// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title Policy holder interface
 * @dev Interface for any contract that wants to be a holder of Ensuro Policies and receive the payouts
 */
interface IPolicyHolder is IERC721Receiver {
  /**
   * @dev Whenever an Policy is expired or resolved with payout = 0, this function is called
   *
   * It should return its Solidity selector to confirm the payout.
   * If interface is not implemented by the recipient, it will be ignored and the payout will be successful.
   * No mather what's the return value or even if this function reverts, this function will not revert the policy
   * expiration.
   *
   * The selector can be obtained in Solidity with `IPolicyPool.onPolicyExpired.selector`.
   */
  function onPolicyExpired(
    address operator,
    address from,
    uint256 policyId
  ) external returns (bytes4);

  /**
   * @dev Whenever an Policy is resolved with payout > 0, this function is called
   *
   * It must return its Solidity selector to confirm the payout.
   * If interface is not implemented by the recipient, it will be ignored and the payout will be successful.
   * If any other value is returned or it reverts, the policy resolution / payout will be reverted.
   *
   * The selector can be obtained in Solidity with `IPolicyPool.onPayoutReceived.selector`.
   */
  function onPayoutReceived(
    address operator,
    address from,
    uint256 policyId,
    uint256 amount
  ) external returns (bytes4);
}
