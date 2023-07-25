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
        trusted account (PRICER_ROLE). One of the components of the price it's a bucket id that groups policies within
        a risk module, with different parameters (such as collaterallization levels or fees).
        For the resolution (resolvePolicy), it has to be called by an authorized user
  * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SignedBucketRiskModule is RiskModule {
  bytes32 public constant POLICY_CREATOR_ROLE = keccak256("POLICY_CREATOR_ROLE");
  bytes32 public constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  bool internal immutable _creationIsOpen;

  mapping(uint256 => PackedParams) internal _buckets;

  /**
   * @dev Emitted when a new risk bucket is created (or modified).
   * @param bucketId The identifier of the group of policies.
   * @param params The packed parameters of the new bucket.
   */
  event NewBucket(uint256 indexed bucketId, Params params);

  /**
   * @dev Emitted when a risk bucket is deleted.
   * @param bucketId The identifier of the group of policies.
   */
  event BucketDeleted(uint256 indexed bucketId);

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

  function _checkSignature(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    bytes32 policyData,
    uint256 bucketId,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) internal view {
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
        bucketId,
        quoteValidUntil
      )
    );
    address signer = ECDSA.recover(quoteHash, quoteSignatureR, quoteSignatureVS);
    _policyPool.access().checkComponentRole(address(this), PRICER_ROLE, signer, false);
  }

  function _newPolicySigned(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    bytes32 policyData,
    uint256 bucketId,
    address payer,
    address onBehalfOf
  ) internal returns (Policy.PolicyData memory createdPolicy) {
    uint96 internalId = uint96(uint256(policyData) % 2**96);
    createdPolicy = _newPolicyWithParams(
      payout,
      premium,
      lossProb,
      expiration,
      payer,
      onBehalfOf,
      internalId,
      bucketParams(bucketId)
    );
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
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the payer
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param bucketId Identifies the group to which the policy belongs (that defines the RM parameters applicable to it)
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
    uint256 bucketId,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external whenNotPaused returns (Policy.PolicyData memory createdPolicy) {
    _checkSignature(
      payout,
      premium,
      lossProb,
      expiration,
      policyData,
      bucketId,
      quoteSignatureR,
      quoteSignatureVS,
      quoteValidUntil
    );
    return
      _newPolicySigned(
        payout,
        premium,
        lossProb,
        expiration,
        policyData,
        bucketId,
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
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the payer
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param bucketId Identifies the group to which the policy belongs (that defines the RM parameters applicable to it)
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
    uint256 bucketId,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external whenNotPaused returns (uint256) {
    _checkSignature(
      payout,
      premium,
      lossProb,
      expiration,
      policyData,
      bucketId,
      quoteSignatureR,
      quoteSignatureVS,
      quoteValidUntil
    );
    return
      _newPolicySigned(
        payout,
        premium,
        lossProb,
        expiration,
        policyData,
        bucketId,
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
   *
   * @param payout The exposure (maximum payout) of the policy
   * @param premium The premium that will be paid by the payer
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param onBehalfOf The policy holder
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param bucketId Identifies the group to which the policy belongs (that defines the RM parameters applicable to it)
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
    uint256 bucketId,
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
    _checkSignature(
      payout,
      premium,
      lossProb,
      expiration,
      policyData,
      bucketId,
      quoteSignatureR,
      quoteSignatureVS,
      quoteValidUntil
    );
    return
      _newPolicySigned(
        payout,
        premium,
        lossProb,
        expiration,
        policyData,
        bucketId,
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

  /**
   * @dev Sets the parameters for a risk bucket.
   *
   * Requirements:
   *
   * - The caller must have the LEVEL1_ROLE or LEVEL2_ROLE
   *
   * @param bucketId Group identifier for the policies that will have these parameters
   * @param params_ The parameters of the new bucket.
   */
  function setBucketParams(uint256 bucketId, Params calldata params_)
    external
    onlyGlobalOrComponentRole2(LEVEL1_ROLE, LEVEL2_ROLE)
  {
    require(
      bucketId != 0,
      "SignedBucketRiskModule: bucketId can't be zero, set default RM parameters"
    );
    _buckets[bucketId] = PackedParams({
      moc: _wadTo4(params_.moc),
      jrCollRatio: _wadTo4(params_.jrCollRatio),
      collRatio: _wadTo4(params_.collRatio),
      ensuroPpFee: _wadTo4(params_.ensuroPpFee),
      ensuroCocFee: _wadTo4(params_.ensuroCocFee),
      jrRoc: _wadTo4(params_.jrRoc),
      srRoc: _wadTo4(params_.srRoc),
      maxPayoutPerPolicy: type(uint32).max, // unused, but needs to be > 0
      exposureLimit: type(uint32).max, //unused, but needs to be > 0
      maxDuration: type(uint16).max //unused
    });
    _validatePackedParams(_buckets[bucketId]);
    emit NewBucket(bucketId, params_);
  }

  /**
   * @dev Deletes a bucket
   *
   * Requirements:
   *
   * - The caller must have the LEVEL1_ROLE or LEVEL2_ROLE
   *
   * @param bucketId Group identifier for the policies that will have these parameters
   */
  function deleteBucket(uint256 bucketId)
    external
    onlyGlobalOrComponentRole2(LEVEL1_ROLE, LEVEL2_ROLE)
  {
    require(
      bucketId != 0,
      "SignedBucketRiskModule: bucketId can't be zero, set default RM parameters"
    );
    delete _buckets[bucketId];
    emit BucketDeleted(bucketId);
  }

  /**
   * @dev returns the risk bucket parameters for the given bucketId
   *
   * @param bucketId Id of the bucket of 0 if you want the default params
   */
  function bucketParams(uint256 bucketId) public view returns (Params memory params_) {
    if (bucketId != 0) {
      PackedParams storage bucketParams_ = _buckets[bucketId];
      require(bucketParams_.moc != 0, "SignedBucketRiskModule: bucket not found!");
      params_ = _unpackParams(bucketParams_);
    } else {
      params_ = params();
    }
  }

  /**
   * @dev Returns the minimum premium for a given bucket
   *
   * @param payout Maximum payout of the policy
   * @param lossProb Probability of having a loss equal to the maximum payout
   * @param expiration Expiration date of the policy
   * @param bucketId Id of the bucket of 0 if you want the default params
   */
  function getMinimumPremiumForBucket(
    uint256 payout,
    uint256 lossProb,
    uint40 expiration,
    uint256 bucketId
  ) public view virtual returns (uint256) {
    return _getMinimumPremium(payout, lossProb, expiration, bucketParams(bucketId));
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[49] private __gap;
}
