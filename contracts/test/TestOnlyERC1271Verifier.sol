// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title Test-only Safe-like ERC-1271 verifier fixture
/// @notice Minimal contract verifier used only by GCC Genesis tests.
/// @dev This fixture has no GCC handling and must never be used as production authority.
contract TestOnlyERC1271Verifier is IERC1271 {
    bytes4 public constant MAGICVALUE = IERC1271.isValidSignature.selector;
    bytes4 public constant INVALID = 0xffffffff;

    address public immutable expectedSigner;

    error ZeroExpectedSigner();

    constructor(address expectedSigner_) {
        if (expectedSigner_ == address(0)) revert ZeroExpectedSigner();
        expectedSigner = expectedSigner_;
    }

    function isValidSignature(
        bytes32 digest,
        bytes calldata signature
    ) external view override returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(expectedSigner, digest, signature)
            ? MAGICVALUE
            : INVALID;
    }
}
