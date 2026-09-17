// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GCC Genesis Deliverable Escrow
/// @notice Single-purpose GCC escrow for GCC-GENESIS-001.
/// @dev There is deliberately no owner, admin, upgrade, arbitrary transfer, or sweep function.
///      GCC can leave this contract only through a valid deliverable award settlement.
contract GenesisDeliverableEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant REQUIRED_CHAIN_ID = 56;

    bytes32 public constant QUALIFIED_PROPOSAL = keccak256("QUALIFIED_PROPOSAL");
    bytes32 public constant FINALIST = keccak256("FINALIST");
    bytes32 public constant SELECTED_COMPONENT = keccak256("SELECTED_COMPONENT");

    bytes32 public constant AWARD_TYPEHASH = keccak256(
        "Award(bytes32 tenderHash,bytes32 awardClass,bytes32 deliverableHash,bytes32 assessmentHash,address recipient,uint64 validUntil)"
    );

    struct Award {
        bytes32 tenderHash;
        bytes32 awardClass;
        bytes32 deliverableHash;
        bytes32 assessmentHash;
        address recipient;
        uint64 validUntil;
    }

    struct RewardRule {
        uint256 amount;
        uint32 maxAwards;
        uint32 paidAwards;
    }

    IERC20 public immutable gcc;
    address public immutable verifier;
    bytes32 public immutable tenderHash;
    uint64 public immutable settlementDeadline;
    uint256 public immutable rewardCap;

    uint256 public totalPaid;
    uint256 public totalAwardsPaid;

    mapping(bytes32 awardClass => RewardRule rule) private _rewardRules;
    mapping(bytes32 awardId => bool paid) public paidAward;
    mapping(bytes32 deliverableClassKey => bool paid) public paidDeliverableClass;

    error WrongChain(uint256 actualChainId);
    error ZeroAddress();
    error ZeroTenderHash();
    error InvalidDeadline();
    error InvalidRewardRule(bytes32 awardClass);
    error EmptyRewardSchedule();
    error WrongTender(bytes32 supplied, bytes32 expected);
    error UnsupportedAwardClass(bytes32 awardClass);
    error AwardClassExhausted(bytes32 awardClass);
    error SettlementClosed();
    error AwardExpired();
    error InvalidAwardExpiry();
    error ZeroDeliverableHash();
    error ZeroAssessmentHash();
    error AwardAlreadyPaid(bytes32 awardId);
    error DeliverableClassAlreadyPaid(bytes32 deliverableClassKey);
    error InvalidVerifierAuthorization();
    error RewardCapExceeded();
    error NativeAssetNotAccepted();

    event GenesisEscrowConfigured(
        address indexed gccToken,
        address indexed verifier,
        bytes32 indexed tenderHash,
        uint64 settlementDeadline,
        uint256 rewardCap
    );

    event DeliverablePaid(
        bytes32 indexed awardId,
        bytes32 indexed awardClass,
        bytes32 indexed deliverableHash,
        bytes32 assessmentHash,
        address recipient,
        uint256 amount,
        address relayer
    );

    constructor(
        address gccToken_,
        address verifier_,
        bytes32 tenderHash_,
        uint64 settlementDeadline_,
        uint256 qualifiedReward_,
        uint32 maxQualifiedAwards_,
        uint256 finalistReward_,
        uint32 maxFinalistAwards_,
        uint256 selectedComponentReward_,
        uint32 maxSelectedComponentAwards_
    ) EIP712("GCC Genesis Deliverable Escrow", "1") {
        if (block.chainid != REQUIRED_CHAIN_ID) revert WrongChain(block.chainid);
        if (gccToken_ == address(0) || verifier_ == address(0)) revert ZeroAddress();
        if (gccToken_.code.length == 0) revert ZeroAddress();
        if (tenderHash_ == bytes32(0)) revert ZeroTenderHash();
        if (settlementDeadline_ <= block.timestamp) revert InvalidDeadline();

        gcc = IERC20(gccToken_);
        verifier = verifier_;
        tenderHash = tenderHash_;
        settlementDeadline = settlementDeadline_;

        _setRewardRule(QUALIFIED_PROPOSAL, qualifiedReward_, maxQualifiedAwards_);
        _setRewardRule(FINALIST, finalistReward_, maxFinalistAwards_);
        _setRewardRule(SELECTED_COMPONENT, selectedComponentReward_, maxSelectedComponentAwards_);

        uint256 cap =
            (qualifiedReward_ * maxQualifiedAwards_) +
            (finalistReward_ * maxFinalistAwards_) +
            (selectedComponentReward_ * maxSelectedComponentAwards_);

        if (cap == 0) revert EmptyRewardSchedule();
        rewardCap = cap;

        emit GenesisEscrowConfigured(
            gccToken_,
            verifier_,
            tenderHash_,
            settlementDeadline_,
            cap
        );
    }

    /// @notice Permissionless settlement. The relayer has no spending authority of its own.
    /// @param award Exact deliverable award authorized by the verifier.
    /// @param verifierAuthorization EIP-712 signature accepted by verifier.
    function settle(
        Award calldata award,
        bytes calldata verifierAuthorization
    ) external nonReentrant returns (bytes32 awardId, uint256 amount) {
        if (block.timestamp > settlementDeadline) revert SettlementClosed();
        if (award.validUntil == 0 || award.validUntil > settlementDeadline) {
            revert InvalidAwardExpiry();
        }
        if (block.timestamp > award.validUntil) revert AwardExpired();
        if (award.tenderHash != tenderHash) {
            revert WrongTender(award.tenderHash, tenderHash);
        }
        if (award.recipient == address(0)) revert ZeroAddress();
        if (award.deliverableHash == bytes32(0)) revert ZeroDeliverableHash();
        if (award.assessmentHash == bytes32(0)) revert ZeroAssessmentHash();

        RewardRule storage rule = _rewardRules[award.awardClass];
        if (rule.maxAwards == 0) revert UnsupportedAwardClass(award.awardClass);
        if (rule.paidAwards >= rule.maxAwards) {
            revert AwardClassExhausted(award.awardClass);
        }

        awardId = deriveAwardId(award);
        if (paidAward[awardId]) revert AwardAlreadyPaid(awardId);

        bytes32 deliverableClassKey = keccak256(
            abi.encode(award.awardClass, award.deliverableHash)
        );
        if (paidDeliverableClass[deliverableClassKey]) {
            revert DeliverableClassAlreadyPaid(deliverableClassKey);
        }

        bytes32 digest = awardDigest(award);
        if (
            !SignatureChecker.isValidSignatureNow(
                verifier,
                digest,
                verifierAuthorization
            )
        ) {
            revert InvalidVerifierAuthorization();
        }

        amount = rule.amount;
        if (totalPaid + amount > rewardCap) revert RewardCapExceeded();

        // Effects before interaction. Any token transfer revert rolls all state back.
        paidAward[awardId] = true;
        paidDeliverableClass[deliverableClassKey] = true;
        rule.paidAwards += 1;
        totalAwardsPaid += 1;
        totalPaid += amount;

        gcc.safeTransfer(award.recipient, amount);

        emit DeliverablePaid(
            awardId,
            award.awardClass,
            award.deliverableHash,
            award.assessmentHash,
            award.recipient,
            amount,
            msg.sender
        );
    }

    function awardDigest(Award calldata award) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                AWARD_TYPEHASH,
                award.tenderHash,
                award.awardClass,
                award.deliverableHash,
                award.assessmentHash,
                award.recipient,
                award.validUntil
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /// @notice Stable award identifier. Expiry is deliberately excluded so re-signing
    ///         the same economic award with a new expiry cannot create a second identity.
    function deriveAwardId(Award calldata award) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                award.tenderHash,
                award.awardClass,
                award.deliverableHash,
                award.assessmentHash,
                award.recipient
            )
        );
    }

    function rewardRule(
        bytes32 awardClass
    ) external view returns (uint256 amount, uint32 maxAwards, uint32 paidAwards) {
        RewardRule storage rule = _rewardRules[awardClass];
        return (rule.amount, rule.maxAwards, rule.paidAwards);
    }

    function remainingLiability() public view returns (uint256) {
        return rewardCap - totalPaid;
    }

    function escrowBalance() public view returns (uint256) {
        return gcc.balanceOf(address(this));
    }

    function fundingShortfall() external view returns (uint256) {
        uint256 balance = escrowBalance();
        uint256 liability = remainingLiability();
        return liability > balance ? liability - balance : 0;
    }

    function excessBalance() external view returns (uint256) {
        uint256 balance = escrowBalance();
        uint256 liability = remainingLiability();
        return balance > liability ? balance - liability : 0;
    }

    function _setRewardRule(
        bytes32 awardClass,
        uint256 amount,
        uint32 maxAwards
    ) private {
        // A disabled class must be exactly (0, 0); an enabled class must have both values.
        if ((amount == 0) != (maxAwards == 0)) {
            revert InvalidRewardRule(awardClass);
        }
        _rewardRules[awardClass] = RewardRule({
            amount: amount,
            maxAwards: maxAwards,
            paidAwards: 0
        });
    }

    receive() external payable {
        revert NativeAssetNotAccepted();
    }
}
