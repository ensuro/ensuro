from collections import namedtuple
from functools import partial
from itertools import product

import pytest
from ethproto.contracts import Contract, ContractProxyField, ERC20Token, RevertError
from ethproto.wadray import _W, Wad, make_integer_float
from ethproto.wrappers import get_provider

from prototype import ensuro, wrappers
from prototype.utils import DAYS_IN_YEAR, WEEK, YEAR

from . import TEST_VARIANTS
from .contracts import PolicyPoolMock, PremiumsAccountMock

TEnv = namedtuple("TEnv", "time_control currency rm_class pool_access kind A")

USDC = make_integer_float(6, "USDC")
_D = USDC.from_value


# Test variants combining different number of decimals and implementation
# test_variants = [f"{variant}-dec{decimals}" for (variant, decimals) in product(TEST_VARIANTS, [6, 18])]
test_variants = [f"{variant}-dec{decimals}" for (variant, decimals) in product(TEST_VARIANTS, [6])]


@pytest.fixture(params=test_variants)
def tenv(request):
    test_variant = request.param.split("-")[0]
    decimals = int(request.param.split("-")[1][3:])

    if decimals == 6:

        def _A(x):
            return Wad(_D(x))

    else:
        _A = _W

    if test_variant == "prototype":
        currency = ERC20Token(
            owner="owner", name="TEST", symbol="TEST", initial_supply=_A(1000), decimals=decimals
        )
        pool_access = ensuro.AccessManager()

        class PolicyPoolMockProto(Contract):
            currency = ContractProxyField()
            access = pool_access

            def new_policy(self, policy, caller, customer, internal_id):
                return policy.risk_module.make_policy_id(internal_id)

            def resolve_policy(self, policy_id, customer_won):
                pass

        pool = PolicyPoolMockProto(currency=currency)
        premiums_account = ensuro.PremiumsAccount(
            pool=pool, senior_etk=ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
        )

        return TEnv(
            currency=currency,
            time_control=ensuro.time_control,
            pool_access=pool_access,
            kind="prototype",
            rm_class=partial(ensuro.TrustfulRiskModule, policy_pool=pool, premiums_account=premiums_account),
            A=_A,
        )
    elif test_variant == "ethereum":
        currency = wrappers.TestCurrency(
            owner="owner", name="TEST", symbol="TEST", initial_supply=_A(1000), decimals=decimals
        )
        access = wrappers.AccessManager(owner="owner")

        pool = PolicyPoolMock(currency_=currency.contract, access_=access.contract, owner="owner")
        premiums_account = PremiumsAccountMock(policyPool_=pool, owner="owner")

        return TEnv(
            currency=currency,
            time_control=get_provider().time_control,
            pool_access=access,
            kind="ethereum",
            rm_class=partial(
                wrappers.TrustfulRiskModule,
                policy_pool=wrappers.PolicyPool.connect(pool.contract, currency.owner),
                premiums_account=premiums_account,
            ),
            A=_A,
        )


def test_getset_rm_parameters(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.03"),
        sr_roc=_W("0.02"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )
    assert rm.name == "Roulette"
    assert rm.coll_ratio == _W(1)
    rm.ensuro_pp_fee.assert_equal(_W("0.03"))
    rm.sr_roc.assert_equal(_W("0.02"))
    assert rm.max_payout_per_policy == tenv.A(1000)
    assert rm.exposure_limit == tenv.A(1000000)
    assert rm.wallet == "CASINO"

    # rm.grant_role("RM_PROVIDER_ROLE", "CASINO")  # Grant the role to the casino owner
    # Grant the role to the casino owner
    tenv.pool_access.grant_component_role(rm, "RM_PROVIDER_ROLE", "CASINO")
    tenv.pool_access.grant_role("LEVEL1_ROLE", "L1_USER")
    tenv.pool_access.grant_role("LEVEL2_ROLE", "L2_USER")

    users = ("CASINO", "L2_USER", "JOHNDOE")

    test_attributes = [
        ("coll_ratio", "L2_USER", _W("0.8")),
        ("ensuro_pp_fee", "L2_USER", _W("0.04")),
        ("sr_roc", "L2_USER", _W("0.03")),
        ("jr_roc", "L2_USER", _W("0.05")),
        ("max_payout_per_policy", "L2_USER", tenv.A(2000)),
        ("exposure_limit", "L1_USER", tenv.A(10000000)),
        ("wallet", "CASINO", "CASINO_POCKET"),
        ("max_duration", "L2_USER", 180),
    ]

    for attr_name, authorized_user, new_value in test_attributes:
        if attr_name == "exposure_limit":
            non_auth_users = ["CASINO", "JOHNDOE"]
        else:
            non_auth_users = [u for u in users if u != authorized_user]
        old_value = getattr(rm, attr_name)
        assert old_value != new_value
        for user in non_auth_users:
            with pytest.raises(RevertError, match="AccessControlUnauthorizedAccount"), rm.as_(user):
                setattr(rm, attr_name, new_value)

        with rm.as_(authorized_user):
            setattr(rm, attr_name, new_value)

        assert getattr(rm, attr_name) == new_value

    if tenv.kind == "ethereum":
        with rm.as_("CASINO"), pytest.raises(RevertError):
            rm.wallet = None


def test_set_rm_parameter_overflow(tenv):
    if tenv.kind != "ethereum":
        pytest.skip("Python doesn't have int limits 😎")
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.03"),
        sr_roc=_W("0.02"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )
    tenv.pool_access.grant_role("LEVEL2_ROLE", "ADMIN")
    tenv.pool_access.grant_role("LEVEL1_ROLE", "ADMIN")

    with rm.as_("ADMIN"), pytest.raises(RevertError, match="SafeCastOverflowedUintDowncast"):
        rm.exposure_limit = tenv.A(2**40 + 1)

    # Verifies OK tweaks
    test_overflows = [
        ("moc", _W("10")),
        ("coll_ratio", _W("10")),
        ("jr_coll_ratio", _W("10")),
        ("ensuro_pp_fee", _W("10")),
        ("ensuro_coc_fee", _W("10")),
        ("sr_roc", _W("10")),
        ("jr_roc", _W("10")),
        ("max_payout_per_policy", tenv.A(50000000)),
        ("exposure_limit", tenv.A(2**32 + 1)),
        ("max_duration", 65536),
    ]

    for attr_name, attr_value in test_overflows:
        with rm.as_("ADMIN"), pytest.raises(RevertError, match="SafeCastOverflowedUintDowncast"):
            setattr(rm, attr_name, attr_value)


def test_new_policy(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.02"),
        sr_roc=_W("0.01"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )
    assert rm.name == "Roulette"
    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(1))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(1))
    assert tenv.currency.allowance("JOHN_SELLER", rm.policy_pool) == tenv.A(1)
    expiration = tenv.time_control.now + WEEK

    # Set ensuro_coc_fee
    tenv.pool_access.grant_role("LEVEL2_ROLE", "DAO")
    with rm.as_("DAO"):
        rm.ensuro_coc_fee = _W("0.03")

    assert rm.ensuro_coc_fee == _W("0.03")

    with rm.as_("JOHN_DOE"), pytest.raises(RevertError, match="AccessControlUnauthorizedAccount"):
        policy = rm.new_policy(tenv.A(36), tenv.A(1), _W(1 / 37), expiration, "CUST1", 123)

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"):
        policy = rm.new_policy(
            payout=tenv.A(36),
            premium=tenv.A(1),
            loss_prob=_W(1 / 37),
            expiration=expiration,
            on_behalf_of="CUST1",
            internal_id=123,
        )

    policy.premium.assert_equal(tenv.A(1))
    policy.payout.assert_equal(tenv.A(36))
    policy.loss_prob.assert_equal(_W(1 / 37))
    policy.pure_premium.assert_equal(tenv.A(36 * 1 / 37))
    policy.sr_scr.assert_equal(tenv.A(36) - policy.pure_premium)
    assert policy.id == rm.make_policy_id(123)
    assert policy.expiration == expiration
    assert (tenv.time_control.now - policy.start) < 60  # Must be now, giving 60 seconds tolerance
    policy.sr_coc.assert_equal(policy.sr_scr * _W("0.01") * _W(7 / 365))
    policy.ensuro_commission.assert_equal(policy.pure_premium * _W("0.02") + policy.sr_coc * _W("0.03"))
    policy.partner_commission.assert_equal(
        tenv.A(1) - policy.pure_premium - policy.sr_coc - policy.ensuro_commission
    )
    policy.sr_interest_rate.assert_equal(_W("0.01"))

    with rm.as_("JOHN_DOE"), pytest.raises(RevertError, match="AccessControlUnauthorizedAccount"):
        rm.resolve_policy(policy.id, True)

    tenv.pool_access.grant_component_role(rm, "RESOLVER_ROLE", "JOE_THE_ORACLE")

    with rm.as_("JOE_THE_ORACLE"):
        rm.resolve_policy(policy.id, True)


def test_moc(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W(0),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )
    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(1))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(1))
    expiration = tenv.time_control.now + WEEK

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"):
        policy = rm.new_policy(
            payout=tenv.A(36),
            premium=tenv.A(1),
            loss_prob=_W(1 / 37),
            expiration=expiration,
            on_behalf_of="CUST1",
            internal_id=111,
        )

    policy.premium.assert_equal(tenv.A(1))
    policy.loss_prob.assert_equal(_W(1 / 37))
    policy.pure_premium.assert_equal(tenv.A(36 * 1 / 37))
    policy.ensuro_commission.assert_equal(tenv.A(36 * 1 / 37 * 0.01))
    assert policy.id == rm.make_policy_id(111)

    with pytest.raises(RevertError, match="AccessControlUnauthorizedAccount"):
        rm.moc = _W("1.01")

    tenv.pool_access.grant_role("LEVEL2_ROLE", "DAO")
    with rm.as_("DAO"):
        rm.moc = _W("1.01")

    assert rm.moc == _W("1.01")

    with rm.as_("JOHN_SELLER"):
        policy2 = rm.new_policy(
            payout=tenv.A(36),
            premium=tenv.A(1),
            loss_prob=_W(1 / 37),
            expiration=expiration,
            on_behalf_of="CUST1",
            internal_id=112,
        )

    policy2.premium.assert_equal(tenv.A(1))
    assert policy2.id == rm.make_policy_id(112)
    policy2.loss_prob.assert_equal(_W(1 / 37))
    policy2.pure_premium.assert_equal(tenv.A(36 * 1 / 37) * _W("1.01"))
    policy2.ensuro_commission.assert_equal(tenv.A(36 * 1 / 37 * 0.01) * _W("1.01"))


def test_minimum_premium(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W("0.2"),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W("0.10"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )
    tenv.pool_access.grant_role("LEVEL2_ROLE", "DAO")
    with rm.as_("DAO"):
        rm.moc = _W("1.3")

    expiration = tenv.time_control.now + WEEK
    pure_premium = tenv.A(36 / 37) * _W("1.3")
    scr = tenv.A(36) * _W("0.2") - pure_premium
    rm.get_minimum_premium(tenv.A(36), _W(1 / 37), expiration).assert_equal(
        pure_premium * _W("1.01") + scr * _W(7 / 365) * _W("0.10")
    )
    minimum_premium = rm.get_minimum_premium(tenv.A(36), _W(1 / 37), expiration)

    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(2))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(2))

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="less than minimum"):
        policy = rm.new_policy(
            payout=tenv.A(36),
            premium=tenv.A("1.28"),
            loss_prob=_W(1 / 37),
            expiration=expiration,
            on_behalf_of="CUST1",
            internal_id=222,
        )

    with rm.as_("JOHN_SELLER"):
        policy = rm.new_policy(
            payout=tenv.A(36),
            premium=rm.get_minimum_premium(tenv.A(36), _W(1 / 37), expiration),
            loss_prob=_W(1 / 37),
            expiration=expiration,
            on_behalf_of="CUST1",
            internal_id=222,
        )

    policy.premium.assert_equal(minimum_premium, decimals=3)
    policy.loss_prob.assert_equal(_W(1 / 37))
    policy.pure_premium.assert_equal(tenv.A(36 * 1 / 37 * 1.3))
    policy.ensuro_commission.assert_equal(policy.pure_premium * _W("0.01"))


def test_get_minimum_premium_with_high_jr_coll_ratio(tenv):
    """A loss probability lower than the jr_coll_ratio is valid"""
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W("0.2"),
        ensuro_pp_fee=_W("0"),
        sr_roc=_W("0"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )

    tenv.pool_access.grant_role("LEVEL2_ROLE", "L2_USER")
    with rm.as_("L2_USER"):
        rm.jr_coll_ratio = _W("0.1")

    minimum_premium = rm.get_minimum_premium(tenv.A(100), _W("0.01"), tenv.time_control.now + WEEK)
    assert minimum_premium == tenv.A(1)


def test_get_minimum_premium_with_low_sr_coll_ratio(tenv):
    """A loss probability higher than the sr_coll_ratio is valid"""
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W("0.1"),  # coll_ratio == sr_coll_ratio in this case
        ensuro_pp_fee=_W("0"),
        sr_roc=_W("0"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )

    minimum_premium = rm.get_minimum_premium(tenv.A(100), _W("0.2"), tenv.time_control.now + WEEK)
    assert minimum_premium == tenv.A(20)


def test_default_premium(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W("0.1"),
        ensuro_pp_fee=_W("0"),
        sr_roc=_W("0"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )

    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(2))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(2))

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")

    # _, uint256max = get_int_bounds("uint256")
    expiration = tenv.time_control.now + WEEK

    with rm.as_("JOHN_SELLER"):
        policy = rm.new_policy(
            payout=tenv.A(36),
            premium=None,
            loss_prob=_W(1 / 37),
            expiration=expiration,
            on_behalf_of="CUST1",
            internal_id=222,
        )

    policy.premium.assert_equal(rm.get_minimum_premium(tenv.A(36), _W(1 / 37), expiration), decimals=3)


def test_premium_too_high(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W(0),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )
    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(37))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(37))
    expiration = tenv.time_control.now + WEEK

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="Premium must be less than payout"):
        rm.new_policy(
            payout=tenv.A(36),
            premium=tenv.A(37),
            loss_prob=_W(1 / 37),
            expiration=expiration,
            on_behalf_of="CUST1",
            internal_id=111,
        )


def test_expiration_in_the_past_should_revert(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W(0),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )
    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(1))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(1))
    expiration = tenv.time_control.now - WEEK

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="Expiration must be in the future"):
        rm.new_policy(
            payout=tenv.A(36),
            premium=tenv.A(1),
            loss_prob=_W(1 / 37),
            expiration=expiration,
            on_behalf_of="CUST1",
            internal_id=111,
        )


def test_max_duration(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W(0),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )

    tenv.pool_access.grant_role("LEVEL2_ROLE", "L2_USER")
    with rm.as_("L2_USER"):
        rm.max_duration = DAYS_IN_YEAR

    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(1))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(1))
    expiration = tenv.time_control.now + YEAR + WEEK

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="Policy exceeds max duration"):
        rm.new_policy(
            payout=tenv.A(36),
            premium=tenv.A(1),
            loss_prob=_W(1 / 37),
            expiration=expiration,
            on_behalf_of="CUST1",
            internal_id=111,
        )


def test_customer_with_zero_address(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W(0),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )

    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(1))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(1))

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="Customer can't be zero address"):
        rm.new_policy(
            payout=tenv.A(36),
            premium=tenv.A(1),
            loss_prob=_W(1 / 37),
            expiration=tenv.time_control.now + WEEK,
            on_behalf_of=None,
            internal_id=111,
        )


def test_exceeded_max_payout(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W(0),
        max_payout_per_policy=tenv.A(100),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )

    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(101))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(101))

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="Payout is more than maximum"):
        rm.new_policy(
            payout=tenv.A(101),
            premium=None,
            loss_prob=_W(1 / 37),
            expiration=tenv.time_control.now + WEEK,
            on_behalf_of="CUST1",
            internal_id=111,
        )


def test_exceeded_max_exposure(tenv):
    rm = tenv.rm_class(
        name="Roulette",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W(0),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(50),
        wallet="CASINO",
    )

    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(101))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(101))

    tenv.pool_access.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="Exposure limit exceeded"):
        rm.new_policy(
            payout=tenv.A(101),
            premium=None,
            loss_prob=_W(1 / 37),
            expiration=tenv.time_control.now + WEEK,
            on_behalf_of="CUST1",
            internal_id=111,
        )
