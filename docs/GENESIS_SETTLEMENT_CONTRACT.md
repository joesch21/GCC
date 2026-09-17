# GCC Genesis Deliverable Settlement Contract

## Status

**DRAFT / NOT DEPLOYED / NOT FUNDED**

This contract is the proposed settlement boundary for `GCC-GENESIS-001`.

It is intentionally separate from GCC Landing. The public landing site remains read-only and has no transaction authority.

## Objective

Create a GCC-funded contract address that a human can fund but cannot subsequently sweep or arbitrarily spend.

GCC leaves the contract only when a deliverable-specific award authorization satisfies the immutable Genesis payment rules.

## Core rule

```text
fund GCC escrow
      |
      v
agent submits deliverable
      |
      v
assessment produces immutable hashes
      |
      v
verifier authorizes exact award
      |
      v
any relayer submits authorization
      |
      v
contract checks rules + replay protection
      |
      v
fixed GCC reward paid directly to recipient
```

The relayer pays BNB gas but receives no authority over GCC.

## No human treasury key

`GenesisDeliverableEscrow` deliberately has:

- no owner;
- no admin;
- no upgrade function;
- no arbitrary `transfer` function;
- no emergency sweep;
- no token recovery;
- no parameter mutation after deployment.

The GCC token, verifier, tender hash, deadline, reward amounts, and reward-count caps are immutable once deployed.

Funding the contract therefore does **not** create a wallet that a human can later log into.

### Important consequence

Overfunded GCC cannot be recovered by an administrator. Fund the contract only after the deployment parameters have been independently verified, and preferably fund exactly the published `rewardCap`.

## Payment classes

Genesis I supports only:

1. `QUALIFIED_PROPOSAL`
2. `FINALIST`
3. `SELECTED_COMPONENT`

Each class has:

- an immutable GCC amount; and
- an immutable maximum number of awards.

The verifier does **not** choose the amount. It can only authorize that a particular deliverable qualifies for one of the pre-funded classes.

This turns the payment schedule into contract law rather than an off-chain convention.

## Award authorization

The verifier signs an EIP-712 `Award`:

```text
tenderHash
awardClass
deliverableHash
assessmentHash
recipient
validUntil
```

The signature is bound by EIP-712 to:

- BSC chain ID 56;
- this exact escrow contract address;
- the Genesis escrow domain and version.

The contract accepts both ordinary ECDSA verifier addresses and EIP-1271 smart-account verifiers through OpenZeppelin `SignatureChecker`.

For the intended no-human-control architecture, the production verifier should ultimately be a contract or agent authority whose own policy is separately reviewed. An EOA verifier is supported for controlled testing but remains a bearer-key authority.

## What proves the deliverable

The escrow does not attempt to judge software quality on-chain.

Instead:

- `deliverableHash` commits to the exact accepted work or component;
- `assessmentHash` commits to the exact assessment/evidence record;
- the verifier authorization says that those hashes satisfy the tender's external verification policy.

The settlement event permanently records both hashes.

## Replay and duplicate protection

The contract prevents:

- replaying the same economic award;
- paying the same deliverable twice in the same reward class;
- exceeding a class's maximum award count;
- paying after the Genesis settlement deadline;
- using an authorization that expires after the contract deadline;
- paying against another tender;
- changing the recipient after authorization;
- changing the assessment after authorization.

The same underlying proposal may legitimately progress from qualified proposal to finalist because those are distinct reward classes.

For `SELECTED_COMPONENT`, each separately rewarded component should have its own content hash.

## Funding

The contract does not need BNB to make payments.

1. Deploy the contract on BSC mainnet.
2. Verify its source and constructor parameters on BscScan.
3. Read `rewardCap()`.
4. Transfer the intended GCC amount directly to the escrow contract address.
5. Confirm `escrowBalance()` and `fundingShortfall()` on-chain.

A relayer pays BNB gas when calling `settle`.

## Deployment gates

Do **not** deploy or fund until all of these are fixed and reviewed:

- verified GCC BSC mainnet token address;
- canonical `GCC-GENESIS-001` tender bytes and their Keccak-256 hash;
- verifier authority address and policy;
- qualified proposal reward amount and count;
- finalist reward amount and count;
- selected component reward amount and count;
- settlement deadline;
- GCC token decimals and human-readable conversion;
- compiled bytecode reproducibility;
- test and security review results.

## Mainnet invariants

The Solidity constructor refuses deployment unless `block.chainid == 56`.

The contract is non-upgradeable and uses Solidity 0.8.37 with the EVM target pinned to `paris`. OpenZeppelin Contracts is pinned to the audited npm `latest` line used by this project, version 5.6.1.

The current implementation must still receive an independent contract review before real GCC is funded.

## Human role

The human may:

- approve the public tender/reward schedule before deployment;
- deploy or cause deployment of the immutable contract;
- transfer GCC into the deployed contract;
- observe settlements.

The human cannot, through this contract:

- withdraw funded GCC;
- change award amounts;
- change award caps;
- change the verifier;
- substitute another tender;
- redirect an already authorized recipient;
- sweep remaining funds.

## Next architecture boundary

The unresolved authority is **deliverable verification**, not custody.

Before mainnet funding, the verifier needs its own explicit policy defining how objective validation plus project-manager assessment becomes an EIP-712 award authorization.

That verifier policy is the next contract/specification layer.
