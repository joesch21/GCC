# Genesis Verifier A — local Node signer

Genesis I uses a dedicated local Verifier A identity. It is not the MetaMask
funding wallet and it does not hold GCC.

The key is generated locally, encrypted with the standard ethers JSON keystore
format, and stored outside the repository by default at:

`~/.config/gcc/genesis-verifier-a.keystore.json`

The private key is never printed or requested by the repository.

## Create the identity

```bash
npm run verifier-a:create
```

The command prompts twice for a password without echoing it, creates the
encrypted keystore with restrictive local permissions where supported, signs a
fixed local self-check digest, verifies recovery to the generated address, and
prints only the public address and keystore path.

## Run the restricted signer

The runtime signer does not accept arbitrary digests. It accepts
newline-delimited Genesis evidence requests, passes them through the existing
Genesis objective verification firewall, derives the EIP-712 attestation digest
internally, and only then signs it.

It requires the deployed authority and escrow addresses in trusted local
environment configuration and remains signing-disabled unless
`GENESIS_VERIFIER_A_SIGNING_ENABLED=true` is explicitly set.

The normal Genesis I path is Verifier A + Verifier B. Verifier C remains a
separate contingency wallet and cannot authorize a payment alone.
