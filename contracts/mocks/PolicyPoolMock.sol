// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IEToken} from "../interfaces/IEToken.sol";
import {IAccessManager} from "../interfaces/IAccessManager.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Policy} from "../Policy.sol";
import {ForwardProxy} from "./ForwardProxy.sol";

contract PolicyPoolMock is IPolicyPool {
  using Policy for Policy.PolicyData;

  uint256 public constant MAX_INT =
    0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

  IERC20Metadata internal _currency;
  IAccessManager internal _access;

  mapping(uint256 => Policy.PolicyData) internal policies;
  mapping(uint256 => bytes32) internal policyHashes;

  event NewPolicy(IRiskModule indexed riskModule, Policy.PolicyData policy);
  event PolicyResolved(IRiskModule indexed riskModule, uint256 indexed policyId, uint256 payout);

  constructor(IERC20Metadata currency_, IAccessManager access_) {
    _currency = currency_;
    _access = access_;
  }

  function currency() external view override returns (IERC20Metadata) {
    return _currency;
  }

  function access() external view override returns (IAccessManager) {
    return _access;
  }

  function treasury() external pure override returns (address) {
    return address(0);
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

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external override {
    _resolvePolicy(policy, payout);
  }

  function expirePolicy(Policy.PolicyData calldata policy) external override {
    _resolvePolicy(policy, 0);
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
  IAccessManager internal _access;

  constructor(
    address forwardTo,
    IERC20Metadata currency_,
    IAccessManager access_
  ) ForwardProxy(forwardTo) {
    _currency = currency_;
    _access = access_;
  }

  function currency() external view returns (IERC20Metadata) {
    return _currency;
  }

  function access() external view returns (IAccessManager) {
    return _access;
  }
}
