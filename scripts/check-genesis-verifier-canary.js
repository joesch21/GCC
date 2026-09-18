const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toUtf8Bytes,
} = require("ethers");

const { promptHidden } = require("./lib/prompt-hidden");
const {
  createGenesisVerifierAFromEnvironment,
} = require("../src/genesisVerifierA");
const {
  createGenesisVerifierB,
} = require("../src/genesisVerifierB");
const {
  AUTHORITY_DOMAIN,
  ESCROW_DOMAIN,
  REWARD_CLASS_HASHES,
  normalizeProductionConfig,
} = require("../src/genesisVerifierB/configuration");
const {
  computeAssessmentHash,
} = require("../src/genesisVerifierB/requestValidation");
const {
  createAwsKmsGenesisSigner,
} = require("../src/genesisVerifierB/awsKmsSigner");

const ROOT = path.resolve(__dirname, "..");
const RECORD_PATH = path.join(
  ROOT,
  "deployments",
  "GCC-GENESIS-001-bsc-mainnet.json"
);
const KEYSTORE_PATH =
  process.env.GENESIS_VERIFIER_A_KEYSTORE ||
  path.join(os.homedir(), ".config", "gcc", "genesis-verifier-a.keystore.json");

const AUTHORITY_ABI = [
  "function isValidSignature(bytes32,bytes) view returns (bytes4)",
  "function policyHash() view returns (bytes32)",
  "function verifiers() view returns (address[3])",
];
const ESCROW_ABI = [
  "function awardDigest((bytes32 tenderHash,bytes32 awardClass,bytes32 deliverableHash,bytes32 assessmentHash,address recipient,uint64 validUntil)) view returns (bytes32)",
  "function QUALIFIED_PROPOSAL() view returns (bytes32)",
  "function settlementDeadline() view returns (uint64)",
];

function sameAddress(a, b) {
  return getAddress(a) === getAddress(b);
}

function buildCanaryRequest({ record, recipient, currentTime, validUntil }) {
  const submissionId = "genesis-live-a-b-canary";
  const deliverableHash = keccak256(
    toUtf8Bytes("GCC-GENESIS-001:LIVE:A+B:CANARY:DELIVERABLE")
  );
  const bindingEvidenceHash = keccak256(
    toUtf8Bytes("GCC-GENESIS-001:LIVE:A+B:CANARY:RECIPIENT-BINDING")
  );

  const assessment = {
    assessment_version: "0.3-draft",
    tender_hash: record.hashes.tender,
    submission_id: submissionId,
    deliverable_hash: deliverableHash,
    reward_class: "QUALIFIED_PROPOSAL",
    gate_results: {
      canary: {
        status: "PASS",
        evidence: ["local:genesis-live-verifier-canary"],
      },
    },
    architectural_analysis: {
      summary: "Live A+B cryptographic canary; no settlement is executed.",
    },
    security_analysis: {
      summary: "Canary exercises the restricted Genesis signing firewall only.",
    },
    provenance_evidence: ["local:genesis-live-verifier-canary"],
    recipient_binding_evidence: {
      recipient_address: recipient,
      binding_method:
        "agent identity credential binding the recipient address",
      binding_evidence_hash: bindingEvidenceHash,
    },
    assessment_hash_input_manifest: [
      "assessment_version",
      "tender_hash",
      "submission_id",
      "deliverable_hash",
      "reward_class",
      "gate_results",
      "architectural_analysis",
      "security_analysis",
      "provenance_evidence",
      "recipient_binding_evidence",
    ],
  };

  const assessmentHash = computeAssessmentHash(assessment);
  const award = {
    tenderHash: record.hashes.tender,
    awardClass: REWARD_CLASS_HASHES.QUALIFIED_PROPOSAL,
    deliverableHash,
    assessmentHash,
    recipient,
    validUntil: validUntil.toString(),
  };

  return {
    award,
    assessment,
    evidence: {
      submission_manifest: {
        tender_id: "GCC-GENESIS-001",
        submission_id: submissionId,
        agent_id: "genesis-live-canary",
        recipient_address: recipient,
        submitted_at: new Date(Number(currentTime) * 1000).toISOString(),
        deliverable_hash: deliverableHash,
        deliverable_location: "local://genesis-live-verifier-canary",
        submission_schema_version: "0.1",
      },
      validation_report: {
        submission_id: submissionId,
        tender_hash: record.hashes.tender,
        deliverable_hash: deliverableHash,
        schema_valid: true,
        mandatory_sections_present: true,
        provenance_present: true,
        duplicate_review: "CLEAR",
        secret_request_check: "PASS",
        security_boundary_present: true,
        failure_modes_present: true,
      },
    },
  };
}

async function main() {
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
  const provider = new JsonRpcProvider(
    process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/"
  );
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Expected BSC mainnet chain 56, got ${network.chainId}`);
  }

  const [latestBlock, keystoreJson] = await Promise.all([
    provider.getBlock("latest"),
    fs.promises.readFile(KEYSTORE_PATH, "utf8"),
  ]);
  if (!latestBlock) throw new Error("Could not read latest BSC block");

  const currentTime = BigInt(latestBlock.timestamp);
  const deadline = BigInt(record.escrow.settlementDeadlineUnix);
  const validUntil =
    currentTime + 3600n < deadline - 60n
      ? currentTime + 3600n
      : deadline - 60n;
  if (validUntil <= currentTime) {
    throw new Error("Genesis settlement deadline is too near for the canary");
  }

  const password = await promptHidden("Unlock Genesis Verifier A for live A+B canary: ");

  const aEnvironment = {
    ...process.env,
    GENESIS_VERIFIER_A_SIGNING_ENABLED: "true",
    GENESIS_VERIFIER_A_AUTHORITY_ADDRESS: record.authority.address,
    GENESIS_VERIFIER_A_ESCROW_ADDRESS: record.escrow.address,
    GENESIS_VERIFIER_A_MAX_AWARD_VALIDITY_HORIZON_SECONDS: "86400",
  };
  const { signerAddress: aAddress, verifier: verifierA } =
    await createGenesisVerifierAFromEnvironment({
      keystoreJson,
      password,
      environment: aEnvironment,
      clock: () => currentTime,
    });

  if (!sameAddress(aAddress, record.verifiers.A)) {
    throw new Error("Local Verifier A keystore does not match the immutable A address");
  }

  process.stderr.write("Locating immutable Verifier B AWS KMS key...\n");
  const kmsSigner = await createAwsKmsGenesisSigner({
    expectedAddress: record.verifiers.B,
  });

  const bConfig = normalizeProductionConfig({
    signingEnabled: true,
    chainId: 56,
    verifierAuthorityAddress: record.authority.address,
    escrowAddress: record.escrow.address,
    escrowDomain: ESCROW_DOMAIN,
    authorityDomain: AUTHORITY_DOMAIN,
    tenderHash: record.hashes.tender,
    policyHash: record.hashes.policy,
    allowedRewardClasses: ["QUALIFIED_PROPOSAL"],
    signerAddress: record.verifiers.B,
    maxAwardValidityHorizonSeconds: "86400",
  });
  const verifierB = createGenesisVerifierB({
    config: bConfig,
    signer: kmsSigner,
    clock: () => currentTime,
  });

  const request = buildCanaryRequest({
    record,
    recipient: record.verifiers.A,
    currentTime,
    validUntil,
  });

  const [aResult, bResult] = await Promise.all([
    verifierA.signGenesisAttestation(request),
    verifierB.signGenesisAttestation(request),
  ]);

  if (aResult.audit.awardDigest !== bResult.audit.awardDigest) {
    throw new Error("Verifier A and B derived different award digests");
  }
  if (aResult.audit.attestationDigest !== bResult.audit.attestationDigest) {
    throw new Error("Verifier A and B derived different attestation digests");
  }

  const authority = new Contract(
    record.authority.address,
    AUTHORITY_ABI,
    provider
  );
  const escrow = new Contract(record.escrow.address, ESCROW_ABI, provider);

  const onchainAwardDigest = await escrow.awardDigest(request.award);
  if (onchainAwardDigest !== aResult.audit.awardDigest) {
    throw new Error("Firewall award digest does not match live escrow");
  }

  const entries = [
    { signer: record.verifiers.A, signature: aResult.signature },
    { signer: record.verifiers.B, signature: bResult.signature },
  ].sort((left, right) =>
    BigInt(left.signer) < BigInt(right.signer) ? -1 : 1
  );

  const authorization = AbiCoder.defaultAbiCoder().encode(
    ["address[]", "bytes[]"],
    [
      entries.map((entry) => entry.signer),
      entries.map((entry) => entry.signature),
    ]
  );
  const magic = await authority.isValidSignature(
    aResult.audit.awardDigest,
    authorization
  );
  if (magic !== "0x1626ba7e") {
    throw new Error("Live GenesisVerifierAuthority rejected the A+B canary");
  }

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        chainId: 56,
        transactionSent: false,
        fundsMoved: false,
        verifierA: record.verifiers.A,
        verifierB: record.verifiers.B,
        awardDigest: aResult.audit.awardDigest,
        attestationDigest: aResult.audit.attestationDigest,
        authority: record.authority.address,
        authorityAccepted2Of3: true,
        conclusion:
          "The live immutable authority accepted independent Verifier A + AWS KMS Verifier B signatures for the same firewall-derived Genesis canary digest. No settlement transaction was sent.",
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
