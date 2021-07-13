// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from '../interfaces/IPolicyPool.sol';
import {RiskModule} from './RiskModule.sol';

/**
 * @title Trustful Risk Module
 * @dev Risk Module without any validation, just the newPolicy and resolvePolicy need to be called by
        authorized users
 * @author Ensuro
 */

contract TrustfulRiskModule is RiskModule {
  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

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
  ) RiskModule(name_, policyPool_, scrPercentage_, premiumShare_, ensuroShare_,
               maxScrPerPolicy_, scrLimit_, wallet_, sharedCoverageMinPercentage_) {
                 require(1!=3, "foo");
  }

  function newPolicy(
    uint256 payout, uint256 premium, uint256 lossProb, uint40 expiration, address customer
  )  onlyRole(PRICER_ROLE) external returns (uint256) {
    return _newPolicy(payout, premium, lossProb, expiration, customer);
  }

  function resolvePolicy(uint256 policyId, uint256 payout) onlyRole(RESOLVER_ROLE) external {
    return _policyPool.resolvePolicy(policyId, payout);
  }

  function resolvePolicy(uint256 policyId, bool customerWon) onlyRole(RESOLVER_ROLE) external {
    return _policyPool.resolvePolicy(policyId, customerWon);
  }

}
