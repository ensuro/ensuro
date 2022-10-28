// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title IAssetManager - Interface of the asset management strategy that's plugged into the reserves
 * @dev The asset manager is a contract that's plugged and called with `delegatecall` (operates in the context of the
 *      reserve - see {Reserve}). The asset manager contract applies a strategy to invest the reserve funds and
 *      get additional yields.
 *
 *      All implementations of this contract should use the Diamond Storage pattern to avoid overwriting the calling contract's state.
 *      See https://eips.ethereum.org/EIPS/eip-2535#storage
 * @author Ensuro
 */
interface IAssetManager is IERC165 {
  /**
   * @dev Event emitted when funds are removed from Reserve liquidity and invested in the investment strategy,
   * @param amount The amount invested
   */
  event MoneyInvested(uint256 amount);

  /**
   * @dev Event emitted when funds are deinvested from the investment strategy and returned to the reserve as liquid
   * funds.
   *
   * @param amount The amount de-invested
   */
  event MoneyDeinvested(uint256 amount);

  /**
   * @dev Event emitted when investment yields are accounted in the reserve
   *
   * @param earnings The amount of earnings generated since last record. It's positive in the case of earnings or
   * negative when there are losses.
   */
  event EarningsRecorded(int256 earnings);

  /**
   * @dev Function called when an asset manager is plugged into a reserve. Useful for initialization tasks
   */
  function connect() external;

  /**
   * @dev Gives the opportunity to the asset manager to rebalance the funds between those that are kept liquid in the
   * reserve balance and those that are invested. Called with delegatecall by the reserve from the external function
   * rebalance (see {Reserve-rebalance}).
   *
   * Events:
   * - Emits {MoneyInvested} or {MoneyDeinvested}
   */
  function rebalance() external;

  /**
   * @dev Gives the opportunity to the asset manager to rebalance the funds between those that are kept liquid in the
   * reserve balance and those that are invested. Called with delegatecall by the reserve from the external function
   * rebalance (see {Reserve-rebalance}).
   *
   * Events:
   * - Emits {MoneyInvested} or {MoneyDeinvested}
   */
  function recordEarnings() external returns (int256);

  /**
   * @dev Refills the reserve balance with enought money to do a payment. Called from the reserve when a payment needs
   * to be made and there's no enought liquid balance (`currency().balanceOf(reserve) < paymentAmount`)
   *
   * Events:
   * - Emits {MoneyDeinvested} with the amount transferred to the liquid balance.
   *
   * @param paymentAmount The total amount of the payment that needs to be made. If this function is called, it's
   * because paymentAmount > balanceOf(reserve). The minimum amount that needs to be transferred to the reserve is
   * `paymentAmount - balanceOf(reserve)`, but it can transfer more.
   * @return Returns the actual amount transferred
   */
  function refillWallet(uint256 paymentAmount) external returns (uint256);

  /**
   * @dev Deinvests all the funds transfer all the assets to the liquid balance. Called from the reserve when the asset
   * manager is unplugged.
   *
   * Events:
   * - Emits {MoneyDeinvested} with the amount transferred to the liquid balance.
   * - Emits {EarningsRecorded} with the amount of earnings since earnings were recorded last time.
   *
   * @return Returns the earnings or losses (negative) since last time earnings were recorded.
   */
  function deinvestAll() external returns (int256);
}
