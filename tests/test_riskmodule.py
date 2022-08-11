"""Unitary tests for eToken contract"""

from functools import partial
from collections import namedtuple
import pytest
from ethproto.contracts import RevertError, Contract, ERC20Token, ContractProxyField
from ethproto.wrappers import get_provider
from prototype import ensuro
from ethproto.wadray import _W, Wad
from prototype import wrappers
from prototype.utils import WEEK, DAY
from . import TEST_VARIANTS

TEnv = namedtuple("TEnv", "time_control currency rm_class pool_config kind")


@pytest.fixture(params=TEST_VARIANTS)
def tenv(request):
    if request.param == "prototype":
        currency = ERC20Token(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(1000))
        pool_config = ensuro.PolicyPoolConfig()

        class PolicyPoolMock(Contract):
            currency = ContractProxyField()
            config = pool_config

            def new_policy(self, policy, customer, internal_id):
                return policy.risk_module.make_policy_id(internal_id)

            def resolve_policy(self, policy_id, customer_won):
                pass

        pool = PolicyPoolMock(currency=currency)
        premiums_account = ensuro.PremiumsAccount(
            pool=pool, senior_etk=ensuro.EToken(
                policy_pool=pool, name="eUSD1YEAR"
            )
        )

        return TEnv(
            currency=currency,
            time_control=ensuro.time_control,
            pool_config=pool_config,
            kind="prototype",
            rm_class=partial(ensuro.TrustfulRiskModule, policy_pool=pool, premiums_account=premiums_account)
        )
    elif request.param == "ethereum":
        PolicyPoolMock = get_provider().get_contract_factory("PolicyPoolMock")
        PremiumsAccountMock = get_provider().get_contract_factory("PolicyPoolComponentMock")

        currency = wrappers.TestCurrency(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(1000))
        config = wrappers.PolicyPoolConfig(owner="owner")

        pool = PolicyPoolMock.deploy(currency.contract, config.contract, {"from": currency.owner})
        premiums_account = PremiumsAccountMock.deploy(pool, {"from": currency.owner})

        return TEnv(
            currency=currency,
            time_control=get_provider().time_control,
            pool_config=config,
            kind="ethereum",
            rm_class=partial(
                wrappers.TrustfulRiskModule,
                policy_pool=wrappers.PolicyPool.connect(pool, currency.owner),
                premiums_account=premiums_account
            )
        )


def test_getset_rm_parameters(tenv):
    rm = tenv.rm_class(
        name="Roulette", coll_ratio=_W(1), ensuro_pp_fee=_W("0.03"),
        sr_roc=_W("0.02"),
        max_payout_per_policy=_W(1000), exposure_limit=_W(1000000),
        wallet="CASINO"
    )
    assert rm.name == "Roulette"
    assert rm.coll_ratio == _W(1)
    rm.ensuro_pp_fee.assert_equal(_W("0.03"))
    rm.sr_roc.assert_equal(_W("0.02"))
    assert rm.max_payout_per_policy == _W(1000)
    assert rm.exposure_limit == _W(1000000)
    assert rm.wallet == "CASINO"

    # rm.grant_role("RM_PROVIDER_ROLE", "CASINO")  # Grant the role to the casino owner
    # Grant the role to the casino owner
    tenv.pool_config.grant_component_role(rm, "RM_PROVIDER_ROLE", "CASINO")
    tenv.pool_config.grant_role("LEVEL2_ROLE", "L2_USER")

    users = ("CASINO", "L2_USER", "JOHNDOE")

    test_attributes = [
        ("coll_ratio", "L2_USER", _W("0.8")),
        ("ensuro_pp_fee", "L2_USER", _W("0.04")),
        ("sr_roc", "L2_USER", _W("0.03")),
        ("jr_roc", "L2_USER", _W("0.05")),
        ("max_payout_per_policy", "L2_USER", _W(2000)),
        ("exposure_limit", "L2_USER", _W(10000000)),
        ("wallet", "CASINO", "CASINO_POCKET"),
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

    if tenv.kind == "ethereum":
        with rm.as_("CASINO"), pytest.raises(RevertError):
            rm.wallet = None


def test_getset_rm_parameters_tweaks(tenv):
    if tenv.kind != "ethereum":
        return
    rm = tenv.rm_class(
        name="Roulette", coll_ratio=_W(1), ensuro_pp_fee=_W("0.03"),
        sr_roc=_W("0.02"),
        max_payout_per_policy=_W(1000), exposure_limit=_W(1e6),  # 1m
        wallet="CASINO"
    )
    tenv.pool_config.grant_role("LEVEL1_ROLE", "L1_USER")
    tenv.pool_config.grant_role("LEVEL2_ROLE", "L2_USER")
    tenv.pool_config.grant_role("LEVEL3_ROLE", "L3_USER")

    # Validate coll_ratio <= 1 in any case
    with rm.as_("L2_USER"), pytest.raises(RevertError, match="Validation: collRatio must be <=1"):
        rm.coll_ratio = _W(1.1)
    with rm.as_("L3_USER"), pytest.raises(RevertError, match="Validation: collRatio must be <=1"):
        rm.coll_ratio = _W("1.02")
    with rm.as_("L3_USER"), pytest.raises(RevertError, match="Tweak exceeded"):
        rm.coll_ratio = _W(0.7)

    with rm.as_("L2_USER"):
        rm.jr_roc = _W("0.1")

    with rm.as_("L2_USER"):
        rm.jr_coll_ratio = _W("0.1")

    # Verifies hard-coded validations
    test_validations = [
        ("coll_ratio", _W(1.01)),  # <= 1
        ("jr_coll_ratio", _W(1.01)),  # <= 1
        ("moc", _W("0.4")),  # [0.5, 4]
        ("moc", _W("4.1")),  # [0.5, 4]
        ("ensuro_pp_fee", _W("1.01")),  # <= 1
        ("jr_roc", _W("1.01")),  # <= 1
        ("sr_roc", _W("1.01")),  # <= 1
    ]

    for attr_name, attr_value in test_validations:
        with rm.as_("L2_USER"), pytest.raises(RevertError, match="Validation: "):
            setattr(rm, attr_name, attr_value)

    # Verifies exceeded tweaks
    test_exceeded_tweaks = [
        ("coll_ratio", _W("0.88")),  # 10% allowed - previous 100
        ("moc", _W("0.88")),  # 10% allowed - previous 1
        ("sr_roc", _W("0.03")),  # 10% allowed
        ("jr_roc", _W("0.2")),  # 10% allowed
        ("ensuro_pp_fee", _W("0.05")),  # 10% allowed
        ("exposure_limit", _W(2e6)),  # 10% allowed - previous 1e6
        ("max_payout_per_policy", _W(1400)),  # 30% allowed
    ]

    for attr_name, attr_value in test_exceeded_tweaks:
        with rm.as_("L3_USER"), pytest.raises(RevertError, match="Tweak exceeded"):
            setattr(rm, attr_name, attr_value)

    # Grant the role to the casino owner
    tenv.pool_config.grant_component_role(rm, "RM_PROVIDER_ROLE", "CASINO")

    assert rm.moc == _W("1")

    # Verifies OK tweaks
    test_ok_tweaks = [
        ("coll_ratio", _W("0.91")),  # 10% allowed - previous 100
        ("moc", _W("1.05")),  # 10% allowed - previous 1
        ("sr_roc", _W("0.0215")),  # 10% allowed - previous 2%
        ("jr_roc", _W("0.095")),  # 10% allowed - previous 10%
        ("ensuro_pp_fee", _W("0.027")),  # 10% allowed - previous 3%
        ("exposure_limit", _W("1050000")),  # 10% allowed - previous 1.05e6
        ("max_payout_per_policy", _W(1099)),  # 10% allowed - previous 1000
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with rm.as_("L3_USER"):
            setattr(rm, attr_name, attr_value)
        assert getattr(rm, attr_name) == attr_value

    # Verifies L2_USER changes
    test_ok_l2_changes = [
        ("coll_ratio", _W("0.1")),
        ("moc", _W("0.8")),
        ("sr_roc", _W("0.01")),
        ("jr_roc", _W("0.3")),
        ("ensuro_pp_fee", _W("0.01")),
        ("exposure_limit", _W("3000000")),
        ("max_payout_per_policy", _W(500)),
    ]

    for attr_name, attr_value in test_ok_l2_changes:
        with rm.as_("L2_USER"):
            setattr(rm, attr_name, attr_value)
        assert getattr(rm, attr_name) == attr_value

    tenv.time_control.fast_forward(WEEK)  # To avoid repeated tweaks

    # Set total liquidity
    rm.policy_pool.contract.setTotalETokenSupply(_W(1e7))
    Wad(rm.policy_pool.contract.totalETokenSupply()).assert_equal(_W(1e7))

    # Increases require LEVEL1_ROLE because more than 10% of total liquidity
    with rm.as_("L2_USER"), pytest.raises(RevertError, match="requires LEVEL1_ROLE"):
        rm.exposure_limit = _W(4e6)
    with rm.as_("L3_USER"), pytest.raises(RevertError, match="requires LEVEL1_ROLE"):
        rm.exposure_limit = _W(3.1e6)

    # Decreases are OK
    with rm.as_("L3_USER"):
        rm.exposure_limit = _W("2900000")
        assert rm.exposure_limit == _W("2900000")
    with rm.as_("L2_USER"):
        rm.exposure_limit = _W("2000000")
        assert rm.exposure_limit == _W("2000000")

    # L1_USER can increase over 10% liquidity
    with rm.as_("L1_USER"):
        rm.exposure_limit = _W("4000000")
        assert rm.exposure_limit == _W("4000000")


def test_avoid_repeated_tweaks(tenv):
    if tenv.kind != "ethereum":
        return
    rm = tenv.rm_class(
        name="Roulette", coll_ratio=_W(1), ensuro_pp_fee=_W("0.03"),
        sr_roc=_W("0.02"),
        max_payout_per_policy=_W(1000), exposure_limit=_W(1e6),  # 1m
        wallet="CASINO"
    )
    tenv.pool_config.grant_role("LEVEL3_ROLE", "L3_USER")

    with rm.as_("L3_USER"):
        rm.coll_ratio = _W("0.95")
        assert rm.coll_ratio == _W("0.95")
        rm.sr_roc = _W("0.021")
        assert rm.sr_roc == _W("0.021")

    with rm.as_("L3_USER"), pytest.raises(RevertError, match="You already tweaked this parameter recently"):
        rm.coll_ratio = _W("0.93")

    with rm.as_("L3_USER"), pytest.raises(RevertError, match="You already tweaked this parameter recently"):
        rm.sr_roc = _W("0.022")

    tenv.time_control.fast_forward(2 * DAY)

    with rm.as_("L3_USER"):
        rm.coll_ratio = _W("0.96")
        assert rm.coll_ratio == _W("0.96")
        rm.sr_roc = _W("0.022")
        assert rm.sr_roc == _W("0.022")


def test_new_policy(tenv):
    rm = tenv.rm_class(
        name="Roulette", coll_ratio=_W(1), ensuro_pp_fee=_W("0.02"),
        sr_roc=_W("0.01"),
        max_payout_per_policy=_W(1000), exposure_limit=_W(1000000),
        wallet="CASINO"
    )
    assert rm.name == "Roulette"
    tenv.currency.transfer(tenv.currency.owner, "CUST1", _W(1))
    tenv.currency.approve("CUST1", rm.policy_pool, _W(1))
    assert tenv.currency.allowance("CUST1", rm.policy_pool) == _W(1)
    expiration = tenv.time_control.now + WEEK

    # Set ensuro_coc_fee
    tenv.pool_config.grant_role("LEVEL2_ROLE", "DAO")
    with rm.as_("DAO"):
        rm.ensuro_coc_fee = _W("0.03")

    assert rm.ensuro_coc_fee == _W("0.03")

    with rm.as_("JOHN_DOE"), pytest.raises(RevertError, match="is missing role"):
        policy = rm.new_policy(_W(36), _W(1), _W(1/37), expiration, "CUST1", 123)

    tenv.pool_config.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"):
        policy = rm.new_policy(_W(36), _W(1), _W(1/37), expiration, "CUST1", 123)

    policy.premium.assert_equal(_W(1))
    policy.payout.assert_equal(_W(36))
    policy.loss_prob.assert_equal(_W(1/37))
    policy.pure_premium.assert_equal(_W(36 * 1/37))
    policy.sr_scr.assert_equal(_W(36) - policy.pure_premium)
    assert policy.id == rm.make_policy_id(123)
    assert policy.expiration == expiration
    assert (tenv.time_control.now - policy.start) < 60  # Must be now, giving 60 seconds tolerance
    policy.sr_coc.assert_equal(policy.sr_scr * _W("0.01") * _W(7/365))
    policy.ensuro_commission.assert_equal(
        policy.pure_premium * _W("0.02") +
        policy.sr_coc * _W("0.03")
    )
    policy.partner_commission.assert_equal(
        _W(1) - policy.pure_premium - policy.sr_coc - policy.ensuro_commission
    )
    policy.sr_interest_rate.assert_equal(_W("0.01"))

    with rm.as_("JOHN_DOE"), pytest.raises(RevertError, match="is missing role"):
        rm.resolve_policy(policy.id, True)

    tenv.pool_config.grant_component_role(rm, "RESOLVER_ROLE", "JOE_THE_ORACLE")

    with rm.as_("JOE_THE_ORACLE"):
        rm.resolve_policy(policy.id, True)


def test_moc(tenv):
    rm = tenv.rm_class(
        name="Roulette", coll_ratio=_W(1), ensuro_pp_fee=_W("0.01"),
        sr_roc=_W(0),
        max_payout_per_policy=_W(1000), exposure_limit=_W(1000000),
        wallet="CASINO"
    )
    tenv.currency.transfer(tenv.currency.owner, "CUST1", _W(1))
    tenv.currency.approve("CUST1", rm.policy_pool, _W(1))
    expiration = tenv.time_control.now + WEEK

    tenv.pool_config.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"):
        policy = rm.new_policy(_W(36), _W(1), _W(1/37), expiration, "CUST1", 111)

    policy.premium.assert_equal(_W(1))
    policy.loss_prob.assert_equal(_W(1/37))
    policy.pure_premium.assert_equal(_W(36 * 1/37))
    policy.ensuro_commission.assert_equal(_W(36 * 1/37 * 0.01))
    assert policy.id == rm.make_policy_id(111)

    with pytest.raises(RevertError, match="missing role"):
        rm.moc = _W("1.01")

    tenv.pool_config.grant_role("LEVEL2_ROLE", "DAO")
    with rm.as_("DAO"):
        rm.moc = _W("1.01")

    assert rm.moc == _W("1.01")

    with rm.as_("JOHN_SELLER"):
        policy2 = rm.new_policy(_W(36), _W(1), _W(1/37), expiration, "CUST1", 112)

    policy2.premium.assert_equal(_W(1))
    assert policy2.id == rm.make_policy_id(112)
    policy2.loss_prob.assert_equal(_W(1/37))
    policy2.pure_premium.assert_equal(_W(36 * 1/37) * _W("1.01"))
    policy2.ensuro_commission.assert_equal(_W(36 * 1/37 * 0.01) * _W("1.01"))


def test_minimum_premium(tenv):
    rm = tenv.rm_class(
        name="Roulette", coll_ratio=_W("0.2"), ensuro_pp_fee=_W("0.01"),
        sr_roc=_W("0.10"),
        max_payout_per_policy=_W(1000), exposure_limit=_W(1000000),
        wallet="CASINO"
    )
    tenv.pool_config.grant_role("LEVEL2_ROLE", "DAO")
    with rm.as_("DAO"):
        rm.moc = _W("1.3")

    expiration = tenv.time_control.now + WEEK
    pure_premium = _W(36/37) * _W("1.3")
    scr = _W(36) * _W("0.2") - pure_premium
    rm.get_minimum_premium(_W(36), _W(1/37), expiration).assert_equal(
        pure_premium * _W("1.01") + scr * _W(7/365) * _W("0.10")
    )
    minimum_premium = rm.get_minimum_premium(_W(36), _W(1/37), expiration)

    tenv.currency.transfer(tenv.currency.owner, "CUST1", _W(2))
    tenv.currency.approve("CUST1", rm.policy_pool, _W(2))

    tenv.pool_config.grant_component_role(rm, "PRICER_ROLE", "JOHN_SELLER")
    with rm.as_("JOHN_SELLER"), pytest.raises(RevertError, match="less than minimum"):
        policy = rm.new_policy(_W(36), _W("1.28"), _W(1/37), expiration, "CUST1", 222)

    with rm.as_("JOHN_SELLER"):
        policy = rm.new_policy(
            _W(36), rm.get_minimum_premium(_W(36), _W(1/37), expiration),
            _W(1/37), expiration, "CUST1", 222
        )

    policy.premium.assert_equal(minimum_premium, decimals=3)
    policy.loss_prob.assert_equal(_W(1/37))
    policy.pure_premium.assert_equal(_W(36 * 1/37 * 1.3))
    policy.ensuro_commission.assert_equal(policy.pure_premium * _W("0.01"))
