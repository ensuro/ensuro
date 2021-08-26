// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

/**
 * @title Base class for PolicyPool components
 * @dev
 * @author Ensuro
 */
abstract contract PolicyPoolComponent is
  UUPSUpgradeable,
  PausableUpgradeable,
  IPolicyPoolComponent
{
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant LEVEL1_ROLE = keccak256("LEVEL1_ROLE");
  bytes32 public constant LEVEL2_ROLE = keccak256("LEVEL2_ROLE");
  bytes32 public constant LEVEL3_ROLE = keccak256("LEVEL3_ROLE");

  bytes32 public constant ENSURO_DAO_ROLE = keccak256("ENSURO_DAO_ROLE");

  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
  bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

  IPolicyPool internal _policyPool;

  modifier onlyPoolRole2(bytes32 role1, bytes32 role2) {
    _policyPool.config().checkRole2(role1, role2, msg.sender);
    _;
  }

  modifier onlyPoolRole(bytes32 role) {
    _policyPool.config().checkRole(role, msg.sender);
    _;
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyPoolComponent_init(IPolicyPool policyPool_) internal initializer {
    __UUPSUpgradeable_init();
    __Pausable_init();
    __PolicyPoolComponent_init_unchained(policyPool_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyPoolComponent_init_unchained(IPolicyPool policyPool_) internal initializer {
    _policyPool = policyPool_;
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address) internal override onlyPoolRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {}

  function pause() public onlyPoolRole(GUARDIAN_ROLE) {
    _pause();
  }

  function unpause() public onlyPoolRole(GUARDIAN_ROLE) {
    _unpause();
  }

  function policyPool() public view override returns (IPolicyPool) {
    return _policyPool;
  }
}
