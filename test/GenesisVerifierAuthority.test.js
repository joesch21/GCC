const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GenesisVerifierAuthority", function () {
  let verifierA;
  let verifierB;
  let verifierC;
  let outsider;
  let recipient;
  let authority;
  let policyHash;

  beforeEach(async function () {
    [, verifierA, verifierB, verifierC, outsider, recipient] =
      await ethers.getSigners();

    policyHash = ethers.keccak256(
      ethers.toUtf8Bytes("GCC-GENESIS-001 verifier policy v0.1 test fixture")
    );

    const Factory = await ethers.getContractFactory("GenesisVerifierAuthority");
    authority = await Factory.deploy(
      policyHash,
      verifierA.address,
      verifierB.address,
      verifierC.address
    );
    await authority.waitForDeployment();
  });

  async function signAttestation(signer, awardDigest, policy = policyHash) {
    const domain = {
      name: "GCC Genesis Verifier Authority",
      version: "1",
      chainId: 56,
      verifyingContract: await authority.getAddress(),
    };

    const types = {
      Attestation: [
        { name: "awardDigest", type: "bytes32" },
        { name: "policyHash", type: "bytes32" },
      ],
    };

    return signer.signTypedData(domain, types, {
      awardDigest,
      policyHash: policy,
    });
  }

  function sortedBundle(entries) {
    entries.sort((a, b) =>
      BigInt(a.signer.toLowerCase()) < BigInt(b.signer.toLowerCase()) ? -1 : 1
    );

    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "bytes[]"],
      [entries.map((x) => x.signer), entries.map((x) => x.signature)]
    );
  }

  it("accepts two valid independent verifier attestations", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("award-1"));
    const bundle = sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(verifierA, awardDigest),
      },
      {
        signer: verifierB.address,
        signature: await signAttestation(verifierB, awardDigest),
      },
    ]);

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0x1626ba7e"
    );
  });

  it("rejects only one verifier", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("award-2"));
    const bundle = sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(verifierA, awardDigest),
      },
    ]);

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0xffffffff"
    );
  });

  it("rejects an outsider even when paired with a valid verifier", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("award-3"));
    const bundle = sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(verifierA, awardDigest),
      },
      {
        signer: outsider.address,
        signature: await signAttestation(outsider, awardDigest),
      },
    ]);

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0xffffffff"
    );
  });

  it("rejects duplicate verifier entries", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("award-4"));
    const signature = await signAttestation(verifierA, awardDigest);
    const bundle = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "bytes[]"],
      [[verifierA.address, verifierA.address], [signature, signature]]
    );

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0xffffffff"
    );
  });

  it("rejects attestations made against a different policy hash", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("award-5"));
    const wrongPolicy = ethers.keccak256(ethers.toUtf8Bytes("wrong-policy"));

    const bundle = sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(verifierA, awardDigest, wrongPolicy),
      },
      {
        signer: verifierB.address,
        signature: await signAttestation(verifierB, awardDigest, wrongPolicy),
      },
    ]);

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0xffffffff"
    );
  });

  it("rejects a signature made for a different award digest", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("award-6"));
    const otherDigest = ethers.keccak256(ethers.toUtf8Bytes("other-award"));

    const bundle = sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(verifierA, otherDigest),
      },
      {
        signer: verifierB.address,
        signature: await signAttestation(verifierB, otherDigest),
      },
    ]);

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0xffffffff"
    );
  });

  it("integrates with GenesisDeliverableEscrow through EIP-1271", async function () {
    const MockGCC = await ethers.getContractFactory("MockGCC");
    const token = await MockGCC.deploy();
    await token.waitForDeployment();

    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latest.timestamp + 7 * 24 * 60 * 60);
    const tenderHash = ethers.keccak256(
      ethers.toUtf8Bytes("GCC-GENESIS-001 canonical tender test")
    );

    const Escrow = await ethers.getContractFactory("GenesisDeliverableEscrow");
    const escrow = await Escrow.deploy(
      await token.getAddress(),
      await authority.getAddress(),
      tenderHash,
      deadline,
      10n * 10n ** 18n,
      2,
      20n * 10n ** 18n,
      1,
      30n * 10n ** 18n,
      1
    );
    await escrow.waitForDeployment();

    await token.mint(await escrow.getAddress(), await escrow.rewardCap());

    const qualifiedClass = await escrow.QUALIFIED_PROPOSAL();
    const award = {
      tenderHash,
      awardClass: qualifiedClass,
      deliverableHash: ethers.keccak256(ethers.toUtf8Bytes("deliverable")),
      assessmentHash: ethers.keccak256(ethers.toUtf8Bytes("assessment")),
      recipient: recipient.address,
      validUntil: deadline - 60n,
    };

    const awardDigest = await escrow.awardDigest(award);

    const bundle = sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(verifierA, awardDigest),
      },
      {
        signer: verifierC.address,
        signature: await signAttestation(verifierC, awardDigest),
      },
    ]);

    await escrow.settle(award, bundle);

    expect(await token.balanceOf(recipient.address)).to.equal(10n * 10n ** 18n);
  });
});
