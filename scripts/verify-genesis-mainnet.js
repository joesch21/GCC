const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const RECORD_PATH = path.resolve(
  __dirname,
  "../deployments/GCC-GENESIS-001-bsc-mainnet.json"
);

function requireApiKey() {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error(
      "Set ETHERSCAN_API_KEY locally before verification. Do not paste the key into chat or commit it."
    );
  }
}

async function verifyOne(label, options) {
  process.stdout.write(`Verifying ${label} at ${options.address}...\n`);
  try {
    await hre.run("verify:verify", options);
    process.stdout.write(`${label}: VERIFIED\n`);
    return "VERIFIED";
  } catch (error) {
    const message = String(error && (error.message || error));
    if (/already verified/i.test(message)) {
      process.stdout.write(`${label}: ALREADY_VERIFIED\n`);
      return "ALREADY_VERIFIED";
    }
    throw error;
  }
}

async function main() {
  requireApiKey();

  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
  if (record.network.chainId !== 56) {
    throw new Error("Deployment record is not BSC mainnet chain 56");
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Connected to unexpected chain ID ${network.chainId}`);
  }

  const authorityArgs = [
    record.hashes.policy,
    record.verifiers.A,
    record.verifiers.B,
    record.verifiers.C,
  ];

  const escrowArgs = [
    record.gccToken,
    record.authority.address,
    record.hashes.tender,
    BigInt(record.escrow.settlementDeadlineUnix),
    hre.ethers.parseUnits("10", 18),
    10,
    0n,
    0,
    0n,
    0,
  ];

  const authorityStatus = await verifyOne("GenesisVerifierAuthority", {
    address: record.authority.address,
    constructorArguments: authorityArgs,
    contract:
      "contracts/GenesisVerifierAuthority.sol:GenesisVerifierAuthority",
  });

  const escrowStatus = await verifyOne("GenesisDeliverableEscrow", {
    address: record.escrow.address,
    constructorArguments: escrowArgs,
    contract:
      "contracts/GenesisDeliverableEscrow.sol:GenesisDeliverableEscrow",
  });

  console.log(
    JSON.stringify(
      {
        chainId: 56,
        authority: {
          address: record.authority.address,
          verification: authorityStatus,
          bscscan: `https://bscscan.com/address/${record.authority.address}#code`,
        },
        escrow: {
          address: record.escrow.address,
          verification: escrowStatus,
          bscscan: `https://bscscan.com/address/${record.escrow.address}#code`,
        },
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
