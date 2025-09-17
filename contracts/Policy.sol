// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";

/**
 * @title Policy library
 * @dev Library for PolicyData struct. This struct represents an active policy, how the premium is
 *      distributed, the probability of payout, duration and how the capital is locked.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library Policy {
  using Math for uint256;

  uint256 internal constant WAD = 1e18;
  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  // Active Policies
  struct PolicyData {
    uint256 id;
    uint256 payout;
    uint256 premium;
    uint256 jrScr;
    uint256 srScr;
    uint256 lossProb; // original loss probability (in wad)
    uint256 purePremium; // share of the premium that covers expected losses
    // equal to payout * lossProb * riskModule.moc
    uint256 ensuroCommission; // share of the premium that goes for Ensuro
    uint256 partnerCommission; // share of the premium that goes for the RM
    uint256 jrCoc; // share of the premium that goes to junior liquidity providers (won or not)
    uint256 srCoc; // share of the premium that goes to senior liquidity providers (won or not)
    IRiskModule riskModule;
    uint40 start;
    uint40 expiration;
  }

  struct PremiumComposition {
    uint256 purePremium;
    uint256 jrScr;
    uint256 srScr;
    uint256 jrCoc;
    uint256 srCoc;
    uint256 ensuroCommission;
    uint256 partnerCommission;
    uint256 totalPremium;
  }

  error PremiumLessThanMinimum(uint256 premium, uint256 minPremium);
  error PremiumExceedsPayout(uint256 premium, uint256 payout);
  error ZeroHash(PolicyData policy);

  function getMinimumPremium(
    IRiskModule.Params memory rmParams,
    uint256 payout,
    uint256 lossProb,
    uint40 expiration,
    uint40 start
  ) internal pure returns (PremiumComposition memory minPremium) {
    minPremium.purePremium = payout.mulDiv(lossProb, WAD).mulDiv(rmParams.moc, WAD);
    minPremium.jrScr = payout.mulDiv(rmParams.jrCollRatio, WAD);
    if (minPremium.jrScr > minPremium.purePremium) {
      minPremium.jrScr -= minPremium.purePremium;
    } else {
      minPremium.jrScr = 0;
    }

    minPremium.srScr = payout.mulDiv(rmParams.collRatio, WAD);
    if (minPremium.srScr > (minPremium.purePremium + minPremium.jrScr)) {
      minPremium.srScr -= minPremium.purePremium + minPremium.jrScr;
    } else {
      minPremium.srScr = 0;
    }

    // Calculate CoCs
    minPremium.jrCoc = minPremium.jrScr.mulDiv((rmParams.jrRoc * (expiration - start)) / SECONDS_PER_YEAR, WAD);
    minPremium.srCoc = minPremium.srScr.mulDiv((rmParams.srRoc * (expiration - start)) / SECONDS_PER_YEAR, WAD);
    uint256 totalCoc = minPremium.jrCoc + minPremium.srCoc;

    minPremium.ensuroCommission =
      minPremium.purePremium.mulDiv(rmParams.ensuroPpFee, WAD) +
      totalCoc.mulDiv(rmParams.ensuroCocFee, WAD);

    minPremium.totalPremium = minPremium.purePremium + minPremium.ensuroCommission + totalCoc;
  }

  function initialize(
    IRiskModule riskModule,
    IRiskModule.Params memory rmParams,
    uint256 premium,
    uint256 payout,
    uint256 lossProb,
    uint40 expiration,
    uint40 start
  ) internal pure returns (PolicyData memory newPolicy) {
    require(premium < payout, PremiumExceedsPayout(premium, payout));
    PolicyData memory policy;

    policy.riskModule = riskModule;
    policy.premium = premium;
    policy.payout = payout;
    policy.lossProb = lossProb;
    policy.start = start;
    policy.expiration = expiration;

    PremiumComposition memory minPremium = getMinimumPremium(rmParams, payout, lossProb, expiration, start);

    policy.purePremium = minPremium.purePremium;
    policy.jrScr = minPremium.jrScr;
    policy.srScr = minPremium.srScr;
    policy.jrCoc = minPremium.jrCoc;
    policy.srCoc = minPremium.srCoc;
    policy.ensuroCommission = minPremium.ensuroCommission;

    require(minPremium.totalPremium <= premium, PremiumLessThanMinimum(premium, minPremium.totalPremium));

    policy.partnerCommission = premium - minPremium.totalPremium;
    return policy;
  }

  function jrInterestRate(PolicyData memory policy) internal pure returns (uint256) {
    return ((policy.jrCoc * SECONDS_PER_YEAR) / (policy.expiration - policy.start)).mulDiv(WAD, policy.jrScr);
  }

  function jrAccruedInterest(PolicyData memory policy) internal view returns (uint256) {
    return (policy.jrCoc * (block.timestamp - policy.start)) / duration(policy);
  }

  function srInterestRate(PolicyData memory policy) internal pure returns (uint256) {
    return ((policy.srCoc * SECONDS_PER_YEAR) / (policy.expiration - policy.start)).mulDiv(WAD, policy.srScr);
  }

  function srAccruedInterest(PolicyData memory policy) internal view returns (uint256) {
    return (policy.srCoc * (block.timestamp - policy.start)) / duration(policy);
  }

  function duration(PolicyData memory policy) internal pure returns (uint40) {
    return policy.expiration - policy.start;
  }

  function hash(PolicyData memory policy) internal pure returns (bytes32 retHash) {
    retHash = keccak256(abi.encode(policy));
    require(retHash != bytes32(0), ZeroHash(policy));
    return retHash;
  }
}
