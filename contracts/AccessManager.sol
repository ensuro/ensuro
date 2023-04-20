// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IAccessManager} from "./interfaces/IAccessManager.sol";

/**
 * @title AccessManager - Protocol access roles
 * @dev Contract that holds the access roles for PolicyPool and other components of the protocol.
 *
 * [CAUTION]
 * ====
 * Avoid leaving a this contract without DEFAULT_ADMIN_ROLE.
 *
 * This contract includes the methods `revokeRole()` and `renounceRole()` that allow to revoke or renounce to
 * specific roles. Even when there are valid reasons to leave these methods (for example revoking the initial
 * DEFAULT_ADMIN_ROLE of the deployer account to leave just the governance account), it's good to mention these
 * methods have to be used with care, avoiding leaving the contract without any default admin.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract AccessManager is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IAccessManager {
  // Core governance roles
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant LEVEL1_ROLE = keccak256("LEVEL1_ROLE");
  bytes32 public constant LEVEL2_ROLE = keccak256("LEVEL2_ROLE");
  bytes32 public constant LEVEL3_ROLE = keccak256("LEVEL3_ROLE");

  // Mask for "namespacing" component roles within the global namespace
  address private constant ANY_COMPONENT = address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);

  /**
    @dev Modifier that checks if the caller has either role1 or role2.
    */
  modifier onlyRole2(bytes32 role1, bytes32 role2) {
    if (!hasRole(role1, _msgSender())) _checkRole(role2, _msgSender());
    _;
  }

  /**
    @dev Modifier that checks if the caller has admin access to the specific component-role.
    */
  modifier onlyComponentRoleAdmin(address component, bytes32 role) {
    require(component != ANY_COMPONENT, "AccessManager: invalid address for component");

    require(
      // The caller has admin on this specific component-role
      hasRole(getRoleAdmin(getComponentRole(component, role)), _msgSender()) ||
        // or no admin was explicitly defined for this component-role combination and the caller has
        // admin for the role on any component
        (getRoleAdmin(getComponentRole(component, role)) == DEFAULT_ADMIN_ROLE &&
          hasRole(getRoleAdmin(getComponentRole(ANY_COMPONENT, role)), _msgSender())),
      "AccessManager: msg.sender needs componentRoleAdmin"
    );
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

  /**
   * @dev Computes a component role
   * @param component The component address
   * @param role The role to get
   * @return The component role
   */
  function getComponentRole(address component, bytes32 role)
    public
    pure
    override
    returns (bytes32)
  {
    return bytes32(bytes20(component)) ^ role;
  }

  /**
   * @dev Checks if an account has a component role
   * @param component The component address
   * @param role The role to check
   * @param account The account to check
   * @param alsoGlobal If true, check for the global role as well
   * @return Whether the account has the role
   */
  function hasComponentRole(
    address component,
    bytes32 role,
    address account,
    bool alsoGlobal
  ) public view override returns (bool) {
    return
      (alsoGlobal && hasRole(role, account)) || hasRole(getComponentRole(component, role), account);
  }

  /**
   * @dev Checks if an account has a component role and reverts if not
   * @param component The component address
   * @param role The role to check
   * @param account The account to check
   * @param alsoGlobal If true, check for the global role as well
   */
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

  /**
   * @dev Checks if an account has either of the role1 or role2 component roles and reverts if not
   * @param component The component address
   * @param role1 The first role to check
   * @param role2 The second role to check
   * @param account The account to check
   * @param alsoGlobal If true, check for the global role as well
   */
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

  /**
   * @dev Checks if an account has a specific role and revert if not
   * @param role The role to check.
   * @param account The account to check for the role.
   */
  function checkRole(bytes32 role, address account) external view override {
    _checkRole(role, account);
  }

  /**
   * @dev Checks if an account has a either role1 or role2 and revert if not
   * @param role1 The first role to check.
   * @param role2 The second role to check.
   * @param account The account to check for the role.
   */
  function checkRole2(
    bytes32 role1,
    bytes32 role2,
    address account
  ) external view override {
    if (!hasRole(role1, account)) _checkRole(role2, account);
  }

  /**
   * @dev Grants `account` the component role `role` for the component with address `component`.
   *
   * Requirements:
   * - the caller must have role admin for this component-role combination or role admin for any component
   *
   * @param component Address of the component for which the role is being granted.
   * @param role Bytes32 identifier of the role being granted.
   * @param account Address of the account being granted the role.
   */
  function grantComponentRole(
    address component,
    bytes32 role,
    address account
  ) external onlyComponentRoleAdmin(component, role) {
    _grantRole(getComponentRole(component, role), account);
  }

  /**
   * @dev Sets `adminRole` as the admin role for the component-role combination or for any component.
   *
   * Requirements:
   * - caller must be the current admin for the role
   *
   * If `component` is the zero address, admin is granted for any component.
   */
  function setComponentRoleAdmin(
    address component,
    bytes32 role,
    bytes32 adminRole
  ) external onlyComponentRoleAdmin(component, role) {
    if (component == address(0)) component = ANY_COMPONENT;
    _setRoleAdmin(getComponentRole(component, role), adminRole);
  }

  /**
   * @dev Set `adminRole` as the admin role of `role`.
   * Requirements:
   * - the caller must be the current admin of the given `role`.
   */
  function setRoleAdmin(bytes32 role, bytes32 adminRole) external onlyRole(getRoleAdmin(role)) {
    _setRoleAdmin(role, adminRole);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
