// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IAssetManager} from "../interfaces/IAssetManager.sol";
import {IInsolvencyHook} from "../interfaces/IInsolvencyHook.sol";
import {IPolicyPoolConfig} from "../interfaces/IPolicyPoolConfig.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IPolicyPoolComponent} from "../interfaces/IPolicyPoolComponent.sol";
import {WadRayMath} from "./WadRayMath.sol";

/**
 * @title PolicyPool Access roles
 * @dev Contract that holds the access roles for PolicyPool and other components of the protocol
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

  // Specific actions roles
  bytes32 public constant REBALANCE_ROLE = keccak256("REBALANCE_ROLE");

  address internal _treasury; // address of Ensuro treasury
  IAssetManager internal _assetManager; // asset manager
  IInsolvencyHook internal _insolvencyHook; // Contract that handles insolvency situations
  IPolicyPool internal _policyPool;

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

  function initialize(
    address treasury_,
    IAssetManager assetManager_,
    IInsolvencyHook insolvencyHook_
  ) public initializer {
    __AccessControl_init();
    __UUPSUpgradeable_init();
    __PolicyPoolConfig_init_unchained(treasury_, assetManager_, insolvencyHook_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __PolicyPoolConfig_init_unchained(
    address treasury_,
    IAssetManager assetManager_,
    IInsolvencyHook insolvencyHook_
  ) internal initializer {
    _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _treasury = treasury_;
    _assetManager = assetManager_;
    _insolvencyHook = insolvencyHook_;
  }

  function connect() external override {
    require(address(_policyPool) == address(0), "PolicyPool already connected");
    _policyPool = IPolicyPool(_msgSender());
    // Not possible to do this validation because connect is called in _policyPool initialize :'(
    // require(_policyPool.config() == this, "PolicyPool not connected to this config");
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address) internal override onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE) {}

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

  function setAssetManager(IAssetManager assetManager_) external onlyRole(LEVEL1_ROLE) {
    _policyPool.setAssetManager(assetManager_);
    _assetManager = assetManager_;
    emit ComponentChanged(GovernanceActions.setAssetManager, address(_assetManager));
  }

  function assetManager() external view virtual override returns (IAssetManager) {
    return _assetManager;
  }

  function setTreasury(address treasury_) external onlyRole(LEVEL1_ROLE) {
    _treasury = treasury_;
    emit ComponentChanged(GovernanceActions.setTreasury, _treasury);
  }

  function treasury() external view override returns (address) {
    return _treasury;
  }

  function setInsolvencyHook(IInsolvencyHook insolvencyHook_)
    external
    onlyRole2(GUARDIAN_ROLE, LEVEL1_ROLE)
  {
    _insolvencyHook = insolvencyHook_;
    emit ComponentChanged(GovernanceActions.setInsolvencyHook, address(_insolvencyHook));
  }

  function insolvencyHook() external view override returns (IInsolvencyHook) {
    return _insolvencyHook;
  }

  function addRiskModule(IRiskModule riskModule) external onlyRole2(LEVEL1_ROLE, LEVEL2_ROLE) {
    require(
      _riskModules[riskModule] == RiskModuleStatus.inactive,
      "Risk Module already in the pool"
    );
    require(address(riskModule) != address(0), "riskModule can't be zero");
    require(
      IPolicyPoolComponent(address(riskModule)).policyPool() == _policyPool,
      "RiskModule not linked to this pool"
    );
    require(
      hasRole(LEVEL1_ROLE, msg.sender) ||
        _policyPool.totalETokenSupply() > (riskModule.scrLimit().wadMul(L2_RM_LIMIT)),
      "RiskModule SCR Limit exceeds the limit for LEVEL2 user"
    );
    _riskModules[riskModule] = RiskModuleStatus.active;
    emit RiskModuleStatusChanged(riskModule, RiskModuleStatus.active);
  }

  function removeRiskModule(IRiskModule riskModule) external onlyRole(LEVEL2_ROLE) {
    require(_riskModules[riskModule] != RiskModuleStatus.inactive, "Risk Module not found");
    require(riskModule.totalScr() == 0, "Can't remove a module with active policies");
    delete _riskModules[riskModule];
    emit RiskModuleStatusChanged(riskModule, RiskModuleStatus.inactive);
  }

  // #if_succeeds_disabled _riskModules.get(riskModule) == newStatus;
  function changeRiskModuleStatus(IRiskModule riskModule, RiskModuleStatus newStatus)
    external
    onlyRole3(GUARDIAN_ROLE, LEVEL1_ROLE, LEVEL2_ROLE)
  {
    require(_riskModules[riskModule] != RiskModuleStatus.inactive, "Risk Module not found");
    require(
      newStatus != RiskModuleStatus.suspended || hasRole(GUARDIAN_ROLE, msg.sender),
      "Only GUARDIAN can suspend modules"
    );
    // To activate LEVEL1 required or LEVEL2 if <5% of total liquidity
    require(
      newStatus != RiskModuleStatus.active ||
        hasRole(LEVEL1_ROLE, msg.sender) ||
        _policyPool.totalETokenSupply() > (riskModule.scrLimit().wadMul(L2_RM_LIMIT)),
      "RiskModule SCR Limit exceeds the limit for LEVEL2 user"
    );
    // Anyone (LEVEL1, LEVEL2, GUARDIAN) can deprecate
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
