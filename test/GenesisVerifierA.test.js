const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  createEncryptedLocalSigner,
} = require("../src/genesisVerifierA/encryptedLocalSigner");

describe("Genesis Verifier A encrypted local signer", function () {
  it("decrypts locally and signs exactly a 32-byte digest", async function () {
    this.timeout(20000);

    const wallet = ethers.Wallet.createRandom();
    const password = "test-only-verifier-a-password";
    const keystoreJson = await wallet.encrypt(password);
    const signer = await createEncryptedLocalSigner({
      keystoreJson,
      password,
    });

    expect(signer.signerAddress).to.equal(wallet.address);

    const digest = ethers.keccak256(
      ethers.toUtf8Bytes("GENESIS_VERIFIER_A_TEST")
    );
    const signature = await signer.signGenesisAttestationDigest(digest);
    expect(ethers.recoverAddress(digest, signature)).to.equal(wallet.address);
    expect(Object.prototype.hasOwnProperty.call(signer, "privateKey")).to.equal(
      false
    );
  });

  it("rejects malformed or caller-sized digest input", async function () {
    this.timeout(20000);

    const wallet = ethers.Wallet.createRandom();
    const password = "test-only-verifier-a-password";
    const signer = await createEncryptedLocalSigner({
      keystoreJson: await wallet.encrypt(password),
      password,
    });

    for (const digest of ["0x", "0x1234", "not-hex"]) {
      try {
        await signer.signGenesisAttestationDigest(digest);
        expect.fail("expected invalid digest rejection");
      } catch (error) {
        expect(error.code).to.equal("GENESIS_VERIFIER_A_DIGEST_INVALID");
      }
    }
  });

  it("fails closed on the wrong password", async function () {
    this.timeout(20000);

    const wallet = ethers.Wallet.createRandom();
    const keystoreJson = await wallet.encrypt(
      "test-only-verifier-a-password"
    );

    try {
      await createEncryptedLocalSigner({
        keystoreJson,
        password: "wrong-password",
      });
      expect.fail("expected unlock failure");
    } catch (error) {
      expect(error.code).to.equal("GENESIS_VERIFIER_A_UNLOCK_FAILED");
    }
  });
});
