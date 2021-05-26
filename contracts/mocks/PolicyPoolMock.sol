// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Policy} from '../Policy.sol';

contract PolicyPoolMock is IPolicyPool {
  IERC20 _currency;
  uint256 public policyCount;
  mapping (uint256 => Policy.PolicyData) public policies;

  constructor(
    IERC20 currency_
  ) {
    _currency = currency_;
    policyCount = 0;
  }

  function currency() external override view returns (IERC20) {
    return _currency;
  }

  function newPolicy(Policy.PolicyData memory policy, address customer) external override returns (uint256) {
    policyCount++;
    policies[policyCount] = policy;
    policies[policyCount].id = policyCount;
    emit NewPolicy(msg.sender, policyCount);
    return policyCount;
  }

  function getPolicy(uint256 policyId) external override view returns (Policy.PolicyData memory) {
    return policies[policyId];
  }
}
