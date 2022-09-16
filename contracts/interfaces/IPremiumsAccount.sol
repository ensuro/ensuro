// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IEToken} from "./IEToken.sol";
import {Policy} from "../Policy.sol";

/**
 * @title IPremiumsAccount interface
 * @dev Interface for Premiums Account contracts.
 * @author Ensuro
 */
interface IPremiumsAccount {
  /**
   * @dev Adds a policy to the PremiumsAccount. Stores the pure premiums and locks the aditional funds from junior and
   * senior eTokens.
   *
   * Requirements:
   * - Must be called by `policyPool()`
   *
   * Events:
   * - {EToken-SCRLocked}
   *
   * @param policy The policy to add (created in this transaction)
   */
  function policyCreated(Policy.PolicyData memory policy) external;

  /**
   * @dev The PremiumsAccount is notified that the policy was resolved and issues the payout to the policyHolder.
   *
   * Requirements:
   * - Must be called by `policyPool()`
   *
   * Events:
   * - {ERC20-Transfer}: `to == policyHolder`, `amount == payout`
   * - {EToken-InternalLoan}: optional, if a loan needs to be taken
   * - {EToken-SCRUnlocked}
   *
   * @param policyHolder The one that will receive the payout
   * @param policy The policy that was resolved
   * @param payout The amount that has to be transferred to `policyHolder`
   */
  function policyResolvedWithPayout(
    address policyHolder,
    Policy.PolicyData memory policy,
    uint256 payout
  ) external;

  /**
   * @dev The PremiumsAccount is notified that the policy has expired, unlocks the SCR and earns the pure premium.
   *
   * Requirements:
   * - Must be called by `policyPool()`
   *
   * Events:
   * - {ERC20-Transfer}: `to == policyHolder`, `amount == payout`
   * - {EToken-InternalLoanRepaid}: optional, if a loan was taken before
   *
   * @param policy The policy that has expired
   */
  function policyExpired(Policy.PolicyData memory policy) external;

  /**
   * @dev The senior eToken, the secondary source of solvency, used if the premiums account is exhausted and junior too
   */
  function seniorEtk() external view returns (IEToken);

  /**
   * @dev The junior eToken, the primary source of solvency, used if the premiums account is exhausted.
   */
  function juniorEtk() external view returns (IEToken);

  /**
   * @dev The total amount of premiums hold by this PremiumsAccount
   */
  function purePremiums() external view returns (uint256);
}
