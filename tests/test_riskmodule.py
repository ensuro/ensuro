"""Unitary tests for eToken contract"""

from functools import partial
from collections import namedtuple
import pytest
from prototype.contracts import RevertError
from prototype import ensuro
from prototype.wadray import _W, _R
from .wrappers import TrustfulRiskModule, time_control

TEnv = namedtuple("TEnv", "time_control rm_class policy_factory")


@pytest.fixture(params=["ethereum", "prototype"])
def tenv(request):
    if request.param == "prototype":
        FakePolicy = namedtuple("FakePolicy", "scr interest_rate expiration")

        return TEnv(
            time_control=ensuro.time_control,
            policy_factory=FakePolicy,
            rm_class=ensuro.RiskModule
        )
    elif request.param == "ethereum":
        FakePolicy = namedtuple("FakePolicy", "scr interest_rate expiration")

        return TEnv(
            time_control=time_control,
            policy_factory=FakePolicy,
            rm_class=partial(TrustfulRiskModule, ensuro="ensuro", owner="Me")
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

    with pytest.raises(RevertError, match="AccessControl"):
        rm.shared_coverage_percentage = _R(2/3)
    with rm.as_("CASINO"):
        rm.shared_coverage_percentage = _R(2/3)

    rm.shared_coverage_percentage.assert_equal(_R(2/3))
