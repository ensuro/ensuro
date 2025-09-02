// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {Governance} from "./Governance.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {WadRayMath} from "./dependencies/WadRayMath.sol";

/**
 * @title Base class for PolicyPool components
 * @dev This is the base class of all the components of the protocol that are linked to the PolicyPool and created
 *      after it.
 *      Holds the reference to _policyPool as immutable, also provides access to common admin roles:
 *
 *      This contract also keeps track of the tweaks to avoid two tweaks of the same type are done in a short period.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract PolicyPoolComponent is UUPSUpgradeable, PausableUpgradeable, IPolicyPoolComponent {
  using WadRayMath for uint256;

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPolicyPool internal immutable _policyPool;

  event GovernanceAction(Governance.GovernanceActions indexed action, uint256 value);
  event ComponentChanged(Governance.GovernanceActions indexed action, address value);

  error NoZeroPolicyPool();
  error UpgradeCannotChangePolicyPool();
  error OnlyPolicyPool();

  modifier onlyPolicyPool() {
    require(_msgSender() == address(_policyPool), OnlyPolicyPool());
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPolicyPool policyPool_) {
    if (address(policyPool_) == address(0)) revert NoZeroPolicyPool();
    _disableInitializers();
    _policyPool = policyPool_;
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyPoolComponent_init() internal onlyInitializing {
    __UUPSUpgradeable_init();
    __Pausable_init();
  }

  function _authorizeUpgrade(address newImpl) internal view override {
    _upgradeValidations(newImpl);
  }

  function _upgradeValidations(address newImpl) internal view virtual {
    if (IPolicyPoolComponent(newImpl).policyPool() != _policyPool) revert UpgradeCannotChangePolicyPool();
  }

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return interfaceId == type(IERC165).interfaceId || interfaceId == type(IPolicyPoolComponent).interfaceId;
  }

  function pause() public {
    _pause();
  }

  function unpause() public {
    _unpause();
  }

  function policyPool() public view override returns (IPolicyPool) {
    return _policyPool;
  }

  function currency() public view returns (IERC20Metadata) {
    return _policyPool.currency();
  }

  // solhint-disable-next-line no-empty-blocks
  function _validateParameters() internal view virtual {} // Must be reimplemented with specific validations

  function _parameterChanged(Governance.GovernanceActions action, uint256 value) internal {
    _validateParameters();
    emit GovernanceAction(action, value);
  }

  function _componentChanged(Governance.GovernanceActions action, address value) internal {
    _validateParameters();
    emit ComponentChanged(action, value);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
