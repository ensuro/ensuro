// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {WadRayMath} from "./WadRayMath.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {PolicyPoolComponent} from "./PolicyPoolComponent.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";
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

  string private _name;
  uint256 internal _scrPercentage; // in ray - Solvency Capital Requirement percentage, to calculate
  // capital requirement as % of (payout - premium)
  uint256 internal _moc; // in ray - Margin Of Conservativism - factor that multiplies lossProb
  // to calculate purePremium
  uint256 internal _ensuroFee; // in ray - % of pure premium that will go for Ensuro treasury
  uint256 internal _scrInterestRate; // in ray - % of interest to charge for the SCR
  uint256 internal _maxScrPerPolicy; // in wad - Max SCR per policy
  uint256 internal _scrLimit; // in wad - Max SCR to be allocated to this module
  uint256 internal _totalScr; // in wad - Current SCR allocated to this module

  address internal _wallet; // Address of the RiskModule provider

  modifier validateParamsAfterChange() {
    _;
    _validateParameters();
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_) PolicyPoolComponent(policyPool_) {}

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param scrPercentage_ Solvency Capital Requirement percentage, to calculate
                          capital requirement as % of (payout - premium)  (in ray)
   * @param ensuroFee_ % of pure premium that will go for Ensuro treasury (in ray)
   * @param scrInterestRate_ % of interest to charge for the SCR (in ray)
   * @param maxScrPerPolicy_ Max SCR to be allocated to this module (in wad)
   * @param scrLimit_ Max SCR to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   */
  // solhint-disable-next-line func-name-mixedcase
  function __RiskModule_init(
    string memory name_,
    uint256 scrPercentage_,
    uint256 ensuroFee_,
    uint256 scrInterestRate_,
    uint256 maxScrPerPolicy_,
    uint256 scrLimit_,
    address wallet_
  ) internal initializer {
    __AccessControl_init();
    __PolicyPoolComponent_init();
    __RiskModule_init_unchained(
      name_,
      scrPercentage_,
      ensuroFee_,
      scrInterestRate_,
      maxScrPerPolicy_,
      scrLimit_,
      wallet_
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function __RiskModule_init_unchained(
    string memory name_,
    uint256 scrPercentage_,
    uint256 ensuroFee_,
    uint256 scrInterestRate_,
    uint256 maxScrPerPolicy_,
    uint256 scrLimit_,
    address wallet_
  ) internal initializer {
    _name = name_;
    _scrPercentage = scrPercentage_;
    _moc = WadRayMath.RAY;
    _ensuroFee = ensuroFee_;
    _scrInterestRate = scrInterestRate_;
    _maxScrPerPolicy = maxScrPerPolicy_;
    _scrLimit = scrLimit_;
    _totalScr = 0;
    _wallet = wallet_;
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    _validateParameters();
  }

  // runs validation on RiskModule parameters
  function _validateParameters() internal view {
    require(
      _scrPercentage <= WadRayMath.RAY && _scrPercentage > 0,
      "Validation: scrPercentage must be <=1"
    );
    require(
      _moc <= (2 * WadRayMath.RAY) && _moc >= (WadRayMath.RAY / 2),
      "Validation: moc must be [0.5, 2]"
    );
    require(_ensuroFee <= WadRayMath.RAY, "Validation: ensuroFee must be <= 1");
    require(_scrInterestRate <= WadRayMath.RAY, "Validation: scrInterestRate must be <= 1 (100%)");
    // _maxScrPerPolicy no limits
    require(_scrLimit >= _totalScr, "Validation: scrLimit can't be less than actual totalScr");
    require(_wallet != address(0), "Validation: Wallet can't be zero address");
  }

  function name() public view override returns (string memory) {
    return _name;
  }

  function scrPercentage() public view override returns (uint256) {
    return _scrPercentage;
  }

  function moc() public view override returns (uint256) {
    return _moc;
  }

  function ensuroFee() public view override returns (uint256) {
    return _ensuroFee;
  }

  function scrInterestRate() public view override returns (uint256) {
    return _scrInterestRate;
  }

  function maxScrPerPolicy() public view override returns (uint256) {
    return _maxScrPerPolicy;
  }

  function scrLimit() public view override returns (uint256) {
    return _scrLimit;
  }

  function totalScr() public view override returns (uint256) {
    return _totalScr;
  }

  function wallet() public view override returns (address) {
    return _wallet;
  }

  function setScrPercentage(uint256 newScrPercentage)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_scrPercentage, newScrPercentage, 1e26),
      "Tweak exceeded: scrPercentage tweaks only up to 10%"
    );
    _scrPercentage = newScrPercentage;
    _parameterChanged(
      IPolicyPoolConfig.GovernanceActions.setScrPercentage,
      newScrPercentage,
      tweak
    );
  }

  function setMoc(uint256 newMoc)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(!tweak || _isTweakRay(_moc, newMoc, 1e26), "Tweak exceeded: moc tweaks only up to 10%");
    _moc = newMoc;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setMoc, newMoc, tweak);
  }

  function setScrInterestRate(uint256 newScrInterestRate)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_scrInterestRate, newScrInterestRate, 3e26),
      "Tweak exceeded: scrInterestRate tweaks only up to 30%"
    );
    _scrInterestRate = newScrInterestRate;
    _parameterChanged(
      IPolicyPoolConfig.GovernanceActions.setScrInterestRate,
      newScrInterestRate,
      tweak
    );
  }

  function setEnsuroFee(uint256 newEnsuroFee)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_ensuroFee, newEnsuroFee, 3e26),
      "Tweak exceeded: ensuroFee tweaks only up to 30%"
    );
    _ensuroFee = newEnsuroFee;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setEnsuroFee, newEnsuroFee, tweak);
  }

  function setMaxScrPerPolicy(uint256 newMaxScrPerPolicy)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakWad(_maxScrPerPolicy, newMaxScrPerPolicy, 3e17),
      "Tweak exceeded: maxScrPerPolicy tweaks only up to 30%"
    );
    _maxScrPerPolicy = newMaxScrPerPolicy;
    _parameterChanged(
      IPolicyPoolConfig.GovernanceActions.setMaxScrPerPolicy,
      newMaxScrPerPolicy,
      tweak
    );
  }

  function setScrLimit(uint256 newScrLimit)
    external
    onlyPoolRole3(LEVEL1_ROLE, LEVEL2_ROLE, LEVEL3_ROLE)
    validateParamsAfterChange
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE) && !hasPoolRole(LEVEL1_ROLE);
    require(
      !tweak || _isTweakWad(_scrLimit, newScrLimit, 1e17),
      "Tweak exceeded: scrLimit tweaks only up to 10%"
    );
    require(
      newScrLimit <= _scrLimit ||
        hasPoolRole(LEVEL1_ROLE) ||
        _policyPool.totalETokenSupply().wadMul(1e17) > newScrLimit,
      "Tweak exceeded: Increase, >=10% of the total liquidity, requires LEVEL1_ROLE"
    );
    require(newScrLimit >= _totalScr, "Can't set SCR less than current SCR allocation");
    _scrLimit = newScrLimit;
    _parameterChanged(IPolicyPoolConfig.GovernanceActions.setScrLimit, newScrLimit, tweak);
  }

  function setWallet(address wallet_)
    external
    onlyRole(RM_PROVIDER_ROLE)
    validateParamsAfterChange
  {
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
  ) external view returns (uint256) {
    uint256 purePremium = payout.wadToRay().rayMul(lossProb.rayMul(moc())).rayToWad();
    uint256 premiumForEnsuro = purePremium.wadMul(ensuroFee().rayToWad());
    uint256 scr = payout.wadMul(scrPercentage().rayToWad()) - purePremium - premiumForEnsuro;
    // actually the scr will be a bit less, because the premiumForEnsuro (CoC) is also substracted
    uint256 interestRate = (
      (scrInterestRate() * (expiration - block.timestamp)).rayDiv(SECONDS_IN_YEAR_RAY)
    ).rayToWad();
    scr -= scr.wadMul(interestRate);
    // Recalculate premiumForLps
    uint256 premiumForLps = scr.wadMul(interestRate);
    // Still inaccurate because the formula is recursive, but good enough. Multiply be 1.0005 to increase a bit
    // and avoid premium less than minimum
    return (purePremium + premiumForEnsuro + premiumForLps).wadMul(1.0005e18);
  }

  function _newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address customer
  ) internal whenNotPaused returns (Policy.PolicyData memory) {
    require(premium < payout, "Premium must be less than payout");
    require(expiration > uint40(block.timestamp), "Expiration must be in the future");
    require(customer != address(0), "Customer can't be zero address");
    require(
      _policyPool.currency().allowance(customer, address(_policyPool)) >= premium,
      "You must allow ENSURO to transfer the premium"
    );
    Policy.PolicyData memory policy = Policy.initialize(
      this,
      premium,
      payout,
      lossProb,
      expiration
    );
    require(policy.scr <= _maxScrPerPolicy, "RiskModule: SCR is more than maximum per policy");
    _totalScr += policy.scr;
    require(_totalScr <= _scrLimit, "RiskModule: SCR limit exceeded");
    uint256 policyId = _policyPool.newPolicy(policy, customer);
    policy.id = policyId;
    return policy;
  }
}
