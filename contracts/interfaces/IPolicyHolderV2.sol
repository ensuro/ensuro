// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IPolicyHolder} from "./IPolicyHolder.sol";

/**
 * @title Policy holder interface - V1 of the interface, new methods added later
 * @dev Interface for any contract that wants to be a holder of Ensuro Policies and receive the payouts
 */
interface IPolicyHolderV2 is IPolicyHolder {
  /**
   * @dev Whenever an Policy is resolved with payout > 0, this function is called
   *
   * It must return its Solidity selector to confirm the payout.
   * If interface is not implemented by the recipient, it will be ignored and the payout will be successful.
   * If any other value is returned or it reverts, the policy resolution / payout will be reverted.
   *
   * The selector can be obtained in Solidity with `IPolicyPool.onPayoutReceived.selector`.
   */
  function onPolicyReplaced(
    address operator,
    address from,
    uint256 oldPolicyId,
    uint256 newPolicyId
  ) external returns (bytes4);
}
