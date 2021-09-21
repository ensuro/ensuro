// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {RiskModule} from "./RiskModule.sol";

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
   * @param ensuroFee_ % of premium that will go for Ensuro treasury (in ray)
   * @param scrInterestRate_ cost of capital (in ray)
   * @param maxScrPerPolicy_ Max SCR to be allocated to this module (in wad)
   * @param scrLimit_ Max SCR to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   * @param sharedCoverageMinPercentage_ minimal % of SCR that must be covered by the RM
   */
  function initialize(
    string memory name_,
    IPolicyPool policyPool_,
    uint256 scrPercentage_,
    uint256 ensuroFee_,
    uint256 scrInterestRate_,
    uint256 maxScrPerPolicy_,
    uint256 scrLimit_,
    address wallet_,
    uint256 sharedCoverageMinPercentage_
  ) public initializer {
    __RiskModule_init(
      name_,
      policyPool_,
      scrPercentage_,
      ensuroFee_,
      scrInterestRate_,
      maxScrPerPolicy_,
      scrLimit_,
      wallet_,
      sharedCoverageMinPercentage_
    );
  }

  function newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address customer
  ) external onlyRole(PRICER_ROLE) returns (uint256) {
    return _newPolicy(payout, premium, lossProb, expiration, customer);
  }

  function resolvePolicy(uint256 policyId, uint256 payout)
    external
    onlyRole(RESOLVER_ROLE)
    whenNotPaused
  {
    return _policyPool.resolvePolicy(policyId, payout);
  }

  function resolvePolicyFullPayout(uint256 policyId, bool customerWon)
    external
    onlyRole(RESOLVER_ROLE)
    whenNotPaused
  {
    return _policyPool.resolvePolicyFullPayout(policyId, customerWon);
  }
}
