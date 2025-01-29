// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {Policy} from "./Policy.sol";
import {RiskModule} from "./RiskModule.sol";

/**
 * @title SignedBucket Risk Module
 * @dev Risk Module that for policy creation verifies the different components of the price have been signed by a
        trusted account (PRICER_ROLE). One of the components of the price is a bucket id that groups policies within
        a risk module, with different parameters (such as collaterallization levels or fees).
        For the resolution (resolvePolicy), it has to be called by an authorized user
  * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract SignedBucketRiskModule is RiskModule {
  bytes32 internal constant POLICY_CREATOR_ROLE = keccak256("POLICY_CREATOR_ROLE");
  bytes32 internal constant REPLACER_ROLE = keccak256("REPLACER_ROLE");
  bytes32 internal constant PRICER_ROLE = keccak256("PRICER_ROLE");
  bytes32 internal constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

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

  /**
   * @dev Event emitted every time a new policy is created. It allows to link the policyData with a particular policy
   *
   * @param policyId The id of the policy
   * @param policyData The value sent in `policyData` parameter that's the hash of the off-chain stored data.
   */
  event NewSignedPolicy(uint256 indexed policyId, bytes32 policyData);

  error QuoteExpired();
  error BucketCannotBeZero();
  error BucketNotFound();

  /// @custom:oz-upgrades-unsafe-allow constructor
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
    if (quoteValidUntil < block.timestamp) revert QuoteExpired();

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
      abi.encodePacked(address(this), payout, premium, lossProb, expiration, policyData, bucketId, quoteValidUntil)
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
    createdPolicy = _newPolicyWithParams(
      payout,
      premium,
      lossProb,
      expiration,
      payer,
      onBehalfOf,
      _makeInternalId(policyData),
      bucketParams(bucketId)
    );
    emit NewSignedPolicy(createdPolicy.id, policyData);
    return createdPolicy;
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
  ) external whenNotPaused onlyComponentRole(POLICY_CREATOR_ROLE) returns (uint256) {
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
    return _newPolicySigned(payout, premium, lossProb, expiration, policyData, bucketId, _msgSender(), onBehalfOf).id;
  }

  /**
   * @dev Replace a policy with a new one, reusing the premium and the capital locked
   *
   * Requirements:
   * - The caller approved the spending of the premium to the PolicyPool
   * - The quote has been signed by an address with the component role PRICER_ROLE
   * - The caller has been granted component role REPLACER_ROLE or creation is open
   *
   * Emits:
   * - {PolicyPool.PolicyReplaced}
   * - {PolicyPool.NewPolicy}
   *
   * @param oldPolicy The policy to be replaced
   * @param payout The exposure (maximum payout) of the new policy
   * @param premium The premium that will be paid by the caller
   * @param lossProb The probability of having to pay the maximum payout (wad)
   * @param expiration The expiration of the policy (timestamp)
   * @param policyData A hash of the private details of the policy. The last 96 bits will be used as internalId
   * @param bucketId Identifies the group to which the policy belongs (that defines the RM parameters applicable to it)
   * @param quoteSignatureR The signature of the quote. R component (EIP-2098 signature)
   * @param quoteSignatureVS The signature of the quote. VS component (EIP-2098 signature)
   * @param quoteValidUntil The expiration of the quote
   * @return Returns the id of the created policy
   */
  function replacePolicy(
    Policy.PolicyData calldata oldPolicy,
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    bytes32 policyData,
    uint256 bucketId,
    bytes32 quoteSignatureR,
    bytes32 quoteSignatureVS,
    uint40 quoteValidUntil
  ) external whenNotPaused onlyComponentRole(REPLACER_ROLE) returns (uint256) {
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
    uint96 internalId = uint96(uint256(policyData) % 2 ** 96);
    return
      _replacePolicy(oldPolicy, payout, premium, lossProb, expiration, _msgSender(), internalId, bucketParams(bucketId))
        .id;
  }

  function resolvePolicy(
    Policy.PolicyData calldata policy,
    uint256 payout
  ) external onlyComponentRole(RESOLVER_ROLE) whenNotPaused {
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
  function setBucketParams(
    uint256 bucketId,
    Params calldata params_
  ) external onlyGlobalOrComponentRole2(LEVEL1_ROLE, LEVEL2_ROLE) {
    if (bucketId == 0) revert BucketCannotBeZero();
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
  function deleteBucket(uint256 bucketId) external onlyGlobalOrComponentRole2(LEVEL1_ROLE, LEVEL2_ROLE) {
    if (bucketId == 0) revert BucketCannotBeZero();
    if (_buckets[bucketId].moc == 0) revert BucketNotFound();
    delete _buckets[bucketId];
    emit BucketDeleted(bucketId);
  }

  /**
   * @dev returns the risk bucket parameters for the given bucketId
   *
   * @param bucketId Id of the bucket or 0 if you want the default params
   */
  function bucketParams(uint256 bucketId) public view returns (Params memory params_) {
    if (bucketId != 0) {
      PackedParams storage bucketParams_ = _buckets[bucketId];
      if (bucketParams_.moc == 0) revert BucketNotFound();
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
    return _getMinimumPremium(payout, lossProb, expiration, uint40(block.timestamp), bucketParams(bucketId));
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[49] private __gap;
}
