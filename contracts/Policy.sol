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
  uint256 internal constant SECONDS_IN_YEAR_RAY = 31536000e27; /* 365 * 24 * 3600 * 10e27 */

  // Active Policies
  struct PolicyData {
    uint256 id;
    uint256 payout;
    uint256 premium;
    uint256 scr;
    uint256 lossProb; // original loss probability (in ray)
    uint256 purePremium; // share of the premium that covers expected losses
    // equal to payout * lossProb * riskModule.moc
    uint256 ensuroCommission; // share of the premium that goes for Ensuro
    uint256 premiumForRm; // share of the premium that goes for the RM (if policy won)
    uint256 coc; // share of the premium that goes to the liquidity providers (won or not)
    IRiskModule riskModule;
    uint40 start;
    uint40 expiration;
  }

  /// #if_succeeds {:msg "premium preserved"} premium == (newPolicy.premium);
  /// #if_succeeds
  ///    {:msg "premium distributed"}
  ///    premium == (newPolicy.purePremium + newPolicy.coc +
  ///                newPolicy.premiumForRm + newPolicy.ensuroCommission);
  function initialize(
    IRiskModule riskModule,
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
    policy.purePremium = payout.wadToRay().rayMul(lossProb.rayMul(riskModule.moc())).rayToWad();
    policy.scr = payout.wadMul(riskModule.collRatio().rayToWad()) - policy.purePremium;
    require(policy.scr != 0, "SCR can't be zero");
    policy.start = uint40(block.timestamp);
    policy.expiration = expiration;
    policy.coc = policy.scr.wadMul(
      ((riskModule.roc() * (policy.expiration - policy.start)).rayDiv(SECONDS_IN_YEAR_RAY))
        .rayToWad()
    );
    policy.ensuroCommission = (policy.purePremium + policy.coc).wadMul(
      riskModule.ensuroFee().rayToWad()
    );
    require(
      policy.purePremium + policy.ensuroCommission + policy.coc <= premium,
      "Premium less than minimum"
    );
    policy.premiumForRm = premium - policy.purePremium - policy.coc - policy.ensuroCommission;
    return policy;
  }

  function interestRate(PolicyData memory policy) internal pure returns (uint256) {
    return
      policy
        .coc
        .wadMul(SECONDS_IN_YEAR)
        .wadDiv((policy.expiration - policy.start) * policy.scr)
        .wadToRay();
  }

  function accruedInterest(PolicyData memory policy) internal view returns (uint256) {
    uint256 secs = block.timestamp - policy.start;
    return
      policy
        .scr
        .wadToRay()
        .rayMul(secs * interestRate(policy))
        .rayDiv(SECONDS_IN_YEAR_RAY)
        .rayToWad();
  }

  function hash(PolicyData memory policy) internal pure returns (bytes32) {
    return keccak256(abi.encode(policy));
  }
}
