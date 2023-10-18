// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {IPolicyHolder} from "../interfaces/IPolicyHolder.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract PolicyHolderMock is IPolicyHolder {
  uint256 public policyId;
  uint256 public payout;
  bool public fail;
  bool public notImplemented;
  bool public badlyImplemented;
  bool public noERC165;

  enum NotificationKind {
    PolicyReceived,
    PayoutReceived,
    PolicyExpired
  }

  event NotificationReceived(
    NotificationKind kind,
    uint256 policyId,
    address operator,
    address from
  );

  constructor() {
    fail = false;
    notImplemented = false;
    badlyImplemented = false;
    payout = type(uint256).max;
  }

  function setFail(bool fail_) external {
    fail = fail_;
  }

  function setNotImplemented(bool notImplemented_) external {
    notImplemented = notImplemented_;
  }

  function setBadlyImplemented(bool badlyImplemented_) external {
    badlyImplemented = badlyImplemented_;
  }

  function setNoERC165(bool noERC165_) external {
    noERC165 = noERC165_;
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
    if (noERC165)
      assembly {
        revert(0, 0)
      }
    if (notImplemented) return false;
    return interfaceId == type(IPolicyHolder).interfaceId;
  }

  function onERC721Received(
    address operator,
    address from,
    uint256 policyId_,
    bytes calldata
  ) external override returns (bytes4) {
    if (fail) revert("onERC721Received: They told me I have to fail");

    policyId = policyId_;
    payout = type(uint256).max;
    emit NotificationReceived(NotificationKind.PolicyReceived, policyId_, operator, from);

    if (badlyImplemented) return bytes4(0x0badf00d);

    return IERC721Receiver.onERC721Received.selector;
  }

  function onPolicyExpired(
    address operator,
    address from,
    uint256 policyId_
  ) external override returns (bytes4) {
    if (fail) revert("onPolicyExpired: They told me I have to fail");
    policyId = policyId_;
    payout = 0;
    emit NotificationReceived(NotificationKind.PolicyExpired, policyId_, operator, from);

    if (badlyImplemented) return bytes4(0x0badf00d);

    return IPolicyHolder.onPolicyExpired.selector;
  }

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
    uint256 policyId_,
    uint256 amount
  ) external override returns (bytes4) {
    if (fail) revert("onPayoutReceived: They told me I have to fail");
    policyId = policyId_;
    payout = amount;
    emit NotificationReceived(NotificationKind.PayoutReceived, policyId_, operator, from);

    if (badlyImplemented) return bytes4(0x0badf00d);

    return IPolicyHolder.onPayoutReceived.selector;
  }
}
