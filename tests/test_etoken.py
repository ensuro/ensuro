"""Unitary tests for eToken contract"""

from collections import namedtuple
import pytest
from prototype.contracts import RevertError
from prototype import ensuro
from prototype.wadray import _W, _R
from prototype.utils import WEEK, DAY


TEnv = namedtuple("TEnv", "time_control etoken_class policy_factory")


@pytest.fixture(params=["prototype"])
def tenv(request):
    if request.param == "prototype":
        FakePolicy = namedtuple("FakePolicy", "mcr interest_rate expiration")

        return TEnv(
            time_control=ensuro.time_control,
            policy_factory=FakePolicy,
            etoken_class=ensuro.EToken
        )


def test_deposit_withdraw(tenv):
    etk = tenv.etoken_class(owner="Me", name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.balance_of("LP1") == _W(1000)
    assert etk.ocean == _W(1000)
    tenv.time_control.fast_forward(DAY)
    assert etk.balance_of("LP1") == _W(1000)  # unchanged because MCR=0
    assert etk.withdraw("LP1", _W(600)) == _W(600)
    assert etk.balance_of("LP1") == _W(400)
    assert etk.withdraw("LP1", None) == _W(400)
    assert etk.balance_of("LP1") == _W(0)


def test_lock_unlock_mcr(tenv):
    etk = tenv.etoken_class(owner="Me", name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.ocean == _W(1000)
    policy = tenv.policy_factory(mcr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    etk.lock_mcr(policy, policy.mcr)
    assert etk.mcr == _W(600)
    assert etk.ocean == _W(400)

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))
    tenv.time_control.fast_forward(3 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(5))

    etk.unlock_mcr(policy, policy.mcr)
    tenv.time_control.fast_forward(10 * DAY)
    expected_balance = _W(1000) + _W("0.06") * _W(5)
    etk.balance_of("LP1").assert_equal(expected_balance)

    assert etk.withdraw("LP1", None) == expected_balance


def test_multiple_policies(tenv):
    etk = tenv.etoken_class(owner="Me", name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)

    policy1 = tenv.policy_factory(mcr=_W(300), interest_rate=_R("0.0365"),
                                  expiration=tenv.time_control.now + WEEK)
    etk.lock_mcr(policy1, policy1.mcr)
    assert etk.mcr_interest_rate == _R("0.0365")
    assert etk.mcr == _W(300)
    assert etk.ocean == _W(700)

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.03") * _W(2))

    # Create 2nd policy twice interest twice MCR
    policy2 = tenv.policy_factory(mcr=_W(600), interest_rate=_R("0.0730"),
                                  expiration=tenv.time_control.now + WEEK)
    etk.lock_mcr(policy2, policy2.mcr)
    etk.mcr_interest_rate.assert_equal(
        (_R("0.0365") * _R(300) + _R("0.0730") * _R(600)) // _R(900)
    )

    assert etk.mcr == _W(900)
    etk.ocean.assert_equal(_W(100) + _W("0.03") * _W(2))

    tenv.time_control.fast_forward(3 * DAY)

    expected_balance = _W(1000) + _W("0.03") * _W(5) + _W("0.12") * _W(3)
    etk.balance_of("LP1").assert_equal(expected_balance)

    etk.unlock_mcr(policy1, policy1.mcr)
    etk.mcr_interest_rate.assert_equal(_R("0.0730"))
    assert etk.mcr == _W(600)
    etk.balance_of("LP1").assert_equal(expected_balance)
    etk.unlock_mcr(policy2, policy2.mcr)
    assert etk.mcr == _W(0)
    etk.total_supply().assert_equal(expected_balance)


def test_multiple_lps(tenv):
    etk = tenv.etoken_class(owner="Me", name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.ocean == _W(1000)
    policy = tenv.policy_factory(mcr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    etk.lock_mcr(policy, policy.mcr)
    assert etk.mcr == _W(600)
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

    etk.unlock_mcr(policy, policy.mcr)
    etk.withdraw("LP2", None).assert_equal(lp2_balance + _W("0.06"))


def test_lock_mcr_validation(tenv):
    etk = tenv.etoken_class(owner="Me", name="eUSD1WEEK", expiration_period=WEEK)
    policy = tenv.policy_factory(mcr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)

    with pytest.raises(RevertError, match="Not enought OCEAN to cover the MCR"):
        etk.lock_mcr(policy, policy.mcr)

    etk.deposit("LP1", _W(200))

    with pytest.raises(RevertError, match="Not enought OCEAN to cover the MCR"):
        etk.lock_mcr(policy, policy.mcr)


def test_accepts_policy(tenv):
    etk_week = tenv.etoken_class(owner="Me", name="eUSD1WEEK", expiration_period=WEEK)
    etk_year = tenv.etoken_class(owner="Me", name="eUSD1YEAR", expiration_period=365 * DAY)
    etk_week.deposit("LP1", _W(1000))
    etk_year.deposit("LP1", _W(2000))

    policy_3_day = tenv.policy_factory(mcr=_W(600), interest_rate=_R("0.0365"),
                                       expiration=tenv.time_control.now + 3 * DAY)
    policy_10_day = tenv.policy_factory(mcr=_W(600), interest_rate=_R("0.0365"),
                                        expiration=tenv.time_control.now + 10 * DAY)

    assert etk_week.accepts(policy_3_day)
    assert etk_year.accepts(policy_3_day)
    assert not etk_week.accepts(policy_10_day)
    assert etk_year.accepts(policy_10_day)
