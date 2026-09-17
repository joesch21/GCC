const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  SECP256K1_HALF_ORDER,
  SECP256K1_ORDER,
  adaptExternalDerSignature,
  computeAttestationDigest,
  encodeDerSignatureForTest,
  normalizeSecp256k1Signature,
  parseDerSignature,
} = require("./test-only-genesis-external-verifier-adapter");

const TEST_ONLY_EXTERNAL_SIGNER_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

describe("TEST-ONLY Genesis external verifier adapter", function () {
  let verifierA;
  let verifierC;
  let recipient;
  let policyHash;
  let externalSigner;
  let authority;

  beforeEach(async function () {
    [, verifierA, verifierC, recipient] = await ethers.getSigners();
    externalSigner = new ethers.Wallet(TEST_ONLY_EXTERNAL_SIGNER_PRIVATE_KEY);
    policyHash = ethers.keccak256(
      ethers.toUtf8Bytes("GCC-GENESIS-001 external verifier test policy")
    );

    const Authority = await ethers.getContractFactory(
      "GenesisVerifierAuthority"
    );
    authority = await Authority.deploy(
      policyHash,
      externalSigner.address,
      verifierA.address,
      verifierC.address
    );
    await authority.waitForDeployment();
  });

  function adapterInput(awardDigest, expectedVerifier = externalSigner.address) {
    return {
      authorityAddress: authority.target,
      chainId: 56,
      policyHash,
      awardDigest,
      expectedVerifier,
    };
  }

  async function signedDer(awardDigest, signer = externalSigner) {
    const digest = computeAttestationDigest(adapterInput(awardDigest));
    const signature = signer.signingKey.sign(digest);
    return {
      digest,
      derSignature: encodeDerSignatureForTest(signature),
      signature,
    };
  }

  function sortedBundle(entries) {
    entries.sort((left, right) => {
      const leftValue = BigInt(left.signer);
      const rightValue = BigInt(right.signer);
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });

    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "bytes[]"],
      [
        entries.map((entry) => entry.signer),
        entries.map((entry) => entry.signature),
      ]
    );
  }

  async function directAttestation(signer, awardDigest) {
    return signer.signTypedData(
      {
        name: "GCC Genesis Verifier Authority",
        version: "1",
        chainId: 56,
        verifyingContract: authority.target,
      },
      {
        Attestation: [
          { name: "awardDigest", type: "bytes32" },
          { name: "policyHash", type: "bytes32" },
        ],
      },
      { awardDigest, policyHash }
    );
  }

  it("computes the exact attestation digest returned by Solidity", async function () {
    const awardDigest = ethers.keccak256(
      ethers.toUtf8Bytes("deterministic external award")
    );
    const offChainDigest = computeAttestationDigest(adapterInput(awardDigest));

    expect(offChainDigest).to.equal(
      await authority.attestationDigest(awardDigest)
    );
  });

  it("parses DER r/s and returns a validated 65-byte Ethereum signature", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("der-parse"));
    const fixture = await signedDer(awardDigest);
    const parsed = parseDerSignature(fixture.derSignature);
    const adapted = adaptExternalDerSignature({
      ...adapterInput(awardDigest),
      derSignature: fixture.derSignature,
    });

    expect(parsed.r).to.equal(BigInt(fixture.signature.r));
    expect(parsed.s).to.equal(BigInt(fixture.signature.s));
    expect(ethers.dataLength(adapted.ethereumSignature)).to.equal(65);
    expect(adapted.v).to.be.oneOf([27, 28]);
    expect(ethers.getBytes(adapted.ethereumSignature)[64]).to.equal(adapted.v);
    expect(adapted.recoveredAddress).to.equal(externalSigner.address);
    expect(ethers.recoverAddress(adapted.digest, adapted.ethereumSignature)).to.equal(
      externalSigner.address
    );
  });

  it("rejects malformed DER encodings", function () {
    const malformed = [
      "0x",
      "0x3106020101020101",
      "0x3006020101020101ff",
      "0x3006020180020101",
      "0x300702020001020101",
      "0x308106020101020101",
    ];

    for (const derSignature of malformed) {
      expect(() => parseDerSignature(derSignature)).to.throw("Malformed DER");
    }
  });

  it("rejects invalid r and s scalars", function () {
    const invalidScalars = [
      { label: "r=0", r: 0n, s: 1n },
      { label: "r=order", r: SECP256K1_ORDER, s: 1n },
      { label: "s=0", r: 1n, s: 0n },
      { label: "s=order", r: 1n, s: SECP256K1_ORDER },
    ];

    for (const scalar of invalidScalars) {
      expect(() =>
        parseDerSignature(encodeDerSignatureForTest(scalar))
      ).to.throw(/Invalid [rs] scalar/);
    }
  });

  it("normalizes the high-s boundary and preserves a valid recovered signer", async function () {
    const boundary = normalizeSecp256k1Signature({
      r: 1n,
      s: SECP256K1_HALF_ORDER + 1n,
    });
    expect(boundary.s).to.equal(SECP256K1_HALF_ORDER);
    expect(boundary.highSNormalized).to.equal(true);

    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("high-s"));
    const fixture = await signedDer(awardDigest);
    const highSDer = encodeDerSignatureForTest({
      r: BigInt(fixture.signature.r),
      s: SECP256K1_ORDER - BigInt(fixture.signature.s),
    });
    const lowSAdapted = adaptExternalDerSignature({
      ...adapterInput(awardDigest),
      derSignature: encodeDerSignatureForTest(fixture.signature),
    });
    const adapted = adaptExternalDerSignature({
      ...adapterInput(awardDigest),
      derSignature: highSDer,
    });

    expect(BigInt(fixture.signature.s)).to.be.at.most(SECP256K1_HALF_ORDER);
    expect(adapted.highSNormalized).to.equal(true);
    expect(adapted.s).to.equal(ethers.zeroPadValue(fixture.signature.s, 32));
    // The high-s representation would use the opposite parity; normalization
    // restores low-s and must therefore emit the original low-s parity.
    expect(adapted.v).to.equal(lowSAdapted.v);
    expect(BigInt(adapted.s)).to.be.at.most(SECP256K1_HALF_ORDER);
    expect(adapted.recoveredAddress).to.equal(externalSigner.address);
  });

  it("rejects a DER signature made for a wrong digest", async function () {
    const signed = await signedDer(ethers.keccak256(ethers.toUtf8Bytes("right")));
    const wrongDigest = ethers.keccak256(ethers.toUtf8Bytes("wrong"));

    expect(() =>
      adaptExternalDerSignature({
        ...adapterInput(wrongDigest),
        derSignature: signed.derSignature,
      })
    ).to.throw("does not recover the expected verifier");
  });

  it("rejects a DER signature when the expected verifier address is wrong", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("wrong-address"));
    const signed = await signedDer(awardDigest);

    expect(() =>
      adaptExternalDerSignature({
        ...adapterInput(awardDigest, verifierA.address),
        derSignature: signed.derSignature,
      })
    ).to.throw("does not recover the expected verifier");
  });

  it("rejects incorrect recovery-id candidates", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("recovery-id"));
    const signed = await signedDer(awardDigest);
    const valid = adaptExternalDerSignature({
      ...adapterInput(awardDigest),
      derSignature: signed.derSignature,
    });
    const wrongCandidate = valid.v === 27 ? 28 : 27;

    expect(() =>
      adaptExternalDerSignature({
        ...adapterInput(awardDigest),
        derSignature: signed.derSignature,
        recoveryIdCandidates: [wrongCandidate],
      })
    ).to.throw("does not recover the expected verifier");

    expect(() =>
      adaptExternalDerSignature({
        ...adapterInput(awardDigest),
        derSignature: signed.derSignature,
        recoveryIdCandidates: [29],
      })
    ).to.throw("Recovery id candidates must be 27 or 28");
  });

  it("accepts the external adapter signature in a valid 2-of-3 authorization", async function () {
    const awardDigest = ethers.keccak256(ethers.toUtf8Bytes("integration"));
    const signed = await signedDer(awardDigest);
    const adapted = adaptExternalDerSignature({
      ...adapterInput(awardDigest),
      derSignature: signed.derSignature,
    });
    const bundle = sortedBundle([
      {
        signer: externalSigner.address,
        signature: adapted.ethereumSignature,
      },
      {
        signer: verifierA.address,
        signature: await directAttestation(verifierA, awardDigest),
      },
    ]);

    expect(await authority.isValidSignature(awardDigest, bundle)).to.equal(
      "0x1626ba7e"
    );
  });

  it("does not require or grant any provider-specific authority", function () {
    expect(Object.keys(require("./test-only-genesis-external-verifier-adapter")))
      .to.not.include("aws")
      .and.to.not.include("azure");
  });
});
