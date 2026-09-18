const fs = require("fs");
const path = require("path");

const {
  AUTHORITY_DOMAIN,
  ESCROW_DOMAIN,
  normalizeProductionConfig,
  readPinnedPolicyHash,
} = require("../genesisVerifierB/configuration");
const { createGenesisVerifierB } = require("../genesisVerifierB");
const { createEncryptedLocalSigner } = require("./encryptedLocalSigner");

const TENDER_HASH_PATH = path.resolve(
  __dirname,
  "../../tenders/GCC-GENESIS-001.keccak256"
);

function configError(message) {
  const error = new Error(message);
  error.code = "GENESIS_VERIFIER_A_INCOMPLETE_CONFIGURATION";
  return error;
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`Missing trusted Verifier A configuration: ${name}`);
  }
  return value.trim();
}

function parseBoolean(value, name) {
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw configError(`${name} must be true or false`);
}

function readPinnedTenderHash() {
  return fs.readFileSync(TENDER_HASH_PATH, "utf8").trim().toLowerCase();
}

function loadVerifierAConfig(environment, signerAddress) {
  const signingEnabled = environment.GENESIS_VERIFIER_A_SIGNING_ENABLED
    ? parseBoolean(
        environment.GENESIS_VERIFIER_A_SIGNING_ENABLED,
        "GENESIS_VERIFIER_A_SIGNING_ENABLED"
      )
    : false;

  return normalizeProductionConfig({
    signingEnabled,
    chainId: 56,
    verifierAuthorityAddress: requiredEnvironment(
      environment,
      "GENESIS_VERIFIER_A_AUTHORITY_ADDRESS"
    ),
    escrowAddress: requiredEnvironment(
      environment,
      "GENESIS_VERIFIER_A_ESCROW_ADDRESS"
    ),
    escrowDomain: ESCROW_DOMAIN,
    authorityDomain: AUTHORITY_DOMAIN,
    tenderHash: readPinnedTenderHash(),
    policyHash: readPinnedPolicyHash(),
    allowedRewardClasses: ["QUALIFIED_PROPOSAL"],
    signerAddress,
    maxAwardValidityHorizonSeconds:
      environment.GENESIS_VERIFIER_A_MAX_AWARD_VALIDITY_HORIZON_SECONDS ||
      "86400",
  });
}

async function createGenesisVerifierAFromEnvironment({
  keystoreJson,
  password,
  environment = process.env,
  clock,
} = {}) {
  const signer = await createEncryptedLocalSigner({
    keystoreJson,
    password,
  });
  const config = loadVerifierAConfig(environment, signer.signerAddress);
  return Object.freeze({
    signerAddress: signer.signerAddress,
    verifier: createGenesisVerifierB({
      config,
      signer,
      clock,
    }),
  });
}

module.exports = {
  createEncryptedLocalSigner,
  createGenesisVerifierAFromEnvironment,
  loadVerifierAConfig,
  readPinnedTenderHash,
};
