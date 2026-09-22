const fs = require("fs");
const path = require("path");
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
  planFundingTransfer,
  planNominalPayout,
} = require("../src/gg6FundingPlan");

const RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
const GCC = getAddress("0x092ac429b9c3450c9909433eb0662c3b7c13cf9a");
const GG6_ESCROW = getAddress("0xca458394e8C3137cE4984bDac6E615d08E2482F6");
const GG6_HUMAN_AUTHORITY = getAddress("0x0b36B0495c5e7899648D731d7b88d6Ffd3915184");
const GG6_RELAYER = getAddress("0x381c2939c943C52D9260B0c635d2FD7B17FB1C21");
const ZERO = "0x0000000000000000000000000000000000000000";

const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function reflectionFee() view returns (uint256)",
  "function getBurnFee() view returns (uint256)",
  "function getTaxFee() view returns (uint256)",
  "function getFeeAccount() view returns (address)",
  "function isExcludedFromFee(address) view returns (bool)",
];

const ESCROW_ABI = [
  "function gcc() view returns (address)",
  "function humanAuthority() view returns (address)",
  "function relayer() view returns (address)",
  "function escrowBalance() view returns (uint256)",
  "function fundingShortfall(uint256 pendingAmount) view returns (uint256)",
];

function requireAddress(value, label) {
  const raw = String(value || "").trim();
  if (!isAddress(raw) || raw.toLowerCase() === ZERO) {
    throw new Error(`${label} must be a non-zero BSC address`);
  }
  return getAddress(raw.toLowerCase());
}

function requirePositiveDecimal(value, label) {
  const raw = String(value || "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(raw)) {
    throw new Error(`${label} must be a plain decimal string`);
  }
  if (/^0(?:\.0+)?$/.test(raw)) {
    throw new Error(`${label} must be greater than zero`);
  }
  return raw;
}

function readInputs() {
  const fundingWallet = requireAddress(
    process.argv[2] || process.env.GG6_FUNDING_WALLET,
    "GG6 funding wallet"
  );
  const recipient = requireAddress(
    process.argv[3] || process.env.GG6_RECIPIENT,
    "GG6 recipient"
  );
  const pendingAmountGcc = requirePositiveDecimal(
    process.argv[4] || process.env.GG6_PENDING_GCC || "1",
    "GG6 pending GCC"
  );
  return { fundingWallet, recipient, pendingAmountGcc };
}

async function main() {
  const { fundingWallet, recipient, pendingAmountGcc } = readInputs();

  const provider = new JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Wrong network: expected BSC mainnet chain 56, got ${network.chainId}`);
  }

  const [gccCode, escrowCode] = await Promise.all([
    provider.getCode(GCC),
    provider.getCode(GG6_ESCROW),
  ]);
  if (gccCode === "0x") throw new Error("Canonical GCC address has no code");
  if (escrowCode === "0x") throw new Error("Verified GG-6 escrow address has no code");

  const token = new Contract(GCC, TOKEN_ABI, provider);
  const escrow = new Contract(GG6_ESCROW, ESCROW_ABI, provider);

  const [
    symbol,
    decimalsRaw,
    owner,
    reflectionFee,
    burnFee,
    taxFee,
    feeAccount,
    fundingWalletExcluded,
    escrowExcluded,
    recipientExcluded,
    fundingWalletGccRaw,
    fundingWalletBnbWei,
    escrowGccRaw,
    configuredGcc,
    configuredAuthority,
    configuredRelayer,
  ] = await Promise.all([
    token.symbol(),
    token.decimals(),
    token.owner(),
    token.reflectionFee(),
    token.getBurnFee(),
    token.getTaxFee(),
    token.getFeeAccount(),
    token.isExcludedFromFee(fundingWallet),
    token.isExcludedFromFee(GG6_ESCROW),
    token.isExcludedFromFee(recipient),
    token.balanceOf(fundingWallet),
    provider.getBalance(fundingWallet),
    token.balanceOf(GG6_ESCROW),
    escrow.gcc(),
    escrow.humanAuthority(),
    escrow.relayer(),
  ]);

  if (symbol !== "GCC") throw new Error(`Token symbol mismatch: ${symbol}`);
  const decimals = Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Invalid GCC decimals");
  }

  if (getAddress(configuredGcc) !== GCC) {
    throw new Error("GG-6 escrow GCC binding mismatch");
  }
  if (getAddress(configuredAuthority) !== GG6_HUMAN_AUTHORITY) {
    throw new Error("GG-6 escrow human authority binding mismatch");
  }
  if (getAddress(configuredRelayer) !== GG6_RELAYER) {
    throw new Error("GG-6 escrow relayer binding mismatch");
  }

  const totalFeePercent = reflectionFee + burnFee + taxFee;
  const pendingRaw = parseUnits(pendingAmountGcc, decimals);
  const onchainShortfallRaw = await escrow.fundingShortfall(pendingRaw);

  const fundingPlan = planFundingTransfer({
    requiredNetRaw: onchainShortfallRaw,
    senderExcludedFromFee: fundingWalletExcluded,
    recipientExcludedFromFee: escrowExcluded,
    totalFeePercent,
  });

  const payoutPlan = planNominalPayout({
    nominalAmountRaw: pendingRaw,
    senderExcludedFromFee: escrowExcluded,
    recipientExcludedFromFee: recipientExcluded,
    totalFeePercent,
  });

  const result = {
    schema: "gcc.gg6_fee_aware_funding_plan.v1",
    mode: "READ_ONLY",
    generatedAt: new Date().toISOString(),
    network: {
      chainId: Number(network.chainId),
      rpc: RPC_URL,
    },
    bindings: {
      gccToken: GCC,
      gg6Escrow: GG6_ESCROW,
      humanAuthority: GG6_HUMAN_AUTHORITY,
      relayer: GG6_RELAYER,
      verified: true,
    },
    token: {
      symbol,
      decimals,
      owner: getAddress(owner),
      ownershipRenounced: owner.toLowerCase() === ZERO,
      feeAccount: getAddress(feeAccount),
      feesPercent: {
        reflection: reflectionFee.toString(),
        burn: burnFee.toString(),
        tax: taxFee.toString(),
        total: totalFeePercent.toString(),
      },
      feeRule:
        "Fee is bypassed if either transfer sender or transfer recipient is excluded from fee.",
      mutableFeeWarning:
        owner.toLowerCase() === ZERO
          ? null
          : "Token ownership is not renounced; fee settings and fee exclusions can change. Re-run this planner immediately before funding and again before payout.",
    },
    canary: {
      recipient,
      nominalPayoutGcc: formatUnits(pendingRaw, decimals),
      recipientExcludedFromFee: recipientExcluded,
      payoutTransferFeeApplies: payoutPlan.takesFee,
      expectedRecipientDirectCreditGcc: formatUnits(
        payoutPlan.expectedDirectCreditRaw,
        decimals
      ),
      amountSemantics:
        payoutPlan.takesFee
          ? "The signed GG-6 amount is nominal. Because neither escrow nor recipient is fee-exempt, the recipient direct balance credit is expected to be lower than the nominal amount."
          : "The signed GG-6 amount is nominal and this transfer is currently fee-free because the sender or recipient is fee-exempt.",
    },
    escrow: {
      address: GG6_ESCROW,
      excludedFromFee: escrowExcluded,
      currentBalanceGcc: formatUnits(escrowGccRaw, decimals),
      pendingNominalGcc: formatUnits(pendingRaw, decimals),
      onchainShortfallGcc: formatUnits(onchainShortfallRaw, decimals),
    },
    fundingWallet: {
      address: fundingWallet,
      excludedFromFee: fundingWalletExcluded,
      gccBalance: formatUnits(fundingWalletGccRaw, decimals),
      bnbBalance: formatEther(fundingWalletBnbWei),
      fundingTransferFeeApplies: fundingPlan.takesFee,
      requiredWalletTransferGcc: formatUnits(fundingPlan.grossRaw, decimals),
      requiredWalletTransferRaw: fundingPlan.grossRaw.toString(),
      expectedDirectEscrowCreditGcc: formatUnits(
        fundingPlan.expectedDirectCreditRaw,
        decimals
      ),
      hasEnoughGcc:
        fundingWalletGccRaw >= fundingPlan.grossRaw,
    },
    nextAction:
      onchainShortfallRaw === 0n
        ? "NO_GCC_TOP_UP_REQUIRED"
        : "HUMAN_FUND_ESCROW_WITH_EXACT_PLANNED_GROSS_THEN_RERUN_TOWER_READINESS",
    safety: {
      readOnly: true,
      sendsTransactions: false,
      signsTransactions: false,
      changesFeeExemptions: false,
      changesTokenFees: false,
      fundsEscrow: false,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "ERROR",
    error: error.message || String(error),
  }, null, 2));
  process.exitCode = 1;
});
