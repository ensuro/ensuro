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
    if (!hasPoolRole(role1, msg.sender))
      _checkPoolRole(role2, msg.sender);
    _;
  }

  modifier onlyPoolRole(bytes32 role) {
      _checkPoolRole(role, msg.sender);
      _;
  }

  function __PolicyPoolComponent_init(IPolicyPool policyPool_) internal initializer {
      __PolicyPoolComponent_init_unchained(policyPool_);
  }

  function __PolicyPoolComponent_init_unchained(IPolicyPool policyPool_) internal initializer {
    _policyPool = policyPool_;
  }

  function hasPoolRole(bytes32 role, address account) internal view returns (bool) {
    return IAccessControlUpgradeable(address(_policyPool)).hasRole(role, account);
  }

  /**
   * @dev Revert with a standard message if `account` is missing `role`.
   *
   * The format of the revert reason is given by the following regular expression:
   *
   *  /^AccessControl: account (0x[0-9a-f]{20}) is missing role (0x[0-9a-f]{32})$/
   */
  function _checkPoolRole(bytes32 role, address account) internal view {
    if (!hasPoolRole(role, account)) {
      revert(
        string(
          abi.encodePacked(
            "AccessControl: account ",
            Strings.toHexString(uint160(account), 20),
            " is missing Pool role ",
            Strings.toHexString(uint256(role), 32)
          )
        )
      );
    }
  }

  function policyPool() public view override returns (IPolicyPool) {
    return _policyPool;
  }
}
