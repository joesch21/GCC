const {
  assertExpectedOutput,
  assertIssueWindow,
  buildCanonicalRequest,
  parseExpectedOutput,
  parseSubmissionBody,
  requireSubmissionFields,
  verifyRecipientBinding,
  intakeError,
} = require("./submission");
const {
  fetchArtifact,
  sourceHasCanonicalDiscoveryReference,
  verifyNetworkedAndOfflineRuns,
} = require("./sandbox");

async function evaluateGithubIssue(options) {
  const issue = options.issue;
  const comments = options.comments || [];
  const record = options.record;
  const synthetic = Boolean(options.synthetic);

  if (!issue || typeof issue !== "object") {
    throw intakeError("GENESIS_INTAKE_ISSUE_INVALID", "Issue is required");
  }
  if (!String(issue.title || "").startsWith("[GCC-GENESIS-001]")) {
    throw intakeError(
      "GENESIS_INTAKE_TITLE_INVALID",
      "Issue title must start with [GCC-GENESIS-001]"
    );
  }

  const fields = parseSubmissionBody(issue.body || "");
  requireSubmissionFields(fields);
  if (synthetic && fields.synthetic_test !== "true") {
    throw intakeError(
      "GENESIS_INTAKE_SYNTHETIC_MARKER_REQUIRED",
      "Synthetic dry-runs require synthetic_test: true"
    );
  }
  assertIssueWindow(issue, record, synthetic);

  const binding = verifyRecipientBinding(fields, comments);
  if (binding.status === "AWAITING_SIGNATURE") {
    return Object.freeze({
      status: "AWAITING_SIGNATURE",
      challenge: binding.challenge,
      fields,
    });
  }

  const artifactFetcher = options.artifactFetcher || fetchArtifact;
  const artifact = await artifactFetcher(fields.deliverable_url);
  if (artifact.hash !== fields.deliverable_hash.toLowerCase()) {
    throw intakeError(
      "GENESIS_INTAKE_DELIVERABLE_HASH_MISMATCH",
      "Fetched bytes do not match deliverable_hash"
    );
  }
  if (!sourceHasCanonicalDiscoveryReference(artifact.bytes)) {
    throw intakeError(
      "GENESIS_INTAKE_DISCOVERY_REFERENCE_MISSING",
      "Deliverable source does not reference the canonical discovery URL"
    );
  }

  const claimedOutput = parseExpectedOutput(fields.observed_output);
  assertExpectedOutput(claimedOutput, "observed_output");

  const runner =
    options.sandboxVerifier ||
    ((sandboxOptions) => verifyNetworkedAndOfflineRuns(sandboxOptions));
  const sandbox = runner({
    bytes: artifact.bytes,
    deliverableUrl: artifact.finalUrl || fields.deliverable_url,
    runtime: fields.runtime,
    runCommand: fields.run_command,
    discoveryOverride: options.discoveryOverride || null,
  });

  if (JSON.stringify(sandbox.networkedOutput) !== JSON.stringify(claimedOutput)) {
    throw intakeError(
      "GENESIS_INTAKE_OBSERVED_OUTPUT_MISMATCH",
      "observed_output does not match sandbox output"
    );
  }

  const request = buildCanonicalRequest({
    record,
    issue,
    fields,
    binding,
    deliverableHash: artifact.hash,
    nowSeconds: options.nowSeconds,
  });

  return Object.freeze({
    status: "QUALIFIED",
    fields,
    binding,
    artifactHash: artifact.hash,
    sandbox: {
      networkedStatus: sandbox.networked.status,
      networkDisabledStatus: sandbox.offline.status,
      output: sandbox.networkedOutput,
    },
    request,
  });
}

module.exports = {
  evaluateGithubIssue,
};
