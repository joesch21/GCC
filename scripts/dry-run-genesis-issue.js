const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { JsonRpcProvider, getAddress } = require("ethers");

const { promptHidden } = require("./lib/prompt-hidden");
const { evaluateGithubIssue } = require("../src/genesisIntake");
const {
  getIssue,
  getIssueComments,
} = require("../src/genesisIntake/github");
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

function parseArgs(argv) {
  const synthetic = argv.includes("--synthetic");
  const issueArg = argv.find((value) => /^\d+$/.test(value));
  if (!issueArg) {
    throw new Error(
      "Usage: npm run mainnet:intake:dry-run -- <issue-number> [--synthetic]"
    );
  }
  return { issueNumber: Number(issueArg), synthetic };
}

async function startSyntheticDiscoveryServer() {
  const tender = {
    tender_id: "GCC-GENESIS-001",
    network: { chain_id: 56 },
    economics: {
      total_budget_gcc: "100",
      reward_per_valid_submission_gcc: "10",
    },
    task: { task_id: "gcc-discovery-client" },
  };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/gcc-agent.json") {
      const port = server.address().port;
      res.end(
        JSON.stringify({
          tenders: [
            {
              tender_id: "GCC-GENESIS-001",
              tender_url:
                "http://host.docker.internal:" +
                port +
                "/tenders/GCC-GENESIS-001.json",
            },
          ],
        })
      );
      return;
    }
    if (req.url === "/tenders/GCC-GENESIS-001.json") {
      res.end(JSON.stringify(tender));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const port = server.address().port;
  return {
    server,
    discoveryUrl:
      "http://host.docker.internal:" +
      port +
      "/.well-known/gcc-agent.json",
  };
}

async function createVerifiers(record, now, keystoreJson, password) {
  const aEnvironment = {
    ...process.env,
    GENESIS_VERIFIER_A_SIGNING_ENABLED: "true",
    GENESIS_VERIFIER_A_AUTHORITY_ADDRESS: record.authority.address,
    GENESIS_VERIFIER_A_ESCROW_ADDRESS: record.escrow.address,
    GENESIS_VERIFIER_A_MAX_AWARD_VALIDITY_HORIZON_SECONDS: "86400",
  };
  const aRuntime = await createGenesisVerifierAFromEnvironment({
    keystoreJson,
    password,
    environment: aEnvironment,
    clock: () => now,
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
    clock: () => now,
  });
  return {
    verifierA: aRuntime.verifier,
    verifierB,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
  const provider = new JsonRpcProvider(
    process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/"
  );

  const [network, latestBlock, issue, comments, keystoreJson] =
    await Promise.all([
      provider.getNetwork(),
      provider.getBlock("latest"),
      getIssue(args.issueNumber),
      getIssueComments(args.issueNumber),
      fs.promises.readFile(KEYSTORE_PATH, "utf8"),
    ]);
  if (network.chainId !== 56n) throw new Error("Expected BSC mainnet chain 56");
  if (!latestBlock) throw new Error("Could not read latest BSC block");
  const now = BigInt(latestBlock.timestamp);

  let syntheticServer = null;
  let discoveryOverride = null;
  if (args.synthetic) {
    syntheticServer = await startSyntheticDiscoveryServer();
    discoveryOverride = syntheticServer.discoveryUrl;
  }

  try {
    const evaluated = await evaluateGithubIssue({
      issue,
      comments,
      record,
      synthetic: args.synthetic,
      discoveryOverride,
      nowSeconds: Number(now),
    });

    if (evaluated.status === "AWAITING_SIGNATURE") {
      console.log(
        JSON.stringify(
          {
            status: "AWAITING_SIGNATURE",
            transactionSent: false,
            issue: args.issueNumber,
            challenge: evaluated.challenge,
          },
          null,
          2
        )
      );
      return;
    }

    const password = await promptHidden(
      "Unlock Genesis Verifier A for intake dry-run: "
    );
    const runtime = await createVerifiers(
      record,
      now,
      keystoreJson,
      password
    );
    const [aResult, bResult] = await Promise.all([
      runtime.verifierA.signGenesisAttestation(evaluated.request),
      runtime.verifierB.signGenesisAttestation(evaluated.request),
    ]);

    const prepared = await prepareSettlement({
      provider,
      record,
      request: evaluated.request,
      verifierAResult: aResult,
      verifierBResult: bResult,
      relayerAddress: record.relayer.address,
    });

    console.log(
      JSON.stringify(
        {
          status: "DRY_RUN_PASS",
          issue: args.issueNumber,
          synthetic: args.synthetic,
          transactionSent: false,
          fundsMoved: false,
          artifactHash: evaluated.artifactHash,
          recipient: evaluated.request.award.recipient,
          authorityAccepted2Of3: prepared.authorityAccepted2Of3,
          awardId: prepared.awardId,
          awardDigest: prepared.awardDigest,
          attestationDigest: prepared.attestationDigest,
          escrowBalanceRaw: prepared.settlement.escrowBalanceRaw,
          fundingShortfallRaw: prepared.settlement.fundingShortfallRaw,
          fundedForAward: prepared.settlement.fundedForAward,
          settlementSimulation: prepared.settlement.simulation,
          conclusion:
            "Synthetic GitHub issue traversed intake, recipient binding, sandbox validation, A+B signing, live authority verification, and read-only settlement simulation. No transaction was sent.",
        },
        null,
        2
      )
    );
  } finally {
    if (syntheticServer) {
      await new Promise((resolve) => syntheticServer.server.close(resolve));
    }
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "DRY_RUN_FAILED",
      code: error.code || "GENESIS_INTAKE_DRY_RUN_FAILED",
      message: error.message || String(error),
      transactionSent: false,
    })
  );
  process.exitCode = 1;
});
