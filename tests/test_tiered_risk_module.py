from ethproto.contracts import Contract, ERC20Token, ContractProxyField
from ethproto.wadray import _W, make_integer_float, Wad

from prototype import ensuro
from prototype.utils import WEEK

# TODO: these are some quick and dirty tests of the prototype to launch the quote API.
# To be fixed after launch.

USDC = make_integer_float(6, "USDC")
_D = USDC.from_value


def _A(x):
    return Wad(_D(x))


def test_prototype_calculates_minimum_premium():
    decimals = 6
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

    rm = ensuro.TieredSignedQuoteRiskModule(
        policy_pool=pool,
        premiums_account=premiums_account,
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

    expiration = ensuro.time_control.now + WEEK

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
