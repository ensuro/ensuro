// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {IRiskModule} from "../../interfaces/IRiskModule.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Policy} from '../Policy.sol';

contract PolicyPoolMock is IPolicyPool {
  IERC20 _currency;
  uint256 public policyCount;
  mapping (uint256 => Policy.PolicyData) public policies;

  event NewPolicy(IRiskModule indexed riskModule, uint256 policyId);

  constructor(
    IERC20 currency_
  ) {
    _currency = currency_;
    policyCount = 0;
  }

  function currency() external override view returns (IERC20) {
    return _currency;
  }

  function assetManager() external override view returns (address) {
    return address(0);
  }

  function newPolicy(Policy.PolicyData memory policy, address customer) external override returns (uint256) {
    policyCount++;
    policies[policyCount] = policy;
    policies[policyCount].id = policyCount;
    emit NewPolicy(IRiskModule(msg.sender), policyCount);
    return policyCount;
  }

  function getPolicy(uint256 policyId) external override view returns (Policy.PolicyData memory) {
    return policies[policyId];
  }

  function _resolvePolicy(uint256 policyId, uint256 payout) internal {
    Policy.PolicyData storage policy = policies[policyId];
    require(policy.id != 0, "Policy not found");
    require(msg.sender == address(policy.riskModule), "Only riskModule is authorized to resolve the policy");
    delete policies[policyId];
  }

  function resolvePolicy(uint256 policyId, uint256 payout) external override {
    _resolvePolicy(policyId, payout);
  }

  function resolvePolicy(uint256 policyId, bool customerWon) external override {
    return _resolvePolicy(policyId, customerWon ? policies[policyId].payout : 0);
  }
}
