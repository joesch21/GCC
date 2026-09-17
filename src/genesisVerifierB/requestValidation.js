const {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} = require("ethers");

const {
  GENESIS_TENDER_ID,
  REWARD_CLASS_HASHES,
  REWARD_CLASS_NAMES,
} = require("./configuration");

const MAX_UINT64 = (1n << 64n) - 1n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const ACCEPTED_BINDING_METHODS = Object.freeze([
  "agent identity credential binding the recipient address",
  "recipient wallet signature over the submission/tender binding challenge",
]);

const REQUEST_KEYS = Object.freeze(["award", "assessment", "evidence"]);
const AWARD_KEYS = Object.freeze([
  "tenderHash",
  "awardClass",
  "deliverableHash",
  "assessmentHash",
  "recipient",
  "validUntil",
]);
const ASSESSMENT_KEYS = Object.freeze([
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
  "assessment_hash_input_manifest",
]);
const EVIDENCE_KEYS = Object.freeze([
  "submission_manifest",
  "validation_report",
]);

const FORBIDDEN_CONTROL_FIELDS = new Set([
  "digest",
  "awardDigest",
  "award_digest",
  "attestationDigest",
  "attestation_digest",
  "signingDigest",
  "signing_digest",
  "keyId",
  "key_id",
  "kmsKeyId",
  "kms_key_id",
  "signingAlgorithm",
  "signing_algorithm",
  "messageType",
  "message_type",
  "chainId",
  "chain_id",
  "domain",
  "escrowAddress",
  "escrow_address",
  "authorityAddress",
  "authority_address",
  "verifierAuthorityAddress",
  "verifier_authority_address",
  "policyHash",
  "policy_hash",
]);

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rejectRequest(message) {
  throw requestError("GENESIS_VERIFIER_B_INVALID_REQUEST", message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, label) {
  if (!isPlainObject(value)) rejectRequest(`${label} must be an object`);
}

function requireKeys(value, expectedKeys, label) {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      rejectRequest(`${label} contains unsupported field: ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      rejectRequest(`${label} is missing required field: ${key}`);
    }
  }
}

function rejectForbiddenControlFields(value, path = "request") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectForbiddenControlFields(item, `${path}[${index}]`)
    );
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_CONTROL_FIELDS.has(key)) {
      rejectRequest(`${path}.${key} is not accepted by the signing firewall`);
    }
    rejectForbiddenControlFields(nestedValue, `${path}.${key}`);
  }
}

function normalizeHash(value, label, { allowZero = false } = {}) {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    rejectRequest(`${label} must be a 32-byte hex value`);
  }
  const normalized = value.toLowerCase();
  if (!allowZero && normalized === ZERO_BYTES32) {
    rejectRequest(`${label} must not be zero`);
  }
  return normalized;
}

function normalizeAddress(value, label) {
  let normalized;
  try {
    normalized = getAddress(value);
  } catch (_error) {
    rejectRequest(`${label} must be a valid address`);
  }
  if (normalized === "0x0000000000000000000000000000000000000000") {
    rejectRequest(`${label} must not be the zero address`);
  }
  return normalized;
}

function normalizeUint64(value, label) {
  let normalized;
  try {
    if (typeof value === "bigint") {
      normalized = value;
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new Error("not a safe integer");
      normalized = BigInt(value);
    } else if (
      typeof value === "string" &&
      /^(0|[1-9][0-9]*)$/.test(value)
    ) {
      normalized = BigInt(value);
    } else {
      throw new Error("not an unsigned integer");
    }
  } catch (_error) {
    rejectRequest(`${label} must be an unsigned integer`);
  }
  if (normalized < 0n || normalized > MAX_UINT64) {
    rejectRequest(`${label} must fit uint64`);
  }
  return normalized;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    rejectRequest(`${label} must be a non-empty string`);
  }
  return value;
}

function canonicalizeStableJson(value, path = "assessment") {
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => canonicalizeStableJson(item, `${path}[${index}]`))
      .join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeStableJson(
            value[key],
            `${path}.${key}`
          )}`
      )
      .join(",")}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  rejectRequest(`${path} contains a non-JSON value`);
}

function computeAssessmentHash(assessment) {
  return keccak256(toUtf8Bytes(canonicalizeStableJson(assessment)));
}

function validateAssessment(assessment, award, config) {
  requireObject(assessment, "assessment");
  requireKeys(assessment, ASSESSMENT_KEYS, "assessment");

  if (assessment.assessment_version !== "0.1-draft") {
    rejectRequest("assessment_version must be 0.1-draft");
  }
  const tenderHash = normalizeHash(assessment.tender_hash, "assessment.tender_hash");
  if (tenderHash !== award.tenderHash || tenderHash !== config.tenderHash) {
    rejectRequest("assessment tender_hash does not match the Award/configuration");
  }

  const submissionId = requireNonEmptyString(
    assessment.submission_id,
    "assessment.submission_id"
  );
  const deliverableHash = normalizeHash(
    assessment.deliverable_hash,
    "assessment.deliverable_hash"
  );
  if (deliverableHash !== award.deliverableHash) {
    rejectRequest("assessment deliverable_hash does not match the Award");
  }

  if (
    typeof assessment.reward_class !== "string" ||
    !REWARD_CLASS_NAMES.includes(assessment.reward_class)
  ) {
    rejectRequest("assessment.reward_class is unknown");
  }
  const expectedAwardClass = REWARD_CLASS_HASHES[assessment.reward_class];
  if (expectedAwardClass !== award.awardClass) {
    rejectRequest("assessment reward_class does not match the Award");
  }

  requireObject(assessment.gate_results, "assessment.gate_results");
  if (Object.keys(assessment.gate_results).length === 0) {
    rejectRequest("assessment.gate_results must contain at least one gate");
  }
  for (const [gateName, gate] of Object.entries(assessment.gate_results)) {
    requireObject(gate, `assessment.gate_results.${gateName}`);
    if (!["PASS", "FAIL", "NOT_APPLICABLE"].includes(gate.status)) {
      rejectRequest(`assessment.gate_results.${gateName}.status is invalid`);
    }
    if (gate.status === "FAIL") {
      rejectRequest(`assessment.gate_results.${gateName} is a failed gate`);
    }
    if (!Array.isArray(gate.evidence) || gate.evidence.length === 0) {
      rejectRequest(
        `assessment.gate_results.${gateName}.evidence must contain a reference`
      );
    }
    gate.evidence.forEach((reference, index) =>
      requireNonEmptyString(
        reference,
        `assessment.gate_results.${gateName}.evidence[${index}]`
      )
    );
  }

  requireObject(
    assessment.architectural_analysis,
    "assessment.architectural_analysis"
  );
  requireObject(assessment.security_analysis, "assessment.security_analysis");

  if (
    !Array.isArray(assessment.provenance_evidence) ||
    assessment.provenance_evidence.length === 0
  ) {
    rejectRequest("assessment.provenance_evidence requires a reference");
  }
  assessment.provenance_evidence.forEach((reference, index) =>
    requireNonEmptyString(reference, `assessment.provenance_evidence[${index}]`)
  );

  requireObject(
    assessment.recipient_binding_evidence,
    "assessment.recipient_binding_evidence"
  );
  for (const field of [
    "recipient_address",
    "binding_method",
    "binding_evidence_hash",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(assessment.recipient_binding_evidence, field)) {
      rejectRequest(
        `assessment.recipient_binding_evidence is missing required field: ${field}`
      );
    }
  }
  const boundRecipient = normalizeAddress(
    assessment.recipient_binding_evidence.recipient_address,
    "assessment.recipient_binding_evidence.recipient_address"
  );
  if (boundRecipient !== award.recipient) {
    rejectRequest("assessment recipient binding does not match the Award");
  }
  if (
    !ACCEPTED_BINDING_METHODS.includes(
      assessment.recipient_binding_evidence.binding_method
    )
  ) {
    rejectRequest("recipient binding method is not accepted by the policy");
  }
  normalizeHash(
    assessment.recipient_binding_evidence.binding_evidence_hash,
    "assessment.recipient_binding_evidence.binding_evidence_hash"
  );

  if (
    !Array.isArray(assessment.assessment_hash_input_manifest) ||
    assessment.assessment_hash_input_manifest.length === 0
  ) {
    rejectRequest("assessment_hash_input_manifest requires a reference");
  }
  assessment.assessment_hash_input_manifest.forEach((reference, index) =>
    requireNonEmptyString(
      reference,
      `assessment.assessment_hash_input_manifest[${index}]`
    )
  );

  const computedAssessmentHash = computeAssessmentHash(assessment);
  if (computedAssessmentHash !== award.assessmentHash) {
    rejectRequest("assessmentHash does not match the canonical assessment manifest");
  }

  return Object.freeze({
    submissionId,
    rewardClass: assessment.reward_class,
    computedAssessmentHash,
  });
}

function validateSubmissionManifest(manifest, award, assessment) {
  requireObject(manifest, "evidence.submission_manifest");
  const requiredFields = [
    "tender_id",
    "submission_id",
    "agent_id",
    "recipient_address",
    "submitted_at",
    "deliverable_hash",
    "deliverable_location",
    "submission_schema_version",
  ];
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(manifest, field)) {
      rejectRequest(`evidence.submission_manifest is missing required field: ${field}`);
    }
  }
  if (manifest.tender_id !== GENESIS_TENDER_ID) {
    rejectRequest("submission_manifest.tender_id is not GCC-GENESIS-001");
  }
  if (manifest.submission_id !== assessment.submissionId) {
    rejectRequest("submission_manifest.submission_id does not match assessment");
  }
  requireNonEmptyString(manifest.agent_id, "submission_manifest.agent_id");
  const recipient = normalizeAddress(
    manifest.recipient_address,
    "submission_manifest.recipient_address"
  );
  if (recipient !== award.recipient) {
    rejectRequest("submission_manifest.recipient_address does not match the Award");
  }
  const deliverableHash = normalizeHash(
    manifest.deliverable_hash,
    "submission_manifest.deliverable_hash"
  );
  if (deliverableHash !== award.deliverableHash) {
    rejectRequest("submission_manifest.deliverable_hash does not match the Award");
  }
  requireNonEmptyString(manifest.deliverable_location, "submission_manifest.deliverable_location");
  requireNonEmptyString(
    manifest.submission_schema_version,
    "submission_manifest.submission_schema_version"
  );
  const submittedAt = requireNonEmptyString(
    manifest.submitted_at,
    "submission_manifest.submitted_at"
  );
  if (!Number.isFinite(Date.parse(submittedAt))) {
    rejectRequest("submission_manifest.submitted_at must be a valid date");
  }
}

function validateValidationReport(report, award, assessment, config) {
  requireObject(report, "evidence.validation_report");
  const requiredFields = [
    "submission_id",
    "tender_hash",
    "deliverable_hash",
    "schema_valid",
    "mandatory_sections_present",
    "provenance_present",
    "duplicate_review",
    "secret_request_check",
    "security_boundary_present",
    "failure_modes_present",
  ];
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(report, field)) {
      rejectRequest(`evidence.validation_report is missing required field: ${field}`);
    }
  }
  if (report.submission_id !== assessment.submissionId) {
    rejectRequest("validation_report.submission_id does not match assessment");
  }
  if (
    normalizeHash(report.tender_hash, "validation_report.tender_hash") !==
    config.tenderHash
  ) {
    rejectRequest("validation_report.tender_hash does not match configuration");
  }
  if (
    normalizeHash(report.deliverable_hash, "validation_report.deliverable_hash") !==
    award.deliverableHash
  ) {
    rejectRequest("validation_report.deliverable_hash does not match the Award");
  }
  if (report.schema_valid !== true) {
    rejectRequest("validation_report.schema_valid must be true");
  }
  if (report.mandatory_sections_present !== true) {
    rejectRequest("validation_report.mandatory_sections_present must be true");
  }
  if (report.provenance_present !== true) {
    rejectRequest("validation_report.provenance_present must be true");
  }
  if (report.secret_request_check !== "PASS") {
    rejectRequest("validation_report.secret_request_check must be PASS");
  }
  if (report.security_boundary_present !== true) {
    rejectRequest("validation_report.security_boundary_present must be true");
  }
  if (report.failure_modes_present !== true) {
    rejectRequest("validation_report.failure_modes_present must be true");
  }
  if (
    typeof report.duplicate_review !== "string" ||
    report.duplicate_review.trim() === "" ||
    report.duplicate_review === "DISQUALIFY"
  ) {
    rejectRequest("validation_report.duplicate_review is not acceptable");
  }
}

function nowSeconds(clock) {
  let value;
  try {
    value = typeof clock === "function" ? clock() : Math.floor(Date.now() / 1000);
  } catch (_error) {
    rejectRequest("trusted clock failed");
  }
  return normalizeUint64(value, "trusted current time");
}

function validateGenesisRequest(request, config, clock) {
  rejectForbiddenControlFields(request);
  requireObject(request, "request");
  requireKeys(request, REQUEST_KEYS, "request");
  requireObject(request.award, "award");
  requireKeys(request.award, AWARD_KEYS, "award");

  const award = {
    tenderHash: normalizeHash(request.award.tenderHash, "award.tenderHash"),
    awardClass: normalizeHash(request.award.awardClass, "award.awardClass"),
    deliverableHash: normalizeHash(
      request.award.deliverableHash,
      "award.deliverableHash"
    ),
    assessmentHash: normalizeHash(
      request.award.assessmentHash,
      "award.assessmentHash"
    ),
    recipient: normalizeAddress(request.award.recipient, "award.recipient"),
    validUntil: normalizeUint64(request.award.validUntil, "award.validUntil"),
  };

  if (award.tenderHash !== config.tenderHash) {
    rejectRequest("award.tenderHash does not match the pinned Genesis tender");
  }
  const rewardClassName = REWARD_CLASS_NAMES.find(
    (name) => REWARD_CLASS_HASHES[name] === award.awardClass
  );
  if (!rewardClassName || !config.allowedRewardClasses.includes(rewardClassName)) {
    rejectRequest("award.awardClass is not an allowed Genesis reward class");
  }

  const currentTime = nowSeconds(clock);
  if (award.validUntil <= currentTime) {
    rejectRequest("award.validUntil is expired");
  }
  if (
    award.validUntil >
    currentTime + config.maxAwardValidityHorizonSeconds
  ) {
    rejectRequest("award.validUntil exceeds the configured validity horizon");
  }

  const assessmentResult = validateAssessment(request.assessment, award, config);

  requireObject(request.evidence, "evidence");
  requireKeys(request.evidence, EVIDENCE_KEYS, "evidence");
  validateSubmissionManifest(
    request.evidence.submission_manifest,
    award,
    assessmentResult
  );
  validateValidationReport(
    request.evidence.validation_report,
    award,
    assessmentResult,
    config
  );

  return Object.freeze({
    award: Object.freeze(award),
    assessment: request.assessment,
    assessmentResult,
    evidence: request.evidence,
    currentTime,
    rewardClassName,
  });
}

module.exports = {
  ACCEPTED_BINDING_METHODS,
  canonicalizeStableJson,
  computeAssessmentHash,
  validateGenesisRequest,
};
