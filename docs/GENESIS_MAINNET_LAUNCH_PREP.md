# GCC Genesis I — Mainnet Launch Preparation

## Scope

This is a **bounded 100 GCC experiment**, not the permanent production architecture.

The experiment asks whether independent agents will discover a GCC-denominated task, complete it, submit it, and receive an on-chain reward without direct human commissioning.

## Verified GCC token binding

BNB Smart Chain mainnet, chain ID `56`.

GCC token:

`0x092ac429b9c3450c9909433eb0662c3b7c13cf9a`

Decimals: `18`.

Before funding the Genesis escrow, run the read-only token preflight:

```bash
npm run mainnet:inspect-gcc
```

The preflight confirms the live chain, code, token metadata, owner, and currently exposed fee parameters. The deployed GCC implementation contains fee/exclusion logic, so Genesis must not assume that a nominal `10 GCC` transfer necessarily produces a `10 GCC` recipient balance delta until the live transfer behavior has been checked.

## Genesis I verifier profile

Genesis I uses the immutable `GenesisVerifierAuthority` threshold of **2-of-3**.

- **Verifier A** — Tower/Condor automated verifier domain. Tower and Condor remain one security slot because they share the same host boundary.
- **Verifier B** — the existing AWS KMS secp256k1 signer already proven end-to-end by the Genesis integration test. For this bounded Genesis I experiment it is explicitly treated as an experimental signer rather than a fully hardened production workload identity.
- **Verifier C** — a dedicated contingency EOA created on a separate physical/mobile device. It cannot authorize a payment alone and is not required during the normal automated A+B settlement path.

This profile is intentionally pragmatic for a maximum escrow liability of 100 GCC. A later experiment can replace B/C with stronger independent workload/HSM domains without changing the basic authority/escrow model.

## Agent payout and BNB gas

An agent does **not** need BNB to receive its GCC reward.

The flow is:

1. the agent supplies a BSC-compatible recipient address in its submission;
2. two verifier authorities attest to an objectively passing award;
3. a relayer calls `GenesisDeliverableEscrow.settle(...)` and pays the BNB transaction gas;
4. the escrow transfers the GCC reward directly to the agent recipient address.

The recipient therefore pays no gas to receive GCC.

An ordinary EOA **does** need BNB later if it wants to send GCC, approve a DEX, swap GCC, or call another BSC contract. Genesis I therefore defines a separate bounded gas-bootstrap service:

- only after a successful GCC settlement;
- target/cap: `0.0002 BNB` per EOA recipient;
- maximum 10 bootstrapped recipients;
- maximum operational exposure: `0.002 BNB`;
- funded separately from the immutable 100 GCC escrow;
- it has no authority to approve GCC awards;
- smart-account recipients that already have a paymaster/gas mechanism do not require the stipend.

This avoids introducing account abstraction/paymaster infrastructure into Genesis I while removing the immediate chicken-and-egg problem of an agent owning GCC but having no BNB to make its first transaction.

## Frozen economic constructor values

`GenesisDeliverableEscrow` uses:

- qualified reward: `10 GCC` = `10000000000000000000` raw units;
- maximum qualified awards: `10`;
- finalist reward / count: `0 / 0`;
- selected-component reward / count: `0 / 0`;
- reward cap: `100 GCC` = `100000000000000000000` raw units;
- GCC token: the mainnet address above;
- tender hash: read from `tenders/GCC-GENESIS-001.keccak256`;
- verifier: the deployed `GenesisVerifierAuthority` address.

No GCC should be sent before the escrow address is deployed and verified.

## Deployment preparation

After Verifier A and Verifier C public addresses exist, prepare the immutable constructor inputs with:

```bash
GENESIS_VERIFIER_A_ADDRESS=0x... \
GENESIS_VERIFIER_C_ADDRESS=0x... \
GENESIS_SETTLEMENT_DEADLINE=<unix-seconds> \
npm run mainnet:prepare
```

Verifier B defaults to the already proven Genesis I AWS KMS signer and can be explicitly overridden with `GENESIS_VERIFIER_B_ADDRESS`.

The first run prints the exact `GenesisVerifierAuthority` constructor arguments. After that contract is deployed and verified, set its address and rerun:

```bash
GENESIS_AUTHORITY_ADDRESS=0x... \
GENESIS_VERIFIER_A_ADDRESS=0x... \
GENESIS_VERIFIER_C_ADDRESS=0x... \
GENESIS_SETTLEMENT_DEADLINE=<unix-seconds> \
npm run mainnet:prepare
```

That produces the exact escrow constructor arguments.

## Funding gate

Only after all of the following are true should the human fund the escrow:

- `GenesisVerifierAuthority` is deployed on chain 56 and its policy hash and three verifier addresses match the frozen inputs;
- `GenesisDeliverableEscrow` is deployed on chain 56;
- the escrow GCC token equals the verified GCC contract;
- the escrow tender hash equals the pinned canonical tender hash;
- reward rules are `10 × 10`, `0 × 0`, `0 × 0`;
- settlement deadline is correct;
- source and constructor parameters are verified on BscScan;
- the live GCC fee/transfer preflight is understood;
- a small-value end-to-end mainnet test has succeeded.

Then transfer **exactly 100 GCC** to the verified `GenesisDeliverableEscrow` address.
