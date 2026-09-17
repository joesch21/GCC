const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GenesisVerifierAuthority with test-only ERC-1271 verifier", function () {
  let verifierA;
  let nestedSigner;
  let verifierC;
  let recipient;
  let policyHash;

  beforeEach(async function () {
    [, verifierA, nestedSigner, verifierC, recipient] =
      await ethers.getSigners();

    policyHash = ethers.keccak256(
      ethers.toUtf8Bytes("GCC-GENESIS-001 ERC-1271 test policy")
    );
  });

  async function deployMixedAuthority() {
    const NestedVerifier = await ethers.getContractFactory(
      "TestOnlyERC1271Verifier"
    );
    const nestedVerifier = await NestedVerifier.deploy(nestedSigner.address);
    await nestedVerifier.waitForDeployment();

    const Authority = await ethers.getContractFactory(
      "GenesisVerifierAuthority"
    );
    const authority = await Authority.deploy(
      policyHash,
      verifierA.address,
      await nestedVerifier.getAddress(),
      verifierC.address
    );
    await authority.waitForDeployment();

    return { authority, nestedVerifier };
  }

  async function signAttestation(
    authority,
    signer,
    awardDigest,
    policy = policyHash
  ) {
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
    entries.sort((a, b) => {
      const left = BigInt(a.signer);
      const right = BigInt(b.signer);
      return left < right ? -1 : left > right ? 1 : 0;
    });

    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "bytes[]"],
      [entries.map((entry) => entry.signer), entries.map((entry) => entry.signature)]
    );
  }

  async function validEoaAndNestedBundle(authority, nestedVerifier, awardDigest) {
    return sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(authority, verifierA, awardDigest),
      },
      {
        signer: await nestedVerifier.getAddress(),
        signature: await signAttestation(authority, nestedSigner, awardDigest),
      },
    ]);
  }

  it("accepts an EOA, an ERC-1271 contract, and another verifier in the set", async function () {
    const { authority, nestedVerifier } = await deployMixedAuthority();
    const nestedAddress = await nestedVerifier.getAddress();

    expect(await authority.verifierAt(0)).to.equal(verifierA.address);
    expect(await authority.verifierAt(1)).to.equal(nestedAddress);
    expect(await authority.verifierAt(2)).to.equal(verifierC.address);
    expect(await authority.isVerifier(nestedAddress)).to.equal(true);
  });

  it("accepts a valid EOA plus ERC-1271 verifier combination for 2-of-3", async function () {
    const { authority, nestedVerifier } = await deployMixedAuthority();
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("nested-award-1"));
    const bundle = await validEoaAndNestedBundle(
      authority,
      nestedVerifier,
      awardDigest
    );

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0x1626ba7e"
    );
  });

  it("rejects an invalid nested ERC-1271 signature", async function () {
    const { authority, nestedVerifier } = await deployMixedAuthority();
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("nested-award-2"));
    const nestedAddress = await nestedVerifier.getAddress();
    const bundle = sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(authority, verifierA, awardDigest),
      },
      {
        signer: nestedAddress,
        signature: await signAttestation(authority, verifierC, awardDigest),
      },
    ]);

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0xffffffff"
    );
  });

  it("rejects duplicate ERC-1271 verifier entries", async function () {
    const { authority, nestedVerifier } = await deployMixedAuthority();
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("nested-award-3"));
    const nestedAddress = await nestedVerifier.getAddress();
    const signature = await signAttestation(authority, nestedSigner, awardDigest);
    const bundle = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "bytes[]"],
      [[nestedAddress, nestedAddress], [signature, signature]]
    );

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0xffffffff"
    );
  });

  it("rejects a nested ERC-1271 signature for a different award digest", async function () {
    const { authority, nestedVerifier } = await deployMixedAuthority();
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("nested-award-4"));
    const otherDigest = ethers.keccak256(
      ethers.toUtf8Bytes("different-nested-award")
    );
    const nestedAddress = await nestedVerifier.getAddress();
    const bundle = sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(authority, verifierA, otherDigest),
      },
      {
        signer: nestedAddress,
        signature: await signAttestation(authority, nestedSigner, otherDigest),
      },
    ]);

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0xffffffff"
    );
  });

  it("rejects nested attestations made against a different policy hash", async function () {
    const { authority, nestedVerifier } = await deployMixedAuthority();
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("nested-award-5"));
    const wrongPolicy = ethers.keccak256(
      ethers.toUtf8Bytes("different-nested-policy")
    );
    const nestedAddress = await nestedVerifier.getAddress();
    const bundle = sortedBundle([
      {
        signer: verifierA.address,
        signature: await signAttestation(
          authority,
          verifierA,
          awardDigest,
          wrongPolicy
        ),
      },
      {
        signer: nestedAddress,
        signature: await signAttestation(
          authority,
          nestedSigner,
          awardDigest,
          wrongPolicy
        ),
      },
    ]);

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0xffffffff"
    );
  });

  it("settles fixed GCC through ERC-1271 verifier -> authority -> escrow", async function () {
    const { authority, nestedVerifier } = await deployMixedAuthority();
    const MockGCC = await ethers.getContractFactory("MockGCC");
    const token = await MockGCC.deploy();
    await token.waitForDeployment();

    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latest.timestamp + 7 * 24 * 60 * 60);
    const tenderHash = ethers.keccak256(
      ethers.toUtf8Bytes("GCC-GENESIS-001 nested ERC-1271 tender")
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

    const award = {
      tenderHash,
      awardClass: await escrow.QUALIFIED_PROPOSAL(),
      deliverableHash: ethers.keccak256(
        ethers.toUtf8Bytes("nested-deliverable")
      ),
      assessmentHash: ethers.keccak256(
        ethers.toUtf8Bytes("nested-assessment")
      ),
      recipient: recipient.address,
      validUntil: deadline - 60n,
    };
    const awardDigest = await escrow.awardDigest(award);
    const bundle = await validEoaAndNestedBundle(
      authority,
      nestedVerifier,
      awardDigest
    );

    await escrow.settle(award, bundle);

    expect(await token.balanceOf(recipient.address)).to.equal(
      10n * 10n ** 18n
    );
  });
});
