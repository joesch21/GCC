const fs = require("fs");
const path = require("path");
const {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} = require("ethers");

const GENESIS_CHAIN_ID = 56;
const GENESIS_TENDER_ID = "GCC-GENESIS-001";
const GENESIS_POLICY_VERSION = "0.3-draft";

const ESCROW_DOMAIN = Object.freeze({
  name: "GCC Genesis Deliverable Escrow",
  version: "1",
});

const AUTHORITY_DOMAIN = Object.freeze({
  name: "GCC Genesis Verifier Authority",
  version: "1",
});

const AWARD_TYPES = Object.freeze({
  Award: Object.freeze([
    Object.freeze({ name: "tenderHash", type: "bytes32" }),
    Object.freeze({ name: "awardClass", type: "bytes32" }),
    Object.freeze({ name: "deliverableHash", type: "bytes32" }),
    Object.freeze({ name: "assessmentHash", type: "bytes32" }),
    Object.freeze({ name: "recipient", type: "address" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
  ]),
});

const ATTESTATION_TYPES = Object.freeze({
  Attestation: Object.freeze([
    Object.freeze({ name: "awardDigest", type: "bytes32" }),
    Object.freeze({ name: "policyHash", type: "bytes32" }),
  ]),
});

const REWARD_CLASS_NAMES = Object.freeze([
  "QUALIFIED_PROPOSAL",
  "FINALIST",
  "SELECTED_COMPONENT",
]);

const REWARD_CLASS_HASHES = Object.freeze(
  Object.fromEntries(
    REWARD_CLASS_NAMES.map((name) => [name, keccak256(toUtf8Bytes(name))])
  )
);

const POLICY_HASH_PATH = path.resolve(
  __dirname,
  "../../policies/GCC-GENESIS-001.verifier-policy.keccak256"
);

const CONFIG_KEYS = Object.freeze([
  "signingEnabled",
  "chainId",
  "verifierAuthorityAddress",
  "escrowAddress",
  "escrowDomain",
  "authorityDomain",
  "tenderHash",
  "policyHash",
  "allowedRewardClasses",
  "signerAddress",
  "maxAwardValidityHorizonSeconds",
]);

function configurationError(message) {
  const error = new Error(message);
  error.code = "GENESIS_VERIFIER_B_INCOMPLETE_CONFIGURATION";
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw configurationError(`${label} must be an object`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw configurationError(`${label} contains unsupported field: ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw configurationError(`${label} is missing required field: ${key}`);
    }
  }
}

function normalizeUint(value, label, { allowZero = false, maximum } = {}) {
  let result;
  try {
    if (typeof value === "bigint") {
      result = value;
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new Error("not a safe integer");
      result = BigInt(value);
    } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
      result = BigInt(value);
    } else {
      throw new Error("not an unsigned integer");
    }
  } catch (_error) {
    throw configurationError(`${label} must be an unsigned integer`);
  }

  if (result < 0n || (!allowZero && result === 0n)) {
    throw configurationError(`${label} must be greater than zero`);
  }
  if (maximum !== undefined && result > maximum) {
    throw configurationError(`${label} is out of range`);
  }
  return result;
}

function normalizeAddress(value, label) {
  let address;
  try {
    address = getAddress(value);
  } catch (_error) {
    throw configurationError(`${label} must be a valid address`);
  }
  if (address === "0x0000000000000000000000000000000000000000") {
    throw configurationError(`${label} must not be the zero address`);
  }
  return address;
}

function normalizeHash(value, label) {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw configurationError(`${label} must be a 32-byte hex value`);
  }
  if (value.toLowerCase() === `0x${"00".repeat(32)}`) {
    throw configurationError(`${label} must not be zero`);
  }
  return value.toLowerCase();
}

function normalizeDomain(value, expected, label) {
  assertPlainObject(value, label);
  assertExactKeys(value, ["name", "version"], label);
  if (value.name !== expected.name || value.version !== expected.version) {
    throw configurationError(`${label} does not match the Genesis contract domain`);
  }
  return Object.freeze({ name: value.name, version: value.version });
}

function readPinnedPolicyHash() {
  let value;
  try {
    value = fs.readFileSync(POLICY_HASH_PATH, "utf8").trim().toLowerCase();
  } catch (_error) {
    throw configurationError("The pinned Genesis policy hash is unavailable");
  }
  if (!isHexString(value, 32) || value === `0x${"00".repeat(32)}`) {
    throw configurationError("The pinned Genesis policy hash is malformed");
  }
  return value;
}

function normalizeProductionConfig(config) {
  assertPlainObject(config, "production configuration");
  assertExactKeys(config, CONFIG_KEYS, "production configuration");

  if (typeof config.signingEnabled !== "boolean") {
    throw configurationError("signingEnabled must be boolean");
  }

  const chainId = normalizeUint(config.chainId, "chainId", {
    allowZero: true,
  });
  if (chainId !== BigInt(GENESIS_CHAIN_ID)) {
    throw configurationError("chainId must be 56");
  }

  const verifierAuthorityAddress = normalizeAddress(
    config.verifierAuthorityAddress,
    "verifierAuthorityAddress"
  );
  const escrowAddress = normalizeAddress(config.escrowAddress, "escrowAddress");

  const escrowDomain = normalizeDomain(
    config.escrowDomain,
    ESCROW_DOMAIN,
    "escrowDomain"
  );
  const authorityDomain = normalizeDomain(
    config.authorityDomain,
    AUTHORITY_DOMAIN,
    "authorityDomain"
  );

  const tenderHash = normalizeHash(config.tenderHash, "tenderHash");
  const policyHash = normalizeHash(config.policyHash, "policyHash");
  if (policyHash !== readPinnedPolicyHash()) {
    throw configurationError("policyHash does not match the pinned Genesis policy");
  }

  if (
    !Array.isArray(config.allowedRewardClasses) ||
    config.allowedRewardClasses.length === 0
  ) {
    throw configurationError("allowedRewardClasses must be a non-empty array");
  }
  const allowedRewardClasses = config.allowedRewardClasses.map((name) => {
    if (
      typeof name !== "string" ||
      !REWARD_CLASS_NAMES.includes(name)
    ) {
      throw configurationError(`Unknown reward class in configuration: ${name}`);
    }
    return name;
  });
  if (new Set(allowedRewardClasses).size !== allowedRewardClasses.length) {
    throw configurationError("allowedRewardClasses must not contain duplicates");
  }
  if (
    allowedRewardClasses.length !== 1 ||
    allowedRewardClasses[0] !== "QUALIFIED_PROPOSAL"
  ) {
    throw configurationError(
      "Genesis I permits only QUALIFIED_PROPOSAL under the pinned policy"
    );
  }

  const signerAddress = normalizeAddress(config.signerAddress, "signerAddress");
  const maxAwardValidityHorizonSeconds = normalizeUint(
    config.maxAwardValidityHorizonSeconds,
    "maxAwardValidityHorizonSeconds",
    { maximum: (1n << 64n) - 1n }
  );

  return Object.freeze({
    signingEnabled: config.signingEnabled,
    chainId: Number(chainId),
    verifierAuthorityAddress,
    escrowAddress,
    escrowDomain,
    authorityDomain,
    tenderHash,
    policyHash,
    allowedRewardClasses: Object.freeze(allowedRewardClasses),
    signerAddress,
    maxAwardValidityHorizonSeconds,
  });
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw configurationError(`Missing trusted environment configuration: ${name}`);
  }
  return value.trim();
}

function parseBoolean(value, name) {
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw configurationError(`${name} must be true or false`);
}

function parseAllowedRewardClasses(value) {
  let classes;
  if (value.startsWith("[")) {
    try {
      classes = JSON.parse(value);
    } catch (_error) {
      throw configurationError("Allowed reward classes are malformed");
    }
  } else {
    classes = value.split(",").map((item) => item.trim());
  }
  return classes;
}

function loadProductionConfig(environment = process.env) {
  const signingEnabled = environment.GENESIS_VERIFIER_B_SIGNING_ENABLED
    ? parseBoolean(
        environment.GENESIS_VERIFIER_B_SIGNING_ENABLED,
        "GENESIS_VERIFIER_B_SIGNING_ENABLED"
      )
    : false;

  return normalizeProductionConfig({
    signingEnabled,
    chainId: requiredEnvironment(environment, "GENESIS_VERIFIER_B_CHAIN_ID"),
    verifierAuthorityAddress: requiredEnvironment(
      environment,
      "GENESIS_VERIFIER_B_AUTHORITY_ADDRESS"
    ),
    escrowAddress: requiredEnvironment(
      environment,
      "GENESIS_VERIFIER_B_ESCROW_ADDRESS"
    ),
    escrowDomain: {
      name: requiredEnvironment(
        environment,
        "GENESIS_VERIFIER_B_ESCROW_DOMAIN_NAME"
      ),
      version: requiredEnvironment(
        environment,
        "GENESIS_VERIFIER_B_ESCROW_DOMAIN_VERSION"
      ),
    },
    authorityDomain: {
      name: requiredEnvironment(
        environment,
        "GENESIS_VERIFIER_B_AUTHORITY_DOMAIN_NAME"
      ),
      version: requiredEnvironment(
        environment,
        "GENESIS_VERIFIER_B_AUTHORITY_DOMAIN_VERSION"
      ),
    },
    tenderHash: requiredEnvironment(
      environment,
      "GENESIS_VERIFIER_B_TENDER_HASH"
    ),
    policyHash: requiredEnvironment(
      environment,
      "GENESIS_VERIFIER_B_POLICY_HASH"
    ),
    allowedRewardClasses: parseAllowedRewardClasses(
      requiredEnvironment(
        environment,
        "GENESIS_VERIFIER_B_ALLOWED_REWARD_CLASSES"
      )
    ),
    signerAddress: requiredEnvironment(
      environment,
      "GENESIS_VERIFIER_B_SIGNER_ADDRESS"
    ),
    maxAwardValidityHorizonSeconds: requiredEnvironment(
      environment,
      "GENESIS_VERIFIER_B_MAX_AWARD_VALIDITY_HORIZON_SECONDS"
    ),
  });
}

module.exports = {
  ATTESTATION_TYPES,
  AUTHORITY_DOMAIN,
  AWARD_TYPES,
  ESCROW_DOMAIN,
  GENESIS_CHAIN_ID,
  GENESIS_POLICY_VERSION,
  GENESIS_TENDER_ID,
  POLICY_HASH_PATH,
  REWARD_CLASS_HASHES,
  REWARD_CLASS_NAMES,
  loadProductionConfig,
  normalizeProductionConfig,
  readPinnedPolicyHash,
};
