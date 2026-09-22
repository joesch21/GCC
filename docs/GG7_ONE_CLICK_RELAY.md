# GG-7 One-Click Grant Relay

## Purpose

GG-7 reduces the proven GG-6 mainnet payout ceremony without changing the
on-chain authority model.

The existing, source-verified `GrantPayoutEscrow` remains unchanged:

- chain: BSC mainnet (`56`);
- escrow: `0xca458394e8C3137cE4984bDac6E615d08E2482F6`;
- GCC: `0x092aC429b9c3450c9909433eB0662c3b7c13cF9A`;
- human authority: `0x0b36B0495c5e7899648D731d7b88d6Ffd3915184`;
- relayer: `0x381c2939c943C52D9260B0c635d2FD7B17FB1C21`.

The human still signs the exact EIP-712 `Payout`. The relayer still cannot
choose recipient, amount, transfer-material hash, or expiry.

## New runtime shape

GG-7 adds a dedicated local relay process:

```
Tower operator UI
  -> human EIP-712 wallet signature
  -> Tower backend exact-binding validation
  -> /run/gcc/gg7-grant-relayer.sock
  -> simulation
  -> existing relayer wallet
  -> GrantPayoutEscrow.settle(Payout,bytes)
  -> receipt verification
```

The relay listens on a Unix-domain socket only. It does not expose a TCP
listener or arbitrary transaction API.

Supported endpoints:

- `GET /health`
- `POST /simulate`
- `POST /settle`

Both mutation endpoints accept only:

```json
{
  "payout": {
    "transferMaterialHash": "0x...",
    "recipient": "0x...",
    "amount": "1000000000000000000",
    "validUntil": "..."
  },
  "humanAuthorization": "0x..."
}
```

The relay always simulates the exact `settle(Payout,bytes)` call before a live
send. It enforces the verified GG-6 escrow, chain 56, existing relayer,
short-lived authorization, gas caps, and a configurable payout ceiling.

## Credential boundary

Tower never receives the relayer password or private key.

Live mode requires:

```
GG7_RELAYER_LIVE=1
```

and a protected password file supplied either through:

```
GG7_RELAYER_PASSWORD_FILE=/protected/path
```

or systemd credentials:

```
CREDENTIALS_DIRECTORY=...
# file: $CREDENTIALS_DIRECTORY/gg7-relayer-password
```

A raw `GG7_RELAYER_PASSWORD` environment variable is explicitly rejected.

The encrypted Genesis relayer keystore remains the existing keystore selected by
`GENESIS_RELAYER_KEYSTORE` or its existing default path.

## Fail-closed limits

Default relay limits:

- maximum authorization horizon: 30 minutes;
- maximum gas limit: 500,000;
- maximum gas cost: 0.005 BNB;
- maximum payout: 1,000 nominal GCC.

The payout ceiling is a service-side blast-radius bound, not a grant policy. It
can be reduced in production with `GG7_RELAYER_MAX_PAYOUT_BASE_UNITS`.

## Dry-run service

Start without a live credential:

```bash
GG7_RELAYER_LIVE=0 npm run mainnet:gg7-relayer-service
```

`/simulate` works. `/settle` returns `gg7_live_send_disabled`.

## Live service

A production service must use an OS-protected credential file and Unix socket
permissions that allow Tower to connect but do not expose the relayer credential.

The service is an execution appliance, not a payment authority. A valid human
EIP-712 authorization remains mandatory for every payout.

## GG-6 compatibility

No contract redeployment or migration is required. GG-7 is an operational layer
over the already-proven GG-6 contract and existing relayer.
