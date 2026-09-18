const fs = require("fs");
const http = require("http");
const path = require("path");
const { getAddress } = require("ethers");

const HOST = "127.0.0.1";
const PORT = Number(process.env.GENESIS_DEPLOY_UI_PORT || 4174);

const ROOT = path.resolve(__dirname, "..");
const GCC_TOKEN = "0x092ac429b9c3450c9909433eb0662c3b7c13cf9a";
const VERIFIER_A = "0x282C3a391e767c87E3907d9fCd94FA6107C4123b";
const VERIFIER_B = "0x2d6D19751d48bD8e6008eE04E70f64AD17f759A6";
const VERIFIER_C = "0xd5422b7493e65c5b5cbfd70028df2D2ED8A39CDE";

function readText(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8").trim();
}

function readArtifact(relative) {
  const artifact = JSON.parse(
    fs.readFileSync(path.join(ROOT, relative), "utf8")
  );
  return { abi: artifact.abi, bytecode: artifact.bytecode };
}

const plan = Object.freeze({
  network: { name: "BNB Smart Chain Mainnet", chainId: 56 },
  gccToken: getAddress(GCC_TOKEN),
  tenderHash: readText("tenders/GCC-GENESIS-001.keccak256"),
  policyHash: readText("policies/GCC-GENESIS-001.verifier-policy.keccak256"),
  verifiers: {
    A: getAddress(VERIFIER_A),
    B: getAddress(VERIFIER_B),
    C: getAddress(VERIFIER_C),
    threshold: 2,
  },
  rewards: {
    qualifiedRewardRaw: "10000000000000000000",
    maxQualifiedAwards: 10,
    finalistRewardRaw: "0",
    maxFinalistAwards: 0,
    selectedComponentRewardRaw: "0",
    maxSelectedComponentAwards: 0,
    rewardCapRaw: "100000000000000000000",
  },
});

const authorityArtifact = readArtifact(
  "artifacts/contracts/GenesisVerifierAuthority.sol/GenesisVerifierAuthority.json"
);
const escrowArtifact = readArtifact(
  "artifacts/contracts/GenesisDeliverableEscrow.sol/GenesisDeliverableEscrow.json"
);
const ethersPath = path.resolve(
  path.dirname(require.resolve("ethers")),
  "../dist/ethers.min.js"
);

function json(res, value) {
  const body = JSON.stringify(value);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function html(res) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://bsc-dataseed.binance.org https://*.binance.org; frame-ancestors 'none';",
  });
  res.end(PAGE);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname === "/") return html(res);
    if (url.pathname === "/api/plan") return json(res, plan);
    if (url.pathname === "/api/authority-artifact") {
      return json(res, authorityArtifact);
    }
    if (url.pathname === "/api/escrow-artifact") {
      return json(res, escrowArtifact);
    }
    if (url.pathname === "/ethers.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      return fs.createReadStream(ethersPath).pipe(res);
    }
    res.writeHead(404).end("Not found");
  } catch (error) {
    res.writeHead(500).end(error.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Genesis mainnet deployer: http://${HOST}:${PORT}`);
  console.log("Local-only. MetaMask signs deployments; this server never receives a private key.");
});

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GCC Genesis I Mainnet Deployer</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 18px;background:#0f1115;color:#f3f4f6}
.card{border:1px solid #343a46;border-radius:12px;padding:18px;margin:14px 0;background:#171a21}
button,input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #4b5563}
button{cursor:pointer;margin:4px 8px 4px 0}
pre{white-space:pre-wrap;word-break:break-word;background:#0b0d11;padding:12px;border-radius:8px}
.ok{color:#86efac}.warn{color:#fde68a}.bad{color:#fca5a5}
label{display:block;margin:10px 0 5px}
input{width:min(440px,95%);background:#0b0d11;color:#fff}
</style>
</head>
<body>
<h1>GCC Genesis I — BSC Mainnet</h1>
<p class="warn">LIVE MAINNET. MetaMask confirmations use real BNB. This page does not receive your private key.</p>
<div class="card">
<h2>1. Bindings</h2>
<pre id="plan">Loading…</pre>
</div>
<div class="card">
<h2>2. MetaMask</h2>
<button id="connect">Connect MetaMask</button>
<pre id="wallet">Not connected.</pre>
</div>
<div class="card">
<h2>3. Deploy Verifier Authority</h2>
<button id="deployAuthority" disabled>Estimate + Deploy Authority</button>
<label>Authority address</label>
<input id="authorityAddress" placeholder="filled after deployment, or paste an already verified authority">
<pre id="authorityLog">Waiting.</pre>
</div>
<div class="card">
<h2>4. Deploy Escrow</h2>
<label>Planned public opening time</label>
<input id="opening" type="datetime-local">
<p>The escrow settlement deadline is computed as opening + 21 days (14-day submission window + 7-day settlement grace).</p>
<button id="deployEscrow" disabled>Estimate + Deploy Escrow</button>
<pre id="escrowLog">Waiting.</pre>
</div>
<div class="card">
<h2>Deployment report</h2>
<pre id="report">Nothing deployed yet.</pre>
<p class="warn">Do not fund the escrow from this page. Funding remains a separate verified step after both deployments are checked.</p>
</div>
<script src="/ethers.js"></script>
<script>
let plan, provider, signer, account;
let authorityArtifact, escrowArtifact;
const report = {};

const el = id => document.getElementById(id);
const show = (id, value) => { el(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); };
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();

function localInputValue(date) {
  const pad = n => String(n).padStart(2,"0");
  return date.getFullYear()+"-"+pad(date.getMonth()+1)+"-"+pad(date.getDate())+"T"+pad(date.getHours())+":"+pad(date.getMinutes());
}

async function load() {
  [plan, authorityArtifact, escrowArtifact] = await Promise.all([
    fetch("/api/plan").then(r=>r.json()),
    fetch("/api/authority-artifact").then(r=>r.json()),
    fetch("/api/escrow-artifact").then(r=>r.json()),
  ]);
  show("plan", plan);
  const opening = new Date(Date.now() + 60*60*1000);
  opening.setSeconds(0,0);
  el("opening").value = localInputValue(opening);
}

async function ensureBsc() {
  const chainId = await window.ethereum.request({method:"eth_chainId"});
  if (chainId !== "0x38") {
    try {
      await window.ethereum.request({
        method:"wallet_switchEthereumChain",
        params:[{chainId:"0x38"}]
      });
    } catch (error) {
      if (error.code !== 4902) throw error;
      await window.ethereum.request({
        method:"wallet_addEthereumChain",
        params:[{
          chainId:"0x38",
          chainName:"BNB Smart Chain Mainnet",
          nativeCurrency:{name:"BNB",symbol:"BNB",decimals:18},
          rpcUrls:["https://bsc-dataseed.binance.org/"],
          blockExplorerUrls:["https://bscscan.com/"]
        }]
      });
    }
  }
}

async function connect() {
  if (!window.ethereum) throw new Error("MetaMask was not detected.");
  await ensureBsc();
  await window.ethereum.request({method:"eth_requestAccounts"});
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  account = await signer.getAddress();
  const network = await provider.getNetwork();
  if (network.chainId !== 56n) throw new Error("MetaMask is not on BSC mainnet.");
  const balance = await provider.getBalance(account);
  show("wallet", {
    address: account,
    chainId: network.chainId.toString(),
    bnb: ethers.formatEther(balance)
  });
  el("deployAuthority").disabled = false;
  el("deployEscrow").disabled = false;
}

async function estimate(factory, args) {
  const tx = await factory.getDeployTransaction(...args);
  const gas = await provider.estimateGas({...tx, from: account});
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice || 0n;
  return {
    gas,
    gasPrice,
    estimatedCost: gas * gasPrice
  };
}

async function deployAuthority() {
  const args = [
    plan.policyHash,
    plan.verifiers.A,
    plan.verifiers.B,
    plan.verifiers.C
  ];
  const factory = new ethers.ContractFactory(authorityArtifact.abi, authorityArtifact.bytecode, signer);
  const est = await estimate(factory, args);
  const balance = await provider.getBalance(account);
  show("authorityLog", {
    stage:"ESTIMATED",
    gas:est.gas.toString(),
    gasPriceGwei:ethers.formatUnits(est.gasPrice,"gwei"),
    estimatedCostBnb:ethers.formatEther(est.estimatedCost),
    walletBnb:ethers.formatEther(balance)
  });
  if (balance < est.estimatedCost) {
    throw new Error("Insufficient BNB for estimated authority deployment gas.");
  }
  if (!confirm("Deploy GenesisVerifierAuthority on BSC mainnet now? MetaMask will ask for confirmation.")) return;
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  show("authorityLog", {stage:"SUBMITTED",transactionHash:tx.hash});
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const [policyHash, verifiers, threshold] = await Promise.all([
    contract.policyHash(), contract.verifiers(), contract.THRESHOLD()
  ]);
  if (policyHash.toLowerCase() !== plan.policyHash.toLowerCase()) throw new Error("Authority policy hash verification failed.");
  if (!same(verifiers[0],plan.verifiers.A)||!same(verifiers[1],plan.verifiers.B)||!same(verifiers[2],plan.verifiers.C)) {
    throw new Error("Authority verifier-set verification failed.");
  }
  if (threshold !== 2n) throw new Error("Authority threshold verification failed.");
  el("authorityAddress").value = address;
  report.authority = {address,transactionHash:tx.hash,policyHash,verifiers,threshold:threshold.toString()};
  show("authorityLog",{stage:"VERIFIED",...report.authority});
  show("report",report);
}

async function deployEscrow() {
  const authority = el("authorityAddress").value.trim();
  if (!ethers.isAddress(authority)) throw new Error("Enter the deployed authority address first.");
  const opening = new Date(el("opening").value);
  if (!Number.isFinite(opening.getTime())) throw new Error("Choose a valid opening time.");
  const openingTimestamp = Math.floor(opening.getTime()/1000);
  if (openingTimestamp <= Math.floor(Date.now()/1000)) throw new Error("Opening time must still be in the future.");
  const deadline = BigInt(openingTimestamp + 21*24*60*60);
  const args = [
    plan.gccToken,
    authority,
    plan.tenderHash,
    deadline,
    BigInt(plan.rewards.qualifiedRewardRaw),
    plan.rewards.maxQualifiedAwards,
    BigInt(plan.rewards.finalistRewardRaw),
    plan.rewards.maxFinalistAwards,
    BigInt(plan.rewards.selectedComponentRewardRaw),
    plan.rewards.maxSelectedComponentAwards
  ];
  const factory = new ethers.ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, signer);
  const est = await estimate(factory, args);
  const balance = await provider.getBalance(account);
  show("escrowLog",{
    stage:"ESTIMATED",
    plannedOpening:opening.toISOString(),
    settlementDeadline:deadline.toString(),
    settlementDeadlineIso:new Date(Number(deadline)*1000).toISOString(),
    gas:est.gas.toString(),
    gasPriceGwei:ethers.formatUnits(est.gasPrice,"gwei"),
    estimatedCostBnb:ethers.formatEther(est.estimatedCost),
    walletBnb:ethers.formatEther(balance)
  });
  if (balance < est.estimatedCost) throw new Error("Insufficient BNB for estimated escrow deployment gas.");
  if (!confirm("Deploy GenesisDeliverableEscrow on BSC mainnet now? MetaMask will ask for confirmation.")) return;
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  show("escrowLog",{stage:"SUBMITTED",transactionHash:tx.hash});
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const qualified = await contract.QUALIFIED_PROPOSAL();
  const [gcc, verifier, tenderHash, onchainDeadline, rewardCap, rule] = await Promise.all([
    contract.gcc(), contract.verifier(), contract.tenderHash(), contract.settlementDeadline(),
    contract.rewardCap(), contract.rewardRule(qualified)
  ]);
  if (!same(gcc,plan.gccToken)||!same(verifier,authority)) throw new Error("Escrow address binding verification failed.");
  if (tenderHash.toLowerCase()!==plan.tenderHash.toLowerCase()) throw new Error("Escrow tender hash verification failed.");
  if (onchainDeadline!==deadline) throw new Error("Escrow deadline verification failed.");
  if (rewardCap!==BigInt(plan.rewards.rewardCapRaw)) throw new Error("Escrow reward cap verification failed.");
  if (rule[0]!==BigInt(plan.rewards.qualifiedRewardRaw)||rule[1]!==10n||rule[2]!==0n) throw new Error("Escrow reward rule verification failed.");
  report.escrow = {
    address, transactionHash:tx.hash, gcc, verifier, tenderHash,
    plannedOpening:opening.toISOString(),
    settlementDeadline:deadline.toString(),
    settlementDeadlineIso:new Date(Number(deadline)*1000).toISOString(),
    rewardCapRaw:rewardCap.toString()
  };
  show("escrowLog",{stage:"VERIFIED",...report.escrow});
  show("report",report);
}

el("connect").onclick=()=>connect().catch(e=>show("wallet","ERROR: "+e.message));
el("deployAuthority").onclick=()=>deployAuthority().catch(e=>show("authorityLog","ERROR: "+e.message));
el("deployEscrow").onclick=()=>deployEscrow().catch(e=>show("escrowLog","ERROR: "+e.message));
load().catch(e=>show("plan","ERROR: "+e.message));
</script>
</body>
</html>`;
