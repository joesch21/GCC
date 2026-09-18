const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  JsonRpcProvider,
  getAddress,
  parseEther,
} = require("ethers");

const { promptHidden } = require("./lib/prompt-hidden");
const {
  evaluateGithubIssue,
} = require("../src/genesisIntake");
const {
  challengeComment,
  parseSubmissionBody,
  submissionWindow,
} = require("../src/genesisIntake/submission");
const {
  getIssueComments,
  listGenesisIssues,
  postIssueComment,
} = require("../src/genesisIntake/github");
const {
  checkGenesisLiveReadiness,
} = require("../src/genesisIntake/liveReadiness");
const {
  createGenesisVerifierAFromEnvironment,
} = require("../src/genesisVerifierA");
const {
  createGenesisVerifierB,
} = require("../src/genesisVerifierB");
const {
  AUTHORITY_DOMAIN,
  ESCROW_DOMAIN,
  normalizeProductionConfig,
} = require("../src/genesisVerifierB/configuration");
const {
  createAwsKmsGenesisSigner,
} = require("../src/genesisVerifierB/awsKmsSigner");
const {
  prepareSettlement,
  sendPreparedSettlement,
} = require("../src/genesisSettlement/relayer");
const {
  unlockRelayer,
} = require("../src/genesisSettlement/encryptedRelayer");

const ROOT = path.resolve(__dirname, "..");
const RECORD_PATH = path.join(
  ROOT,
  "deployments",
  "GCC-GENESIS-001-bsc-mainnet.json"
);
const A_KEYSTORE_PATH =
  process.env.GENESIS_VERIFIER_A_KEYSTORE ||
  path.join(os.homedir(), ".config", "gcc", "genesis-verifier-a.keystore.json");
const RELAYER_KEYSTORE_PATH =
  process.env.GENESIS_RELAYER_KEYSTORE ||
  path.join(os.homedir(), ".config", "gcc", "genesis-relayer.keystore.json");
const STATE_PATH =
  process.env.GENESIS_INTAKE_STATE ||
  path.join(os.homedir(), ".local", "state", "gcc", "genesis-intake.json");

function bool(value) {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function positiveBigInt(value, fallback, label) {
  const raw = value || fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(label + " must be a positive integer");
  }
  return BigInt(raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (_error) {
    return { version: 1, issues: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  const temporary = STATE_PATH + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(temporary, STATE_PATH);
}

function hasChallengeComment(comments) {
  return comments.some((comment) =>
    String(comment.body || "").includes(
      "<!-- gcc-genesis-recipient-challenge -->"
    )
  );
}

function paidComment(sent, evaluated) {
  return [
    "<!-- gcc-genesis-settlement -->",
    "Genesis I status: PAID",
    "",
    "submission_id: " + evaluated.fields.submission_id,
    "deliverable_hash: " + evaluated.artifactHash,
    "recipient_address: " + evaluated.request.award.recipient,
    "award_id: " + sent.awardId,
    "transaction_hash: " + sent.transactionHash,
    "",
    "The bounded A+B verifier path authorized this objective QUALIFIED_PROPOSAL settlement. No human per-payment approval was used.",
  ].join("\n");
}

function rejectedComment(error) {
  return [
    "<!-- gcc-genesis-intake-rejected -->",
    "Genesis I status: REJECTED",
    "",
    "code: " + (error.code || "GENESIS_INTAKE_REJECTED"),
    "reason: " + (error.message || String(error)),
    "",
    "The issue may be corrected while the submission window remains open; an updated issue will be evaluated again.",
  ].join("\n");
}

async function createVerifierRuntime(record) {
  const aKeystoreJson = fs.readFileSync(A_KEYSTORE_PATH, "utf8");
  const password = await promptHidden(
    "Unlock Genesis Verifier A for autonomous intake: "
  );
  const environment = {
    ...process.env,
    GENESIS_VERIFIER_A_SIGNING_ENABLED: "true",
    GENESIS_VERIFIER_A_AUTHORITY_ADDRESS: record.authority.address,
    GENESIS_VERIFIER_A_ESCROW_ADDRESS: record.escrow.address,
    GENESIS_VERIFIER_A_MAX_AWARD_VALIDITY_HORIZON_SECONDS: "86400",
  };
  const aRuntime = await createGenesisVerifierAFromEnvironment({
    keystoreJson: aKeystoreJson,
    password,
    environment,
    clock: () => Math.floor(Date.now() / 1000),
  });
  if (getAddress(aRuntime.signerAddress) !== getAddress(record.verifiers.A)) {
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
    clock: () => Math.floor(Date.now() / 1000),
  });
  return {
    verifierA: aRuntime.verifier,
    verifierB,
  };
}

async function createRelayerRuntime(record, sendEnabled) {
  if (!sendEnabled) {
    return {
      wallet: null,
      address: getAddress(record.relayer.address),
    };
  }
  const relayerKeystoreJson = fs.readFileSync(RELAYER_KEYSTORE_PATH, "utf8");
  const password = await promptHidden(
    "Unlock Genesis settlement relayer for autonomous intake: "
  );
  const unlocked = await unlockRelayer({
    keystoreJson: relayerKeystoreJson,
    password,
  });
  if (getAddress(unlocked.address) !== getAddress(record.relayer.address)) {
    throw new Error("Relayer keystore does not match recorded relayer address");
  }
  return {
    wallet: unlocked.wallet,
    address: unlocked.address,
  };
}

async function main() {
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
  const provider = new JsonRpcProvider(
    process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/"
  );
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error("Genesis intake requires BSC mainnet chain 56");
  }

  const sendEnabled = bool(process.env.GENESIS_RELAYER_SEND);
  if (
    sendEnabled &&
    process.env.GENESIS_LIVE_ACK !== "GCC-GENESIS-001-LIVE"
  ) {
    throw new Error(
      "LIVE_SEND requires GENESIS_LIVE_ACK=GCC-GENESIS-001-LIVE"
    );
  }
  const pollMs = Number(process.env.GENESIS_INTAKE_POLL_MS || "60000");
  if (!Number.isSafeInteger(pollMs) || pollMs < 10000) {
    throw new Error("GENESIS_INTAKE_POLL_MS must be an integer >= 10000");
  }
  const maxGasLimit = positiveBigInt(
    process.env.GENESIS_RELAYER_MAX_GAS_LIMIT,
    "1000000",
    "GENESIS_RELAYER_MAX_GAS_LIMIT"
  );
  const maxGasCostWei = positiveBigInt(
    process.env.GENESIS_RELAYER_MAX_GAS_COST_WEI,
    parseEther("0.005").toString(),
    "GENESIS_RELAYER_MAX_GAS_COST_WEI"
  );

  const verifiers = await createVerifierRuntime(record);
  const relayer = await createRelayerRuntime(record, sendEnabled);
  const liveReadiness = sendEnabled
    ? await checkGenesisLiveReadiness({ provider, record })
    : null;
  const state = loadState();
  const window = submissionWindow(record);

  console.error(
    JSON.stringify({
      role: "GENESIS_GITHUB_INTAKE_BRIDGE",
      mode: sendEnabled ? "LIVE_SEND" : "DRY_RUN",
      chainId: 56,
      repository: "joesch21/GCC",
      titlePrefix: "[GCC-GENESIS-001]",
      opensAt: window.opensAtIso,
      closesAt: window.closesAtIso,
      settlementDeadline: record.escrow.settlementDeadlineIso,
      escrow: record.escrow.address,
      authority: record.authority.address,
      relayer: relayer.address,
      pollMs,
      sandbox: "docker-unprivileged-no-host-secrets",
      arbitraryTransactions: false,
      liveReadiness,
    })
  );

  for (;;) {
    try {
      const issues = await listGenesisIssues();
      for (const issue of issues) {
        const fields = parseSubmissionBody(issue.body || "");
        if (fields.synthetic_test === "true") continue;

        const existing = state.issues[String(issue.number)];
        if (existing && existing.status === "PAID") continue;
        if (
          existing &&
          existing.status === "REJECTED" &&
          existing.issueUpdatedAt === issue.updated_at
        ) {
          continue;
        }

        let comments;
        try {
          comments = await getIssueComments(issue.number);
          const evaluated = await evaluateGithubIssue({
            issue,
            comments,
            record,
          });

          if (evaluated.status === "AWAITING_SIGNATURE") {
            if (!hasChallengeComment(comments)) {
              await postIssueComment(
                issue.number,
                challengeComment(evaluated.challenge)
              );
            }
            state.issues[String(issue.number)] = {
              status: "AWAITING_SIGNATURE",
              issueUpdatedAt: issue.updated_at,
            };
            saveState(state);
            continue;
          }

          const [aResult, bResult] = await Promise.all([
            verifiers.verifierA.signGenesisAttestation(evaluated.request),
            verifiers.verifierB.signGenesisAttestation(evaluated.request),
          ]);
          const prepared = await prepareSettlement({
            provider,
            record,
            request: evaluated.request,
            verifierAResult: aResult,
            verifierBResult: bResult,
            relayerAddress: relayer.address,
          });

          if (!sendEnabled) {
            console.log(
              JSON.stringify({
                status: "DRY_RUN_PASS",
                issue: issue.number,
                transactionSent: false,
                awardId: prepared.awardId,
                recipient: evaluated.request.award.recipient,
                settlementSimulation: prepared.settlement.simulation,
              })
            );
            continue;
          }

          const sent = await sendPreparedSettlement({
            wallet: relayer.wallet,
            provider,
            prepared,
            maxGasLimit,
            maxGasCostWei,
          });
          const finalResult = {
            ...sent,
            awardId: prepared.awardId,
          };
          await postIssueComment(
            issue.number,
            paidComment(finalResult, evaluated)
          );
          state.issues[String(issue.number)] = {
            status: "PAID",
            issueUpdatedAt: issue.updated_at,
            awardId: prepared.awardId,
            transactionHash: sent.transactionHash,
            deliverableHash: evaluated.artifactHash,
          };
          saveState(state);
          console.log(
            JSON.stringify({
              status: "PAID",
              issue: issue.number,
              transactionHash: sent.transactionHash,
              awardId: prepared.awardId,
            })
          );
        } catch (error) {
          const transient =
            Boolean(error.retryable) ||
            error.code === "GENESIS_VERIFIER_B_AWS_CLI_FAILED";
          console.error(
            JSON.stringify({
              status: transient ? "RETRY" : "REJECTED",
              issue: issue.number,
              code: error.code || "GENESIS_INTAKE_ERROR",
              message: error.message || String(error),
            })
          );
          if (transient) continue;

          comments = comments || [];
          const alreadyCommented = comments.some((comment) =>
            String(comment.body || "").includes(
              "<!-- gcc-genesis-intake-rejected -->"
            )
          );
          if (!alreadyCommented) {
            await postIssueComment(issue.number, rejectedComment(error));
          }
          state.issues[String(issue.number)] = {
            status: "REJECTED",
            issueUpdatedAt: issue.updated_at,
            code: error.code || "GENESIS_INTAKE_ERROR",
          };
          saveState(state);
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          status: "POLL_ERROR",
          code: error.code || "GENESIS_INTAKE_POLL_ERROR",
          message: error.message || String(error),
        })
      );
    }

    await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
