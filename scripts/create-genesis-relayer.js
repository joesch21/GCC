const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet, getAddress } = require("ethers");
const { promptHidden } = require("./lib/prompt-hidden");

const DEFAULT_PATH = path.join(
  os.homedir(),
  ".config",
  "gcc",
  "genesis-relayer.keystore.json"
);

async function main() {
  const outputPath = path.resolve(
    process.argv[2] || process.env.GENESIS_RELAYER_KEYSTORE || DEFAULT_PATH
  );
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing relayer keystore: ${outputPath}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(outputPath), 0o700);
  } catch (_error) {}

  const password = await promptHidden(
    "Create Genesis relayer password (12+ characters): "
  );
  if (password.length < 12) {
    throw new Error("Use a password of at least 12 characters.");
  }
  const confirmation = await promptHidden("Confirm password: ");
  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }

  const wallet = Wallet.createRandom();
  const encryptedJson = await wallet.encrypt(password);
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, encryptedJson, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(outputPath, 0o600);
  } catch (_error) {}

  console.log(
    JSON.stringify(
      {
        role: "GENESIS_SETTLEMENT_RELAYER",
        address: getAddress(wallet.address),
        keystore: outputPath,
        status: "CREATED",
        permissionModel:
          "Permissionless settle() caller only; no GCC custody or arbitrary transaction API.",
        privateKeyExported: false,
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
