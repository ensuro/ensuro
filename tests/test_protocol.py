from io import StringIO
from unittest import TestCase
import pytest
from prototype.contracts import RevertError, Contract
from prototype.wadray import _W, _R
from prototype.utils import load_config, WEEK, DAY


class TestProtocol(TestCase):
    def tearDown(self):
        Contract.manager.clean_all()

    def _calculate_shares(self, balances, total_supply):
        return dict((k, v // total_supply) for (k, v) in balances.items())

    def test_walkthrough(self):

        YAML_SETUP = """
        module: prototype.ensuro
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
        adjustment = policy_1.premium_split()[-1] - accrued_interest
        protocol.resolve_policy("Roulette", policy_1.id, customer_won=True)

        assert USD.balance_of("CUST1") == _W(36)
        assert USD.balance_of(protocol.contract_id) == _W(1000 + 2000 + 2000 + 2 - 35)

        assert borrow_from_mcr.equal(eUSD1YEAR.protocol_loan)
        daily_protocol_loan_interest = eUSD1YEAR.protocol_loan_interest_rate // _R(365)

        for lp in ("LP1", "LP2", "LP3"):
            balance = eUSD1YEAR.balance_of(lp)
            balance.assert_equal(
                balances_1y[lp] + (adjustment - borrow_from_mcr) * shares_1y[lp]
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

            (balance - balances_1y[lp]).assert_equal(
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
        eUSD1YEAR.total_supply().assert_equal(_W("2966.9818"))  # from Jupyter

        protocol.withdraw("eUSD1YEAR", "LP2", None).assert_equal(_W("1977.98534"))

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
        assert protocol.pure_premiums.equal(_W("21.21943222506249692"))  # from jypiter prints

        assert USD.balance_of(protocol.contract_id).equal(
            _W(1000 + 2000 + 2 - 35 + 2 * 65 - 72 * won_count) +
            _W(2000) - _W("1977.98534")
        )

        assert protocol.withdraw("eUSD1YEAR", "LP1", None) == _W("1023.42788568762743449")
        assert protocol.withdraw("eUSD1WEEK", "LP3", None) == _W("500.587288338126130735")
        assert protocol.withdraw("eUSD1MONTH", "LP3", None) == _W("1501.780045569056425935")
        USD.balance_of(protocol.contract_id).assert_equal(
            _W("21.219432")
        )

        assert USD.balance_of("LP1") == _W("1023.42788568762743449")
        assert USD.balance_of("LP3") == (_W("500.587288338126130735") + _W("1501.780045569056425935"))
        assert USD.balance_of("CUST3") == _W(72)

    def test_transfers(self):

        YAML_SETUP = """
        module: prototype.ensuro
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

    def test_withdraw_queue(self):

        YAML_SETUP = """
        module: prototype.ensuro
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
            min_queued_withdraw: 20
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
        etoken.total_withdrawable().assert_equal(
            _W(3000) - (_R(2200) * (_R(1) + policy.interest_rate) * _R("1.1")).to_wad()
        )
        withdrawable = etoken.total_withdrawable()

        assert protocol.withdraw("eUSD1YEAR", "LP2", None) == withdrawable
        assert protocol.currency.balance_of("LP2") == withdrawable

        protocol.fast_forward_time(4 * DAY)
        to_withdraw = etoken.balance_of("LP2")
        assert etoken.queue_withdraw("LP2", None) == to_withdraw

        protocol.fast_forward_time(361 * DAY)
        protocol.resolve_policy("Roulette", policy.id, customer_won=False)
        assert protocol.currency.balance_of("LP2") == (withdrawable + to_withdraw)

        protocol.withdraw("eUSD1YEAR", "LP2", None).assert_equal(
            for_lps * _W(361/365) * to_withdraw // (to_withdraw + _W(2000)),
            decimals=2
        )

    def test_rebalance_policy(self):
        YAML_SETUP = """
        module: prototype.ensuro
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
              amount: 1000
            - user: LP2
              amount: 1000
            - user: LP3
              amount: 1000
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

        protocol.currency.approve("LP1", protocol.contract_id, _W(1000))
        protocol.currency.approve("LP2", protocol.contract_id, _W(1000))
        protocol.currency.approve("LP3", protocol.contract_id, _W(1000))

        # each pool has 1000
        assert protocol.deposit("eUSD1YEAR", "LP1", _W(1000)) == _W(1000)
        assert protocol.deposit("eUSD1MONTH", "LP2", _W(1000)) == _W(1000)
        assert protocol.deposit("eUSD1WEEK", "LP3", _W(1000)) == _W(1000)

        protocol.currency.approve("CUST1", protocol.contract_id, _W(100))
        policy = protocol.new_policy(
            "Roulette", payout=_W(2100), premium=_W(100), customer="CUST1",
            loss_prob=_R("0.03"), expiration=protocol.now() + 10 * DAY
        )
        assert policy.mcr == _W(2000)
        for_lps = policy.premium_split()[-1]

        # Only eUSD1YEAR and eUSD1MONTH are affected
        assert protocol.etokens["eUSD1YEAR"].ocean == _W(0)
        assert protocol.etokens["eUSD1MONTH"].ocean == _W(0)
        assert protocol.etokens["eUSD1WEEK"].ocean == _W(1000)

        assert len(policy.locked_funds) == 2

        protocol.fast_forward_time(4 * DAY)

        # After four days, now the policy expires in less than a week, so eUSD1WEEK is eligible
        protocol.rebalance_policy("Roulette", policy.id)

        # Now funds are locked in the three pools
        protocol.etokens["eUSD1YEAR"].mcr.assert_equal(_W(2000 / 3) + _W("1.63637"))
        protocol.etokens["eUSD1MONTH"].mcr.assert_equal(_W(2000 / 3) + _W("1.63637"))
        protocol.etokens["eUSD1WEEK"].mcr.assert_equal(_W(2000 / 3) - _W("1.63637") * _W(2))
        mcr_week_share = protocol.etokens["eUSD1WEEK"].mcr // policy.mcr
        mcr_others_share = (_W(1) - mcr_week_share) // _W(2)

        mcr_week_share.assert_equal(_W(1/3), decimals=2)  # not exactly 1/3 because accrued interest
        mcr_others_share.assert_equal(_W(1/3), decimals=2)

        protocol.fast_forward_time(6 * DAY)

        protocol.etokens["eUSD1YEAR"].total_supply().assert_equal(
            _W(1000) + for_lps * _W("0.4") * _W("0.5") + for_lps * _W("0.6") * mcr_others_share,
        )
        protocol.etokens["eUSD1MONTH"].total_supply().assert_equal(
            _W(1000) + for_lps * _W("0.4") * _W("0.5") + for_lps * _W("0.6") * mcr_others_share,
        )
        protocol.etokens["eUSD1WEEK"].total_supply().assert_equal(
            _W(1000) + for_lps * _W("0.6") * mcr_week_share,
        )

    def test_risk_module_shared_coverage(self):
        YAML_SETUP = """
        module: prototype.ensuro
        risk_modules:
          - name: Roulette
            mcr_percentage: 1
            premium_share: 0.015
            ensuro_share: 0.01
            max_mcr_per_policy: 1000
            mcr_limit: 1200
            shared_coverage_min_percentage: .25
        currency:
            name: USD
            symbol: $
            initial_supply: 20000
            initial_balances:
            - user: LP1
              amount: 10000
            - user: RM
              amount: 5000
            - user: CUST1
              amount: 200
        etokens:
          - name: eUSD1YEAR
            expiration_period: 31536000
        """

        protocol = load_config(StringIO(YAML_SETUP))
        USD = protocol.currency

        USD.approve("LP1", protocol.contract_id, _W(10000))
        assert protocol.deposit("eUSD1YEAR", "LP1", _W(10000)) == _W(10000)

        USD.approve("CUST1", protocol.contract_id, _W(200))

        # Should fail if more than max for policy
        with pytest.raises(RevertError, match="max for this module"):
            policy = protocol.new_policy(
                "Roulette", payout=_W(2100), premium=_W(100), customer="CUST1",
                loss_prob=_R("0.02"), expiration=protocol.now() + 10 * DAY
            )

        USD.approve("RM", protocol.contract_id, _W(1000))
        policy = protocol.new_policy(
            "Roulette", payout=_W(1100), premium=_W(100), customer="CUST1",
            loss_prob=_R("0.02"), expiration=protocol.now() + 10 * DAY
        )
        policy.rm_coverage.assert_equal(_W(1100) * _W("0.25"))
        USD.balance_of("RM").assert_equal(_W(4750))  # 250 locked in the protocol

        policy.mcr.assert_equal(_W(750))
        pure_premium, for_ensuro, for_rm, for_lps = policy.premium_split()

        pure_premium.assert_equal(_W(1100) * _W("0.75") * _W("0.02"))
        rm_shared_premium = _W(100) * _W("0.25")
        profit_premium = _W(100) - rm_shared_premium - pure_premium
        for_ensuro.assert_equal(profit_premium * _W("0.01"))
        for_rm.assert_equal(profit_premium * _W("0.015") + rm_shared_premium)
        assert (pure_premium + for_ensuro + for_rm + for_lps) == policy.premium

        # Another policy with the same parameters fails because of MCR limit
        with pytest.raises(RevertError, match="MCR exceeds the allowed for this module"):
            policy = protocol.new_policy(
                "Roulette", payout=_W(1100), premium=_W(100), customer="CUST1",
                loss_prob=_R("0.02"), expiration=protocol.now() + 10 * DAY
            )

        protocol.resolve_policy("Roulette", policy.id, False)

        USD.balance_of("RM").assert_equal(_W(5000) + for_rm)  # received back the MCR + part of premium
        USD.balance_of("ENS").assert_equal(for_ensuro)

    def test_asset_manager(self):
        YAML_SETUP = """
        module: prototype.ensuro
        risk_modules:
          - name: Roulette
            mcr_percentage: 1
        currency:
            name: USD
            symbol: $
            initial_supply: 20000
            initial_balances:
            - user: LP1
              amount: 10000
            - user: CUST1
              amount: 200
        etokens:
          - name: eUSD1YEAR
            expiration_period: 31536000
        asset_manager:
            class: FixedRateAssetManager
            liquidity_min: 1000
            liquidity_middle: 1500
            liquidity_max: 2000
        """

        protocol = load_config(StringIO(YAML_SETUP))
        USD = protocol.currency
        etk = protocol.etokens["eUSD1YEAR"]
        asset_manager = protocol.asset_manager

        USD.approve("LP1", protocol.contract_id, _W(10000))
        assert protocol.deposit("eUSD1YEAR", "LP1", _W(10000)) == _W(10000)
        asset_manager.checkpoint()  # Rebalance cash
        assert USD.balance_of(protocol.contract_id) == _W(1500)
        assert USD.balance_of(asset_manager.contract_id) == _W(8500)

        protocol.fast_forward_time(365 * DAY)
        assert etk.balance_of("LP1") == _W(10000)
        asset_manager.checkpoint()
        assert USD.balance_of(protocol.contract_id) == _W(1500)  # unchanged
        etk.balance_of("LP1").assert_equal(_W(10000) + _W(8500) * _W("0.05"))  # All earnings for the LP
        lp1_balance = etk.balance_of("LP1")

        USD.approve("CUST1", protocol.contract_id, _W(200))
        policy = protocol.new_policy(
            "Roulette", payout=_W(9200), premium=_W(200), customer="CUST1",
            loss_prob=_R("0.01"), expiration=protocol.now() + 365 * DAY // 2
        )
        pure_premium, _, _, for_lps = policy.premium_split()

        asset_manager.checkpoint()
        assert USD.balance_of(protocol.contract_id) == _W(1700)  # +200 but not sent to asset_manager
        etk.balance_of("LP1").assert_equal(lp1_balance)
        protocol.get_investable().assert_equal(_W(200))
        etk.get_investable().assert_equal(lp1_balance)

        protocol.fast_forward_time(365 * DAY // 2)
        protocol.get_investable().assert_equal(_W(200))
        etk.get_investable().assert_equal(lp1_balance + for_lps)

        protocol_share = _W(200) // asset_manager.total_investable()
        etk_share = etk.get_investable() // asset_manager.total_investable()
        asset_manager.checkpoint()

        protocol.won_pure_premiums.assert_equal(_W(8500) * _W("0.025") * protocol_share)
        etk.balance_of("LP1").assert_equal(lp1_balance + for_lps + _W(8500) * _W("0.025") * etk_share)

        protocol.resolve_policy("Roulette", policy.id, customer_won=True)
        assert USD.balance_of(protocol.contract_id) == _W(1500)  # balance back to middle
        USD.balance_of(asset_manager.contract_id).assert_equal(
            _W(8500) +                # initial investment
            _W(8500) * _W("0.075") -  # earned interest
            _W(9200 - 1700 + 1500)    # 9200 (payout) - 1700 (wallet) + 1500 (liquidity_middle)
        )

        assert protocol.get_investable() == _W(0)
        assert etk.get_investable() == (
            etk.ocean + etk.get_protocol_loan()  # not really the money available but used for etk_share
        )

    def test_nfts(self):

        YAML_SETUP = """
        module: prototype.ensuro
        risk_modules:
          - name: Roulette
            mcr_percentage: 1
            premium_share: 0
            ensuro_share: 0
        nft:
            name: Ensuro Policy NFT
            symbol: EPOL
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
        usd = protocol.currency

        usd.approve("LP1", protocol.contract_id, _W(3500))
        nft = protocol.policies_nft

        assert protocol.deposit("eUSD1YEAR", "LP1", _W(3500)) == _W(3500)

        usd.approve("CUST1", protocol.contract_id, _W(100))
        policy = protocol.new_policy(
            "Roulette", payout=_W(3600), premium=_W(100), customer="CUST1",
            loss_prob=_R(1/37), expiration=protocol.now() + WEEK
        )

        assert nft.balance_of("CUST1") == 1
        assert nft.owner_of(policy.id) == "CUST1"

        nft.transfer_from("CUST1", "CUST1", "CUST2", policy.id)

        protocol.fast_forward_time(WEEK)
        protocol.resolve_policy("Roulette", policy.id, customer_won=True)
        assert usd.balance_of("CUST1") == _W(0)
        assert usd.balance_of("CUST2") == _W(3600)