// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IPolicyHolder} from "./IPolicyHolder.sol";

/**
 * @title Policy holder interface - V2 of the interface that adds onPolicyReplaced endpoint
 * @dev Interface for any contract that wants to be a holder of Ensuro Policies and receive notification of payouts and
 *      replacements.
 *
 *      Implementors of this interface MUST return true on supportsInterface for both IPolicyHolder and IPolicyHolderV2.
 */
interface IPolicyHolderV2 is IPolicyHolder {
  /**
   * @dev Whenever a policy is replaced, this function is called
   *
   * It must return its Solidity selector to confirm the payout.
   * If interface is not implemented by the recipient, it will be ignored and the replacement will be successful.
   * If any other value is returned or it reverts, the policy replacement will be reverted.
   *
   * The selector can be obtained in Solidity with `IPolicyHolderV2.onPolicyReplaced.selector`.
   */
  function onPolicyReplaced(
    address operator,
    address from,
    uint256 oldPolicyId,
    uint256 newPolicyId
  ) external returns (bytes4);
}
