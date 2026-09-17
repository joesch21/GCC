const { expect } = require("chai");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");

const {
  adaptExternalDerSignature,
  computeAttestationDigest,
} = require("./test-only-genesis-external-verifier-adapter");
const {
  getAwsKmsPocConfig,
  getKmsEthereumAddress,
  signDigestWithKms,
} = require("./test-only-aws-kms-genesis-signer");

const policyHash = require("fs")
  .readFileSync(
    path.join(
      __dirname,
      "..",
      "policies",
      "GCC-GENESIS-001.verifier-policy.keccak256"
    ),
    "utf8"
  )
  .trim();

const RUN_AWS_KMS_POC = process.env.GCC_GENESIS_RUN_AWS_KMS_POC === "1";
const describeAwsKms = RUN_AWS_KMS_POC ? describe : describe.skip;
const UNIT = 10n ** 18n;
const FIXED_REWARD = 10n * UNIT;

describeAwsKms("TEST-ONLY AWS KMS Genesis integration", function () {
  it("settles a real KMS signature through authority and escrow", async function () {
    const config = getAwsKmsPocConfig();
    const derivedAddress = await getKmsEthereumAddress(config.keyId);
    expect(derivedAddress).to.equal(config.expectedAddress);

    const [deployer, verifier2, verifier3, recipient, relayer] =
      await ethers.getSigners();

    const Authority = await ethers.getContractFactory(
      "GenesisVerifierAuthority"
    );
    const authority = await Authority.deploy(
      policyHash,
      config.expectedAddress,
      verifier2.address,
      verifier3.address
    );
    await authority.waitForDeployment();

    const MockGCC = await ethers.getContractFactory("MockGCC");
    const token = await MockGCC.deploy();
    await token.waitForDeployment();

    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latest.timestamp + 7 * 24 * 60 * 60);
    const tenderHash = ethers.keccak256(
      ethers.toUtf8Bytes("GCC-GENESIS-001 AWS KMS local POC tender")
    );

    const Escrow = await ethers.getContractFactory("GenesisDeliverableEscrow");
    const escrow = await Escrow.deploy(
      await token.getAddress(),
      await authority.getAddress(),
      tenderHash,
      deadline,
      FIXED_REWARD,
      1,
      0,
      0,
      0,
      0
    );
    await escrow.waitForDeployment();
    await token.mint(await escrow.getAddress(), FIXED_REWARD);

    const award = {
      tenderHash,
      awardClass: await escrow.QUALIFIED_PROPOSAL(),
      deliverableHash: ethers.keccak256(
        ethers.toUtf8Bytes("GCC-GENESIS-001 AWS KMS deterministic deliverable")
      ),
      assessmentHash: ethers.keccak256(
        ethers.toUtf8Bytes("GCC-GENESIS-001 AWS KMS deterministic assessment")
      ),
      recipient: recipient.address,
      validUntil: deadline - 60n,
    };

    const awardDigest = await escrow.awardDigest(award);
    const attestationDigest = computeAttestationDigest({
      authorityAddress: await authority.getAddress(),
      chainId: 56,
      policyHash,
      awardDigest,
    });
    expect(attestationDigest).to.equal(
      await authority.attestationDigest(awardDigest)
    );

    let tempDirectory;
    try {
      tempDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "gcc-genesis-aws-kms-poc-")
      );
      const digestPath = path.join(tempDirectory, "attestation-digest.bin");
      const digestBytes = Buffer.from(ethers.getBytes(attestationDigest));
      expect(digestBytes.length).to.equal(32);
      await fs.writeFile(digestPath, digestBytes);
      expect((await fs.readFile(digestPath)).equals(digestBytes)).to.equal(true);

      const kmsDerSignature = await signDigestWithKms(
        config.keyId,
        digestPath
      );
      const kmsSignature = adaptExternalDerSignature({
        authorityAddress: await authority.getAddress(),
        chainId: 56,
        policyHash,
        awardDigest,
        expectedVerifier: config.expectedAddress,
        derSignature: kmsDerSignature,
      });
      expect(kmsSignature.recoveredAddress).to.equal(config.expectedAddress);

      const verifier2Signature = await verifier2.signTypedData(
        {
          name: "GCC Genesis Verifier Authority",
          version: "1",
          chainId: 56,
          verifyingContract: await authority.getAddress(),
        },
        {
          Attestation: [
            { name: "awardDigest", type: "bytes32" },
            { name: "policyHash", type: "bytes32" },
          ],
        },
        { awardDigest, policyHash }
      );

      const entries = [
        {
          signer: config.expectedAddress,
          signature: kmsSignature.ethereumSignature,
        },
        { signer: verifier2.address, signature: verifier2Signature },
      ].sort((left, right) => {
        const leftValue = BigInt(left.signer);
        const rightValue = BigInt(right.signer);
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      });
      const authorization = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address[]", "bytes[]"],
        [
          entries.map((entry) => entry.signer),
          entries.map((entry) => entry.signature),
        ]
      );

      expect(
        await authority.isValidSignature(awardDigest, authorization)
      ).to.equal("0x1626ba7e");

      const wrongAwardDigest = ethers.keccak256(
        ethers.toUtf8Bytes("GCC-GENESIS-001 AWS KMS wrong award")
      );
      const wrongVerifier2Signature = await verifier2.signTypedData(
        {
          name: "GCC Genesis Verifier Authority",
          version: "1",
          chainId: 56,
          verifyingContract: await authority.getAddress(),
        },
        {
          Attestation: [
            { name: "awardDigest", type: "bytes32" },
            { name: "policyHash", type: "bytes32" },
          ],
        },
        { awardDigest: wrongAwardDigest, policyHash }
      );
      const wrongEntries = [
        {
          signer: config.expectedAddress,
          signature: kmsSignature.ethereumSignature,
        },
        { signer: verifier2.address, signature: wrongVerifier2Signature },
      ].sort((left, right) => {
        const leftValue = BigInt(left.signer);
        const rightValue = BigInt(right.signer);
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      });
      const wrongAuthorization = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address[]", "bytes[]"],
        [
          wrongEntries.map((entry) => entry.signer),
          wrongEntries.map((entry) => entry.signature),
        ]
      );
      expect(
        await authority.isValidSignature(wrongAwardDigest, wrongAuthorization)
      ).to.equal("0xffffffff");

      const recipientBefore = await token.balanceOf(recipient.address);
      const escrowBefore = await token.balanceOf(await escrow.getAddress());
      const totalPaidBefore = await escrow.totalPaid();
      const totalSupplyBefore = await token.totalSupply();

      await escrow.connect(relayer).settle(award, authorization);

      expect(await token.balanceOf(recipient.address)).to.equal(
        recipientBefore + FIXED_REWARD
      );
      expect(await escrow.totalPaid()).to.equal(
        totalPaidBefore + FIXED_REWARD
      );
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(
        escrowBefore - FIXED_REWARD
      );
      expect(await token.totalSupply()).to.equal(totalSupplyBefore);
      for (const address of [
        deployer.address,
        verifier2.address,
        verifier3.address,
        relayer.address,
        await authority.getAddress(),
        config.expectedAddress,
      ]) {
        expect(await token.balanceOf(address)).to.equal(0n);
      }
    } finally {
      if (tempDirectory) {
        await fs.rm(tempDirectory, { recursive: true, force: true });
      }
    }
  });
});
