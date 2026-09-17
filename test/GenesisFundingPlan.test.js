const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  minimumGrossForNet,
  netAfterFee,
} = require("../src/genesisFundingPlan");

describe("Genesis fee-aware funding plan", function () {
  it("keeps 100 GCC unchanged for a fee-exempt sender", function () {
    const target = ethers.parseUnits("100", 18);
    expect(minimumGrossForNet(target, 0n)).to.equal(target);
  });

  it("computes the minimum gross funding transfer for the current 2 percent GCC fee", function () {
    const target = ethers.parseUnits("100", 18);
    const gross = minimumGrossForNet(target, 2n);

    expect(gross).to.equal(102040816326530612244n);
    expect(netAfterFee(gross, 2n)).to.equal(target);
    expect(netAfterFee(gross - 1n, 2n)).to.be.lessThan(target);
  });

  it("shows a nominal 10 GCC transfer credits 9.8 GCC directly at a 2 percent fee", function () {
    const nominal = ethers.parseUnits("10", 18);
    expect(netAfterFee(nominal, 2n)).to.equal(
      ethers.parseUnits("9.8", 18)
    );
  });
});
