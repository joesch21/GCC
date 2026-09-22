// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GCC Grant Payout Escrow
/// @notice Human-authorized, relayer-executed GCC payouts for the GG grant pipeline.
/// @dev Reuses the existing Genesis gas relayer identity, but does not reuse the
///      Genesis tender escrow. There is deliberately no owner, admin, upgrade,
///      arbitrary call, arbitrary token transfer, or sweep function.
contract GrantPayoutEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant REQUIRED_CHAIN_ID = 56;

    bytes32 public constant PAYOUT_TYPEHASH = keccak256(
        "Payout(bytes32 transferMaterialHash,address recipient,uint256 amount,uint64 validUntil)"
    );

    struct Payout {
        bytes32 transferMaterialHash;
        address recipient;
        uint256 amount;
        uint64 validUntil;
    }

    IERC20 public immutable gcc;
    address public immutable humanAuthority;
    address public immutable relayer;

    uint256 public totalPaid;
    mapping(bytes32 payoutId => bool paid) public paidPayout;

    error WrongChain(uint256 actualChainId);
    error ZeroAddress();
    error InvalidGccToken();
    error RelayerOnly();
    error InvalidTransferMaterialHash();
    error InvalidAmount();
    error InvalidExpiry();
    error PayoutExpired();
    error PayoutAlreadyPaid(bytes32 payoutId);
    error InvalidHumanAuthorization();
    error NativeAssetNotAccepted();

    event GrantPayoutEscrowConfigured(
        address indexed gccToken,
        address indexed humanAuthority,
        address indexed relayer
    );

    event GrantPaid(
        bytes32 indexed payoutId,
        bytes32 indexed transferMaterialHash,
        address indexed recipient,
        uint256 amount,
        address relayer
    );

    constructor(
        address gccToken_,
        address humanAuthority_,
        address relayer_
    ) EIP712("GCC Grant Payout Escrow", "1") {
        if (block.chainid != REQUIRED_CHAIN_ID) revert WrongChain(block.chainid);
        if (
            gccToken_ == address(0) ||
            humanAuthority_ == address(0) ||
            relayer_ == address(0)
        ) revert ZeroAddress();
        if (gccToken_.code.length == 0) revert InvalidGccToken();

        gcc = IERC20(gccToken_);
        humanAuthority = humanAuthority_;
        relayer = relayer_;

        emit GrantPayoutEscrowConfigured(
            gccToken_,
            humanAuthority_,
            relayer_
        );
    }

    /// @notice Settle one exact human-authorized GG grant payout.
    /// @dev Only the configured existing gas relayer may submit. The relayer
    ///      cannot change recipient, amount, material hash, or expiry without
    ///      invalidating the human authorization.
    function settle(
        Payout calldata payout,
        bytes calldata humanAuthorization
    ) external nonReentrant returns (bytes32 payoutId) {
        if (msg.sender != relayer) revert RelayerOnly();
        if (payout.transferMaterialHash == bytes32(0)) {
            revert InvalidTransferMaterialHash();
        }
        if (payout.recipient == address(0)) revert ZeroAddress();
        if (payout.amount == 0) revert InvalidAmount();
        if (payout.validUntil == 0) revert InvalidExpiry();
        if (block.timestamp > payout.validUntil) revert PayoutExpired();

        payoutId = derivePayoutId(payout);
        if (paidPayout[payoutId]) revert PayoutAlreadyPaid(payoutId);

        bytes32 digest = payoutDigest(payout);
        if (
            !SignatureChecker.isValidSignatureNow(
                humanAuthority,
                digest,
                humanAuthorization
            )
        ) {
            revert InvalidHumanAuthorization();
        }

        paidPayout[payoutId] = true;
        totalPaid += payout.amount;

        gcc.safeTransfer(payout.recipient, payout.amount);

        emit GrantPaid(
            payoutId,
            payout.transferMaterialHash,
            payout.recipient,
            payout.amount,
            msg.sender
        );
    }

    function payoutDigest(Payout calldata payout) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PAYOUT_TYPEHASH,
                payout.transferMaterialHash,
                payout.recipient,
                payout.amount,
                payout.validUntil
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /// @notice Stable single-use identity for this exact economic payout.
    function derivePayoutId(Payout calldata payout) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                payout.transferMaterialHash,
                payout.recipient,
                payout.amount
            )
        );
    }

    function escrowBalance() public view returns (uint256) {
        return gcc.balanceOf(address(this));
    }

    /// @notice Exact GCC reserve top-up needed for a specified pending payout sum.
    function fundingShortfall(uint256 pendingAmount) external view returns (uint256) {
        uint256 balance = escrowBalance();
        return pendingAmount > balance ? pendingAmount - balance : 0;
    }

    receive() external payable {
        revert NativeAssetNotAccepted();
    }
}
