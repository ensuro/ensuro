// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyHolder} from "../interfaces/IPolicyHolder.sol";
import {IPolicyHolderV2} from "../interfaces/IPolicyHolderV2.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";

contract PolicyHolderMock is IPolicyHolderV2 {
  uint256 public policyId;
  uint256 public payout;
  bool public fail;
  bool public failReplace;
  bool public emptyRevert;
  bool public notImplemented;
  bool public badlyImplemented;
  bool public badlyImplementedReplace;
  bool public noERC165;
  bool public noV2;
  uint256 public spendGasCount;

  enum NotificationKind {
    PolicyReceived,
    PayoutReceived,
    PolicyExpired,
    PolicyReplaced
  }

  event NotificationReceived(NotificationKind kind, uint256 policyId, address operator, address from);

  constructor() {
    fail = false;
    notImplemented = false;
    badlyImplemented = false;
    emptyRevert = false;
    noERC165 = false;
    payout = type(uint256).max;
    spendGasCount = 0;
  }

  function setFail(bool fail_) external {
    fail = fail_;
  }

  function setFailReplace(bool failReplace_) external {
    failReplace = failReplace_;
  }

  function setSpendGasCount(uint256 spendGasCount_) external {
    spendGasCount = spendGasCount_;
  }

  function setNotImplemented(bool notImplemented_) external {
    notImplemented = notImplemented_;
  }

  function setBadlyImplemented(bool badlyImplemented_) external {
    badlyImplemented = badlyImplemented_;
  }

  function setBadlyImplementedReplace(bool badlyImplementedReplace_) external {
    badlyImplementedReplace = badlyImplementedReplace_;
  }

  function setNoV2(bool noV2_) external {
    noV2 = noV2_;
  }

  function setNoERC165(bool noERC165_) external {
    noERC165 = noERC165_;
  }

  function setEmptyRevert(bool emptyRevert_) external {
    emptyRevert = emptyRevert_;
  }

  function spendGas() internal {
    // Spends gas doing storage writes
    for (uint256 i = 0; i < spendGasCount; i++) {
      StorageSlot.getUint256Slot(bytes32(100 + i)).value = i + 1;
    }
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
    return
      interfaceId == type(IPolicyHolder).interfaceId ||
      (!noV2 && interfaceId == type(IPolicyHolderV2).interfaceId) ||
      interfaceId == type(IERC165).interfaceId;
  }

  function onERC721Received(
    address operator,
    address from,
    uint256 policyId_,
    bytes calldata
  ) external override returns (bytes4) {
    if (fail)
      if (emptyRevert)
        assembly {
          revert(0, 0)
        }
      else revert("onERC721Received: They told me I have to fail");

    policyId = policyId_;
    payout = type(uint256).max;
    emit NotificationReceived(NotificationKind.PolicyReceived, policyId_, operator, from);

    if (badlyImplemented) return bytes4(0x0badf00d);

    spendGas();

    return IERC721Receiver.onERC721Received.selector;
  }

  function onPolicyExpired(address operator, address from, uint256 policyId_) external override returns (bytes4) {
    if (fail)
      if (emptyRevert)
        assembly {
          revert(0, 0)
        }
      else revert("onPolicyExpired: They told me I have to fail");
    policyId = policyId_;
    payout = 0;
    emit NotificationReceived(NotificationKind.PolicyExpired, policyId_, operator, from);

    if (badlyImplemented) return bytes4(0x0badf00d);

    spendGas();

    return IPolicyHolder.onPolicyExpired.selector;
  }

  /**
   * @dev See {IPolicyHolderV2-onPayoutReceived}.
   */
  function onPayoutReceived(
    address operator,
    address from,
    uint256 policyId_,
    uint256 amount
  ) external override returns (bytes4) {
    if (fail)
      if (emptyRevert)
        assembly {
          revert(0, 0)
        }
      else revert("onPayoutReceived: They told me I have to fail");
    policyId = policyId_;
    payout = amount;
    emit NotificationReceived(NotificationKind.PayoutReceived, policyId_, operator, from);

    if (badlyImplemented) return bytes4(0x0badf00d);

    spendGas();

    return IPolicyHolder.onPayoutReceived.selector;
  }

  /**
   * @dev See {IPolicyHolderV2-onPolicyReplaced}.
   */
  function onPolicyReplaced(
    address operator,
    address from,
    uint256 oldPolicyId,
    uint256 newPolicyId
  ) external override returns (bytes4) {
    if (noV2) revert("Shouldn't call this method if V2 not enabled");
    if (failReplace)
      if (emptyRevert)
        assembly {
          revert(0, 0)
        }
      else revert("onPolicyReplaced: They told me I have to fail");
    policyId = oldPolicyId;
    payout = newPolicyId;
    emit NotificationReceived(NotificationKind.PolicyReplaced, oldPolicyId, operator, from);

    if (badlyImplementedReplace) return bytes4(0x0badf00d);

    spendGas();

    return IPolicyHolderV2.onPolicyReplaced.selector;
  }
}
