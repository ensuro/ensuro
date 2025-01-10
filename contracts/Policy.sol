// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;
import {WadRayMath} from "./dependencies/WadRayMath.sol";
import {IRiskModule} from "./interfaces/IRiskModule.sol";

/**
 * @title Policy library
 * @dev Library for PolicyData struct. This struct represents an active policy, how the premium is
 *      distributed, the probability of payout, duration and how the capital is locked.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library Policy {
  using WadRayMath for uint256;

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

  function getMinimumPremium(
    IRiskModule.Params memory rmParams,
    uint256 payout,
    uint256 lossProb,
    uint40 expiration,
    uint40 start
  ) internal pure returns (PremiumComposition memory minPremium) {
    minPremium.purePremium = payout.wadMul(lossProb.wadMul(rmParams.moc));
    minPremium.jrScr = payout.wadMul(rmParams.jrCollRatio);
    if (minPremium.jrScr > minPremium.purePremium) {
      minPremium.jrScr -= minPremium.purePremium;
    } else {
      minPremium.jrScr = 0;
    }

    minPremium.srScr = payout.wadMul(rmParams.collRatio);
    if (minPremium.srScr > (minPremium.purePremium + minPremium.jrScr)) {
      minPremium.srScr -= minPremium.purePremium + minPremium.jrScr;
    } else {
      minPremium.srScr = 0;
    }

    // Calculate CoCs
    minPremium.jrCoc = minPremium.jrScr.wadMul((rmParams.jrRoc * (expiration - start)) / SECONDS_PER_YEAR);
    minPremium.srCoc = minPremium.srScr.wadMul((rmParams.srRoc * (expiration - start)) / SECONDS_PER_YEAR);
    uint256 totalCoc = minPremium.jrCoc + minPremium.srCoc;

    minPremium.ensuroCommission =
      minPremium.purePremium.wadMul(rmParams.ensuroPpFee) +
      totalCoc.wadMul(rmParams.ensuroCocFee);

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
    require(premium <= payout, "Premium cannot be more than payout");
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

    require(minPremium.totalPremium <= premium, "Premium less than minimum");

    policy.partnerCommission = premium - minPremium.totalPremium;
    return policy;
  }

  function jrInterestRate(PolicyData memory policy) internal pure returns (uint256) {
    return ((policy.jrCoc * SECONDS_PER_YEAR) / (policy.expiration - policy.start)).wadDiv(policy.jrScr);
  }

  function jrAccruedInterest(PolicyData memory policy) internal view returns (uint256) {
    return (policy.jrCoc * (block.timestamp - policy.start)) / (policy.expiration - policy.start);
  }

  function srInterestRate(PolicyData memory policy) internal pure returns (uint256) {
    return ((policy.srCoc * SECONDS_PER_YEAR) / (policy.expiration - policy.start)).wadDiv(policy.srScr);
  }

  function srAccruedInterest(PolicyData memory policy) internal view returns (uint256) {
    return (policy.srCoc * (block.timestamp - policy.start)) / (policy.expiration - policy.start);
  }

  function hash(PolicyData memory policy) internal pure returns (bytes32 retHash) {
    retHash = keccak256(abi.encode(policy));
    require(retHash != bytes32(0), "Policy: hash cannot be 0");
    return retHash;
  }
}
