const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

describe("GG-6 exact canary signer safety surface", function () {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "serve-gg6-canary-signer.js"),
    "utf8"
  );

  it("pins the exact deployed escrow, authority, recipient, amount and material hash", function () {
    expect(source).to.include("0xca458394e8c3137ce4984bdac6e615d08e2482f6");
    expect(source).to.include("0x0b36b0495c5e7899648d731d7b88d6ffd3915184");
    expect(source).to.include("0x0c5c77f31cd27a4adbf15a690e99cc50437442de");
    expect(source).to.include('const CANARY_AMOUNT = "1000000000000000000"');
    expect(source).to.include(
      "0x6a7c3bfaf1b6eea3c984285ac501f7cac79e7bfc426837c5ce075c2154705462"
    );
  });

  it("signs typed data locally and contains no transaction send path", function () {
    expect(source).to.include("signTypedData");
    expect(source).to.include("verifyTypedData");
    expect(source).to.include("SIGNATURE_RECOVERED_LOCALLY");
    expect(source).to.not.include("sendTransaction(");
    expect(source).to.not.include(".settle(");
    expect(source).to.not.include("eth_sendTransaction");
    expect(source).to.not.include("eth_sendRawTransaction");
  });

  it("requires bounded relayer dry-run for contract-level acceptance", function () {
    expect(source).to.include("accountCodePresent");
    expect(source).to.include("bounded relayer dry-run is required");
    expect(source).to.not.include("currently expects the configured human authority to be an EOA");
  });

  it("never posts the signature back to the local server", function () {
    expect(source).to.not.match(/fetch\([^\n]+method\s*:\s*["']POST["']/);
    expect(source).to.include("privateKeyReceivedByServer: false");
    expect(source).to.include("transactionBroadcastEnabled: false");
  });
});
