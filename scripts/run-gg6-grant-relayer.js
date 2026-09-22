const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("node:readline");
const {
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
  parseEther,
} = require("ethers");

const { promptHidden } = require("./lib/prompt-hidden");
const { unlockRelayer } = require("../src/genesisSettlement/encryptedRelayer");

const ROOT = path.resolve(__dirname, "..");
const GENESIS_RECORD_PATH = path.join(
  ROOT,
  "deployments",
  "GCC-GENESIS-001-bsc-mainnet.json"
);
const RELAYER_KEYSTORE_PATH =
  process.env.GENESIS_RELAYER_KEYSTORE ||
  path.join(os.homedir(), ".config", "gcc", "genesis-relayer.keystore.json");

const ESCROW_ABI = [
  "function gcc() view returns (address)",
  "function humanAuthority() view returns (address)",
  "function relayer() view returns (address)",
  "function escrowBalance() view returns (uint256)",
  "function fundingShortfall(uint256 pendingAmount) view returns (uint256)",
  "function settle((bytes32 transferMaterialHash,address recipient,uint256 amount,uint64 validUntil) payout, bytes humanAuthorization) returns (bytes32)",
];

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

async function main() {
  const genesisRecord = JSON.parse(fs.readFileSync(GENESIS_RECORD_PATH, "utf8"));
  const expectedRelayer = getAddress(genesisRecord.relayer.address);
  const expectedGcc = getAddress(genesisRecord.gccToken);

  const escrowAddress = process.env.GG6_GRANT_ESCROW_ADDRESS
    ? getAddress(process.env.GG6_GRANT_ESCROW_ADDRESS)
    : null;
  if (!escrowAddress) {
    throw new Error("GG6_GRANT_ESCROW_ADDRESS is required");
  }
  if (escrowAddress === getAddress(genesisRecord.escrow.address)) {
    throw new Error("Refusing to use the Genesis tender escrow for GG-6 grants");
  }

  const provider = new JsonRpcProvider(
    process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/"
  );
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Expected BSC mainnet chain 56, got ${network.chainId}`);
  }

  const escrow = new Contract(escrowAddress, ESCROW_ABI, provider);
  const [configuredGcc, configuredRelayer, humanAuthority] = await Promise.all([
    escrow.gcc(),
    escrow.relayer(),
    escrow.humanAuthority(),
  ]);
  if (getAddress(configuredGcc) !== expectedGcc) {
    throw new Error("GG-6 escrow GCC token does not match canonical mainnet GCC");
  }
  if (getAddress(configuredRelayer) !== expectedRelayer) {
    throw new Error("GG-6 escrow does not bind the existing Genesis relayer");
  }

  const sendEnabled = parseBoolean(process.env.GG6_RELAYER_SEND);
  const maxGasLimit = parsePositiveBigInt(
    process.env.GG6_RELAYER_MAX_GAS_LIMIT,
    "500000",
    "GG6_RELAYER_MAX_GAS_LIMIT"
  );
  const maxGasCostWei = parsePositiveBigInt(
    process.env.GG6_RELAYER_MAX_GAS_COST_WEI,
    parseEther("0.005").toString(),
    "GG6_RELAYER_MAX_GAS_COST_WEI"
  );

  let wallet = null;
  if (sendEnabled) {
    const keystoreJson = fs.readFileSync(RELAYER_KEYSTORE_PATH, "utf8");
    const password = await promptHidden("Unlock existing Genesis relayer for GG-6 payout: ");
    const unlocked = await unlockRelayer({ keystoreJson, password });
    if (getAddress(unlocked.address) !== expectedRelayer) {
      throw new Error("Relayer keystore does not match canonical existing relayer");
    }
    wallet = unlocked.wallet.connect(provider);
  }

  const iface = new Interface(ESCROW_ABI);

  console.error(JSON.stringify({
    role: "GG6_GRANT_PAYOUT_RELAYER",
    mode: sendEnabled ? "LIVE_SEND" : "DRY_RUN",
    chainId: 56,
    gccToken: expectedGcc,
    grantEscrow: escrowAddress,
    existingRelayer: expectedRelayer,
    humanAuthority: getAddress(humanAuthority),
    genesisTenderEscrowReused: false,
    arbitraryTransactions: false,
    allowedTarget: escrowAddress,
    allowedFunction: "settle(Payout,bytes)",
    maxGasLimit: maxGasLimit.toString(),
    maxGasCostWei: maxGasCostWei.toString(),
  }));

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
      const payout = request.payout;
      const humanAuthorization = String(request.humanAuthorization || "");
      if (!payout || !humanAuthorization.startsWith("0x")) {
        throw new Error("payout and humanAuthorization are required");
      }

      const data = iface.encodeFunctionData("settle", [payout, humanAuthorization]);
      const from = expectedRelayer;

      const [gasEstimate, simulation] = await Promise.all([
        provider.estimateGas({ from, to: escrowAddress, data, value: 0n }),
        provider.call({ from, to: escrowAddress, data, value: 0n }),
      ]);

      if (gasEstimate > maxGasLimit) {
        throw new Error("GG6_RELAYER_GAS_LIMIT_EXCEEDED");
      }

      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
      if (!gasPrice) throw new Error("Could not resolve BSC gas price");
      const estimatedGasCost = gasEstimate * gasPrice;
      if (estimatedGasCost > maxGasCostWei) {
        throw new Error("GG6_RELAYER_GAS_COST_EXCEEDED");
      }

      if (!sendEnabled) {
        console.log(JSON.stringify({
          status: "DRY_RUN_PASS",
          transactionSent: false,
          fundsMoved: false,
          target: escrowAddress,
          function: "settle(Payout,bytes)",
          gasEstimate: gasEstimate.toString(),
          estimatedGasCostWei: estimatedGasCost.toString(),
          simulationResult: simulation,
          payout,
        }));
        continue;
      }

      const tx = await wallet.sendTransaction({
        to: escrowAddress,
        data,
        value: 0n,
        gasLimit: gasEstimate,
      });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error("GG6_RELAYER_TRANSACTION_FAILED");
      }

      console.log(JSON.stringify({
        status: "SENT",
        transactionSent: true,
        transactionHash: tx.hash,
        blockNumber: receipt.blockNumber,
        target: escrowAddress,
        payout,
      }));
    } catch (error) {
      console.log(JSON.stringify({
        status: "REJECTED",
        transactionSent: false,
        code: error.code || "GG6_RELAYER_REJECTED",
        message: error.message || String(error),
      }));
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
