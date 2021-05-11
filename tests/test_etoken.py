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
        FakePolicy = namedtuple("FakePolicy", "mcr interest_rate expiration")

        return TEnv(
            time_control=ensuro.time_control,
            policy_factory=FakePolicy,
            etoken_class=ensuro.EToken
        )
    elif request.param == "ethereum":
        FakePolicy = namedtuple("FakePolicy", "mcr interest_rate expiration")

        return TEnv(
            time_control=time_control,
            policy_factory=FakePolicy,
            etoken_class=partial(ETokenETH, protocol="ensuro", symbol="ETK")
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
    assert etk.mcr_interest_rate == _R("0.0365")
    etk.token_interest_rate.assert_equal(_R("0.0365") * _R(600/1000))
    etk.ocean.assert_equal(_W(400))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))
    tenv.time_control.fast_forward(3 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(5))

    etk.unlock_mcr(policy, policy.mcr)
    tenv.time_control.fast_forward(10 * DAY)
    expected_balance = _W(1000) + _W("0.06") * _W(5)
    etk.balance_of("LP1").assert_equal(expected_balance)
    etk.transfer("LP1", "LP2", expected_balance)

    etk.withdraw("LP2", None).assert_equal(expected_balance)
    etk.balance_of("LP1").assert_equal(_W(0))


def test_etoken_erc20(tenv):
    etk = tenv.etoken_class(owner="Me", name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)
    policy = tenv.policy_factory(mcr=_W(600), interest_rate=_R("0.0365"),
                                 expiration=tenv.time_control.now + WEEK)
    etk.lock_mcr(policy, policy.mcr)
    tenv.time_control.fast_forward(2 * DAY)
    expected_balance = _W(1000) + _W("0.06") * _W(2)
    etk.balance_of("LP1").assert_equal(expected_balance)
    etk.approve("LP1", "SPEND", expected_balance // _W(2))

    with pytest.raises(RevertError, match="allowance"):
        etk.transfer_from("SPEND", "LP1", "LP2", expected_balance)
    etk.transfer_from("SPEND", "LP1", "LP2", expected_balance // _W(2))
    etk.allowance("LP1", "SPEND").assert_equal(_W(0))
    etk.balance_of("LP1").assert_equal(expected_balance // _W(2))
    etk.balance_of("LP2").assert_equal(expected_balance // _W(2))

    etk.withdraw("LP2", _W(100)).assert_equal(_W(100))

    total_withdrawable = _W(1000) + _W("0.06") * _W(2) - policy.mcr * _W("1.0365") - _W(100)
    etk.total_withdrawable().assert_equal(total_withdrawable)

    # Max to withdraw is total_withdrawable
    etk.withdraw("LP1", _W(5000)).assert_equal(total_withdrawable)
    etk.unlock_mcr(policy, policy.mcr)
    # now max to withdraw is LP balance
    etk.withdraw("LP1", _W(5000)).assert_equal(expected_balance // _W(2) - total_withdrawable)
    etk.balance_of("LP2").assert_equal(expected_balance // _W(2) - _W(100))
    etk.withdraw("LP2", None).assert_equal(expected_balance // _W(2) - _W(100))


def test_multiple_policies(tenv):
    etk = tenv.etoken_class(owner="Me", name="eUSD1WEEK", expiration_period=WEEK)
    assert etk.deposit("LP1", _W(1000)) == _W(1000)

    policy1 = tenv.policy_factory(mcr=_W(300), interest_rate=_R("0.0365"),
                                  expiration=tenv.time_control.now + WEEK)
    etk.lock_mcr(policy1, policy1.mcr)
    assert etk.mcr_interest_rate == _R("0.0365")
    assert etk.mcr == _W(300)
    etk.ocean.assert_equal(_W(700))

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
    assert etk.mcr == policy2.mcr
    etk.balance_of("LP1").assert_equal(expected_balance)
    with pytest.raises(RevertError):
        etk.unlock_mcr(policy2, policy2.mcr + _W(1))  # Can't unlock more than MCR
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


def test_protocol_loan(tenv):
    etk = tenv.etoken_class(owner="Me", name="eUSD1WEEK", expiration_period=WEEK,
                            protocol_loan_interest_rate=_R("0.073"))
    etk.deposit("LP1", _W(1000))
    assert etk.protocol_loan_interest_rate == _R("0.073")

    policy = tenv.policy_factory(mcr=_W(600), interest_rate=_R("0.04"),
                                 expiration=tenv.time_control.now + WEEK)
    etk.lock_mcr(policy, policy.mcr)
    tenv.time_control.fast_forward(7 * DAY)
    etk.ocean.assert_equal(_W(400) + _W(600 * 0.04 * 7 / 365))

    with pytest.raises(RevertError):
        etk.lend_to_protocol(_W(401))  # Can't lend more than ocean

    etk.lend_to_protocol(_W(300))
    etk.get_protocol_loan().assert_equal(_W(300))
    tenv.time_control.fast_forward(7 * DAY)

    # After 7 days increases at a rate of 7.3%/year (0.02% per day)
    etk.get_protocol_loan().assert_equal(_W(300) * _W(1 + 0.0002 * 7))

    tenv.time_control.fast_forward(1 * DAY)
    etk.set_protocol_loan_interest_rate(_R("0.0365"))
    assert etk.protocol_loan_interest_rate == _R("0.0365")
    protocol_loan = _W(300) * _W(1 + 0.0002 * 8)
    etk.get_protocol_loan().assert_equal(protocol_loan)

    tenv.time_control.fast_forward(3 * DAY)
    etk.get_protocol_loan().assert_equal(protocol_loan + protocol_loan * _W(0.0001 * 3))
    protocol_loan = protocol_loan + protocol_loan * _W(0.0001 * 3)

    etk.repay_protocol_loan(protocol_loan // _W(3))
    etk.get_protocol_loan().assert_equal(protocol_loan * _W(2/3))
    etk.repay_protocol_loan(protocol_loan * _W(2/3))
    etk.get_protocol_loan().assert_equal(_W(0))
