import pytest
from functools import partial
from collections import namedtuple

from ethproto.contracts import Contract, ERC20Token, ContractProxyField
from ethproto.wrappers import get_provider
from ethproto.wadray import _W, make_integer_float, Wad

from prototype import ensuro
from prototype import wrappers
from prototype.utils import WEEK
from . import TEST_VARIANTS

TEnv = namedtuple("TEnv", ["time_control", "currency", "rm_class", "pool_access", "kind", "A"])

# TODO: these are some quick and dirty tests of the prototype to launch the quote API.
# To be fixed after launch.

USDC = make_integer_float(6, "USDC")
_D = USDC.from_value


def _A(x):
    return Wad(_D(x))


decimals = 6


@pytest.fixture(params=TEST_VARIANTS)
def tenv(request):
    test_variant = request.param

    if test_variant == "prototype":
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
            rm_class=partial(
                ensuro.TieredSignedQuoteRiskModule, policy_pool=pool, premiums_account=premiums_account
            ),
            A=_A,
        )
    elif test_variant == "ethereum":
        PolicyPoolMock = get_provider().get_contract_factory("PolicyPoolMock")
        PremiumsAccountMock = get_provider().get_contract_factory("PolicyPoolComponentMock")

        currency = wrappers.TestCurrency(
            owner="owner", name="TEST", symbol="TEST", initial_supply=_A(1000), decimals=decimals
        )
        access = wrappers.AccessManager(owner="owner")

        pool = PolicyPoolMock.deploy(currency.contract, access.contract, {"from": currency.owner})
        premiums_account = PremiumsAccountMock.deploy(pool, {"from": currency.owner})

        return TEnv(
            currency=currency,
            time_control=get_provider().time_control,
            pool_access=access,
            kind="ethereum",
            rm_class=partial(
                wrappers.TieredSignedQuoteRiskModule,
                policy_pool=wrappers.PolicyPool.connect(pool, currency.owner),
                premiums_account=premiums_account,
                creation_is_open=True,
            ),
            A=_A,
        )


def test_prototype_calculates_minimum_premium(tenv: TEnv):
    if tenv.kind != "prototype":
        pytest.skip("Prototype only test")

    rm = tenv.rm_class(
        name="Tiered",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.03"),
        sr_roc=_W("0.02"),
        max_payout_per_policy=_A(1000),
        exposure_limit=_A(1000000),
        wallet="CASINO",
    )

    rm.set_buckets(
        {
            _W("0.05"): ensuro.BucketParams(
                moc=_W("0.9"),
                jr_coll_ratio=_W("0"),
                coll_ratio=_W("0.8"),
                ensuro_pp_fee=_W("0"),
                ensuro_coc_fee=_W("0"),
                jr_roc=_W("0"),
                sr_roc=_W("0.01"),
            )
        }
    )

    expiration = tenv.time_control.now + WEEK

    # Policy with default risk bucket
    premium_composition = rm.get_minimum_premium_composition(_A(1000), _W("0.1"), expiration)
    assert premium_composition.pure_premium == _A("100")
    assert premium_composition.jr_coc == _A("0")
    assert premium_composition.sr_coc == _A("0.345205")
    assert premium_composition.ensuro_commission == _A("3")
    assert premium_composition.total == _A("103.345205")

    # Policy with first risk bucket
    premium_composition = rm.get_minimum_premium_composition(_A(1500), _W("0.05"), expiration)
    assert premium_composition.pure_premium == _A("67.5")
    assert premium_composition.jr_coc == _A("0")
    assert premium_composition.sr_coc == _A("0.217191")
    assert premium_composition.ensuro_commission == _A("0")
    assert premium_composition.total == _A("67.717191")


def test_wrapper_allows_obtaining_buckets(tenv: TEnv):
    if tenv.kind != "ethereum":
        pytest.skip("ETH only test")

    rm = tenv.rm_class(
        name="Tiered",
        coll_ratio=_W(1),
        ensuro_pp_fee=_W("0.03"),
        sr_roc=_W("0.02"),
        max_payout_per_policy=_A(1000),
        exposure_limit=_A(1000000),
        wallet="CASINO",
    )

    tenv.pool_access.grant_role("LEVEL1_ROLE", "owner")

    rm.push_bucket(
        _W("0.05"),
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
    proto_rm = ensuro.TieredSignedQuoteRiskModule(
        policy_pool=pool,
        premiums_account=premiums_account,
        name="Tiered Proto",
        coll_ratio=rm.coll_ratio,
        ensuro_pp_fee=rm.ensuro_pp_fee,
        sr_roc=rm.sr_roc,
        max_payout_per_policy=rm.max_payout_per_policy,
        exposure_limit=rm.exposure_limit,
        wallet=rm.wallet,
    )

    buckets = dict()
    for bucket in rm.buckets():
        # import ipdb; ipdb.set_trace()
        bucket_params = rm.bucket_params(bucket)
        buckets[Wad(bucket)] = ensuro.BucketParams.from_contract_bucket_params(bucket_params)

    proto_rm.set_buckets(buckets)
    expiration = tenv.time_control.now + WEEK

    # Policy with default risk bucket
    premium_composition = proto_rm.get_minimum_premium_composition(_A(1000), _W("0.1"), expiration)
    assert premium_composition.pure_premium == _A("100")
    assert premium_composition.jr_coc == _A("0")
    assert premium_composition.sr_coc == _A("0.345214")
    assert premium_composition.ensuro_commission == _A("3")
    assert premium_composition.total == _A("103.345214")

    # Policy with first risk bucket
    premium_composition = proto_rm.get_minimum_premium_composition(_A(1500), _W("0.05"), expiration)
    assert premium_composition.pure_premium == _A("67.5")
    assert premium_composition.jr_coc == _A("0")
    assert premium_composition.sr_coc == _A("0.217197")
    assert premium_composition.ensuro_commission == _A("0")
    assert premium_composition.total == _A("67.717197")
