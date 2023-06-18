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
  uint256[] private buckets;

  mapping(uint256 => Params) private bucketParams;

  // _params are the default parameters inherited from parent contract

  event NewBucket(uint256 lossProb, Params params);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IPolicyPool policyPool_,
    IPremiumsAccount premiumsAccount_,
    bool creationIsOpen_
  ) SignedQuoteRiskModule(policyPool_, premiumsAccount_, creationIsOpen_) {}

  function setBucket(
    uint256 lossProb,
    Params calldata params_
  ) public onlyGlobalOrComponentRole(LEVEL1_ROLE) {
    _insertBucket(lossProb, params_);
    emit NewBucket(lossProb, params_);
  }

  function _insertBucket(uint256 lossprob, Params memory params_) internal {
    // make room in the buckets array
    buckets.push(0);

    // Shift everything right until the right place is found
    uint256 newBucketPos;
    for (
      newBucketPos = buckets.length - 1;
      newBucketPos > 0 && buckets[newBucketPos - 1] > lossprob;
      newBucketPos--
    ) {
      buckets[newBucketPos] = buckets[newBucketPos - 1];
    }

    // Insert the new bucket in the right position
    buckets[newBucketPos] = lossprob;

    // Insert the new bucket params
    bucketParams[lossprob] = params_;
  }

  function _getBucketParams(uint256 lossProb) internal view returns (Params memory params) {
    params = _unpackParams(_params); // TODO: just use params()?
    for (uint256 i = 0; i < buckets.length && buckets[i] > 0; i++) {
      if (lossProb <= buckets[i]) {
        params = bucketParams[buckets[i]];
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
}
