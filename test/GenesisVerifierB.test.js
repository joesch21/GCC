const { expect } = require("chai");
const fs = require("fs");
const { ethers } = require("hardhat");

const {
  createGenesisVerifierB,
  loadProductionConfig,
} = require("../src/genesisVerifierB");
const {
  computeAssessmentHash,
} = require("../src/genesisVerifierB/requestValidation");
const {
  REWARD_CLASS_HASHES,
} = require("../src/genesisVerifierB/configuration");

const POLICY_HASH = fs
  .readFileSync(
    "policies/GCC-GENESIS-001.verifier-policy.keccak256",
    "utf8"
  )
  .trim();
const NOW = 1700000000n;
const HORIZON = 24n * 60n * 60n;
const ACCEPTED_BINDING_METHOD =
  "agent identity credential binding the recipient address";

describe("Genesis Verifier B signing firewall", function () {
  let signer;
  let authorityAddress;
  let escrowAddress;
  let recipient;
  let otherRecipient;
  let tenderHash;

  beforeEach(async function () {
    [, signer, authorityAddress, escrowAddress, recipient, otherRecipient] =
      await ethers.getSigners();
    tenderHash = ethers.keccak256(ethers.toUtf8Bytes("configured Genesis tender"));
  });

  function config(overrides = {}) {
    return {
      signingEnabled: true,
      chainId: 56,
      verifierAuthorityAddress: authorityAddress.address,
      escrowAddress: escrowAddress.address,
      escrowDomain: {
        name: "GCC Genesis Deliverable Escrow",
        version: "1",
      },
      authorityDomain: {
        name: "GCC Genesis Verifier Authority",
        version: "1",
      },
      tenderHash,
      policyHash: POLICY_HASH,
      allowedRewardClasses: ["QUALIFIED_PROPOSAL"],
      signerAddress: signer.address,
      maxAwardValidityHorizonSeconds: HORIZON,
      ...overrides,
    };
  }

  function assessment(overrides = {}) {
    return {
      assessment_version: "0.3-draft",
      tender_hash: tenderHash,
      submission_id: "submission-001",
      deliverable_hash: ethers.keccak256(ethers.toUtf8Bytes("deliverable-001")),
      reward_class: "QUALIFIED_PROPOSAL",
      gate_results: {
        common: {
          status: "PASS",
          evidence: ["ref:validation-report/common"],
        },
      },
      architectural_analysis: {
        summary: "Architecture reviewed against the tender requirements.",
      },
      security_analysis: {
        summary: "Security boundaries and failure modes were reviewed.",
      },
      provenance_evidence: ["ref:submission-manifest/deliverable"],
      recipient_binding_evidence: {
        recipient_address: recipient.address,
        binding_method: ACCEPTED_BINDING_METHOD,
        binding_evidence_hash: ethers.keccak256(
          ethers.toUtf8Bytes("recipient-binding-evidence")
        ),
      },
      assessment_hash_input_manifest: [
        "assessment_version",
        "tender_hash",
        "submission_id",
        "deliverable_hash",
        "reward_class",
        "gate_results",
        "architectural_analysis",
        "security_analysis",
        "provenance_evidence",
        "recipient_binding_evidence",
      ],
      ...overrides,
    };
  }

  function validRequest(overrides = {}) {
    const baseAssessment = assessment();
    const award = {
      tenderHash,
      awardClass: REWARD_CLASS_HASHES.QUALIFIED_PROPOSAL,
      deliverableHash: baseAssessment.deliverable_hash,
      assessmentHash: computeAssessmentHash(baseAssessment),
      recipient: recipient.address,
      validUntil: (NOW + 3600n).toString(),
    };
    return {
      award: { ...award, ...(overrides.award || {}) },
      assessment: overrides.assessment || baseAssessment,
      evidence: overrides.evidence || {
        submission_manifest: {
          tender_id: "GCC-GENESIS-001",
          submission_id: "submission-001",
          agent_id: "agent-001",
          recipient_address: recipient.address,
          submitted_at: "2026-09-17T00:00:00.000Z",
          deliverable_hash: baseAssessment.deliverable_hash,
          deliverable_location: "content-addressed://deliverable-001",
          submission_schema_version: "0.1",
        },
        validation_report: {
          submission_id: "submission-001",
          tender_hash: tenderHash,
          deliverable_hash: baseAssessment.deliverable_hash,
          schema_valid: true,
          mandatory_sections_present: true,
          provenance_present: true,
          duplicate_review: "CLEAR",
          secret_request_check: "PASS",
          security_boundary_present: true,
          failure_modes_present: true,
        },
      },
    };
  }

  function testVerifier(configOverrides = {}) {
    const calls = [];
    const fakeSigner = {
      signerAddress: signer.address,
      async signGenesisAttestationDigest(digest) {
        calls.push(digest);
        return "0x1234";
      },
    };
    return {
      calls,
      fakeSigner,
      verifier: createGenesisVerifierB({
        config: config(configOverrides),
        signer: fakeSigner,
        clock: () => NOW,
      }),
    };
  }

  async function expectReject(action, code = "GENESIS_VERIFIER_B_INVALID_REQUEST") {
    try {
      await action();
      expect.fail("expected the signing firewall to reject the request");
    } catch (error) {
      expect(error.code).to.equal(code);
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  it("rejects arbitrary digest injection", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.digest = ethers.keccak256(ethers.toUtf8Bytes("arbitrary"));
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects the wrong tender", async function () {
    const { verifier } = testVerifier();
    const request = validRequest({
      award: { tenderHash: ethers.keccak256(ethers.toUtf8Bytes("wrong tender")) },
    });
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects a caller-supplied wrong policy binding", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.policyHash = ethers.keccak256(ethers.toUtf8Bytes("wrong policy"));
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects a caller-supplied wrong chain", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.chainId = 1;
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects a caller-supplied wrong authority", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.authorityAddress = otherRecipient.address;
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects a caller-supplied wrong escrow or domain", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.domain = {
      name: "not Genesis",
      version: "99",
      verifyingContract: otherRecipient.address,
    };
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects a zero recipient", async function () {
    const { verifier } = testVerifier();
    const request = validRequest({
      award: { recipient: "0x0000000000000000000000000000000000000000" },
    });
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects an expired award", async function () {
    const { verifier } = testVerifier();
    const request = validRequest({ award: { validUntil: (NOW - 1n).toString() } });
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects an excessive validity window", async function () {
    const { verifier } = testVerifier();
    const request = validRequest({
      award: { validUntil: (NOW + HORIZON + 1n).toString() },
    });
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects a malformed deliverableHash", async function () {
    const { verifier } = testVerifier();
    const request = validRequest({ award: { deliverableHash: "0x1234" } });
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects a malformed assessmentHash", async function () {
    const { verifier } = testVerifier();
    const request = validRequest({ award: { assessmentHash: "0x1234" } });
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects an assessmentHash mismatch", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.assessment.architectural_analysis.summary = "changed";
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects an assessment recipient mismatch", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.assessment.recipient_binding_evidence.recipient_address =
      otherRecipient.address;
    request.award.assessmentHash = computeAssessmentHash(request.assessment);
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects an assessment deliverable mismatch", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.assessment.deliverable_hash = ethers.keccak256(
      ethers.toUtf8Bytes("other deliverable")
    );
    request.award.assessmentHash = computeAssessmentHash(request.assessment);
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects an assessment reward-class mismatch", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.assessment.reward_class = "FINALIST";
    request.award.assessmentHash = computeAssessmentHash(request.assessment);
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects an unknown reward class", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.assessment.reward_class = "UNKNOWN_CLASS";
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects missing mandatory evidence references", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.assessment.provenance_evidence = [];
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects a caller-supplied KMS key identifier", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.kmsKeyId = "caller-controlled-key";
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects a caller-supplied signing algorithm", async function () {
    const { verifier } = testVerifier();
    const request = validRequest();
    request.signingAlgorithm = "ECDSA_SHA_256";
    await expectReject(() => verifier.signGenesisAttestation(request));
  });

  it("rejects signing-disabled mode without invoking the signer", async function () {
    const { verifier, calls } = testVerifier({ signingEnabled: false });
    await expectReject(
      () => verifier.signGenesisAttestation(validRequest()),
      "GENESIS_VERIFIER_B_SIGNING_DISABLED"
    );
    expect(calls).to.deep.equal([]);
  });

  it("fails closed when trusted production configuration is incomplete", function () {
    try {
      loadProductionConfig({});
      expect.fail("expected incomplete production configuration to fail closed");
    } catch (error) {
      expect(error.code).to.equal("GENESIS_VERIFIER_B_INCOMPLETE_CONFIGURATION");
    };
  });

  it("presents exactly one internally-derived digest equivalent to Solidity", async function () {
    const Authority = await ethers.getContractFactory("GenesisVerifierAuthority");
    const authority = await Authority.deploy(
      POLICY_HASH,
      signer.address,
      authorityAddress.address,
      escrowAddress.address
    );
    await authority.waitForDeployment();

    const latest = await ethers.provider.getBlock("latest");
    const settlementDeadline = BigInt(latest.timestamp + 7 * 24 * 60 * 60);
    const MockGCC = await ethers.getContractFactory("MockGCC");
    const token = await MockGCC.deploy();
    await token.waitForDeployment();
    const Escrow = await ethers.getContractFactory("GenesisDeliverableEscrow");
    const escrow = await Escrow.deploy(
      await token.getAddress(),
      await authority.getAddress(),
      tenderHash,
      settlementDeadline,
      1,
      1,
      0,
      0,
      0,
      0
    );
    await escrow.waitForDeployment();

    const current = BigInt(latest.timestamp);
    const baseAssessment = assessment();
    const award = {
      tenderHash,
      awardClass: await escrow.QUALIFIED_PROPOSAL(),
      deliverableHash: baseAssessment.deliverable_hash,
      assessmentHash: computeAssessmentHash(baseAssessment),
      recipient: recipient.address,
      validUntil: current + 3600n,
    };
    const request = {
      award: { ...award, validUntil: award.validUntil.toString() },
      assessment: baseAssessment,
      evidence: validRequest().evidence,
    };
    const calls = [];
    const fakeSigner = {
      signerAddress: signer.address,
      async signGenesisAttestationDigest(digest) {
        calls.push(digest);
        return "0x1234";
      },
    };
    const verifier = createGenesisVerifierB({
      config: config({
        verifierAuthorityAddress: await authority.getAddress(),
        escrowAddress: await escrow.getAddress(),
        signerAddress: signer.address,
      }),
      signer: fakeSigner,
      clock: () => current,
    });

    const result = await verifier.signGenesisAttestation(request);
    const solidityAwardDigest = await escrow.awardDigest(award);
    const solidityAttestationDigest = await authority.attestationDigest(
      solidityAwardDigest
    );

    expect(result.audit.awardDigest).to.equal(solidityAwardDigest);
    expect(result.audit.attestationDigest).to.equal(solidityAttestationDigest);
    expect(calls).to.deep.equal([solidityAttestationDigest]);
  });
});
