function requirePercent(value) {
  const fee = typeof value === "bigint" ? value : BigInt(value);
  if (fee < 0n || fee >= 100n) {
    throw new Error("feePercent must be between 0 and 99");
  }
  return fee;
}

function netAfterFee(grossRaw, feePercent) {
  const gross = typeof grossRaw === "bigint" ? grossRaw : BigInt(grossRaw);
  const fee = requirePercent(feePercent);
  if (gross < 0n) throw new Error("grossRaw must be non-negative");
  return gross - (gross * fee) / 100n;
}

function minimumGrossForNet(targetRaw, feePercent) {
  const target = typeof targetRaw === "bigint" ? targetRaw : BigInt(targetRaw);
  const fee = requirePercent(feePercent);
  if (target < 0n) throw new Error("targetRaw must be non-negative");
  if (target === 0n || fee === 0n) return target;

  let gross = (target * 100n) / (100n - fee);
  while (netAfterFee(gross, fee) < target) gross += 1n;
  while (gross > 0n && netAfterFee(gross - 1n, fee) >= target) gross -= 1n;
  return gross;
}

module.exports = {
  minimumGrossForNet,
  netAfterFee,
};
