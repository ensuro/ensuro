// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "../../interfaces/IPolicyPoolComponent.sol";
import {IInsolvencyHook} from "../../interfaces/IInsolvencyHook.sol";
import {IEToken} from "../../interfaces/IEToken.sol";
import {WadRayMath} from "../WadRayMath.sol";
import {IMintableERC20} from "./IMintableERC20.sol";

contract FreeGrantInsolvencyHook is IInsolvencyHook, IPolicyPoolComponent {
  using SafeERC20 for IERC20;
  using WadRayMath for uint256;

  IPolicyPool internal _policyPool;
  uint256 public cashGranted;

  modifier onlyPolicyPool() {
    require(msg.sender == address(_policyPool), "The caller must be the PolicyPool");
    _;
  }

  event OutOfCashGranted(uint256 amount);

  constructor(IPolicyPool policyPool_) {
    _policyPool = policyPool_;
  }

  function policyPool() public view override returns (IPolicyPool) {
    return _policyPool;
  }

  function outOfCash(uint256 paymentAmount) external override onlyPolicyPool {
    IERC20 currency = _policyPool.currency();
    IMintableERC20(address(currency)).mint(address(this), paymentAmount);
    currency.approve(address(_policyPool), paymentAmount);
    _policyPool.receiveGrant(paymentAmount);
    cashGranted += paymentAmount;
    emit OutOfCashGranted(paymentAmount);
  }

  // solhint-disable-next-line no-empty-blocks
  function insolventEToken(IEToken eToken, uint256 paymentAmount) external override {}
}
