"""Unitary tests for eToken contract"""
import sys
from functools import partial, wraps
from collections import namedtuple
import pytest
from ethproto.contracts import RevertError
from prototype import ensuro
from ethproto.wadray import _W, _R
from prototype.utils import WEEK, DAY
from prototype import wrappers

TEnv = namedtuple("TEnv", "time_control etoken_class policy_factory kind")


@pytest.fixture(params=["prototype", "ethereum"])
def tenv(request):
    if request.param == "prototype":
        FakePolicy = namedtuple("FakePolicy", "scr interest_rate expiration")

        class FakePolicy(FakePolicy):
            @property
            def risk_module(self):
                return None

        pp_config = ensuro.PolicyPoolConfig()
        policy_pool = ensuro.PolicyPool(
            config=pp_config, currency="required-not-used", policy_nft="required-not-used"
        )

        return TEnv(
            time_control=ensuro.time_control,
            policy_factory=FakePolicy,
            etoken_class=partial(ensuro.EToken, policy_pool=policy_pool),
            kind="prototype"
        )
    elif request.param == "ethereum":
        FakePolicy = namedtuple("FakePolicy", "scr interest_rate expiration")
        PolicyPoolMockForward = wrappers.get_provider().get_contract_factory("PolicyPoolMockForward")

        currency = wrappers.TestCurrency(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(1000))

        def etoken_factory(**kwargs):
            config = wrappers.PolicyPoolConfig(owner="owner")
            pool = PolicyPoolMockForward.deploy(
                wrappers.AddressBook.ZERO, currency.contract, config.contract, {"from": currency.owner}
            )
            symbol = kwargs.pop("symbol", "ETK")
            etoken = wrappers.EToken(policy_pool=pool, symbol=symbol, **kwargs)
            pool.setForwardTo(etoken.contract, {"from": currency.owner})
            return etoken

        return TEnv(
            time_control=wrappers.get_provider().time_control,
            policy_factory=FakePolicy,
            # etoken_class=partial(ETokenETH, policy_pool="ensuro", symbol="ETK")
            etoken_class=etoken_factory,
            kind="ethereum"
        )


def test_only_policy_pool_validation(tenv):
    if tenv.kind == "prototype":
        return
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    with pytest.raises(RevertError, match="The caller must be the PolicyPool"):
        etk.deposit("LP1", _W(1000))
    with pytest.raises(RevertError, match="The caller must be the PolicyPool"):
        etk.withdraw("LP1", _W(1000))
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    with pytest.raises(RevertError, match="The caller must be the PolicyPool"):
        etk.lock_scr(policy, policy.scr)
    with pytest.raises(RevertError, match="The caller must be the PolicyPool"):
        etk.unlock_scr(policy, policy.scr)


def skip_if_coverage_activated(f):
    @wraps(f)
    def wrapped(tenv, *args, **kwargs):
        if "brownie" in sys.modules:
            from brownie._config import CONFIG
            if CONFIG.argv.get("coverage", False) and tenv.kind == "ethereum":
                return
        return f(tenv, *args, **kwargs)
    return wrapped


@skip_if_coverage_activated
def test_deposit_withdraw(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.balance_of("LP1") == _W(1000)
    assert etk.ocean == _W(1000)
    tenv.time_control.fast_forward(DAY)
    assert etk.balance_of("LP1") == _W(1000)  # unchanged because SCR=0
    with etk.thru_policy_pool():
        assert etk.withdraw("LP1", _W(600)) == _W(600)
    assert etk.balance_of("LP1") == _W(400)
    with etk.thru_policy_pool():
        assert etk.withdraw("LP1", None) == _W(400)
    assert etk.balance_of("LP1") == _W(0)
    with etk.thru_policy_pool():
        assert etk.withdraw("LP1", None) == _W(0)


@skip_if_coverage_activated
def test_lock_unlock_scr(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.ocean == _W(1000)
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    with etk.thru_policy_pool():
        etk.lock_scr(policy, policy.scr)
    assert etk.scr == _W(600)
    assert etk.scr_interest_rate == _R("0.0365")
    etk.token_interest_rate.assert_equal(_R("0.0365") * _R(600/1000))
    etk.ocean.assert_equal(_W(400))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))
    tenv.time_control.fast_forward(3 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(5))

    with etk.thru_policy_pool():
        etk.unlock_scr(policy, policy.scr)

    tenv.time_control.fast_forward(10 * DAY)
    expected_balance = _W(1000) + _W("0.06") * _W(5)
    etk.balance_of("LP1").assert_equal(expected_balance)
    etk.transfer("LP1", "LP2", expected_balance)

    with etk.thru_policy_pool():
        etk.withdraw("LP2", None).assert_equal(expected_balance)
    etk.balance_of("LP1").assert_equal(_W(0))


@skip_if_coverage_activated
def test_etoken_erc20(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    with etk.thru_policy_pool():
        etk.lock_scr(policy, policy.scr)
    tenv.time_control.fast_forward(2 * DAY)
    expected_balance = _W(1000) + _W("0.06") * _W(2)
    etk.balance_of("LP1").assert_equal(expected_balance)

    with pytest.raises(RevertError):
        etk.approve("LP1", None, expected_balance // _W(2))

    etk.approve("LP1", "SPEND", expected_balance // _W(2))
    etk.increase_allowance("LP1", "SPEND", _W(50))
    with pytest.raises(RevertError):
        etk.decrease_allowance("LP1", "SPEND", _W(1000))
    etk.decrease_allowance("LP1", "SPEND", _W(20))
    etk.allowance("LP1", "SPEND").assert_equal(expected_balance // _W(2) + _W(30))
    etk.decrease_allowance("LP1", "SPEND", _W(30))

    with pytest.raises(RevertError, match="allowance"):
        etk.transfer_from("SPEND", "LP1", "LP2", expected_balance)
    etk.transfer_from("SPEND", "LP1", "LP2", expected_balance // _W(2))
    etk.allowance("LP1", "SPEND").assert_equal(_W(0))
    etk.balance_of("LP1").assert_equal(expected_balance // _W(2))
    etk.balance_of("LP2").assert_equal(expected_balance // _W(2))

    with etk.thru_policy_pool():
        etk.withdraw("LP2", _W(100)).assert_equal(_W(100))

    total_withdrawable = _W(1000) + _W("0.06") * _W(2) - policy.scr * _W("1.0365") - _W(100)
    etk.total_withdrawable().assert_equal(total_withdrawable)

    # Max to withdraw is total_withdrawable
    with etk.thru_policy_pool():
        etk.withdraw("LP1", _W(5000)).assert_equal(total_withdrawable)
        etk.unlock_scr(policy, policy.scr)
        # now max to withdraw is LP balance
        etk.withdraw("LP1", _W(5000)).assert_equal(expected_balance // _W(2) - total_withdrawable)
        etk.balance_of("LP2").assert_equal(expected_balance // _W(2) - _W(100))
        etk.withdraw("LP2", None).assert_equal(expected_balance // _W(2) - _W(100))


@skip_if_coverage_activated
def test_multiple_policies(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)

    policy1 = tenv.policy_factory(scr=_W(300), interest_rate=_R("0.0365"),
                                  expiration=tenv.time_control.now + WEEK)
    with etk.thru_policy_pool():
        etk.lock_scr(policy1, policy1.scr)
    assert etk.scr_interest_rate == _R("0.0365")
    assert etk.scr == _W(300)
    etk.ocean.assert_equal(_W(700))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.03") * _W(2))

    # Create 2nd policy twice interest twice SCR
    policy2 = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0730"),
                                  expiration=tenv.time_control.now + WEEK)
    with etk.thru_policy_pool():
        etk.lock_scr(policy2, policy2.scr)
    etk.scr_interest_rate.assert_equal(
        (_R("0.0365") * _R(300) + _R("0.0730") * _R(600)) // _R(900)
    )

    assert etk.scr == _W(900)
    etk.ocean.assert_equal(_W(100) + _W("0.03") * _W(2))

    tenv.time_control.fast_forward(3 * DAY)

    expected_balance = _W(1000) + _W("0.03") * _W(5) + _W("0.12") * _W(3)
    etk.balance_of("LP1").assert_equal(expected_balance)

    # Create 3rd policy - Doesn't have impact because unlocked inmediatelly
    policy3 = tenv.policy_factory(scr=_W(100), interest_rate=_R("0.1"),
                                  expiration=tenv.time_control.now + WEEK)
    with etk.thru_policy_pool():
        etk.lock_scr(policy3, policy3.scr)
    etk.total_withdrawable().assert_equal(_W(0))

    with etk.thru_policy_pool():
        etk.unlock_scr(policy3, policy3.scr)
        etk.unlock_scr(policy1, policy1.scr)

    etk.scr_interest_rate.assert_equal(_R("0.0730"))
    assert etk.scr == policy2.scr
    etk.balance_of("LP1").assert_equal(expected_balance)
    with etk.thru_policy_pool(), pytest.raises(RevertError, match="SCR"):
        etk.unlock_scr(policy2, policy2.scr + _W(1))  # Can't unlock more than SCR

    with etk.thru_policy_pool():
        etk.unlock_scr(policy2, policy2.scr)
    assert etk.scr == _W(0)
    etk.total_supply().assert_equal(expected_balance)


@skip_if_coverage_activated
def test_multiple_lps(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.ocean == _W(1000)
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    with etk.thru_policy_pool():
        etk.lock_scr(policy, policy.scr)
    assert etk.scr == _W(600)
    assert etk.ocean == _W(400)

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))

    with etk.thru_policy_pool():
        etk.deposit("LP2", _W(2000)).assert_equal(_W(2000))
    tenv.time_control.fast_forward(3 * DAY)

    lp1_balance = _W(1000) + _W("0.06") * _W(2) + _W("0.06") * _W(3) * _W(1/3)
    etk.balance_of("LP1").assert_equal(lp1_balance)
    lp2_balance = _W(2000) + _W("0.06") * _W(3) * _W(2/3)
    etk.balance_of("LP2").assert_equal(lp2_balance)

    with etk.thru_policy_pool():
        etk.withdraw("LP1", None).assert_equal(lp1_balance)

    tenv.time_control.fast_forward(1 * DAY)
    etk.balance_of("LP2").assert_equal(lp2_balance + _W("0.06"))

    with etk.thru_policy_pool():
        etk.unlock_scr(policy, policy.scr)
        etk.withdraw("LP2", None).assert_equal(lp2_balance + _W("0.06"))


@skip_if_coverage_activated
def test_lock_scr_validation(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)

    with etk.thru_policy_pool():
        with pytest.raises(RevertError, match="Not enought OCEAN to cover the SCR"):
            etk.lock_scr(policy, policy.scr)
        etk.deposit("LP1", _W(200))
        with pytest.raises(RevertError, match="Not enought OCEAN to cover the SCR"):
            etk.lock_scr(policy, policy.scr)


@skip_if_coverage_activated
def test_accepts_policy(tenv):
    etk_week = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    etk_year = tenv.etoken_class(name="eUSD1YEAR", expiration_period=365 * DAY)

    with etk_week.thru_policy_pool():
        etk_week.deposit("LP1", _W(1000))
    with etk_year.thru_policy_pool():
        etk_year.deposit("LP1", _W(2000))

    policy_3_day = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                       expiration=tenv.time_control.now + 3 * DAY)
    policy_10_day = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                        expiration=tenv.time_control.now + 10 * DAY)

    assert etk_week.accepts(policy_3_day)
    assert etk_year.accepts(policy_3_day)
    assert not etk_week.accepts(policy_10_day)
    assert etk_year.accepts(policy_10_day)


@skip_if_coverage_activated
def test_pool_loan(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK,
                            pool_loan_interest_rate=_R("0.073"))
    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(1000))
    assert etk.pool_loan_interest_rate == _R("0.073")
    assert etk.get_pool_loan() == _W(0)

    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.04"),
                                 expiration=tenv.time_control.now + WEEK)
    with etk.thru_policy_pool():
        etk.lock_scr(policy, policy.scr)
    tenv.time_control.fast_forward(7 * DAY)
    etk.ocean.assert_equal(_W(400) + _W(600 * 0.04 * 7 / 365))

    ocean = etk.ocean

    with etk.thru_policy_pool():
        lended = etk.lend_to_pool(_W(401))  # Can't lend more than ocean
        lended.assert_equal(ocean)
        etk.repay_pool_loan(lended)
        etk.lend_to_pool(_W(300))

    etk.get_pool_loan().assert_equal(_W(300))
    tenv.time_control.fast_forward(7 * DAY)

    # After 7 days increases at a rate of 7.3%/year (0.02% per day)
    etk.get_pool_loan().assert_equal(_W(300) * _W(1 + 0.0002 * 7))
    with etk.thru_policy_pool():
        etk.lend_to_pool(_W(100))
    etk.get_investable().assert_equal(etk.ocean + etk.scr + etk.get_pool_loan())

    tenv.time_control.fast_forward(1 * DAY)

    with etk.as_("owner"):
        etk.grant_role("LEVEL2_ROLE", "SETRATE")
    with etk.as_("SETRATE"):
        etk.set_pool_loan_interest_rate(_R("0.0365"))

    assert etk.pool_loan_interest_rate == _R("0.0365")
    pool_loan = _W(400) + _W(300) * _W(0.0002 * 8) + _W(100) * _W(0.0002)
    etk.get_pool_loan().assert_equal(pool_loan)

    tenv.time_control.fast_forward(3 * DAY)
    etk.get_pool_loan().assert_equal(pool_loan * _W(1 + 0.0001 * 3))
    pool_loan = pool_loan * _W(1 + 0.0001 * 3)

    with etk.thru_policy_pool():
        etk.repay_pool_loan(pool_loan // _W(3))
        etk.get_pool_loan().assert_equal(pool_loan * _W(2/3))
        etk.repay_pool_loan(pool_loan * _W(2/3))
        etk.get_pool_loan().assert_equal(_W(0))


@skip_if_coverage_activated
def test_asset_and_discrete_earnings(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)

    # Initial setup
    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(1000))
        etk.deposit("LP2", _W(2000))
    assert etk.total_supply() == _W(3000)
    assert etk.get_current_scale(True) == _R(1)

    # Possitive asset earning
    with etk.thru_policy_pool():
        etk.discrete_earning(_W(500))   # TODO: etk.asset_earnings(_W(500)) called from assetManager
    etk.total_supply().assert_equal(_W(3500))
    etk.get_current_scale(False).assert_equal(_R(1) * _R(3500/3000))
    etk.get_current_scale(True).assert_equal(_R(1) * _R(3500/3000))

    # Negative asset earning
    with etk.thru_policy_pool():
        etk.discrete_earning(-_W(300))    # TODO: etk.asset_earnings(-_W(300)) called from assetManager
    etk.total_supply().assert_equal(_W(3200))
    etk.get_current_scale(False).assert_equal(_R(1) * _R(3200/3000))
    tenv.time_control.fast_forward(1 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) * _W(3200/3000))
    etk.balance_of("LP2").assert_equal(_W(2000) * _W(3200/3000))

    # Possitive discrete_earning
    with etk.thru_policy_pool():
        etk.discrete_earning(_W(400))
    etk.balance_of("LP1").assert_equal(_W(1000) * _W(3600/3000))
    etk.balance_of("LP2").assert_equal(_W(2000) * _W(3600/3000))
    etk.total_supply().assert_equal(_W(3600))

    # Negative discrete_earning
    with etk.thru_policy_pool():
        etk.discrete_earning(-_W(700))
    etk.balance_of("LP1").assert_equal(_W(1000) * _W(2900/3000))
    etk.balance_of("LP2").assert_equal(_W(2000) * _W(2900/3000))
    etk.total_supply().assert_equal(_W(2900))

    # Finally, down to zero adjustment (almost zero, zero not allowed)
    with etk.thru_policy_pool():
        etk.discrete_earning(-etk.total_supply() * _W("0.99999"))
    etk.total_supply().assert_equal(_W(0), decimals=1)


def test_name_and_others(tenv):
    etk = tenv.etoken_class(name="eUSD One Week", symbol="eUSD1W", expiration_period=WEEK)
    assert etk.name == "eUSD One Week"
    assert etk.symbol == "eUSD1W"
    assert etk.decimals == 18


@skip_if_coverage_activated
def test_max_utilization_rate(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK, max_utilization_rate=_R("0.9"))
    assert etk.max_utilization_rate == _R("0.9")
    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(1000))
    assert etk.ocean == _W(1000)
    assert etk.ocean_for_new_scr == _W(900)

    with etk.as_("owner"):
        etk.grant_role("LEVEL2_ROLE", "SETRATE")
    with etk.as_("SETRATE"):
        etk.set_max_utilization_rate(_R("0.95"))

    assert etk.ocean_for_new_scr == _W(950)

    policy = tenv.policy_factory(scr=_W(1100), interest_rate=_R("0.04"),
                                expiration=tenv.time_control.now + WEEK)
                                
    with pytest.raises(RevertError, match="Not enought OCEAN to cover the SCR"):
        with etk.thru_policy_pool():
            etk.lock_scr(policy, policy.scr)

    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    with etk.thru_policy_pool():
        etk.lock_scr(policy, policy.scr)

    etk.utilization_rate.assert_equal(_R("0.6"))
    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(1000))
    
    etk.utilization_rate.assert_equal(_R("0.3"))

    expected_balance = _W(2000) - _W("600") * _W("1.0365")
    with etk.thru_policy_pool():
        etk.withdraw("LP1", _W(1400)).assert_equal(expected_balance)



def test_unlock_scr(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.ocean == _W(1000)
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    with etk.thru_policy_pool():
        etk.lock_scr(policy, policy.scr)
    assert etk.scr == _W(600)
    assert etk.scr_interest_rate == _R("0.0365")
    etk.token_interest_rate.assert_equal(_R("0.0365") * _R(600/1000))
    etk.ocean.assert_equal(_W(400))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))
    tenv.time_control.fast_forward(3 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(5))

    with etk.thru_policy_pool():
        etk.unlock_scr(policy, policy.scr)


def test_getset_etk_parameters_tweaks(tenv):
    if tenv.kind != "ethereum":
        return
    etk = tenv.etoken_class(
        name="eUSD1WEEK", expiration_period=WEEK, max_utilization_rate=_R("0.9"),
        liquidity_requirement=_R(1), pool_loan_interest_rate=_R("0.02")
    )
    with etk.as_("owner"):
        etk.grant_role("LEVEL2_ROLE", "L2_USER")
        etk.grant_role("LEVEL3_ROLE", "L3_USER")

    # Verifies hard-coded validations
    test_validations = [
        ("liquidity_requirement", _R("0.7")),  # [0.8, 1.3]
        ("liquidity_requirement", _R("1.4")),  # [0.8, 1.3]
        ("max_utilization_rate", _R(1.01)),  # <= [0.5, 1]
        ("max_utilization_rate", _R(0.3)),  # <= [0.5, 1]
        ("pool_loan_interest_rate", _R("0.6")),  # <=50%
    ]

    for attr_name, attr_value in test_validations:
        with etk.as_("L2_USER"), pytest.raises(RevertError, match="Validation: "):
            setattr(etk, attr_name, attr_value)

    # Verifies exceeded tweaks
    test_exceeded_tweaks = [
        ("liquidity_requirement", _R("0.6")),  # 10% allowed - previous 100%
        ("liquidity_requirement", _R("1.5")),  # 10% allowed - previous 100%
        ("max_utilization_rate", _R("0.4")),  # 30% allowed - previous 90%
        ("pool_loan_interest_rate", _R("0.04")),  # 30% allowed - previous 2%
    ]

    for attr_name, attr_value in test_exceeded_tweaks:
        with etk.as_("L3_USER"), pytest.raises(RevertError, match="Tweak exceeded: "):
            setattr(etk, attr_name, attr_value)

    # Verifies OK tweaks
    test_ok_tweaks = [
        ("liquidity_requirement", _R("1.09")),  # 10% allowed - previous 100%
        ("max_utilization_rate", _R("0.8")),  # 30% allowed - previous 90%
        ("pool_loan_interest_rate", _R("0.025")),  # 30% allowed - previous 2%
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with etk.as_("L3_USER"):
            setattr(etk, attr_name, attr_value)
        assert getattr(etk, attr_name) == attr_value

    # Verifies L2_USER changes
    test_ok_l2_changes = [
        ("liquidity_requirement", _R("0.8")),  # previous 109%
        ("max_utilization_rate", _R("0.51")),  # previous 80%
        ("pool_loan_interest_rate", _R("0.07")),  # previous 2.5%
        ("accept_all_rms", False),  # previous True
        ("accept_all_rms", True),  # previous False
    ]

    for attr_name, attr_value in test_ok_l2_changes:
        with etk.as_("L2_USER"):
            setattr(etk, attr_name, attr_value)
        assert getattr(etk, attr_name) == attr_value

    assert not etk.is_accept_exception("FOORM")
    with etk.as_("L2_USER"):
        etk.set_accept_exception("FOORM", True)
    assert etk.is_accept_exception("FOORM")
    assert not etk.is_accept_exception("BARRM")

    tenv.time_control.fast_forward(WEEK)  # To avoid repeated tweaks

    # New OK tweaks
    test_ok_tweaks = [
        ("liquidity_requirement", _R("0.87")),  # previous 80%
        ("max_utilization_rate", _R("0.6")),  # previous 51%
        ("pool_loan_interest_rate", _R("0.06")),  # previous 7%
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with etk.as_("L3_USER"):
            setattr(etk, attr_name, attr_value)
        assert getattr(etk, attr_name) == attr_value

    # Other tweaks
    test_ok_tweaks = [
        ("liquidity_requirement", _R("0.9")),  # previous 87%
        ("max_utilization_rate", _R("0.66")),  # previous 60%
        ("pool_loan_interest_rate", _R("0.05")),  # previous 6%
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with etk.as_("L3_USER"), pytest.raises(RevertError,
                                               match="You already tweaked this parameter recently"):
            setattr(etk, attr_name, attr_value)

    tenv.time_control.fast_forward(2 * DAY)  # Tweaks expired

    for attr_name, attr_value in test_ok_tweaks:
        with etk.as_("L3_USER"):
            setattr(etk, attr_name, attr_value)
        assert getattr(etk, attr_name) == attr_value
