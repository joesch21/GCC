const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  TypedDataEncoder,
  getAddress,
  isAddress,
} = require("ethers");

const HOST = "127.0.0.1";
const PORT = Number(process.env.GG6_SIGN_UI_PORT || 4177);
const READINESS_FILE = path.resolve(
  process.env.GG6_READINESS_FILE || "/tmp/gg6-canary-readiness.json"
);

const CHAIN_ID = 56;
const ESCROW = getAddress("0xca458394e8c3137ce4984bdac6e615d08e2482f6");
const HUMAN_AUTHORITY = getAddress("0x0b36b0495c5e7899648d731d7b88d6ffd3915184");
const CANARY_RECIPIENT = getAddress("0x0c5c77f31cd27a4adbf15a690e99cc50437442de");
const CANARY_AMOUNT = "1000000000000000000";
const CANARY_TRANSFER_MATERIAL_HASH =
  "0x6a7c3bfaf1b6eea3c984285ac501f7cac79e7bfc426837c5ce075c2154705462";

const EXPECTED_TYPES = Object.freeze({
  Payout: Object.freeze([
    Object.freeze({ name: "transferMaterialHash", type: "bytes32" }),
    Object.freeze({ name: "recipient", type: "address" }),
    Object.freeze({ name: "amount", type: "uint256" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
  ]),
});

function sameAddress(a, b) {
  return getAddress(String(a).toLowerCase()) === getAddress(String(b).toLowerCase());
}

function requireHash(value, label) {
  const raw = String(value || "");
  if (!/^0x[a-fA-F0-9]{64}$/.test(raw)) throw new Error(label + " invalid");
  return raw.toLowerCase();
}

function readPackage() {
  if (!fs.existsSync(READINESS_FILE)) {
    throw new Error(
      "Readiness file not found. Generate it from Tower with npm run --silent mainnet:gg6-readiness > " +
      READINESS_FILE
    );
  }

  const report = JSON.parse(fs.readFileSync(READINESS_FILE, "utf8"));
  if (report?.schema !== "gcc.agent_grant_payout_readiness_report.v1") {
    throw new Error("Unexpected readiness report schema");
  }
  if (report.status !== "READY_FOR_HUMAN_AUTHORIZATION") {
    throw new Error("Readiness report is not READY_FOR_HUMAN_AUTHORIZATION");
  }
  if (!Array.isArray(report.payouts) || report.payouts.length !== 1) {
    throw new Error("Canary signer requires exactly one payout");
  }

  const item = report.payouts[0];
  const auth = item?.human_authorization;
  const payout = item?.payout;
  if (item?.status !== "READY_FOR_HUMAN_AUTHORIZATION") {
    throw new Error("Payout is not READY_FOR_HUMAN_AUTHORIZATION");
  }
  if (item?.network?.chain_id !== CHAIN_ID) throw new Error("Wrong chain");
  if (!sameAddress(item?.payout_escrow?.address, ESCROW)) throw new Error("Escrow mismatch");
  if (!sameAddress(item?.payout_escrow?.human_authority, HUMAN_AUTHORITY)) {
    throw new Error("Human authority mismatch");
  }
  if (String(item?.payout_escrow?.gcc_shortfall_base_units) !== "0") {
    throw new Error("GCC shortfall is non-zero");
  }
  if (String(item?.relayer_gas?.bnb_shortfall_wei) !== "0") {
    throw new Error("Relayer BNB shortfall is non-zero");
  }

  if (auth?.standard !== "EIP712" || auth?.primaryType !== "Payout") {
    throw new Error("Unexpected human authorization standard");
  }
  if (auth?.signature_required !== true || auth?.signature_present !== false) {
    throw new Error("Unexpected signature state");
  }

  const domain = auth.domain;
  if (
    domain?.name !== "GCC Grant Payout Escrow" ||
    domain?.version !== "1" ||
    Number(domain?.chainId) !== CHAIN_ID ||
    !sameAddress(domain?.verifyingContract, ESCROW)
  ) {
    throw new Error("EIP-712 domain mismatch");
  }

  if (JSON.stringify(auth.types) !== JSON.stringify(EXPECTED_TYPES)) {
    throw new Error("EIP-712 type definition mismatch");
  }

  const message = auth.message;
  const materialHash = requireHash(message?.transferMaterialHash, "transferMaterialHash");
  if (materialHash !== CANARY_TRANSFER_MATERIAL_HASH) {
    throw new Error("Canary transfer material hash mismatch");
  }
  if (!isAddress(message?.recipient) || !sameAddress(message.recipient, CANARY_RECIPIENT)) {
    throw new Error("Canary recipient mismatch");
  }
  if (String(message?.amount) !== CANARY_AMOUNT) {
    throw new Error("Canary amount mismatch");
  }
  if (String(payout?.amount_base_units) !== CANARY_AMOUNT) {
    throw new Error("Payout amount binding mismatch");
  }
  if (requireHash(payout?.transfer_material_hash, "payout transfer material hash") !== materialHash) {
    throw new Error("Payout material binding mismatch");
  }
  if (!sameAddress(payout?.recipient, CANARY_RECIPIENT)) {
    throw new Error("Payout recipient binding mismatch");
  }

  const validUntil = BigInt(String(message?.validUntil || "0"));
  const validUntilMs = Number(validUntil) * 1000;
  if (!Number.isSafeInteger(validUntilMs) || validUntilMs <= Date.now() + 60_000) {
    throw new Error("Readiness authorization expires too soon; generate a fresh report");
  }

  const digest = TypedDataEncoder.hash(
    domain,
    EXPECTED_TYPES,
    {
      transferMaterialHash: materialHash,
      recipient: CANARY_RECIPIENT,
      amount: BigInt(CANARY_AMOUNT),
      validUntil,
    }
  ).toLowerCase();

  if (digest !== requireHash(auth?.digest, "authorization digest")) {
    throw new Error("Authorization digest mismatch");
  }

  return Object.freeze({
    schema: "gcc.gg6_canary_human_signing_package.v1",
    mode: "SIGN_ONLY_NO_BROADCAST",
    chainId: CHAIN_ID,
    escrow: ESCROW,
    humanAuthority: HUMAN_AUTHORITY,
    recipient: CANARY_RECIPIENT,
    nominalAmountGcc: "1",
    amountBaseUnits: CANARY_AMOUNT,
    transferMaterialHash: materialHash,
    validUntil: validUntil.toString(),
    validUntilIso: new Date(validUntilMs).toISOString(),
    digest,
    domain,
    types: EXPECTED_TYPES,
    message: {
      transferMaterialHash: materialHash,
      recipient: CANARY_RECIPIENT,
      amount: CANARY_AMOUNT,
      validUntil: validUntil.toString(),
    },
    safety: {
      localOnly: true,
      privateKeyReceivedByServer: false,
      transactionBroadcastEnabled: false,
      arbitraryRecipientEnabled: false,
      arbitraryAmountEnabled: false,
      exactCanaryMaterialOnly: true,
    },
  });
}

const ethersPath = path.resolve(
  path.dirname(require.resolve("ethers")),
  "../dist/ethers.umd.min.js"
);
if (!fs.existsSync(ethersPath)) {
  throw new Error("Browser ethers bundle not found: " + ethersPath);
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
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
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none';",
  });
  res.end(PAGE);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname === "/") return html(res);
    if (url.pathname === "/api/package") {
      try {
        return json(res, readPackage());
      } catch (error) {
        return json(res, { status: "ERROR", error: error.message }, 409);
      }
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
  console.log(`GG-6 canary human signer: http://${HOST}:${PORT}`);
  console.log("Local-only. Wallet signs exact EIP-712 canary data; this server never receives the signature or private key.");
});

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GG-6 Canary Human Authorization</title>
<style>
body{font-family:system-ui,sans-serif;max-width:920px;margin:32px auto;padding:0 18px;background:#0f1115;color:#f3f4f6}
.card{border:1px solid #343a46;border-radius:12px;padding:18px;margin:14px 0;background:#171a21}
button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #4b5563;cursor:pointer;margin:4px 8px 4px 0}
button:disabled{opacity:.5;cursor:not-allowed}
pre{white-space:pre-wrap;word-break:break-word;background:#0b0d11;padding:12px;border-radius:8px}
.warn{color:#fde68a}.ok{color:#86efac}.bad{color:#fca5a5}
label{display:flex;gap:8px;align-items:flex-start;margin:12px 0}
</style>
</head>
<body>
<h1>GG-6 Canary Human Authorization</h1>
<p class="warn">LIVE BSC MAINNET AUTHORIZATION. This page signs exactly one 1 GCC canary payout. It cannot broadcast a transaction.</p>

<div class="card">
<h2>1. Exact signing package</h2>
<pre id="pkg">Loading…</pre>
</div>

<div class="card">
<h2>2. Human authority wallet</h2>
<button id="connect" disabled>Connect human-authority wallet</button>
<pre id="wallet">Not connected.</pre>
</div>

<div class="card">
<h2>3. Confirm exact canary</h2>
<label><input type="checkbox" id="confirm"> I confirm recipient, nominal 1 GCC amount, transfer-material hash, escrow, chain 56 and expiry shown above.</label>
<button id="sign" disabled>Sign exact EIP-712 canary</button>
<pre id="signLog">Waiting.</pre>
</div>

<div class="card">
<h2>Bounded relayer request</h2>
<p>This output contains the signature but no private key. Do not edit any field.</p>
<pre id="relay">Nothing signed yet.</pre>
</div>

<script src="/ethers.js"></script>
<script>
let pkg, provider, signer, account;
const el=id=>document.getElementById(id);
const show=(id,v)=>{el(id).textContent=typeof v==="string"?v:JSON.stringify(v,null,2)};
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();

async function load(){
  const response=await fetch("/api/package",{cache:"no-store"});
  const value=await response.json();
  if(!response.ok) throw new Error(value.error||"Could not load signing package");
  pkg=value;
  show("pkg",pkg);
  el("connect").disabled=false;
}

async function ensureBsc(){
  const current=await window.ethereum.request({method:"eth_chainId"});
  if(current!=="0x38"){
    await window.ethereum.request({
      method:"wallet_switchEthereumChain",
      params:[{chainId:"0x38"}],
    });
  }
}

async function connect(){
  if(!window.ethereum) throw new Error("No injected EVM wallet detected.");
  await ensureBsc();
  await window.ethereum.request({method:"eth_requestAccounts"});
  provider=new ethers.BrowserProvider(window.ethereum);
  const candidateSigner=await provider.getSigner();
  const candidateAccount=await candidateSigner.getAddress();
  const network=await provider.getNetwork();
  if(network.chainId!==56n) throw new Error("Wallet is not on BSC mainnet.");
  if(!same(candidateAccount,pkg.humanAuthority)){
    throw new Error("Connected wallet is not the immutable GG-6 human authority.");
  }
  const code=await provider.getCode(candidateAccount);
  signer=candidateSigner;
  account=candidateAccount;
  show("wallet",{
    status:"PASS",
    address:account,
    chainId:56,
    role:"GG6_HUMAN_AUTHORITY",
    accountCodePresent:code!=="0x",
    note:code!=="0x"
      ?"Authority has on-chain code. Local ECDSA recovery is not sufficient proof of contract acceptance; bounded relayer dry-run is required."
      :"Authority has no on-chain code. Bounded relayer dry-run is still required before broadcast."
  });
  updateSign();
}

function updateSign(){
  el("sign").disabled=!(pkg&&signer&&el("confirm").checked);
}

async function signExact(){
  if(!pkg||!signer) throw new Error("Connect the human authority wallet first.");
  if(Date.now()+60000>=Date.parse(pkg.validUntilIso)){
    throw new Error("Authorization expires too soon. Generate a fresh readiness report.");
  }

  const currentAccount=await signer.getAddress();
  if(!same(currentAccount,pkg.humanAuthority)) throw new Error("Human authority wallet changed.");

  const signature=await signer.signTypedData(
    pkg.domain,
    pkg.types,
    {
      transferMaterialHash:pkg.message.transferMaterialHash,
      recipient:pkg.message.recipient,
      amount:BigInt(pkg.message.amount),
      validUntil:BigInt(pkg.message.validUntil),
    }
  );

  const recovered=ethers.verifyTypedData(
    pkg.domain,
    pkg.types,
    {
      transferMaterialHash:pkg.message.transferMaterialHash,
      recipient:pkg.message.recipient,
      amount:BigInt(pkg.message.amount),
      validUntil:BigInt(pkg.message.validUntil),
    },
    signature
  );
  if(!same(recovered,pkg.humanAuthority)) throw new Error("Local signature recovery does not match human authority.");

  const digest=ethers.TypedDataEncoder.hash(
    pkg.domain,
    pkg.types,
    {
      transferMaterialHash:pkg.message.transferMaterialHash,
      recipient:pkg.message.recipient,
      amount:BigInt(pkg.message.amount),
      validUntil:BigInt(pkg.message.validUntil),
    }
  );
  if(digest.toLowerCase()!==pkg.digest.toLowerCase()) throw new Error("Digest changed before signing.");

  const request={
    payout:{
      transferMaterialHash:pkg.message.transferMaterialHash,
      recipient:pkg.message.recipient,
      amount:pkg.message.amount,
      validUntil:pkg.message.validUntil,
    },
    humanAuthorization:signature,
  };

  show("signLog",{
    status:"SIGNATURE_RECOVERED_LOCALLY",
    signer:recovered,
    digest,
    transactionSent:false,
    validUntil:pkg.validUntilIso,
  });
  show("relay",request);
  el("sign").disabled=true;
  el("confirm").disabled=true;
}

el("connect").onclick=()=>connect().catch(e=>show("wallet","ERROR: "+e.message));
el("confirm").onchange=updateSign;
el("sign").onclick=()=>signExact().catch(e=>show("signLog","ERROR: "+e.message));
load().catch(e=>show("pkg","ERROR: "+e.message));
</script>
</body>
</html>`;
