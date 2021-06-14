"""Unitary tests for eToken contract"""

from functools import partial
from collections import namedtuple
import pytest
from prototype.contracts import RevertError
from prototype import ensuro
from prototype.wadray import _W, _R
from prototype.utils import WEEK, DAY
from .wrappers import ETokenETH, time_control

TEnv = namedtuple("TEnv", "time_control etoken_class policy_factory")


@pytest.fixture(params=["prototype", "ethereum"])
def tenv(request):
    if request.param == "prototype":
        FakePolicy = namedtuple("FakePolicy", "scr interest_rate expiration")

        return TEnv(
            time_control=ensuro.time_control,
            policy_factory=FakePolicy,
            etoken_class=partial(ensuro.EToken, policy_pool="required-not-used")
        )
    elif request.param == "ethereum":
        FakePolicy = namedtuple("FakePolicy", "scr interest_rate expiration")

        return TEnv(
            time_control=time_control,
            policy_factory=FakePolicy,
            etoken_class=partial(ETokenETH, policy_pool="ensuro", symbol="ETK")
        )


def test_deposit_withdraw(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.balance_of("LP1") == _W(1000)
    assert etk.ocean == _W(1000)
    tenv.time_control.fast_forward(DAY)
    assert etk.balance_of("LP1") == _W(1000)  # unchanged because SCR=0
    assert etk.withdraw("LP1", _W(600)) == _W(600)
    assert etk.balance_of("LP1") == _W(400)
    assert etk.withdraw("LP1", None) == _W(400)
    assert etk.balance_of("LP1") == _W(0)
    assert etk.withdraw("LP1", None) == _W(0)


def test_lock_unlock_scr(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.ocean == _W(1000)
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    etk.lock_scr(policy, policy.scr)
    assert etk.scr == _W(600)
    assert etk.scr_interest_rate == _R("0.0365")
    etk.token_interest_rate.assert_equal(_R("0.0365") * _R(600/1000))
    etk.ocean.assert_equal(_W(400))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))
    tenv.time_control.fast_forward(3 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(5))

    etk.unlock_scr(policy, policy.scr)
    tenv.time_control.fast_forward(10 * DAY)
    expected_balance = _W(1000) + _W("0.06") * _W(5)
    etk.balance_of("LP1").assert_equal(expected_balance)
    etk.transfer("LP1", "LP2", expected_balance)

    etk.withdraw("LP2", None).assert_equal(expected_balance)
    etk.balance_of("LP1").assert_equal(_W(0))


def test_etoken_erc20(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
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

    etk.withdraw("LP2", _W(100)).assert_equal(_W(100))

    total_withdrawable = _W(1000) + _W("0.06") * _W(2) - policy.scr * _W("1.0365") - _W(100)
    etk.total_withdrawable().assert_equal(total_withdrawable)

    # Max to withdraw is total_withdrawable
    etk.withdraw("LP1", _W(5000)).assert_equal(total_withdrawable)
    etk.unlock_scr(policy, policy.scr)
    # now max to withdraw is LP balance
    etk.withdraw("LP1", _W(5000)).assert_equal(expected_balance // _W(2) - total_withdrawable)
    etk.balance_of("LP2").assert_equal(expected_balance // _W(2) - _W(100))
    etk.withdraw("LP2", None).assert_equal(expected_balance // _W(2) - _W(100))


def test_multiple_policies(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)

    policy1 = tenv.policy_factory(scr=_W(300), interest_rate=_R("0.0365"),
                                  expiration=tenv.time_control.now + WEEK)
    etk.lock_scr(policy1, policy1.scr)
    assert etk.scr_interest_rate == _R("0.0365")
    assert etk.scr == _W(300)
    etk.ocean.assert_equal(_W(700))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.03") * _W(2))

    # Create 2nd policy twice interest twice SCR
    policy2 = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0730"),
                                  expiration=tenv.time_control.now + WEEK)
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
    etk.lock_scr(policy3, policy3.scr)
    etk.total_withdrawable().assert_equal(_W(0))
    etk.unlock_scr(policy3, policy3.scr)

    etk.unlock_scr(policy1, policy1.scr)
    etk.scr_interest_rate.assert_equal(_R("0.0730"))
    assert etk.scr == policy2.scr
    etk.balance_of("LP1").assert_equal(expected_balance)
    with pytest.raises(RevertError):
        etk.unlock_scr(policy2, policy2.scr + _W(1))  # Can't unlock more than SCR
    etk.unlock_scr(policy2, policy2.scr)
    assert etk.scr == _W(0)
    etk.total_supply().assert_equal(expected_balance)


def test_multiple_lps(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.ocean == _W(1000)
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    etk.lock_scr(policy, policy.scr)
    assert etk.scr == _W(600)
    assert etk.ocean == _W(400)

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))

    etk.deposit("LP2", _W(2000)).assert_equal(_W(2000))
    tenv.time_control.fast_forward(3 * DAY)

    lp1_balance = _W(1000) + _W("0.06") * _W(2) + _W("0.06") * _W(3) * _W(1/3)
    etk.balance_of("LP1").assert_equal(lp1_balance)
    lp2_balance = _W(2000) + _W("0.06") * _W(3) * _W(2/3)
    etk.balance_of("LP2").assert_equal(lp2_balance)
    etk.withdraw("LP1", None).assert_equal(lp1_balance)

    tenv.time_control.fast_forward(1 * DAY)
    etk.balance_of("LP2").assert_equal(lp2_balance + _W("0.06"))

    etk.unlock_scr(policy, policy.scr)
    etk.withdraw("LP2", None).assert_equal(lp2_balance + _W("0.06"))


def test_lock_scr_validation(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)

    with pytest.raises(RevertError, match="Not enought OCEAN to cover the SCR"):
        etk.lock_scr(policy, policy.scr)

    etk.deposit("LP1", _W(200))

    with pytest.raises(RevertError, match="Not enought OCEAN to cover the SCR"):
        etk.lock_scr(policy, policy.scr)


def test_accepts_policy(tenv):
    etk_week = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)
    etk_year = tenv.etoken_class(name="eUSD1YEAR", expiration_period=365 * DAY)
    etk_week.deposit("LP1", _W(1000))
    etk_year.deposit("LP1", _W(2000))

    policy_3_day = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                       expiration=tenv.time_control.now + 3 * DAY)
    policy_10_day = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.0365"),
                                        expiration=tenv.time_control.now + 10 * DAY)

    assert etk_week.accepts(policy_3_day)
    assert etk_year.accepts(policy_3_day)
    assert not etk_week.accepts(policy_10_day)
    assert etk_year.accepts(policy_10_day)


def test_pool_loan(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK,
                            pool_loan_interest_rate=_R("0.073"))
    etk.deposit("LP1", _W(1000))
    assert etk.pool_loan_interest_rate == _R("0.073")
    assert etk.get_pool_loan() == _W(0)

    policy = tenv.policy_factory(scr=_W(600), interest_rate=_R("0.04"),
                                 expiration=tenv.time_control.now + WEEK)
    etk.lock_scr(policy, policy.scr)
    tenv.time_control.fast_forward(7 * DAY)
    etk.ocean.assert_equal(_W(400) + _W(600 * 0.04 * 7 / 365))

    with pytest.raises(RevertError):
        etk.lend_to_pool(_W(401))  # Can't lend more than ocean

    etk.lend_to_pool(_W(300))
    etk.get_pool_loan().assert_equal(_W(300))
    tenv.time_control.fast_forward(7 * DAY)

    # After 7 days increases at a rate of 7.3%/year (0.02% per day)
    etk.get_pool_loan().assert_equal(_W(300) * _W(1 + 0.0002 * 7))
    etk.lend_to_pool(_W(100))
    etk.get_investable().assert_equal(etk.ocean + etk.scr + etk.get_pool_loan())

    tenv.time_control.fast_forward(1 * DAY)

    with etk.as_("owner"):
        etk.grant_role("SET_LOAN_RATE_ROLE", "SETRATE")
    with etk.as_("SETRATE"):
        etk.set_pool_loan_interest_rate(_R("0.0365"))

    assert etk.pool_loan_interest_rate == _R("0.0365")
    pool_loan = _W(400) + _W(300) * _W(0.0002 * 8) + _W(100) * _W(0.0002)
    etk.get_pool_loan().assert_equal(pool_loan)

    tenv.time_control.fast_forward(3 * DAY)
    etk.get_pool_loan().assert_equal(pool_loan * _W(1 + 0.0001 * 3))
    pool_loan = pool_loan * _W(1 + 0.0001 * 3)

    etk.repay_pool_loan(pool_loan // _W(3))
    etk.get_pool_loan().assert_equal(pool_loan * _W(2/3))
    etk.repay_pool_loan(pool_loan * _W(2/3))
    etk.get_pool_loan().assert_equal(_W(0))


def test_asset_and_discrete_earnings(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", expiration_period=WEEK)

    # Initial setup
    etk.deposit("LP1", _W(1000))
    etk.deposit("LP2", _W(2000))
    assert etk.total_supply() == _W(3000)
    assert etk.get_current_scale(True) == _R(1)

    # Possitive asset earning
    etk.discrete_earning(_W(500))   # TODO: etk.asset_earnings(_W(500)) called from assetManager
    etk.total_supply().assert_equal(_W(3500))
    etk.get_current_scale(False).assert_equal(_R(1) * _R(3500/3000))
    etk.get_current_scale(True).assert_equal(_R(1) * _R(3500/3000))

    # Negative asset earning
    etk.discrete_earning(-_W(300))    # TODO: etk.asset_earnings(-_W(300)) called from assetManager
    etk.total_supply().assert_equal(_W(3200))
    etk.get_current_scale(False).assert_equal(_R(1) * _R(3200/3000))
    tenv.time_control.fast_forward(1 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) * _W(3200/3000))
    etk.balance_of("LP2").assert_equal(_W(2000) * _W(3200/3000))

    # Possitive discrete_earning
    etk.discrete_earning(_W(400))
    etk.balance_of("LP1").assert_equal(_W(1000) * _W(3600/3000))
    etk.balance_of("LP2").assert_equal(_W(2000) * _W(3600/3000))
    etk.total_supply().assert_equal(_W(3600))

    # Negative discrete_earning
    etk.discrete_earning(-_W(700))
    etk.balance_of("LP1").assert_equal(_W(1000) * _W(2900/3000))
    etk.balance_of("LP2").assert_equal(_W(2000) * _W(2900/3000))
    etk.total_supply().assert_equal(_W(2900))

    # Finally, down to zero adjustment
    etk.discrete_earning(-etk.total_supply())
    etk.total_supply().assert_equal(_W(0))


def test_name_and_others(tenv):
    etk = tenv.etoken_class(name="eUSD One Week", symbol="eUSD1W", expiration_period=WEEK)
    assert etk.name == "eUSD One Week"
    assert etk.symbol == "eUSD1W"
    assert etk.decimals == 18
