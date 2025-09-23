// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Policy} from "../Policy.sol";
import {ForwardProxy} from "./ForwardProxy.sol";

contract PolicyPoolMock is IPolicyPool {
  using Policy for Policy.PolicyData;

  uint256 public constant MAX_INT = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

  IERC20Metadata internal _currency;

  mapping(uint256 => Policy.PolicyData) internal policies;
  mapping(uint256 => bytes32) internal policyHashes;

  constructor(IERC20Metadata currency_) {
    _currency = currency_;
  }

  function currency() external view override returns (IERC20Metadata) {
    return _currency;
  }

  function treasury() external pure override returns (address) {
    return address(0);
  }

  function newPolicy(
    Policy.PolicyData memory policy,
    address /* payer */,
    address /* policyHolder */,
    uint96 internalId
  ) external override returns (uint256) {
    policy.id = (uint256(uint160(msg.sender)) << 96) + internalId;
    policyHashes[policy.id] = policy.hash();
    emit NewPolicy(IRiskModule(msg.sender), policy);
    return policy.id;
  }

  function replacePolicy(
    Policy.PolicyData memory oldPolicy,
    Policy.PolicyData memory newPolicy_,
    address /* payer */,
    uint96 internalId
  ) external override returns (uint256) {
    newPolicy_.id = (uint256(uint160(msg.sender)) << 96) + internalId;
    policyHashes[newPolicy_.id] = newPolicy_.hash();
    IRiskModule rm = IRiskModule(msg.sender);
    emit NewPolicy(rm, newPolicy_);
    emit PolicyReplaced(IRiskModule(msg.sender), oldPolicy.id, newPolicy_.id);
    return newPolicy_.id;
  }

  function extractRiskModule(uint256 policyId) public pure returns (IRiskModule) {
    return IRiskModule(address(uint160(policyId >> 96)));
  }

  function _resolvePolicy(Policy.PolicyData memory policy, uint256 payout) internal {
    require(policy.id != 0, "Policy not found");
    require(policy.hash() == policyHashes[policy.id], "Hash doesn't match");
    delete policies[policy.id];
    delete policyHashes[policy.id];
    emit PolicyResolved(IRiskModule(msg.sender), policy.id, payout);
  }

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external override {
    _resolvePolicy(policy, payout);
  }

  function expirePolicy(Policy.PolicyData calldata policy) external override {
    _resolvePolicy(policy, 0);
  }

  function resolvePolicyFullPayout(Policy.PolicyData calldata policy, bool customerWon) external override {
    return _resolvePolicy(policy, customerWon ? policy.payout : 0);
  }

  function isActive(uint256 policyId) external view override returns (bool) {
    return policyHashes[policyId] != bytes32(0);
  }

  function getPolicyHash(uint256 policyId) external view override returns (bytes32) {
    return policyHashes[policyId];
  }

  function deposit(IEToken, uint256) external pure override {
    revert("Not Implemented deposit");
  }

  function withdraw(IEToken, uint256) external pure override returns (uint256) {
    revert("Not Implemented withdraw");
  }

  /**
   * @dev Simple passthrough method for testing Policy.initialize
   */
  function initializeAndEmitPolicy(
    Policy.Params memory rmParams,
    uint256 premium,
    uint256 payout,
    uint256 lossProb,
    uint40 expiration,
    uint40 start
  ) external {
    Policy.PolicyData memory policy = Policy.initialize(
      rmParams,
      premium,
      payout,
      lossProb,
      expiration,
      start == 0 ? uint40(block.timestamp) : start
    );

    emit NewPolicy(IRiskModule(address(0)), policy);
  }
}

/**
 * @title PolicyPoolMockForward
 * @dev PolicyPool that forwards fallback calls to another contract. Used to simulate calls to EToken
 *      and other contracts that have functions that can be called only from PolicyPool
 */
contract PolicyPoolMockForward is ForwardProxy {
  uint256 public constant MAX_INT = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

  IERC20Metadata internal _currency;

  constructor(address forwardTo, IERC20Metadata currency_) ForwardProxy(forwardTo) {
    _currency = currency_;
  }

  function currency() external view returns (IERC20Metadata) {
    return _currency;
  }
}
