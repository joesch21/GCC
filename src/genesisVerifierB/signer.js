const { getAddress } = require("ethers");

function signerError(message) {
  const error = new Error(message);
  error.code = "GENESIS_VERIFIER_B_SIGNER_INVALID";
  return error;
}

function assertSignerInterface(signer, configuredSignerAddress) {
  if (signer === null || typeof signer !== "object") {
    throw signerError("A restricted Genesis signer adapter is required");
  }
  if (typeof signer.signGenesisAttestationDigest !== "function") {
    throw signerError(
      "Signer adapter must implement signGenesisAttestationDigest(digest)"
    );
  }
  let signerAddress;
  try {
    signerAddress = getAddress(signer.signerAddress);
  } catch (_error) {
    throw signerError("Signer adapter must declare its signerAddress");
  }
  if (signerAddress !== configuredSignerAddress) {
    throw signerError("Signer adapter identity does not match configuration");
  }
}

module.exports = {
  assertSignerInterface,
};
