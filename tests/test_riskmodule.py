from collections import namedtuple
from functools import partial
from itertools import product

import pytest
from ethproto.contracts import Contract, ContractProxyField, ERC20Token, RevertError
from ethproto.wadray import _W, Wad, make_integer_float
from ethproto.wrappers import get_provider

from prototype import ensuro, wrappers
from prototype.utils import WEEK

from . import TEST_VARIANTS
from .contracts import PolicyPoolMock, PremiumsAccountMock

TEnv = namedtuple("TEnv", "time_control currency rm_class kind A")

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

        class PolicyPoolMockProto(Contract):
            currency = ContractProxyField()

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
            kind="prototype",
            rm_class=partial(ensuro.RiskModule, policy_pool=pool, premiums_account=premiums_account),
            A=_A,
        )
    elif test_variant == "ethereum":
        currency = wrappers.TestCurrency(
            owner="owner", name="TEST", symbol="TEST", initial_supply=_A(1000), decimals=decimals
        )
        pool = PolicyPoolMock(currency_=currency.contract, owner="owner")
        premiums_account = PremiumsAccountMock(policyPool_=pool, owner="owner")

        return TEnv(
            currency=currency,
            time_control=get_provider().time_control,
            kind="ethereum",
            rm_class=partial(
                wrappers.RiskModule,
                policy_pool=wrappers.PolicyPool.connect(pool.contract, currency.owner),
                premiums_account=premiums_account,
            ),
            A=_A,
        )


def test_new_policy(tenv):
    rm = tenv.rm_class(
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.02"),
        sr_roc=_W("0.01"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )
    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(1))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(1))
    assert tenv.currency.allowance("JOHN_SELLER", rm.policy_pool) == tenv.A(1)
    expiration = tenv.time_control.now + WEEK

    # Set ensuro_coc_fee
    with rm.as_("DAO"):
        rm.ensuro_coc_fee = _W("0.03")

    assert rm.ensuro_coc_fee == _W("0.03")

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

    with rm.as_("JOE_THE_ORACLE"):
        rm.resolve_policy(policy.id, True)


def test_moc(tenv):
    rm = tenv.rm_class(
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
        coll_ratio=_W("0.2"),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W("0.10"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )
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

    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="PremiumLessThanMinimum"):
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
        coll_ratio=_W("0.2"),
        ensuro_pp_fee=_W("0"),
        sr_roc=_W("0"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )

    with rm.as_("L2_USER"):
        rm.jr_coll_ratio = _W("0.1")

    minimum_premium = rm.get_minimum_premium(tenv.A(100), _W("0.01"), tenv.time_control.now + WEEK)
    assert minimum_premium == tenv.A(1)


def test_get_minimum_premium_with_low_sr_coll_ratio(tenv):
    """A loss probability higher than the sr_coll_ratio is valid"""
    rm = tenv.rm_class(
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
        coll_ratio=_W("0.1"),
        ensuro_pp_fee=_W("0"),
        sr_roc=_W("0"),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )

    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(2))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(2))

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

    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="PremiumExceedsPayout"):
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

    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="ExpirationMustBeInTheFuture"):
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
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.01"),
        sr_roc=_W(0),
        max_payout_per_policy=tenv.A(1000),
        exposure_limit=tenv.A(1000000),
        wallet="CASINO",
    )

    tenv.currency.transfer(tenv.currency.owner, "JOHN_SELLER", tenv.A(1))
    tenv.currency.approve("JOHN_SELLER", rm.policy_pool, tenv.A(1))

    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="InvalidCustomer"):
        rm.new_policy(
            payout=tenv.A(36),
            premium=tenv.A(1),
            loss_prob=_W(1 / 37),
            expiration=tenv.time_control.now + WEEK,
            on_behalf_of=None,
            internal_id=111,
        )
