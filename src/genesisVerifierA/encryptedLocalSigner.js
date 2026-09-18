const {
  Wallet,
  getAddress,
  isHexString,
  recoverAddress,
} = require("ethers");

function verifierAError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function createEncryptedLocalSigner({ keystoreJson, password }) {
  if (typeof keystoreJson !== "string" || keystoreJson.trim() === "") {
    throw verifierAError(
      "GENESIS_VERIFIER_A_KEYSTORE_INVALID",
      "Encrypted Verifier A keystore JSON is required"
    );
  }
  if (typeof password !== "string" || password.length === 0) {
    throw verifierAError(
      "GENESIS_VERIFIER_A_PASSWORD_REQUIRED",
      "Verifier A keystore password is required"
    );
  }

  let wallet;
  try {
    wallet = await Wallet.fromEncryptedJson(keystoreJson, password);
  } catch (_error) {
    throw verifierAError(
      "GENESIS_VERIFIER_A_UNLOCK_FAILED",
      "Verifier A keystore could not be unlocked"
    );
  }

  const signerAddress = getAddress(wallet.address);

  return Object.freeze({
    signerAddress,

    async signGenesisAttestationDigest(digest) {
      if (typeof digest !== "string" || !isHexString(digest, 32)) {
        throw verifierAError(
          "GENESIS_VERIFIER_A_DIGEST_INVALID",
          "Verifier A accepts only an internally-derived 32-byte digest"
        );
      }

      const signature = wallet.signingKey.sign(digest).serialized;
      const recovered = getAddress(recoverAddress(digest, signature));
      if (recovered !== signerAddress) {
        throw verifierAError(
          "GENESIS_VERIFIER_A_SIGNATURE_INVALID",
          "Verifier A signature self-check failed"
        );
      }
      return signature;
    },
  });
}

module.exports = {
  createEncryptedLocalSigner,
};
