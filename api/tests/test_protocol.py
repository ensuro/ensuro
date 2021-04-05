from decimal import Decimal
from io import StringIO
from unittest import TestCase
from ..wadray import Wad, Ray, _W, _R
from ..utils import load_config, WEEK, DAY


class TestWalkthrough(TestCase):

    def _calculate_shares(self, balances, total_supply):
        return dict((k, v // total_supply) for (k, v) in balances.items())

    def test_walkthrough(self):

        YAML_SETUP = """
        module: app.prototype
        risk_modules:
          - name: Roulette
            mcr_percentage: 100
            premium_share: 0
            ensuro_share: 0
          - name: Flight-Insurance
            mcr_percentage: 90
            premium_share: 3
            ensuro_share: 1.5
          - name: Fire-Insurance
            mcr_percentage: 80
            premium_share: 0
            ensuro_share: 0.5
        etokens:
          - name: eUSD1WEEK
            expiration_period: 604800
          - name: eUSD1MONTH
            expiration_period: 2592000
          - name: eUSD1YEAR
            expiration_period: 31536000
        """

        protocol = load_config(StringIO(YAML_SETUP))

        assert protocol.deposit("eUSD1YEAR", "LP1", _W(1000)) == _W(1000)

        eUSD1YEAR = protocol.etokens["eUSD1YEAR"]
        eUSD1MONTH = protocol.etokens["eUSD1MONTH"]
        assert eUSD1YEAR.balance_of("LP1") == _W(1000)

        protocol.fast_forward_time(WEEK)

        assert eUSD1YEAR.balance_of("LP1") == _W(1000)  # Unchanged

        policy = policy_1 = policy = protocol.new_policy(
            "Roulette", payout=_W(36), premium=_W(1),
            loss_prob=_R(1/37), expiration=protocol.now() + WEEK
        )

        assert policy.mcr == _W(35)
        assert policy.pure_premium.equal(_W(36) * _W(1/37))
        assert policy.interest_rate.equal(_R("0.0402647545"))

        for etoken, amount in policy.locked_funds:
            assert etoken == "eUSD1YEAR"
            assert amount == policy.mcr

        assert eUSD1YEAR.balance_of('LP1').equal(_W("1000"))
        # After one day, balance increases because of accrued interest of policy
        protocol.fast_forward_time(DAY)
        p1_one_day_interest = policy.premium_split()[-1] // _W(7)  # 1/7 since the policy lasts 1 WEEK
        assert eUSD1YEAR.balance_of('LP1').equal(_W("1000") + p1_one_day_interest)

        assert protocol.deposit("eUSD1YEAR", "LP2", _W(2000)) == _W(2000)

        # After one day both balances increase
        protocol.fast_forward_time(DAY)
        assert eUSD1YEAR.balance_of('LP1').equal(
            _W(1000) + p1_one_day_interest + p1_one_day_interest * _W(1) // _W(3)
        )
        assert eUSD1YEAR.balance_of('LP2').equal(
            _W(2000) + p1_one_day_interest * _W(2) // _W(3)
        )

        # New deposits
        assert protocol.deposit("eUSD1WEEK", "LP3", _W(500)) == _W(500)
        assert protocol.deposit("eUSD1MONTH", "LP3", _W(1500)) == _W(1500)

        balances_1y = dict((lp, eUSD1YEAR.balance_of(lp)) for lp in ("LP1", "LP2", "LP3"))
        shares_1y = self._calculate_shares(balances_1y, eUSD1YEAR.total_supply())

        policy_2 = policy = protocol.new_policy(
            "Roulette", payout=_W(72), premium=_W(2),
            loss_prob=_R(1/37), expiration=protocol.now() + 10 * DAY
        )

        assert policy.mcr == _W(70)
        assert policy.pure_premium.equal(_W(72) * _W(1/37))
        assert policy.interest_rate.equal(
            ((policy.premium - policy.pure_premium) * _W(365 / 10) // policy.mcr).to_ray()
        )
        p2_one_day_interest = policy.premium_split()[-1] // _W(10)

        eUSD1YEAR_ocean = eUSD1YEAR.ocean
        eUSD1MONTH_ocean = eUSD1MONTH.ocean
        total_ocean = eUSD1YEAR_ocean + eUSD1MONTH_ocean

        for etoken, amount in policy.locked_funds:
            if etoken == "eUSD1YEAR":
                assert amount.equal(policy.mcr * eUSD1YEAR_ocean // total_ocean)
            elif etoken == "eUSD1MONTH":
                assert amount.equal(policy.mcr * eUSD1MONTH_ocean // total_ocean)
            else:
                assert False

        p2_1y_one_day_interest = p2_one_day_interest * eUSD1YEAR_ocean // total_ocean

        protocol.fast_forward_time(DAY)

        for lp in ("LP1", "LP2", "LP3"):
            balance = eUSD1YEAR.balance_of(lp)
            assert balance.equal(
                balances_1y[lp] + (p1_one_day_interest + p2_1y_one_day_interest) * shares_1y[lp]
            )
            balances_1y[lp] = balance
        shares_1y = self._calculate_shares(balances_1y, eUSD1YEAR.total_supply())

        # Resolve 1st policy
        accrued_interest, p1_mcr = p1_one_day_interest * _W(3), policy_1.mcr
        assert accrued_interest.equal(policy_1.accrued_interest())

        protocol.resolve_policy("Roulette", policy_1.id, customer_won=True)

        for lp in ("LP1", "LP2", "LP3"):
            balance = eUSD1YEAR.balance_of(lp)
            assert balance.equal(
                balances_1y[lp] - (accrued_interest + p1_mcr) * shares_1y[lp]
            )
            balances_1y[lp] = balance
        shares_1y = self._calculate_shares(balances_1y, eUSD1YEAR.total_supply())

        protocol.fast_forward_time(2 * DAY)

        p2_accrued_interest = p2_one_day_interest * _W(3)
        assert p2_accrued_interest.equal(policy_2.accrued_interest())
        protocol.resolve_policy("Roulette", policy_2.id, customer_won=False)

        result = policy_2.premium - p2_accrued_interest

        for lp in ("LP1", "LP2", "LP3"):
            balance = eUSD1YEAR.balance_of(lp)

            assert (balance - balances_1y[lp]).equal(
                ((_W(2) * p2_one_day_interest) + result) * (eUSD1YEAR_ocean // total_ocean) * shares_1y[lp]
            )
            balances_1y[lp] = balance
        shares_1y = self._calculate_shares(balances_1y, eUSD1YEAR.total_supply())

        assert eUSD1MONTH.balance_of("LP3").equal(
            _W(1500) + policy_2.premium * (eUSD1MONTH_ocean // total_ocean)
        )
