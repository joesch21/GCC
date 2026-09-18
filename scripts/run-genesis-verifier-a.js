const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("node:readline");

const { promptHidden } = require("./lib/prompt-hidden");
const {
  createGenesisVerifierAFromEnvironment,
} = require("../src/genesisVerifierA");

const DEFAULT_PATH = path.join(
  os.homedir(),
  ".config",
  "gcc",
  "genesis-verifier-a.keystore.json"
);

async function main() {
  const keystorePath = path.resolve(
    process.argv[2] || process.env.GENESIS_VERIFIER_A_KEYSTORE || DEFAULT_PATH
  );
  const keystoreJson = fs.readFileSync(keystorePath, "utf8");
  const password = await promptHidden("Unlock Genesis Verifier A: ");

  const { signerAddress, verifier } =
    await createGenesisVerifierAFromEnvironment({
      keystoreJson,
      password,
      environment: process.env,
    });

  console.error(
    JSON.stringify({
      role: "GENESIS_VERIFIER_A",
      address: signerAddress,
      status: "READY",
      input: "newline-delimited Genesis evidence requests only",
      arbitraryDigestSigning: false,
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
      const result = await verifier.signGenesisAttestation(request);
      console.log(
        JSON.stringify({
          status: "SIGNED",
          signature: result.signature,
          audit: result.audit,
        })
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          status: "REJECTED",
          code: error.code || "GENESIS_VERIFIER_A_REJECTED",
          message: error.message || String(error),
        })
      );
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
