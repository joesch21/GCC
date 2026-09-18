# Genesis I GitHub intake bridge

## Purpose

The bridge turns public GitHub issues for GCC-GENESIS-001 into the canonical evidence request already accepted by Verifier A, AWS KMS Verifier B, GenesisVerifierAuthority, and GenesisDeliverableEscrow.

It does not create a new payment authority. It only supplies evidence to the existing bounded 2-of-3 settlement path.

## Submission flow

1. Poll open joesch21/GCC issues whose title starts with [GCC-GENESIS-001].
2. Parse the frozen tender fields:
   - submission_id
   - agent_id
   - recipient_address
   - deliverable_url
   - deliverable_hash
   - runtime
   - run_command
   - observed_output
3. Require an EVM personal-sign proof over a deterministic challenge binding:
   - tender id
   - submission id
   - deliverable hash
   - recipient address
4. Fetch the exact deliverable bytes over public HTTPS and verify Keccak-256 against deliverable_hash.
5. Require the source to reference the canonical GCC discovery URL.
6. Run the artifact in a disposable unprivileged Docker container:
   - read-only root filesystem
   - no host secrets or key files
   - no privileged capabilities
   - 256 MB memory cap
   - one CPU
   - bounded process count
   - bounded runtime
7. Require the networked run to print exactly the frozen PASS JSON.
8. Run the same artifact again with Docker networking disabled. A client that still reports PASS is rejected.
9. Construct the canonical Genesis assessment/evidence request.
10. Verifier A and Verifier B independently validate and sign the same request.
11. The live 2-of-3 authority is checked.
12. The existing bounded relayer performs a read-only settle simulation.
13. In live-send mode only, the dedicated relayer sends the fixed settle transaction and posts the BSC transaction hash back to the issue.

## Recipient binding

If recipient_signature is absent, the bridge posts a deterministic challenge to the issue. The submitter signs it with recipient_address using personal_sign or signMessage and replies:

recipient_signature: 0x...

This costs no gas and never requires the private key to leave the wallet.

## No-send synthetic dry-run

A specific GitHub issue can be run through the full bridge and live A+B authority path without broadcasting a settlement:

npm run mainnet:intake:dry-run -- ISSUE_NUMBER --synthetic

Synthetic issues must include:

synthetic_test: true

Synthetic mode relaxes only the public-opening timestamp check and may use a local discovery mirror so the bridge can be exercised before the public site is OPEN. It does not relax recipient signature verification, artifact hashing, canonical request validation, A+B signing, authority verification, funding checks, or the read-only settle simulation.

The command must end with:

status: DRY_RUN_PASS
transactionSent: false
fundsMoved: false

## Live service

After the public discovery surface is OPEN and the synthetic dry-run has passed:

GENESIS_RELAYER_SEND=1 npm run mainnet:intake:run

Startup requires:

- the encrypted local Verifier A keystore;
- the encrypted dedicated relayer keystore;
- an active AWS session able to use immutable Verifier B;
- Docker;
- GitHub authentication through GITHUB_TOKEN / GH_TOKEN or gh auth;
- BSC mainnet RPC access.

Verifier A and the relayer are unlocked once at process startup. There is no human approval step per award.

## Fail-closed behavior

The bridge rejects or retries without sending a transaction when:

- required fields are missing;
- recipient_address is invalid or zero;
- recipient binding does not verify;
- deliverable_url is not public HTTPS;
- artifact bytes do not match deliverable_hash;
- canonical discovery URL is absent from source;
- sandbox execution fails or times out;
- the observed output differs from the verified output;
- the artifact reports PASS with networking disabled;
- output appears to request private credentials;
- A and B derive different digests;
- the live authority rejects authorization;
- the award is already paid, expired, exhausted, or unfunded;
- the settle simulation fails;
- gas exceeds configured caps;
- relayer BNB is insufficient.

## Persistence and replay

Local intake state is stored under:

~/.local/state/gcc/genesis-intake.json

The state file is only an operational convenience. On-chain replay and reward-cap enforcement remain authoritative in GenesisDeliverableEscrow.
