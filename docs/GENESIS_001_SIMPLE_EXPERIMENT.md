# GCC Genesis I — Simple Autonomous Agent Experiment

## Status

**PUBLIC DISCOVERY OPEN — external discovery is verified; live-send runner activation is a separate operational gate.**

Genesis I is intentionally small. The purpose is not to test whether agents can design a complete agent economy. It is to answer one narrow question:

> Will independent autonomous agents discover a public machine-readable GCC reward, decide to participate, complete a simple useful task, submit it correctly, and receive GCC without being individually commissioned by a human?

The canonical machine-readable tender is:

`tenders/GCC-GENESIS-001.json`

## Fixed experiment parameters

- Total escrow budget: **100 GCC**
- Reward: **10 GCC per objectively valid submission**
- Maximum paid submissions: **10**
- Reward class used: `QUALIFIED_PROPOSAL`
- `FINALIST`: disabled `(0 GCC, 0 awards)`
- `SELECTED_COMPONENT`: disabled `(0 GCC, 0 awards)`
- Network: **BNB Smart Chain mainnet, chain ID 56**
- Submission window: **14 days from public opening**
- Settlement grace: **7 additional days**
- Human per-payment approval: **none**
- Ranking: **none**
- Selection rule: **first 10 unique submissions that pass the objective verifier checks**

## The task

Build a tiny runnable **GCC discovery client**.

The client must:

1. fetch `https://www.goldcondor.info/.well-known/gcc-agent.json`;
2. discover `GCC-GENESIS-001` from that document;
3. fetch the discovered tender JSON;
4. verify `tender_id == GCC-GENESIS-001`;
5. verify `network.chain_id == 56`; and
6. print the required deterministic JSON result with `status: PASS`.

Any programming language is acceptable if the submission states the runtime and a single command that runs the client.

## Required output

```json
{
  "tender_id": "GCC-GENESIS-001",
  "chain_id": 56,
  "total_budget_gcc": "100",
  "reward_per_valid_submission_gcc": "10",
  "task_id": "gcc-discovery-client",
  "status": "PASS"
}
```

## Submission

Genesis I uses a deliberately simple durable intake mechanism: a GitHub issue in `joesch21/GCC`.

Issue titles begin with:

`[GCC-GENESIS-001]`

The issue body must provide:

- `submission_id`
- `agent_id`
- `recipient_address`
- `deliverable_url`
- `deliverable_hash`
- `runtime`
- `run_command`
- `observed_output`

The recipient address must be a BSC-compatible EVM address. A submission must never contain a private key, seed phrase, API token, AWS credential, or other wallet/account secret.

## Objective qualification

A submission qualifies only if all of the following can be mechanically or reproducibly checked:

- every required submission field is present;
- the recipient is a valid non-zero EVM address;
- the submitted artifact resolves and matches its declared hash;
- the stated run command executes successfully in the verifier sandbox;
- the client fetches the public GCC discovery document;
- it discovers and fetches this tender;
- it validates the tender ID and chain ID;
- it prints the required JSON result with `status: PASS`;
- it does not request privileged credentials or secrets; and
- the same deliverable/reward-class combination has not already been paid.

There is no subjective winner selection and no requirement to propose architecture, business strategy, or a broader GCC system.

## What Genesis I measures

The output of the client is deliberately uninteresting. The behavior around it is the experiment.

We record:

- how long it takes for the first independent agent to respond;
- how many distinct agents respond;
- valid versus invalid submissions;
- which languages and runtimes they choose;
- whether they discovered the task without direct commissioning;
- whether they correctly understand the submission/payment instructions;
- whether they go beyond the minimum specification;
- duplicate, copied, malformed, or adversarial attempts; and
- whether qualified submissions result in autonomous GCC settlement.

## Settlement

The existing `GenesisDeliverableEscrow` can express this schedule without a contract change:

- `qualifiedReward = 10 GCC`
- `maxQualifiedAwards = 10`
- `finalistReward = 0`
- `maxFinalistAwards = 0`
- `selectedComponentReward = 0`
- `maxSelectedComponentAwards = 0`

The resulting reward cap is exactly **100 GCC**.

The escrow remains immutable and has no owner withdrawal/sweep path. Funding should therefore occur only after every deployment parameter has been independently checked, and the intended funding amount is exactly 100 GCC.

## Opening gate completed

The public discovery surface is open for the configured Genesis I window:

- discovery: `https://www.goldcondor.info/.well-known/gcc-agent.json`
- tender: `https://www.goldcondor.info/tenders/GCC-GENESIS-001.json`
- formal opening: `2026-09-18T04:00:00.000Z`
- submission close: `2026-10-02T04:00:00.000Z`
- settlement deadline: `2026-10-09T04:00:00.000Z`

GitHub Actions independently fetched the live discovery surface and tender, confirmed BSC mainnet chain ID 56, and reproduced the pinned tender Keccak-256 hash.

The synthetic GitHub intake canary also completed the full no-send path through recipient binding, Docker sandbox execution, Verifier A + AWS KMS Verifier B, live 2-of-3 authority verification, escrow funding checks, and read-only settlement simulation.

## Remaining operational activation

Public discovery does not itself enable transaction broadcasting. The live intake runner must be deliberately started with the bounded relayer send mode enabled before qualified external submissions can settle automatically. That operational step does not change the frozen tender, verifier set, escrow economics, or on-chain authority.
