const { Wallet, getAddress } = require("ethers");

function relayerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function unlockRelayer({ keystoreJson, password }) {
  if (typeof keystoreJson !== "string" || keystoreJson.trim() === "") {
    throw relayerError(
      "GENESIS_RELAYER_KEYSTORE_INVALID",
      "Encrypted Genesis relayer keystore JSON is required"
    );
  }
  if (typeof password !== "string" || password.length === 0) {
    throw relayerError(
      "GENESIS_RELAYER_PASSWORD_REQUIRED",
      "Genesis relayer keystore password is required"
    );
  }

  let wallet;
  try {
    wallet = await Wallet.fromEncryptedJson(keystoreJson, password);
  } catch (_error) {
    throw relayerError(
      "GENESIS_RELAYER_UNLOCK_FAILED",
      "Genesis relayer keystore could not be unlocked"
    );
  }

  return Object.freeze({
    address: getAddress(wallet.address),
    wallet,
  });
}

module.exports = { unlockRelayer };
