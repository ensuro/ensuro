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

  uint256 internal constant SECONDS_IN_YEAR_WAD = 31536000e18; /* 365 * 24 * 3600 * 10e18 */

  // For parameters that can be changed by the risk module provider
  bytes32 public constant RM_PROVIDER_ROLE = keccak256("RM_PROVIDER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IPremiumsAccount internal immutable _premiumsAccount;

  string private _name;
  uint256 internal _params;

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
   * @param collRatio_ Collateralization ratio to compute solvency requirement as % of payout (in wad)
   * @param ensuroPpFee_ % of pure premium that will go for Ensuro treasury (in wad)
   * @param srRoc_ return on capital paid to LPs (annualized percentage - in wad)
   * @param maxPayoutPerPolicy_ Maximum payout per policy (in wad)
   * @param exposureLimit_ Max exposure (sum of payouts) to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   */
  // solhint-disable-next-line func-name-mixedcase
  function __RiskModule_init(
    string memory name_,
    uint256 collRatio_,
    uint256 ensuroPpFee_,
    uint256 srRoc_,
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
      srRoc_,
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
    uint256 srRoc_,
    uint256 maxPayoutPerPolicy_,
    uint256 exposureLimit_,
    address wallet_
  ) internal initializer {
    _name = name_;
    _setParam(Parameter.moc, WadRayMath.WAD);
    // _setParam(Parameter.jrCollRatio, 0);
    _setParam(Parameter.collRatio, collRatio_);
    _setParam(Parameter.ensuroPpFee, ensuroPpFee_);
    // _setParam(Parameter.ensuroCocFee, ensuroCocFee_);
    // _setParam(Parameter.jrRoc, jrRoc_);
    _setParam(Parameter.srRoc, srRoc_);

    _maxPayoutPerPolicy = maxPayoutPerPolicy_;
    _exposureLimit = exposureLimit_;
    _activeExposure = 0;
    _wallet = wallet_;
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
    _validateParameters();
  }

  // runs validation on RiskModule parameters
  function _validateParameters() internal view override {
    Params memory p = params();

    require(p.jrCollRatio <= WadRayMath.WAD, "Validation: jrCollRatio must be <=1");
    require(p.collRatio <= WadRayMath.WAD && p.collRatio > 0, "Validation: collRatio must be <=1");
    require(p.collRatio >= p.jrCollRatio, "Validation: collRatio >= jrCollRatio");
    require(
      p.moc <= (2 * WadRayMath.WAD) && p.moc >= (WadRayMath.WAD / 2),
      "Validation: moc must be [0.5, 2]"
    );
    require(p.ensuroPpFee <= WadRayMath.WAD, "Validation: ensuroPpFee must be <= 1");
    require(p.ensuroCocFee <= WadRayMath.WAD, "Validation: ensuroCocFee must be <= 1");
    require(p.srRoc <= WadRayMath.WAD, "Validation: srRoc must be <= 1 (100%)");
    require(p.jrRoc <= WadRayMath.WAD, "Validation: jrRoc must be <= 1 (100%)");
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

  function _getParam(Parameter param) internal view returns (uint256) {
    uint256 startBitPosition = 32 * uint256(param);
    uint256 mask = type(uint256).max ^ (0xFFFFFFFF << startBitPosition);
    return ((_params & ~mask) >> startBitPosition) * 10**9; // 9+9 digits -> 18 digits (wad)
  }

  function _setParam(Parameter param, uint256 newValue) internal {
    uint256 startBitPosition = 32 * uint256(param);
    uint256 mask = type(uint256).max ^ (0xFFFFFFFF << startBitPosition);
    require(newValue / 10**9 < 10**32, "Parameter overflow"); // TODO: keep?
    _params = (_params & mask) | (~mask & ((newValue / 10**9) << startBitPosition));
  }

  function setParam(Parameter param, uint256 newValue)
    external
    onlyPoolRole2(LEVEL2_ROLE, LEVEL3_ROLE)
  {
    bool tweak = !hasPoolRole(LEVEL2_ROLE);
    require(
      !tweak || _isTweakRay(_getParam(param), newValue, 1e26),
      "Tweak exceeded: tweaks only up to 10%"
    );
    _setParam(param, newValue);
    _parameterChanged(
      IPolicyPoolConfig.GovernanceActions(
        uint256(IPolicyPoolConfig.GovernanceActions.setMoc) + uint256(param)
      ),
      newValue,
      tweak
    );
  }

  function params() public view override returns (Params memory ret) {
    ret.moc = _getParam(Parameter.moc);
    ret.jrCollRatio = _getParam(Parameter.jrCollRatio);
    ret.collRatio = _getParam(Parameter.collRatio);
    ret.ensuroPpFee = _getParam(Parameter.ensuroPpFee);
    ret.ensuroCocFee = _getParam(Parameter.ensuroCocFee);
    ret.jrRoc = _getParam(Parameter.jrRoc);
    ret.srRoc = _getParam(Parameter.srRoc);
    return ret;
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
    Params memory p = params();
    uint256 purePremium = payout.wadMul(lossProb.wadMul(p.moc));
    uint256 jrScr = payout.wadMul(p.jrCollRatio);
    if (jrScr > purePremium) {
      jrScr -= purePremium;
    } else {
      jrScr = 0;
    }
    uint256 srScr = payout.wadMul(p.collRatio);
    if (srScr > (purePremium + jrScr)) {
      srScr -= purePremium + jrScr;
    } else {
      srScr = 0;
    }
    uint256 jrCoc = jrScr.wadMul(
      (p.jrRoc * (expiration - block.timestamp)).wadDiv(SECONDS_IN_YEAR_WAD)
    );
    uint256 srCoc = srScr.wadMul(
      (p.srRoc * (expiration - block.timestamp)).wadDiv(SECONDS_IN_YEAR_WAD)
    );
    uint256 ensuroCommission = purePremium.wadMul(p.ensuroPpFee) +
      (jrCoc + srCoc).wadMul(p.ensuroCocFee);
    return purePremium + ensuroCommission + (jrCoc + srCoc);
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
