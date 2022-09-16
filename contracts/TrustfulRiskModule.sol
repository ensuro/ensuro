// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {RiskModule} from "./RiskModule.sol";
import {Policy} from "./Policy.sol";

/**
 * @title Trustful Risk Module
 * @dev Risk Module without any validation, just the newPolicy and resolvePolicy need to be called by
        authorized users
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */

contract TrustfulRiskModule is RiskModule {
  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow constructor
  // solhint-disable-next-line no-empty-blocks
  constructor(IPolicyPool policyPool_, IPremiumsAccount premiumsAccount_)
    RiskModule(policyPool_, premiumsAccount_)
  {} // solhint-disable-line no-empty-blocks

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
    __RiskModule_init(
      name_,
      collRatio_,
      ensuroPpFee_,
      srRoc_,
      maxPayoutPerPolicy_,
      exposureLimit_,
      wallet_
    );
  }

  function newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address onBehalfOf,
    uint96 internalId
  ) external onlyComponentRole(PRICER_ROLE) returns (uint256) {
    address payer = onBehalfOf;
    if (payer != msg.sender && _policyPool.currency().allowance(payer, msg.sender) < premium)
      payer = msg.sender;

    return _newPolicy(payout, premium, lossProb, expiration, payer, onBehalfOf, internalId).id;
  }

  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout)
    external
    onlyComponentRole(RESOLVER_ROLE)
    whenNotPaused
  {
    _policyPool.resolvePolicy(policy, payout);
  }

  function resolvePolicyFullPayout(Policy.PolicyData calldata policy, bool customerWon)
    external
    onlyComponentRole(RESOLVER_ROLE)
    whenNotPaused
  {
    _policyPool.resolvePolicyFullPayout(policy, customerWon);
  }
}
