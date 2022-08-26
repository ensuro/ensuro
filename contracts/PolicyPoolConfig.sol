// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IPolicyPoolConfig} from "./interfaces/IPolicyPoolConfig.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";
import {ILPWhitelist} from "./interfaces/ILPWhitelist.sol";
import {IExchange} from "./interfaces/IExchange.sol";
import {IPolicyPoolComponent} from "./interfaces/IPolicyPoolComponent.sol";
import {WadRayMath} from "./WadRayMath.sol";

/**
 * @title PolicyPoolConfig - Protocol access roles and other settings/components
 * @dev Contract that holds the access roles for PolicyPool and other components of the protocol.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract PolicyPoolConfig is
  Initializable,
  AccessControlUpgradeable,
  UUPSUpgradeable,
  IPolicyPoolConfig
{
  using WadRayMath for uint256;

  // Core governance roles
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  bytes32 public constant LEVEL1_ROLE = keccak256("LEVEL1_ROLE");
  bytes32 public constant LEVEL2_ROLE = keccak256("LEVEL2_ROLE");
  bytes32 public constant LEVEL3_ROLE = keccak256("LEVEL3_ROLE");

  uint256 public constant L2_RM_LIMIT = 5e16; // 5% in WAD

  address internal _treasury; // address of Ensuro treasury
  IPolicyPool internal _policyPool;
  ILPWhitelist internal _lpWhitelist; // Contract that handles whitelisting of Liquidity Providers
  IExchange internal _exchange; // Contract that handles exchange operations between assets

  mapping(IRiskModule => RiskModuleStatus) private _riskModules;

  event ComponentChanged(IPolicyPoolConfig.GovernanceActions indexed action, address value);

  modifier onlyRole2(bytes32 role1, bytes32 role2) {
    if (!hasRole(role1, _msgSender())) _checkRole(role2, _msgSender());
    _;
  }

  modifier onlyRole3(
    bytes32 role1,
    bytes32 role2,
    bytes32 role3
  ) {
    if (!hasRole(role1, _msgSender()) && !hasRole(role2, _msgSender())) {
      _checkRole(role3, _msgSender());
    }
    _;
  }

  function initialize(IPolicyPool policyPool_, address treasury_) public initializer {
    __AccessControl_init();
    __UUPSUpgradeable_init();
    __PolicyPoolConfig_init_unchained(policyPool_, treasury_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyPoolConfig_init_unchained(IPolicyPool policyPool_, address treasury_)
    internal
    initializer
  {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _policyPool = policyPool_;
    _treasury = treasury_;
  }

  /**
   * @dev This function can be called only once in contract's lifetime. It links the PolicyPoolConfig with the
   *      PolicyPool contract. It's called in PolicyPool initialization.
   */
  function connect() external override {
    require(
      address(_policyPool) == address(0) || address(_policyPool) == _msgSender(),
      "PolicyPool already connected"
    );
    _policyPool = IPolicyPool(_msgSender());
    // Not possible to do this validation because connect is called in _policyPool initialize :'(
    // require(_policyPool.config() == this, "PolicyPool not connected to this config");
  }

  function policyPool() external view returns (IPolicyPool) {
    return _policyPool;
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address) internal override onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {}

  function getComponentRole(address component, bytes32 role) public pure returns (bytes32) {
    return bytes32(bytes20(component)) ^ role;
  }

  function checkComponentRole(
    address component,
    bytes32 role,
    address account
  ) external view override {
    _checkRole(getComponentRole(component, role), account);
  }

  function grantComponentRole(
    address component,
    bytes32 role,
    address account
  ) external onlyRole(getRoleAdmin(getComponentRole(component, role))) {
    _grantRole(getComponentRole(component, role), account);
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

  function setTreasury(address treasury_) external onlyRole(LEVEL1_ROLE) {
    _treasury = treasury_;
    emit ComponentChanged(GovernanceActions.setTreasury, _treasury);
  }

  function treasury() external view override returns (address) {
    return _treasury;
  }

  function setLPWhitelist(ILPWhitelist lpWhitelist_)
    external
    onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE)
  {
    require(
      address(lpWhitelist_) == address(0) ||
        IPolicyPoolComponent(address(lpWhitelist_)).policyPool() == _policyPool,
      "Component not linked to this PolicyPool"
    );
    _lpWhitelist = lpWhitelist_;
    emit ComponentChanged(GovernanceActions.setLPWhitelist, address(_lpWhitelist));
  }

  function lpWhitelist() external view override returns (ILPWhitelist) {
    return _lpWhitelist;
  }

  function setExchange(IExchange exchange_) external onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {
    require(
      address(exchange_) == address(0) ||
        IPolicyPoolComponent(address(exchange_)).policyPool() == _policyPool,
      "Component not linked to this PolicyPool"
    );
    _exchange = exchange_;
    emit ComponentChanged(GovernanceActions.setExchange, address(_exchange));
  }

  function exchange() external view override returns (IExchange) {
    return _exchange;
  }

  function addRiskModule(IRiskModule riskModule) external onlyRole(LEVEL1_ROLE) {
    require(
      _riskModules[riskModule] == RiskModuleStatus.inactive,
      "Risk Module already in the pool"
    );
    require(address(riskModule) != address(0), "riskModule can't be zero");
    require(
      IPolicyPoolComponent(address(riskModule)).policyPool() == _policyPool,
      "RiskModule not linked to this pool"
    );
    _riskModules[riskModule] = RiskModuleStatus.active;
    emit RiskModuleStatusChanged(riskModule, RiskModuleStatus.active);
  }

  function removeRiskModule(IRiskModule riskModule) external onlyRole(LEVEL2_ROLE) {
    require(_riskModules[riskModule] != RiskModuleStatus.inactive, "Risk Module not found");
    require(riskModule.activeExposure() == 0, "Can't remove a module with active policies");
    delete _riskModules[riskModule];
    emit RiskModuleStatusChanged(riskModule, RiskModuleStatus.inactive);
  }

  function changeRiskModuleStatus(IRiskModule riskModule, RiskModuleStatus newStatus)
    external
    onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE)
  {
    require(_riskModules[riskModule] != RiskModuleStatus.inactive, "Risk Module not found");
    require(
      newStatus != RiskModuleStatus.suspended || hasRole(GUARDIAN_ROLE, msg.sender),
      "Only GUARDIAN can suspend modules"
    );
    // To activate LEVEL1 required or LEVEL2 if <5% of total liquidity
    require(hasRole(LEVEL1_ROLE, msg.sender), "Only LEVEL1 can activate modules");
    // Anyone (LEVEL1, GUARDIAN) can deprecate
    _riskModules[riskModule] = newStatus;
    emit RiskModuleStatusChanged(riskModule, newStatus);
  }

  function checkAcceptsNewPolicy(IRiskModule riskModule) external view override {
    RiskModuleStatus rmStatus = _riskModules[riskModule];
    require(rmStatus == RiskModuleStatus.active, "RM module not found or not active");
  }

  function checkAcceptsResolvePolicy(IRiskModule riskModule) external view override {
    RiskModuleStatus rmStatus = _riskModules[riskModule];
    require(
      rmStatus == RiskModuleStatus.active || rmStatus == RiskModuleStatus.deprecated,
      "Module must be active or deprecated to process resolutions"
    );
  }
}
