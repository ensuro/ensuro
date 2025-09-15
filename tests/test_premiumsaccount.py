"""Unitary tests for premiums account contract"""

from collections import namedtuple
from functools import partial

import pytest
from ethproto.contracts import Contract, ContractProxyField, ERC20Token, RevertError
from ethproto.wadray import _W, Wad
from ethproto.wrappers import get_provider

from prototype import ensuro, wrappers
from prototype.ensuro import RiskModule
from prototype.utils import DAY, WEEK

from . import TEST_VARIANTS
from .contracts import PolicyPoolMockForward

MAX_UINT = Wad(2**256 - 1)
TEnv = namedtuple("TEnv", "currency time_control kind pa_class etk module")


@pytest.fixture(params=TEST_VARIANTS)
def tenv(request):
    if request.param == "prototype":
        currency = ERC20Token(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(10000))

        class PolicyPoolMock(Contract):
            currency = ContractProxyField()

            def new_policy(self, policy, customer, internal_id):
                return policy.risk_module.make_policy_id(internal_id)

            def resolve_policy(self, policy_id, customer_won):
                pass

        pool = PolicyPoolMock(currency=currency)

        return TEnv(
            currency=currency,
            time_control=ensuro.time_control,
            kind="prototype",
            etk=partial(ensuro.EToken, policy_pool=pool),
            pa_class=partial(ensuro.PremiumsAccount, pool=pool),
            module=ensuro,
        )
    elif request.param == "ethereum":
        currency = wrappers.TestCurrency(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(10000))

        def etoken_factory(**kwargs):
            pool = PolicyPoolMockForward(
                forwardTo=wrappers.AddressBook.ZERO,
                currency_=currency.contract,
                owner="owner",
            )
            symbol = kwargs.pop("symbol", "ETK")
            etoken = wrappers.EToken(policy_pool=pool, symbol=symbol, **kwargs)
            pool.setForwardTo(etoken.contract, {"from": currency.owner})
            return etoken

        def pa_factory(**kwargs):
            pa_pool = PolicyPoolMockForward(
                forwardTo=wrappers.AddressBook.ZERO,
                currency_=currency.contract,
                owner="owner",
            )
            pa = wrappers.PremiumsAccount(pool=pa_pool, **kwargs)
            pa_pool.setForwardTo(pa.contract, {"from": currency.owner})
            return pa

        return TEnv(
            currency=currency,
            time_control=get_provider().time_control,
            kind="ethereum",
            etk=etoken_factory,
            pa_class=pa_factory,
            module=wrappers,
        )


def test_premiums_account_creation(tenv):
    pa = tenv.pa_class(
        junior_etk=tenv.etk(name="eUSD1MONTH", symbol="ETK1"),
        senior_etk=tenv.etk(name="eUSD1YEAR", symbol="ETK2"),
    )

    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(_W(0))

    jr_etk = pa.junior_etk
    sr_etk = pa.senior_etk

    tenv.currency.allowance(pa, jr_etk).assert_equal(_W(0))
    tenv.currency.allowance(pa, sr_etk).assert_equal(_W(0))


def test_receive_grant(tenv):
    pa = tenv.pa_class()

    with pytest.raises(
        RevertError,
        match="transfer amount exceeds allowance|insufficient allowance|ERC20InsufficientAllowance",
    ):
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
    treasury = "ENS"

    with pytest.raises(RevertError, match="InvalidDestination"):
        pa.withdraw_won_premiums(_W(100), None)

    with pytest.raises(RevertError, match="WithdrawExceedsSurplus"):
        pa.withdraw_won_premiums(_W(100), treasury)

    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(1000)

    pa.receive_grant(tenv.currency.owner, _W(200))
    pa.won_pure_premiums.assert_equal(_W(200))

    pa.withdraw_won_premiums(_W(50), treasury)
    pa.won_pure_premiums.assert_equal(_W(150))
    treasury_balance = tenv.currency.balance_of(treasury)
    treasury_balance.assert_equal(_W(50))

    with pytest.raises(RevertError, match="WithdrawExceedsSurplus"):
        pa.withdraw_won_premiums(_W(500), treasury)
    pa.withdraw_won_premiums(None, treasury)  # None == MAX_UINT --> as much as possible
    pa.won_pure_premiums.assert_equal(_W(0))
    treasury_balance = tenv.currency.balance_of(treasury)
    treasury_balance.assert_equal(_W(200))


def test_withdraw_won_premiums_with_borrowed_active_pp(tenv):
    # Create policy
    senior_etk = tenv.etk(name="eUSD1YEAR")
    pa = tenv.pa_class(senior_etk=senior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(300))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(300)) == _W(300)
        senior_etk.add_borrower(pa)

    rm = RiskModule(premiums_account="dummy", name="Roulette", policy_pool="dummy")

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(36),
        premium=_W(1),
        loss_prob=_W(1 / 37),
        start=start,
        expiration=expiration,
    )

    policy_2 = ensuro.Policy(
        id=2,
        risk_module=rm,
        payout=_W(72),
        premium=_W(2),
        loss_prob=_W(1 / 37),
        start=start,
        expiration=expiration,
    )

    if tenv.kind == "ethereum":
        with pytest.raises(RevertError, match="OnlyPolicyPool()"):
            pa.policy_created(policy)

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)
    pa.active_pure_premiums.assert_equal(
        policy_2.payout * policy_2.loss_prob * rm.moc + policy.payout * policy.loss_prob * rm.moc
    )

    pure_premiums = pa.active_pure_premiums

    tenv.time_control.fast_forward(2 * DAY)

    # Resolve policy
    tenv.currency.transfer(tenv.currency.owner, pa, policy.pure_premium + policy_2.pure_premium)
    tenv.currency.approve(tenv.currency.owner, pa, _W(100))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(100)

    if tenv.kind == "ethereum":
        with pytest.raises(RevertError, match="OnlyPolicyPool()"):
            pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(12))

    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(12))

    senior_etk.get_loan(pa).assert_equal(_W(12) - pure_premiums)
    senior_loan = senior_etk.get_loan(pa)

    pa.borrowed_active_pp.assert_equal(policy.payout * policy.loss_prob * rm.moc)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)
    pa.won_pure_premiums.assert_equal(_W(0))

    tenv.currency.allowance(pa, senior_etk).assert_equal(_W(0))

    # Expire policy
    if tenv.kind == "ethereum":
        with pytest.raises(RevertError, match="OnlyPolicyPool()"):
            pa.policy_expired(policy)

    with pa.thru_policy_pool():
        pa.policy_expired(policy)

    # Senior unchanged, allowance remains 0 because no repayment made - won premium used to cover deficit
    senior_etk.get_loan(pa).assert_equal(senior_loan)
    tenv.currency.allowance(pa, senior_etk).assert_equal(_W(0))

    # Create new policy and expire it
    tenv.currency.transfer(tenv.currency.owner, pa, policy.pure_premium)
    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)
    with pa.thru_policy_pool():
        pa.policy_expired(policy)

    assert pa.funds_available == policy.pure_premium
    senior_etk.get_loan(pa).assert_equal(senior_loan)

    pa.repay_loans()
    senior_etk.get_loan(pa).assert_equal(senior_loan - policy.pure_premium)
    assert pa.funds_available == _W(0)

    tenv.currency.allowance(pa, senior_etk).assert_equal(senior_loan - policy.pure_premium)
    senior_loan = senior_etk.get_loan(pa)

    pa.receive_grant(tenv.currency.owner, _W(100))
    assert pa.funds_available == _W(100)
    pa.repay_loans()
    pa.won_pure_premiums.assert_equal(_W(100) - senior_loan)

    senior_etk.get_loan(pa).assert_equal(_W(0))
    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))


def test_policy_created_without_etokens(tenv):
    pa = tenv.pa_class()

    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    rm = RiskModule(premiums_account="dummy", name="Roulette", policy_pool="dummy")
    rm.coll_ratio.assert_equal(_W(1))

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(3600),
        premium=_W(3600),
        loss_prob=_W(1),
        start=start,
        expiration=expiration,
    )

    policy.pure_premium.assert_equal(_W(3600))
    policy.jr_scr.assert_equal(0)
    policy.sr_scr.assert_equal(0)

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    rm_2 = RiskModule(
        premiums_account="dummy",
        name="Roulette",
        policy_pool="dummy",
        coll_ratio=_W("0.5"),
    )
    rm_2.coll_ratio.assert_equal(_W("0.5"))

    policy_2 = ensuro.Policy(
        id=2,
        risk_module=rm_2,
        payout=_W(3600),
        premium=_W(3600),
        loss_prob=_W("0.6"),
        start=start,
        expiration=expiration,
    )

    policy_2.pure_premium.assert_equal(_W(3600) * _W("0.6"))
    policy_2.jr_scr.assert_equal(0)
    policy_2.sr_scr.assert_equal(0)

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)
    pa.active_pure_premiums.assert_equal(policy_2.pure_premium + policy.pure_premium)


def test_create_and_expire_policy_with_sr_etk(tenv):
    # Create policy
    senior_etk = tenv.etk(name="eUSD1YEAR", symbol="ETK1")
    pa = tenv.pa_class(
        senior_etk=senior_etk,
    )
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(900))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(900)) == _W(900)
        senior_etk.add_borrower(pa)

    rm = RiskModule(premiums_account="dummy", name="Roulette", policy_pool="dummy")
    rm.coll_ratio.assert_equal(_W(1))

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(300),
        premium=_W(100),
        loss_prob=_W(1 / 37),
        start=start,
        expiration=expiration,
    )

    policy_2 = ensuro.Policy(
        id=2,
        risk_module=rm,
        payout=_W(400),
        premium=_W(100),
        loss_prob=_W(1 / 37),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)
    pa.active_pure_premiums.assert_equal(
        policy_2.payout * policy_2.loss_prob * rm.moc + policy.payout * policy.loss_prob * rm.moc
    )

    tenv.time_control.fast_forward(5 * DAY)

    # Expire policy
    with pa.thru_policy_pool():
        pa.policy_expired(policy)
    pa.active_pure_premiums.assert_equal(policy_2.payout * policy_2.loss_prob * rm.moc)
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    # Resolve policy_2
    with pytest.raises(RevertError, match="ERC20: transfer amount exceeds balance|ERC20InsufficientBalance"):
        with pa.thru_policy_pool():
            pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(90))

    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(1000)
    pa.receive_grant(tenv.currency.owner, _W(100))

    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(100))
    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(
        policy_2.payout * policy_2.loss_prob * rm.moc + policy.payout * policy.loss_prob * rm.moc
    )


def test_policy_resolved_with_payout(tenv):
    # Create policy
    senior_etk = tenv.etk(name="eUSD1YEAR", symbol="ETK1")
    pa = tenv.pa_class(
        senior_etk=senior_etk,
    )
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(800))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(800)) == _W(800)
        senior_etk.add_borrower(pa)

    rm = RiskModule(premiums_account="dummy", name="Roulette", policy_pool="dummy")

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(600),
        premium=_W(100),
        loss_prob=_W(1 / 37),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)
    policy.pure_premium.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    # Resolve policy
    with pytest.raises(RevertError, match="ERC20: transfer amount exceeds balance|ERC20InsufficientBalance"):
        with pa.thru_policy_pool():
            pa.policy_resolved_with_payout(tenv.currency.owner, policy, _W(90))

    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(1000)
    pa.receive_grant(tenv.currency.owner, _W(100))

    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy, _W(90))
    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc + _W(10))


def test_policy_created_with_jr_etoken(tenv):
    junior_etk = tenv.etk(name="eUSD1MONTH", symbol="ETK1")
    pa = tenv.pa_class(junior_etk=junior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, junior_etk, _W(900))
    with junior_etk.thru_policy_pool():
        assert junior_etk.deposit("LP1", _W(900)) == _W(900)
        junior_etk.add_borrower(pa)

    with pytest.raises(RevertError, match="Validation: collRatio >= jrCollRatio"):
        rm = RiskModule(
            premiums_account="dummy",
            name="Roulette",
            policy_pool="dummy",
            coll_ratio=_W("0.5"),
            jr_coll_ratio=_W("0.8"),
        )

    rm = RiskModule(
        premiums_account="dummy",
        name="Roulette",
        policy_pool="dummy",
        coll_ratio=_W("0.5"),
        jr_coll_ratio=_W("0.4"),
    )

    rm.coll_ratio.assert_equal(_W("0.5"))

    rm.jr_coll_ratio.assert_equal(_W("0.4"))
    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(600),
        premium=_W(2500),
        loss_prob=_W("0.6"),
        start=start,
        expiration=expiration,
    )

    policy_2 = ensuro.Policy(
        id=2,
        risk_module=rm,
        payout=_W(600),
        premium=_W(2500),
        loss_prob=_W("0.6"),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    policy.sr_scr.assert_equal(_W(0))
    policy.jr_scr.assert_equal(_W(0))

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)
    pa.active_pure_premiums.assert_equal(
        policy_2.payout * policy_2.loss_prob * rm.moc + policy.payout * policy.loss_prob * rm.moc
    )

    tenv.time_control.fast_forward(5 * DAY)

    # Expire policy
    with pa.thru_policy_pool():
        pa.policy_expired(policy)
    pa.active_pure_premiums.assert_equal(policy_2.payout * policy_2.loss_prob * rm.moc)
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    # Resolve policy_2
    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(1000)
    pa.receive_grant(tenv.currency.owner, _W(100))

    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(100))
    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(
        policy_2.payout * policy_2.loss_prob * rm.moc + policy.payout * policy.loss_prob * rm.moc
    )


def test_policy_created_with_sr_etoken(tenv):
    senior_etk = tenv.etk(name="eUSD1YEAR", symbol="ETK1")
    pa = tenv.pa_class(senior_etk=senior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(1000))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(1000)) == _W(1000)
        senior_etk.add_borrower(pa)

    rm = RiskModule(
        premiums_account="dummy",
        name="Roulette",
        policy_pool="dummy",
        coll_ratio=_W("0.2"),
    )

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(600),
        premium=_W(400),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    policy.jr_scr.assert_equal(_W(0))
    policy.sr_scr.assert_equal(_W(0))


def test_policy_created_with_jr_and_sr_etoken(tenv):
    junior_etk = tenv.etk(name="eUSD1MONTH", symbol="ETK1")
    senior_etk = tenv.etk(name="eUSD1YEAR", symbol="ETK2")
    pa = tenv.pa_class(junior_etk=junior_etk, senior_etk=senior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(300))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(300)) == _W(300)
        senior_etk.add_borrower(pa)

    rm = RiskModule(
        premiums_account="dummy",
        name="Roulette",
        policy_pool="dummy",
        coll_ratio=_W("0.95"),
        jr_coll_ratio=_W("0.1"),
    )
    rm.jr_coll_ratio.assert_equal(_W("0.1"))
    rm.coll_ratio.assert_equal(_W("0.95"))

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(100),
        premium=_W(30),
        loss_prob=_W(1 / 37),
        start=start,
        expiration=expiration,
    )

    tenv.currency.transfer(tenv.currency.owner, junior_etk, _W(300))
    with junior_etk.thru_policy_pool():
        assert junior_etk.deposit("LP1", _W(300)) == _W(300)
        junior_etk.add_borrower(pa)

    with pa.thru_policy_pool():
        pa.policy_created(policy)

    pa.active_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc)

    policy.jr_scr.assert_equal(policy.payout * rm.jr_coll_ratio - policy.pure_premium)
    policy.sr_scr.assert_equal(policy.payout * rm.coll_ratio - policy.pure_premium - policy.jr_scr)

    tenv.currency.approve(tenv.currency.owner, pa, _W(1000))
    pa.receive_grant(tenv.currency.owner, _W(100))

    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy, _W(90))

    pa.active_pure_premiums.assert_equal(_W(0))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(policy.payout * policy.loss_prob * rm.moc + _W(10))

    policy.jr_scr.assert_equal(policy.payout * rm.jr_coll_ratio - policy.pure_premium)
    policy.sr_scr.assert_equal(policy.payout * rm.coll_ratio - policy.pure_premium - policy.jr_scr)


def test_pay_from_premium(tenv):
    senior_etk = tenv.etk(name="eUSD1YEAR", symbol="ETK1")
    pa = tenv.pa_class(senior_etk=senior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(800))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(800)) == _W(800)
        senior_etk.add_borrower(pa)

    rm = RiskModule(
        premiums_account="dummy",
        name="Roulette",
        policy_pool="dummy",
        coll_ratio=_W("0.95"),
    )
    rm.coll_ratio.assert_equal(_W("0.95"))

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(20),
        premium=_W(10),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(_W(10))

    policy_2 = ensuro.Policy(
        id=2,
        risk_module=rm,
        payout=_W(20),
        premium=_W(10),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)

    pa.active_pure_premiums.assert_equal(_W(20))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(_W(0))

    # Resolve policy
    tenv.currency.transfer(tenv.currency.owner, pa, _W(20))
    tenv.currency.approve(tenv.currency.owner, pa, _W(20))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(20)

    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(20))

    pa.active_pure_premiums.assert_equal(_W(10))
    pa.borrowed_active_pp.assert_equal(_W(10))
    pa.won_pure_premiums.assert_equal(_W(0))

    # with pytest.raises(RevertError, match="ERC20: transfer amount exceeds balance"):
    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy, _W(20))


def test_payout_equal_pure_premium(tenv):
    senior_etk = tenv.etk(name="eUSD1YEAR", symbol="ETK1")
    pa = tenv.pa_class(senior_etk=senior_etk)
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(1000))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(1000)) == _W(1000)
        senior_etk.add_borrower(pa)

    rm = RiskModule(
        premiums_account="dummy",
        name="Roulette",
        policy_pool="dummy",
        coll_ratio=_W("1"),
    )

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(20),
        premium=_W(12),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(_W(10))

    policy_2 = ensuro.Policy(
        id=2,
        risk_module=rm,
        payout=_W(20),
        premium=_W(12),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)

    pa.active_pure_premiums.assert_equal(_W(20))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(_W(0))

    # Replicate premium transfers
    tenv.currency.transfer(tenv.currency.owner, pa, policy.pure_premium + policy_2.pure_premium)
    tenv.currency.transfer(tenv.currency.owner, senior_etk, policy.sr_coc + policy_2.sr_coc)

    # Resolve 1st policy
    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(20))

    pa.active_pure_premiums.assert_equal(_W(10))
    pa.borrowed_active_pp.assert_equal(_W(10))
    pa.won_pure_premiums.assert_equal(_W(0))

    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy, _W(10))


def test_set_loan_limits(tenv):
    pa = tenv.pa_class(
        junior_etk=tenv.etk(name="eUSD1MONTH", symbol="ETK1"),
        senior_etk=tenv.etk(name="eUSD1YEAR", symbol="ETK2"),
    )

    assert pa.jr_loan_limit == MAX_UINT
    assert pa.sr_loan_limit == MAX_UINT

    with pa.as_("ADMIN"):
        pa.set_loan_limits(_W(1), _W(2))

    assert pa.jr_loan_limit == _W(1)
    assert pa.sr_loan_limit == _W(2)

    with pa.as_("ADMIN"):
        pa.set_loan_limits(_W(3), None)

    assert pa.jr_loan_limit == _W(3)
    assert pa.sr_loan_limit == _W(2)

    with pa.as_("ADMIN"):
        pa.set_loan_limits(None, _W(4))

    assert pa.jr_loan_limit == _W(3)
    assert pa.sr_loan_limit == _W(4)

    with pa.as_("ADMIN"):
        pa.set_loan_limits(_W(0), None)

    assert pa.jr_loan_limit == MAX_UINT
    assert pa.sr_loan_limit == _W(4)

    with pa.as_("ADMIN"):
        pa.set_loan_limits(None, _W(0))

    assert pa.jr_loan_limit == MAX_UINT
    assert pa.sr_loan_limit == MAX_UINT

    if tenv.kind != "ethereum":
        return

    with pa.as_("ADMIN"), pytest.raises(RevertError, match="InvalidLoanLimit"):
        pa.set_loan_limits(_W("13.12"), None)

    with pa.as_("ADMIN"), pytest.raises(RevertError, match="InvalidLoanLimit"):
        pa.set_loan_limits(None, _W("13.12"))

    with pa.as_("ADMIN"):
        pa.set_loan_limits(_W(21), _W(12))

    assert pa.jr_loan_limit == _W(21)
    assert pa.sr_loan_limit == _W(12)


def test_set_deficit_ratio(tenv):
    pa = tenv.pa_class(
        junior_etk=tenv.etk(name="eUSD1MONTH", symbol="ETK1"),
        senior_etk=tenv.etk(name="eUSD1YEAR", symbol="ETK2"),
    )

    with pytest.raises(RevertError, match="InvalidDeficitRatio"):
        pa.set_deficit_ratio(_W("1.7"), True)

    pa.set_deficit_ratio(_W("0.7"), True)
    pa.deficit_ratio.assert_equal(_W("0.7"))


def test_set_deficit_ratio_without_adjustment(tenv):
    senior_etk = tenv.etk(name="eUSD1YEAR", symbol="ETK2")
    pa = tenv.pa_class(
        senior_etk=senior_etk,
    )
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(500))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(500)) == _W(500)
        senior_etk.add_borrower(pa)

    rm = RiskModule(
        premiums_account="dummy",
        name="Roulette",
        policy_pool="dummy",
        coll_ratio=_W("0.95"),
    )

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(20),
        premium=_W(10),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(_W(10))

    pa.funds_available.assert_equal(_W(10))

    senior_etk.balance_of("LP1").assert_equal(_W(500))
    senior_etk.get_loan(pa).assert_equal(_W(0))

    pa.set_deficit_ratio(_W("0.7"), False)
    pa.deficit_ratio.assert_equal(_W("0.7"))
    pa.funds_available.assert_equal(_W(7))  # Funds available to repay loans or cover losses decrease

    pa.active_pure_premiums.assert_equal(_W(10))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(_W(0))

    senior_etk.balance_of("LP1").assert_equal(_W(500))
    senior_etk.get_loan(pa).assert_equal(_W(0))


def test_ratio_adjustment(tenv):
    junior_etk = tenv.etk(name="eUSD1MONTH", symbol="ETK1")
    senior_etk = tenv.etk(name="eUSD1YEAR", symbol="ETK2")
    pa = tenv.pa_class(
        junior_etk=junior_etk,
        senior_etk=senior_etk,
    )
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(500))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(500)) == _W(500)
        senior_etk.add_borrower(pa)

    tenv.currency.transfer(tenv.currency.owner, junior_etk, _W(300))
    with junior_etk.thru_policy_pool():
        assert junior_etk.deposit("LP1", _W(300)) == _W(300)
        junior_etk.add_borrower(pa)

    rm = RiskModule(
        premiums_account="dummy",
        name="Roulette",
        policy_pool="dummy",
        coll_ratio=_W("0.95"),
    )

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(20),
        premium=_W(10),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy)
    pa.active_pure_premiums.assert_equal(_W(10))

    policy_2 = ensuro.Policy(
        id=2,
        risk_module=rm,
        payout=_W(20),
        premium=_W(10),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)

    pa.active_pure_premiums.assert_equal(_W(20))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(_W(0))

    # Resolve policy
    tenv.currency.transfer(tenv.currency.owner, pa, _W(20))
    tenv.currency.approve(tenv.currency.owner, pa, _W(20))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(20)

    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy_2, _W(20))

    pa.active_pure_premiums.assert_equal(_W(10))
    pa.borrowed_active_pp.assert_equal(_W(10))
    pa.won_pure_premiums.assert_equal(_W(0))

    policy_3 = ensuro.Policy(
        id=3,
        risk_module=rm,
        payout=_W(20),
        premium=_W(10),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy_3)

    pa.active_pure_premiums.assert_equal(_W(20))
    pa.borrowed_active_pp.assert_equal(_W(10))
    pa.won_pure_premiums.assert_equal(_W(0))

    junior_etk.balance_of("LP1").assert_equal(_W(300))
    senior_etk.balance_of("LP1").assert_equal(_W(500))
    junior_etk.get_loan(pa).assert_equal(_W(0))
    senior_etk.get_loan(pa).assert_equal(_W(0))

    with pytest.raises(RevertError, match="DeficitExceedsMaxDeficit"):
        pa.set_deficit_ratio(_W("0.3"), False)

    pa.set_deficit_ratio(_W("0.3"), True)
    pa.set_deficit_ratio(_W("0.3"), True)
    pa.deficit_ratio.assert_equal(_W("0.3"))

    pa.active_pure_premiums.assert_equal(_W(20))
    pa.borrowed_active_pp.assert_equal(_W(6))
    pa.won_pure_premiums.assert_equal(_W(0))

    junior_etk.balance_of("LP1").assert_equal(_W(296))
    senior_etk.balance_of("LP1").assert_equal(_W(500))
    junior_etk.get_loan(pa).assert_equal(_W(4))
    senior_etk.get_loan(pa).assert_equal(_W(0))
    pa.funds_available.assert_equal(_W(0))

    # Loans can be repaid with new business
    policy_4 = ensuro.Policy(
        id=4,
        risk_module=rm,
        payout=_W(20),
        premium=_W(10),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy_4)

    pa.funds_available.assert_equal(_W(3))
    pa.funds_available.assert_equal(_W("0.3") * policy_4.pure_premium)

    pa.repay_loans()


def test_set_deficit_ratio_and_create_policy(tenv):
    senior_etk = tenv.etk(name="eUSD1YEAR", symbol="ETK2")
    start = tenv.time_control.now
    expiration = tenv.time_control.now + WEEK
    pa = tenv.pa_class(
        senior_etk=senior_etk,
    )
    pa.set_deficit_ratio(_W("0.3"), True)
    pa.deficit_ratio.assert_equal(_W("0.3"))

    tenv.currency.transfer(tenv.currency.owner, senior_etk, _W(500))
    with senior_etk.thru_policy_pool():
        assert senior_etk.deposit("LP1", _W(500)) == _W(500)
        senior_etk.add_borrower(pa)

    rm = RiskModule(
        premiums_account="dummy",
        name="Roulette",
        policy_pool="dummy",
        coll_ratio=_W("0.95"),
    )

    policy = ensuro.Policy(
        id=1,
        risk_module=rm,
        payout=_W(20),
        premium=_W(10),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy)

    policy_2 = ensuro.Policy(
        id=2,
        risk_module=rm,
        payout=_W(20),
        premium=_W(10),
        loss_prob=_W(1 / 2),
        start=start,
        expiration=expiration,
    )

    with pa.thru_policy_pool():
        pa.policy_created(policy_2)

    pa.active_pure_premiums.assert_equal(_W(20))
    pa.borrowed_active_pp.assert_equal(_W(0))
    pa.won_pure_premiums.assert_equal(_W(0))

    # Resolve policy
    tenv.currency.transfer(tenv.currency.owner, pa, _W(20))
    tenv.currency.approve(tenv.currency.owner, pa, _W(20))
    assert tenv.currency.allowance(tenv.currency.owner, pa) == _W(20)

    senior_etk.balance_of("LP1").assert_equal(_W(500))
    senior_etk.get_loan(pa).assert_equal(_W(0))

    with pa.thru_policy_pool():
        pa.policy_resolved_with_payout(tenv.currency.owner, policy, _W(20))

    pa.active_pure_premiums.assert_equal(_W(10))
    pa.borrowed_active_pp.assert_equal(_W(3))
    pa.won_pure_premiums.assert_equal(_W(0))

    senior_etk.balance_of("LP1").assert_equal(_W(493))
    senior_etk.get_loan(pa).assert_equal(_W(7))


def test_set_deficit_ratio_refuses_loss_of_precision(tenv):
    pa = tenv.pa_class(
        junior_etk=tenv.etk(name="eUSD1MONTH", symbol="ETK1"),
        senior_etk=tenv.etk(name="eUSD1YEAR", symbol="ETK2"),
    )

    with pytest.raises(RevertError, match="InvalidDeficitRatio"):
        pa.set_deficit_ratio(_W("0.12345"), True)
