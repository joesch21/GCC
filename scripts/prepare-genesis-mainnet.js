const fs = require("fs");
const path = require("path");
const { getAddress, isAddress, parseUnits } = require("ethers");

const GCC_TOKEN = "0x092ac429b9c3450c9909433eb0662c3b7c13cf9a";
const DEFAULT_VERIFIER_B = "0x2d6D19751d48bD8e6008eE04E70f64AD17f759A6";
const ZERO = "0x0000000000000000000000000000000000000000";

function readPinned(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8").trim();
}

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || !isAddress(value) || value.toLowerCase() === ZERO) {
    throw new Error(`${name} must be a non-zero EVM address`);
  }
  return getAddress(value);
}

function optionalAddress(name) {
  const value = process.env[name];
  if (!value) return null;
  if (!isAddress(value) || value.toLowerCase() === ZERO) {
    throw new Error(`${name} must be a non-zero EVM address`);
  }
  return getAddress(value);
}

function main() {
  const verifierA = requiredAddress("GENESIS_VERIFIER_A_ADDRESS");
  const verifierB = process.env.GENESIS_VERIFIER_B_ADDRESS
    ? requiredAddress("GENESIS_VERIFIER_B_ADDRESS")
    : getAddress(DEFAULT_VERIFIER_B);
  const verifierC = requiredAddress("GENESIS_VERIFIER_C_ADDRESS");

  const unique = new Set([verifierA.toLowerCase(), verifierB.toLowerCase(), verifierC.toLowerCase()]);
  if (unique.size !== 3) throw new Error("Verifier A, B, and C must be three distinct addresses");

  const tenderHash = readPinned("tenders/GCC-GENESIS-001.keccak256");
  const policyHash = readPinned("policies/GCC-GENESIS-001.verifier-policy.keccak256");

  const deadlineText = process.env.GENESIS_SETTLEMENT_DEADLINE;
  if (!deadlineText || !/^\d+$/.test(deadlineText)) {
    throw new Error("GENESIS_SETTLEMENT_DEADLINE must be the intended Unix settlement deadline (14-day submission window + 7-day grace from public opening)");
  }
  const settlementDeadline = BigInt(deadlineText);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (settlementDeadline <= now) throw new Error("GENESIS_SETTLEMENT_DEADLINE must be in the future");

  const authorityAddress = optionalAddress("GENESIS_AUTHORITY_ADDRESS");

  const output = {
    network: { name: "BNB Smart Chain Mainnet", chainId: 56 },
    bindings: {
      gccToken: getAddress(GCC_TOKEN),
      gccDecimals: 18,
      tenderHash,
      policyHash
    },
    verifierProfile: {
      A: verifierA,
      B: verifierB,
      BSource: process.env.GENESIS_VERIFIER_B_ADDRESS ? "environment override" : "existing Genesis I AWS KMS experimental signer",
      C: verifierC,
      threshold: 2
    },
    GenesisVerifierAuthority: {
      constructorArgs: [policyHash, verifierA, verifierB, verifierC]
    },
    GenesisDeliverableEscrow: authorityAddress
      ? {
          constructorArgs: [
            getAddress(GCC_TOKEN),
            authorityAddress,
            tenderHash,
            settlementDeadline.toString(),
            parseUnits("10", 18).toString(),
            10,
            "0",
            0,
            "0",
            0
          ],
          rewardCapRaw: parseUnits("100", 18).toString(),
          rewardCapGcc: "100"
        }
      : {
          status: "WAITING_FOR_DEPLOYED_AUTHORITY_ADDRESS",
          next: "After the authority deployment is mined and verified, set GENESIS_AUTHORITY_ADDRESS and rerun this script."
        },
    funding: {
      rule: "Do not fund before both contracts are deployed, verified, constructor bindings are checked, and the live GCC transfer-fee preflight has passed.",
      amountGcc: "100"
    }
  };

  console.log(JSON.stringify(output, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
