const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const { evaluateGithubIssue } = require("../src/genesisIntake");
const {
  EXPECTED_OUTPUT,
  recipientBindingChallenge,
  verifyRecipientBinding,
} = require("../src/genesisIntake/submission");
const {
  AUTHORITY_DOMAIN,
  ESCROW_DOMAIN,
  normalizeProductionConfig,
} = require("../src/genesisVerifierB/configuration");
const {
  validateGenesisRequest,
} = require("../src/genesisVerifierB/requestValidation");

describe("Genesis GitHub intake bridge", function () {
  const record = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "deployments",
        "GCC-GENESIS-001-bsc-mainnet.json"
      ),
      "utf8"
    )
  );
  const fixturePath = path.join(
    __dirname,
    "fixtures",
    "genesis-synthetic-client.mjs"
  );
  const fixtureBytes = fs.readFileSync(fixturePath);
  const fixtureHash = ethers.keccak256(fixtureBytes).toLowerCase();
  const nowSeconds = Math.floor(
    Date.parse("2026-09-18T04:10:00.000Z") / 1000
  );

  function baseFields(wallet) {
    return {
      submission_id: "synthetic-intake-001",
      agent_id: "synthetic-ci-agent",
      recipient_address: wallet.address,
      deliverable_url:
        "https://raw.githubusercontent.com/joesch21/GCC/main/test/fixtures/genesis-synthetic-client.mjs",
      deliverable_hash: fixtureHash,
      runtime: "node:22",
      run_command: "node genesis-synthetic-client.mjs",
      observed_output: JSON.stringify(EXPECTED_OUTPUT),
      synthetic_test: "true",
    };
  }

  async function signedIssue(wallet) {
    const fields = baseFields(wallet);
    fields.recipient_signature = await wallet.signMessage(
      recipientBindingChallenge(fields)
    );
    const body = Object.entries(fields)
      .map(([key, value]) => key + ": " + value)
      .join("\n");
    return {
      number: 900001,
      title: "[GCC-GENESIS-001] synthetic bridge dry-run",
      body,
      created_at: "2026-09-18T03:30:00.000Z",
      updated_at: "2026-09-18T03:30:00.000Z",
      html_url: "https://github.com/joesch21/GCC/issues/900001",
    };
  }

  it("verifies recipient personal-sign binding", async function () {
    const wallet = ethers.Wallet.createRandom();
    const fields = baseFields(wallet);
    fields.recipient_signature = await wallet.signMessage(
      recipientBindingChallenge(fields)
    );
    const result = verifyRecipientBinding(fields, []);
    expect(result.status).to.equal("VERIFIED");
    expect(result.recipient).to.equal(wallet.address);
    expect(result.bindingEvidenceHash).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("rejects a recipient signature from another wallet", async function () {
    const wallet = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const fields = baseFields(wallet);
    fields.recipient_signature = await attacker.signMessage(
      recipientBindingChallenge(fields)
    );
    expect(() => verifyRecipientBinding(fields, [])).to.throw(
      "does not recover recipient_address"
    );
  });

  it("builds a verifier-valid canonical request from a synthetic GitHub issue", async function () {
    const wallet = ethers.Wallet.createRandom();
    const issue = await signedIssue(wallet);

    const evaluated = await evaluateGithubIssue({
      issue,
      comments: [],
      record,
      synthetic: true,
      nowSeconds,
      artifactFetcher: async () => ({
        bytes: fixtureBytes,
        finalUrl:
          "https://raw.githubusercontent.com/joesch21/GCC/main/test/fixtures/genesis-synthetic-client.mjs",
        hash: fixtureHash,
      }),
      sandboxVerifier: () => ({
        networked: { status: 0 },
        offline: { status: 1 },
        networkedOutput: EXPECTED_OUTPUT,
      }),
    });

    expect(evaluated.status).to.equal("QUALIFIED");
    expect(evaluated.request.award.recipient).to.equal(wallet.address);
    expect(evaluated.request.award.deliverableHash).to.equal(fixtureHash);

    const config = normalizeProductionConfig({
      signingEnabled: false,
      chainId: 56,
      verifierAuthorityAddress: record.authority.address,
      escrowAddress: record.escrow.address,
      escrowDomain: ESCROW_DOMAIN,
      authorityDomain: AUTHORITY_DOMAIN,
      tenderHash: record.hashes.tender,
      policyHash: record.hashes.policy,
      allowedRewardClasses: ["QUALIFIED_PROPOSAL"],
      signerAddress: record.verifiers.A,
      maxAwardValidityHorizonSeconds: "86400",
    });

    const validated = validateGenesisRequest(
      evaluated.request,
      config,
      () => nowSeconds
    );
    expect(validated.rewardClassName).to.equal("QUALIFIED_PROPOSAL");
    expect(validated.assessmentResult.submissionId).to.equal(
      "synthetic-intake-001"
    );
  });

  it("returns a deterministic recipient challenge when signature is absent", async function () {
    const wallet = ethers.Wallet.createRandom();
    const fields = baseFields(wallet);
    const body = Object.entries(fields)
      .map(([key, value]) => key + ": " + value)
      .join("\n");
    const issue = {
      number: 900002,
      title: "[GCC-GENESIS-001] awaiting binding",
      body,
      created_at: "2026-09-18T03:30:00.000Z",
      updated_at: "2026-09-18T03:30:00.000Z",
    };

    const evaluated = await evaluateGithubIssue({
      issue,
      comments: [],
      record,
      synthetic: true,
      nowSeconds,
    });
    expect(evaluated.status).to.equal("AWAITING_SIGNATURE");
    expect(evaluated.challenge).to.equal(recipientBindingChallenge(fields));
  });
});
