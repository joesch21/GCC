# Genesis Production Verifier B

## Status

This is a production-oriented signing firewall implementation. It does not
deploy contracts, call AWS, create keys, or authorize a mainnet deployment.
The current Genesis verifier policy remains **DRAFT** (`0.3-draft`).

## Security boundary

```text
Evidence/request
      |
      v
Verifier B policy firewall
      |
      v
Exact Award and attestation digest reconstruction
      |
      v
Restricted signer interface
      |
      v
AWS KMS workload identity (future adapter)
      |
      v
GenesisVerifierAuthority
```

The public entry point accepts only a structured request containing the
existing escrow Award fields, the assessment manifest, and the policy's
submission/validation evidence. It rejects caller-supplied digests, chain or
domain overrides, key identifiers, signing algorithms, and message types.

The assessment is checked against
`schemas/gcc-genesis-assessment.schema.json`. The evidence checks cover the
mandatory fields and hard-fail conditions described by
`policies/GCC-GENESIS-001.verifier-policy.json`. The assessment hash is
recomputed using the policy's `stable-json-v1` canonicalization. The Award
digest and the `GenesisVerifierAuthority` attestation digest are then rebuilt
using the exact contract domains and types in Solidity.

The signer adapter has one permitted operation:

```text
signGenesisAttestationDigest(internallyDerived32ByteDigest)
```

It receives no request, key ID, algorithm, or message type. A future AWS
adapter must use trusted workload configuration for the signer identity and
key selection, with KMS equivalent to `MessageType=DIGEST` and
`SigningAlgorithm=ECDSA_SHA_256`. AWS is not part of the policy engine and is
not called by ordinary tests.

Production configuration is loaded from trusted process environment variables
and has no development defaults for authority, escrow, tender, policy, or
signer addresses. It requires chain ID 56, the exact escrow and authority
domain names/versions, the checked-in pinned policy hash, allowed reward
classes, and a maximum validity horizon. The explicit
`GENESIS_VERIFIER_B_SIGNING_ENABLED` gate defaults to false. Incomplete
configuration fails closed.

The module can prove structural and policy-evidence consistency. It does not
magically prove that subjective architectural judgments in an assessment are
objectively correct; those judgments remain part of the independently
reviewable assessment evidence.

Humans must not have production per-award signing authority. Production AWS
signing permission will later belong to a constrained workload identity, not
the interactive IAM user. Condor/Tower together count as one security domain;
AWS Verifier B is a second domain. Production still requires an independent
Verifier C. This change authorizes no mainnet deployment.
