const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("node:readline");
const {
  JsonRpcProvider,
  getAddress,
  parseEther,
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

function parseBoolean(value) {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function parsePositiveBigInt(value, fallback, label) {
  const raw = value || fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return BigInt(raw);
}

function resultSummary(prepared) {
  return {
    chainId: prepared.chainId,
    authorityAccepted2Of3: prepared.authorityAccepted2Of3,
    awardDigest: prepared.awardDigest,
    attestationDigest: prepared.attestationDigest,
    awardId: prepared.awardId,
    escrow: prepared.settlement.to,
    amountRaw: prepared.settlement.amountRaw,
    escrowBalanceRaw: prepared.settlement.escrowBalanceRaw,
    fundingShortfallRaw: prepared.settlement.fundingShortfallRaw,
    fundedForAward: prepared.settlement.fundedForAward,
    settlementDeadline: prepared.settlement.settlementDeadline,
    validUntil: prepared.settlement.validUntil,
    simulation: prepared.settlement.simulation,
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

  const sendEnabled = parseBoolean(process.env.GENESIS_RELAYER_SEND);
  const maxGasLimit = parsePositiveBigInt(
    process.env.GENESIS_RELAYER_MAX_GAS_LIMIT,
    "1000000",
    "GENESIS_RELAYER_MAX_GAS_LIMIT"
  );
  const maxGasCostWei = parsePositiveBigInt(
    process.env.GENESIS_RELAYER_MAX_GAS_COST_WEI,
    parseEther("0.005").toString(),
    "GENESIS_RELAYER_MAX_GAS_COST_WEI"
  );

  const aKeystoreJson = fs.readFileSync(A_KEYSTORE_PATH, "utf8");
  const aPassword = await promptHidden("Unlock Genesis Verifier A for settlement relayer: ");
  const aEnvironment = {
    ...process.env,
    GENESIS_VERIFIER_A_SIGNING_ENABLED: "true",
    GENESIS_VERIFIER_A_AUTHORITY_ADDRESS: record.authority.address,
    GENESIS_VERIFIER_A_ESCROW_ADDRESS: record.escrow.address,
    GENESIS_VERIFIER_A_MAX_AWARD_VALIDITY_HORIZON_SECONDS: "86400",
  };
  const { signerAddress: aAddress, verifier: verifierA } =
    await createGenesisVerifierAFromEnvironment({
      keystoreJson: aKeystoreJson,
      password: aPassword,
      environment: aEnvironment,
      clock: () => Math.floor(Date.now() / 1000),
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
    clock: () => Math.floor(Date.now() / 1000),
  });

  let relayerWallet = null;
  let relayerAddress = process.env.GENESIS_RELAYER_ADDRESS
    ? getAddress(process.env.GENESIS_RELAYER_ADDRESS)
    : null;

  if (sendEnabled) {
    const relayerKeystoreJson = fs.readFileSync(RELAYER_KEYSTORE_PATH, "utf8");
    const relayerPassword = await promptHidden("Unlock Genesis settlement relayer: ");
    const unlocked = await unlockRelayer({
      keystoreJson: relayerKeystoreJson,
      password: relayerPassword,
    });
    relayerWallet = unlocked.wallet;
    relayerAddress = unlocked.address;
  }

  console.error(
    JSON.stringify({
      role: "GENESIS_SETTLEMENT_RELAYER",
      mode: sendEnabled ? "LIVE_SEND" : "DRY_RUN",
      chainId: 56,
      escrow: record.escrow.address,
      authority: record.authority.address,
      verifierThreshold: 2,
      verifierPath: ["A", "B"],
      relayerAddress,
      maxGasLimit: maxGasLimit.toString(),
      maxGasCostWei: maxGasCostWei.toString(),
      arbitraryTransactions: false,
      input: "newline-delimited canonical Genesis evidence requests; QUIT to stop",
    })
  );

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    if (text === "QUIT") break;

    try {
      const request = JSON.parse(text);
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
        relayerAddress,
      });

      if (!sendEnabled) {
        console.log(
          JSON.stringify({
            status: "DRY_RUN_PASS",
            transactionSent: false,
            ...resultSummary(prepared),
          })
        );
        continue;
      }

      if (!prepared.settlement.fundedForAward) {
        console.log(
          JSON.stringify({
            status: "BLOCKED_UNFUNDED",
            transactionSent: false,
            ...resultSummary(prepared),
          })
        );
        continue;
      }

      const sent = await sendPreparedSettlement({
        wallet: relayerWallet,
        provider,
        prepared,
        maxGasLimit,
        maxGasCostWei,
      });

      console.log(
        JSON.stringify({
          ...sent,
          awardId: prepared.awardId,
          awardDigest: prepared.awardDigest,
          recipient: request.award.recipient,
          amountRaw: prepared.settlement.amountRaw,
        })
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          status: "REJECTED",
          code: error.code || "GENESIS_RELAYER_REJECTED",
          message: error.message || String(error),
          transactionSent: false,
        })
      );
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
