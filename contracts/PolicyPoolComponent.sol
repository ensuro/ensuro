// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IAccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";

/**
 * @title Base class for PolicyPool components
 * @dev
 * @author Ensuro
 */
abstract contract PolicyPoolComponent is
  Initializable,
  IPolicyPoolComponent
{
  IPolicyPool internal _policyPool;

  modifier onlyPoolRole2(bytes32 role1, bytes32 role2) {
    _policyPool.config().checkRole2(role1, role2, msg.sender);
    _;
  }

  modifier onlyPoolRole(bytes32 role) {
    _policyPool.config().checkRole(role, msg.sender);
    _;
  }

  function __PolicyPoolComponent_init(IPolicyPool policyPool_) internal initializer {
    __PolicyPoolComponent_init_unchained(policyPool_);
  }

  function __PolicyPoolComponent_init_unchained(IPolicyPool policyPool_) internal initializer {
    _policyPool = policyPool_;
  }

  function policyPool() public view override returns (IPolicyPool) {
    return _policyPool;
  }
}
