const { Contract, JsonRpcProvider, formatUnits } = require("ethers");

const RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
const GCC = "0x092ac429b9c3450c9909433eb0662c3b7c13cf9a";

const ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function reflectionFee() view returns (uint256)",
  "function getBurnFee() view returns (uint256)",
  "function getTaxFee() view returns (uint256)",
  "function getFeeAccount() view returns (address)",
  "function isExcludedFromFee(address) view returns (bool)"
];

async function optional(contract, fn, ...args) {
  try {
    const value = await contract[fn](...args);
    return typeof value === "bigint" ? value.toString() : value;
  } catch (error) {
    return `UNAVAILABLE:${error.shortMessage || error.message}`;
  }
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) {
    throw new Error(`Wrong network: expected BSC mainnet chain 56, got ${network.chainId}`);
  }

  const code = await provider.getCode(GCC);
  if (code === "0x") throw new Error("GCC address has no contract code on BSC mainnet");

  const token = new Contract(GCC, ABI, provider);
  const [name, symbol, decimals, totalSupply, owner, reflectionFee, burnFee, taxFee, feeAccount] =
    await Promise.all([
      optional(token, "name"),
      optional(token, "symbol"),
      optional(token, "decimals"),
      optional(token, "totalSupply"),
      optional(token, "owner"),
      optional(token, "reflectionFee"),
      optional(token, "getBurnFee"),
      optional(token, "getTaxFee"),
      optional(token, "getFeeAccount")
    ]);

  const result = {
    chainId: Number(network.chainId),
    rpc: RPC_URL,
    gccToken: GCC,
    codePresent: code !== "0x",
    name,
    symbol,
    decimals,
    totalSupplyRaw: totalSupply,
    totalSupplyFormatted:
      /^\d+$/.test(String(totalSupply)) && /^\d+$/.test(String(decimals))
        ? formatUnits(totalSupply, Number(decimals))
        : null,
    owner,
    reflectionFeePercent: reflectionFee,
    burnFeePercent: burnFee,
    taxFeePercent: taxFee,
    feeAccount,
    note: "Read-only preflight. Before funding the escrow, also confirm whether an escrow-to-recipient transfer is fee-free or define the reward as the nominal transfer amount."
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
