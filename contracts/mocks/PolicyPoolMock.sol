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

  enum PolicyResolution {
    unresolved,
    customerWon,
    poolWon
  }

  mapping (uint256 => PolicyResolution) public resolutions;

  event NewPolicy(IRiskModule indexed riskModule, uint256 policyId);
  event ResolvePolicyDebug(IRiskModule indexed riskModule, uint256 policyId, bool customerWon);


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

  function getPolicyResolution(uint256 policyId) external view returns (PolicyResolution) {
    return resolutions[policyId];
  }

  function resolvePolicy(uint256 policyId, bool customerWon) external override {
    Policy.PolicyData storage policy = policies[policyId];
    require(policy.id != 0, "Policy not found");
    require(msg.sender == address(policy.riskModule), "Only riskModule is authorized to resolve the policy");
    emit ResolvePolicyDebug(IRiskModule(msg.sender), policyId, customerWon);
    resolutions[policyId] = customerWon ? PolicyResolution.customerWon : PolicyResolution.poolWon;
    // delete policies[policyId];
  }
}
