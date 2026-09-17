# GCC Genesis I — Mainnet Launch Preparation

## Scope

This is a **bounded 100 GCC nominal reward experiment**, not the permanent production architecture.

The experiment asks whether independent agents will discover a GCC-denominated task, complete it, submit it, and receive an on-chain reward without direct human commissioning.

## Verified GCC token binding

BNB Smart Chain mainnet, chain ID `56`.

GCC token:

`0x092ac429b9c3450c9909433eb0662c3b7c13cf9a`

Decimals: `18`.

The live read-only preflight currently reports:

- owner: zero address;
- reflection fee: `1%`;
- burn fee: `0%`;
- tax fee: `1%`;
- combined transfer deduction for ordinary non-exempt transfers: `2%`.

The verified token source makes fee exclusion and fee changes `onlyOwner`. Because the live owner is the zero address, Genesis must treat the current fee/exclusion state as fixed for this experiment rather than assume the new escrow can later be made fee-exempt.

Run:

```bash
npm run mainnet:inspect-gcc
```

before launch and again immediately before funding.

## What "10 GCC reward" means

The frozen escrow constructor amount remains **10 GCC nominal per award**.

For an ordinary sender/recipient pair that is not already fee-exempt, a nominal 10 GCC transfer currently produces a direct recipient transfer of:

`9.8 GCC`

with the remaining 2% handled by GCC's current 1% reflection and 1% tax mechanics. Reflection can also change holder balances separately, so the balance delta may not equal only the direct transfer event.

Genesis I therefore does **not** claim that every recipient's balance increases by exactly 10.000000 GCC. The experiment measures autonomous discovery and settlement, not fee-neutral token accounting.

## Genesis I verifier profile

Genesis I uses the immutable `GenesisVerifierAuthority` threshold of **2-of-3**.

- **Verifier A** — Tower/Condor local automated verifier domain. Tower and Condor remain one security slot because they share the same host boundary.
- **Verifier B** — the existing AWS KMS secp256k1 signer already proven end-to-end by the Genesis integration test.
- **Verifier C** — a dedicated contingency EOA created on a separate physical/mobile device.

Important current boundary: Condor's repository proves native BSC transaction signing exists but is production-disabled and does not yet prove an autonomous Genesis attestation signer. Verifier A must therefore be wired to the Genesis signing firewall before launch; merely naming a Condor address is not enough.

Verifier C cannot authorize a payment alone. The intended normal path is automated A+B once A's restricted signer is live.

## Agent payout and BNB gas

An agent does **not** need BNB to receive GCC.

The flow is:

1. the agent supplies a BSC-compatible recipient address;
2. two verifier authorities attest to an objectively passing award;
3. a relayer calls `GenesisDeliverableEscrow.settle(...)` and pays the BNB gas;
4. the escrow performs the nominal 10 GCC transfer to the agent address.

The recipient therefore pays no gas to receive GCC.

An ordinary EOA does need BNB later to send GCC, approve a DEX, swap, or call another BSC contract. Genesis I keeps the separate bounded gas bootstrap:

- only after a successful settlement;
- target/cap: `0.0002 BNB` per EOA recipient;
- maximum 10 recipients;
- maximum operational exposure: `0.002 BNB`;
- funded separately from the GCC escrow;
- no award authority;
- optional for smart-account/paymaster recipients.

## Frozen economic constructor values

`GenesisDeliverableEscrow` uses:

- qualified nominal reward: `10 GCC` = `10000000000000000000` raw units;
- maximum qualified awards: `10`;
- finalist reward / count: `0 / 0`;
- selected-component reward / count: `0 / 0`;
- nominal reward cap: `100 GCC` = `100000000000000000000` raw units;
- GCC token: the verified mainnet address above;
- tender hash: pinned in `tenders/GCC-GENESIS-001.keccak256`;
- verifier: the deployed `GenesisVerifierAuthority` address.

## Fee-aware escrow funding

A new escrow address cannot be newly fee-exempt after deployment because GCC ownership is renounced.

Therefore **do not blindly transfer 100 GCC from a normal wallet**. With the current 2% fee, that would directly credit only about 98 GCC and the escrow could not execute ten nominal 10 GCC awards.

For a non-exempt funding wallet, the minimum gross transfer that directly credits a 100 GCC nominal escrow balance under a 2% deduction is:

`102.040816326530612244 GCC`

If the funding wallet is already fee-exempt, a 100 GCC transfer is sufficient.

The repository now calculates this from the live contract for the actual public funding address:

```bash
npm run mainnet:plan-funding -- 0xYOUR_PUBLIC_FUNDING_WALLET
```

This is read-only. It does not request a key or send a transaction.

## Deployment preparation

After Verifier A and Verifier C public addresses exist:

```bash
GENESIS_VERIFIER_A_ADDRESS=0x... \
GENESIS_VERIFIER_C_ADDRESS=0x... \
GENESIS_SETTLEMENT_DEADLINE=<unix-seconds> \
npm run mainnet:prepare
```

Verifier B defaults to the already proven Genesis I AWS KMS signer.

The first run prints the exact `GenesisVerifierAuthority` constructor arguments. After the authority is deployed and verified, rerun with:

```bash
GENESIS_AUTHORITY_ADDRESS=0x... \
GENESIS_VERIFIER_A_ADDRESS=0x... \
GENESIS_VERIFIER_C_ADDRESS=0x... \
GENESIS_SETTLEMENT_DEADLINE=<unix-seconds> \
npm run mainnet:prepare
```

That produces the escrow constructor arguments.

## Funding gate

Fund only after:

- Verifier A has a working restricted autonomous Genesis attestation signer;
- Verifier B is reachable and signs only through the Genesis firewall;
- Verifier C public address is fixed on a separate device;
- `GenesisVerifierAuthority` is deployed on chain 56 and its policy hash/verifier set matches;
- `GenesisDeliverableEscrow` is deployed on chain 56;
- GCC token and tender hash match the pinned values;
- reward rules are `10 × 10`, `0 × 0`, `0 × 0`;
- settlement deadline is correct;
- both contracts and constructor inputs are verified on BscScan;
- a small-value mainnet settlement test succeeds;
- `mainnet:plan-funding` has been run against the actual funding wallet.

Then transfer **the fee-aware gross amount reported by the planner**, not an assumed 100 GCC wallet transfer.
