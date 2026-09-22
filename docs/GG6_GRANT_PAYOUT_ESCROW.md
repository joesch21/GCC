# GG-6 grant payout escrow and existing relayer reuse

## Decision

GG-6 reuses the existing Genesis settlement **relayer identity**:

`0x381c2939c943C52D9260B0c635d2FD7B17FB1C21`

The Genesis tender escrow at:

`0x8e834961EeC8F1a7048964B28E8156A211993E12`

is **not** reused for GG grant funds.

That distinction is mandatory. The Genesis escrow is immutable and bound to
`GCC-GENESIS-001`, its tender hash, fixed reward classes, fixed award amounts,
and its settlement deadline. A generic GG grant payout cannot be routed through
that contract.

## GG-6 payout path

GG-6 introduces `GrantPayoutEscrow`.

It is deployed on BSC mainnet (chain ID 56) with three immutable bindings:

1. the verified GCC mainnet token;
2. the human authority address;
3. the existing Genesis gas-relayer address.

The human funds the grant payout escrow with GCC. The existing relayer remains
gas-only and is funded separately with BNB.

The relayer cannot select a payment. It may only submit a `Payout` carrying:

- the exact GG-5 transfer-material hash;
- the approved recipient wallet;
- the exact base-unit GCC amount;
- a short expiry;
- the human authorization over those exact fields.

Any change to material hash, recipient, amount, or expiry invalidates the
authorization.

## Existing mainnet bindings

Source: `deployments/GCC-GENESIS-001-bsc-mainnet.json`.

- Network: BSC mainnet
- Chain ID: 56
- GCC token: `0x092aC429b9c3450c9909433eB0662c3b7c13cF9A`
- Existing relayer: `0x381c2939c943C52D9260B0c635d2FD7B17FB1C21`
- Genesis escrow: `0x8e834961EeC8F1a7048964B28E8156A211993E12` — explicitly excluded from GG-6 grant custody

The new GG-6 grant escrow address must be recorded separately after deployment
and verified on BscScan before funding.

## Funding model

There are two independent balances.

### GCC reserve

GCC is sent by the human to the new `GrantPayoutEscrow`, never to the relayer.

Tower should compare:

`pending exact approved GG payouts`

against:

`GrantPayoutEscrow.escrowBalance()`

and report the exact shortfall. A payout must remain blocked while the reserve
is below the required amount.

### Relayer gas

BNB is sent by the human to the existing relayer address.

Tower should compare the relayer's BNB balance against the configured minimum
gas reserve and report the exact shortfall.

The relayer does not require GCC and the grant escrow does not accept BNB.

## Contract safety

`GrantPayoutEscrow` has no:

- owner;
- admin;
- upgrade path;
- sweep function;
- arbitrary target call;
- arbitrary token transfer;
- native-BNB receive path.

Only the immutable relayer may call `settle()`. Payment authority comes from
the immutable human authority signature, not from the relayer.

Each exact payout can settle once.

## Mainnet deployment gate

Do not deploy or fund until all of the following are explicit:

- BSC mainnet chain ID is 56;
- GCC address is the verified mainnet contract;
- human authority address is confirmed;
- existing relayer address matches the recorded Genesis relayer;
- contract source/tests pass;
- deployed source is verified on BscScan;
- the deployed address is written to the GG-6 deployment record;
- a tiny-value canary is prepared first.

GG-6 code preparation does not itself deploy a contract, fund an address, sign
an authorization, or send a blockchain transaction.
