const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const {
  getAddress,
  getBytes,
  isHexString,
  keccak256,
  recoverAddress,
  toBeHex,
  zeroPadValue,
} = require("ethers");

const execFileAsync = promisify(execFile);

const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

function kmsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function awsJson(args) {
  try {
    const { stdout } = await execFileAsync("aws", args, {
      env: { ...process.env },
      shell: false,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (_error) {
    throw kmsError(
      "GENESIS_VERIFIER_B_AWS_CLI_FAILED",
      "AWS CLI operation failed. Ensure the AWS session is logged in and the current identity can use the Genesis KMS key."
    );
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
    throw kmsError(
      "GENESIS_VERIFIER_B_PUBLIC_KEY_INVALID",
      "KMS public key is not valid SPKI"
    );
  }

  const jwk = keyObject.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1") {
    throw kmsError(
      "GENESIS_VERIFIER_B_PUBLIC_KEY_INVALID",
      "KMS key is not secp256k1"
    );
  }

  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  if (x.length !== 32 || y.length !== 32) {
    throw kmsError(
      "GENESIS_VERIFIER_B_PUBLIC_KEY_INVALID",
      "KMS secp256k1 affine coordinates are malformed"
    );
  }

  const addressHash = keccak256(Buffer.concat([x, y]));
  return getAddress(`0x${addressHash.slice(-40)}`);
}

async function getKmsEthereumAddress(keyId) {
  let response;
  try {
    response = await awsJson([
      "kms",
      "get-public-key",
      "--key-id",
      keyId,
      "--output",
      "json",
      "--no-cli-pager",
    ]);
  } catch (error) {
    throw error;
  }

  const keySpec = response.KeySpec || response.CustomerMasterKeySpec;
  if (keySpec !== "ECC_SECG_P256K1" || response.KeyUsage !== "SIGN_VERIFY") {
    throw kmsError(
      "GENESIS_VERIFIER_B_KMS_KEY_INVALID",
      "Configured KMS key is not an ECC_SECG_P256K1 signing key"
    );
  }
  if (
    !Array.isArray(response.SigningAlgorithms) ||
    !response.SigningAlgorithms.includes("ECDSA_SHA_256")
  ) {
    throw kmsError(
      "GENESIS_VERIFIER_B_KMS_KEY_INVALID",
      "Configured KMS key does not support ECDSA_SHA_256"
    );
  }

  return deriveEthereumAddressFromKmsPublicKey(
    Buffer.from(response.PublicKey, "base64")
  );
}

async function discoverKmsKeyByAddress(expectedAddress) {
  const expected = getAddress(expectedAddress);

  if (process.env.GCC_GENESIS_KMS_KEY_ID) {
    const keyId = process.env.GCC_GENESIS_KMS_KEY_ID.trim();
    const derived = await getKmsEthereumAddress(keyId);
    if (derived !== expected) {
      throw kmsError(
        "GENESIS_VERIFIER_B_KMS_ADDRESS_MISMATCH",
        "GCC_GENESIS_KMS_KEY_ID does not correspond to the immutable Verifier B address"
      );
    }
    return keyId;
  }

  const listed = await awsJson([
    "kms",
    "list-keys",
    "--output",
    "json",
    "--no-cli-pager",
  ]);
  const keys = Array.isArray(listed.Keys) ? listed.Keys : [];
  const matches = [];

  for (const entry of keys) {
    if (!entry || !entry.KeyId) continue;
    try {
      const derived = await getKmsEthereumAddress(entry.KeyId);
      if (derived === expected) matches.push(entry.KeyId);
    } catch (_error) {
      // Ignore keys that are inaccessible or not secp256k1 signing keys.
    }
  }

  if (matches.length === 0) {
    throw kmsError(
      "GENESIS_VERIFIER_B_KMS_KEY_NOT_FOUND",
      "No accessible AWS KMS key matches the immutable Genesis Verifier B address. If ListKeys is restricted, set GCC_GENESIS_KMS_KEY_ID locally and rerun."
    );
  }
  if (matches.length > 1) {
    throw kmsError(
      "GENESIS_VERIFIER_B_KMS_KEY_AMBIGUOUS",
      "More than one accessible KMS key maps to the immutable Verifier B address"
    );
  }
  return matches[0];
}

function readDerLength(bytes, offset) {
  if (offset >= bytes.length) throw kmsError("GENESIS_VERIFIER_B_DER_INVALID", "Malformed DER length");
  const first = bytes[offset++];
  if ((first & 0x80) === 0) return { length: first, offset };
  const octetCount = first & 0x7f;
  if (octetCount === 0 || octetCount > 2 || offset + octetCount > bytes.length) {
    throw kmsError("GENESIS_VERIFIER_B_DER_INVALID", "Malformed DER length");
  }
  let length = 0;
  for (let i = 0; i < octetCount; i += 1) {
    length = (length << 8) | bytes[offset + i];
  }
  return { length, offset: offset + octetCount };
}

function readDerInteger(bytes, offset, end) {
  if (offset >= end || bytes[offset++] !== 0x02) {
    throw kmsError("GENESIS_VERIFIER_B_DER_INVALID", "Malformed DER integer");
  }
  const lengthResult = readDerLength(bytes, offset);
  offset = lengthResult.offset;
  const integerEnd = offset + lengthResult.length;
  if (lengthResult.length === 0 || integerEnd > end) {
    throw kmsError("GENESIS_VERIFIER_B_DER_INVALID", "Truncated DER integer");
  }
  if ((bytes[offset] & 0x80) !== 0) {
    throw kmsError("GENESIS_VERIFIER_B_DER_INVALID", "Negative DER integer");
  }

  let value = 0n;
  for (let i = offset; i < integerEnd; i += 1) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  if (value <= 0n || value >= SECP256K1_ORDER) {
    throw kmsError("GENESIS_VERIFIER_B_DER_INVALID", "Invalid ECDSA scalar");
  }
  return { value, offset: integerEnd };
}

function parseDerSignature(derSignature) {
  const bytes = getBytes(derSignature);
  if (bytes.length < 8 || bytes[0] !== 0x30) {
    throw kmsError("GENESIS_VERIFIER_B_DER_INVALID", "Expected DER sequence");
  }
  const sequence = readDerLength(bytes, 1);
  const end = sequence.offset + sequence.length;
  if (end !== bytes.length) {
    throw kmsError("GENESIS_VERIFIER_B_DER_INVALID", "DER sequence length mismatch");
  }
  const r = readDerInteger(bytes, sequence.offset, end);
  const s = readDerInteger(bytes, r.offset, end);
  if (s.offset !== end) {
    throw kmsError("GENESIS_VERIFIER_B_DER_INVALID", "Trailing DER data");
  }
  return { r: r.value, s: s.value };
}

function toFixed32(value) {
  return zeroPadValue(toBeHex(value), 32);
}

function ethereumSignatureFromDer({ digest, derSignature, expectedAddress }) {
  if (!isHexString(digest, 32)) {
    throw kmsError(
      "GENESIS_VERIFIER_B_DIGEST_INVALID",
      "KMS signer accepts only a 32-byte attestation digest"
    );
  }

  const expected = getAddress(expectedAddress);
  const parsed = parseDerSignature(derSignature);
  const s =
    parsed.s > SECP256K1_HALF_ORDER
      ? SECP256K1_ORDER - parsed.s
      : parsed.s;

  for (const v of [27, 28]) {
    const signature = `${toFixed32(parsed.r)}${toFixed32(s).slice(2)}${toBeHex(v, 1).slice(2)}`;
    try {
      if (getAddress(recoverAddress(digest, signature)) === expected) {
        return signature;
      }
    } catch (_error) {
      // Try the other recovery id.
    }
  }

  throw kmsError(
    "GENESIS_VERIFIER_B_SIGNATURE_RECOVERY_FAILED",
    "KMS signature does not recover the immutable Verifier B address"
  );
}

async function signDigestWithKms(keyId, digest) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-genesis-kms-"));
  const digestPath = path.join(directory, "digest.bin");
  try {
    await fs.writeFile(digestPath, Buffer.from(getBytes(digest)), { mode: 0o600 });
    const response = await awsJson([
      "kms",
      "sign",
      "--key-id",
      keyId,
      "--message",
      `fileb://${digestPath}`,
      "--message-type",
      "DIGEST",
      "--signing-algorithm",
      "ECDSA_SHA_256",
      "--output",
      "json",
      "--no-cli-pager",
    ]);
    if (!response.Signature) {
      throw kmsError(
        "GENESIS_VERIFIER_B_KMS_SIGN_FAILED",
        "AWS KMS returned no signature"
      );
    }
    return Buffer.from(response.Signature, "base64");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function createAwsKmsGenesisSigner({ expectedAddress, keyId } = {}) {
  const signerAddress = getAddress(expectedAddress);
  const resolvedKeyId = keyId || (await discoverKmsKeyByAddress(signerAddress));
  const derivedAddress = await getKmsEthereumAddress(resolvedKeyId);
  if (derivedAddress !== signerAddress) {
    throw kmsError(
      "GENESIS_VERIFIER_B_KMS_ADDRESS_MISMATCH",
      "AWS KMS key does not correspond to the immutable Verifier B address"
    );
  }

  return Object.freeze({
    signerAddress,
    async signGenesisAttestationDigest(digest) {
      if (!isHexString(digest, 32)) {
        throw kmsError(
          "GENESIS_VERIFIER_B_DIGEST_INVALID",
          "AWS KMS signer accepts only a 32-byte attestation digest"
        );
      }
      const der = await signDigestWithKms(resolvedKeyId, digest);
      return ethereumSignatureFromDer({
        digest,
        derSignature: der,
        expectedAddress: signerAddress,
      });
    },
  });
}

module.exports = {
  createAwsKmsGenesisSigner,
  deriveEthereumAddressFromKmsPublicKey,
  discoverKmsKeyByAddress,
  ethereumSignatureFromDer,
  getKmsEthereumAddress,
  parseDerSignature,
};
