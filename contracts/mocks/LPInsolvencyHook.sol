// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {IEToken} from "../../interfaces/IEToken.sol";
import {IPolicyPoolComponent} from "../../interfaces/IPolicyPoolComponent.sol";
import {IInsolvencyHook} from "../../interfaces/IInsolvencyHook.sol";
import {WadRayMath} from "../WadRayMath.sol";
import {IMintableERC20} from "./IMintableERC20.sol";

contract LPInsolvencyHook is IInsolvencyHook, IPolicyPoolComponent {
  using SafeERC20 for IERC20;
  using WadRayMath for uint256;

  IPolicyPool internal _policyPool;
  IEToken internal _eToken;
  uint256 public cashDeposited;

  modifier onlyPolicyPool {
    require(msg.sender == address(_policyPool), "The caller must be the PolicyPool");
    _;
  }

  event OutOfCashDeposited(uint256 amount);

  constructor(IPolicyPool policyPool_, IEToken eToken_) {
    _policyPool = policyPool_;
    _eToken = eToken_;
  }

  function policyPool() public view override returns (IPolicyPool) {
    return _policyPool;
  }

  function outOfCash(uint256 paymentAmount) external override onlyPolicyPool {
    IERC20 currency = _policyPool.currency();
    IMintableERC20(address(currency)).mint(address(this), paymentAmount);
    currency.approve(address(_policyPool), paymentAmount);
    _policyPool.deposit(_eToken, paymentAmount);
    cashDeposited += paymentAmount;
    emit OutOfCashDeposited(paymentAmount);
  }
}
