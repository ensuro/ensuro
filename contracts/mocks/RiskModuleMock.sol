// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPolicyPool} from "../interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "../interfaces/IPremiumsAccount.sol";
import {RiskModule} from "../RiskModule.sol";
import {Policy} from "../Policy.sol";

/**
 * @title Trustful Risk Module
 * @dev Risk Module without any validation, just the newPolicy and resolvePolicy need to be called by
        authorized users
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */

contract RiskModuleMock is RiskModule {
  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_, IPremiumsAccount premiumsAccount_) RiskModule(policyPool_, premiumsAccount_) {}

  /**
   * @dev Initializes the RiskModule
   * @param name_ Name of the Risk Module
   * @param collRatio_ Collateralization ratio to compute solvency requirement as % of payout (in ray)
   * @param ensuroPpFee_ % of pure premium that will go for Ensuro treasury (in ray)
   * @param srRoc_ return on capital paid to Senior LPs (annualized percentage - in ray)
   * @param maxPayoutPerPolicy_ Maximum payout per policy (in wad)
   * @param exposureLimit_ Max exposure (sum of payouts) to be allocated to this module (in wad)
   * @param wallet_ Address of the RiskModule provider
   */
  function initialize(
    string memory name_,
    uint256 collRatio_,
    uint256 ensuroPpFee_,
    uint256 srRoc_,
    uint256 maxPayoutPerPolicy_,
    uint256 exposureLimit_,
    address wallet_
  ) public initializer {
    __RiskModule_init(name_, collRatio_, ensuroPpFee_, srRoc_, maxPayoutPerPolicy_, exposureLimit_, wallet_);
  }

  function newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address payer,
    address onBehalfOf,
    uint96 internalId
  ) external returns (uint256) {
    return
      _newPolicy(
        payout,
        premium,
        lossProb,
        expiration,
        payer == address(0) ? msg.sender : payer,
        onBehalfOf,
        internalId
      ).id;
  }

  function newPolicyRaw(
    Policy.PolicyData memory policy,
    address payer,
    address policyHolder,
    uint96 internalId
  ) external returns (uint256) {
    return _policyPool.newPolicy(policy, payer, policyHolder, internalId);
  }

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout) external {
    _policyPool.resolvePolicy(policy, payout);
  }

  function resolvePolicyRaw(Policy.PolicyData calldata policy, uint256 payout) external {
    return _policyPool.resolvePolicy(policy, payout);
  }

  function replacePolicy(
    Policy.PolicyData calldata oldPolicy,
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    uint96 internalId
  ) external returns (uint256) {
    return _replacePolicy(oldPolicy, payout, premium, lossProb, expiration, msg.sender, internalId, params()).id;
  }

  function replacePolicyRaw(
    Policy.PolicyData memory oldPolicy,
    Policy.PolicyData memory newPolicy_,
    address payer,
    uint96 internalId
  ) external returns (uint256) {
    return _policyPool.replacePolicy(oldPolicy, newPolicy_, payer, internalId);
  }
}
