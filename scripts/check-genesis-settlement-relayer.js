const fs = require("fs");
const os = require("os");
const path = require("path");
const {
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
const {
  prepareSettlement,
} = require("../src/genesisSettlement/relayer");

const ROOT = path.resolve(__dirname, "..");
const RECORD_PATH = path.join(
  ROOT,
  "deployments",
  "GCC-GENESIS-001-bsc-mainnet.json"
);
const KEYSTORE_PATH =
  process.env.GENESIS_VERIFIER_A_KEYSTORE ||
  path.join(os.homedir(), ".config", "gcc", "genesis-verifier-a.keystore.json");

function buildRequest(record, currentTime, validUntil) {
  const recipient = getAddress(record.verifiers.A);
  const submissionId = "genesis-relayer-live-canary";
  const deliverableHash = keccak256(
    toUtf8Bytes("GCC-GENESIS-001:RELAYER:LIVE:CANARY")
  );
  const bindingEvidenceHash = keccak256(
    toUtf8Bytes("GCC-GENESIS-001:RELAYER:LIVE:CANARY:BINDING")
  );

  const assessment = {
    assessment_version: "0.3-draft",
    tender_hash: record.hashes.tender,
    submission_id: submissionId,
    deliverable_hash: deliverableHash,
    reward_class: "QUALIFIED_PROPOSAL",
    gate_results: {
      relayer_canary: {
        status: "PASS",
        evidence: ["local:genesis-relayer-live-canary"],
      },
    },
    architectural_analysis: {
      summary:
        "Bounded live relayer canary; validates authorization assembly without settlement.",
    },
    security_analysis: {
      summary:
        "No settlement transaction is sent; request passes the same production signing firewalls.",
    },
    provenance_evidence: ["local:genesis-relayer-live-canary"],
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
        agent_id: "genesis-relayer-live-canary",
        recipient_address: recipient,
        submitted_at: new Date(Number(currentTime) * 1000).toISOString(),
        deliverable_hash: deliverableHash,
        deliverable_location: "local://genesis-relayer-live-canary",
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
  const [network, latestBlock, keystoreJson] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock("latest"),
    fs.promises.readFile(KEYSTORE_PATH, "utf8"),
  ]);
  if (network.chainId !== 56n) throw new Error("Expected BSC mainnet chain 56");
  if (!latestBlock) throw new Error("Could not read latest BSC block");

  const now = BigInt(latestBlock.timestamp);
  const deadline = BigInt(record.escrow.settlementDeadlineUnix);
  const validUntil = now + 3600n < deadline - 60n ? now + 3600n : deadline - 60n;
  if (validUntil <= now) throw new Error("Genesis settlement deadline is too near");

  const password = await promptHidden(
    "Unlock Genesis Verifier A for relayer canary: "
  );
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
      clock: () => now,
    });
  if (getAddress(aAddress) !== getAddress(record.verifiers.A)) {
    throw new Error("Verifier A keystore does not match immutable Verifier A");
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
    clock: () => now,
  });

  const request = buildRequest(record, now, validUntil);
  const [aResult, bResult] = await Promise.all([
    verifierA.signGenesisAttestation(request),
    verifierB.signGenesisAttestation(request),
  ]);

  const prepared = await prepareSettlement({
    provider,
    record,
    request,
    verifierAResult: aResult,
    verifierBResult: bResult,
  });

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        chainId: 56,
        transactionSent: false,
        fundsMoved: false,
        authorityAccepted2Of3: prepared.authorityAccepted2Of3,
        awardDigest: prepared.awardDigest,
        attestationDigest: prepared.attestationDigest,
        awardId: prepared.awardId,
        escrow: prepared.settlement.to,
        escrowBalanceRaw: prepared.settlement.escrowBalanceRaw,
        fundingShortfallRaw: prepared.settlement.fundingShortfallRaw,
        fundedForAward: prepared.settlement.fundedForAward,
        settlementSimulation: prepared.settlement.simulation,
        conclusion: prepared.settlement.fundedForAward
          ? "Bounded relayer assembled A+B authorization and live settlement simulation passed. No transaction was sent."
          : "Bounded relayer assembled A+B authorization and the live authority accepted it. Settlement simulation is intentionally deferred until the escrow is funded.",
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
