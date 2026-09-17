const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const TEMPLATE_PATH = path.join(
  __dirname,
  "..",
  "infra",
  "aws",
  "genesis-verifier-b",
  "template.yaml"
);

const CRYPTOGRAPHIC_ACTIONS = new Set([
  "kms:Sign",
  "kms:Decrypt",
  "kms:Encrypt",
  "kms:GenerateDataKey",
  "kms:ReEncrypt*",
  "kms:GenerateMac",
  "kms:VerifyMac",
  "kms:Verify",
]);
const WORKLOAD_ACTIONS = new Set([
  "kms:Sign",
  "kms:GetPublicKey",
  "kms:DescribeKey",
]);
const ADMIN_ACTIONS = new Set([
  "kms:CancelKeyDeletion",
  "kms:DescribeKey",
  "kms:DisableKey",
  "kms:EnableKey",
  "kms:GetKeyPolicy",
  "kms:ListResourceTags",
  "kms:PutKeyPolicy",
  "kms:ScheduleKeyDeletion",
  "kms:TagResource",
  "kms:UntagResource",
  "kms:UpdateKeyDescription",
]);

function loadTemplate() {
  return yaml.load(fs.readFileSync(TEMPLATE_PATH, "utf8"));
}

function resource(template, logicalId) {
  const result = template.Resources && template.Resources[logicalId];
  expect(result, `missing CloudFormation resource ${logicalId}`).to.be.an(
    "object"
  );
  return result;
}

function statements(policy) {
  const value = policy && policy.Statement;
  return Array.isArray(value) ? value : [value];
}

function actions(statement) {
  return new Set(
    (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).filter(
      Boolean
    )
  );
}

function rolePrincipal() {
  return {
    "Fn::GetAtt": ["GCCGenesisVerifierBExecutionRole", "Arn"],
  };
}

function productionKeyArn() {
  return {
    "Fn::GetAtt": ["GCCGenesisVerifierBProductionKmsKey", "Arn"],
  };
}

function awsPrincipal(statement) {
  return statement.Principal && statement.Principal.AWS;
}

function isRolePrincipal(value) {
  return JSON.stringify(value) === JSON.stringify(rolePrincipal());
}

function isProductionKeyArn(value) {
  return JSON.stringify(value) === JSON.stringify(productionKeyArn());
}

function keyPolicy(template) {
  return resource(template, "GCCGenesisVerifierBProductionKmsKey").Properties
    .KeyPolicy;
}

function workloadKeyPolicyStatement(template) {
  return statements(keyPolicy(template)).find((statement) =>
    isRolePrincipal(awsPrincipal(statement))
  );
}

function workloadIdentityPolicy(template) {
  return resource(template, "GCCGenesisVerifierBKmsUsePolicy").Properties
    .PolicyDocument;
}

function allTemplateStrings(value, result = []) {
  if (typeof value === "string") {
    result.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => allTemplateStrings(item, result));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => allTemplateStrings(item, result));
  }
  return result;
}

function assertProductionBoundary(template) {
  const key = resource(template, "GCCGenesisVerifierBProductionKmsKey");
  const role = resource(template, "GCCGenesisVerifierBExecutionRole");
  const managedPolicy = resource(template, "GCCGenesisVerifierBKmsUsePolicy");
  const policy = key.Properties.KeyPolicy;
  const admin = statements(policy).find(
    (statement) => statement.Sid === "AccountAdministrativeKeyManagement"
  );
  const workload = workloadKeyPolicyStatement(template);
  const identity = workloadIdentityPolicy(template);
  const identityStatements = statements(identity);
  const identityKmsStatements = identityStatements.filter((statement) =>
    [...actions(statement)].some((action) => action.startsWith("kms:"))
  );

  expect(key.Properties.KeySpec).to.equal("ECC_SECG_P256K1");
  expect(key.Properties.KeyUsage).to.equal("SIGN_VERIFY");
  expect(key.DeletionPolicy).to.equal("Retain");
  expect(key.UpdateReplacePolicy).to.equal("Retain");
  expect(admin).to.be.an("object");
  expect(workload).to.be.an("object");
  expect(actions(admin).has("kms:*")).to.equal(false);
  expect(actions(admin).has("kms:Sign")).to.equal(false);
  expect(isRolePrincipal(awsPrincipal(workload))).to.equal(true);
  expect(actions(workload)).to.deep.equal(WORKLOAD_ACTIONS);
  expect(identityKmsStatements).to.have.length(1);
  expect(actions(identityKmsStatements[0])).to.deep.equal(WORKLOAD_ACTIONS);
  expect(isProductionKeyArn(identityKmsStatements[0].Resource)).to.equal(true);
  expect(identityKmsStatements[0].Resource).not.to.equal("*");
  expect(managedPolicy.DependsOn).to.equal("GCCGenesisVerifierBProductionKmsKey");

  const trust = role.Properties.AssumeRolePolicyDocument;
  expect(statements(trust)).to.have.length(1);
  expect(statements(trust)[0].Principal).to.deep.equal({
    Service: "lambda.amazonaws.com",
  });
  expect(actions(statements(trust)[0])).to.deep.equal(new Set(["sts:AssumeRole"]));

  const allowedAdminActions = actions(admin);
  expect(allowedAdminActions).to.deep.equal(ADMIN_ACTIONS);

  for (const statement of statements(policy)) {
    if (statement.Effect === "Allow") {
      expect(awsPrincipal(statement)).not.to.equal("*");
    }
  }

  const kmsUsePrincipals = statements(policy)
    .filter(
      (statement) =>
        statement.Effect === "Allow" &&
        [...actions(statement)].some((action) => CRYPTOGRAPHIC_ACTIONS.has(action))
    )
    .map(awsPrincipal);
  expect(kmsUsePrincipals).to.have.length(1);
  expect(isRolePrincipal(kmsUsePrincipals[0])).to.equal(true);

  const templateText = allTemplateStrings(template).join("\n");
  expect(templateText).not.to.match(/arn:aws:iam::\d{12}/);
  expect(templateText).not.to.match(/arn:aws:kms:[^\s]*:\d{12}:key\//);
  expect(templateText).not.to.match(/(AKIA|ASIA)[A-Z0-9]{16}/);
  expect(templateText).not.to.match(/-----BEGIN [A-Z ]+ PRIVATE KEY-----/);
  expect(templateText).not.to.match(/gcc-genesis-poc/);
}

describe("Genesis Verifier B AWS production policy boundary", function () {
  it("uses an ECC_SECG_P256K1 KMS key", function () {
    const key = resource(loadTemplate(), "GCCGenesisVerifierBProductionKmsKey");
    expect(key.Properties.KeySpec).to.equal("ECC_SECG_P256K1");
  });

  it("uses the SIGN_VERIFY key usage", function () {
    const key = resource(loadTemplate(), "GCCGenesisVerifierBProductionKmsKey");
    expect(key.Properties.KeyUsage).to.equal("SIGN_VERIFY");
  });

  it("makes the workload role the only cryptographic-use principal", function () {
    const template = loadTemplate();
    const workload = workloadKeyPolicyStatement(template);
    expect(workload).to.be.an("object");
    expect(isRolePrincipal(awsPrincipal(workload))).to.equal(true);
    expect(
      statements(keyPolicy(template)).filter((statement) =>
        [...actions(statement)].some((action) => CRYPTOGRAPHIC_ACTIONS.has(action))
      )
    ).to.have.length(1);
  });

  it("does not name interactive IAM users as KMS-use principals", function () {
    const template = loadTemplate();
    const useStatements = statements(keyPolicy(template)).filter((statement) =>
      [...actions(statement)].some((action) => CRYPTOGRAPHIC_ACTIONS.has(action))
    );
    expect(useStatements.some((statement) => /:user\//.test(JSON.stringify(statement)))).to.equal(
      false
    );
    expect(allTemplateStrings(template).join("\n")).not.to.contain("gcc-genesis-poc");
  });

  it("does not grant kms:* in the administration statement", function () {
    const admin = statements(keyPolicy(loadTemplate())).find(
      (statement) => statement.Sid === "AccountAdministrativeKeyManagement"
    );
    expect(actions(admin).has("kms:*")).to.equal(false);
  });

  it("does not grant kms:Sign in the administration statement", function () {
    const admin = statements(keyPolicy(loadTemplate())).find(
      (statement) => statement.Sid === "AccountAdministrativeKeyManagement"
    );
    expect(actions(admin).has("kms:Sign")).to.equal(false);
  });

  it("grants kms:Sign to the workload key-policy principal", function () {
    expect(actions(workloadKeyPolicyStatement(loadTemplate())).has("kms:Sign")).to.equal(
      true
    );
  });

  it("scopes workload kms:Sign to the production key", function () {
    const statement = statements(workloadIdentityPolicy(loadTemplate())).find(
      (candidate) => actions(candidate).has("kms:Sign")
    );
    expect(statement).to.be.an("object");
    expect(isProductionKeyArn(statement.Resource)).to.equal(true);
    expect(statement.Resource).not.to.equal("*");
  });

  it("does not allow the workload to PutKeyPolicy", function () {
    expect(JSON.stringify(workloadIdentityPolicy(loadTemplate()))).not.to.contain(
      "kms:PutKeyPolicy"
    );
  });

  it("does not allow the workload to CreateGrant", function () {
    expect(JSON.stringify(workloadIdentityPolicy(loadTemplate()))).not.to.contain(
      "kms:CreateGrant"
    );
  });

  it("does not allow the workload to ScheduleKeyDeletion", function () {
    expect(JSON.stringify(workloadIdentityPolicy(loadTemplate()))).not.to.contain(
      "kms:ScheduleKeyDeletion"
    );
  });

  it("does not allow the workload to AssumeRole", function () {
    expect(JSON.stringify(workloadIdentityPolicy(loadTemplate())).includes("sts:AssumeRole")).to.equal(
      false
    );
  });

  it("trusts Lambda only", function () {
    const role = resource(loadTemplate(), "GCCGenesisVerifierBExecutionRole");
    const trust = role.Properties.AssumeRolePolicyDocument;
    expect(statements(trust)).to.have.length(1);
    expect(statements(trust)[0].Principal).to.deep.equal({
      Service: "lambda.amazonaws.com",
    });
    expect(statements(trust)[0].Effect).to.equal("Allow");
  });

  it("has no wildcard AWS principal in an Allow statement", function () {
    for (const statement of statements(keyPolicy(loadTemplate()))) {
      if (statement.Effect === "Allow") {
        expect(awsPrincipal(statement)).not.to.equal("*");
      }
    }
  });

  it("retains the KMS key through deletion and replacement", function () {
    const key = resource(loadTemplate(), "GCCGenesisVerifierBProductionKmsKey");
    expect(key.DeletionPolicy).to.equal("Retain");
    expect(key.UpdateReplacePolicy).to.equal("Retain");
  });

  it("contains no hard-coded AWS account IDs, key IDs, credentials, or secrets", function () {
    const templateText = allTemplateStrings(loadTemplate()).join("\n");
    expect(templateText).not.to.match(/arn:aws:iam::\d{12}/);
    expect(templateText).not.to.match(/arn:aws:kms:[^\s]*:\d{12}:key\//);
    expect(templateText).not.to.match(/(AKIA|ASIA)[A-Z0-9]{16}/);
    expect(templateText).not.to.match(/-----BEGIN [A-Z ]+ PRIVATE KEY-----/);
    expect(templateText).not.to.match(/(^|[^A-Za-z])secret([^A-Za-z]|$)/i);
  });

  it("validates the complete production boundary", function () {
    expect(() => assertProductionBoundary(loadTemplate())).not.to.throw();
  });

  it("rejects a weakened kms:* administration mutation", function () {
    const weakened = loadTemplate();
    const admin = statements(keyPolicy(weakened)).find(
      (statement) => statement.Sid === "AccountAdministrativeKeyManagement"
    );
    admin.Action = ["kms:*"];
    expect(() => assertProductionBoundary(weakened)).to.throw();
  });

  it("rejects a weakened wildcard-signing resource mutation", function () {
    const weakened = loadTemplate();
    const statement = statements(workloadIdentityPolicy(weakened)).find(
      (candidate) => actions(candidate).has("kms:Sign")
    );
    statement.Resource = "*";
    expect(() => assertProductionBoundary(weakened)).to.throw();
  });

  it("rejects a weakened IAM-user cryptographic-principal mutation", function () {
    const weakened = loadTemplate();
    const statement = workloadKeyPolicyStatement(weakened);
    statement.Principal.AWS = {
      "Fn::Sub":
        "arn:${AWS::Partition}:iam::${AWS::AccountId}:user/gcc-genesis-poc",
    };
    expect(() => assertProductionBoundary(weakened)).to.throw();
  });
});
