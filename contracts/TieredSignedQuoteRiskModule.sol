// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.16;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPolicyPool} from "./interfaces/IPolicyPool.sol";
import {IPremiumsAccount} from "./interfaces/IPremiumsAccount.sol";
import {SignedQuoteRiskModule} from "./SignedQuoteRiskModule.sol";
import {Policy} from "./Policy.sol";

// DEBUG: import hardhat console
import "hardhat/console.sol";

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
  uint256[] private _buckets;

  mapping(uint256 => Params) private _bucketParams;

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
    _validateParams(params_);
    _insertBucket(lossProb, params_);
    emit NewBucket(lossProb, params_);
  }

  function removeBucket(uint256 lossProb) public onlyGlobalOrComponentRole(LEVEL1_ROLE) {
    Params memory params_ = _getBucketParams(lossProb);
    _removeBucket(lossProb);
    emit BucketDeleted(lossProb, params_);
  }

  function _insertBucket(uint256 lossprob, Params memory params_) internal {
    // make room in the buckets array
    _buckets.push(0);

    // Shift everything right until the right place is found
    uint256 newBucketPos;
    for (
      newBucketPos = _buckets.length - 1;
      newBucketPos > 0 && _buckets[newBucketPos - 1] > lossprob;
      newBucketPos--
    ) {
      _buckets[newBucketPos] = _buckets[newBucketPos - 1];
    }

    // Insert the new bucket in the right position
    _buckets[newBucketPos] = lossprob;

    // Insert the new bucket params
    _bucketParams[lossprob] = params_;
  }

  function _removeBucket(uint256 lossprob) internal {
    uint256 bucketPos;
    for (
      bucketPos = 0;
      bucketPos < _buckets.length && _buckets[bucketPos] != lossprob;
      bucketPos++
    ) {} // solhint-disable-line no-empty-blocks
    require(bucketPos < _buckets.length, "Bucket not found");

    // shift everything left
    for (uint256 i = bucketPos; i < _buckets.length - 1; i++) {
      _buckets[i] = _buckets[i + 1];
    }

    // remove last element
    _buckets.pop();
  }

  function _getBucketParams(uint256 lossProb) internal view returns (Params memory params) {
    params = this.params();
    for (uint256 i = 0; i < _buckets.length && _buckets[i] > 0; i++) {
      if (lossProb <= _buckets[i]) {
        params = _bucketParams[_buckets[i]];
        break;
      }
    }
    return params;
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

  function buckets() public view returns (uint256[] memory) {
    return _buckets;
  }

  function bucketParams(uint256 lossprob) public view returns (Params memory) {
    return _getBucketParams(lossprob);
  }
}
