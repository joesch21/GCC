const fs = require("fs");
const path = require("path");
const { JsonRpcProvider } = require("ethers");
const {
  checkGenesisLiveReadiness,
} = require("../src/genesisIntake/liveReadiness");

const ROOT = path.resolve(__dirname, "..");
const RECORD_PATH = path.join(
  ROOT,
  "deployments",
  "GCC-GENESIS-001-bsc-mainnet.json"
);

async function main() {
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
  const provider = new JsonRpcProvider(
    process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/"
  );
  const result = await checkGenesisLiveReadiness({ provider, record });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "FAIL",
      code: error.code || "GENESIS_LIVE_READINESS_FAILED",
      message: error.message || String(error),
    })
  );
  process.exitCode = 1;
});
