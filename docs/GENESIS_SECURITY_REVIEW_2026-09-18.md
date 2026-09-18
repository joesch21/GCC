# Genesis I Security Review — 2026-09-18

## Scope

This review covers the exact Solidity sources deployed for GCC Genesis I:

- `contracts/GenesisVerifierAuthority.sol`
- `contracts/GenesisDeliverableEscrow.sol`

The deployed BSC mainnet runtime bytecode for both contracts has already been independently matched against the locally compiled source, and both contracts are publicly source-verified on BscScan.

## Automated static analysis

Tool: Slither `0.11.6`

Environment:

- Solidity `0.8.37`
- optimizer enabled, 200 runs
- EVM target `cancun`
- dependencies excluded from detector findings
- test contracts excluded from detector findings

Result:

- High: **0**
- Medium: **2**
- Low: **2**
- Informational: **1**

The raw Slither report and machine-readable summary were produced by the `Genesis Security Review` GitHub Actions workflow.

## Findings and disposition

### Medium — locked-ether

Slither reports that `GenesisDeliverableEscrow` has a payable `receive()` function but no BNB withdrawal path.

Disposition: **expected / non-exploitable in the intended interface**.

The `receive()` function unconditionally reverts with `NativeAssetNotAccepted()`; normal BNB transfers cannot be accepted. A forced native-asset balance (for example through protocol-level forced delivery) could remain unrecoverable, but native BNB is deliberately outside the escrow's asset model and has no effect on GCC settlement accounting.

No contract change is recommended for the deployed Genesis I instance.

### Medium — uninitialized-local

Slither reports the local `address previous;` variable in `GenesisVerifierAuthority.isValidSignature`.

Disposition: **safe Solidity default-value behavior**.

Local value-type variables default to zero. The variable is only consulted when `i > 0`, after the previous loop iteration has assigned it to the prior signer. It is used solely to enforce strictly ascending signer addresses and therefore signer uniqueness.

Initializing it explicitly to `address(0)` would be stylistic only and would not change behavior.

### Low — timestamp comparison in constructor

Slither reports use of `block.timestamp` to require the settlement deadline to be in the future.

Disposition: **intentional time-bound protocol behavior**.

Genesis I is explicitly deadline-based. Normal validator timestamp variance is negligible relative to the multi-day experiment window.

### Low — timestamp comparisons in settle

Slither reports comparisons of `block.timestamp` against `settlementDeadline` and `award.validUntil`.

Disposition: **intentional time-bound protocol behavior**.

These checks are required to prevent settlement after the immutable experiment deadline and after an individual award authorization expires.

### Informational — cyclomatic complexity

Slither reports cyclomatic complexity 14 for `GenesisDeliverableEscrow.settle`.

Disposition: **accepted**.

The function contains a sequence of explicit, fail-closed validation checks before one bounded token transfer. The deployed implementation is non-upgradeable, has no owner/admin/sweep path, is protected by `nonReentrant`, applies effects before interaction, and has comprehensive replay, class-cap, deadline, verifier-authorization, and reward-cap checks.

## Manual security observations

The review additionally confirmed:

- BSC chain ID 56 is enforced at construction.
- The authority is immutable 2-of-3 with no owner, signer rotation, or upgrade path.
- Verifier signers must be authorized, unique, strictly ascending, and produce valid signatures for the policy-bound EIP-712 attestation digest.
- The escrow is immutable and permits GCC to leave only through `settle`.
- Replay is blocked by both award identity and deliverable/reward-class identity.
- Reward-class counts and the total 100 GCC nominal cap are enforced on-chain.
- State effects occur before the GCC transfer and the function is `nonReentrant`.
- BNB is rejected through the normal receive path.
- There is no arbitrary transfer or sweep function.
- Fee-on-transfer GCC semantics are deliberately treated as nominal-transfer semantics; the recipient's direct balance credit may be lower than the nominal 10 GCC amount.
- The tiny reflection-derived balance above the 100 GCC liability cannot increase the nominal payout cap and may remain stranded because no sweep path exists.

## Review conclusion

**No high-severity finding was reported.**

The two Slither medium findings are accepted as either an intentional design property or a safe language-default pattern, not exploitable paths under the deployed Genesis I interface.

The low and informational findings correspond to intentional deadline enforcement and validation-branch complexity.

This automated static-analysis review, together with the existing exact-bytecode comparison, BscScan source verification, contract tests, live A+B authority canaries, bounded relayer canaries, and funded `eth_call` settlement simulation, satisfies the Genesis I pre-opening automated contract/security review gate.

This is not a third-party professional audit and should not be represented as one.
