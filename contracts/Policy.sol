// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {SafeMath} from '@openzeppelin/contracts/utils/math/SafeMath.sol';
import {WadRayMath} from './WadRayMath.sol';
import {IRiskModule} from '../interfaces/IRiskModule.sol';

library Policy {
  using SafeMath for uint256;
  using WadRayMath for uint256;

  uint256 public constant SECONDS_IN_YEAR = 31536000000000000000000000; /* 365 * 24 * 3600 * 10e18 */
  uint256 public constant SECONDS_IN_YEAR_RAY = 31536000000000000000000000000000000; /* 365 * 24 * 3600 * 10e27 */

  // Active Policies
  struct PolicyData {
    uint256 id;
    IRiskModule riskModule;
    uint256 payout;
    uint256 premium;
    uint256 scr;
    uint256 rmCoverage;     // amount of the payout covered by risk_module
    uint256 lossProb;       // original loss probability (in ray)
    uint40 start;
    uint40 expiration;
    uint256 purePremium;    // share of the premium that covers expected losses
                            // equal to payout * lossProb * riskModule.moc
    uint256 premiumForEnsuro; // share of the premium that goes for Ensuro (if policy won)
    uint256 premiumForRm;     // share of the premium that goes for the RM (if policy won)
    uint256 premiumForLps;    // share of the premium that goes to the liquidity providers (won or not)
  }

  function initialize(IRiskModule riskModule, uint256 premium, uint256 payout,
                      uint256 lossProb, uint40 expiration) public returns (PolicyData memory) {
    require(premium <= payout);
    PolicyData memory policy;
    policy.riskModule = riskModule;
    policy.premium = premium;
    policy.payout = payout;
    policy.rmCoverage = payout.wadToRay().rayMul(riskModule.sharedCoveragePercentage()).rayToWad();
    uint256 ens_premium;
    uint256 rm_premium;
    policy.lossProb = lossProb;
    (ens_premium, rm_premium) = _coveragePremiumSplit(policy);
    policy.scr = payout.sub(ens_premium).sub(policy.rmCoverage).wadMul(
      riskModule.scrPercentage().rayToWad()
    );
    require(policy.scr != 0, "SCR can't be zero");
    policy.start = uint40(block.timestamp);
    policy.expiration = expiration;
    policy.purePremium = payout.sub(policy.rmCoverage).wadToRay().rayMul(lossProb).rayToWad();  // TODO moc
    uint256 profitPremium = ens_premium.sub(policy.purePremium);
    policy.premiumForEnsuro = profitPremium.wadMul(riskModule.ensuroShare().rayToWad());
    policy.premiumForRm = profitPremium.wadMul(riskModule.premiumShare().rayToWad());
    policy.premiumForLps = profitPremium.sub(policy.premiumForEnsuro).sub(policy.premiumForRm);
    policy.premiumForRm = policy.premiumForRm.add(rm_premium);
    return policy;
  }

  function _coveragePremiumSplit(PolicyData memory policy) internal returns (uint256, uint256) {
    uint256 ens_premium = policy.premium.wadMul(
      policy.payout.sub(policy.rmCoverage)
    ).wadDiv(policy.payout);
    return (ens_premium, policy.premium.sub(ens_premium));
  }

  function rmScr(PolicyData memory policy) public returns (uint256) {
    uint256 ens_premium;
    uint256 rm_premium;
    (ens_premium, rm_premium) = _coveragePremiumSplit(policy);
    return policy.rmCoverage.sub(rm_premium);
  }

  function interestRate(PolicyData memory policy) public returns (uint256) {
    return policy.premiumForLps.wadMul(SECONDS_IN_YEAR).wadDiv(
      (policy.expiration - policy.start) * policy.scr
    ).wadToRay();
  }

  function accruedInterest(PolicyData memory policy) public returns (uint256) {
    uint256 secs = block.timestamp.sub(policy.start);
    return policy.scr.wadToRay().rayMul(
      secs * interestRate(policy)
    ).rayDiv(SECONDS_IN_YEAR_RAY).rayToWad();
  }

  // For debugging
  function uint2str(uint _i) public pure returns (string memory _uintAsString) {
    if (_i == 0) {
      return "0";
    }
    uint j = _i;
    uint len;
    while (j != 0) {
      len++;
      j /= 10;
    }
    bytes memory bstr = new bytes(len);
    uint k = len;
    while (_i != 0) {
        k = k-1;
        uint8 temp = (48 + uint8(_i - _i / 10 * 10));
        bytes1 b1 = bytes1(temp);
        bstr[k] = b1;
        _i /= 10;
    }
    return string(bstr);
   }
}
