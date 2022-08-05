// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;
import {WadRayMath} from "./WadRayMath.sol";
import {IRiskModule} from "../interfaces/IRiskModule.sol";

/**
 * @title Policy library
 * @dev Library for PolicyData struct. This struct represents an active policy, how the premium is
 *      distributed, the probability of payout, duration and how the capital is locked.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
library Policy {
  using WadRayMath for uint256;

  uint256 internal constant SECONDS_IN_YEAR = 31536000e18; /* 365 * 24 * 3600 * 10e18 */
  uint256 internal constant SECONDS_IN_YEAR_WAD = 31536000e18; /* 365 * 24 * 3600 * 10e18 */

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

  /// #if_succeeds {:msg "premium preserved"} premium == (newPolicy.premium);
  /// #if_succeeds
  ///    {:msg "premium distributed"}
  ///    premium == (newPolicy.purePremium + newPolicy.coc +
  ///                newPolicy.partnerCommission + newPolicy.ensuroCommission);
  function initialize(
    IRiskModule riskModule,
    IRiskModule.Params memory rmParams,
    uint256 premium,
    uint256 payout,
    uint256 lossProb,
    uint40 expiration
  ) internal view returns (PolicyData memory newPolicy) {
    require(premium <= payout, "Premium cannot be more than payout");
    PolicyData memory policy;

    policy.riskModule = riskModule;
    policy.premium = premium;
    policy.payout = payout;
    policy.lossProb = lossProb;
    policy.start = uint40(block.timestamp);
    policy.expiration = expiration;
    policy.purePremium = payout.wadMul(lossProb.wadMul(rmParams.moc));
    // Calculate Junior and Senior SCR
    policy.jrScr = payout.wadMul(rmParams.jrCollRatio);
    if (policy.jrScr > policy.purePremium) {
      policy.jrScr -= policy.purePremium;
    } else {
      policy.jrScr = 0;
    }
    policy.srScr = payout.wadMul(rmParams.collRatio);
    if (policy.srScr > (policy.purePremium + policy.jrScr)) {
      policy.srScr -= policy.purePremium + policy.jrScr;
    } else {
      policy.srScr = 0;
    }
    // Calculate CoCs
    policy.jrCoc = policy.jrScr.wadMul(
      ((rmParams.jrRoc * (policy.expiration - policy.start)).wadDiv(SECONDS_IN_YEAR_WAD))
    );
    policy.srCoc = policy.srScr.wadMul(
      ((rmParams.srRoc * (policy.expiration - policy.start)).wadDiv(SECONDS_IN_YEAR_WAD))
    );
    uint256 coc = policy.jrCoc + policy.srCoc;
    policy.ensuroCommission =
      policy.purePremium.wadMul(rmParams.ensuroPpFee) +
      coc.wadMul(rmParams.ensuroCocFee);
    require(
      (policy.purePremium + policy.ensuroCommission + coc) <= premium,
      "Premium less than minimum"
    );
    policy.partnerCommission = premium - policy.purePremium - coc - policy.ensuroCommission;
    return policy;
  }

  function jrInterestRate(PolicyData memory policy) internal pure returns (uint256) {
    return
      policy.jrCoc.wadMul(SECONDS_IN_YEAR).wadDiv(
        (policy.expiration - policy.start) * policy.jrScr
      );
  }

  function jrAccruedInterest(PolicyData memory policy) internal view returns (uint256) {
    uint256 secs = block.timestamp - policy.start;
    return policy.jrScr.wadMul(secs * jrInterestRate(policy)).wadDiv(SECONDS_IN_YEAR_WAD);
  }

  function srInterestRate(PolicyData memory policy) internal pure returns (uint256) {
    return
      policy.srCoc.wadMul(SECONDS_IN_YEAR).wadDiv(
        (policy.expiration - policy.start) * policy.srScr
      );
  }

  function srAccruedInterest(PolicyData memory policy) internal view returns (uint256) {
    uint256 secs = block.timestamp - policy.start;
    return policy.srScr.wadMul(secs * srInterestRate(policy)).wadDiv(SECONDS_IN_YEAR_WAD);
  }

  function hash(PolicyData memory policy) internal pure returns (bytes32) {
    return keccak256(abi.encode(policy));
  }
}
