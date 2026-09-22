const fs = require("fs");
const http = require("http");
const path = require("path");
const { getAddress } = require("ethers");

const HOST = "127.0.0.1";
const PORT = Number(process.env.GG6_DEPLOY_UI_PORT || 4176);
const ROOT = path.resolve(__dirname, "..");

const GCC_TOKEN = getAddress("0x092aC429b9c3450c9909433eB0662c3b7c13cF9A");
const EXISTING_RELAYER = getAddress("0x381c2939c943C52D9260B0c635d2FD7B17FB1C21");
const GENESIS_ESCROW = getAddress("0x8e834961EeC8F1a7048964B28E8156A211993E12");
const GENESIS_AUTHORITY = getAddress("0x00E462098E41980C81B0ccB45F5fAb7c81F13FDb");

function readArtifact(relative) {
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
  return { abi: artifact.abi, bytecode: artifact.bytecode };
}

const escrowArtifact = readArtifact(
  "artifacts/contracts/GrantPayoutEscrow.sol/GrantPayoutEscrow.json"
);

const ethersPath = path.resolve(
  path.dirname(require.resolve("ethers")),
  "../dist/ethers.umd.min.js"
);
if (!fs.existsSync(ethersPath)) {
  throw new Error(`Browser ethers bundle not found: ${ethersPath}`);
}

const plan = Object.freeze({
  network: { name: "BNB Smart Chain Mainnet", chainId: 56 },
  gccToken: GCC_TOKEN,
  existingRelayer: EXISTING_RELAYER,
  forbiddenGenesisEscrow: GENESIS_ESCROW,
  forbiddenGenesisVerifierAuthority: GENESIS_AUTHORITY,
  humanAuthority: "REQUIRED_SINGLE_CONDOR_AUTHORITY_ADDRESS",
  contract: "contracts/GrantPayoutEscrow.sol:GrantPayoutEscrow",
  funding: {
    gcc: "Human funds GCC to the newly deployed GrantPayoutEscrow only after verification.",
    bnb: `Human funds BNB to existing relayer ${EXISTING_RELAYER} when Tower reports a gas shortfall.`,
  },
});

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
    if (url.pathname === "/api/artifact") return json(res, escrowArtifact);
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
  console.log(`GG-6 mainnet deployer: http://${HOST}:${PORT}`);
  console.log("Local-only. An injected wallet signs deployment; this server never receives a private key.");
});

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GG-6 GrantPayoutEscrow — BSC Mainnet</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 18px;background:#0f1115;color:#f3f4f6}
.card{border:1px solid #343a46;border-radius:12px;padding:18px;margin:14px 0;background:#171a21}
button,input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #4b5563}
button{cursor:pointer;margin:4px 8px 4px 0}
input{width:min(620px,95%);background:#0b0d11;color:#fff}
pre{white-space:pre-wrap;word-break:break-word;background:#0b0d11;padding:12px;border-radius:8px}
.warn{color:#fde68a}.ok{color:#86efac}.bad{color:#fca5a5}
label{display:block;margin:10px 0 5px}
</style>
</head>
<body>
<h1>GG-6 GrantPayoutEscrow — BSC Mainnet</h1>
<p class="warn">LIVE BSC MAINNET. Deployment uses real BNB. This page never receives your private key.</p>

<div class="card">
<h2>1. Frozen bindings</h2>
<pre id="plan">Loading…</pre>
</div>

<div class="card">
<h2>2. Deployment wallet</h2>
<button id="connect">Connect injected wallet</button>
<pre id="wallet">Not connected.</pre>
</div>

<div class="card">
<h2>3. Human authority</h2>
<p>Enter the single existing Condor authority wallet address. Do not use the Genesis verifier authority, Genesis escrow, GCC token, or relayer address.</p>
<label>Condor human authority address</label>
<input id="authority" placeholder="0x...">
<button id="validate" disabled>Validate + Estimate</button>
<pre id="validation">Waiting.</pre>
</div>

<div class="card">
<h2>4. Deploy</h2>
<button id="deploy" disabled>Deploy GrantPayoutEscrow</button>
<pre id="deployLog">Waiting.</pre>
</div>

<div class="card">
<h2>Deployment report</h2>
<pre id="report">Nothing deployed yet.</pre>
<p class="warn">Do not fund the contract until source verification and immutable binding checks are complete.</p>
</div>

<script src="/ethers.js"></script>
<script>
let plan, artifact, provider, signer, account, validated = null;
const el = id => document.getElementById(id);
const show = (id,v) => { el(id).textContent = typeof v === "string" ? v : JSON.stringify(v,null,2); };
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();

async function load(){
  [plan,artifact]=await Promise.all([
    fetch("/api/plan").then(r=>r.json()),
    fetch("/api/artifact").then(r=>r.json()),
  ]);
  show("plan",plan);
}

async function ensureBsc(){
  const chainId=await window.ethereum.request({method:"eth_chainId"});
  if(chainId!=="0x38"){
    try{
      await window.ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x38"}]});
    }catch(error){
      if(error.code!==4902) throw error;
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

async function connect(){
  if(!window.ethereum) throw new Error("No injected EVM wallet detected.");
  await ensureBsc();
  await window.ethereum.request({method:"eth_requestAccounts"});
  provider=new ethers.BrowserProvider(window.ethereum);
  signer=await provider.getSigner();
  account=await signer.getAddress();
  const network=await provider.getNetwork();
  if(network.chainId!==56n) throw new Error("Wallet is not on BSC mainnet.");
  const balance=await provider.getBalance(account);
  show("wallet",{address:account,chainId:56,bnb:ethers.formatEther(balance)});
  el("validate").disabled=false;
}

function authorityAddress(){
  const raw=el("authority").value.trim();
  if(!ethers.isAddress(raw)) throw new Error("Enter a valid Condor authority address.");
  const authority=ethers.getAddress(raw);
  for(const forbidden of [
    plan.gccToken,
    plan.existingRelayer,
    plan.forbiddenGenesisEscrow,
    plan.forbiddenGenesisVerifierAuthority
  ]){
    if(same(authority,forbidden)) throw new Error("That address is reserved infrastructure and cannot be the GG-6 human authority.");
  }
  return authority;
}

async function validate(){
  if(!provider||!signer) throw new Error("Connect the deployment wallet first.");
  const network=await provider.getNetwork();
  if(network.chainId!==56n) throw new Error("Wrong chain: expected BSC mainnet 56.");
  const [gccCode,relayerCode,balance]=await Promise.all([
    provider.getCode(plan.gccToken),
    provider.getCode(plan.existingRelayer),
    provider.getBalance(account),
  ]);
  if(!gccCode||gccCode==="0x") throw new Error("Canonical GCC address has no bytecode on chain 56.");
  if(relayerCode!=="0x") throw new Error("Existing relayer is unexpectedly a contract; stop and review.");
  const authority=authorityAddress();
  const factory=new ethers.ContractFactory(artifact.abi,artifact.bytecode,signer);
  const tx=await factory.getDeployTransaction(plan.gccToken,authority,plan.existingRelayer);
  const gas=await provider.estimateGas({...tx,from:account});
  const fee=await provider.getFeeData();
  const gasPrice=fee.gasPrice||fee.maxFeePerGas||0n;
  const estimatedCost=gas*gasPrice;
  if(balance<estimatedCost) throw new Error("Deployment wallet has insufficient BNB for estimated gas.");
  validated={authority,gas,gasPrice,estimatedCost};
  show("validation",{
    status:"PASS",
    chainId:56,
    gccToken:plan.gccToken,
    gccCodePresent:true,
    humanAuthority:authority,
    existingRelayer:plan.existingRelayer,
    existingRelayerIsEOA:true,
    gas:gas.toString(),
    gasPriceGwei:ethers.formatUnits(gasPrice,"gwei"),
    estimatedCostBnb:ethers.formatEther(estimatedCost),
    deploymentWalletBnb:ethers.formatEther(balance)
  });
  el("deploy").disabled=false;
}

async function deploy(){
  if(!validated) throw new Error("Validate the deployment first.");
  const authority=authorityAddress();
  if(!same(authority,validated.authority)) throw new Error("Authority address changed after validation.");
  const factory=new ethers.ContractFactory(artifact.abi,artifact.bytecode,signer);
  if(!confirm("Deploy GG-6 GrantPayoutEscrow on BSC mainnet now? Your wallet will ask for confirmation.")) return;
  const contract=await factory.deploy(plan.gccToken,authority,plan.existingRelayer);
  const tx=contract.deploymentTransaction();
  show("deployLog",{stage:"SUBMITTED",transactionHash:tx.hash});
  await contract.waitForDeployment();
  const address=await contract.getAddress();
  const [gcc,humanAuthority,relayer,escrowBalance,totalPaid,code]=await Promise.all([
    contract.gcc(),
    contract.humanAuthority(),
    contract.relayer(),
    contract.escrowBalance(),
    contract.totalPaid(),
    provider.getCode(address),
  ]);
  if(!same(gcc,plan.gccToken)) throw new Error("Post-deploy GCC binding mismatch.");
  if(!same(humanAuthority,authority)) throw new Error("Post-deploy human authority mismatch.");
  if(!same(relayer,plan.existingRelayer)) throw new Error("Post-deploy relayer mismatch.");
  if(escrowBalance!==0n||totalPaid!==0n) throw new Error("Fresh escrow is not empty.");
  if(!code||code==="0x") throw new Error("No deployed bytecode found.");

  const report={
    schema:"gcc.gg6_grant_payout_deployment.v1",
    network:{name:"BNB Smart Chain Mainnet",chainId:56},
    gccToken:gcc,
    humanAuthority,
    relayer,
    escrow:{
      address,
      transactionHash:tx.hash,
      initialGccBalanceRaw:escrowBalance.toString(),
      initialTotalPaidRaw:totalPaid.toString(),
      localPostDeployVerification:"PASS",
      bscscanSourceVerification:"PENDING"
    },
    sourceCommit:"a3574b55b7a5594de85c43ac45e1da9129b86753",
    deployedAt:new Date().toISOString()
  };
  show("deployLog",{stage:"ONCHAIN_BINDINGS_VERIFIED",...report});
  show("report",report);
  el("deploy").disabled=true;
}

el("connect").onclick=()=>connect().catch(e=>show("wallet","ERROR: "+e.message));
el("validate").onclick=()=>validate().catch(e=>show("validation","ERROR: "+e.message));
el("deploy").onclick=()=>deploy().catch(e=>show("deployLog","ERROR: "+e.message));
load().catch(e=>show("plan","ERROR: "+e.message));
</script>
</body>
</html>`;
