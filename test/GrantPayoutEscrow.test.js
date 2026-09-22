const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GrantPayoutEscrow", function () {
  const UNIT = 10n ** 18n;
  const EXISTING_RELAYER = "0x381c2939c943C52D9260B0c635d2FD7B17FB1C21";

  let deployer;
  let humanAuthority;
  let funder;
  let recipient;
  let otherRecipient;
  let wrongRelayer;
  let token;
  let escrow;
  let deadline;

  beforeEach(async function () {
    [deployer, humanAuthority, funder, recipient, otherRecipient, wrongRelayer] =
      await ethers.getSigners();

    const MockGCC = await ethers.getContractFactory("MockGCC");
    token = await MockGCC.deploy();
    await token.waitForDeployment();

    const Escrow = await ethers.getContractFactory("GrantPayoutEscrow");
    escrow = await Escrow.deploy(
      await token.getAddress(),
      humanAuthority.address,
      EXISTING_RELAYER
    );
    await escrow.waitForDeployment();

    const latest = await ethers.provider.getBlock("latest");
    deadline = BigInt(latest.timestamp + 3600);

    await token.mint(funder.address, 1000n * UNIT);
    await token.connect(funder).transfer(await escrow.getAddress(), 100n * UNIT);

    await ethers.provider.send("hardhat_setBalance", [
      EXISTING_RELAYER,
      "0x3635C9ADC5DEA00000"
    ]);
  });

  function buildPayout(overrides = {}) {
    return {
      transferMaterialHash: ethers.keccak256(
        ethers.toUtf8Bytes("gg5-transfer-material-1")
      ),
      recipient: recipient.address,
      amount: 10n * UNIT,
      validUntil: deadline,
      ...overrides,
    };
  }

  async function signPayout(payout, signer = humanAuthority) {
    const domain = {
      name: "GCC Grant Payout Escrow",
      version: "1",
      chainId: 56,
      verifyingContract: await escrow.getAddress(),
    };
    const types = {
      Payout: [
        { name: "transferMaterialHash", type: "bytes32" },
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "validUntil", type: "uint64" },
      ],
    };
    return signer.signTypedData(domain, types, payout);
  }

  async function existingRelayerSigner() {
    await ethers.provider.send("hardhat_impersonateAccount", [EXISTING_RELAYER]);
    return ethers.getSigner(EXISTING_RELAYER);
  }

  it("reuses the existing Genesis relayer identity without giving it payout choice", async function () {
    expect(await escrow.relayer()).to.equal(EXISTING_RELAYER);
    const payout = buildPayout();
    const signature = await signPayout(payout);
    const relayer = await existingRelayerSigner();

    await expect(escrow.connect(relayer).settle(payout, signature))
      .to.emit(escrow, "GrantPaid")
      .withArgs(
        await escrow.derivePayoutId(payout),
        payout.transferMaterialHash,
        recipient.address,
        10n * UNIT,
        EXISTING_RELAYER
      );

    expect(await token.balanceOf(recipient.address)).to.equal(10n * UNIT);
  });

  it("rejects settlement from any caller except the configured relayer", async function () {
    const payout = buildPayout();
    await expect(
      escrow.connect(wrongRelayer).settle(payout, await signPayout(payout))
    ).to.be.revertedWithCustomError(escrow, "RelayerOnly");
  });

  it("rejects a signature from anyone except the human authority", async function () {
    const payout = buildPayout();
    const relayer = await existingRelayerSigner();

    await expect(
      escrow.connect(relayer).settle(payout, await signPayout(payout, deployer))
    ).to.be.revertedWithCustomError(escrow, "InvalidHumanAuthorization");
  });

  it("binds the authorization to exact recipient, amount and GG-5 material hash", async function () {
    const payout = buildPayout();
    const signature = await signPayout(payout);
    const relayer = await existingRelayerSigner();

    await expect(
      escrow.connect(relayer).settle(
        { ...payout, recipient: otherRecipient.address },
        signature
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidHumanAuthorization");

    await expect(
      escrow.connect(relayer).settle(
        { ...payout, amount: 11n * UNIT },
        signature
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidHumanAuthorization");

    await expect(
      escrow.connect(relayer).settle(
        {
          ...payout,
          transferMaterialHash: ethers.keccak256(
            ethers.toUtf8Bytes("different-material")
          )
        },
        signature
      )
    ).to.be.revertedWithCustomError(escrow, "InvalidHumanAuthorization");
  });

  it("cannot replay an already-paid payout", async function () {
    const payout = buildPayout();
    const signature = await signPayout(payout);
    const relayer = await existingRelayerSigner();

    await escrow.connect(relayer).settle(payout, signature);

    await expect(
      escrow.connect(relayer).settle(payout, signature)
    ).to.be.revertedWithCustomError(escrow, "PayoutAlreadyPaid");
  });

  it("rejects expired payout authority", async function () {
    const latest = await ethers.provider.getBlock("latest");
    const payout = buildPayout({ validUntil: BigInt(latest.timestamp - 1) });
    const relayer = await existingRelayerSigner();

    await expect(
      escrow.connect(relayer).settle(payout, await signPayout(payout))
    ).to.be.revertedWithCustomError(escrow, "PayoutExpired");
  });

  it("reports the exact GCC reserve shortfall for pending payouts", async function () {
    expect(await escrow.escrowBalance()).to.equal(100n * UNIT);
    expect(await escrow.fundingShortfall(75n * UNIT)).to.equal(0n);
    expect(await escrow.fundingShortfall(125n * UNIT)).to.equal(25n * UNIT);
  });

  it("rejects native BNB so GCC reserve and relayer gas remain separate", async function () {
    await expect(
      funder.sendTransaction({
        to: await escrow.getAddress(),
        value: 1n,
      })
    ).to.be.revertedWithCustomError(escrow, "NativeAssetNotAccepted");
  });
});
