const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GenesisDeliverableEscrow", function () {
  const UNIT = 10n ** 18n;

  const qualifiedReward = 10n * UNIT;
  const finalistReward = 25n * UNIT;
  const selectedReward = 50n * UNIT;

  const maxQualified = 3;
  const maxFinalists = 2;
  const maxSelected = 1;

  let deployer;
  let verifier;
  let funder;
  let recipient;
  let otherRecipient;
  let relayer;
  let token;
  let escrow;
  let tenderHash;
  let deadline;

  const QUALIFIED = ethers.keccak256(ethers.toUtf8Bytes("QUALIFIED_PROPOSAL"));
  const FINALIST = ethers.keccak256(ethers.toUtf8Bytes("FINALIST"));
  const SELECTED = ethers.keccak256(ethers.toUtf8Bytes("SELECTED_COMPONENT"));

  beforeEach(async function () {
    [deployer, verifier, funder, recipient, otherRecipient, relayer] =
      await ethers.getSigners();

    const MockGCC = await ethers.getContractFactory("MockGCC");
    token = await MockGCC.deploy();
    await token.waitForDeployment();

    const latest = await ethers.provider.getBlock("latest");
    deadline = BigInt(latest.timestamp + 7 * 24 * 60 * 60);
    tenderHash = ethers.keccak256(
      ethers.toUtf8Bytes("GCC-GENESIS-001 canonical tender bytes")
    );

    const Escrow = await ethers.getContractFactory("GenesisDeliverableEscrow");
    escrow = await Escrow.deploy(
      await token.getAddress(),
      verifier.address,
      tenderHash,
      deadline,
      qualifiedReward,
      maxQualified,
      finalistReward,
      maxFinalists,
      selectedReward,
      maxSelected
    );
    await escrow.waitForDeployment();

    const cap =
      qualifiedReward * BigInt(maxQualified) +
      finalistReward * BigInt(maxFinalists) +
      selectedReward * BigInt(maxSelected);

    await token.mint(funder.address, cap);
    await token.connect(funder).transfer(await escrow.getAddress(), cap);
  });

  function buildAward(overrides = {}) {
    return {
      tenderHash,
      awardClass: QUALIFIED,
      deliverableHash: ethers.keccak256(ethers.toUtf8Bytes("deliverable-1")),
      assessmentHash: ethers.keccak256(ethers.toUtf8Bytes("assessment-1")),
      recipient: recipient.address,
      validUntil: deadline - 60n,
      ...overrides,
    };
  }

  async function signAward(award, signer = verifier) {
    const domain = {
      name: "GCC Genesis Deliverable Escrow",
      version: "1",
      chainId: 56,
      verifyingContract: await escrow.getAddress(),
    };

    const types = {
      Award: [
        { name: "tenderHash", type: "bytes32" },
        { name: "awardClass", type: "bytes32" },
        { name: "deliverableHash", type: "bytes32" },
        { name: "assessmentHash", type: "bytes32" },
        { name: "recipient", type: "address" },
        { name: "validUntil", type: "uint64" },
      ],
    };

    return signer.signTypedData(domain, types, award);
  }

  it("has no owner-controlled payout path and pays the fixed class amount", async function () {
    const award = buildAward();
    const signature = await signAward(award);

    expect(await token.balanceOf(recipient.address)).to.equal(0n);

    await expect(escrow.connect(relayer).settle(award, signature))
      .to.emit(escrow, "DeliverablePaid")
      .withArgs(
        await escrow.deriveAwardId(award),
        QUALIFIED,
        award.deliverableHash,
        award.assessmentHash,
        recipient.address,
        qualifiedReward,
        relayer.address
      );

    expect(await token.balanceOf(recipient.address)).to.equal(qualifiedReward);
    expect(await escrow.totalPaid()).to.equal(qualifiedReward);
  });

  it("rejects an authorization from anyone except the configured verifier", async function () {
    const award = buildAward();
    const badSignature = await signAward(award, deployer);

    await expect(
      escrow.connect(relayer).settle(award, badSignature)
    ).to.be.revertedWithCustomError(escrow, "InvalidVerifierAuthorization");
  });

  it("cannot replay an already-paid award", async function () {
    const award = buildAward();
    const signature = await signAward(award);

    await escrow.connect(relayer).settle(award, signature);

    await expect(
      escrow.connect(relayer).settle(award, signature)
    ).to.be.revertedWithCustomError(escrow, "AwardAlreadyPaid");
  });

  it("cannot pay the same deliverable twice in the same reward class", async function () {
    const first = buildAward();
    await escrow.connect(relayer).settle(first, await signAward(first));

    const second = buildAward({
      assessmentHash: ethers.keccak256(ethers.toUtf8Bytes("assessment-2")),
      recipient: otherRecipient.address,
    });

    await expect(
      escrow.connect(relayer).settle(second, await signAward(second))
    ).to.be.revertedWithCustomError(escrow, "DeliverableClassAlreadyPaid");
  });

  it("permits different reward classes for the same underlying proposal", async function () {
    const deliverableHash = ethers.keccak256(ethers.toUtf8Bytes("proposal-A"));

    const qualified = buildAward({ deliverableHash });
    await escrow.connect(relayer).settle(qualified, await signAward(qualified));

    const finalist = buildAward({
      awardClass: FINALIST,
      deliverableHash,
      assessmentHash: ethers.keccak256(ethers.toUtf8Bytes("finalist-assessment")),
    });
    await escrow.connect(relayer).settle(finalist, await signAward(finalist));

    expect(await token.balanceOf(recipient.address)).to.equal(
      qualifiedReward + finalistReward
    );
  });

  it("enforces each reward-class count cap", async function () {
    for (let i = 0; i < maxSelected; i += 1) {
      const award = buildAward({
        awardClass: SELECTED,
        deliverableHash: ethers.keccak256(ethers.toUtf8Bytes(`selected-${i}`)),
        assessmentHash: ethers.keccak256(ethers.toUtf8Bytes(`assessment-${i}`)),
      });
      await escrow.connect(relayer).settle(award, await signAward(award));
    }

    const extra = buildAward({
      awardClass: SELECTED,
      deliverableHash: ethers.keccak256(ethers.toUtf8Bytes("selected-extra")),
      assessmentHash: ethers.keccak256(ethers.toUtf8Bytes("assessment-extra")),
    });

    await expect(
      escrow.connect(relayer).settle(extra, await signAward(extra))
    ).to.be.revertedWithCustomError(escrow, "AwardClassExhausted");
  });

  it("binds every payment to the configured tender", async function () {
    const award = buildAward({
      tenderHash: ethers.keccak256(ethers.toUtf8Bytes("different-tender")),
    });

    await expect(
      escrow.connect(relayer).settle(award, await signAward(award))
    ).to.be.revertedWithCustomError(escrow, "WrongTender");
  });

  it("rejects expired authorizations", async function () {
    const latest = await ethers.provider.getBlock("latest");
    const award = buildAward({ validUntil: BigInt(latest.timestamp - 1) });

    await expect(
      escrow.connect(relayer).settle(award, await signAward(award))
    ).to.be.revertedWithCustomError(escrow, "AwardExpired");
  });

  it("rejects native BNB", async function () {
    await expect(
      funder.sendTransaction({
        to: await escrow.getAddress(),
        value: 1n,
      })
    ).to.be.revertedWithCustomError(escrow, "NativeAssetNotAccepted");
  });

  it("reports the exact remaining liability", async function () {
    const initialCap = await escrow.rewardCap();
    expect(await escrow.escrowBalance()).to.equal(initialCap);
    expect(await escrow.fundingShortfall()).to.equal(0n);

    const award = buildAward();
    await escrow.connect(relayer).settle(award, await signAward(award));

    expect(await escrow.remainingLiability()).to.equal(
      initialCap - qualifiedReward
    );
  });
});
