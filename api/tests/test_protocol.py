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

        for etoken, amount in policy.locked_funds.items():
            assert etoken == "eUSD1YEAR"
            assert amount == policy.mcr

        assert eUSD1YEAR.balance_of('LP1').equal(_W("1000"))
        # After one day, balance increases because of accrued interest of policy
        protocol.fast_forward_time(DAY)
        p1_one_day_interest = policy.premium_split()[-1] // _W(7)  # 1/7 since the policy lasts 1 WEEK
        assert eUSD1YEAR.balance_of('LP1').equal(_W("1000") + p1_one_day_interest)

        assert protocol.deposit("eUSD1YEAR", "LP2", _W(2000)).equal(_W(2000))

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

        for etoken, amount in policy.locked_funds.items():
            if etoken == "eUSD1YEAR":
                assert amount.equal(policy.mcr * eUSD1YEAR_ocean // total_ocean)
            elif etoken == "eUSD1MONTH":
                assert amount.equal(policy.mcr * eUSD1MONTH_ocean // total_ocean)
            else:
                assert False

        p2_1y_one_day_interest = p2_one_day_interest * policy_2.get_mcr_share("eUSD1YEAR").to_wad()

        protocol.fast_forward_time(DAY)

        for lp in ("LP1", "LP2", "LP3"):
            balance = eUSD1YEAR.balance_of(lp)
            assert balance.equal(
                balances_1y[lp] + (p1_one_day_interest + p2_1y_one_day_interest) * shares_1y[lp]
            )
            balances_1y[lp] = balance
        shares_1y = self._calculate_shares(balances_1y, eUSD1YEAR.total_supply())

        # Resolve 1st policy
        accrued_interest = p1_one_day_interest * _W(3)
        assert accrued_interest.equal(policy_1.accrued_interest())

        borrow_from_mcr = policy_1.payout - protocol.pure_premiums
        protocol.resolve_policy("Roulette", policy_1.id, customer_won=True)
        assert borrow_from_mcr.equal(eUSD1YEAR.protocol_loan)
        daily_protocol_loan_interest = eUSD1YEAR.protocol_loan_interest_rate // _R(365)

        for lp in ("LP1", "LP2", "LP3"):
            balance = eUSD1YEAR.balance_of(lp)
            assert balance.equal(
                balances_1y[lp] - borrow_from_mcr * shares_1y[lp]
            )
            balances_1y[lp] = balance
        shares_1y = self._calculate_shares(balances_1y, eUSD1YEAR.total_supply())
        total_supply_before = eUSD1YEAR.total_supply()

        protocol.fast_forward_time(2 * DAY)

        balances_after = dict((lp, eUSD1YEAR.balance_of(lp)) for lp in ("LP1", "LP2", "LP3"))
        shares_after = self._calculate_shares(balances_after, eUSD1YEAR.total_supply())
        assert shares_1y == shares_after
        assert (eUSD1YEAR.total_supply() - total_supply_before).equal(
            p2_one_day_interest * _W(2) * policy_2.get_mcr_share("eUSD1YEAR").to_wad()
        )
        balances_1y = balances_after

        p2_accrued_interest = p2_one_day_interest * _W(3)
        assert p2_accrued_interest.equal(policy_2.accrued_interest())
        p2_for_lps = policy_2.premium_split()[-1]
        adjustment = p2_for_lps - p2_accrued_interest
        protocol.resolve_policy("Roulette", policy_2.id, customer_won=False)

        for lp in ("LP1", "LP2", "LP3"):
            balance = eUSD1YEAR.balance_of(lp)

            assert (balance - balances_1y[lp]).equal(
                adjustment * (eUSD1YEAR_ocean // total_ocean) * shares_1y[lp]
            )
            balances_1y[lp] = balance
        shares_1y = self._calculate_shares(balances_1y, eUSD1YEAR.total_supply())

        assert eUSD1MONTH.balance_of("LP3").equal(
            _W(1500) + policy_2.premium_split()[-1] * policy_2.get_mcr_share("eUSD1MONTH").to_wad()
        )

        assert eUSD1YEAR.get_protocol_loan().equal((
            borrow_from_mcr.to_ray() * (_R(1) + daily_protocol_loan_interest * _R(2))
        ).to_wad())  # protocol_loan is the same but with 2 days interest
        assert eUSD1YEAR.total_supply().equal(_W("2966.96639675928"))  # from Jupyter

        policies = []

        for day in range(60):
            protocol_loan = eUSD1YEAR.get_protocol_loan()
            new_p = protocol.new_policy(
                "Roulette", payout=_W(72), premium=_W(2),
                loss_prob=_R(1/37), expiration=protocol.now() + 6 * DAY
            )
            customer_won = day % 37 == 36
            for p in list(policies):
                if p.expiration > protocol.now():
                    break
                if customer_won:
                    if p.payout < protocol.pure_premiums:
                        change = _W(0)
                    else:
                        change = (protocol.pure_premiums - p.payout) * p.get_mcr_share("eUSD1YEAR").to_wad()
                else:
                    change = min(
                        protocol_loan, (p.pure_premium.to_ray() * p.get_mcr_share("eUSD1YEAR")).to_wad()
                    )
                protocol.resolve_policy("Roulette", p.id, customer_won=customer_won)
                policies.pop(0)

                assert eUSD1YEAR.get_protocol_loan().equal(protocol_loan - change)
                protocol_loan = eUSD1YEAR.get_protocol_loan()

            protocol.fast_forward_time(DAY)
            policies.append(new_p)
            assert eUSD1YEAR.get_protocol_loan().equal(
                protocol_loan * (_R(1) + daily_protocol_loan_interest).to_wad()
            )

        assert eUSD1YEAR.get_protocol_loan() == _W(0)

        for i, p in enumerate(policies):
            day = 60 + i
            customer_won = day % 37 == 36
            protocol.resolve_policy("Roulette", p.id, customer_won=customer_won)
            if customer_won:
                repay = _W(0)
            else:
                repay = min(
                    protocol_loan, (p.pure_premium.to_ray() * p.get_mcr_share("eUSD1YEAR")).to_wad()
                )
            assert eUSD1YEAR.get_protocol_loan().equal(protocol_loan - repay)

            protocol.fast_forward_time(DAY)
            assert eUSD1YEAR.get_protocol_loan().equal(
                ((protocol_loan - repay).to_ray() * (_R(1) + daily_protocol_loan_interest)).to_wad()
            )
            protocol_loan = eUSD1YEAR.get_protocol_loan()

        assert eUSD1YEAR.get_protocol_loan() == _W(0)
        assert protocol.pure_premiums.equal(_W("11.5358414574"))  # from jypiter prints
