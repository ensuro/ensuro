// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {WadRayMath} from "./WadRayMath.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
import {IPremiumsAccount} from "../interfaces/IPremiumsAccount.sol";
import {IPolicyPoolConfig} from "../interfaces/IPolicyPoolConfig.sol";
import {Policy} from "./Policy.sol";

/**
 * @title Ensuro Risk Module base contract
 * @dev Risk Module that keeps the configuration and is responsible for pricing and policy resolution
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract RiskModule is IRiskModule, AccessControlUpgradeable, PolicyPoolComponent {
  using Policy for Policy.PolicyData;
  using WadRayMath for uint256;

  uint256 internal constant SECONDS_IN_YEAR_RAY = 31536000e27; /* 365 * 24 * 3600 * 10e27 */

  // For parameters that can be changed by the risk module provider
  bytes32 public constant RM_PROVIDER_ROLE = keccak256("RM_PROVIDER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPremiumsAccount internal immutable _premiumsAccount;

  string private _name;
  uint256 internal _collRatio; // in ray - Collateralization Ratio to compute solvency requirement as % of payout
  uint256 internal _moc; // in ray - Margin Of Conservativism - factor that multiplies lossProb
  // to calculate purePremium
  uint256 internal _ensuroPpFee; // in ray - % of pure premium that will go for Ensuro treasury
  uint256 internal _ensuroCocFee; // in ray - % of cost of capital that will go for Ensuro treasury
  uint256 internal _roc; // in ray - return on capital paid to LPs - Annualized Percentage
  uint256 internal _maxPayoutPerPolicy; // in wad - Max payout per policy
  uint256 internal _exposureLimit; // in wad - Max exposure (sum of payouts) to be allocated to this module
  uint256 internal _activeExposure; // in wad - Current exposure of active policies

  address internal _wallet; // Address of the RiskModule provider

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IPolicyPool policyPool_, IPremiumsAccount premiumsAccount_)
    PolicyPoolComponent(policyPool_)
  {
    require(
      PolicyPoolComponent(address(premiumsAccount_)).policyPool() == policyPool_,
      "The PremiumsAccount must be part of the Pool"
    );
    _premiumsAccount = premiumsAccount_;
  }

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param collRatio_ Collateralization ratio to compute solvency requirement as % of payout (in ray)
   * @param ensuroPpFee_ % of pure premium that will go for Ensuro treasury (in ray)
   * @param roc_ return on capital paid to LPs (annualized percentage - in ray)
   * @param maxPayoutPerPolicy_ Maximum payout per policy (in wad)
   * @param exposureLimit_ Max exposure (sum of payouts) to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   */
  // solhint-disable-next-line func-name-mixedcase
  function __RiskModule_init(
    string memory name_,
    uint256 collRatio_,
    uint256 ensuroPpFee_,
    uint256 roc_,
    uint256 maxPayoutPerPolicy_,
    uint256 exposureLimit_,
    address wallet_
  ) internal initializer {
    __AccessControl_init();
    __PolicyPoolComponent_init();
    __RiskModule_init_unchained(
      name_,
      collRatio_,
      ensuroPpFee_,
      roc_,
      maxPayoutPerPolicy_,
      exposureLimit_,
      wallet_
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function __RiskModule_init_unchained(
    string memory name_,
    uint256 collRatio_,
    uint256 ensuroPpFee_,
    uint256 roc_,
    uint256 maxPayoutPerPolicy_,
    uint256 exposureLimit_,
    address wallet_
  ) internal initializer {
    _name = name_;
    _collRatio = collRatio_;
    _moc = WadRayMath.RAY;
    _ensuroPpFee = ensuroPpFee_;
    _roc = roc_;
    _maxPayoutPerPolicy = maxPayoutPerPolicy_;
    _exposureLimit = exposureLimit_;
    _activeExposure = 0;
    _wallet = wallet_;
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    _validateParameters();
  }

  // runs validation on RiskModule parameters
  function _validateParameters() internal view override {
    require(_collRatio <= WadRayMath.RAY && _collRatio > 0, "Validation: collRatio must be <=1");
    require(
      _moc <= (2 * WadRayMath.RAY) && _moc >= (WadRayMath.RAY / 2),
      "Validation: moc must be [0.5, 2]"
    );
    require(_ensuroPpFee <= WadRayMath.RAY, "Validation: ensuroPpFee must be <= 1");
    require(_ensuroCocFee <= WadRayMath.RAY, "Validation: ensuroCocFee must be <= 1");
    require(_roc <= WadRayMath.RAY, "Validation: roc must be <= 1 (100%)");
    // _maxPayoutPerPolicy no limits
    require(
      _exposureLimit >= _activeExposure,
      "Validation: exposureLimit can't be less than actual activeExposure"
    );
    require(_wallet != address(0), "Validation: Wallet can't be zero address");
  }

  function name() public view override returns (string memory) {
    return _name;
  }

  function collRatio() public view override returns (uint256) {
    return _collRatio;
  }

  function moc() public view override returns (uint256) {
    return _moc;
  }

  function ensuroPpFee() public view override returns (uint256) {
    return _ensuroPpFee;
  }

  function ensuroCocFee() public view override returns (uint256) {
    return _ensuroCocFee;
  }

  function roc() public view override returns (uint256) {
    return _roc;
  }

  function maxPayoutPerPolicy() public view override returns (uint256) {
    return _maxPayoutPerPolicy;
  }

  function exposureLimit() public view override returns (uint256) {
    return _exposureLimit;
  }

  function activeExposure() public view override returns (uint256) {
    return _activeExposure;
  }

  function wallet() public view override returns (address) {
    return _wallet;
  }

  function setCollRatio(uint256 newCollRatio) external onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE) {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_collRatio, newCollRatio, 1e26),
      "Tweak exceeded: collRatio tweaks only up to 10%"
    );
    _collRatio = newCollRatio;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setCollRatio, newCollRatio, tweak);
  }

  function setMoc(uint256 newMoc) external onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE) {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(!tweak || _isTweakRay(_moc, newMoc, 1e26), "Tweak exceeded: moc tweaks only up to 10%");
    _moc = newMoc;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setMoc, newMoc, tweak);
  }

  function setRoc(uint256 newRoc) external onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE) {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(!tweak || _isTweakRay(_roc, newRoc, 3e26), "Tweak exceeded: roc tweaks only up to 30%");
    _roc = newRoc;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setRoc, newRoc, tweak);
  }

  function setEnsuroPpFee(uint256 newValue) external onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE) {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_ensuroPpFee, newValue, 3e26),
      "Tweak exceeded: ensuroPpFee tweaks only up to 30%"
    );
    _ensuroPpFee = newValue;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setEnsuroPpFee, newValue, tweak);
  }

  function setEnsuroCocFee(uint256 newValue) external onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE) {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_ensuroCocFee, newValue, 3e26),
      "Tweak exceeded: ensuroCocFee tweaks only up to 30%"
    );
    _ensuroCocFee = newValue;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setEnsuroCocFee, newValue, tweak);
  }

  function setMaxPayoutPerPolicy(uint256 newMaxPayoutPerPolicy)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakWad(_maxPayoutPerPolicy, newMaxPayoutPerPolicy, 3e17),
      "Tweak exceeded: maxPayoutPerPolicy tweaks only up to 30%"
    );
    _maxPayoutPerPolicy = newMaxPayoutPerPolicy;
    _parameterChanged(
      IPolicyPoolConfig.GovernanceActions.setMaxPayoutPerPolicy,
      newMaxPayoutPerPolicy,
      tweak
    );
  }

  function setExposureLimit(uint256 newExposureLimit)
    external
    onlyPoolRole3(LEVEL1_ROLE, LEVEL2_ROLE, LEVEL3_ROLE)
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE) && !hasPoolRole(LEVEL1_ROLE);
    require(
      !tweak || _isTweakWad(_exposureLimit, newExposureLimit, 1e17),
      "Tweak exceeded: exposureLimit tweaks only up to 10%"
    );
    require(
      newExposureLimit <= _exposureLimit ||
        hasPoolRole(LEVEL1_ROLE) ||
        _policyPool.totalETokenSupply().wadMul(1e17) > newExposureLimit,
      "Tweak exceeded: Increase, >=10% of the total liquidity, requires LEVEL1_ROLE"
    );
    require(newExposureLimit >= _activeExposure, "Can't set SCR less than current SCR allocation");
    _exposureLimit = newExposureLimit;
    _parameterChanged(
      IPolicyPoolConfig.GovernanceActions.setExposureLimit,
      newExposureLimit,
      tweak
    );
  }

  function setWallet(address wallet_) external onlyRole(RM_PROVIDER_ROLE) {
    _wallet = wallet_;
    _parameterChanged(
      IPolicyPoolConfig.GovernanceActions.setWallet,
      uint256(uint160(wallet_)),
      false
    );
  }

  function getMinimumPremium(
    uint256 payout,
    uint256 lossProb,
    uint40 expiration
  ) public view returns (uint256) {
    uint256 purePremium = payout.wadToRay().rayMul(lossProb.rayMul(moc())).rayToWad();
    uint256 scr = payout.wadMul(collRatio().rayToWad()) - purePremium;
    uint256 interestRate = ((roc() * (expiration - block.timestamp)).rayDiv(SECONDS_IN_YEAR_RAY))
      .rayToWad();
    uint256 coc = scr.wadMul(interestRate);
    uint256 ensuroCommission = purePremium.wadMul(ensuroPpFee().rayToWad()) +
      coc.wadMul(ensuroCocFee().rayToWad());
    return purePremium + ensuroCommission + coc;
  }

  function _newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address customer,
    uint96 internalId
  ) internal whenNotPaused returns (Policy.PolicyData memory) {
    require(premium < payout, "Premium must be less than payout");
    require(expiration > uint40(block.timestamp), "Expiration must be in the future");
    require(customer != address(0), "Customer can't be zero address");
    require(
      _policyPool.currency().allowance(customer, address(_policyPool)) >= premium,
      "You must allow ENSURO to transfer the premium"
    );
    require(payout <= _maxPayoutPerPolicy, "RiskModule: Payout is more than maximum per policy");
    Policy.PolicyData memory policy = Policy.initialize(
      this,
      premium,
      payout,
      lossProb,
      expiration
    );
    _activeExposure += policy.payout;
    require(_activeExposure <= _exposureLimit, "RiskModule: SCR limit exceeded");
    uint256 policyId = _policyPool.newPolicy(policy, customer, internalId);
    policy.id = policyId;
    return policy;
  }

  function releaseExposure(uint256 payout) external override onlyPolicyPool {
    // In the Python protype this function is called `remove_policy` and receives
    // all the policy. Since we just need the amount, for performance reasons
    // we just send the amount and the method is called releaseExposure
    _activeExposure -= payout;
  }

  function premiumsAccount() external view override returns (IPremiumsAccount) {
    return _premiumsAccount;
  }
}
