// TEST-ONLY: provider-neutral adapter for external secp256k1 verifier fixtures.
// This module has no provider, network, custody, or production-authority code.

const { ethers } = require("ethers");

const GENESIS_CHAIN_ID = 56;
const GENESIS_DOMAIN_NAME = "GCC Genesis Verifier Authority";
const GENESIS_DOMAIN_VERSION = "1";
const ATTESTATION_TYPES = {
  Attestation: [
    { name: "awardDigest", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
  ],
};

const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

function malformedDer(message) {
  return new Error(`Malformed DER signature: ${message}`);
}

function readDerLength(bytes, offset) {
  if (offset >= bytes.length) throw malformedDer("missing length");

  const first = bytes[offset++];
  if ((first & 0x80) === 0) return { length: first, offset };

  const octetCount = first & 0x7f;
  if (octetCount === 0) throw malformedDer("indefinite length is not allowed");
  if (octetCount > 2) throw malformedDer("length is too large");
  if (offset + octetCount > bytes.length) {
    throw malformedDer("truncated length");
  }
  if (bytes[offset] === 0) throw malformedDer("non-minimal length");

  let length = 0;
  for (let i = 0; i < octetCount; i++) {
    length = (length << 8) | bytes[offset + i];
  }
  if (length < 0x80) throw malformedDer("non-minimal long-form length");

  return { length, offset: offset + octetCount };
}

function readDerInteger(bytes, offset, end, label) {
  if (offset >= end || bytes[offset++] !== 0x02) {
    throw malformedDer(`missing ${label} INTEGER`);
  }

  const lengthResult = readDerLength(bytes, offset);
  offset = lengthResult.offset;
  const integerEnd = offset + lengthResult.length;
  if (lengthResult.length === 0 || integerEnd > end) {
    throw malformedDer(`truncated ${label} INTEGER`);
  }

  const first = bytes[offset];
  if ((first & 0x80) !== 0) throw malformedDer(`${label} INTEGER is negative`);
  if (
    lengthResult.length > 1 &&
    first === 0 &&
    (bytes[offset + 1] & 0x80) === 0
  ) {
    throw malformedDer(`${label} INTEGER has redundant padding`);
  }

  let value = 0n;
  for (let i = offset; i < integerEnd; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }

  if (value === 0n || value >= SECP256K1_ORDER) {
    throw new Error(`Invalid ${label} scalar`);
  }

  return { value, offset: integerEnd };
}

function parseDerSignature(derSignature) {
  let bytes;
  try {
    bytes = ethers.getBytes(derSignature);
  } catch (_error) {
    throw malformedDer("expected a byte string or hex string");
  }

  if (bytes.length < 8 || bytes[0] !== 0x30) {
    throw malformedDer("expected a SEQUENCE");
  }

  const sequenceLength = readDerLength(bytes, 1);
  const sequenceStart = sequenceLength.offset;
  const sequenceEnd = sequenceStart + sequenceLength.length;
  if (sequenceEnd !== bytes.length) {
    throw malformedDer("SEQUENCE length does not match input");
  }

  const rResult = readDerInteger(bytes, sequenceStart, sequenceEnd, "r");
  const sResult = readDerInteger(bytes, rResult.offset, sequenceEnd, "s");
  if (sResult.offset !== sequenceEnd) {
    throw malformedDer("trailing data");
  }

  return { r: rResult.value, s: sResult.value };
}

function normalizeSecp256k1Signature({ r, s }) {
  if (r <= 0n || r >= SECP256K1_ORDER) throw new Error("Invalid r scalar");
  if (s <= 0n || s >= SECP256K1_ORDER) throw new Error("Invalid s scalar");

  if (s > SECP256K1_HALF_ORDER) {
    return {
      r,
      s: SECP256K1_ORDER - s,
      highSNormalized: true,
    };
  }

  return { r, s, highSNormalized: false };
}

function computeAttestationDigest({
  authorityAddress,
  chainId,
  policyHash,
  awardDigest,
}) {
  let numericChainId;
  try {
    numericChainId = BigInt(chainId);
  } catch (_error) {
    throw new Error("chainId must be 56");
  }
  if (numericChainId !== BigInt(GENESIS_CHAIN_ID)) {
    throw new Error("chainId must be 56");
  }

  return ethers.TypedDataEncoder.hash(
    {
      name: GENESIS_DOMAIN_NAME,
      version: GENESIS_DOMAIN_VERSION,
      chainId: GENESIS_CHAIN_ID,
      verifyingContract: ethers.getAddress(authorityAddress),
    },
    ATTESTATION_TYPES,
    { awardDigest, policyHash }
  );
}

function encodeDerLength(length) {
  if (length < 0x80) return [length];

  const octets = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) {
    octets.unshift(remaining & 0xff);
  }
  return [0x80 | octets.length, ...octets];
}

function encodeDerInteger(value) {
  let bytes = Array.from(ethers.getBytes(ethers.toBeHex(value)));
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0);
  return [0x02, ...encodeDerLength(bytes.length), ...bytes];
}

// TEST-ONLY fixture helper: converts a known test r/s pair to canonical DER.
function encodeDerSignatureForTest({ r, s }) {
  const body = [...encodeDerInteger(r), ...encodeDerInteger(s)];
  return ethers.hexlify(
    Uint8Array.from([0x30, ...encodeDerLength(body.length), ...body])
  );
}

function toFixed32(value) {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

function normalizeRecoveryId(candidate) {
  const recoveryId = Number(candidate);
  if (recoveryId !== 27 && recoveryId !== 28) {
    throw new Error("Recovery id candidates must be 27 or 28");
  }
  return recoveryId;
}

function deriveRecoveryId({
  digest,
  r,
  s,
  expectedVerifier,
  recoveryIdCandidates = [27, 28],
}) {
  const expected = ethers.getAddress(expectedVerifier);
  if (!Array.isArray(recoveryIdCandidates) || recoveryIdCandidates.length === 0) {
    throw new Error("At least one recovery id candidate is required");
  }

  for (const candidate of recoveryIdCandidates) {
    const recoveryId = normalizeRecoveryId(candidate);
    const candidateSignature = {
      r: toFixed32(r),
      s: toFixed32(s),
      v: recoveryId,
    };

    try {
      const recovered = ethers.getAddress(
        ethers.recoverAddress(digest, candidateSignature)
      );
      if (recovered === expected) {
        return { recoveryId, recoveredAddress: recovered };
      }
    } catch (_error) {
      // An invalid recovery candidate is simply not a match.
    }
  }

  throw new Error("Signature does not recover the expected verifier");
}

function adaptExternalDerSignature({
  authorityAddress,
  chainId,
  policyHash,
  awardDigest,
  expectedVerifier,
  derSignature,
  recoveryIdCandidates,
}) {
  const digest = computeAttestationDigest({
    authorityAddress,
    chainId,
    policyHash,
    awardDigest,
  });
  const parsed = parseDerSignature(derSignature);
  const normalized = normalizeSecp256k1Signature(parsed);
  const recovery = deriveRecoveryId({
    digest,
    r: normalized.r,
    s: normalized.s,
    expectedVerifier,
    recoveryIdCandidates,
  });
  const ethereumSignature = ethers.concat([
    toFixed32(normalized.r),
    toFixed32(normalized.s),
    ethers.toBeHex(recovery.recoveryId, 1),
  ]);

  const recoveredAddress = ethers.getAddress(
    ethers.recoverAddress(digest, ethereumSignature)
  );
  const expected = ethers.getAddress(expectedVerifier);
  if (recoveredAddress !== expected) {
    throw new Error("Produced signature does not recover the expected verifier");
  }

  return {
    digest,
    ethereumSignature,
    r: toFixed32(normalized.r),
    s: toFixed32(normalized.s),
    v: recovery.recoveryId,
    recoveredAddress,
    highSNormalized: normalized.highSNormalized,
  };
}

module.exports = {
  ATTESTATION_TYPES,
  GENESIS_CHAIN_ID,
  GENESIS_DOMAIN_NAME,
  GENESIS_DOMAIN_VERSION,
  SECP256K1_HALF_ORDER,
  SECP256K1_ORDER,
  adaptExternalDerSignature,
  computeAttestationDigest,
  encodeDerSignatureForTest,
  normalizeSecp256k1Signature,
  parseDerSignature,
};
