# Genesis I bounded settlement relayer

The Genesis settlement relayer is a gas-only execution boundary for the immutable
`GenesisDeliverableEscrow` on BSC mainnet.

It does not custody GCC and has no authority to select recipients, amounts,
reward classes, arbitrary transaction targets, or arbitrary calldata. A request
must first pass both Genesis verification firewalls (Verifier A and AWS KMS
Verifier B). The relayer then rechecks the resulting A+B authorization against
the live 2-of-3 `GenesisVerifierAuthority` before it can call `settle(...)`.

## Safety bounds

- chain is fixed to BSC mainnet (56);
- target is fixed to the recorded Genesis escrow;
- transaction value is always 0 BNB;
- only `settle(Award, verifierAuthorization)` calldata is generated;
- A+B must derive identical award and attestation digests;
- the live authority must return the EIP-1271 magic value;
- already-paid, expired, disabled, exhausted, and unfunded awards are rejected;
- a successful `eth_call` settlement simulation is required before send;
- gas limit and maximum gas cost are capped by trusted relayer configuration;
- the dedicated relayer keystore is encrypted locally and its private key is
  never exported.

## Commands

Create the dedicated gas relayer wallet once:

```bash
npm run mainnet:relayer:create
```

Run the live A+B relayer canary without sending a transaction:

```bash
npm run mainnet:relayer:canary
```

Run the NDJSON executor in dry-run mode:

```bash
npm run mainnet:relayer:run
```

To enable autonomous settlement after the escrow and relayer are funded, start
the same process with trusted local configuration:

```bash
GENESIS_RELAYER_SEND=1 npm run mainnet:relayer:run
```

The process is unlocked once at startup. Each subsequent newline-delimited
request is evaluated and, if every bounded check passes, settled without a
separate human payment approval.

The relayer wallet needs BNB for gas only. It does not need GCC.
