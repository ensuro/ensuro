// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {IRiskModule} from "../../interfaces/IRiskModule.sol";
import {IEToken} from "../../interfaces/IEToken.sol";
import {IAssetManager} from "../../interfaces/IAssetManager.sol";
import {IPolicyPoolConfig} from "../../interfaces/IPolicyPoolConfig.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Policy} from "../Policy.sol";
import {ForwardProxy} from "./ForwardProxy.sol";

contract PolicyPoolMock is IPolicyPool {
  IERC20 internal _currency;
  IPolicyPoolConfig internal _config;

  uint256 public policyCount;
  uint256 internal _totalETokenSupply;
  mapping(uint256 => Policy.PolicyData) internal policies;

  event NewPolicy(IRiskModule indexed riskModule, uint256 policyId);
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  constructor(IERC20 currency_, IPolicyPoolConfig config_) {
    _currency = currency_;
    policyCount = 0;
    _config = config_;
    _config.connect();
    _totalETokenSupply = 1e40; // 1e22 = a lot...
  }

  function currency() external view override returns (IERC20) {
    return _currency;
  }

  function config() external view override returns (IPolicyPoolConfig) {
    return _config;
  }

  function setAssetManager(IAssetManager) external pure override {
    revert("Not Implemented");
  }

  function getInvestable() external pure override returns (uint256) {
    return 0;
  }

  function getETokenCount() external pure override returns (uint256) {
    return 0;
  }

  function getETokenAt(uint256) external pure override returns (IEToken) {
    return IEToken(address(0));
  }

  function assetEarnings(uint256, bool) external pure override {
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

  function receiveGrant(uint256) external pure override {
    revert("Not Implemented");
  }

  function resolvePolicy(uint256 policyId, uint256 payout) external override {
    _resolvePolicy(policyId, payout);
  }

  function resolvePolicy(uint256 policyId, bool customerWon) external override {
    return _resolvePolicy(policyId, customerWon ? policies[policyId].payout : 0);
  }

  function deposit(IEToken, uint256) external pure override {
    revert("Not Implemented deposit");
  }

  function withdraw(IEToken, uint256) external pure override returns (uint256) {
    revert("Not Implemented withdraw");
  }

  function setTotalETokenSupply(uint256 value) external {
    _totalETokenSupply = value;
  }

  function totalETokenSupply() external view override returns (uint256) {
    return _totalETokenSupply;
  }
}

/**
 * @title PolicyPoolMockForward
 * @dev PolicyPool that forwards fallback calls to another contract. Used to simulate calls to EToken
 *      and other contracts that have functions that can be called only from PolicyPool
 */
contract PolicyPoolMockForward is ForwardProxy {
  IERC20 internal _currency;
  IPolicyPoolConfig internal _config;

  constructor(
    address forwardTo,
    IERC20 currency_,
    IPolicyPoolConfig config_
  ) ForwardProxy(forwardTo) {
    _currency = currency_;
    _config = config_;
    _config.connect();
  }

  function currency() external view returns (IERC20) {
    return _currency;
  }

  function config() external view returns (IPolicyPoolConfig) {
    return _config;
  }
}
