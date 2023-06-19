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
        trusted account (PRICER_ROLE). For the resolution (resolvePolicy), it has to be called by an authorized user.

        It allows different collaterallization levels for different policy types, by defining tiers or buckets of loss
        probability.

 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract TieredSignedQuoteRiskModule is SignedQuoteRiskModule {
  uint8 public constant MAX_BUCKETS = 4;

  struct PackedBuckets {
    uint64[MAX_BUCKETS] lossProbs;
  }

  PackedBuckets private _buckets;
  PackedParams[MAX_BUCKETS] private _bucketParams;

  event NewBucket(uint256 lossProb, Params params);

  event BucketDeleted(uint256 lossProb, Params params);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    IPremiumsAccount premiumsAccount_,
    bool creationIsOpen_
  ) SignedQuoteRiskModule(policyPool_, premiumsAccount_, creationIsOpen_) {} // solhint-disable-line no-empty-blocks

  function setBucket(uint256 lossProb, Params calldata params_)
    public
    onlyGlobalOrComponentRole(LEVEL1_ROLE)
  {
    _validatePackedParams(
      _insertBucket(
        lossProb,
        PackedParams({
          moc: _wadTo4(params_.moc),
          jrCollRatio: _wadTo4(params_.jrCollRatio),
          collRatio: _wadTo4(params_.collRatio),
          ensuroPpFee: _wadTo4(params_.ensuroPpFee),
          ensuroCocFee: _wadTo4(params_.ensuroCocFee),
          jrRoc: _wadTo4(params_.jrRoc),
          srRoc: _wadTo4(params_.srRoc),
          maxPayoutPerPolicy: type(uint32).max, // unused
          exposureLimit: type(uint32).max, //unused
          maxDuration: type(uint16).max //unused
        })
      )
    );
    emit NewBucket(lossProb, params_);
  }

  function removeBucket(uint256 lossProb) public onlyGlobalOrComponentRole(LEVEL1_ROLE) {
    Params memory params_ = _getBucketParams(lossProb);
    _removeBucket(lossProb);
    emit BucketDeleted(lossProb, params_);
  }

  function _insertBucket(uint256 lossprob, PackedParams memory params_)
    internal
    returns (PackedParams storage)
  {
    require(_buckets.lossProbs[MAX_BUCKETS - 1] == 0, "Buckets full");

    uint256 newBucketPos;

    // Find the last element in the array
    for (
      newBucketPos = 0;
      newBucketPos < MAX_BUCKETS && _buckets.lossProbs[newBucketPos] > 0;
      newBucketPos++
    ) {} // solhint-disable-line no-empty-blocks

    // Shift everything right until the right place is found
    for (; newBucketPos > 0 && _buckets.lossProbs[newBucketPos - 1] > lossprob; newBucketPos--) {
      _buckets.lossProbs[newBucketPos] = _buckets.lossProbs[newBucketPos - 1];
      _bucketParams[newBucketPos] = _bucketParams[newBucketPos - 1];
    }

    // Insert the new bucket in the right position
    _buckets.lossProbs[newBucketPos] = SafeCast.toUint64(lossprob);

    // Insert the new bucket params
    _bucketParams[newBucketPos] = params_;

    return _bucketParams[newBucketPos];
  }

  function _removeBucket(uint256 lossprob) internal {
    uint256 bucketPos;
    for (
      bucketPos = 0;
      bucketPos < MAX_BUCKETS && _buckets.lossProbs[bucketPos] != lossprob;
      bucketPos++
    ) {} // solhint-disable-line no-empty-blocks
    require(bucketPos < MAX_BUCKETS, "Bucket not found");

    // shift everything left
    for (uint256 i = bucketPos; i < MAX_BUCKETS - 1; i++) {
      _buckets.lossProbs[i] = _buckets.lossProbs[i + 1];
      _bucketParams[i] = _bucketParams[i + 1];
    }
    _buckets.lossProbs[MAX_BUCKETS - 1] = 0;
    _bucketParams[MAX_BUCKETS - 1] = PackedParams(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }

  function _getBucketParams(uint256 lossProb) internal view returns (Params memory) {
    for (uint256 i = 0; i < MAX_BUCKETS && _buckets.lossProbs[i] > 0; i++) {
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
        _getBucketParams(lossProb)
      );
  }

  function getMinimumPremium(
    uint256 payout,
    uint256 lossProb,
    uint40 expiration
  ) public view virtual override returns (uint256) {
    return _getMinimumPremium(payout, lossProb, expiration, _getBucketParams(lossProb));
  }

  function buckets() public view returns (uint256[4] memory result) {
    for (uint256 i = 0; i < MAX_BUCKETS && _buckets.lossProbs[i] > 0; i++) {
      result[i] = _buckets.lossProbs[i];
    }
    return result;
  }

  function bucketParams(uint256 lossprob) public view returns (Params memory) {
    return _getBucketParams(lossprob);
  }

  /**
   * @dev This empty reserved space is put in place to allow future versions to add new
   * variables without shifting down storage in the inheritance chain.
   * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
   */
  uint256[45] private __gap;
}
