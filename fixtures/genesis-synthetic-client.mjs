const canonicalDiscoveryUrl =
  "https://www.goldcondor.info/.well-known/gcc-agent.json";
const discoveryUrl =
  process.env.GCC_DISCOVERY_URL || canonicalDiscoveryUrl;

async function fetchJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(label + " returned HTTP " + response.status);
  }
  return response.json();
}

const discovery = await fetchJson(discoveryUrl, "discovery");
const entry = (discovery.tenders || []).find(
  (item) => item.tender_id === "GCC-GENESIS-001"
);
if (!entry || !entry.tender_url) {
  throw new Error("GCC-GENESIS-001 not discovered");
}

const tender = await fetchJson(entry.tender_url, "tender");
if (tender.tender_id !== "GCC-GENESIS-001") {
  throw new Error("wrong tender_id");
}
if (!tender.network || tender.network.chain_id !== 56) {
  throw new Error("wrong chain_id");
}

console.log(
  JSON.stringify({
    tender_id: tender.tender_id,
    chain_id: tender.network.chain_id,
    total_budget_gcc: String(tender.economics.total_budget_gcc),
    reward_per_valid_submission_gcc: String(
      tender.economics.reward_per_valid_submission_gcc
    ),
    task_id: tender.task.task_id,
    status: "PASS",
  })
);
