# Genesis Verifier B AWS production workload identity

## Status and scope

This document defines the proposed AWS-native production boundary for
Genesis Verifier B. It is a design and CloudFormation validation artifact: it
does not create AWS resources, call AWS mutation APIs, alter the existing
test-only PoC KMS key, deploy a Lambda, or authorize a BSC mainnet deployment.
The Genesis policy remains **DRAFT** (`0.3-draft`).

Verifier B is one of three required cryptographic domains. Condor and Tower
together remain only **one separate domain**, not two independent domains. An
independent Verifier C is still required before production settlement claims
are treated as sufficiently separated.

## Boundary

```text
Genesis Verifier B Lambda workload
              |
              v
GCCGenesisVerifierBExecutionRole
              |
              v
ONE production AWS KMS key
ECC_SECG_P256K1 / SIGN_VERIFY
              |
              v
       kms:Sign only
              |
              v
GenesisVerifierAuthority
```

The CloudFormation template is
[`infra/aws/genesis-verifier-b/template.yaml`](../infra/aws/genesis-verifier-b/template.yaml).
It defines:

- `GCCGenesisVerifierBExecutionRole`, trusted only by the Lambda service
  principal (`lambda.amazonaws.com`);
- one retained production `AWS::KMS::Key`, with `KeySpec` set to
  `ECC_SECG_P256K1` and `KeyUsage` set to `SIGN_VERIFY`; and
- `GCCGenesisVerifierBKmsUsePolicy`, attached after key creation, granting the
  role only `kms:Sign`, `kms:GetPublicKey`, and `kms:DescribeKey` on that exact
  production key ARN.

The key policy is explicit rather than the broad default KMS policy. Its
account administrative statement contains only key-management operations; it
does not contain `kms:*` or cryptographic operations. Its workload statement
names the execution role directly and contains no IAM user or wildcard
principal. The `Resource: '*'` in a KMS key policy is the key-policy resource
scope required for a policy attached to that key; the workload identity policy
is the permission boundary that scopes `kms:Sign` to the generated production
key ARN.

The execution role has only the three standard CloudWatch Logs actions needed
for Lambda execution logging in addition to its KMS policy. It has no
`kms:PutKeyPolicy`, `kms:CreateGrant`, `kms:ScheduleKeyDeletion`, `iam:*`,
`sts:AssumeRole`, `secretsmanager:*`, `s3:*`, or network/infrastructure
administration permission.

The interactive IAM user `gcc-genesis-poc` is a test-only PoC identity and is
not a production signing principal. Humans have no normal per-award
production signing permission.

## CloudFormation dependency order

The role is created with Lambda trust and logging only. The KMS key can then
name that role in its explicit key policy. The separate managed policy is
explicitly dependent on the key and references its generated ARN, so the role
can exist before the final KMS identity permission is attached without a
circular dependency:

```text
execution role (trust + logging)
          |
          +--------------> production KMS key
                                  |
                                  v
                    KMS-use managed policy -> role
```

Both `DeletionPolicy` and `UpdateReplacePolicy` are `Retain` for the
production key. The template intentionally creates no alias or replacement
key and contains no hard-coded account ID, key ID, credential, or secret.

## Administrative limits and residual control-plane risk

The account administrative principal is an administrative control plane, not
a normal signing principal. Account/key administrators can potentially change
the key policy, disable the key, or otherwise alter this boundary. Therefore
this design must not claim absolute operator impossibility: the administrative
plane remains a powerful security assumption.

`iam:PassRole` and permissions to update the Lambda code or configuration are
also security-sensitive. Someone who can deploy arbitrary code using this
execution role could cause it to request KMS signatures, even without direct
KMS credentials. Those deployment and control-plane permissions must be
restricted, separately reviewed, and monitored before mainnet.

## PV-1 integration

The existing Verifier B firewall must run before any AWS signer call:

```text
structured evidence
        |
        v
PV-1 validation
        |
        v
internally reconstructed digest
        |
        v
AWS signer adapter
        |
        v
execution-role temporary credentials
        |
        v
production KMS key
```

The firewall validates the structured request and evidence, reconstructs the
award and `GenesisVerifierAuthority` attestation digests, and passes only the
internally derived 32-byte attestation digest to the restricted signer
interface. The AWS adapter must never expose a generic arbitrary-digest API
externally. Callers must not select the KMS key, signing algorithm, message
type, or digest. In production, the adapter should obtain temporary
execution-role credentials from Lambda's role environment and use trusted
configuration for the single production key, with KMS `MessageType=DIGEST` and
`SigningAlgorithm=ECDSA_SHA_256`.

The existing AWS CLI adapter remains test-only PoC code and is not the
production workload identity implementation.

## Validation and deployment boundary

`test/GenesisVerifierBAwsPolicy.test.js` parses the template locally and
checks key type/usage, explicit least-privilege statements, role trust,
dependency order, retention policies, absence of interactive users and
hard-coded secrets, and rejection of weakened policy mutations. These tests
do not call AWS.

Passing these static checks does not create resources and does not authorize
BSC mainnet deployment. The Genesis policy is still DRAFT, and independent
Verifier C, deployment-control restrictions, operational monitoring, and
separate production review remain required.
