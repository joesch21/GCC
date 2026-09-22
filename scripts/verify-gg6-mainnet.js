const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const RECORD_PATH = path.resolve(
  __dirname,
  "../deployments/GG6-GRANT-PAYOUT-bsc-mainnet.json"
);

function requireApiKey() {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error(
      "Set ETHERSCAN_API_KEY locally before verification. Do not paste the key into chat or commit it."
    );
  }
}

async function main() {
  requireApiKey();

  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
  if (record.network?.chainId !== 56) {
    throw new Error("GG-6 deployment record is not BSC mainnet chain 56");
  }

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Connected to unexpected chain ID ${network.chainId}`);
  }

  const expectedGcc = hre.ethers.getAddress(
    "0x092aC429b9c3450c9909433eB0662c3b7c13cF9A"
  );
  const expectedRelayer = hre.ethers.getAddress(
    "0x381c2939c943C52D9260B0c635d2FD7B17FB1C21"
  );

  if (hre.ethers.getAddress(record.gccToken) !== expectedGcc) {
    throw new Error("Deployment record GCC token mismatch");
  }
  if (hre.ethers.getAddress(record.relayer) !== expectedRelayer) {
    throw new Error("Deployment record relayer mismatch");
  }

  const escrow = await hre.ethers.getContractAt(
    "GrantPayoutEscrow",
    record.escrow.address
  );
  const [gcc, humanAuthority, relayer, balance, totalPaid, code] =
    await Promise.all([
      escrow.gcc(),
      escrow.humanAuthority(),
      escrow.relayer(),
      escrow.escrowBalance(),
      escrow.totalPaid(),
      hre.ethers.provider.getCode(record.escrow.address),
    ]);

  if (hre.ethers.getAddress(gcc) !== expectedGcc) {
    throw new Error("On-chain GG-6 GCC binding mismatch");
  }
  if (
    hre.ethers.getAddress(humanAuthority) !==
    hre.ethers.getAddress(record.humanAuthority)
  ) {
    throw new Error("On-chain GG-6 human authority mismatch");
  }
  if (hre.ethers.getAddress(relayer) !== expectedRelayer) {
    throw new Error("On-chain GG-6 relayer mismatch");
  }
  if (!code || code === "0x") {
    throw new Error("GG-6 escrow has no runtime bytecode");
  }

  let verification = "VERIFIED";
  try {
    await hre.run("verify:verify", {
      address: record.escrow.address,
      constructorArguments: [
        expectedGcc,
        hre.ethers.getAddress(record.humanAuthority),
        expectedRelayer,
      ],
      contract: "contracts/GrantPayoutEscrow.sol:GrantPayoutEscrow",
    });
  } catch (error) {
    const message = String(error && (error.message || error));
    if (/already verified/i.test(message)) {
      verification = "ALREADY_VERIFIED";
    } else {
      throw error;
    }
  }

  console.log(JSON.stringify({
    status:"PASS",
    chainId:56,
    escrow:record.escrow.address,
    gcc,
    humanAuthority,
    relayer,
    escrowBalanceRaw:balance.toString(),
    totalPaidRaw:totalPaid.toString(),
    bscscanSourceVerification:verification,
    bscscan:`https://bscscan.com/address/${record.escrow.address}#code`
  },null,2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
