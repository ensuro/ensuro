"""Unitary tests for premiums account contract"""
import pytest
from ethproto.contracts import RevertError, Contract, ERC20Token, ContractProxyField
from prototype import wrappers
from prototype import ensuro
from ethproto.wrappers import get_provider
from ethproto.wadray import _W, Wad
from collections import namedtuple
from functools import partial
from prototype.utils import WEEK, DAY
from . import TEST_VARIANTS

MAX_UINT = Wad(2**256 - 1)
TEnv = namedtuple("TEnv", "time_control currency module pa_class pool_config kind")

# @pytest.fixture(params=TEST_VARIANTS)
@pytest.fixture(params=["prototype"])
def tenv(request):
    if request.param == "prototype":
        currency = ERC20Token(owner="owner", name="TEST",
                              symbol="TEST", initial_supply=_W(1000))
        pool_config = ensuro.PolicyPoolConfig()

        class PolicyPoolMock(Contract):
            currency = ContractProxyField()
            config = pool_config

            def new_policy(self, policy, customer, internal_id):
                return policy.risk_module.make_policy_id(internal_id)

            def resolve_policy(self, policy_id, customer_won):
                pass

        pool = PolicyPoolMock(currency=currency)

        return TEnv(
            currency=currency,
            time_control=ensuro.time_control,
            pool_config=pool_config,
            module=ensuro,
            kind="prototype",
            pa_class=partial(ensuro.PremiumsAccount, pool=pool),
        )


def test_premiums_account_creation(tenv):
    pool = tenv.pa_class().pool
    pa = tenv.pa_class(
        junior_etk=ensuro.EToken(policy_pool=pool, name="eUSD1MONTH"),
        senior_etk=ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    )

    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(_W(0))

    jr_etk = pa.junior_etk
    sr_etk = pa.senior_etk

    tenv.currency.allowance(pa, jr_etk.contract_id).assert_equal(MAX_UINT)
    tenv.currency.allowance(pa, sr_etk.contract_id).assert_equal(MAX_UINT)


def test_receive_grant(tenv):
    pa = tenv.pa_class()

    assert tenv.currency.balance_of(tenv.currency.owner) == _W(1000)
    with pytest.raises(RevertError, match="transfer amount exceeds allowance"):
        pa.receive_grant(tenv.currency.owner, _W(1000))

    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(1000)

    pa.receive_grant(tenv.currency.owner, _W(100))

    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(_W(100))

    pa.receive_grant(tenv.currency.owner, _W(200))
    pa.won_pure_premiums.assert_equal(_W(300))


def test_withdraw_won_premiums(tenv):
    pa = tenv.pa_class()
    tenv.pool_config.grant_role(
        "WITHDRAW_WON_PREMIUMS_ROLE", tenv.currency.owner)

    with pytest.raises(RevertError, match="No premiums to withdraw"):
        pa.withdraw_won_premiums(_W(100))

    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(1000)

    pa.receive_grant(tenv.currency.owner, _W(200))
    pa.won_pure_premiums.assert_equal(_W(200))

    pa.withdraw_won_premiums(_W(50))
    pa.won_pure_premiums.assert_equal(_W(150))
    treasury_balance = tenv.currency.balance_of("ENS")
    treasury_balance.assert_equal(_W(50))

    pa.withdraw_won_premiums(_W(500))
    pa.won_pure_premiums.assert_equal(_W(0))
    treasury_balance = tenv.currency.balance_of("ENS")
    treasury_balance.assert_equal(_W(200))


def test_policy_created_without_etokens(tenv):
    pa = tenv.pa_class()

    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK
    pool = tenv.pa_class().pool

    rm = tenv.module.TrustfulRiskModule(policy_pool=pool, premiums_account=pa, name="Roulette")
    rm.coll_ratio.assert_equal(_W(1))

    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(3600), premium=_W(3600),
                           loss_prob=_W(1), start=start, expiration=expiration)

    policy.pure_premium.assert_equal(_W(3600))
    policy.jr_scr.assert_equal(0)
    policy.sr_scr.assert_equal(0)

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    rm_2 = tenv.module.TrustfulRiskModule(policy_pool=pool, premiums_account=pa,
                                        coll_ratio=_W("0.5"), name="Roulette")
    rm_2.coll_ratio.assert_equal(_W("0.5"))

    policy_2 = ensuro.Policy(id=2, risk_module=rm_2, payout=_W(3600), premium=_W(3600),
                           loss_prob=_W("0.6"), start=start, expiration=expiration,
                           )

    policy_2.pure_premium.assert_equal(_W(3600) * _W("0.6"))
    policy_2.jr_scr.assert_equal(0)
    policy_2.sr_scr.assert_equal(0)

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)
    pa.active_pure_premiums.assert_equal(policy_2.pure_premium + policy.pure_premium)


def test_create_and_expire_policy_with_sr_etk(tenv):
    # Create policy
    pool = tenv.pa_class().pool
    senior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    pa = tenv.pa_class(
        senior_etk=senior_etk,
    )
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(700))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(700)) == _W(700)

    rm = tenv.module.TrustfulRiskModule(policy_pool=pool, premiums_account=pa, name="Roulette")
    senior_etk.add_borrower(pa)

    rm.coll_ratio.assert_equal(_W(1))

    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(300), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration,
                           )

    policy_2 = ensuro.Policy(id=2, risk_module=rm, payout=_W(400), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration,
                           )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)
    pa.active_pure_premiums.assert_equal(policy_2.payout * policy_2.loss_prob * rm.moc + policy.payout * policy.loss_prob * rm.moc)

    tenv.time_control.fast_forward(5 * DAY)

    # Expire policy
    pa.policy_expired(policy)
    pa.active_pure_premiums.assert_equal(policy_2.payout * policy_2.loss_prob * rm.moc)
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    # Resolve policy_2
    with pytest.raises(RevertError, match="ERC20: transfer amount exceeds balance"):
        pa.policy_resolved_with_payout(
            tenv.currency.owner, policy_2, _W(90))

    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    assert tenv.currency.allowance(
        tenv.currency.owner, pa) == _W(1000)
    pa.receive_grant(tenv.currency.owner, _W(100))

    pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(100))
    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(policy_2.payout * policy_2.loss_prob * rm.moc + policy.payout * policy.loss_prob * rm.moc)


def test_policy_resolved_with_payout(tenv):
    # Create policy
    pool = tenv.pa_class().pool
    senior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    pa = tenv.pa_class(
        senior_etk=senior_etk,
    )
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK
    senior_etk.add_borrower(pa)

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(800))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(800)) == _W(800)

    rm = tenv.module.TrustfulRiskModule(
        policy_pool=pool, premiums_account=pa, name="Roulette")

    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(600), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration,
                           )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)
    policy.pure_premium.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    # Resolve policy
    with pytest.raises(RevertError, match="ERC20: transfer amount exceeds balance"):
        pa.policy_resolved_with_payout(
            tenv.currency.owner, policy, _W(90))

    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    assert tenv.currency.allowance(
        tenv.currency.owner, pa) == _W(1000)
    pa.receive_grant(tenv.currency.owner, _W(100))

    pa.policy_resolved_with_payout(
        tenv.currency.owner, policy, _W(90))
    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc + _W(10))


def test_policy_created_with_jr_etoken(tenv):
    pool = tenv.pa_class().pool
    junior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1MONTH")
    pa = tenv.pa_class(junior_etk=junior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, junior_etk, _W(900))
    with junior_etk.thru_policy_pool():
        assert junior_etk.deposit("LP1", _W(900)) == _W(900)

    rm = tenv.module.TrustfulRiskModule(
        policy_pool=pool, premiums_account=pa, name="Roulette", coll_ratio=_W("0.5"))

    rm.coll_ratio.assert_equal(_W("0.5"))
    tenv.pool_config.grant_role("LEVEL2_ROLE", tenv.currency.owner)
    rm.jr_coll_ratio = _W("0.8")

    rm.jr_coll_ratio.assert_equal(_W("0.8"))
    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(600), premium=_W(2500),
                           loss_prob=_W("0.6"), start=start, expiration=expiration)

    policy_2 = ensuro.Policy(id=2, risk_module=rm, payout=_W(300), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration,
                           )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    policy.sr_scr.assert_equal(_W(0))
    policy.jr_scr.assert_equal(policy.payout * rm.jr_coll_ratio - policy.pure_premium)

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)
    pa.active_pure_premiums.assert_equal(policy_2.payout * policy_2.loss_prob * rm.moc + policy.payout * policy.loss_prob * rm.moc)

    tenv.time_control.fast_forward(5 * DAY)

    # Expire policy
    pa.policy_expired(policy)
    pa.active_pure_premiums.assert_equal(policy_2.payout * policy_2.loss_prob * rm.moc)
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    # Resolve policy_2
    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    assert tenv.currency.allowance(
        tenv.currency.owner, pa) == _W(1000)
    pa.receive_grant(tenv.currency.owner, _W(100))

    pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(100))
    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(policy_2.payout * policy_2.loss_prob * rm.moc + policy.payout * policy.loss_prob * rm.moc)


def test_policy_created_with_sr_etoken(tenv):
    pool = tenv.pa_class().pool
    senior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    pa = tenv.pa_class(senior_etk=senior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(1000))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(1000)) == _W(1000)

    rm = tenv.module.TrustfulRiskModule(
        policy_pool=pool, premiums_account=pa, name="Roulette", coll_ratio=_W("0.95"))

    rm.coll_ratio.assert_equal(_W("0.95"))
    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(600), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration)

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    policy.jr_scr.assert_equal(_W(0))
    policy.sr_scr.assert_equal(policy.payout * rm.coll_ratio - policy.pure_premium)


def test_policy_created_with_jr_and_sr_etoken(tenv):
    pool = tenv.pa_class().pool
    junior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1MONTH")
    senior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    pa = tenv.pa_class(junior_etk=junior_etk, senior_etk=senior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(300))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(300)) == _W(300)

    rm = tenv.module.TrustfulRiskModule(
        policy_pool=pool, premiums_account=pa, name="Roulette", coll_ratio=_W("0.95"))

    tenv.pool_config.grant_role("LEVEL2_ROLE", tenv.currency.owner)
    rm.jr_coll_ratio = _W("0.1")

    rm.jr_coll_ratio.assert_equal(_W("0.1"))
    rm.coll_ratio.assert_equal(_W("0.95"))
    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(100), premium=_W(30),
                           loss_prob=_W(1/37), start=start, expiration=expiration)

    with pytest.raises(RevertError, match="Not enought funds available to cover the SCR"):
        pa.policy_created(policy)

    tenv.currency.transfer(tenv.currency.owner, junior_etk, _W(300))
    with junior_etk.thru_policy_pool():
        assert junior_etk.deposit("LP1", _W(300)) == _W(300)

    with pa.thru_policy_pool():
        pa.policy_created(policy)

    pa.active_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc)

    policy.jr_scr.assert_equal(
        policy.payout * rm.jr_coll_ratio - policy.pure_premium)
    policy.sr_scr.assert_equal(
        policy.payout * rm.coll_ratio - policy.pure_premium - policy.jr_scr)

    junior_etk.add_borrower(pa)
    senior_etk.add_borrower(pa)

    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    pa.receive_grant(tenv.currency.owner, _W(100))

    pa.policy_resolved_with_payout(
        tenv.currency.owner, policy, _W(90))
    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc + _W(10))

    policy.jr_scr.assert_equal(
        policy.payout * rm.jr_coll_ratio - policy.pure_premium)
    policy.sr_scr.assert_equal(
        policy.payout * rm.coll_ratio - policy.pure_premium - policy.jr_scr)
