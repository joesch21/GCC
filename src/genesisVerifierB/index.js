const {
  loadProductionConfig,
  normalizeProductionConfig,
} = require("./configuration");
const { constructGenesisDigests } = require("./digestConstruction");
const { createDecisionAuditRecord } = require("./auditRecord");
const { validateGenesisRequest } = require("./requestValidation");
const {
  assertSignerInterface,
} = require("./signer");

function signingDisabledError() {
  const error = new Error(
    "Genesis Verifier B production signing is disabled by configuration"
  );
  error.code = "GENESIS_VERIFIER_B_SIGNING_DISABLED";
  return error;
}

function createGenesisVerifierB({ config, signer, clock } = {}) {
  const trustedConfig = normalizeProductionConfig(config);
  assertSignerInterface(signer, trustedConfig.signerAddress);

  function evaluate(request) {
    const validatedRequest = validateGenesisRequest(
      request,
      trustedConfig,
      clock
    );
    const digests = constructGenesisDigests(
      trustedConfig,
      validatedRequest.award
    );
    return Object.freeze({
      validatedRequest,
      digests,
      audit: createDecisionAuditRecord(
        trustedConfig,
        validatedRequest,
        digests,
        trustedConfig.signingEnabled ? "READY_TO_SIGN" : "SIGNING_DISABLED"
      ),
    });
  }

  return Object.freeze({
    evaluateGenesisAward(request) {
      return evaluate(request).audit;
    },

    async signGenesisAttestation(request) {
      const evaluated = evaluate(request);
      if (!trustedConfig.signingEnabled) throw signingDisabledError();

      const signature = await signer.signGenesisAttestationDigest(
        evaluated.digests.attestationDigest
      );
      return Object.freeze({
        signature,
        audit: createDecisionAuditRecord(
          trustedConfig,
          evaluated.validatedRequest,
          evaluated.digests,
          "SIGNED"
        ),
      });
    },
  });
}

function createGenesisVerifierBFromEnvironment({ signer, environment, clock } = {}) {
  return createGenesisVerifierB({
    config: loadProductionConfig(environment),
    signer,
    clock,
  });
}

module.exports = {
  createGenesisVerifierB,
  createGenesisVerifierBFromEnvironment,
  loadProductionConfig,
};
