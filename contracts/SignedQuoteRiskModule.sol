// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {RiskModule} from "./RiskModule.sol";
import {Policy} from "./Policy.sol";

/**
 * @title SignedQuote Risk Module
 * @dev Risk Module that for policy creation verifies the different components of the price have been signed by a
        trusted account (PRICER_ROLE). For the resolution (resolvePolicy), it has to be called by an authorized user
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SignedQuoteRiskModule is RiskModule {
  bytes32 public constant POLICY_CREATOR_ROLE = keccak256("POLICY_CREATOR_ROLE");
  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  bool internal immutable _creationIsOpen;

  /**
   * @dev Event emitted every time a new policy is created. It allows to link the policyData with a particular policy
   *
   * @param policyId The id of the policy
   * @param policyData The value sent in `policyData` parameter that's the hash of the off-chain stored data.
   */
  event NewSignedPolicy(uint256 indexed policyId, bytes32 policyData);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    IPremiumsAccount premiumsAccount_,
    bool creationIsOpen_
  ) RiskModule(policyPool_, premiumsAccount_) {
    _creationIsOpen = creationIsOpen_;
  }

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

  function _newPolicySigned(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    bytes32 policyData,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil,
    address payer,
    address onBehalfOf
  ) internal returns (Policy.PolicyData memory createdPolicy) {
    if (!_creationIsOpen)
      _policyPool.access().checkComponentRole(
        address(this),
        POLICY_CREATOR_ROLE,
        _msgSender(),
        false
      );
    require(quoteValidUntil >= block.timestamp, "Quote expired");

    /**
     * Checks the quote has been signed by an authorized user
     * The "quote" is computed as hash of the following fields (encodePacked):
     * - address(this): the address of this RiskModule
     * - payout, premium, lossProb, expiration: the base parameters of the policy
     * - policyData: a hash of the private details of the policy. The calculation should include some
     *   unique id (quoteId), so each policyData identifies a policy.
     * - quoteValidUntil: the maximum validity of the quote
     */
    bytes32 quoteHash = ECDSA.toEthSignedMessageHash(
      abi.encodePacked(
        address(this),
        payout,
        premium,
        lossProb,
        expiration,
        policyData,
        quoteValidUntil
      )
    );
    address signer = ECDSA.recover(quoteHash, quoteSignatureR, quoteSignatureVS);
    _policyPool.access().checkComponentRole(address(this), PRICER_ROLE, signer, false);
    uint96 internalId = uint96(uint256(policyData) % 2**96);

    createdPolicy = _newPolicy(
      payout,
      premium,
      lossProb,
      expiration,
      payer,
      onBehalfOf,
      internalId
    );
    emit NewSignedPolicy(createdPolicy.id, policyData);
    return createdPolicy;
  }

  /**
   * @dev Creates a new Policy using a signed quote. The caller is the payer of the policy. Returns all the struct, not just the id.
   *
   * Requirements:
   * - The caller approved the spending of the premium to the PolicyPool
   * - The quote has been signed by an address with the component role PRICER_ROLE
   *
   *  Emits:
   * - {PolicyPool.NewPolicy}
   *  - {NewSignedPolicy}
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the payer
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param quoteSignatureR The signature of the quote. R component (EIP-2098 signature)
   * @param quoteSignatureVS The signature of the quote. VS component (EIP-2098 signature)
   * @param quoteValidUntil The expiration of the quote
   * @return createdPolicy Returns the created policy
   */
  function newPolicyFull(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address onBehalfOf,
    bytes32 policyData,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external whenNotPaused returns (Policy.PolicyData memory createdPolicy) {
    return
      _newPolicySigned(
        payout,
        premium,
        lossProb,
        expiration,
        policyData,
        quoteSignatureR,
        quoteSignatureVS,
        quoteValidUntil,
        _msgSender(),
        onBehalfOf
      );
  }

  /**
   * @dev Creates a new Policy using a signed quote. The caller is the payer of the policy.
   *
   * Requirements:
   * - The caller approved the spending of the premium to the PolicyPool
   * - The quote has been signed by an address with the component role PRICER_ROLE
   *
   * Emits:
   * - {PolicyPool.NewPolicy}
   * - {NewSignedPolicy}
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the payer
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param quoteSignatureR The signature of the quote. R component (EIP-2098 signature)
   * @param quoteSignatureVS The signature of the quote. VS component (EIP-2098 signature)
   * @param quoteValidUntil The expiration of the quote
   * @return Returns the id of the created policy
   */
  function newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address onBehalfOf,
    bytes32 policyData,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external whenNotPaused returns (uint256) {
    return
      _newPolicySigned(
        payout,
        premium,
        lossProb,
        expiration,
        policyData,
        quoteSignatureR,
        quoteSignatureVS,
        quoteValidUntil,
        _msgSender(),
        onBehalfOf
      ).id;
  }

  /**
   * @dev Creates a new Policy using a signed quote. The payer is the policy holder
   *
   * Requirements:
   * - currency().allowance(onBehalfOf, _msgSender()) > 0
   * - The quote has been signed by an address with the component role PRICER_ROLE
   *
   * Emits:
   * - {PolicyPool.NewPolicy}
   * - {NewSignedPolicy}
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the payer
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param quoteSignatureR The signature of the quote. R component (EIP-2098 signature)
   * @param quoteSignatureVS The signature of the quote. VS component (EIP-2098 signature)
   * @param quoteValidUntil The expiration of the quote
   * @return Returns the id of the created policy
   */
  function newPolicyPaidByHolder(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address onBehalfOf,
    bytes32 policyData,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external whenNotPaused returns (uint256) {
    require(
      onBehalfOf == _msgSender() || currency().allowance(onBehalfOf, _msgSender()) > 0,
      "Sender is not authorized to create policies onBehalfOf"
    );
    /**
     * The standard is the payer should be the _msgSender() but usually, in this type of module,
     * the sender is an operative account managed by software, where the onBehalfOf is a more
     * secure account (hardware wallet) that does the cash movements.
     * This non standard behaviour allows for a more secure setup, where the sender never manages
     * cash.
     * We leverage the currency's allowance mechanism to allow the sender access to the payer's
     * funds.
     * Note that this allowance won't be spent, so anything above 0 is accepted.
     */
    return
      _newPolicySigned(
        payout,
        premium,
        lossProb,
        expiration,
        policyData,
        quoteSignatureR,
        quoteSignatureVS,
        quoteValidUntil,
        onBehalfOf,
        onBehalfOf
      ).id;
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

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[50] private __gap;
}
