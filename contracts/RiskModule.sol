// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {SafeMath} from '@openzeppelin/contracts/utils/math/SafeMath.sol';
import {WadRayMath} from './WadRayMath.sol';
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {IPolicyPool} from '../interfaces/IPolicyPool.sol';
import {IRiskModule} from '../interfaces/IRiskModule.sol';
import {Policy} from './Policy.sol';

/**
 * @title Ensuro Risk Module base contract
 * @dev Risk Module that keeps the configuration and is responsible for pricing and policy resolution
 * @author Ensuro
 */

abstract contract RiskModule is IRiskModule, AccessControl, Pausable {
  using Policy for Policy.PolicyData;
  using SafeMath for uint256;
  using WadRayMath for uint256;

  // For parameters that can be changed by Ensuro
  bytes32 public constant ENSURO_DAO_ROLE = keccak256("ENSURO_DAO_ROLE");
  // For parameters that can be changed by the risk module provider
  bytes32 public constant RM_PROVIDER_ROLE = keccak256("RM_PROVIDER_ROLE");

  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

  string private _name;
  IPolicyPool internal _policyPool;
  uint256 internal _scrPercentage;   // in ray - Solvency Capital Requirement percentage, to calculate
                                     // capital requirement as % of (payout - premium)
  uint256 internal _premiumShare;    // in ray - % of premium that will go for the risk module provider
  uint256 internal _ensuroShare;     // in ray - % of premium that will go for Ensuro treasury
  uint256 internal _maxScrPerPolicy; // in wad - Max SCR per policy
  uint256 internal _scrLimit;        // in wad - Max SCR to be allocated to this module
  uint256 internal _totalScr;        // in wad - Current SCR allocated to this module

  address internal _wallet;          // Address of the RiskModule provider
  uint256 internal _sharedCoverageMinPercentage;
                                     // in ray - minimal % of SCR that must be covered by the RM
  uint256 internal _sharedCoveragePercentage;
                                     // in ray - current % of SCR that will be covered by the RM.
                                     // Always >= _sharedCoverageMinPercentage
  uint256 internal _sharedCoverageScr;
                                     // in wad - Current SCR covered by the Risk Module

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param policyPool_ The address of the Ensuro PolicyPool where this module is plugged
   * @param scrPercentage_ Solvency Capital Requirement percentage, to calculate
                          capital requirement as % of (payout - premium)  (in ray)
   * @param premiumShare_ % of premium that will go for the risk module provider (in ray)
   * @param ensuroShare_ % of premium that will go for Ensuro treasury (in ray)
   * @param maxScrPerPolicy_ Max SCR to be allocated to this module (in wad)
   * @param scrLimit_ Max SCR to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   * @param sharedCoverageMinPercentage_ minimal % of SCR that must be covered by the RM
   */
  constructor(
    string memory name_,
    IPolicyPool policyPool_,
    uint256 scrPercentage_,
    uint256 premiumShare_,
    uint256 ensuroShare_,
    uint256 maxScrPerPolicy_,
    uint256 scrLimit_,
    address wallet_,
    uint256 sharedCoverageMinPercentage_
  ) {
    _name = name_;
    _policyPool = policyPool_;
    _scrPercentage = scrPercentage_;
    _premiumShare = premiumShare_;
    _ensuroShare = ensuroShare_;
    _maxScrPerPolicy = maxScrPerPolicy_;
    _scrLimit = scrLimit_;
    _totalScr = 0;
    require(wallet_ != address(0), "Wallet can't be zero address");
    _wallet = wallet_;
    _sharedCoverageMinPercentage = sharedCoverageMinPercentage_;
    _sharedCoveragePercentage = sharedCoverageMinPercentage_;
    _sharedCoverageScr = 0;
    _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
  }

  function name() public view override returns (string memory) {
      return _name;
  }

  function scrPercentage() public view override returns (uint256) {
      return _scrPercentage;
  }

  function premiumShare() public view override returns (uint256) {
      return _premiumShare;
  }

  function ensuroShare() public view override returns (uint256) {
      return _ensuroShare;
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

  function sharedCoverageMinPercentage() public view override returns (uint256) {
      return _sharedCoverageMinPercentage;
  }

  function sharedCoveragePercentage() public view override returns (uint256) {
      return _sharedCoveragePercentage;
  }

  function sharedCoverageScr() public view override returns (uint256) {
      return _sharedCoverageScr;
  }

  function wallet() public view override returns (address) {
      return _wallet;
  }

  function setScrPercentage(uint256 newScrPercentage) external onlyRole(ENSURO_DAO_ROLE) {
    // TODO emit Event?
    _scrPercentage = newScrPercentage;
  }

  function setPremiumShare(uint256 newPremiumShare) external onlyRole(ENSURO_DAO_ROLE) {
    // TODO emit Event?
    _premiumShare = newPremiumShare;
  }

  function setEnsuroShare(uint256 newEnsuroShare) external onlyRole(ENSURO_DAO_ROLE) {
    // TODO emit Event?
    _ensuroShare = newEnsuroShare;
  }

  function setMaxScrPerPolicy(uint256 newMaxScrPerPolicy) external onlyRole(ENSURO_DAO_ROLE) {
    // TODO emit Event?
    _maxScrPerPolicy = newMaxScrPerPolicy;
  }

  function setScrLimit(uint256 newScrLimit) external onlyRole(ENSURO_DAO_ROLE) {
    // TODO emit Event?
    require(newScrLimit >= _totalScr, "Can't set SCR less than current SCR allocation");
    _scrLimit = newScrLimit;
  }

  function setSharedCoverageMinPercentage(uint256 newSCMP) external onlyRole(ENSURO_DAO_ROLE) {
    // TODO emit Event?
    _sharedCoverageMinPercentage = newSCMP;
    if (newSCMP < _sharedCoveragePercentage)
      _sharedCoveragePercentage = newSCMP;
  }

  function setSharedCoveragePercentage(uint256 newSCP) external onlyRole(RM_PROVIDER_ROLE) {
    // TODO emit Event?
    require(newSCP >= _sharedCoverageMinPercentage, "Can't set shared coverage perc. less than minimum");
    _sharedCoveragePercentage = newSCP;
  }

  function setWallet(address wallet_) external onlyRole(RM_PROVIDER_ROLE) {
    // TODO emit Event?
    require(wallet_ != address(0), "Wallet can't be zero address");
    _wallet = wallet_;
  }

  function _newPolicy(uint256 payout, uint256 premium, uint256 lossProb,
                      uint40 expiration, address customer) whenNotPaused internal returns (uint256) {
    require(premium < payout, "Premium must be less than payout");
    require(expiration > uint40(block.timestamp), "Expiration must be in the future");
    require(customer != address(0), "Customer can't be zero address");
    require(_policyPool.currency().allowance(customer, address(_policyPool)) >= premium,
            "You must allow ENSURO to transfer the premium");
    Policy.PolicyData memory policy = Policy.initialize(this, premium, payout, lossProb, expiration);
    require(policy.scr <= _maxScrPerPolicy, "RiskModule: SCR is more than maximum per policy");
    _totalScr = _totalScr.add(policy.scr);
    require(_totalScr <= _scrLimit, "RiskModule: SCR limit exceeded");
    _sharedCoverageScr = _sharedCoverageScr.add(policy.rmCoverage);
    uint256 policyId = _policyPool.newPolicy(policy, customer);
    return policyId;

  }
}
