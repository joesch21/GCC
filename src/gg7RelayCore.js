const {
  Contract,
  Interface,
  getAddress,
  isAddress,
  parseEther,
} = require("ethers");

const CHAIN_ID = 56;
const VERIFIED_GG6_ESCROW = "0xca458394e8C3137cE4984bDac6E615d08E2482F6";
const VERIFIED_GCC = "0x092aC429b9c3450c9909433eB0662c3b7c13cF9A";
const EXISTING_RELAYER = "0x381c2939c943C52D9260B0c635d2FD7B17FB1C21";
const HUMAN_AUTHORITY = "0x0b36B0495c5e7899648D731d7b88d6Ffd3915184";

const ESCROW_ABI = [
  "function gcc() view returns (address)",
  "function humanAuthority() view returns (address)",
  "function relayer() view returns (address)",
  "function escrowBalance() view returns (uint256)",
  "function fundingShortfall(uint256 pendingAmount) view returns (uint256)",
  "function derivePayoutId((bytes32 transferMaterialHash,address recipient,uint256 amount,uint64 validUntil) payout) pure returns (bytes32)",
  "function paidPayout(bytes32 payoutId) view returns (bool)",
  "function totalPaid() view returns (uint256)",
  "function settle((bytes32 transferMaterialHash,address recipient,uint256 amount,uint64 validUntil) payout, bytes humanAuthorization) returns (bytes32)",
];

function parsePositiveBigInt(value, fallback, label) {
  const raw = String(value ?? fallback ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(label + "_invalid");
  return BigInt(raw);
}

function normalizeConfig(override = {}) {
  const escrowAddress = getAddress(
    override.escrowAddress || process.env.GG7_GRANT_ESCROW_ADDRESS || VERIFIED_GG6_ESCROW
  );
  if (escrowAddress !== getAddress(VERIFIED_GG6_ESCROW)) {
    throw new Error("gg7_verified_gg6_escrow_required");
  }

  const maxGasLimit = parsePositiveBigInt(
    override.maxGasLimit ?? process.env.GG7_RELAYER_MAX_GAS_LIMIT,
    "500000",
    "gg7_max_gas_limit"
  );
  const maxGasCostWei = parsePositiveBigInt(
    override.maxGasCostWei ?? process.env.GG7_RELAYER_MAX_GAS_COST_WEI,
    parseEther("0.005").toString(),
    "gg7_max_gas_cost"
  );
  const maxPayoutBaseUnits = parsePositiveBigInt(
    override.maxPayoutBaseUnits ?? process.env.GG7_RELAYER_MAX_PAYOUT_BASE_UNITS,
    (1000n * 10n ** 18n).toString(),
    "gg7_max_payout"
  );
  const maxValiditySeconds = Number(
    override.maxValiditySeconds ??
      process.env.GG7_RELAYER_MAX_VALIDITY_SECONDS ??
      1800
  );
  if (!Number.isSafeInteger(maxValiditySeconds) || maxValiditySeconds < 60 || maxValiditySeconds > 1800) {
    throw new Error("gg7_max_validity_invalid");
  }

  return {
    escrowAddress,
    maxGasLimit,
    maxGasCostWei,
    maxPayoutBaseUnits,
    maxValiditySeconds,
  };
}

function validateHex(value, bytes, label) {
  const raw = String(value || "");
  const expected = 2 + bytes * 2;
  if (!new RegExp("^0x[0-9a-fA-F]{" + (expected - 2) + "}$").test(raw)) {
    throw new Error(label + "_invalid");
  }
  return raw;
}

function validateRelayRequest(request, { nowSeconds, maxPayoutBaseUnits, maxValiditySeconds }) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("gg7_request_invalid");
  }
  const payout = request.payout;
  if (!payout || typeof payout !== "object" || Array.isArray(payout)) {
    throw new Error("gg7_payout_required");
  }

  const transferMaterialHash = validateHex(
    payout.transferMaterialHash,
    32,
    "gg7_transfer_material_hash"
  );
  if (/^0x0{64}$/i.test(transferMaterialHash)) {
    throw new Error("gg7_transfer_material_hash_zero");
  }

  const recipientRaw = String(payout.recipient || "");
  if (!isAddress(recipientRaw)) throw new Error("gg7_recipient_invalid");
  const recipient = getAddress(recipientRaw);
  if (recipient === getAddress("0x0000000000000000000000000000000000000000")) {
    throw new Error("gg7_recipient_zero");
  }

  const amountRaw = String(payout.amount || "");
  if (!/^[1-9][0-9]*$/.test(amountRaw)) throw new Error("gg7_amount_invalid");
  const amount = BigInt(amountRaw);
  if (amount > maxPayoutBaseUnits) throw new Error("gg7_amount_exceeds_service_limit");

  const validUntilRaw = String(payout.validUntil || "");
  if (!/^[1-9][0-9]*$/.test(validUntilRaw)) throw new Error("gg7_valid_until_invalid");
  const validUntil = BigInt(validUntilRaw);
  const now = BigInt(nowSeconds);
  if (validUntil <= now) throw new Error("gg7_authorization_expired");
  if (validUntil > now + BigInt(maxValiditySeconds)) {
    throw new Error("gg7_authorization_horizon_exceeded");
  }

  const humanAuthorization = validateHex(
    request.humanAuthorization,
    65,
    "gg7_human_authorization"
  );

  return Object.freeze({
    payout: Object.freeze({
      transferMaterialHash,
      recipient,
      amount: amount.toString(),
      validUntil: validUntil.toString(),
    }),
    humanAuthorization,
  });
}

async function verifyInfrastructure({ provider, escrowAddress, expectedRelayer = EXISTING_RELAYER }) {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error("gg7_chain_must_be_bsc_mainnet");
  }
  const code = await provider.getCode(escrowAddress);
  if (!code || code === "0x") throw new Error("gg7_escrow_code_required");

  const escrow = new Contract(escrowAddress, ESCROW_ABI, provider);
  const [gcc, authority, relayer] = await Promise.all([
    escrow.gcc(),
    escrow.humanAuthority(),
    escrow.relayer(),
  ]);

  if (getAddress(gcc) !== getAddress(VERIFIED_GCC)) {
    throw new Error("gg7_gcc_binding_mismatch");
  }
  if (getAddress(authority) !== getAddress(HUMAN_AUTHORITY)) {
    throw new Error("gg7_human_authority_binding_mismatch");
  }
  if (getAddress(relayer) !== getAddress(expectedRelayer)) {
    throw new Error("gg7_relayer_binding_mismatch");
  }

  return { escrow, gcc: getAddress(gcc), authority: getAddress(authority), relayer: getAddress(relayer) };
}

function createGg7RelayCore({
  provider,
  wallet = null,
  config = {},
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!provider) throw new Error("gg7_provider_required");
  const cfg = normalizeConfig(config);
  const iface = new Interface(ESCROW_ABI);

  async function prepare(rawRequest) {
    const infrastructure = await verifyInfrastructure({
      provider,
      escrowAddress: cfg.escrowAddress,
      expectedRelayer: EXISTING_RELAYER,
    });

    const request = validateRelayRequest(rawRequest, {
      nowSeconds: clock(),
      maxPayoutBaseUnits: cfg.maxPayoutBaseUnits,
      maxValiditySeconds: cfg.maxValiditySeconds,
    });

    const data = iface.encodeFunctionData("settle", [
      {
        transferMaterialHash: request.payout.transferMaterialHash,
        recipient: request.payout.recipient,
        amount: request.payout.amount,
        validUntil: request.payout.validUntil,
      },
      request.humanAuthorization,
    ]);

    const from = getAddress(EXISTING_RELAYER);
    const [gasEstimate, simulation, feeData] = await Promise.all([
      provider.estimateGas({ from, to: cfg.escrowAddress, data, value: 0n }),
      provider.call({ from, to: cfg.escrowAddress, data, value: 0n }),
      provider.getFeeData(),
    ]);

    if (gasEstimate > cfg.maxGasLimit) throw new Error("gg7_gas_limit_exceeded");
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (!gasPrice) throw new Error("gg7_gas_price_unavailable");
    const estimatedGasCost = gasEstimate * gasPrice;
    if (estimatedGasCost > cfg.maxGasCostWei) throw new Error("gg7_gas_cost_exceeded");

    return {
      request,
      infrastructure,
      data,
      gasEstimate,
      estimatedGasCost,
      simulation,
    };
  }

  async function simulate(rawRequest) {
    const prepared = await prepare(rawRequest);
    return {
      schema: "gcc.gg7_bounded_relay_result.v1",
      status: "DRY_RUN_PASS",
      transactionSent: false,
      fundsMoved: false,
      target: cfg.escrowAddress,
      function: "settle(Payout,bytes)",
      gasEstimate: prepared.gasEstimate.toString(),
      estimatedGasCostWei: prepared.estimatedGasCost.toString(),
      simulationResult: prepared.simulation,
      payout: prepared.request.payout,
    };
  }

  async function settle(rawRequest) {
    if (!wallet) throw new Error("gg7_live_wallet_unavailable");
    if (getAddress(wallet.address) !== getAddress(EXISTING_RELAYER)) {
      throw new Error("gg7_wallet_relayer_mismatch");
    }

    const prepared = await prepare(rawRequest);
    const tx = await wallet.connect(provider).sendTransaction({
      to: cfg.escrowAddress,
      data: prepared.data,
      value: 0n,
      gasLimit: prepared.gasEstimate,
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("gg7_transaction_failed");

    const escrow = new Contract(cfg.escrowAddress, ESCROW_ABI, provider);
    const payoutStruct = {
      transferMaterialHash: prepared.request.payout.transferMaterialHash,
      recipient: prepared.request.payout.recipient,
      amount: prepared.request.payout.amount,
      validUntil: prepared.request.payout.validUntil,
    };
    const payoutId = await escrow.derivePayoutId(payoutStruct);
    const [paid, totalPaid] = await Promise.all([
      escrow.paidPayout(payoutId),
      escrow.totalPaid(),
    ]);
    if (!paid) throw new Error("gg7_post_settlement_paid_flag_missing");

    return {
      schema: "gcc.gg7_bounded_relay_result.v1",
      status: "SENT_VERIFIED",
      transactionSent: true,
      fundsMoved: true,
      transactionHash: tx.hash,
      blockNumber: receipt.blockNumber,
      target: cfg.escrowAddress,
      payoutId,
      totalPaidBaseUnits: BigInt(totalPaid).toString(),
      payout: prepared.request.payout,
    };
  }

  return {
    config: cfg,
    simulate,
    settle,
  };
}

module.exports = {
  CHAIN_ID,
  VERIFIED_GG6_ESCROW,
  VERIFIED_GCC,
  EXISTING_RELAYER,
  HUMAN_AUTHORITY,
  ESCROW_ABI,
  normalizeConfig,
  validateRelayRequest,
  verifyInfrastructure,
  createGg7RelayCore,
};
