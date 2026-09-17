// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title GCC Genesis Verifier Authority
/// @notice Immutable 2-of-3 verifier for GCC-GENESIS-001 award digests.
/// @dev Holds no GCC and exposes no owner, admin, upgrade, or signer-rotation path.
///      The policy hash binds every attestation to one frozen verifier policy.
contract GenesisVerifierAuthority is EIP712, IERC1271 {
    uint256 public constant REQUIRED_CHAIN_ID = 56;
    uint256 public constant VERIFIER_COUNT = 3;
    uint256 public constant THRESHOLD = 2;

    bytes4 private constant MAGICVALUE = IERC1271.isValidSignature.selector;
    bytes4 private constant INVALID = 0xffffffff;

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(bytes32 awardDigest,bytes32 policyHash)"
    );

    bytes32 public immutable policyHash;
    bytes32 public immutable verifierSetHash;

    address[3] private _verifiers;
    mapping(address verifier => bool allowed) public isVerifier;

    error WrongChain(uint256 actualChainId);
    error ZeroPolicyHash();
    error ZeroVerifier();
    error DuplicateVerifier(address verifier);
    error SelfVerifier();

    event VerifierAuthorityConfigured(
        bytes32 indexed policyHash,
        bytes32 indexed verifierSetHash,
        address verifier0,
        address verifier1,
        address verifier2
    );

    constructor(
        bytes32 policyHash_,
        address verifier0_,
        address verifier1_,
        address verifier2_
    ) EIP712("GCC Genesis Verifier Authority", "1") {
        if (block.chainid != REQUIRED_CHAIN_ID) revert WrongChain(block.chainid);
        if (policyHash_ == bytes32(0)) revert ZeroPolicyHash();

        address[3] memory supplied = [verifier0_, verifier1_, verifier2_];

        for (uint256 i = 0; i < VERIFIER_COUNT; i++) {
            address verifier = supplied[i];
            if (verifier == address(0)) revert ZeroVerifier();
            if (verifier == address(this)) revert SelfVerifier();
            if (isVerifier[verifier]) revert DuplicateVerifier(verifier);

            isVerifier[verifier] = true;
            _verifiers[i] = verifier;
        }

        policyHash = policyHash_;
        verifierSetHash = keccak256(
            abi.encode(
                policyHash_,
                THRESHOLD,
                verifier0_,
                verifier1_,
                verifier2_
            )
        );

        emit VerifierAuthorityConfigured(
            policyHash_,
            verifierSetHash,
            verifier0_,
            verifier1_,
            verifier2_
        );
    }

    /// @notice EIP-1271 verification used by GenesisDeliverableEscrow.
    /// @dev authorization = abi.encode(address[] signers, bytes[] signatures)
    ///      Signers must be strictly ascending to prove uniqueness deterministically.
    function isValidSignature(
        bytes32 awardDigest,
        bytes calldata authorization
    ) external view override returns (bytes4) {
        (address[] memory signers, bytes[] memory signatures) = abi.decode(
            authorization,
            (address[], bytes[])
        );

        if (signers.length < THRESHOLD || signers.length != signatures.length) {
            return INVALID;
        }

        // More signatures than the complete immutable verifier set is never valid.
        if (signers.length > VERIFIER_COUNT) return INVALID;

        bytes32 digest = attestationDigest(awardDigest);
        address previous;

        for (uint256 i = 0; i < signers.length; i++) {
            address signer = signers[i];

            if (!isVerifier[signer]) return INVALID;
            if (i > 0 && uint160(signer) <= uint160(previous)) return INVALID;

            if (
                !SignatureChecker.isValidSignatureNow(
                    signer,
                    digest,
                    signatures[i]
                )
            ) {
                return INVALID;
            }

            previous = signer;
        }

        return MAGICVALUE;
    }

    function attestationDigest(
        bytes32 awardDigest
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                awardDigest,
                policyHash
            )
        );

        return _hashTypedDataV4(structHash);
    }

    function verifierAt(uint256 index) external view returns (address) {
        return _verifiers[index];
    }

    function verifiers() external view returns (address[3] memory) {
        return _verifiers;
    }
}
