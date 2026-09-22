# GG-7 Runtime Activation

This phase installs the already-merged GG-7 bounded relay as a persistent
local service. It does not change the GG-6 contract and it does not make any
grant payment by itself.

## Runtime identities and authority

The installer creates:

- service user: `gcc-gg7-relay`
- shared socket group: `tower-gg7`
- runtime: `/var/lib/gcc-gg7-relay/app`
- Unix socket: `/run/gcc/gg7-grant-relayer.sock`
- protected encrypted-keystore copy:
  `/etc/gcc/gg7/genesis-relayer.keystore.json`
- protected password credential:
  `/etc/gcc/credentials/gg7-relayer-password`

The existing relayer remains:

`0x381c2939c943C52D9260B0c635d2FD7B17FB1C21`

The service is hard-bound to:

- BSC mainnet chain 56;
- verified GCC token `0x092aC429b9c3450c9909433eB0662c3b7c13cF9A`;
- verified GG-6 escrow `0xca458394e8C3137cE4984bDac6E615d08E2482F6`;
- exact `settle(Payout,bytes)` only.

Tower receives Unix-socket access only. It cannot read the protected password
credential and does not receive the private key.

## Install

Run from the exact reviewed GCC source revision:

```bash
cd /home/joseph/GCC
sudo env GG7_EXPECTED_SOURCE_SHA=<reviewed-merge-sha> \
  ./scripts/install-gg7-relay-service.sh
```

The installer asks once for the existing Genesis relayer keystore password.
The password is not echoed and is not placed in an environment variable or
command-line argument.

The installer refuses to continue unless:

- the source HEAD is exactly the reviewed SHA;
- the source worktree is clean;
- the local keystore declares the canonical relayer address;
- the supplied password decrypts that exact keystore;
- the dedicated service identity/group can be established;
- Tower's local user can reach the Unix socket;
- relay health reports live mode, chain 56, Unix transport, and no arbitrary
  target/function authority.

A recovery copy of any previous service/config/credential is written under
`/var/lib/tower-recovery`.

## Service hardening

The systemd unit uses:

- dedicated unprivileged identity;
- `NoNewPrivileges=true`;
- `ProtectSystem=strict`;
- `ProtectHome=true`;
- private devices/tmp;
- kernel/control-group protections;
- empty capability bounding set;
- only AF_UNIX/AF_INET/AF_INET6 address families;
- writable access limited to the runtime Unix-socket directory.

Network access remains necessary for read/simulate/send against BSC mainnet.

## Acceptance

```bash
sudo systemctl status gcc-gg7-grant-relayer.service --no-pager
sudo -u joseph curl --unix-socket /run/gcc/gg7-grant-relayer.sock \
  http://localhost/health
```

Expected health includes:

```json
{
  "status": "READY",
  "liveEnabled": true,
  "chainId": 56,
  "transport": "unix_socket",
  "arbitraryTarget": false,
  "arbitraryFunction": false
}
```

No payout is created, signed, or submitted during installation.
