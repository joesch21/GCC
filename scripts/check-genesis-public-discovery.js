const fs = require("fs");
const path = require("path");
const { keccak256, toUtf8Bytes } = require("ethers");

const DISCOVERY_URL =
  "https://www.goldcondor.info/.well-known/gcc-agent.json";
const TENDER_URL =
  "https://www.goldcondor.info/tenders/GCC-GENESIS-001.json";
const STATS_URL =
  "https://www.goldcondor.info/api/genesis-discovery-stats";

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

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "gcc-genesis-public-readiness/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`${url} did not return application/json`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const pinnedHash = fs
    .readFileSync(
      path.resolve(__dirname, "../tenders/GCC-GENESIS-001.keccak256"),
      "utf8"
    )
    .trim()
    .toLowerCase();

  const discovery = await fetchJson(DISCOVERY_URL);
  if (discovery.status !== "OPEN") {
    throw new Error("Discovery status is not OPEN");
  }
  if (!discovery.network || discovery.network.chain_id !== 56) {
    throw new Error("Discovery does not bind BSC mainnet chain 56");
  }

  const entry = (discovery.tenders || []).find(
    (item) => item.tender_id === "GCC-GENESIS-001"
  );
  if (!entry) {
    throw new Error("GCC-GENESIS-001 is not discoverable");
  }
  if (entry.status !== "OPEN") {
    throw new Error("GCC-GENESIS-001 is not OPEN");
  }
  if (entry.tender_url !== TENDER_URL) {
    throw new Error("Discovered tender URL is not canonical");
  }
  if (
    String(entry.tender_hash_keccak256 || "").toLowerCase() !== pinnedHash
  ) {
    throw new Error("Discovery tender hash differs from pinned tender hash");
  }

  const tender = await fetchJson(entry.tender_url);
  if (tender.tender_id !== "GCC-GENESIS-001") {
    throw new Error("Fetched tender ID mismatch");
  }
  if (!tender.network || tender.network.chain_id !== 56) {
    throw new Error("Fetched tender chain ID mismatch");
  }
  if (
    tender.task.discovery_url !== DISCOVERY_URL ||
    tender.task.tender_url !== TENDER_URL
  ) {
    throw new Error("Fetched tender public URLs are not canonical");
  }

  const actualHash = keccak256(toUtf8Bytes(canonical(tender))).toLowerCase();
  if (actualHash !== pinnedHash) {
    throw new Error(
      `Public tender hash mismatch: expected ${pinnedHash}, got ${actualHash}`
    );
  }

  const now = Date.now();
  const opensAt = Date.parse(discovery.opens_at);
  const closesAt = Date.parse(discovery.submission_closes_at);
  if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt)) {
    throw new Error("Discovery window timestamps are invalid");
  }
  if (now < opensAt || now >= closesAt) {
    throw new Error("Genesis I public submission window is not currently open");
  }

  const stats = await fetchJson(STATS_URL);
  if (!stats.ok || stats.experiment !== "GCC-GENESIS-001") {
    throw new Error("Genesis discovery stats endpoint is not healthy");
  }
  if (
    !stats.totals ||
    Number(stats.totals.internalProbe || 0) < 1
  ) {
    throw new Error(
      "Persistent Genesis discovery stats did not record the readiness probe"
    );
  }
  const privacy = stats.privacy || {};
  for (const key of [
    "storesIp",
    "storesWallet",
    "storesCookie",
    "storesReferrer",
    "storesRawUserAgent",
    "storesQueryString",
  ]) {
    if (privacy[key] !== false) {
      throw new Error("Genesis discovery stats privacy contract failed: " + key);
    }
  }

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        externallyDiscoverable: true,
        discoveryUrl: DISCOVERY_URL,
        tenderUrl: TENDER_URL,
        tenderHash: actualHash,
        chainId: 56,
        opensAt: discovery.opens_at,
        closesAt: discovery.submission_closes_at,
        settlementDeadline: discovery.settlement_deadline,
        persistentStats: {
          status: "PASS",
          url: STATS_URL,
          totalRequests: Number(stats.totals.all || 0),
          externalRequests: Number(stats.totals.external || 0),
          internalProbeRequests: Number(stats.totals.internalProbe || 0),
          firstSeenAt: stats.firstSeenAt || null,
          lastSeenAt: stats.lastSeenAt || null,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "FAIL",
      externallyDiscoverable: false,
      message: error.message || String(error),
    })
  );
  process.exitCode = 1;
});
