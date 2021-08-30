// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {IPolicyPoolConfig} from "../interfaces/IPolicyPoolConfig.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import {WadRayMath} from "./WadRayMath.sol";

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
  using WadRayMath for uint256;

  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant LEVEL1_ROLE = keccak256("LEVEL1_ROLE");
  bytes32 public constant LEVEL2_ROLE = keccak256("LEVEL2_ROLE");
  bytes32 public constant LEVEL3_ROLE = keccak256("LEVEL3_ROLE");

  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
  bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

  uint40 public constant TWEAK_EXPIRATION = 1 days;

  IPolicyPool internal _policyPool;
  uint40 internal _lastTweakTimestamp;
  uint56 internal _lastTweakActions; // bitwise map of applied actions

  event GovernanceAction(IPolicyPoolConfig.GovernanceActions indexed action, uint256 value);

  modifier onlyPoolRole3(
    bytes32 role1,
    bytes32 role2,
    bytes32 role3
  ) {
    if (!hasPoolRole(role1)) {
      _policyPool.config().checkRole2(role2, role3, msg.sender);
    }
    _;
  }

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

  function unpause() public onlyPoolRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {
    _unpause();
  }

  function policyPool() public view override returns (IPolicyPool) {
    return _policyPool;
  }

  function hasPoolRole(bytes32 role) internal view returns (bool) {
    return _policyPool.config().hasRole(role, msg.sender);
  }

  function _isTweakRay(
    uint256 oldValue,
    uint256 newValue,
    uint256 maxTweak
  ) internal pure returns (bool) {
    if (oldValue == newValue) return true;
    if (oldValue == 0) return maxTweak >= WadRayMath.RAY;
    if (newValue == 0) return false;
    if (oldValue < newValue) {
      return (newValue.rayDiv(oldValue) - WadRayMath.RAY) <= maxTweak;
    } else {
      return (WadRayMath.RAY - newValue.rayDiv(oldValue)) <= maxTweak;
    }
  }

  function _isTweakWad(
    uint256 oldValue,
    uint256 newValue,
    uint256 maxTweak
  ) internal pure returns (bool) {
    if (oldValue == newValue) return true;
    if (oldValue == 0) return maxTweak >= WadRayMath.WAD;
    if (newValue == 0) return false;
    if (oldValue < newValue) {
      return (newValue.wadDiv(oldValue) - WadRayMath.WAD) <= maxTweak;
    } else {
      return (WadRayMath.WAD - newValue.wadDiv(oldValue)) <= maxTweak;
    }
  }

  function _parameterChanged(
    IPolicyPoolConfig.GovernanceActions action,
    uint256 value,
    bool tweak
  ) internal {
    if (tweak) _registerTweak(action);
    emit GovernanceAction(action, value);
  }

  function lastTweak() external view returns (uint40, uint56) {
    return (_lastTweakTimestamp, _lastTweakActions);
  }

  function _registerTweak(IPolicyPoolConfig.GovernanceActions action) internal {
    uint56 actionBitMap = uint56(1 << (uint8(action) - 1));
    if ((uint40(block.timestamp) - _lastTweakTimestamp) > TWEAK_EXPIRATION) {
      _lastTweakTimestamp = uint40(block.timestamp);
      _lastTweakActions = actionBitMap;
    } else {
      if ((actionBitMap & _lastTweakActions) == 0) {
        _lastTweakActions |= actionBitMap;
        _lastTweakTimestamp = uint40(block.timestamp); // Updates the expiration
      } else {
        revert("You already tweaked this parameter recently. Wait before tweaking again");
      }
    }
  }
}
