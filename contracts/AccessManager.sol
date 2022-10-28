// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IAccessManager} from "./interfaces/IAccessManager.sol";

/**
 * @title AccessManager - Protocol access roles
 * @dev Contract that holds the access roles for PolicyPool and other components of the protocol.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract AccessManager is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IAccessManager {
  // Core governance roles
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant LEVEL1_ROLE = keccak256("LEVEL1_ROLE");
  bytes32 public constant LEVEL2_ROLE = keccak256("LEVEL2_ROLE");
  bytes32 public constant LEVEL3_ROLE = keccak256("LEVEL3_ROLE");

  modifier onlyRole2(bytes32 role1, bytes32 role2) {
    if (!hasRole(role1, _msgSender())) _checkRole(role2, _msgSender());
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize() public initializer {
    __AccessControl_init();
    __UUPSUpgradeable_init();
    __AccessManager_init_unchained();
  }

  // solhint-disable-next-line func-name-mixedcase
  function __AccessManager_init_unchained() internal onlyInitializing {
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address) internal override onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {}

  /**
   * @dev See {IERC165-supportsInterface}.
   */
  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return super.supportsInterface(interfaceId) || interfaceId == type(IAccessManager).interfaceId;
  }

  function getComponentRole(address component, bytes32 role)
    public
    pure
    override
    returns (bytes32)
  {
    return bytes32(bytes20(component)) ^ role;
  }

  function hasComponentRole(
    address component,
    bytes32 role,
    address account,
    bool alsoGlobal
  ) public view override returns (bool) {
    return
      (alsoGlobal && hasRole(role, account)) || hasRole(getComponentRole(component, role), account);
  }

  function checkComponentRole(
    address component,
    bytes32 role,
    address account,
    bool alsoGlobal
  ) external view override {
    if (!alsoGlobal || !hasRole(role, account)) {
      _checkRole(getComponentRole(component, role), account);
    }
  }

  function checkComponentRole2(
    address component,
    bytes32 role1,
    bytes32 role2,
    address account,
    bool alsoGlobal
  ) external view override {
    if (alsoGlobal && hasRole(role1, account)) return;
    if (hasRole(getComponentRole(component, role1), account)) return;
    if (alsoGlobal && hasRole(role2, account)) return;
    _checkRole(getComponentRole(component, role2), account);
  }

  function checkRole(bytes32 role, address account) external view override {
    _checkRole(role, account);
  }

  function checkRole2(
    bytes32 role1,
    bytes32 role2,
    address account
  ) external view override {
    if (!hasRole(role1, account)) _checkRole(role2, account);
  }

  function grantComponentRole(
    address component,
    bytes32 role,
    address account
  ) external onlyRole(getRoleAdmin(getComponentRole(component, role))) {
    _grantRole(getComponentRole(component, role), account);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
