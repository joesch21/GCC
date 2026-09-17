function createDecisionAuditRecord(config, validatedRequest, digests, decision) {
  return Object.freeze({
    decision,
    policyVersion: "0.1-draft",
    chainId: config.chainId,
    verifierAuthorityAddress: config.verifierAuthorityAddress,
    escrowAddress: config.escrowAddress,
    signerAddress: config.signerAddress,
    tenderHash: config.tenderHash,
    policyHash: config.policyHash,
    rewardClass: validatedRequest.rewardClassName,
    award: Object.freeze({
      tenderHash: validatedRequest.award.tenderHash,
      awardClass: validatedRequest.award.awardClass,
      deliverableHash: validatedRequest.award.deliverableHash,
      assessmentHash: validatedRequest.award.assessmentHash,
      recipient: validatedRequest.award.recipient,
      validUntil: validatedRequest.award.validUntil.toString(),
    }),
    assessment: Object.freeze({
      submissionId: validatedRequest.assessmentResult.submissionId,
      assessmentHash: validatedRequest.assessmentResult.computedAssessmentHash,
    }),
    awardDigest: digests.awardDigest,
    attestationDigest: digests.attestationDigest,
  });
}

module.exports = { createDecisionAuditRecord };
