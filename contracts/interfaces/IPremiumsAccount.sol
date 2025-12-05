// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IEToken} from "./IEToken.sol";
import {Policy} from "../Policy.sol";

/**
 * @title IPremiumsAccount interface
 * @notice Interface for Premiums Account contracts.
 * @author Ensuro
 */
interface IPremiumsAccount {
  /**
   * @notice Adds a policy to the PremiumsAccount. Stores the pure premiums and locks the aditional funds from junior and
   * senior eTokens.
   *
   * @param policy The policy to add (created in this transaction)
   *
   * @custom:pre Must be called by `policyPool()`
   *
   * @custom:emits {EToken-SCRLocked}
   */
  function policyCreated(Policy.PolicyData memory policy) external;

  /**
   * @notice Replaces a policy with another in PremiumsAccount. Stores the pure premiums difference and
   * re-locks the aditional funds from junior and senior eTokens.
   *
   * @param oldPolicy The policy to replace (created in a previous transaction)
   * @param newPolicy The policy that will replace the old one (created in this transaction)
   *
   * @custom:pre Must be called by `policyPool()`
   *
   * @custom:emits {EToken-SCRUnlocked}
   * @custom:emits {EToken-SCRLocked}
   */
  function policyReplaced(Policy.PolicyData memory oldPolicy, Policy.PolicyData memory newPolicy) external;

  /**
   * @notice Reflects the cancellation of a policy, doing the required refunds.
   *
   * @param policyToCancel The policy that is being cancelled
   * @param purePremiumRefund The pure premium amount that will be reimbursed to the policy holder
   * @param jrCocRefund The jrCoc that will be reimbursed to the policy holder
   * @param srCocRefund The srCoc that will be reimbursed to the policy holder
   * @param policyHolder Owner of the policy that will receive the reimbursement
   *
   * @custom:pre Must be called by `policyPool()`
   *
   * @custom:emits {EToken-SCRUnlocked}
   */
  function policyCancelled(
    Policy.PolicyData calldata policyToCancel,
    uint256 purePremiumRefund,
    uint256 jrCocRefund,
    uint256 srCocRefund,
    address policyHolder
  ) external;

  /**
   * @notice The PremiumsAccount is notified that the policy was resolved and issues the payout to the policyHolder.
   *
   * @param policyHolder The one that will receive the payout
   * @param policy The policy that was resolved
   * @param payout The amount that has to be transferred to `policyHolder`
   *
   * @custom:pre Must be called by `policyPool()`
   * @custom:emits {ERC20-Transfer}: `to == policyHolder`, `amount == payout`
   * @custom:emits {EToken-InternalLoan}: optional, if a loan needs to be taken
   * @custom:emits {EToken-SCRUnlocked}
   */
  function policyResolvedWithPayout(address policyHolder, Policy.PolicyData memory policy, uint256 payout) external;

  /**
   * @notice The PremiumsAccount is notified that the policy has expired, unlocks the SCR and earns the pure premium.
   *
   * @param policy The policy that has expired
   *
   * @custom:pre Must be called by `policyPool()`
   * @custom:emits {ERC20-Transfer}: `to == policyHolder`, `amount == payout`
   * @custom:emits {EToken-InternalLoanRepaid}: optional, if a loan was taken before
   */
  function policyExpired(Policy.PolicyData memory policy) external;

  /**
   * @notice The senior eToken, the secondary source of solvency, used if the premiums account is exhausted and junior too
   */
  function seniorEtk() external view returns (IEToken);

  /**
   * @notice The junior eToken, the primary source of solvency, used if the premiums account is exhausted.
   */
  function juniorEtk() external view returns (IEToken);

  /**
   * @notice Returns the juniorEtk and seniorEtk. See {juniorEtk()} and {seniorEtk()}
   */
  function etks() external view returns (IEToken juniorEtk, IEToken seniorEtk);

  /**
   * @notice The total amount of premiums hold by this PremiumsAccount
   */
  function purePremiums() external view returns (uint256);
}
