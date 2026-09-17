const { TypedDataEncoder } = require("ethers");

const {
  ATTESTATION_TYPES,
  AWARD_TYPES,
} = require("./configuration");

function constructAwardDigest(config, award) {
  return TypedDataEncoder.hash(
    {
      name: config.escrowDomain.name,
      version: config.escrowDomain.version,
      chainId: config.chainId,
      verifyingContract: config.escrowAddress,
    },
    AWARD_TYPES,
    {
      tenderHash: award.tenderHash,
      awardClass: award.awardClass,
      deliverableHash: award.deliverableHash,
      assessmentHash: award.assessmentHash,
      recipient: award.recipient,
      validUntil: award.validUntil,
    }
  );
}

function constructAttestationDigest(config, awardDigest) {
  return TypedDataEncoder.hash(
    {
      name: config.authorityDomain.name,
      version: config.authorityDomain.version,
      chainId: config.chainId,
      verifyingContract: config.verifierAuthorityAddress,
    },
    ATTESTATION_TYPES,
    {
      awardDigest,
      policyHash: config.policyHash,
    }
  );
}

function constructGenesisDigests(config, award) {
  const awardDigest = constructAwardDigest(config, award);
  const attestationDigest = constructAttestationDigest(config, awardDigest);
  return Object.freeze({ awardDigest, attestationDigest });
}

module.exports = {
  constructAttestationDigest,
  constructAwardDigest,
  constructGenesisDigests,
};
