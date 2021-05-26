"""Unitary tests for eToken contract"""

from functools import partial
from collections import namedtuple
import pytest
from prototype.contracts import RevertError, Contract, IntField, ERC20Token, ContractProxyField
from prototype import ensuro
from prototype.wadray import _W, _R
from .wrappers import TrustfulRiskModule, time_control, TestCurrency
from prototype.utils import WEEK

TEnv = namedtuple("TEnv", "time_control currency rm_class policy_factory")


@pytest.fixture(params=["ethereum", "prototype"])
def tenv(request):
    if request.param == "prototype":
        FakePolicy = namedtuple("FakePolicy", "scr interest_rate expiration")
        currency = ERC20Token(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(1000))

        class PolicyPoolMock(Contract):
            currency = ContractProxyField()
            policy_count = IntField(default=0)

            def new_policy(self, policy, customer):
                self.policy_count += 1
                return self.policy_count

        return TEnv(
            currency=currency,
            time_control=ensuro.time_control,
            policy_factory=FakePolicy,
            rm_class=partial(ensuro.RiskModule, policy_pool=PolicyPoolMock(currency=currency))
        )
    elif request.param == "ethereum":
        FakePolicy = namedtuple("FakePolicy", "scr interest_rate expiration")
        from brownie import PolicyPoolMock

        currency = TestCurrency(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(1000))

        pool = PolicyPoolMock.deploy(currency.contract, {"from": currency.owner})

        return TEnv(
            currency=currency,
            time_control=time_control,
            policy_factory=FakePolicy,
            rm_class=partial(TrustfulRiskModule, policy_pool=pool)
        )


def test_getset_rm_parameters(tenv):
    rm = tenv.rm_class(
        name="Roulette", scr_percentage=_R(1), premium_share=_R("0.10"), ensuro_share=_R("0.03"),
        max_scr_per_policy=_W(1000), scr_limit=_W(1000000),
        wallet="CASINO", shared_coverage_min_percentage=_R("0.5")
    )
    assert rm.name == "Roulette"
    assert rm.scr_percentage == _R(1)
    rm.premium_share.assert_equal(_R(1/10))
    rm.ensuro_share.assert_equal(_R(3/100))
    assert rm.max_scr_per_policy == _W(1000)
    assert rm.scr_limit == _W(1000000)
    assert rm.wallet == "CASINO"
    rm.shared_coverage_min_percentage.assert_equal(_R(1/2))
    rm.shared_coverage_percentage.assert_equal(_R(1/2))

    rm.grant_role("RM_PROVIDER_ROLE", "CASINO")  # Grant the role to the casino owner
    rm.grant_role("ENSURO_DAO_ROLE", "ENSURO_DAO")  # Grant the role to the casino owner

    users = ("CASINO", "ENSURO_DAO", "JOHNDOE")

    test_attributes = [
        ("scr_percentage", "ENSURO_DAO", _R(0.8)),
        ("premium_share", "ENSURO_DAO", _R(15/100)),
        ("ensuro_share", "ENSURO_DAO", _R(4/100)),
        ("max_scr_per_policy", "ENSURO_DAO", _W(2000)),
        ("scr_limit", "ENSURO_DAO", _W(10000000)),
        ("wallet", "CASINO", "CASINO_POCKET"),
        ("shared_coverage_min_percentage", "ENSURO_DAO", _R("0.3")),
        ("shared_coverage_percentage", "CASINO", _R("0.35")),
    ]

    for attr_name, authorized_user, new_value in test_attributes:
        non_auth_users = [u for u in users if u != authorized_user]
        old_value = getattr(rm, attr_name)
        assert old_value != new_value
        for user in non_auth_users:
            with pytest.raises(RevertError, match="AccessControl"), rm.as_(user):
                setattr(rm, attr_name, new_value)

        with rm.as_(authorized_user):
            setattr(rm, attr_name, new_value)

        assert getattr(rm, attr_name) == new_value

    with rm.as_("CASINO"), pytest.raises(RevertError, match="less than minimum"):
        rm.shared_coverage_percentage = _R("0.25")  # Should be reverted because < 0.3 min_percentage

    with rm.as_("CASINO"):
        rm.shared_coverage_percentage = _R("0.45")

    rm.shared_coverage_percentage == _R("0.45")
    rm.shared_coverage_min_percentage == _R("0.3")


def test_new_policy(tenv):
    rm = tenv.rm_class(
        name="Roulette", scr_percentage=_R(1), premium_share=_R("0.10"), ensuro_share=_R("0.03"),
        max_scr_per_policy=_W(1000), scr_limit=_W(1000000),
        wallet="CASINO", shared_coverage_min_percentage=_R("0.6")
    )
    assert rm.name == "Roulette"
    tenv.currency.transfer(tenv.currency.owner, "CUST1", _W(1))
    tenv.currency.approve("CUST1", rm.policy_pool, _W(1))
    assert tenv.currency.allowance("CUST1", rm.policy_pool) == _W(1)
    expiration = tenv.time_control.now + WEEK
    policy = rm.new_policy(_W(36), _W(1), _R(1/37), expiration, "CUST1")

    policy.premium.assert_equal(_W(1))
    policy.payout.assert_equal(_W(36))
    policy.loss_prob.assert_equal(_R(1/37))
    policy.rm_coverage.assert_equal(_W(36 * .6))
    policy.scr.assert_equal(_W(35 * .4))
    assert policy.expiration == expiration
    assert (time_control.now - policy.start) < 60  # Must be now, giving 60 seconds tolerance
    policy.pure_premium.assert_equal(_W(36 * .4 * 1/37))
    profit_premium = _W(1 * .4) - policy.pure_premium
    policy.premium_for_ensuro.assert_equal(profit_premium * _W("0.03"))
    policy.premium_for_rm.assert_equal(profit_premium * _W("0.10") + _W(1 * .6))
    policy.premium_for_lps.assert_equal(profit_premium * _W(1 - 0.13))
    policy.interest_rate.assert_equal(policy.premium_for_lps.to_ray() * _R(365/7) // policy.scr.to_ray())
