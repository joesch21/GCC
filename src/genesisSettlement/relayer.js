const {
  AbiCoder,
  Contract,
  Interface,
  getAddress,
  parseEther,
} = require("ethers");

const AUTHORITY_ABI = [
  "function isValidSignature(bytes32,bytes) view returns (bytes4)",
];
const ESCROW_ABI = [
  "function awardDigest((bytes32 tenderHash,bytes32 awardClass,bytes32 deliverableHash,bytes32 assessmentHash,address recipient,uint64 validUntil)) view returns (bytes32)",
  "function deriveAwardId((bytes32 tenderHash,bytes32 awardClass,bytes32 deliverableHash,bytes32 assessmentHash,address recipient,uint64 validUntil)) pure returns (bytes32)",
  "function paidAward(bytes32) view returns (bool)",
  "function rewardRule(bytes32) view returns (uint256,uint32,uint32)",
  "function escrowBalance() view returns (uint256)",
  "function fundingShortfall() view returns (uint256)",
  "function settlementDeadline() view returns (uint64)",
  "function settle((bytes32 tenderHash,bytes32 awardClass,bytes32 deliverableHash,bytes32 assessmentHash,address recipient,uint64 validUntil),bytes) returns (bytes32,uint256)",
];

const SETTLE_INTERFACE = new Interface([
  "function settle((bytes32 tenderHash,bytes32 awardClass,bytes32 deliverableHash,bytes32 assessmentHash,address recipient,uint64 validUntil),bytes) returns (bytes32,uint256)",
]);

function settlementError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assembleAuthorization(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw settlementError(
      "GENESIS_RELAYER_AUTHORIZATION_INVALID",
      "At least two verifier signatures are required"
    );
  }
  const normalized = entries
    .map((entry) => ({
      signer: getAddress(entry.signer),
      signature: entry.signature,
    }))
    .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));

  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i - 1].signer === normalized[i].signer) {
      throw settlementError(
        "GENESIS_RELAYER_AUTHORIZATION_INVALID",
        "Duplicate verifier signer"
      );
    }
  }

  return AbiCoder.defaultAbiCoder().encode(
    ["address[]", "bytes[]"],
    [
      normalized.map((entry) => entry.signer),
      normalized.map((entry) => entry.signature),
    ]
  );
}

function assertMatchingVerifierResults(aResult, bResult) {
  if (!aResult || !bResult || !aResult.audit || !bResult.audit) {
    throw settlementError(
      "GENESIS_RELAYER_VERIFIER_RESULT_INVALID",
      "Verifier results are incomplete"
    );
  }
  if (aResult.audit.awardDigest !== bResult.audit.awardDigest) {
    throw settlementError(
      "GENESIS_RELAYER_DIGEST_MISMATCH",
      "Verifier A and B derived different award digests"
    );
  }
  if (aResult.audit.attestationDigest !== bResult.audit.attestationDigest) {
    throw settlementError(
      "GENESIS_RELAYER_DIGEST_MISMATCH",
      "Verifier A and B derived different attestation digests"
    );
  }
}

async function prepareSettlement({
  provider,
  record,
  request,
  verifierAResult,
  verifierBResult,
  relayerAddress,
}) {
  const network = await provider.getNetwork();
  if (network.chainId !== 56n || record.network.chainId !== 56) {
    throw settlementError(
      "GENESIS_RELAYER_WRONG_CHAIN",
      "Genesis relayer requires BSC mainnet chain 56"
    );
  }

  assertMatchingVerifierResults(verifierAResult, verifierBResult);

  const authorization = assembleAuthorization([
    { signer: record.verifiers.A, signature: verifierAResult.signature },
    { signer: record.verifiers.B, signature: verifierBResult.signature },
  ]);

  const authority = new Contract(
    record.authority.address,
    AUTHORITY_ABI,
    provider
  );
  const escrow = new Contract(record.escrow.address, ESCROW_ABI, provider);

  const onchainAwardDigest = await escrow.awardDigest(request.award);
  if (onchainAwardDigest !== verifierAResult.audit.awardDigest) {
    throw settlementError(
      "GENESIS_RELAYER_AWARD_DIGEST_MISMATCH",
      "Live escrow award digest differs from verifier digest"
    );
  }

  const magic = await authority.isValidSignature(
    onchainAwardDigest,
    authorization
  );
  if (magic !== "0x1626ba7e") {
    throw settlementError(
      "GENESIS_RELAYER_AUTHORITY_REJECTED",
      "Live verifier authority rejected the A+B authorization"
    );
  }

  const awardId = await escrow.deriveAwardId(request.award);
  const [
    alreadyPaid,
    rule,
    balance,
    shortfall,
    deadline,
    latestBlock,
  ] = await Promise.all([
    escrow.paidAward(awardId),
    escrow.rewardRule(request.award.awardClass),
    escrow.escrowBalance(),
    escrow.fundingShortfall(),
    escrow.settlementDeadline(),
    provider.getBlock("latest"),
  ]);

  if (!latestBlock) {
    throw settlementError(
      "GENESIS_RELAYER_BLOCK_UNAVAILABLE",
      "Could not read latest BSC block"
    );
  }
  if (alreadyPaid) {
    throw settlementError(
      "GENESIS_RELAYER_ALREADY_PAID",
      "This award has already been settled"
    );
  }
  if (rule[1] === 0n || rule[2] >= rule[1]) {
    throw settlementError(
      "GENESIS_RELAYER_REWARD_CLASS_EXHAUSTED",
      "Reward class is disabled or exhausted"
    );
  }

  const now = BigInt(latestBlock.timestamp);
  const validUntil = BigInt(request.award.validUntil);
  if (now > BigInt(deadline) || now > validUntil) {
    throw settlementError(
      "GENESIS_RELAYER_SETTLEMENT_CLOSED",
      "Settlement deadline or award validity has expired"
    );
  }

  const data = SETTLE_INTERFACE.encodeFunctionData("settle", [
    request.award,
    authorization,
  ]);
  const fundedForAward = balance >= rule[0];

  let simulation = {
    attempted: false,
    success: false,
    gasEstimate: null,
    reason: fundedForAward
      ? "NOT_ATTEMPTED"
      : "ESCROW_NOT_FUNDED_FOR_AWARD",
  };

  if (fundedForAward) {
    const from = relayerAddress
      ? getAddress(relayerAddress)
      : getAddress(record.verifiers.A);
    await provider.call({
      from,
      to: record.escrow.address,
      data,
      value: 0n,
    });
    const gasEstimate = await provider.estimateGas({
      from,
      to: record.escrow.address,
      data,
      value: 0n,
    });
    simulation = {
      attempted: true,
      success: true,
      gasEstimate: gasEstimate.toString(),
      reason: null,
    };
  }

  return Object.freeze({
    chainId: 56,
    authorityAccepted2Of3: true,
    awardDigest: onchainAwardDigest,
    attestationDigest: verifierAResult.audit.attestationDigest,
    awardId,
    authorization,
    settlement: Object.freeze({
      to: getAddress(record.escrow.address),
      data,
      value: "0",
      amountRaw: rule[0].toString(),
      maxAwards: rule[1].toString(),
      paidAwards: rule[2].toString(),
      escrowBalanceRaw: balance.toString(),
      fundingShortfallRaw: shortfall.toString(),
      fundedForAward,
      settlementDeadline: deadline.toString(),
      validUntil: validUntil.toString(),
      simulation,
    }),
  });
}

async function sendPreparedSettlement({
  wallet,
  provider,
  prepared,
  maxGasLimit = 1000000n,
  maxGasCostWei = parseEther("0.005"),
}) {
  if (!prepared.settlement.fundedForAward) {
    throw settlementError(
      "GENESIS_RELAYER_ESCROW_UNFUNDED",
      "Escrow is not funded for this award"
    );
  }
  if (!prepared.settlement.simulation.success) {
    throw settlementError(
      "GENESIS_RELAYER_SIMULATION_REQUIRED",
      "Successful settlement simulation is required before send"
    );
  }

  const relayer = wallet.connect(provider);
  const from = await relayer.getAddress();
  const estimated = await provider.estimateGas({
    from,
    to: prepared.settlement.to,
    data: prepared.settlement.data,
    value: 0n,
  });
  const gasLimit = (estimated * 120n + 99n) / 100n;
  if (gasLimit > BigInt(maxGasLimit)) {
    throw settlementError(
      "GENESIS_RELAYER_GAS_LIMIT_EXCEEDED",
      "Estimated settlement gas exceeds the configured relayer limit"
    );
  }

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  if (!gasPrice || gasPrice <= 0n) {
    throw settlementError(
      "GENESIS_RELAYER_GAS_PRICE_UNAVAILABLE",
      "Could not determine BSC gas price"
    );
  }
  const maximumCost = gasLimit * gasPrice;
  if (maximumCost > BigInt(maxGasCostWei)) {
    throw settlementError(
      "GENESIS_RELAYER_GAS_COST_EXCEEDED",
      "Settlement gas cost exceeds the configured relayer cost cap"
    );
  }

  const bnbBalance = await provider.getBalance(from);
  if (bnbBalance < maximumCost) {
    throw settlementError(
      "GENESIS_RELAYER_BNB_INSUFFICIENT",
      "Relayer BNB balance is below the bounded settlement gas requirement"
    );
  }

  const tx = await relayer.sendTransaction({
    to: prepared.settlement.to,
    data: prepared.settlement.data,
    value: 0n,
    gasLimit,
    gasPrice,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw settlementError(
      "GENESIS_RELAYER_TRANSACTION_FAILED",
      "Settlement transaction did not succeed"
    );
  }

  return Object.freeze({
    status: "SETTLED",
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    relayer: from,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: gasPrice.toString(),
  });
}

module.exports = {
  assembleAuthorization,
  prepareSettlement,
  sendPreparedSettlement,
};
