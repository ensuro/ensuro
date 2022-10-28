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

  /**
   * @dev Creates a new Policy
   *
   * Requirements:
   * - The caller has been granted componentRole(PRICER_ROLE)
   *
   * Emits:
   * - {PolicyPool.NewPolicy}
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the policyHolder
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param internalId An id that's unique within this module and it will be used to identify the policy
   * @return Returns the id of the created policy
   */
  function newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address onBehalfOf,
    uint96 internalId
  ) external onlyComponentRole(PRICER_ROLE) returns (uint256) {
    address payer = onBehalfOf;
    if (payer != _msgSender() && _policyPool.currency().allowance(payer, _msgSender()) < premium)
      /**
       * The standard is the payer should be the _msgSender() but usually, in this type of module,
       * the sender is an operative account managed by software, where the onBehalfOf is a more
       * secure account (hardware wallet) that does the cash movements.
       * This non standard behaviour allows for a more secure setup, where the sender never manages
       * cash.
       * We leverage the currency's allowance mechanism to allow the sender access to the payer's
       * funds.
       * Note that this allowance won't be spent, so it can be set as the maximum amount of a single
       * premium even for multiple policies.
       */
      payer = _msgSender();

    return _newPolicy(payout, premium, lossProb, expiration, payer, onBehalfOf, internalId).id;
  }

  /**
   * @dev Resolves a policy, if payout > 0, it pays to the policy holder.
   *
   * Requirements:
   * - The caller has been granted componentRole(RESOLVER_ROLE)
   * - payout <= policy.payout
   * - block.timestamp >= policy.expiration
   *
   * Emits:
   * - {PolicyPool.PolicyResolved}
   *
   * @param policy The policy previously created (from {NewPolicy} event)
   * @param payout The payout to transfer to the policy holder
   */
  function resolvePolicy(Policy.PolicyData calldata policy, uint256 payout)
    external
    onlyComponentRole(RESOLVER_ROLE)
    whenNotPaused
  {
    _policyPool.resolvePolicy(policy, payout);
  }

  /**
   * @dev Resolves a policy with full payout (policy.payout) if customerWon == true
   *
   * Requirements:
   * - The caller has been granted componentRole(RESOLVER_ROLE)
   * - block.timestamp >= policy.expiration
   *
   * Emits:
   * - {PolicyPool.PolicyResolved}
   *
   * @param policy The policy previously created (from {NewPolicy} event)
   * @param customerWon If true, policy.payout is transferred to the policy holder. If false, the policy is resolved
   * without payout and can't be longer claimed.
   */
  function resolvePolicyFullPayout(Policy.PolicyData calldata policy, bool customerWon)
    external
    onlyComponentRole(RESOLVER_ROLE)
    whenNotPaused
  {
    _policyPool.resolvePolicyFullPayout(policy, customerWon);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
