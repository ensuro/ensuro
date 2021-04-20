from io import StringIO
from unittest import TestCase
import pytest
from ..contracts import RevertError, Contract
from ..wadray import _W, _R
from ..utils import load_config, WEEK, DAY


class TestProtocol(TestCase):
    def tearDown(self):
        Contract.manager.clean_all()

    def _calculate_shares(self, balances, total_supply):
        return dict((k, v // total_supply) for (k, v) in balances.items())

    def test_walkthrough(self):

        YAML_SETUP = """
        module: app.prototype
        risk_modules:
          - name: Roulette
            mcr_percentage: 1
            premium_share: 0
            ensuro_share: 0
          - name: Flight-Insurance
            mcr_percentage: "0.9"
            premium_share: "0.03"
            ensuro_share: "0.015"
          - name: Fire-Insurance
            mcr_percentage: "0.8"
            premium_share: 0
            ensuro_share: "0.005"
        currency:
            name: USD
            symbol: $
            initial_supply: 6000
            initial_balances:
            - user: LP1
              amount: 1000
            - user: LP2
              amount: 2000
            - user: LP3
              amount: 2000
            - user: CUST1
              amount: 1
            - user: CUST2
              amount: 2
            - user: CUST3
              amount: 130
        etokens:
          - name: eUSD1WEEK
            expiration_period: 604800
          - name: eUSD1MONTH
            expiration_period: 2592000
          - name: eUSD1YEAR
            expiration_period: 31536000
        """

        protocol = load_config(StringIO(YAML_SETUP))

        with pytest.raises(RevertError, match="Not enought allowance"):
            protocol.deposit("eUSD1YEAR", "LP1", _W(1000))

        assert protocol.currency.balance_of("LP1") == _W(1000)  # unchanged

        protocol.currency.approve("LP1", protocol.contract_id, _W(1000))
        assert protocol.deposit("eUSD1YEAR", "LP1", _W(1000)) == _W(1000)

        eUSD1YEAR = protocol.etokens["eUSD1YEAR"]
        eUSD1MONTH = protocol.etokens["eUSD1MONTH"]
        USD = protocol.currency

        assert eUSD1YEAR.balance_of("LP1") == _W(1000)
        assert eUSD1YEAR.ocean == _W(1000)
        assert USD.balance_of("LP1") == _W(0)

        protocol.fast_forward_time(WEEK)

        assert eUSD1YEAR.balance_of("LP1") == _W(1000)  # Unchanged

        with pytest.raises(RevertError, match="Not enought allowance"):
            policy = policy_1 = policy = protocol.new_policy(
                "Roulette", payout=_W(36), premium=_W(1), customer="CUST1",
                loss_prob=_R(1/37), expiration=protocol.now() + WEEK
            )

        protocol.currency.approve("CUST1", protocol.contract_id, _W(1))
        policy_1 = policy = protocol.new_policy(
            "Roulette", payout=_W(36), premium=_W(1), customer="CUST1",
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

        protocol.currency.approve("LP2", protocol.contract_id, _W(2000))
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
        protocol.currency.approve("LP3", protocol.contract_id, _W(2000))
        assert protocol.deposit("eUSD1WEEK", "LP3", _W(500)) == _W(500)
        assert protocol.deposit("eUSD1MONTH", "LP3", _W(1500)) == _W(1500)

        balances_1y = dict((lp, eUSD1YEAR.balance_of(lp)) for lp in ("LP1", "LP2", "LP3"))
        shares_1y = self._calculate_shares(balances_1y, eUSD1YEAR.total_supply())

        protocol.currency.approve("CUST2", protocol.contract_id, _W(2))
        policy_2 = policy = protocol.new_policy(
            "Roulette", payout=_W(72), premium=_W(2), customer="CUST2",
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

        assert USD.balance_of("CUST1") == _W(36)
        assert USD.balance_of(protocol.contract_id) == _W(1000 + 2000 + 2000 + 2 - 35)

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

        assert USD.balance_of("CUST2") == _W(0)
        assert USD.balance_of(protocol.contract_id) == _W(1000 + 2000 + 2000 + 2 - 35)  # unchanged

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

        assert protocol.redeem("eUSD1YEAR", "LP2", None) == _W("1977.97505218308246292")

        policies = []

        protocol.currency.approve("CUST3", protocol.contract_id, _W(130))

        won_count = 0

        for day in range(65):
            protocol_loan = eUSD1YEAR.get_protocol_loan()
            new_p = protocol.new_policy(
                "Roulette", payout=_W(72), premium=_W(2),
                loss_prob=_R(1/37), expiration=protocol.now() + 6 * DAY,
                customer="CUST3",
            )
            customer_won = day % 37 == 36
            for p in list(policies):
                if p.expiration > protocol.now():
                    break
                if customer_won:
                    won_count += 1
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

        protocol_loan = eUSD1YEAR.get_protocol_loan()

        for i, p in enumerate(policies):
            day = 65 + i
            customer_won = day % 37 == 36
            protocol.resolve_policy("Roulette", p.id, customer_won=customer_won)
            if customer_won:
                won_count += 1
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
        assert protocol.pure_premiums.equal(_W("21.2194318750412539"))  # from jypiter prints

        assert USD.balance_of(protocol.contract_id).equal(
            _W(1000 + 2000 + 2 - 35 + 2 * 65 - 72 * won_count) +
            _W(2000) - _W("1977.975052183")
        )

        assert protocol.redeem("eUSD1YEAR", "LP1", None) == _W("1023.422734019840732922")
        assert protocol.redeem("eUSD1WEEK", "LP3", None) == _W("500.587289337969297047")
        assert protocol.redeem("eUSD1MONTH", "LP3", None) == _W("1501.780048568622237637")
        USD.balance_of(protocol.contract_id).assert_equal(
            _W("21.23487")  # TODO: understand the difference with 21.21943... of pure premiums
        )

        assert USD.balance_of("LP1") == _W("1023.422734019840732922")
        assert USD.balance_of("LP3") == (_W("500.587289337969297047") + _W("1501.780048568622237637"))
        assert USD.balance_of("CUST3") == _W(72)

    def test_transfers(self):

        YAML_SETUP = """
        module: app.prototype
        risk_modules:
          - name: Roulette
            mcr_percentage: 1
            premium_share: 0
            ensuro_share: 0
        currency:
            name: USD
            symbol: $
            initial_supply: 6000
            initial_balances:
            - user: LP1
              amount: 3500
            - user: CUST1
              amount: 100
        etokens:
          - name: eUSD1WEEK
            expiration_period: 604800
          - name: eUSD1MONTH
            expiration_period: 2592000
          - name: eUSD1YEAR
            expiration_period: 31536000
        """

        protocol = load_config(StringIO(YAML_SETUP))

        protocol.currency.approve("LP1", protocol.contract_id, _W(3500))
        etoken = protocol.etokens["eUSD1YEAR"]

        assert protocol.deposit("eUSD1YEAR", "LP1", _W(3500)) == _W(3500)

        protocol.currency.approve("CUST1", protocol.contract_id, _W(100))
        policy = protocol.new_policy(
            "Roulette", payout=_W(3600), premium=_W(100), customer="CUST1",
            loss_prob=_R(1/37), expiration=protocol.now() + WEEK
        )

        assert etoken.ocean == _W(0)
        protocol.fast_forward_time(3 * DAY)

        pure_premium, _, _, interest = policy.premium_split()

        etoken.balance_of("LP1").assert_equal(
            _W(3500) + interest * _W(3/7)
        )
        lp1_balance = etoken.balance_of("LP1")

        etoken.transfer("LP1", "LP2", lp1_balance // _W(3))
        etoken.approve("LP1", "spender", lp1_balance // _W(3))
        etoken.transfer_from("spender", "LP1", "LP3", lp1_balance // _W(3))

        etoken.balance_of("LP1").assert_equal(lp1_balance // _W(3))
        etoken.balance_of("LP2").assert_equal(lp1_balance // _W(3))
        etoken.balance_of("LP3").assert_equal(lp1_balance // _W(3))

        protocol.fast_forward_time(4 * DAY)

        etoken.balance_of("LP1").assert_equal(lp1_balance // _W(3) + interest * _W(4/7) // _W(3))
        etoken.balance_of("LP2").assert_equal(lp1_balance // _W(3) + interest * _W(4/7) // _W(3))
        etoken.balance_of("LP3").assert_equal(lp1_balance // _W(3) + interest * _W(4/7) // _W(3))

        protocol.resolve_policy("Roulette", policy.id, customer_won=True)
        etoken.balance_of("LP1").assert_equal(_W(0))
        etoken.balance_of("LP2").assert_equal(_W(0))
        etoken.balance_of("LP3").assert_equal(_W(0))

    def test_redeem_queue(self):

        YAML_SETUP = """
        module: app.prototype
        risk_modules:
          - name: Roulette
            mcr_percentage: 1
            premium_share: 0
            ensuro_share: 0
        currency:
            name: USD
            symbol: $
            initial_supply: 6000
            initial_balances:
            - user: LP1
              amount: 2000
            - user: LP2
              amount: 1000
            - user: CUST1
              amount: 100
        etokens:
          - name: eUSD1YEAR
            expiration_period: 31536000
            min_queued_redeem: 20
            liquidity_requirement: "1.1"
        """

        protocol = load_config(StringIO(YAML_SETUP))

        protocol.currency.approve("LP1", protocol.contract_id, _W(2000))
        protocol.currency.approve("LP2", protocol.contract_id, _W(1000))
        etoken = protocol.etokens["eUSD1YEAR"]

        assert protocol.deposit("eUSD1YEAR", "LP1", _W(2000)) == _W(2000)
        assert protocol.deposit("eUSD1YEAR", "LP2", _W(1000)) == _W(1000)

        protocol.currency.approve("CUST1", protocol.contract_id, _W(100))
        policy = protocol.new_policy(
            "Roulette", payout=_W(2300), premium=_W(100), customer="CUST1",
            loss_prob=_R("0.01"), expiration=protocol.now() + 365 * DAY
        )
        assert policy.mcr == _W(2200)
        assert etoken.ocean == _W(800)
        _, _, _, for_lps = policy.premium_split()

        assert etoken.mcr_interest_rate == policy.interest_rate
        etoken.total_redeemable().assert_equal(
            _W(3000) - (_R(2200) * (_R(1) + policy.interest_rate) * _R("1.1")).to_wad()
        )
        redeemable = etoken.total_redeemable()

        assert protocol.redeem("eUSD1YEAR", "LP2", None) == redeemable
        assert protocol.currency.balance_of("LP2") == redeemable

        protocol.fast_forward_time(4 * DAY)
        to_redeem = etoken.balance_of("LP2")
        assert etoken.queue_redeem("LP2", None) == to_redeem

        protocol.fast_forward_time(361 * DAY)
        protocol.resolve_policy("Roulette", policy.id, customer_won=False)
        assert protocol.currency.balance_of("LP2") == (redeemable + to_redeem)

        protocol.redeem("eUSD1YEAR", "LP2", None).assert_equal(
            for_lps * _W(361/365) * to_redeem // (to_redeem + _W(2000)),
            decimals=2
        )
