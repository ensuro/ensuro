// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import {SafeMath} from '@openzeppelin/contracts/utils/math/SafeMath.sol';
import {WadRayMath} from './WadRayMath.sol';
import {IRiskModule} from '../interfaces/IRiskModule.sol';

library Policy {
  using SafeMath for uint256;
  using WadRayMath for uint256;

  struct LockedCapital {
    address eToken;
    uint256 amount;
  }

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
    // LockedCapital[] lockedFunds;  // sum(lockedFunds.amount) == (scr - rmCoverage)
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

  /*
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.rm_coverage = self.risk_module.shared_coverage_percentage.to_wad() * self.payout
        ens_premium, rm_premium = self._coverage_premium_split()
        self.scr = (self.payout - ens_premium - self.rm_coverage) * self.risk_module.scr_percentage.to_wad()

    def _coverage_premium_split(self):
        ens_premium = self.premium * (self.payout - self.rm_coverage) // self.payout
        rm_premium = self.premium - ens_premium
        return ens_premium, rm_premium

    @property
    def pure_premium(self):
        payout = self.payout - self.rm_coverage
        return (payout.to_ray() * self.loss_prob).to_wad()

    @property
    def rm_scr(self):
        ens_premium, rm_premium = self._coverage_premium_split()
        return self.rm_coverage - rm_premium

    def premium_split(self):
        ens_premium, rm_premium = self._coverage_premium_split()

        pure_premium = self.pure_premium
        profit_premium = ens_premium - pure_premium
        for_ensuro = (profit_premium.to_ray() * self.risk_module.ensuro_share).to_wad()
        for_risk_module = (profit_premium.to_ray() * self.risk_module.premium_share).to_wad()
        for_lps = profit_premium - for_ensuro - for_risk_module
        for_risk_module += rm_premium  # after calculating for_lps...
        return pure_premium, for_ensuro, for_risk_module, for_lps

    @property
    def interest_rate(self):
        _, for_ensuro, for_risk_module, for_lps = self.premium_split()
        return (
            for_lps * _W(SECONDS_IN_YEAR) // (
                _W(self.expiration - self.start) * self.scr
            )
        ).to_ray()

    def accrued_interest(self):
        seconds = Ray.from_value(time_control.now - self.start)
        return (
            self.scr.to_ray() * seconds * self.interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        ).to_wad()

    def get_scr_share(self, etoken_name):
        if etoken_name not in self.locked_funds:
            return Ray(0)
        return (self.locked_funds[etoken_name] // self.scr).to_ray()

    */


}
