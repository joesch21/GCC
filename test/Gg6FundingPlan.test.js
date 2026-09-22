const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  transferTakesFee,
  planFundingTransfer,
  planNominalPayout,
} = require("../src/gg6FundingPlan");

describe("GG-6 fee-aware funding plan", function () {
  it("bypasses fees when the sender is fee-exempt", function () {
    expect(transferTakesFee({
      senderExcludedFromFee: true,
      recipientExcludedFromFee: false,
      totalFeePercent: 2n,
    })).to.equal(false);
  });

  it("bypasses fees when the recipient is fee-exempt", function () {
    expect(transferTakesFee({
      senderExcludedFromFee: false,
      recipientExcludedFromFee: true,
      totalFeePercent: 2n,
    })).to.equal(false);
  });

  it("grosses up escrow funding when neither side is fee-exempt", function () {
    const target = ethers.parseUnits("1", 18);
    const plan = planFundingTransfer({
      requiredNetRaw: target,
      senderExcludedFromFee: false,
      recipientExcludedFromFee: false,
      totalFeePercent: 2n,
    });

    expect(plan.takesFee).to.equal(true);
    expect(plan.grossRaw).to.equal(1020408163265306122n);
    expect(plan.expectedDirectCreditRaw).to.equal(target);
  });

  it("keeps exact funding amount when either side is fee-exempt", function () {
    const target = ethers.parseUnits("1", 18);
    const plan = planFundingTransfer({
      requiredNetRaw: target,
      senderExcludedFromFee: false,
      recipientExcludedFromFee: true,
      totalFeePercent: 2n,
    });

    expect(plan.takesFee).to.equal(false);
    expect(plan.grossRaw).to.equal(target);
    expect(plan.expectedDirectCreditRaw).to.equal(target);
  });

  it("models recipient direct credit from a nominal payout", function () {
    const nominal = ethers.parseUnits("1", 18);
    const plan = planNominalPayout({
      nominalAmountRaw: nominal,
      senderExcludedFromFee: false,
      recipientExcludedFromFee: false,
      totalFeePercent: 2n,
    });

    expect(plan.takesFee).to.equal(true);
    expect(plan.expectedDirectCreditRaw).to.equal(
      ethers.parseUnits("0.98", 18)
    );
  });
});
