const {
  minimumGrossForNet,
  netAfterFee,
} = require("./genesisFundingPlan");

function asBigInt(value, label) {
  try {
    return typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new Error(`${label} must be an integer`);
  }
}

function validateFeePercent(value) {
  const fee = asBigInt(value, "totalFeePercent");
  if (fee < 0n || fee >= 100n) {
    throw new Error("totalFeePercent must be between 0 and 99");
  }
  return fee;
}

function transferTakesFee({
  senderExcludedFromFee,
  recipientExcludedFromFee,
  totalFeePercent,
}) {
  if (typeof senderExcludedFromFee !== "boolean") {
    throw new Error("senderExcludedFromFee must be boolean");
  }
  if (typeof recipientExcludedFromFee !== "boolean") {
    throw new Error("recipientExcludedFromFee must be boolean");
  }
  const fee = validateFeePercent(totalFeePercent);
  return fee > 0n && !senderExcludedFromFee && !recipientExcludedFromFee;
}

function planFundingTransfer({
  requiredNetRaw,
  senderExcludedFromFee,
  recipientExcludedFromFee,
  totalFeePercent,
}) {
  const target = asBigInt(requiredNetRaw, "requiredNetRaw");
  if (target < 0n) throw new Error("requiredNetRaw must be non-negative");

  const fee = validateFeePercent(totalFeePercent);
  const takesFee = transferTakesFee({
    senderExcludedFromFee,
    recipientExcludedFromFee,
    totalFeePercent: fee,
  });

  const grossRaw = takesFee
    ? minimumGrossForNet(target, fee)
    : target;

  const expectedDirectCreditRaw = takesFee
    ? netAfterFee(grossRaw, fee)
    : grossRaw;

  return {
    takesFee,
    grossRaw,
    expectedDirectCreditRaw,
  };
}

function planNominalPayout({
  nominalAmountRaw,
  senderExcludedFromFee,
  recipientExcludedFromFee,
  totalFeePercent,
}) {
  const nominal = asBigInt(nominalAmountRaw, "nominalAmountRaw");
  if (nominal < 0n) throw new Error("nominalAmountRaw must be non-negative");

  const fee = validateFeePercent(totalFeePercent);
  const takesFee = transferTakesFee({
    senderExcludedFromFee,
    recipientExcludedFromFee,
    totalFeePercent: fee,
  });

  return {
    takesFee,
    nominalAmountRaw: nominal,
    expectedDirectCreditRaw: takesFee
      ? netAfterFee(nominal, fee)
      : nominal,
  };
}

module.exports = {
  transferTakesFee,
  planFundingTransfer,
  planNominalPayout,
};
