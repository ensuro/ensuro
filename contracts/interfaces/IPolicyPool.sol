// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Policy} from "../Policy.sol";
import {IEToken} from "./IEToken.sol";
import {IRiskModule} from "./IRiskModule.sol";

/**
 * @title Interface of PolicyPool contracts
 * @notice There's a single instance of PolicyPool contract for a given deployment of the protocol
 * @dev Some methods of this interface will be called by other components of the protocol (like RiskModule or
 *      PremiumsAccount).
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
interface IPolicyPool {
  /**
   * @notice Event emitted every time a new policy is added to the pool
   * @dev Contains all the data about the policy that is later required for doing operations with the policy like
   *      resolution or expiration.
   *
   * @param riskModule The risk module that created the policy
   * @param policy The {Policy-PolicyData} struct with all the immutable fields of the policy.
   */
  event NewPolicy(IRiskModule indexed riskModule, Policy.PolicyData policy);

  /**
   * @notice Event emitted every time a new policy replaces an old Policy.
   * @dev The event contains only the id of the replacement policy, the full data is available in the NewPolicy event.
   *
   * @param riskModule The risk module that created the policy
   * @param oldPolicyId The id of the replaced policy.
   * @param newPolicyId The id of the new policy.
   */
  event PolicyReplaced(IRiskModule indexed riskModule, uint256 indexed oldPolicyId, uint256 indexed newPolicyId);

  /**
   * @notice Event emitted when a policy is cancelled, and part of the paid premium is refunded.
   * @dev After this, the policy is no longer active. The refund amounts are transferred to the policy holder.
   *
   * @param riskModule The risk module that created the policy
   * @param cancelledPolicyId The id of the cancelled policy.
   * @param purePremiumRefund The amount of pure premium refunded
   * @param jrCocRefund The amount of Jr CoC refunded
   * @param srCocRefund The amount of Sr CoC refunded
   */
  event PolicyCancelled(
    IRiskModule indexed riskModule,
    uint256 indexed cancelledPolicyId,
    uint256 purePremiumRefund,
    uint256 jrCocRefund,
    uint256 srCocRefund
  );

  /**
   * @notice Event emitted every time a policy is removed from the pool
   * @dev If the policy expired, the `payout` is 0, otherwise is the amount transferred to the policyholder.
   *
   * @param riskModule The risk module where that created the policy initially.
   * @param policyId The unique id of the policy
   * @param payout The payout that has been paid to the policy holder. 0 when the policy expired.
   */
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  /**
   * @notice Reference to the main currency (ERC20, e.g. USDC) used in the protocol
   */
  function currency() external view returns (IERC20Metadata);

  /**
   * @notice Address of the treasury, that receives protocol fees.
   */
  function treasury() external view returns (address);

  /**
   * @notice Creates a new Policy
   * @dev It charges the premium and distributes it to the different parties (PremiumsAccount, ETokens, treasury)
   *
   * @custom:pre `msg.sender` must be an active RiskModule
   * @custom:pre `rm.premiumsAccount()` must be an active PremiumsAccount
   * @custom:pre `payer` approved the spending of `currency()` for at least `policy.premium`
   * @custom:pre `internalId` must be unique within the risk module (`msg.sender`) and not used before
   *
   * @custom:emits NewPolicy with all the details about the policy
   * @custom:emits ERC20-Transfer transfers from `payer` to the different receivers of the premium
   *               (see Premium Split in the docs)
   *
   * @custom:throws PolicyAlreadyExists when reusing an internalId

   * @param policy A policy created with {Policy-initialize}
   * @param payer The address that will pay for the premium
   * @param policyHolder The address of the policy holder
   * @param internalId A unique id within the RiskModule, that will be used to compute the policy id
   * @return The policy id, identifying the NFT and the policy
   */
  function newPolicy(
    Policy.PolicyData memory policy,
    address payer,
    address policyHolder,
    uint96 internalId
  ) external returns (uint256);

  /**
   * @notice Replaces a policy with another
   * @dev After this call, the oldPolicy is no longer active and a new policy is created. Diferencial changes to
   *      premiums and locked SCR.
   *
   * @param oldPolicy A policy created previously and not expired
   * @param newPolicy_ A policy created with {Policy-initialize}
   * @param payer The address that will pay for the premium difference
   * @param internalId A unique id within the RiskModule, that will be used to compute the policy id
   * @return The policy id, identifying the NFT and the policy
   *
   * @custom:pre `msg.sender` must be an active RiskModule
   * @custom:pre `rm.premiumsAccount()` must be an active PremiumsAccount
   * @custom:pre `payer` approved the spending of `currency()` for at least `newPolicy_.premium - oldPolicy.premium`
   * @custom:pre `internalId` must be unique within `policy.riskModule` and not used before
   *
   * @custom:throws PolicyAlreadyExpired when trying to replace an expired policy
   * @custom:throws InvalidPolicyReplacement when trying to reduce some of the premium componentsa
   *
   * @custom:emits PolicyReplaced with the ids of the new and replaced policy
   * @custom:emits NewPolicy with all the details of the new policy
   */
  function replacePolicy(
    Policy.PolicyData memory oldPolicy,
    Policy.PolicyData memory newPolicy_,
    address payer,
    uint96 internalId
  ) external returns (uint256);

  /**
   * @notice Cancels a policy, doing optional refunds of parts of the premium.
   * @dev After this call the policy is not claimable and funds are unlocked
   *
   * @custom:pre `msg.sender` must be an active or deprecated RiskModule
   * @custom:pre Policy not expired
   *
   * Events:
   * @custom:emits PolicyCancelled with the refund amounts
   * @custom:emits ERC20-Transfer transfers of the refunds amount to the policy holder
   *
   * @param policyToCancel A policy created previously and not expired, that will be cancelled
   * @param purePremiumRefund The amount to refund from pure premiums (<= policyToCancel.purePremium)
   * @param jrCocRefund The amount to refund from jrCoc (<= policyToCancel.jrCoc)
   * @param srCocRefund The amount to refund from srCoc (<= policyToCancel.jrCoc)
   */
  function cancelPolicy(
    Policy.PolicyData calldata policyToCancel,
    uint256 purePremiumRefund,
    uint256 jrCocRefund,
    uint256 srCocRefund
  ) external;

  /**
   * @notice Resolves a policy with a payout, sending the payment to the owner of the policy NFT.
   * @dev After this call the policy is no longer active and the funds have been unlocked.
   *
   * @custom:pre `msg.sender` must be an active or deprecated RiskModule
   * @custom:pre `payout`: must be less than equal to `policy.payout`.
   * @custom:pre `policy`: must be a Policy not resolved before and not expired (if payout > 0).
   *
   * @custom:emits PolicyResolved with the payout amount
   * @custom:emits ERC20-Transfer to the policyholder with the payout
   *
   * @param policy A policy previously created with `newPolicy`
   * @param payout The amount to pay to the policyholder
   */
  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external;

  /**
   * @notice Expires a policy, unlocked the solvency.
   * @dev Resolves a policy with a payout 0, unlocking the solvency. Can be called by anyone, but only after
   *      `Policy.expiration`.
   *
   * @custom:pre `policy`: must be a Policy not resolved before
   * @custom:pre `policy.expiration` <= block.timestamp
   *
   * @custom:emits PolicyResolved with the payout == 0
   *
   * @param policy A policy previously created with `newPolicy`
   */
  function expirePolicy(Policy.PolicyData calldata policy) external;

  /**
   * @notice Returns whether a policy is active
   * @dev A policy is active when it's still in the PolicyPool, not yet resolved or expired.
   *      Be aware that a policy might be active but the `block.timestamp` might be after the expiration date, so it
   *      can't be triggered with a payout.
   *
   * @param policyId The id of the policy queried
   * @return Whether the policy is active or not
   */
  function isActive(uint256 policyId) external view returns (bool);

  /**
   * @notice Returns the stored hash of the policy
   * @dev Returns `bytes32(0)` if the policy isn't active.
   *
   * @param policyId The id of the policy queried
   * @return Returns the hash of a given policy id
   */
  function getPolicyHash(uint256 policyId) external view returns (bytes32);

  /**
   * @notice Deposits liquidity into an eToken
   * @dev Forwards the call to {EToken-deposit}, after transferring the funds.
   *      The user will receive etokens for the same amount deposited.
   *
   * @custom:pre `msg.sender` approved the spending of `currency()` for at least `amount`
   * @custom:pre `eToken` is an active eToken installed in the pool.
   *
   * @custom:emits EToken-Transfer from 0x0 to `receiver`, reflects the eTokens minted.
   * @custom:emits ERC20-Transfer from `msg.sender` to address(eToken)
   *
   * @param eToken The address of the eToken to which the user wants to provide liquidity
   * @param amount The amount to deposit
   * @param receiver The user that will receive the minted tokens
   */
  function deposit(IEToken eToken, uint256 amount, address receiver) external;

  /**
   * @notice Deposits liquidity into an eToken, EIP-2612 compatible version.
   * @dev Forwards the call to {EToken-deposit}, after transferring the funds.
   *      The user will receive etokens for the same amount deposited. EIP-2612 compatible version, allows sending a
   *      signed permit in the same operation.
   *
   * @custom:pre `msg.sender` approved the spending of `currency()` for at least `amount`
   * @custom:pre `eToken` is an active eToken installed in the pool.
   *
   * @custom:emits EToken-Transfer from 0x0 to `receiver`, reflects the eTokens minted.
   * @custom:emits ERC20-Transfer from `msg.sender` to address(eToken)
   *
   * @param eToken The address of the eToken to which the user wants to provide liquidity
   * @param receiver The user that will receive the minted tokens
   * @param amount The amount to deposit
   * @param deadline The deadline of the permit
   * @param v Component of the secp256k1 signature
   * @param r Component of the secp256k1 signature
   * @param s Component of the secp256k1 signature
   */
  function depositWithPermit(
    IEToken eToken,
    uint256 amount,
    address receiver,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external;

  /**
   * @notice Withdraws an amount from an eToken
   * @dev Forwards the call to {EToken-withdraw}. `amount` of eTokens will be burned and the user will receive the
   *      same amount in `currency()`.
   *
   * @custom:pre `eToken` is an active (or deprecated) eToken installed in the pool.
   *
   * @custom:emits EToken-Transfer from `owner` to `0x0`, reflects the eTokens burned.
   * @custom:emits ERC20-Transfer from address(eToken) to `receiver`
   *
   * @param eToken The address of the eToken from where the user wants to withdraw liquidity
   * @param amount The amount to withdraw. If equal to type(uint256).max, means full withdrawal.
   *               If the balance is not enough or can't be withdrawn (locked as SCR), it withdraws
   *               as much as it can, but doesn't fails.
   * @param receiver The user that will receive the resulting `currency()`
   * @param owner The user that owns the eTokens (must be msg.sender or have allowance)
   * @return Returns the actual amount withdrawn.
   */
  function withdraw(IEToken eToken, uint256 amount, address receiver, address owner) external returns (uint256);
}
