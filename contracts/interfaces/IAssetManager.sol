// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/**
 * @title IAssetManager - Interface of the asset management strategy that's plugged into the reserves
 * @author Ensuro
 */
interface IAssetManager {
  event MoneyInvested(uint256 amount);
  event MoneyDeinvested(uint256 amount);
  event EarningsRecorded(bool positive, uint256 amount);

  function connect() external;

  function rebalance() external;

  function recordEarnings() external returns (int256);

  function refillWallet(uint256 paymentAmount) external;

  function deinvestAll() external returns (int256);
}
