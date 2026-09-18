const { Contract, keccak256, toUtf8Bytes } = require("ethers");
const { REWARD_CLASS_HASHES } = require("../genesisVerifierB/configuration");

const DISCOVERY_URL =
  "https://www.goldcondor.info/.well-known/gcc-agent.json";
const TENDER_URL =
  "https://www.goldcondor.info/tenders/GCC-GENESIS-001.json";

const ESCROW_ABI = [
  "function rewardRule(bytes32) view returns (uint256,uint32,uint32)",
  "function escrowBalance() view returns (uint256)",
  "function fundingShortfall() view returns (uint256)",
  "function settlementDeadline() view returns (uint64)",
];

function readinessError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fetchJson(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "gcc-genesis-live-readiness/1.0",
      },
    });
    if (!response.ok) {
      throw readinessError(
        "GENESIS_LIVE_PUBLIC_FETCH_FAILED",
        url + " returned HTTP " + response.status
      );
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw readinessError(
        "GENESIS_LIVE_PUBLIC_FETCH_FAILED",
        url + " did not return application/json"
      );
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function checkGenesisLiveReadiness({
  provider,
  record,
  fetchImpl = fetch,
}) {
  const [network, latestBlock, discovery] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock("latest"),
    fetchJson(DISCOVERY_URL, fetchImpl),
  ]);

  if (network.chainId !== 56n || record.network.chainId !== 56) {
    throw readinessError(
      "GENESIS_LIVE_WRONG_CHAIN",
      "Genesis live intake requires BSC mainnet chain 56"
    );
  }
  if (!latestBlock) {
    throw readinessError(
      "GENESIS_LIVE_BLOCK_UNAVAILABLE",
      "Could not read latest BSC block"
    );
  }
  if (
    discovery.status !== "OPEN" ||
    !discovery.network ||
    discovery.network.chain_id !== 56
  ) {
    throw readinessError(
      "GENESIS_LIVE_DISCOVERY_NOT_OPEN",
      "Public Genesis discovery is not OPEN on BSC mainnet"
    );
  }

  const entry = (discovery.tenders || []).find(
    (item) => item.tender_id === "GCC-GENESIS-001"
  );
  if (!entry || entry.status !== "OPEN" || entry.tender_url !== TENDER_URL) {
    throw readinessError(
      "GENESIS_LIVE_TENDER_NOT_OPEN",
      "GCC-GENESIS-001 is not openly discoverable at the canonical tender URL"
    );
  }
  if (
    String(entry.tender_hash_keccak256 || "").toLowerCase() !==
    String(record.hashes.tender).toLowerCase()
  ) {
    throw readinessError(
      "GENESIS_LIVE_TENDER_HASH_MISMATCH",
      "Public discovery tender hash differs from the deployed Genesis tender hash"
    );
  }

  const tender = await fetchJson(entry.tender_url, fetchImpl);
  const publicTenderHash = keccak256(
    toUtf8Bytes(canonical(tender))
  ).toLowerCase();
  if (publicTenderHash !== String(record.hashes.tender).toLowerCase()) {
    throw readinessError(
      "GENESIS_LIVE_TENDER_HASH_MISMATCH",
      "Public tender bytes do not match the deployed Genesis tender hash"
    );
  }
  if (
    tender.tender_id !== "GCC-GENESIS-001" ||
    !tender.network ||
    tender.network.chain_id !== 56 ||
    tender.task.discovery_url !== DISCOVERY_URL ||
    tender.task.tender_url !== TENDER_URL
  ) {
    throw readinessError(
      "GENESIS_LIVE_TENDER_INVALID",
      "Public tender does not match the frozen Genesis I discovery contract"
    );
  }

  const opensAt = Date.parse(discovery.opens_at);
  const closesAt = Date.parse(discovery.submission_closes_at);
  if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt)) {
    throw readinessError(
      "GENESIS_LIVE_WINDOW_INVALID",
      "Public Genesis submission window is malformed"
    );
  }
  const chainNowMs = Number(latestBlock.timestamp) * 1000;
  if (chainNowMs < opensAt || chainNowMs >= closesAt) {
    throw readinessError(
      "GENESIS_LIVE_WINDOW_CLOSED",
      "Genesis I public submission window is not currently open"
    );
  }

  const escrow = new Contract(record.escrow.address, ESCROW_ABI, provider);
  const [rule, balance, shortfall, deadline, relayerBalance] =
    await Promise.all([
      escrow.rewardRule(REWARD_CLASS_HASHES.QUALIFIED_PROPOSAL),
      escrow.escrowBalance(),
      escrow.fundingShortfall(),
      escrow.settlementDeadline(),
      provider.getBalance(record.relayer.address),
    ]);

  if (BigInt(deadline) !== BigInt(record.escrow.settlementDeadlineUnix)) {
    throw readinessError(
      "GENESIS_LIVE_DEADLINE_MISMATCH",
      "Live escrow settlement deadline differs from the deployment record"
    );
  }
  if (BigInt(latestBlock.timestamp) > BigInt(deadline)) {
    throw readinessError(
      "GENESIS_LIVE_SETTLEMENT_CLOSED",
      "Live escrow settlement deadline has passed"
    );
  }
  if (shortfall !== 0n) {
    throw readinessError(
      "GENESIS_LIVE_ESCROW_SHORTFALL",
      "Genesis escrow reports a funding shortfall"
    );
  }
  if (rule[0] <= 0n || rule[1] === 0n || rule[2] >= rule[1]) {
    throw readinessError(
      "GENESIS_LIVE_REWARD_EXHAUSTED",
      "QUALIFIED_PROPOSAL reward class is disabled or exhausted"
    );
  }
  if (balance < rule[0]) {
    throw readinessError(
      "GENESIS_LIVE_ESCROW_UNFUNDED",
      "Genesis escrow cannot fund the next 10 GCC award"
    );
  }
  if (relayerBalance <= 0n) {
    throw readinessError(
      "GENESIS_LIVE_RELAYER_BNB_EMPTY",
      "Genesis settlement relayer has no BNB for gas"
    );
  }

  return Object.freeze({
    status: "PASS",
    chainId: 56,
    chainTimestamp: Number(latestBlock.timestamp),
    discoveryUrl: DISCOVERY_URL,
    tenderUrl: TENDER_URL,
    tenderHash: publicTenderHash,
    opensAt: discovery.opens_at,
    closesAt: discovery.submission_closes_at,
    settlementDeadline: deadline.toString(),
    escrow: record.escrow.address,
    escrowBalanceRaw: balance.toString(),
    fundingShortfallRaw: shortfall.toString(),
    rewardAmountRaw: rule[0].toString(),
    maxAwards: rule[1].toString(),
    paidAwards: rule[2].toString(),
    remainingAwards: (rule[1] - rule[2]).toString(),
    relayer: record.relayer.address,
    relayerBnbBalanceWei: relayerBalance.toString(),
  });
}

module.exports = {
  DISCOVERY_URL,
  TENDER_URL,
  checkGenesisLiveReadiness,
};
