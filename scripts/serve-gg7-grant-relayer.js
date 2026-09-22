const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  JsonRpcProvider,
  getAddress,
} = require("ethers");

const { unlockRelayer } = require("../src/genesisSettlement/encryptedRelayer");
const {
  EXISTING_RELAYER,
  VERIFIED_GG6_ESCROW,
  createGg7RelayCore,
} = require("../src/gg7RelayCore");

const SOCKET_PATH =
  process.env.GG7_RELAY_SOCKET || "/run/gcc/gg7-grant-relayer.sock";
const KEYSTORE_PATH =
  process.env.GENESIS_RELAYER_KEYSTORE ||
  path.join(os.homedir(), ".config", "gcc", "genesis-relayer.keystore.json");
const RPC_URL =
  process.env.BSC_RPC_URL ||
  process.env.GCC_BSC_RPC_URL ||
  "https://bsc-dataseed.binance.org/";
const LIVE_ENABLED =
  process.env.GG7_RELAYER_LIVE === "1" ||
  String(process.env.GG7_RELAYER_LIVE || "").toLowerCase() === "true";

if (process.env.GG7_RELAYER_PASSWORD) {
  throw new Error("GG7_RELAYER_PASSWORD environment variable is forbidden; use a protected credential file");
}

function credentialPath() {
  const explicit = String(process.env.GG7_RELAYER_PASSWORD_FILE || "").trim();
  if (explicit) return explicit;
  const directory = String(process.env.CREDENTIALS_DIRECTORY || "").trim();
  if (directory) return path.join(directory, "gg7-relayer-password");
  return "";
}

function readPasswordFile() {
  const file = credentialPath();
  if (!file) {
    throw new Error("GG7 relayer password credential file is required for live mode");
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("GG7 relayer password credential must be a file");
  const password = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (!password) throw new Error("GG7 relayer password credential is empty");
  return password;
}

async function loadWallet() {
  if (!LIVE_ENABLED) return null;
  const keystoreJson = fs.readFileSync(KEYSTORE_PATH, "utf8");
  const password = readPasswordFile();
  try {
    const unlocked = await unlockRelayer({ keystoreJson, password });
    if (getAddress(unlocked.address) !== getAddress(EXISTING_RELAYER)) {
      throw new Error("GG7 relayer keystore does not match canonical existing relayer");
    }
    return unlocked.wallet;
  } finally {
    // Best-effort: no password is retained outside the local function scope.
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error("gg7_request_too_large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("gg7_json_invalid"));
      }
    });
    req.on("error", reject);
  });
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = await loadWallet();
  const relay = createGg7RelayCore({
    provider,
    wallet,
    config: {
      escrowAddress:
        process.env.GG7_GRANT_ESCROW_ADDRESS || VERIFIED_GG6_ESCROW,
    },
  });

  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o750 });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://unix.local");

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        schema: "gcc.gg7_bounded_relay_health.v1",
        status: "READY",
        liveEnabled: LIVE_ENABLED,
        chainId: 56,
        target: relay.config.escrowAddress,
        relayer: getAddress(EXISTING_RELAYER),
        transport: "unix_socket",
        socketPath: SOCKET_PATH,
        arbitraryTarget: false,
        arbitraryFunction: false,
      });
    }

    if (req.method !== "POST" ||
        !["/simulate", "/settle"].includes(url.pathname)) {
      return json(res, 404, { status: "NOT_FOUND" });
    }

    try {
      const request = await readJson(req);
      if (url.pathname === "/simulate") {
        return json(res, 200, await relay.simulate(request));
      }
      if (!LIVE_ENABLED) {
        return json(res, 503, {
          status: "REJECTED",
          transactionSent: false,
          error: "gg7_live_send_disabled",
        });
      }
      return json(res, 200, await relay.settle(request));
    } catch (error) {
      return json(res, 400, {
        status: "REJECTED",
        transactionSent: false,
        error: error.message || String(error),
      });
    }
  });

  server.on("close", () => {
    provider.destroy();
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
  });

  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o660);
    console.log(JSON.stringify({
      role: "GG7_GRANT_PAYOUT_RELAY",
      status: "LISTENING",
      liveEnabled: LIVE_ENABLED,
      socketPath: SOCKET_PATH,
      target: relay.config.escrowAddress,
      relayer: getAddress(EXISTING_RELAYER),
      credentialMode: LIVE_ENABLED ? "protected_file" : "none_dry_run",
      passwordInEnvironment: false,
      tcpListening: false,
    }));
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
