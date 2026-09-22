const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  VERIFIED_GG6_ESCROW,
  EXISTING_RELAYER,
  normalizeConfig,
  validateRelayRequest,
} = require("../src/gg7RelayCore");

describe("GG-7 bounded relay core", function () {
  const now = 1_790_116_000;
  const base = {
    payout: {
      transferMaterialHash:
        "0x6a7c3bfaf1b6eea3c984285ac501f7cac79e7bfc426837c5ce075c2154705462",
      recipient: "0x0C5c77F31CD27A4ADbf15a690E99CC50437442de",
      amount: "1000000000000000000",
      validUntil: String(now + 900),
    },
    humanAuthorization:
      "0x" + "11".repeat(65),
  };

  it("accepts only a short-lived exact-shaped human-authorized payout", function () {
    const parsed = validateRelayRequest(base, {
      nowSeconds: now,
      maxPayoutBaseUnits: 1000n * 10n ** 18n,
      maxValiditySeconds: 1800,
    });

    expect(parsed.payout.amount).to.equal("1000000000000000000");
    expect(parsed.payout.recipient).to.equal(
      "0x0C5c77F31CD27A4ADbf15a690E99CC50437442de"
    );
  });

  it("rejects expired, over-horizon and over-limit requests", function () {
    const common = {
      nowSeconds: now,
      maxPayoutBaseUnits: 2n * 10n ** 18n,
      maxValiditySeconds: 1800,
    };

    expect(() =>
      validateRelayRequest(
        { ...base, payout: { ...base.payout, validUntil: String(now) } },
        common
      )
    ).to.throw("gg7_authorization_expired");

    expect(() =>
      validateRelayRequest(
        { ...base, payout: { ...base.payout, validUntil: String(now + 1801) } },
        common
      )
    ).to.throw("gg7_authorization_horizon_exceeded");

    expect(() =>
      validateRelayRequest(
        { ...base, payout: { ...base.payout, amount: "3000000000000000000" } },
        common
      )
    ).to.throw("gg7_amount_exceeds_service_limit");
  });

  it("pins the already verified GG-6 escrow", function () {
    expect(normalizeConfig({ escrowAddress: VERIFIED_GG6_ESCROW }).escrowAddress)
      .to.equal(VERIFIED_GG6_ESCROW);

    expect(() =>
      normalizeConfig({
        escrowAddress: "0x8e834961EeC8F1a7048964B28E8156A211993E12",
      })
    ).to.throw("gg7_verified_gg6_escrow_required");
  });

  it("keeps the daemon local-only and refuses raw password environment use", function () {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "serve-gg7-grant-relayer.js"),
      "utf8"
    );

    expect(source).to.include('"/run/gcc/gg7-grant-relayer.sock"');
    expect(source).to.include("server.listen(SOCKET_PATH");
    expect(source).to.not.match(/server\.listen\([^\n]+127\.0\.0\.1/);
    expect(source).to.include("GG7_RELAYER_PASSWORD environment variable is forbidden");
    expect(source).to.include("CREDENTIALS_DIRECTORY");
    expect(source).to.include('["/simulate", "/settle"]');
    expect(source).to.not.include("privateKey");
  });

  it("pins the existing Genesis relayer identity", function () {
    expect(EXISTING_RELAYER).to.equal(
      "0x381c2939c943C52D9260B0c635d2FD7B17FB1C21"
    );
  });
});
