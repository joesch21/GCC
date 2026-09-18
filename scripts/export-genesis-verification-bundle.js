const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

function canonicalAddress(value) {
  return hre.ethers.getAddress(String(value).toLowerCase());
}

const ROOT = path.resolve(__dirname, "..");
const RECORD_PATH = path.join(
  ROOT,
  "deployments",
  "GCC-GENESIS-001-bsc-mainnet.json"
);
const OUT_DIR = path.join(ROOT, "verification-bundle");

async function exportContract({ label, fqn, address, constructorTypes, constructorValues }) {
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  if (!buildInfo) {
    throw new Error(`Missing Hardhat build info for ${fqn}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const inputPath = path.join(
    OUT_DIR,
    `${label}.standard-json-input.json`
  );
  fs.writeFileSync(
    inputPath,
    JSON.stringify(buildInfo.input, null, 2) + "\n",
    "utf8"
  );

  const constructorArgs = hre.ethers.AbiCoder.defaultAbiCoder()
    .encode(constructorTypes, constructorValues)
    .slice(2);

  const metadata = {
    contract: label,
    fullyQualifiedName: fqn,
    address,
    chainId: 56,
    compiler: {
      version: buildInfo.solcVersion,
      longVersion: buildInfo.solcLongVersion,
      optimizer: buildInfo.input.settings.optimizer,
      evmVersion: buildInfo.input.settings.evmVersion,
    },
    verificationMode: "Solidity (Standard-Json-Input)",
    constructorArgumentsHexWithout0x: constructorArgs,
    standardJsonInputFile: path.basename(inputPath),
    bscscanContractUrl: `https://bscscan.com/address/${address}#code`,
  };

  const metadataPath = path.join(OUT_DIR, `${label}.verification.json`);
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8"
  );

  return metadata;
}

async function main() {
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));

  const authority = await exportContract({
    label: "GenesisVerifierAuthority",
    fqn: "contracts/GenesisVerifierAuthority.sol:GenesisVerifierAuthority",
    address: canonicalAddress(record.authority.address),
    constructorTypes: ["bytes32", "address", "address", "address"],
    constructorValues: [
      record.hashes.policy,
      canonicalAddress(record.verifiers.A),
      canonicalAddress(record.verifiers.B),
      canonicalAddress(record.verifiers.C),
    ],
  });

  const escrow = await exportContract({
    label: "GenesisDeliverableEscrow",
    fqn: "contracts/GenesisDeliverableEscrow.sol:GenesisDeliverableEscrow",
    address: canonicalAddress(record.escrow.address),
    constructorTypes: [
      "address",
      "address",
      "bytes32",
      "uint64",
      "uint256",
      "uint32",
      "uint256",
      "uint32",
      "uint256",
      "uint32",
    ],
    constructorValues: [
      canonicalAddress(record.gccToken),
      canonicalAddress(record.authority.address),
      record.hashes.tender,
      BigInt(record.escrow.settlementDeadlineUnix),
      hre.ethers.parseUnits("10", 18),
      10,
      0,
      0,
      0,
      0,
    ],
  });

  console.log(
    JSON.stringify(
      {
        status: "READY",
        outputDirectory: OUT_DIR,
        chainId: 56,
        contracts: [authority, escrow],
        note:
          "Upload the matching Standard JSON Input file in BscScan Verify & Publish, use the recorded compiler long version, and paste the constructor arguments hex without 0x when requested.",
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
