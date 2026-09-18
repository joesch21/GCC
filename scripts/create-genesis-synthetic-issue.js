const fs = require("fs");
const path = require("path");
const { Wallet, keccak256 } = require("ethers");

const {
  EXPECTED_OUTPUT,
  recipientBindingChallenge,
} = require("../src/genesisIntake/submission");
const {
  postIssueComment,
  resolveToken,
} = require("../src/genesisIntake/github");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATH = path.join(
  ROOT,
  "fixtures",
  "genesis-synthetic-client.mjs"
);
const DELIVERABLE_URL =
  "https://raw.githubusercontent.com/joesch21/GCC/main/fixtures/genesis-synthetic-client.mjs";

async function createIssue(body) {
  const token = resolveToken();
  if (!token) {
    throw new Error(
      "GitHub authentication is required. Run gh auth login or provide GH_TOKEN/GITHUB_TOKEN."
    );
  }

  const response = await fetch(
    "https://api.github.com/repos/joesch21/GCC/issues",
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": "gcc-genesis-intake/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: "[GCC-GENESIS-001] synthetic intake dry-run canary",
        body,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      "GitHub issue creation failed with HTTP " + response.status
    );
  }
  return response.json();
}

async function main() {
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const deliverableHash = keccak256(bytes).toLowerCase();
  const wallet = Wallet.createRandom();

  const fields = {
    submission_id:
      "synthetic-intake-" + new Date().toISOString().replace(/[^0-9]/g, ""),
    agent_id: "gcc-genesis-synthetic-canary",
    recipient_address: wallet.address,
    deliverable_url: DELIVERABLE_URL,
    deliverable_hash: deliverableHash,
    runtime: "node:22",
    run_command: "node genesis-synthetic-client.mjs",
    observed_output: JSON.stringify(EXPECTED_OUTPUT),
    synthetic_test: "true",
  };

  const challenge = recipientBindingChallenge(fields);
  fields.recipient_signature = await wallet.signMessage(challenge);

  const body = Object.entries(fields)
    .map(([key, value]) => key + ": " + value)
    .join("\n");

  const issue = await createIssue(body);

  console.log(
    JSON.stringify(
      {
        status: "CREATED",
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        synthetic: true,
        recipientAddress: wallet.address,
        deliverableHash,
        privateKeyStored: false,
        transactionSent: false,
        nextCommand:
          "npm run mainnet:intake:dry-run -- " +
          issue.number +
          " --synthetic",
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
