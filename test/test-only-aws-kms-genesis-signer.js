// TEST-ONLY: AWS KMS adapter for the opt-in GCC Genesis local-chain POC.
// It has no production custody, deployment, IAM, or provider integration role.

const { execFile } = require("child_process");
const crypto = require("crypto");
const { promisify } = require("util");
const { getAddress, keccak256 } = require("ethers");

const execFileAsync = promisify(execFile);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required AWS POC environment: ${name}`);
  return value;
}

async function awsJson(args) {
  try {
    const result = await execFileAsync("aws", args, {
      env: { ...process.env },
      shell: false,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (_error) {
    // Do not expose AWS CLI stderr, identifiers, credentials, or response data.
    throw new Error("AWS CLI operation failed");
  }
}

function deriveEthereumAddressFromKmsPublicKey(publicKeyDer) {
  let keyObject;
  try {
    keyObject = crypto.createPublicKey({
      key: publicKeyDer,
      format: "der",
      type: "spki",
    });
  } catch (_error) {
    throw new Error("KMS public key is not a valid SPKI key");
  }

  let jwk;
  try {
    jwk = keyObject.export({ format: "jwk" });
  } catch (_error) {
    throw new Error("KMS public key cannot be exported for validation");
  }

  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1") {
    throw new Error("KMS public key is not secp256k1");
  }

  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("KMS secp256k1 public point is not 32-byte affine form");
  }

  // Ethereum addresses are the low 20 bytes of keccak256(X || Y), excluding
  // the SEC1 uncompressed-point prefix byte.
  const addressHash = keccak256(Buffer.concat([x, y]));
  return getAddress(`0x${addressHash.slice(-40)}`);
}

async function getKmsEthereumAddress(keyId) {
  const response = await awsJson([
    "kms",
    "get-public-key",
    "--key-id",
    keyId,
    "--output",
    "json",
    "--no-cli-pager",
  ]);

  const keySpec = response.KeySpec || response.CustomerMasterKeySpec;
  if (keySpec !== "ECC_SECG_P256K1") {
    throw new Error("Configured KMS key is not ECC_SECG_P256K1");
  }
  if (response.KeyUsage !== "SIGN_VERIFY") {
    throw new Error("Configured KMS key is not a signing key");
  }
  if (
    !Array.isArray(response.SigningAlgorithms) ||
    !response.SigningAlgorithms.includes("ECDSA_SHA_256")
  ) {
    throw new Error("Configured KMS key does not support ECDSA_SHA_256");
  }
  if (typeof response.PublicKey !== "string" || response.PublicKey.length === 0) {
    throw new Error("KMS GetPublicKey returned no public key");
  }

  return deriveEthereumAddressFromKmsPublicKey(
    Buffer.from(response.PublicKey, "base64")
  );
}

async function signDigestWithKms(keyId, digestFilePath) {
  const response = await awsJson([
    "kms",
    "sign",
    "--key-id",
    keyId,
    "--message",
    `fileb://${digestFilePath}`,
    "--message-type",
    "DIGEST",
    "--signing-algorithm",
    "ECDSA_SHA_256",
    "--output",
    "json",
    "--no-cli-pager",
  ]);

  if (typeof response.Signature !== "string" || response.Signature.length === 0) {
    throw new Error("KMS Sign returned no signature");
  }

  return Buffer.from(response.Signature, "base64");
}

function getAwsKmsPocConfig() {
  const expectedAddressValue = requiredEnvironment("GCC_GENESIS_KMS_ADDRESS");
  let expectedAddress;
  try {
    expectedAddress = getAddress(expectedAddressValue);
  } catch (_error) {
    throw new Error("GCC_GENESIS_KMS_ADDRESS is not a valid address");
  }

  return {
    profile: requiredEnvironment("AWS_PROFILE"),
    keyId: requiredEnvironment("GCC_GENESIS_KMS_KEY_ID"),
    expectedAddress,
  };
}

module.exports = {
  getAwsKmsPocConfig,
  getKmsEthereumAddress,
  signDigestWithKms,
};
