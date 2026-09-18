const { expect } = require("chai");
const { Wallet, AbiCoder } = require("ethers");

const {
  assembleAuthorization,
  sendPreparedSettlement,
} = require("../src/genesisSettlement/relayer");

describe("Genesis bounded settlement relayer", function () {
  it("sorts verifier authorization entries by signer address", function () {
    const a = Wallet.createRandom();
    const b = Wallet.createRandom();
    const sigA = "0x1234";
    const sigB = "0xabcd";

    const encoded = assembleAuthorization([
      { signer: b.address, signature: sigB },
      { signer: a.address, signature: sigA },
    ]);
    const [signers, signatures] = AbiCoder.defaultAbiCoder().decode(
      ["address[]", "bytes[]"],
      encoded
    );

    const expected = [
      { signer: a.address, signature: sigA },
      { signer: b.address, signature: sigB },
    ].sort((left, right) =>
      BigInt(left.signer) < BigInt(right.signer) ? -1 : 1
    );

    expect(Array.from(signers)).to.deep.equal(
      expected.map((entry) => entry.signer)
    );
    expect(Array.from(signatures)).to.deep.equal(
      expected.map((entry) => entry.signature)
    );
  });

  it("rejects duplicate verifier signers", function () {
    const wallet = Wallet.createRandom();
    expect(() =>
      assembleAuthorization([
        { signer: wallet.address, signature: "0x12" },
        { signer: wallet.address, signature: "0x34" },
      ])
    ).to.throw("Duplicate verifier signer");
  });

  it("never sends when the escrow is not funded", async function () {
    let connected = false;
    const wallet = {
      connect() {
        connected = true;
        return this;
      },
    };

    let error;
    try {
      await sendPreparedSettlement({
        wallet,
        provider: {},
        prepared: {
          settlement: {
            fundedForAward: false,
            simulation: { success: false },
          },
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error.code).to.equal("GENESIS_RELAYER_ESCROW_UNFUNDED");
    expect(connected).to.equal(false);
  });
});
