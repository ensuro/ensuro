// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IEToken} from "./IEToken.sol";

/**
 * @title ICooler - Interface of Cooler contracts, for eTokens that have cooldown
 * @author Ensuro
 */
interface ICooler {
  /**
   * @dev Returns the amount of pending (scheduled) withdrawals for a given eToken
   *
   * @param eToken The eToken (see {EToken})
   * @return The amount in currency that is pending
   */
  function pendingWithdrawals(IEToken eToken) external view returns (uint256);

  /**
   * @dev Returns the cooldown period in seconds required for withdrawals in a given eToken
   *
   * @param eToken The eToken (see {EToken})
   * @param owner  The owner of the tokens requested to withdraw
   * @param amount The amount requested to withdraw
   * @return The cooldown period in seconds
   */
  function cooldownPeriod(IEToken eToken, address owner, uint256 amount) external view returns (uint40);
}
