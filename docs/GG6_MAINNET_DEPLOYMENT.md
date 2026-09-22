# GG-6 mainnet deployment runbook

## Purpose

Deploy and source-verify `GrantPayoutEscrow` on BSC mainnet without exposing a private key to the local deployer server.

## Frozen bindings

- Network: BNB Smart Chain Mainnet
- Chain ID: `56`
- GCC: `0x092aC429b9c3450c9909433eB0662c3b7c13cF9A`
- Existing gas relayer: `0x381c2939c943C52D9260B0c635d2FD7B17FB1C21`
- Genesis tender escrow is forbidden as the GG-6 escrow:
  `0x8e834961EeC8F1a7048964B28E8156A211993E12`
- Genesis verifier authority is not the GG-6 human authority:
  `0x00E462098E41980C81B0ccB45F5fAb7c81F13FDb`

The remaining immutable constructor input is the **single existing Condor human authority address**. Do not substitute a Safe, the Genesis verifier authority, relayer, GCC token or tender escrow.

## Deploy

Run locally:

```bash
npm run mainnet:gg6-deploy-ui
```

Then open:

```text
http://127.0.0.1:4176
```

The page is local-only. It loads the compiled `GrantPayoutEscrow` artifact, forces BSC mainnet, verifies GCC bytecode, verifies the existing relayer is an EOA, requires the explicit Condor authority address, estimates deployment gas, and then asks the injected wallet to sign the deployment.

The server never receives a private key.

After mining, the page checks the three immutable bindings and confirms the new escrow starts with zero GCC and zero paid amount.

## Record

Copy the generated deployment report into:

```text
deployments/GG6-GRANT-PAYOUT-bsc-mainnet.json
```

using the committed template as the schema.

Do not fund the escrow yet.

## BscScan source verification

Set the existing local Etherscan/BscScan API key in the environment. Never commit or paste it into chat.

Then run:

```bash
npm run mainnet:gg6-verify
```

The verifier:

1. requires chain ID 56;
2. validates the recorded GCC and relayer;
3. reads the deployed `gcc`, `humanAuthority` and `relayer` immutables;
4. confirms runtime bytecode exists;
5. submits the exact constructor arguments for source verification;
6. treats an already-verified contract as success.

Only after this passes should the deployment record be updated to `bscscanSourceVerification: VERIFIED`.

## Funding gate

After deployment + source verification:

- GCC funding target = new `GrantPayoutEscrow`;
- BNB gas funding target = existing relayer;
- Tower GG-6 determines exact shortfalls;
- start with a tiny GCC canary;
- do not enable any generic wallet or arbitrary-send capability.
