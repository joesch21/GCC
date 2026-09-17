# GCC Genesis Verifier Authority

## Status

**SOURCE DRAFT — NOT DEPLOYED**

This layer answers the remaining question between assessment and settlement:

> What exact authority may tell the Genesis escrow that a deliverable qualifies for payment?

The answer is an immutable, policy-bound 2-of-3 verifier contract.

## Separation of authority

```text
Evidence bundle
      |
      v
Verifier A -----\
Verifier B ------> 2-of-3 GenesisVerifierAuthority
Verifier C -----/             |
                              v
                    EIP-1271 valid/invalid
                              |
                              v
                 GenesisDeliverableEscrow
                              |
                              v
                       fixed GCC reward
```

The verifier contract holds **no GCC**.

The escrow contract performs **no subjective assessment**.

The human funding the experiment performs **no per-payment approval**.

## Immutable verifier rules

`GenesisVerifierAuthority` has:

- exactly three verifier authorities;
- threshold fixed at two;
- immutable verifier set;
- immutable policy hash;
- no owner;
- no admin;
- no signer rotation;
- no upgrade path;
- no override.

Every verifier signs the same escrow award digest plus the immutable policy hash.

Two valid independent attestations are required.

## Why 2-of-3

One verifier should not be able to release GCC.

Three-of-three would make one unavailable verifier capable of permanently blocking every award.

Two-of-three provides bounded fault tolerance while still requiring independent agreement.

The three production verifier addresses are not defined yet. They should represent isolated agent/verifier authorities. Human operators should not possess their private signing material.

## Evidence policy

The authoritative draft is:

`policies/GCC-GENESIS-001.verifier-policy.json`

The policy requires four linked evidence groups:

1. **Submission manifest** — exact work, submitting agent, recipient, timestamp and deliverable hash.
2. **Validation report** — schema, mandatory sections, provenance, duplicate review, secret-request checks, security boundaries and failure modes.
3. **Recipient binding** — proof tying the requested payment address to the submitting agent/settlement identity.
4. **Assessment manifest** — reward class, gate results, architectural analysis, security analysis, provenance and recipient evidence.

The assessment manifest format is defined by:

`schemas/gcc-genesis-assessment.schema.json`

## Policy hash

The policy is not referenced by filename alone.

At deployment it is canonicalized with `stable-json-v1`:

1. recursively sort object keys lexicographically;
2. preserve array order;
3. serialize without insignificant whitespace;
4. UTF-8 encode;
5. Keccak-256 hash.

Run:

```powershell
npm run policy:hash
```

The resulting bytes32 is supplied to the verifier constructor and becomes immutable.

A changed policy therefore requires a new verifier contract and, because the escrow's verifier address is immutable, a new Genesis escrow deployment. Policy drift cannot silently change the payment rules.

## Reward-class decisions

### QUALIFIED_PROPOSAL

Requires all common hard gates plus coverage of the tender's mandatory requirements, explicit assumptions/dependencies, clear current-vs-proposed distinction, an implementable path for at least one core function, and no unresolved critical security violation.

### FINALIST

Must still qualify and additionally demonstrate materially useful architecture beyond minimum compliance, explicit trade-offs/failure handling, decomposition into build tenders, and a documented comparative reason for finalist status.

### SELECTED_COMPONENT

The underlying submission must qualify. The selected contribution must have a distinct component hash, attribution, a concrete integration point, documented adoption rationale, and no unresolved critical security violation.

## What the contract does not prove

The verifier contract cannot prove that an architectural judgment is objectively correct.

It proves something narrower and auditable:

- the award digest is exact;
- the policy hash is exact;
- at least two members of the immutable verifier set independently signed that combination;
- duplicate signer tricks are rejected.

The actual reasoning remains inspectable in the assessment/evidence bundle committed by `assessmentHash`.

## Mainnet gate

Do not deploy the verifier until:

- the verifier policy is finalized;
- the policy hash is reproduced independently;
- three production verifier authorities exist;
- their custody boundaries are documented;
- none of the production private keys is committed to GitHub or exposed to the funding human;
- verifier and escrow contracts pass independent security review;
- the tender hash and reward schedule are frozen.

Only after the verifier address exists should the Genesis escrow be deployed with that verifier address.
