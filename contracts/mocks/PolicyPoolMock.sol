// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../../interfaces/IPolicyPool.sol";
import {IRiskModule} from "../../interfaces/IRiskModule.sol";
import {IEToken} from "../../interfaces/IEToken.sol";
import {IAssetManager} from "../../interfaces/IAssetManager.sol";
import {IPolicyPoolConfig} from "../../interfaces/IPolicyPoolConfig.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Policy} from "../Policy.sol";
import {ForwardProxy} from "./ForwardProxy.sol";

contract PolicyPoolMock is IPolicyPool {
  using Policy for Policy.PolicyData;

  uint256 public constant MAX_INT =
    0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

  IERC20Metadata internal _currency;
  IPolicyPoolConfig internal _config;

  uint256 internal _totalETokenSupply;
  mapping(uint256 => Policy.PolicyData) internal policies;
  mapping(uint256 => bytes32) internal policyHashes;

  event NewPolicy(IRiskModule indexed riskModule, Policy.PolicyData policy);
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  constructor(IERC20Metadata currency_, IPolicyPoolConfig config_) {
    _currency = currency_;
    _config = config_;
    _config.connect();
    require(
      _config.assetManager() == IAssetManager(address(0)),
      "AssetManager can't be set before PolicyPool initialization"
    );
    _totalETokenSupply = 1e40; // 1e22 = a lot...
  }

  function currency() external view override returns (IERC20Metadata) {
    return _currency;
  }

  function config() external view override returns (IPolicyPoolConfig) {
    return _config;
  }

  function policyNFT() external pure override returns (address) {
    return address(0);
  }

  function setAssetManager(IAssetManager newAssetManager) external override {
    require(msg.sender == address(_config), "Only the PolicyPoolConfig can change assetManager");
    if (address(_config.assetManager()) != address(0)) {
      _config.assetManager().deinvestAll(); // deInvest all assets
      _currency.approve(address(_config.assetManager()), 0); // revoke currency management approval
    }
    if (address(newAssetManager) != address(0)) {
      _currency.approve(address(newAssetManager), type(uint256).max);
    }
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
    address, /* customer */
    uint96 internalId
  ) external override returns (uint256) {
    policy.id = (uint256(uint160(address(policy.riskModule))) << 96) + internalId;
    policyHashes[policy.id] = policy.hash();
    emit NewPolicy(IRiskModule(msg.sender), policy);
    return policy.id;
  }

  function _resolvePolicy(Policy.PolicyData memory policy, uint256 payout) internal {
    require(policy.id != 0, "Policy not found");
    require(policy.hash() == policyHashes[policy.id], "Hash doesn't match");
    require(
      msg.sender == address(policy.riskModule),
      "Only riskModule is authorized to resolve the policy"
    );
    delete policies[policy.id];
    delete policyHashes[policy.id];
    emit PolicyResolved(IRiskModule(msg.sender), policy.id, payout);
  }

  function receiveGrant(uint256) external pure override {
    revert("Not Implemented");
  }

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external override {
    _resolvePolicy(policy, payout);
  }

  function resolvePolicyFullPayout(Policy.PolicyData calldata policy, bool customerWon)
    external
    override
  {
    return _resolvePolicy(policy, customerWon ? policy.payout : 0);
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
  uint256 public constant MAX_INT =
    0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

  IERC20Metadata internal _currency;
  IPolicyPoolConfig internal _config;

  constructor(
    address forwardTo,
    IERC20Metadata currency_,
    IPolicyPoolConfig config_
  ) ForwardProxy(forwardTo) {
    _currency = currency_;
    _config = config_;
    _config.connect();
  }

  function currency() external view returns (IERC20Metadata) {
    return _currency;
  }

  function config() external view returns (IPolicyPoolConfig) {
    return _config;
  }

  function setAssetManager(IAssetManager newAssetManager) external {
    require(msg.sender == address(_config), "Only the PolicyPoolConfig can change assetManager");
    if (address(_config.assetManager()) != address(0)) {
      _config.assetManager().deinvestAll(); // deInvest all assets
      _currency.approve(address(_config.assetManager()), 0); // revoke currency management approval
    }
    if (address(newAssetManager) != address(0)) {
      _currency.approve(address(newAssetManager), type(uint256).max);
    }
  }

  // solhint-disable-next-line no-empty-blocks
  function assetEarnings(uint256 amount, bool positive) external {}

  function getInvestable() external view returns (uint256) {
    return _currency.balanceOf(address(this));
  }

  function getETokenCount() external pure returns (uint256) {
    return 0;
  }

  function getETokenAt(uint256) external pure returns (IEToken) {
    return IEToken(address(0));
  }
}
