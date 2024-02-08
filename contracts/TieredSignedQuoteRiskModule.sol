// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {SignedQuoteRiskModule} from "./SignedQuoteRiskModule.sol";
import {Policy} from "./Policy.sol";

/**
 * @title Tiered SignedQuote Risk Module
 * @dev Risk Module that for policy creation verifies the different components of the price have been signed by a
 *      trusted account (PRICER_ROLE). For the resolution (resolvePolicy), it has to be called by an authorized user.
 *
 *      It allows different collaterallization levels for different policy types, by defining tiers or buckets of loss
 *      probability.
 *
 *      Each bucket's loss probability represents the upper bound of the bucket (inclusive). The global parameters of
 *      the contract represent the 100% bucket.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract TieredSignedQuoteRiskModule is SignedQuoteRiskModule {
  using SafeCast for uint256;

  uint8 public constant MAX_BUCKETS = 4;

  struct PackedBuckets {
    uint64[MAX_BUCKETS] lossProbs;
  }

  PackedBuckets internal _buckets;
  PackedParams[MAX_BUCKETS] internal _bucketParams;

  /**
   * @dev Emitted when a new risk bucket is created.
   * @param lossProb The loss probability of the new bucket.
   * @param params The packed parameters of the new bucket.
   */
  event NewBucket(uint256 lossProb, Params params);

  /**
   * @dev Emitted when the risks buckets are reset and only the default one remains
   */
  event BucketsReset();

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    IPremiumsAccount premiumsAccount_,
    bool creationIsOpen_
  ) SignedQuoteRiskModule(policyPool_, premiumsAccount_, creationIsOpen_) {} // solhint-disable-line no-empty-blocks

  /**
   * @dev Adds a new risk bucket with the given loss probability and parameters after the last one.
   *
   * Requirements:
   *
   * - The caller must have the LEVEL1_ROLE or LEVEL2_ROLE
   *
   * @param lossProb The loss probability of the new bucket.
   * @param params_ The parameters of the new bucket.
   */
  function pushBucket(
    uint256 lossProb,
    Params calldata params_
  ) external onlyGlobalOrComponentRole2(LEVEL1_ROLE, LEVEL2_ROLE) {
    uint256 newBucket = 0;
    if (_buckets.lossProbs[0] != 0) {
      for (
        newBucket = 1;
        newBucket < MAX_BUCKETS && _buckets.lossProbs[newBucket] != 0;
        newBucket++
      ) {} // solhint-disable-line no-empty-blocks
      require(newBucket < MAX_BUCKETS, "No more than 4 buckets accepted");
      require(
        lossProb > uint256(_buckets.lossProbs[newBucket - 1]),
        "lossProb <= last lossProb - reset instead"
      );
    }
    _buckets.lossProbs[newBucket] = lossProb.toUint64();
    _bucketParams[newBucket] = PackedParams({
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
    if (newBucket < MAX_BUCKETS - 1) {
      _buckets.lossProbs[newBucket + 1] = 0;
    }
    _validatePackedParams(_bucketParams[newBucket]);
    emit NewBucket(lossProb, params_);
  }

  function resetBuckets() external onlyGlobalOrComponentRole2(LEVEL1_ROLE, LEVEL2_ROLE) {
    _buckets.lossProbs[0] = 0;
    emit BucketsReset();
  }

  /**
   * @dev returns the risk bucket parameters for the given loss probability
   */
  function bucketParams(uint256 lossProb) public view returns (Params memory) {
    for (uint256 i = 0; i < MAX_BUCKETS && _buckets.lossProbs[i] != 0; i++) {
      if (lossProb <= _buckets.lossProbs[i]) {
        return _unpackParams(_bucketParams[i]);
      }
    }
    return this.params();
  }

  function _newPolicy(
    uint256 payout,
    uint256 premium,
    uint256 lossProb,
    uint40 expiration,
    address payer,
    address onBehalfOf,
    uint96 internalId
  ) internal override whenNotPaused returns (Policy.PolicyData memory) {
    return
      _newPolicyWithParams(
        payout,
        premium,
        lossProb,
        expiration,
        payer,
        onBehalfOf,
        internalId,
        bucketParams(lossProb)
      );
  }

  function getMinimumPremium(
    uint256 payout,
    uint256 lossProb,
    uint40 expiration
  ) public view virtual override returns (uint256) {
    return _getMinimumPremium(payout, lossProb, expiration, bucketParams(lossProb));
  }

  /**
   * @dev returns the current risk bucket limits
   */
  function buckets() external view returns (uint256[MAX_BUCKETS] memory result) {
    for (uint256 i = 0; i < MAX_BUCKETS && _buckets.lossProbs[i] > 0; i++) {
      result[i] = _buckets.lossProbs[i];
    }
    return result;
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[45] private __gap;
}
