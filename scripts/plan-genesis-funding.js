const {
  Contract,
  JsonRpcProvider,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
} = require("ethers");
const {
  minimumGrossForNet,
  netAfterFee,
} = require("../src/genesisFundingPlan");

const RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
const GCC = "0x092ac429b9c3450c9909433eb0662c3b7c13cf9a";
const ZERO = "0x0000000000000000000000000000000000000000";

const ABI = [
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function reflectionFee() view returns (uint256)",
  "function getBurnFee() view returns (uint256)",
  "function getTaxFee() view returns (uint256)",
  "function getFeeAccount() view returns (address)",
  "function isExcludedFromFee(address) view returns (bool)",
];

function readFundingWallet() {
  const value = process.argv[2] || process.env.GENESIS_FUNDING_WALLET;
  if (!value || !isAddress(value) || value.toLowerCase() === ZERO) {
    throw new Error(
      "Provide the public funding wallet address: npm run mainnet:plan-funding -- 0x..."
    );
  }
  return getAddress(value);
}

async function main() {
  const fundingWallet = readFundingWallet();
  const provider = new JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Wrong network: expected BSC mainnet chain 56, got ${network.chainId}`);
  }

  const token = new Contract(GCC, ABI, provider);
  const [
    owner,
    reflectionFee,
    burnFee,
    taxFee,
    feeAccount,
    fundingWalletExcluded,
    fundingWalletGccRaw,
    fundingWalletBnbWei,
  ] = await Promise.all([
    token.owner(),
    token.reflectionFee(),
    token.getBurnFee(),
    token.getTaxFee(),
    token.getFeeAccount(),
    token.isExcludedFromFee(fundingWallet),
    token.balanceOf(fundingWallet),
    provider.getBalance(fundingWallet),
  ]);

  const totalFeePercent = reflectionFee + burnFee + taxFee;
  const targetEscrowBalanceRaw = parseUnits("100", 18);
  const nominalAwardRaw = parseUnits("10", 18);

  const requiredFundingTransferRaw = fundingWalletExcluded
    ? targetEscrowBalanceRaw
    : minimumGrossForNet(targetEscrowBalanceRaw, totalFeePercent);

  const ordinaryRecipientDirectRaw = netAfterFee(
    nominalAwardRaw,
    totalFeePercent
  );

  const result = {
    chainId: Number(network.chainId),
    gccToken: getAddress(GCC),
    owner: getAddress(owner),
    ownershipRenounced: owner.toLowerCase() === ZERO,
    feeAccount: getAddress(feeAccount),
    fees: {
      reflectionPercent: reflectionFee.toString(),
      burnPercent: burnFee.toString(),
      taxPercent: taxFee.toString(),
      totalPercent: totalFeePercent.toString(),
    },
    fundingWallet,
    fundingWalletExcludedFromFee: fundingWalletExcluded,
    fundingWalletBalances: {
      gcc: formatUnits(fundingWalletGccRaw, 18),
      bnb: formatEther(fundingWalletBnbWei),
      hasEnoughGccForPlannedFunding:
        fundingWalletGccRaw >= requiredFundingTransferRaw,
      note:
        "BNB balance is reported for visibility only. The eventual MetaMask funding transfer also requires enough BNB for gas.",
    },
    rewardSemantics: {
      escrowNominalTransferPerAwardGcc: "10",
      ordinaryNonExcludedRecipientDirectCreditGcc: formatUnits(
        ordinaryRecipientDirectRaw,
        18
      ),
      note:
        "Genesis I keeps the frozen 10 GCC constructor amount as the nominal escrow transfer. GCC token fees apply unless sender or recipient is already fee-exempt.",
    },
    fundingPlan: {
      targetEscrowBalanceGcc: "100",
      requiredWalletTransferGcc: formatUnits(requiredFundingTransferRaw, 18),
      requiredWalletTransferRaw: requiredFundingTransferRaw.toString(),
      expectedDirectEscrowCreditGcc: formatUnits(
        fundingWalletExcluded
          ? requiredFundingTransferRaw
          : netAfterFee(requiredFundingTransferRaw, totalFeePercent),
        18
      ),
      note: fundingWalletExcluded
        ? "Funding wallet is fee-exempt, so a 100 GCC transfer is sufficient."
        : "Funding wallet is not fee-exempt. The gross transfer is increased so the escrow receives at least the frozen 100 GCC nominal reward cap before reflection balance effects.",
    },
    safety:
      "READ_ONLY. Do not transfer GCC until the deployed escrow address and constructor bindings are verified.",
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
