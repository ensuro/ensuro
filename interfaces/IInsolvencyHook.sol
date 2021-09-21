// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IEToken} from "./IEToken.sol";

/**
 * @title IInsolvencyHook interface
 * @dev Interface for insolvency hook, the contract that manages the insolvency situation of the pool
 * @author Ensuro
 */
interface IInsolvencyHook {
  /**
   * @dev This is called from PolicyPool when doesn't have enought money for payment.
   *      After the call, there should be enought money in PolicyPool.currency().balanceOf(_policyPool) to
   *      do the payment
   * @param paymentAmount The amount of the payment
   */
  function outOfCash(uint256 paymentAmount) external;

  /**
   * @dev This is called from EToken when doesn't have enought totalSupply to cover the SCR
   *      The hook might choose not to do anything or solve the insolvency with a deposit
   * @param eToken The token that suffers insolvency
   * @param paymentAmount The amount of the payment
   */
  function insolventEToken(IEToken eToken, uint256 paymentAmount) external;
}
