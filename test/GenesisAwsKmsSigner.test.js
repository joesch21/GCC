const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  ethereumSignatureFromDer,
  parseDerSignature,
} = require("../src/genesisVerifierB/awsKmsSigner");

function derLength(length) {
  if (length < 0x80) return [length];
  const bytes = [];
  for (let value = length; value > 0; value >>= 8) {
    bytes.unshift(value & 0xff);
  }
  return [0x80 | bytes.length, ...bytes];
}

function derInteger(hexValue) {
  let bytes = Array.from(ethers.getBytes(hexValue));
  while (bytes.length > 1 && bytes[0] === 0) bytes.shift();
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0);
  return [0x02, ...derLength(bytes.length), ...bytes];
}

function toDer(signature) {
  const parsed = ethers.Signature.from(signature);
  const body = [
    ...derInteger(parsed.r),
    ...derInteger(parsed.s),
  ];
  return ethers.hexlify(
    Uint8Array.from([0x30, ...derLength(body.length), ...body])
  );
}

describe("Genesis AWS KMS signer adapter", function () {
  it("adapts a DER secp256k1 signature back to the expected EVM signer", async function () {
    const wallet = ethers.Wallet.createRandom();
    const digest = ethers.keccak256(
      ethers.toUtf8Bytes("GCC-GENESIS-001 KMS adapter unit test")
    );
    const direct = wallet.signingKey.sign(digest).serialized;
    const der = toDer(direct);

    const parsed = parseDerSignature(der);
    expect(parsed.r).to.be.greaterThan(0n);
    expect(parsed.s).to.be.greaterThan(0n);

    const adapted = ethereumSignatureFromDer({
      digest,
      derSignature: der,
      expectedAddress: wallet.address,
    });
    expect(ethers.recoverAddress(digest, adapted)).to.equal(wallet.address);
  });

  it("rejects a DER signature when the expected verifier is different", async function () {
    const wallet = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const digest = ethers.keccak256(
      ethers.toUtf8Bytes("GCC-GENESIS-001 wrong verifier test")
    );
    const der = toDer(wallet.signingKey.sign(digest).serialized);

    expect(() =>
      ethereumSignatureFromDer({
        digest,
        derSignature: der,
        expectedAddress: other.address,
      })
    ).to.throw("does not recover");
  });
});
