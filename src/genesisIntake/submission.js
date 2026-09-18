const {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
} = require("ethers");
const {
  GENESIS_POLICY_VERSION,
  REWARD_CLASS_HASHES,
} = require("../genesisVerifierB/configuration");
const {
  computeAssessmentHash,
} = require("../genesisVerifierB/requestValidation");

const TENDER_ID = "GCC-GENESIS-001";
const TITLE_PREFIX = "[GCC-GENESIS-001]";
const SUBMISSION_WINDOW_SECONDS = 14 * 24 * 60 * 60;
const REQUIRED_FIELDS = Object.freeze([
  "submission_id",
  "agent_id",
  "recipient_address",
  "deliverable_url",
  "deliverable_hash",
  "runtime",
  "run_command",
  "observed_output",
]);
const EXPECTED_OUTPUT = Object.freeze({
  tender_id: TENDER_ID,
  chain_id: 56,
  total_budget_gcc: "100",
  reward_per_valid_submission_gcc: "10",
  task_id: "gcc-discovery-client",
  status: "PASS",
});

function intakeError(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function parseSubmissionBody(body) {
  if (typeof body !== "string") {
    throw intakeError("GENESIS_INTAKE_BODY_INVALID", "Issue body must be text");
  }
  const fields = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      throw intakeError(
        "GENESIS_INTAKE_DUPLICATE_FIELD",
        "Submission repeats field: " + key
      );
    }
    fields[key] = value;
  }
  return fields;
}

function requireSubmissionFields(fields) {
  for (const field of REQUIRED_FIELDS) {
    if (!fields[field] || typeof fields[field] !== "string") {
      throw intakeError(
        "GENESIS_INTAKE_MISSING_FIELD",
        "Submission is missing required field: " + field
      );
    }
  }
}

function normalizeRecipient(value) {
  let address;
  try {
    address = getAddress(value);
  } catch (_error) {
    throw intakeError(
      "GENESIS_INTAKE_RECIPIENT_INVALID",
      "recipient_address must be a valid EVM address"
    );
  }
  if (address === "0x0000000000000000000000000000000000000000") {
    throw intakeError(
      "GENESIS_INTAKE_RECIPIENT_INVALID",
      "recipient_address must not be zero"
    );
  }
  return address;
}

function normalizeHash(value, label) {
  const zero = "0x" + "00".repeat(32);
  if (
    typeof value !== "string" ||
    !isHexString(value, 32) ||
    value.toLowerCase() === zero
  ) {
    throw intakeError(
      "GENESIS_INTAKE_HASH_INVALID",
      label + " must be a non-zero 32-byte hex value"
    );
  }
  return value.toLowerCase();
}

function parseExpectedOutput(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    throw intakeError(
      "GENESIS_INTAKE_OUTPUT_INVALID",
      "observed_output must be a one-line JSON object"
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw intakeError(
      "GENESIS_INTAKE_OUTPUT_INVALID",
      "observed_output must be a JSON object"
    );
  }
  return parsed;
}

function assertExpectedOutput(value, label) {
  const expectedKeys = Object.keys(EXPECTED_OUTPUT);
  if (Object.keys(value).length !== expectedKeys.length) {
    throw intakeError(
      "GENESIS_INTAKE_OUTPUT_MISMATCH",
      label + " has unexpected fields"
    );
  }
  for (const key of expectedKeys) {
    if (value[key] !== EXPECTED_OUTPUT[key]) {
      throw intakeError(
        "GENESIS_INTAKE_OUTPUT_MISMATCH",
        label + "." + key + " does not match the tender"
      );
    }
  }
}

function recipientBindingChallenge(fields) {
  const recipient = normalizeRecipient(fields.recipient_address);
  const deliverableHash = normalizeHash(
    fields.deliverable_hash,
    "deliverable_hash"
  );
  const submissionId = String(fields.submission_id || "").trim();
  if (!submissionId) {
    throw intakeError(
      "GENESIS_INTAKE_MISSING_FIELD",
      "submission_id is required"
    );
  }
  return [
    "GCC Genesis I recipient binding",
    "tender_id:" + TENDER_ID,
    "submission_id:" + submissionId,
    "deliverable_hash:" + deliverableHash,
    "recipient_address:" + recipient,
  ].join("\n");
}

function findRecipientSignature(fields, comments) {
  if (fields.recipient_signature) return fields.recipient_signature.trim();
  for (const comment of comments || []) {
    const parsed = parseSubmissionBody(String(comment.body || ""));
    if (parsed.recipient_signature) return parsed.recipient_signature.trim();
  }
  return null;
}

function verifyRecipientBinding(fields, comments) {
  const challenge = recipientBindingChallenge(fields);
  const signature = findRecipientSignature(fields, comments);
  if (!signature) {
    return Object.freeze({ status: "AWAITING_SIGNATURE", challenge });
  }
  if (!isHexString(signature, 65)) {
    throw intakeError(
      "GENESIS_INTAKE_RECIPIENT_SIGNATURE_INVALID",
      "recipient_signature must be a 65-byte EVM signature"
    );
  }
  let recovered;
  try {
    recovered = getAddress(verifyMessage(challenge, signature));
  } catch (_error) {
    throw intakeError(
      "GENESIS_INTAKE_RECIPIENT_SIGNATURE_INVALID",
      "recipient_signature could not be verified"
    );
  }
  const recipient = normalizeRecipient(fields.recipient_address);
  if (recovered !== recipient) {
    throw intakeError(
      "GENESIS_INTAKE_RECIPIENT_SIGNATURE_INVALID",
      "recipient_signature does not recover recipient_address"
    );
  }
  const bindingEvidenceHash = keccak256(
    toUtf8Bytes(
      challenge + "\nrecipient_signature:" + signature.toLowerCase()
    )
  );
  return Object.freeze({
    status: "VERIFIED",
    challenge,
    signature,
    recipient,
    bindingEvidenceHash,
  });
}

function submissionWindow(record) {
  const opensAtMs = Date.parse(record.escrow.plannedOpeningIso);
  if (!Number.isFinite(opensAtMs)) {
    throw intakeError(
      "GENESIS_INTAKE_CONFIG_INVALID",
      "Deployment record opening timestamp is invalid"
    );
  }
  const closesAtMs = opensAtMs + SUBMISSION_WINDOW_SECONDS * 1000;
  return Object.freeze({
    opensAtMs,
    closesAtMs,
    opensAtIso: new Date(opensAtMs).toISOString(),
    closesAtIso: new Date(closesAtMs).toISOString(),
  });
}

function assertIssueWindow(issue, record, synthetic) {
  const createdAt = Date.parse(issue.created_at);
  if (!Number.isFinite(createdAt)) {
    throw intakeError(
      "GENESIS_INTAKE_ISSUE_TIME_INVALID",
      "Issue created_at is invalid"
    );
  }
  const window = submissionWindow(record);
  if (synthetic) return window;
  if (createdAt < window.opensAtMs || createdAt >= window.closesAtMs) {
    throw intakeError(
      "GENESIS_INTAKE_OUTSIDE_SUBMISSION_WINDOW",
      "Submission is outside the public submission window"
    );
  }
  return window;
}

function buildCanonicalRequest(options) {
  const record = options.record;
  const issue = options.issue;
  const fields = options.fields;
  const binding = options.binding;
  const deliverableHash = options.deliverableHash;
  const nowSeconds =
    options.nowSeconds === undefined
      ? Math.floor(Date.now() / 1000)
      : options.nowSeconds;
  const deadline = Number(record.escrow.settlementDeadlineUnix);
  const validUntil = Math.min(nowSeconds + 3600, deadline);
  if (!Number.isSafeInteger(validUntil) || validUntil <= nowSeconds) {
    throw intakeError(
      "GENESIS_INTAKE_SETTLEMENT_CLOSED",
      "No settlement authorization window remains"
    );
  }

  const recipient = normalizeRecipient(fields.recipient_address);
  const issueRef = String(issue.html_url || issue.url || "");
  const assessment = {
    assessment_version: GENESIS_POLICY_VERSION,
    tender_hash: record.hashes.tender.toLowerCase(),
    submission_id: fields.submission_id.trim(),
    deliverable_hash: deliverableHash,
    reward_class: "QUALIFIED_PROPOSAL",
    gate_results: {
      objective_qualification: {
        status: "PASS",
        evidence: [
          "github_issue:" + issue.number,
          "deliverable:" + fields.deliverable_url,
          "sandbox:networked-pass",
          "sandbox:network-disabled-not-pass",
          "recipient-binding:wallet-signature",
        ],
      },
    },
    architectural_analysis: {
      summary:
        "Objective Genesis I discovery-client checks passed; no ranking used.",
    },
    security_analysis: {
      summary:
        "Artifact ran in a disposable unprivileged container with no host secrets.",
    },
    provenance_evidence: [
      issueRef || "github_issue:" + issue.number,
      fields.deliverable_url,
    ],
    recipient_binding_evidence: {
      recipient_address: recipient,
      binding_method:
        "recipient wallet signature over the submission/tender binding challenge",
      binding_evidence_hash: binding.bindingEvidenceHash,
    },
    assessment_hash_input_manifest: [
      "github_issue:" + issue.number,
      "deliverable_hash:" + deliverableHash,
      "recipient_binding_hash:" + binding.bindingEvidenceHash,
      "validation_report:objective-pass",
    ],
  };
  const assessmentHash = computeAssessmentHash(assessment);

  return Object.freeze({
    award: {
      tenderHash: record.hashes.tender.toLowerCase(),
      awardClass: REWARD_CLASS_HASHES.QUALIFIED_PROPOSAL,
      deliverableHash,
      assessmentHash,
      recipient,
      validUntil: String(validUntil),
    },
    assessment,
    evidence: {
      submission_manifest: {
        tender_id: TENDER_ID,
        submission_id: fields.submission_id.trim(),
        agent_id: fields.agent_id.trim(),
        recipient_address: recipient,
        submitted_at: issue.created_at,
        deliverable_hash: deliverableHash,
        deliverable_location: fields.deliverable_url,
        submission_schema_version: "1.0",
      },
      validation_report: {
        submission_id: fields.submission_id.trim(),
        tender_hash: record.hashes.tender.toLowerCase(),
        deliverable_hash: deliverableHash,
        schema_valid: true,
        mandatory_sections_present: true,
        provenance_present: true,
        duplicate_review: "CLEAR_ONCHAIN_RECHECK_REQUIRED",
        secret_request_check: "PASS",
        security_boundary_present: true,
        failure_modes_present: true,
      },
    },
  });
}

function challengeComment(challenge) {
  return [
    "<!-- gcc-genesis-recipient-challenge -->",
    "Genesis I requires proof that the declared payout address is controlled by the submitting agent.",
    "",
    "Sign this exact message with recipient_address using EVM personal_sign or signMessage. This costs no gas and never reveals the private key.",
    "",
    "BEGIN SIGNED MESSAGE",
    challenge,
    "END SIGNED MESSAGE",
    "",
    "Reply with: recipient_signature: 0x...",
  ].join("\n");
}

module.exports = {
  EXPECTED_OUTPUT,
  REQUIRED_FIELDS,
  SUBMISSION_WINDOW_SECONDS,
  TENDER_ID,
  TITLE_PREFIX,
  assertExpectedOutput,
  assertIssueWindow,
  buildCanonicalRequest,
  challengeComment,
  findRecipientSignature,
  intakeError,
  normalizeHash,
  normalizeRecipient,
  parseExpectedOutput,
  parseSubmissionBody,
  recipientBindingChallenge,
  requireSubmissionFields,
  submissionWindow,
  verifyRecipientBinding,
};
