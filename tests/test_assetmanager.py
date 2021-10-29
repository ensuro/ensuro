"""Unitary tests for eToken contract"""

from functools import partial
from collections import namedtuple
import pytest
from ethproto.contracts import RevertError
from prototype import ensuro
from ethproto.wadray import _W
from prototype.utils import WEEK, DAY
from prototype.wrappers import TestCurrency, PolicyPoolConfig, get_provider
from prototype import wrappers

TEnv = namedtuple("TEnv", "time_control build_asset_manager kind")


@pytest.fixture(params=["prototype", "ethereum"])
def tenv(request):
    if request.param == "prototype":

        def build_asset_manager(asm_class, **kwargs):
            cls = getattr(ensuro, asm_class)
            cls = partial(cls, pool="required-not-used")
            return cls(**kwargs)

        return TEnv(
            time_control=ensuro.time_control,
            build_asset_manager=build_asset_manager,
            kind="prototype"
        )
    elif request.param == "ethereum":
        PolicyPoolMockForward = get_provider().get_contract_factory("PolicyPoolMockForward")

        currency = TestCurrency(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(1000))

        def build_asset_manager(asm_class, **kwargs):
            cls = getattr(wrappers, asm_class)
            config = PolicyPoolConfig(owner="owner")
            pool = PolicyPoolMockForward.deploy(
                wrappers.AddressBook.ZERO, currency.contract, config.contract, {"from": currency.owner}
            )
            obj = cls(pool=pool, owner="owner", **kwargs)
            pool.setForwardTo(obj.contract, {"from": currency.owner})
            config.grant_role("LEVEL1_ROLE", "owner")
            config.set_asset_manager(obj)
            return obj

        return TEnv(
            time_control=get_provider().time_control,
            build_asset_manager=build_asset_manager,
            kind="ethereum"
        )


def test_getset_asm_parameters_tweaks(tenv):
    if tenv.kind != "ethereum":
        return
    asm = tenv.build_asset_manager(
        asm_class="FixedRateAssetManager",
        liquidity_min=_W(20),
        liquidity_middle=_W(50),
        liquidity_max=_W(100),
    )
    with asm.as_("owner"):
        asm.grant_role("LEVEL2_ROLE", "L2_USER")
        asm.grant_role("LEVEL3_ROLE", "L3_USER")

    # Verifies hard-coded validations
    test_validations = [
        ("liquidity_min", _W(60)),
        ("liquidity_min", _W(110)),
        ("liquidity_middle", _W(10)),
        ("liquidity_middle", _W(110)),
        ("liquidity_max", _W(40)),
    ]

    for attr_name, attr_value in test_validations:
        with asm.as_("L2_USER"), pytest.raises(RevertError, match="Validation: "):
            setattr(asm, attr_name, attr_value)
    return
    # Verifies exceeded tweaks
    test_exceeded_tweaks = [
        ("liquidity_min", _W(10)),  # 30% allowed - previous 20
        ("liquidity_middle", _W(90)),  # 30% allowed - previous 50
        ("liquidity_max", _W(150)),  # 30% allowed - previous 100
    ]

    for attr_name, attr_value in test_exceeded_tweaks:
        with asm.as_("L3_USER"), pytest.raises(RevertError, match="Tweak exceeded: "):
            setattr(asm, attr_name, attr_value)

    # Verifies OK tweaks
    test_ok_tweaks = [
        ("liquidity_min", _W(25)),  # 30% allowed - previous 20
        ("liquidity_middle", _W(55)),  # 30% allowed - previous 50
        ("liquidity_max", _W(90)),  # 30% allowed - previous 100
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with asm.as_("L3_USER"):
            setattr(asm, attr_name, attr_value)
        assert getattr(asm, attr_name) == attr_value

    # Verifies L2_USER changes
    test_ok_l2_changes = [
        ("liquidity_min", _W(10)),  # 30% allowed - previous 25
        ("liquidity_middle", _W(80)),  # 30% allowed - previous 55
        ("liquidity_max", _W(200)),  # 30% allowed - previous 90
    ]

    for attr_name, attr_value in test_ok_l2_changes:
        with asm.as_("L2_USER"):
            setattr(asm, attr_name, attr_value)
        assert getattr(asm, attr_name) == attr_value

    tenv.time_control.fast_forward(WEEK)  # To avoid repeated tweaks

    # New OK tweaks
    test_ok_tweaks = [
        ("liquidity_min", _W(11)),  # 30% allowed - previous 10
        ("liquidity_middle", _W(82)),  # 30% allowed - previous 80
        ("liquidity_max", _W(190)),  # 30% allowed - previous 200
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with asm.as_("L3_USER"):
            setattr(asm, attr_name, attr_value)
        assert getattr(asm, attr_name) == attr_value

    # Other tweaks
    test_ok_tweaks = [
        ("liquidity_min", _W(12)),  # 30% allowed - previous 11
        ("liquidity_middle", _W(83)),  # 30% allowed - previous 82
        ("liquidity_max", _W(180)),  # 30% allowed - previous 190
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with asm.as_("L3_USER"), pytest.raises(RevertError,
                                               match="You already tweaked this parameter recently"):
            setattr(asm, attr_name, attr_value)

    tenv.time_control.fast_forward(2 * DAY)  # Tweaks expired

    for attr_name, attr_value in test_ok_tweaks:
        with asm.as_("L3_USER"):
            setattr(asm, attr_name, attr_value)
        assert getattr(asm, attr_name) == attr_value
