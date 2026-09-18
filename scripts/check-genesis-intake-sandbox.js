const fs = require("fs");
const http = require("http");
const path = require("path");

const {
  verifyNetworkedAndOfflineRuns,
} = require("../src/genesisIntake/sandbox");

const fixturePath = path.join(
  __dirname,
  "..",
  "fixtures",
  "genesis-synthetic-client.mjs"
);

async function main() {
  const bytes = fs.readFileSync(fixturePath);
  const tender = {
    tender_id: "GCC-GENESIS-001",
    network: { chain_id: 56 },
    economics: {
      total_budget_gcc: "100",
      reward_per_valid_submission_gcc: "10",
    },
    task: { task_id: "gcc-discovery-client" },
  };

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/gcc-agent.json") {
      const port = server.address().port;
      res.end(
        JSON.stringify({
          tenders: [
            {
              tender_id: "GCC-GENESIS-001",
              tender_url:
                "http://host.docker.internal:" +
                port +
                "/tenders/GCC-GENESIS-001.json",
            },
          ],
        })
      );
      return;
    }
    if (req.url === "/tenders/GCC-GENESIS-001.json") {
      res.end(JSON.stringify(tender));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });

  try {
    const port = server.address().port;
    const result = verifyNetworkedAndOfflineRuns({
      bytes,
      deliverableUrl:
        "https://example.invalid/genesis-synthetic-client.mjs",
      runtime: "node:22",
      runCommand: "node genesis-synthetic-client.mjs",
      discoveryOverride:
        "http://host.docker.internal:" +
        port +
        "/.well-known/gcc-agent.json",
    });

    console.log(
      JSON.stringify(
        {
          status: "PASS",
          networkedStatus: result.networked.status,
          networkDisabledStatus: result.offline.status,
          output: result.networkedOutput,
        },
        null,
        2
      )
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
