from collections import namedtuple
from functools import partial

import pytest
from ethproto.contracts import Contract, ContractProxyField, ERC20Token
from ethproto.wadray import _W, Wad, make_integer_float
from ethproto.wrappers import get_provider

from prototype import ensuro, wrappers
from prototype.utils import WEEK

from . import TEST_VARIANTS

TEnv = namedtuple("TEnv", ["time_control", "currency", "rm_class", "pool_access", "kind", "A"])


USDC = make_integer_float(6, "USDC")
_D = USDC.from_value


def _A(x):
    return Wad(_D(x))


decimals = 6


@pytest.fixture
def tenv_prototype():
    currency = ERC20Token(
        owner="owner", name="TEST", symbol="TEST", initial_supply=_A(1000), decimals=decimals
    )
    pool_access = ensuro.AccessManager()

    class PolicyPoolMock(Contract):
        currency = ContractProxyField()
        access = pool_access

        def new_policy(self, policy, caller, customer, internal_id):
            return policy.risk_module.make_policy_id(internal_id)

        def resolve_policy(self, policy_id, customer_won):
            pass

    pool = PolicyPoolMock(currency=currency)
    premiums_account = ensuro.PremiumsAccount(
        pool=pool, senior_etk=ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    )

    return TEnv(
        currency=currency,
        time_control=ensuro.time_control,
        pool_access=pool_access,
        kind="prototype",
        rm_class=partial(ensuro.SignedBucketRiskModule, policy_pool=pool, premiums_account=premiums_account),
        A=_A,
    )


@pytest.fixture
def tenv_ethereum():
    PolicyPoolMock = wrappers.ETHWrapper.build_from_def(get_provider().get_contract_def("PolicyPoolMock"))
    PremiumsAccountMock = wrappers.ETHWrapper.build_from_def(
        get_provider().get_contract_def("PolicyPoolComponentMock")
    )

    currency = wrappers.TestCurrency(
        owner="owner", name="TEST", symbol="TEST", initial_supply=_A(1000), decimals=decimals
    )
    access = wrappers.AccessManager(owner="owner")

    pool = PolicyPoolMock(currency_=currency.contract, access_=access.contract)
    premiums_account = PremiumsAccountMock(policyPool_=pool)

    return TEnv(
        currency=currency,
        time_control=get_provider().time_control,
        pool_access=access,
        kind="ethereum",
        rm_class=partial(
            wrappers.SignedBucketRiskModule,
            policy_pool=wrappers.PolicyPool.connect(pool.contract, currency.owner),
            premiums_account=premiums_account,
            creation_is_open=True,
        ),
        A=_A,
    )


@pytest.mark.skipif("prototype" not in TEST_VARIANTS, reason="Prototype tests disabled")
def test_prototype_calculates_minimum_premium(tenv_prototype: TEnv):
    rm = tenv_prototype.rm_class(
        name="Bucket",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.03"),
        sr_roc=_W("0.02"),
        max_payout_per_policy=_A(1000),
        exposure_limit=_A(1000000),
        wallet="CASINO",
    )

    bucket_params = ensuro.BucketParams(
        moc=_W("0.9"),
        jr_coll_ratio=_W("0"),
        coll_ratio=_W("0.8"),
        ensuro_pp_fee=_W("0"),
        ensuro_coc_fee=_W("0"),
        jr_roc=_W("0"),
        sr_roc=_W("0.01"),
    )

    rm.set_bucket_params(_W(20), bucket_params)

    expiration = tenv_prototype.time_control.now + WEEK

    # Policy with default risk bucket
    premium_composition = rm.get_minimum_premium_composition(_A(1000), _W("0.1"), expiration)
    assert premium_composition.pure_premium == _A("100")
    assert premium_composition.jr_coc == _A("0")
    assert premium_composition.sr_coc == _A("0.345205")
    assert premium_composition.ensuro_commission == _A("3")
    assert premium_composition.total == _A("103.345205")

    # Policy with first risk bucket
    premium_composition = rm.get_minimum_premium_composition(
        _A(1500), _W("0.05"), expiration, rm.bucket_params(_W(20))
    )
    assert (
        rm.get_minimum_premium_for_bucket(_A(1500), _W("0.05"), expiration, _W(20))
        == premium_composition.total
    )
    assert premium_composition.pure_premium == _A("67.5")
    assert premium_composition.jr_coc == _A("0")
    assert premium_composition.sr_coc == _A("0.217191")
    assert premium_composition.ensuro_commission == _A("0")
    assert premium_composition.total == _A("67.717191")


@pytest.mark.skipif("ethereum" not in TEST_VARIANTS, reason="Ethereum tests disabled")
def test_wrapper_allows_obtaining_buckets(tenv_ethereum: TEnv):
    rm = tenv_ethereum.rm_class(
        name="Bucket",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.03"),
        sr_roc=_W("0.02"),
        max_payout_per_policy=_A(1000),
        exposure_limit=_A(1000000),
        wallet="CASINO",
    )
    tenv_ethereum.pool_access.grant_role("LEVEL1_ROLE", "owner")

    rm.set_bucket_params(
        _W(20),
        ensuro.BucketParams(
            moc=_W("0.9"),
            jr_coll_ratio=_W("0"),
            coll_ratio=_W("0.8"),
            ensuro_pp_fee=_W("0"),
            ensuro_coc_fee=_W("0"),
            jr_roc=_W("0"),
            sr_roc=_W("0.01"),
        ).as_tuple(),
    )

    # Build a prototype from the wrapper
    currency = ERC20Token(
        owner="owner", name="TEST", symbol="TEST", initial_supply=_A(1000), decimals=decimals
    )
    pool_access = ensuro.AccessManager()

    class PolicyPoolMock(Contract):
        currency = ContractProxyField()
        access = pool_access

        def new_policy(self, policy, caller, customer, internal_id):
            return policy.risk_module.make_policy_id(internal_id)

        def resolve_policy(self, policy_id, customer_won):
            pass

    pool = PolicyPoolMock(currency=currency)
    premiums_account = ensuro.PremiumsAccount(
        pool=pool, senior_etk=ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    )
    proto_rm = ensuro.SignedBucketRiskModule(
        policy_pool=pool,
        premiums_account=premiums_account,
        name="Bucket Proto",
        coll_ratio=rm.coll_ratio,
        ensuro_pp_fee=rm.ensuro_pp_fee,
        sr_roc=rm.sr_roc,
        max_payout_per_policy=rm.max_payout_per_policy,
        exposure_limit=rm.exposure_limit,
        wallet=rm.wallet,
    )

    for bucket_id, params in rm.fetch_buckets().items():
        proto_rm.set_bucket_params(bucket_id, ensuro.BucketParams.from_contract_bucket_params(params))

    expiration = ensuro.time_control.now + WEEK

    # Policy with default risk bucket
    premium_composition = proto_rm.get_minimum_premium_composition(_A(1000), _W("0.1"), expiration)
    assert premium_composition.pure_premium == _A("100")
    assert premium_composition.jr_coc == _A("0")
    assert premium_composition.sr_coc == _A("0.345205")
    assert premium_composition.ensuro_commission == _A("3")
    assert premium_composition.total == _A("103.345205")

    # Policy with first risk bucket
    premium_composition = proto_rm.get_minimum_premium_composition(
        _A(1500), _W("0.05"), expiration, proto_rm.bucket_params(_W(20))
    )
    assert (
        proto_rm.get_minimum_premium_for_bucket(_A(1500), _W("0.05"), expiration, _W(20))
        == premium_composition.total
    )
    assert premium_composition.pure_premium == _A("67.5")
    assert premium_composition.jr_coc == _A("0")
    assert premium_composition.sr_coc == _A("0.217191")
    assert premium_composition.ensuro_commission == _A("0")
    assert premium_composition.total == _A("67.717191")
