"""Unitary tests for premiums account contract"""
from email import policy
import pytest
from ethproto.contracts import RevertError, Contract, ERC20Token, ContractProxyField
from prototype import wrappers
from prototype import ensuro
from ethproto.wadray import _W, _R, Wad
from collections import namedtuple
from functools import partial
from prototype.utils import WEEK, DAY
from . import TEST_VARIANTS

TEnv = namedtuple("TEnv", "time_control currency pa_class pool_config kind")


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
            kind="prototype",
            pa_class=partial(ensuro.PremiumsAccount, pool=pool),
        )


def test_premiums_account_creation(tenv):
    assert tenv.pa_class().junior_etk == None
    assert tenv.pa_class().senior_etk == None

    pool = tenv.pa_class().pool
    premiums_account = tenv.pa_class(
        junior_etk=ensuro.EToken(policy_pool=pool, name="eUSD1MONTH"),
        senior_etk=ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    )

    premiums_account.active_pure_premiums.assert_equal(_W(0))
    premiums_account.borrowed_active_pp.assert_equal(_W(0))
    premiums_account.won_pure_premiums.assert_equal(_W(0))

    jr_etk = premiums_account.junior_etk
    sr_etk = premiums_account.senior_etk

    tenv.currency.allowance(
        premiums_account, jr_etk.contract_id).assert_equal(Wad(2**256 - 1))
    tenv.currency.allowance(
        premiums_account, sr_etk.contract_id).assert_equal(Wad(2**256 - 1))


def test_receive_grant(tenv):
    premiums_account = tenv.pa_class()

    assert tenv.currency.balance_of(tenv.currency.owner) == _W(1000)
    with pytest.raises(RevertError, match="transfer amount exceeds allowance"):
        premiums_account.receive_grant(tenv.currency.owner, _W(1000))

    tenv.currency.approve(tenv.currency.owner,
                          premiums_account, _W(1000))
    assert tenv.currency.allowance(
        tenv.currency.owner, premiums_account) == _W(1000)

    premiums_account.receive_grant(tenv.currency.owner, _W(100))

    premiums_account.active_pure_premiums.assert_equal(_W(0))
    premiums_account.borrowed_active_pp.assert_equal(_W(0))
    premiums_account.won_pure_premiums.assert_equal(_W(100))

    premiums_account.receive_grant(tenv.currency.owner, _W(200))
    premiums_account.won_pure_premiums.assert_equal(_W(300))


def test_withdraw_won_premiums(tenv):
    premiums_account = tenv.pa_class()
    tenv.pool_config.grant_role(
        "WITHDRAW_WON_PREMIUMS_ROLE", tenv.currency.owner)

    with pytest.raises(RevertError, match="No premiums to withdraw"):
        premiums_account.withdraw_won_premiums(_W(100))

    tenv.currency.approve(tenv.currency.owner,
                          premiums_account, _W(1000))
    assert tenv.currency.allowance(
        tenv.currency.owner, premiums_account) == _W(1000)

    premiums_account.receive_grant(tenv.currency.owner, _W(200))
    premiums_account.won_pure_premiums.assert_equal(_W(200))

    premiums_account.withdraw_won_premiums(_W(50))
    premiums_account.won_pure_premiums.assert_equal(_W(150))
    treasury_balance = tenv.currency.balance_of("ENS")
    treasury_balance.assert_equal(_W(50))

    premiums_account.withdraw_won_premiums(_W(500))
    premiums_account.won_pure_premiums.assert_equal(_W(0))
    treasury_balance = tenv.currency.balance_of("ENS")
    treasury_balance.assert_equal(_W(200))


def test_policy_created_without_etk_coll_ratio(tenv):
    premiums_account = tenv.pa_class()
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK
    pool = tenv.pa_class().pool

    rm = ensuro.TrustfulRiskModule(
        policy_pool=pool, premiums_account=premiums_account, name="Roulette")

    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(3600), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration,
                           )

    premiums_account.policy_created(policy)
    premiums_account.active_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc)
    premiums_account.borrowed_active_pp.assert_equal(_W(0))
    premiums_account.won_pure_premiums.assert_equal(_W(0))

    policy.sr_scr.assert_equal(_W(0))
    policy.jr_scr.assert_equal(_W(0))


def test_create_and_expire_policy_with_jr_etk(tenv):
    # Create policy
    pool = tenv.pa_class().pool
    premiums_account = tenv.pa_class(
        junior_etk=ensuro.EToken(policy_pool=pool, name="eUSD1MONTH"),
    )
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    rm = ensuro.TrustfulRiskModule(
        policy_pool=pool, premiums_account=premiums_account, name="Roulette")

    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(3600), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration,
                           )

    premiums_account.policy_created(policy)
    premiums_account.active_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc)

    # Expire policy
    premiums_account.policy_expired(policy)
    premiums_account.active_pure_premiums.assert_equal(_W(0))
    premiums_account.borrowed_active_pp.assert_equal(_W(0))
    premiums_account.won_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc)


def test_policy_resolved_with_payout(tenv):
    # Create policy
    pool = tenv.pa_class().pool
    premiums_account = tenv.pa_class(
        junior_etk=ensuro.EToken(policy_pool=pool, name="eUSD1MONTH"),
    )
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    rm = ensuro.TrustfulRiskModule(
        policy_pool=pool, premiums_account=premiums_account, name="Roulette")

    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(3600), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration,
                           )

    premiums_account.policy_created(policy)
    premiums_account.active_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc)
    policy.pure_premium.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    # Resolve policy
    with pytest.raises(RevertError, match="ERC20: transfer amount exceeds balance"):
        premiums_account.policy_resolved_with_payout(
            tenv.currency.owner, policy, _W(90))

    tenv.currency.approve(tenv.currency.owner, premiums_account, _W(1000))
    assert tenv.currency.allowance(
        tenv.currency.owner, premiums_account) == _W(1000)
    premiums_account.receive_grant(tenv.currency.owner, _W(100))

    premiums_account.policy_resolved_with_payout(
        tenv.currency.owner, policy, _W(90))
    premiums_account.active_pure_premiums.assert_equal(_W(0))
    premiums_account.borrowed_active_pp.assert_equal(_W(0))
    premiums_account.won_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc + _W(10))


def test_policy_created_with_jr_etoken(tenv):
    pool = tenv.pa_class().pool
    junior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1MONTH")
    premiums_account = tenv.pa_class(junior_etk=junior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, junior_etk, _W(1000))
    with junior_etk.thru_policy_pool():
        assert junior_etk.deposit("LP1", _W(1000)) == _W(1000)

    rm = ensuro.TrustfulRiskModule(
        policy_pool=pool, premiums_account=premiums_account, name="Roulette", jr_coll_ratio=_W("0.1"))

    rm.jr_coll_ratio.assert_equal(_W("0.1"))
    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(3600), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration)

    premiums_account.policy_created(policy)
    premiums_account.active_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc)

    policy.sr_scr.assert_equal(_W(0))
    policy.jr_scr.assert_equal(
        policy.payout * rm.jr_coll_ratio - policy.pure_premium)


def test_policy_created_with_sr_etoken(tenv):
    pool = tenv.pa_class().pool
    senior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    premiums_account = tenv.pa_class(senior_etk=senior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(1000))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(1000)) == _W(1000)

    rm = ensuro.TrustfulRiskModule(
        policy_pool=pool, premiums_account=premiums_account, name="Roulette", coll_ratio=_W("0.95"))
    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(600), premium=_W(100),
                           loss_prob=_W(1/37), start=start, expiration=expiration)

    premiums_account.policy_created(policy)
    premiums_account.active_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc)

    policy.jr_scr.assert_equal(_W(0))
    policy.sr_scr.assert_equal(
        policy.payout * rm.coll_ratio - policy.pure_premium - policy.jr_scr)


def test_policy_created_with_jr_and_sr_etoken(tenv):
    pool = tenv.pa_class().pool
    junior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1MONTH")
    senior_etk = ensuro.EToken(policy_pool=pool, name="eUSD1YEAR")
    premiums_account = tenv.pa_class(
        junior_etk=junior_etk, senior_etk=senior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(300))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(300)) == _W(300)

    rm = ensuro.TrustfulRiskModule(
        policy_pool=pool, premiums_account=premiums_account, name="Roulette", jr_coll_ratio=_W("0.1"), coll_ratio=_W("0.95"))

    rm.jr_coll_ratio.assert_equal(_W("0.1"))
    rm.coll_ratio.assert_equal(_W("0.95"))
    policy = ensuro.Policy(id=1, risk_module=rm, payout=_W(100), premium=_W(30),
                           loss_prob=_W(1/37), start=start, expiration=expiration)

    with pytest.raises(RevertError, match="Not enought funds available to cover the SCR"):
        premiums_account.policy_created(policy)

    tenv.currency.transfer(tenv.currency.owner, junior_etk, _W(300))
    with junior_etk.thru_policy_pool():
        assert junior_etk.deposit("LP1", _W(300)) == _W(300)

    premiums_account.policy_created(policy)

    premiums_account.active_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc)

    policy.jr_scr.assert_equal(
        policy.payout * rm.jr_coll_ratio - policy.pure_premium)
    policy.sr_scr.assert_equal(
        policy.payout * rm.coll_ratio - policy.pure_premium - policy.jr_scr)

    junior_etk.add_borrower(premiums_account)
    senior_etk.add_borrower(premiums_account)

    tenv.currency.approve(tenv.currency.owner, premiums_account, _W(1000))
    premiums_account.receive_grant(tenv.currency.owner, _W(100))

    premiums_account.policy_resolved_with_payout(
        tenv.currency.owner, policy, _W(90))
    premiums_account.active_pure_premiums.assert_equal(_W(0))
    premiums_account.borrowed_active_pp.assert_equal(_W(0))
    premiums_account.won_pure_premiums.assert_equal(
        policy.payout * policy.loss_prob * rm.moc + _W(10))

    policy.jr_scr.assert_equal(
        policy.payout * rm.jr_coll_ratio - policy.pure_premium)
    policy.sr_scr.assert_equal(
        policy.payout * rm.coll_ratio - policy.pure_premium - policy.jr_scr)
