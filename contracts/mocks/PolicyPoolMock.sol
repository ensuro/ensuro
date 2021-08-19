// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {IRiskModule} from "../../interfaces/IRiskModule.sol";
import {IEToken} from "../../interfaces/IEToken.sol";
import {IAssetManager} from "../../interfaces/IAssetManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Policy} from "../Policy.sol";

contract PolicyPoolMock is IPolicyPool {
  IERC20 internal _currency;
  uint256 public policyCount;
  mapping(uint256 => Policy.PolicyData) internal policies;

  event NewPolicy(IRiskModule indexed riskModule, uint256 policyId);
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  constructor(IERC20 currency_) {
    _currency = currency_;
    policyCount = 0;
  }

  function currency() external view override returns (IERC20) {
    return _currency;
  }

  function assetManager() external pure override returns (IAssetManager) {
    return IAssetManager(address(0));
  }

  function getInvestable() external view override returns (uint256) {
    return 0;
  }

  function getETokenCount() external view override returns (uint256) {
    return 0;
  }

  function getETokenAt(uint256) external view override returns (IEToken) {
    return IEToken(address(0));
  }

  function assetEarnings(uint256, bool) external override {
    revert("Not Implemented");
  }

  function newPolicy(
    Policy.PolicyData memory policy,
    address /* customer */
  ) external override returns (uint256) {
    policyCount++;
    policies[policyCount] = policy;
    policies[policyCount].id = policyCount;
    emit NewPolicy(IRiskModule(msg.sender), policyCount);
    return policyCount;
  }

  function getPolicy(uint256 policyId) external view override returns (Policy.PolicyData memory) {
    return policies[policyId];
  }

  function _resolvePolicy(uint256 policyId, uint256 payout) internal {
    Policy.PolicyData storage policy = policies[policyId];
    require(policy.id != 0, "Policy not found");
    require(
      msg.sender == address(policy.riskModule),
      "Only riskModule is authorized to resolve the policy"
    );
    delete policies[policyId];
    emit PolicyResolved(IRiskModule(msg.sender), policyId, payout);
  }

  function receiveGrant(uint256) external override {
    revert("Not Implemented");
  }

  function resolvePolicy(uint256 policyId, uint256 payout) external override {
    _resolvePolicy(policyId, payout);
  }

  function resolvePolicy(uint256 policyId, bool customerWon) external override {
    return _resolvePolicy(policyId, customerWon ? policies[policyId].payout : 0);
  }
}
