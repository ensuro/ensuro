"""Unitary tests for eToken contract"""

from collections import namedtuple
from functools import partial

import pytest
from ethproto.contracts import RevertError
from ethproto.wadray import _W, Wad

from prototype import ensuro, wrappers
from prototype.utils import DAY, MONTH, WEEK

from . import TEST_VARIANTS
from .contracts import ForwardProxy, PolicyPoolMockForward

TEnv = namedtuple("TEnv", "time_control etoken_class policy_factory kind currency fw_proxy_factory module")
SECONDS_IN_YEAR = 365 * 3600 * 24


@pytest.fixture(params=TEST_VARIANTS)
def tenv(request):
    FakePolicyTuple = namedtuple("FakePolicy", "sr_scr sr_interest_rate expiration")

    class FakePolicy(FakePolicyTuple):
        @property
        def risk_module(self):
            return None

        @property
        def sr_coc(self):
            return self.sr_scr * (
                self.sr_interest_rate * _W(self.expiration - self.time_control.now) // _W(SECONDS_IN_YEAR)
            )

    if request.param == "prototype":
        currency = ensuro.ERC20Token(name="Test", symbol="TEST", initial_supply=_W(10000))
        policy_pool = ensuro.PolicyPool(
            currency=currency,
        )
        FakePolicy.time_control = ensuro.time_control

        def fw_proxy_factory(name, etk):
            currency.approve(name, etk, Wad(2**256 - 1))
            return name

        return TEnv(
            time_control=ensuro.time_control,
            policy_factory=FakePolicy,
            etoken_class=partial(ensuro.EToken, policy_pool=policy_pool),
            currency=currency,
            kind="prototype",
            fw_proxy_factory=fw_proxy_factory,
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

        def fw_proxy_factory(name, etk):
            provider = wrappers.get_provider()
            fw_proxy = ForwardProxy(forwardTo=etk.contract, owner="owner")
            # Unlock the proxy's address on the node to be able to do the approval
            provider.unlock_account(fw_proxy.contract.address)

            # TODO: This fails unless the gasPrice is zero, because fw_proxy has no gas tokens.
            # Would it be better to transfer ETH to it?
            currency.approve(fw_proxy.contract.address, etk.contract, 2**256 - 1)
            return fw_proxy.contract.address

        FakePolicy.time_control = wrappers.get_provider().time_control

        return TEnv(
            time_control=FakePolicy.time_control,
            policy_factory=FakePolicy,
            etoken_class=etoken_factory,
            currency=currency,
            kind="ethereum",
            fw_proxy_factory=fw_proxy_factory,
            module=wrappers,
        )


def test_only_policy_pool_validation(tenv):
    if tenv.kind == "prototype":
        return
    etk = tenv.etoken_class(name="eUSD1WEEK")
    with pytest.raises(RevertError, match="OnlyPolicyPool()"):
        etk.deposit("LP1", _W(1000))
    with pytest.raises(RevertError, match="OnlyPolicyPool()"):
        etk.withdraw("LP1", _W(1000))
    with pytest.raises(RevertError, match="The caller must be a borrower"):
        etk.lock_scr(_W(600), _W("0.0365"))
    with pytest.raises(RevertError, match="The caller must be a borrower"):
        etk.unlock_scr(_W(600), _W("0.0365"), _W(0))


def test_deposit_withdraw(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    assert etk.liquidity_requirement == _W(1)
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
    assert etk.balance_of("LP1") == _W(1000)
    assert etk.funds_available == _W(1000)
    tenv.time_control.fast_forward(DAY)
    assert etk.balance_of("LP1") == _W(1000)  # unchanged because SCR=0
    with etk.thru_policy_pool():
        assert etk.withdraw("LP1", _W(600)) == _W(600)
        assert tenv.currency.balance_of("LP1") == _W(600)
    assert etk.balance_of("LP1") == _W(400)
    with etk.thru_policy_pool():
        assert etk.withdraw("LP1", None) == _W(400)
        assert tenv.currency.balance_of("LP1") == _W(1000)
    assert etk.balance_of("LP1") == _W(0)
    with etk.thru_policy_pool():
        assert etk.withdraw("LP1", None) == _W(0)
        assert tenv.currency.balance_of("LP1") == _W(1000)


def test_lock_unlock_scr(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")
    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
        etk.add_borrower(pa)
    assert etk.funds_available == _W(1000)

    assert etk.scaled_total_supply() == _W(1000)
    assert etk.scaled_balance_of("LP1") == _W(1000)

    policy = tenv.policy_factory(
        sr_scr=_W(600), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    assert etk.scr == _W(600)
    assert etk.scr_interest_rate == _W("0.0365")
    etk.token_interest_rate.assert_equal(_W("0.0365") * _W(600 / 1000))
    etk.funds_available.assert_equal(_W(400))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))
    tenv.time_control.fast_forward(3 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(5))

    # Scaled balance is still 1000
    assert etk.scaled_balance_of("LP1") == _W(1000)
    assert etk.scaled_total_supply() == _W(1000)

    with etk.thru(pa):
        etk.unlock_scr(policy.sr_scr, policy.sr_interest_rate, _W(0))

    tenv.time_control.fast_forward(10 * DAY)
    expected_balance = _W(1000) + _W("0.06") * _W(5)
    etk.balance_of("LP1").assert_equal(expected_balance)
    etk.transfer("LP1", "LP2", expected_balance)
    etk.balance_of("LP1").assert_equal(_W(0))
    etk.balance_of("LP2").assert_equal(expected_balance)

    lp2_sc_balance, sc_ts = etk.get_scaled_user_balance_and_supply("LP2")
    lp2_sc_balance.assert_equal(_W(1000))
    sc_ts.assert_equal(_W(1000))

    with etk.thru_policy_pool():
        etk.withdraw("LP2", expected_balance // _W(4)).assert_equal(expected_balance // _W(4))
        etk.scaled_balance_of("LP2").assert_equal(_W(750))
        etk.withdraw("LP2", None).assert_equal(expected_balance * _W(3 / 4))
        etk.balance_of("LP2").assert_equal(_W(0))
        tenv.currency.balance_of("LP2").assert_equal(expected_balance)
    etk.balance_of("LP1").assert_equal(_W(0))


def test_etoken_erc20(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")
    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
        etk.add_borrower(pa)
    policy = tenv.policy_factory(
        sr_scr=_W(600), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    tenv.time_control.fast_forward(2 * DAY)
    expected_balance = _W(1000) + _W("0.06") * _W(2)
    etk.balance_of("LP1").assert_equal(expected_balance)

    with pytest.raises(RevertError):
        etk.approve("LP1", None, expected_balance // _W(2))

    with pytest.raises(RevertError):
        etk.approve(None, "SPEND", expected_balance // _W(2))

    etk.approve("LP1", "SPEND", expected_balance // _W(2))
    etk.approve("LP1", "SPEND", etk.allowance("LP1", "SPEND") + _W(50))
    etk.approve("LP1", "SPEND", etk.allowance("LP1", "SPEND") - _W(20))
    etk.allowance("LP1", "SPEND").assert_equal(expected_balance // _W(2) + _W(30))
    etk.approve("LP1", "SPEND", etk.allowance("LP1", "SPEND") - _W(30))

    with pytest.raises(RevertError, match="allowance|ERC20InsufficientAllowance"):
        etk.transfer_from("SPEND", "LP1", "LP2", expected_balance)
    etk.transfer_from("SPEND", "LP1", "LP2", expected_balance // _W(2))
    etk.allowance("LP1", "SPEND").assert_equal(_W(0))
    etk.balance_of("LP1").assert_equal(expected_balance // _W(2))
    etk.balance_of("LP2").assert_equal(expected_balance // _W(2))

    with etk.thru_policy_pool():
        etk.withdraw("LP2", _W(100)).assert_equal(_W(100))

    total_withdrawable = _W(1000) + _W("0.06") * _W(2) - policy.sr_scr - _W(100)
    etk.total_withdrawable().assert_equal(total_withdrawable)

    assert _W(5000) > total_withdrawable

    # Max to withdraw is total_withdrawable - Only if infinite sent as parameter
    with etk.thru_policy_pool(), pytest.raises(RevertError, match="amount > max withdrawable"):
        etk.withdraw("LP1", _W(5000)).assert_equal(total_withdrawable)

    with etk.thru_policy_pool():
        etk.withdraw("LP1", None).assert_equal(total_withdrawable)

    with etk.thru(pa):
        etk.unlock_scr(policy.sr_scr, policy.sr_interest_rate, _W(0))
    with etk.thru_policy_pool():
        # now max to withdraw is LP balance
        etk.withdraw("LP1", None).assert_equal(expected_balance // _W(2) - total_withdrawable)
        etk.balance_of("LP2").assert_equal(expected_balance // _W(2) - _W(100))
        etk.withdraw("LP2", None).assert_equal(expected_balance // _W(2) - _W(100))


def test_multiple_policies(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")
    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
        etk.add_borrower(pa)

    policy1 = tenv.policy_factory(
        sr_scr=_W(300), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy1.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy1.sr_scr, policy1.sr_interest_rate)
    assert etk.scr_interest_rate == _W("0.0365")
    assert etk.scr == _W(300)
    etk.funds_available.assert_equal(_W(700))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.03") * _W(2))

    # Create 2nd policy twice interest twice SCR
    policy2 = tenv.policy_factory(
        sr_scr=_W(600), sr_interest_rate=_W("0.0730"), expiration=tenv.time_control.now + WEEK
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy2.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy2.sr_scr, policy2.sr_interest_rate)
    etk.scr_interest_rate.assert_equal((_W("0.0365") * _W(300) + _W("0.0730") * _W(600)) // _W(900))

    assert etk.scr == _W(900)
    etk.funds_available.assert_equal(_W(100) + _W("0.03") * _W(2))

    tenv.time_control.fast_forward(3 * DAY)

    expected_balance = _W(1000) + _W("0.03") * _W(5) + _W("0.12") * _W(3)
    etk.balance_of("LP1").assert_equal(expected_balance)

    # Create 3rd policy - Doesn't have impact because unlocked inmediatelly
    policy3 = tenv.policy_factory(
        sr_scr=_W(100), sr_interest_rate=_W("0.1"), expiration=tenv.time_control.now + WEEK
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy3.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy3.sr_scr, policy3.sr_interest_rate)
    etk.total_withdrawable().assert_equal(_W(0.51))  # accrued interests are withdrawable

    with etk.thru(pa):
        etk.unlock_scr(policy3.sr_scr, policy3.sr_interest_rate, _W(0))
        etk.unlock_scr(policy1.sr_scr, policy1.sr_interest_rate, _W(0))

    etk.scr_interest_rate.assert_equal(_W("0.0730"))
    assert etk.scr == policy2.sr_scr
    etk.balance_of("LP1").assert_equal(expected_balance)
    with etk.thru(pa), pytest.raises(RevertError, match="SCR"):
        etk.unlock_scr(policy2.sr_scr + _W(1), policy2.sr_interest_rate, _W(0))  # Can't unlock more than SCR

    with etk.thru(pa):
        etk.unlock_scr(policy2.sr_scr, policy2.sr_interest_rate, _W(0))
    assert etk.scr == _W(0)
    etk.total_supply().assert_equal(expected_balance)


def test_multiple_lps(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")
    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
        etk.add_borrower(pa)
    assert etk.funds_available == _W(1000)
    policy = tenv.policy_factory(
        sr_scr=_W(600), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    assert etk.scr == _W(600)
    assert etk.funds_available == _W(400)

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))

    tenv.currency.transfer(tenv.currency.owner, etk, _W(2000))
    with etk.thru_policy_pool():
        etk.deposit("LP2", _W(2000)).assert_equal(_W(2000))
    tenv.time_control.fast_forward(3 * DAY)

    lp1_balance = _W(1000) + _W("0.06") * _W(2) + _W("0.06") * _W(3) * _W(1 / 3)
    etk.balance_of("LP1").assert_equal(lp1_balance)
    lp2_balance = _W(2000) + _W("0.06") * _W(3) * _W(2 / 3)
    etk.balance_of("LP2").assert_equal(lp2_balance)

    with etk.thru_policy_pool():
        etk.withdraw("LP1", None).assert_equal(lp1_balance)

    tenv.time_control.fast_forward(1 * DAY)
    etk.balance_of("LP2").assert_equal(lp2_balance + _W("0.06"))

    with etk.thru(pa):
        etk.unlock_scr(policy.sr_scr, policy.sr_interest_rate, _W(0))
    with etk.thru_policy_pool():
        etk.withdraw("LP2", None).assert_equal(lp2_balance + _W("0.06"))


def test_lock_scr_validation(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")
    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    policy = tenv.policy_factory(
        sr_scr=_W(600), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )

    with etk.thru(pa), pytest.raises(RevertError, match="EToken: Borrower cannot be the zero address"):
        with etk.thru_policy_pool():
            etk.add_borrower(None)

    with etk.thru_policy_pool():
        etk.add_borrower(pa)

    with etk.thru(pa):
        with pytest.raises(RevertError, match="Not enough funds available to cover the SCR"):
            etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    with etk.thru_policy_pool():
        tenv.currency.transfer(tenv.currency.owner, etk, _W(200))
        etk.deposit("LP1", _W(200))

    with etk.thru(pa):
        with pytest.raises(RevertError, match="Not enough funds available to cover the SCR"):
            etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)


def test_internal_loan(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", internal_loan_interest_rate=_W("0.073"))
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))

    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    pa2 = tenv.fw_proxy_factory("PA2", etk)  # Other Premiums Account
    tenv.currency.transfer(tenv.currency.owner, pa, _W(2000))
    pa_balance = _W(2000)

    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(1000))
    assert etk.internal_loan_interest_rate == _W("0.073")
    assert etk.get_loan(pa) == _W(0)

    with etk.thru_policy_pool():
        etk.add_borrower(pa)

    policy = tenv.policy_factory(
        sr_scr=_W(600), sr_interest_rate=_W("0.04"), expiration=tenv.time_control.now + MONTH
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    tenv.time_control.fast_forward(7 * DAY)
    etk.funds_available.assert_equal(_W(400) + _W(600 * 0.04 * 7 / 365))

    funds_available = etk.funds_available
    total_supply = etk.total_supply()
    max_negative_adjustment = etk.max_negative_adjustment()

    assert max_negative_adjustment < total_supply

    assert funds_available < _W(401)

    with etk.thru(pa):
        not_lended = etk.internal_loan(pa, _W(1001), "CUST1")
        not_lended.assert_equal(_W(1001) - max_negative_adjustment)
        lended = _W(1001) - not_lended
        assert tenv.currency.balance_of("CUST1") == lended
        assert etk.get_loan(pa) == lended

        with pytest.raises(RevertError, match="EToken: amount should be greater than zero."):
            etk.repay_loan(pa, _W(0), pa)

        etk.repay_loan(pa, lended, pa)
        tenv.currency.balance_of(pa).assert_equal(pa_balance - lended)
        pa_balance -= lended
        etk.get_loan(pa).assert_equal(_W(0))
        etk.internal_loan(pa, _W(300), "CUST1").assert_equal(_W(0))

    etk.get_loan(pa).assert_equal(_W(300))
    tenv.time_control.fast_forward(7 * DAY)

    etk.get_loan(pa2).assert_equal(_W(0))

    # After 7 days increases at a rate of 7.3%/year (0.02% per day)
    etk.get_loan(pa).assert_equal(_W(300) * _W(1 + 0.0002 * 7))
    with etk.thru(pa):
        etk.internal_loan(pa, _W(100), "CUST2").assert_equal(_W(0))
        assert tenv.currency.balance_of("CUST2") == _W(100)

    tenv.time_control.fast_forward(1 * DAY)

    internal_loan = _W(400) + _W(300) * _W(0.0002 * 8) + _W(100) * _W(0.0002)
    etk.get_loan(pa).assert_equal(internal_loan)

    etk.repay_loan(pa, Wad(1), pa)  # Does a minimal payment, so scale is updated
    with etk.as_("SETRATE"):
        etk.set_internal_loan_interest_rate(_W("0.0365"))

    assert etk.internal_loan_interest_rate == _W("0.0365")
    etk.get_loan(pa).assert_equal(internal_loan)

    tenv.time_control.fast_forward(3 * DAY)
    etk.get_loan(pa).assert_equal(internal_loan * _W(1 + 0.0001 * 3))
    internal_loan = internal_loan * _W(1 + 0.0001 * 3)

    with etk.thru(pa):
        tenv.currency.approve(pa, etk, internal_loan // _W(3))
        etk.repay_loan(pa, internal_loan // _W(3), pa)
        pa_balance -= internal_loan // _W(3)
        tenv.currency.balance_of(pa).assert_equal(pa_balance)

        etk.get_loan(pa).assert_equal(internal_loan * _W(2 / 3))
        tenv.currency.approve(pa, etk, internal_loan * _W(2 / 3))
        etk.repay_loan(pa, internal_loan * _W(2 / 3), pa)
        pa_balance -= internal_loan * _W(2 / 3)
        tenv.currency.balance_of(pa).assert_equal(pa_balance)
        etk.get_loan(pa).assert_equal(_W(0))


def test_name_and_others(tenv):
    etk = tenv.etoken_class(name="eUSD One Week", symbol="eUSD1W")
    assert etk.name == "eUSD One Week"
    assert etk.symbol == "eUSD1W"
    assert etk.decimals == 18


def test_max_utilization_rate(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK", max_utilization_rate=_W("0.9"))
    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    assert etk.max_utilization_rate == _W("0.9")
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(1000))
        etk.add_borrower(pa)
    assert etk.funds_available == _W(1000)
    assert etk.funds_available_to_lock == _W(900)

    with etk.as_("SETRATE"):
        etk.set_max_utilization_rate(_W("0.95"))

    assert etk.funds_available_to_lock == _W(950)

    policy = tenv.policy_factory(
        sr_scr=_W(951), sr_interest_rate=_W("0.04"), expiration=tenv.time_control.now + WEEK
    )

    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)
    with pytest.raises(RevertError, match="Not enough funds available to cover the SCR"):
        with etk.thru(pa):
            etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)

    # Lock first policy
    policy = tenv.policy_factory(
        sr_scr=_W(150), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )
    with etk.thru(pa):
        etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)

    etk.funds_available_to_lock.assert_equal(_W(950 - 150))

    with etk.as_("SETRATE"):
        etk.set_max_utilization_rate(_W("0.80"))

    etk.funds_available_to_lock.assert_equal(_W(800 - 150))

    with etk.as_("SETRATE"):
        etk.set_max_utilization_rate(_W("0.95"))

    etk.funds_available_to_lock.assert_equal(_W(950 - 150))

    # Lock 2nd policy
    policy = tenv.policy_factory(
        sr_scr=_W(800), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )
    with etk.thru(pa):
        etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)

    etk.utilization_rate.assert_equal(_W("0.95"))
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(1000))

    etk.utilization_rate.assert_equal(_W("0.475"))

    with etk.as_("SETRATE"):
        etk.set_min_utilization_rate(_W("0.475"))

    tenv.currency.transfer(tenv.currency.owner, etk, _W(5))
    with etk.thru_policy_pool(), pytest.raises(
        RevertError, match="Deposit rejected - Utilization Rate < min"
    ):
        etk.deposit("LP1", _W(5))

    withdrawable = _W(2000) - _W(950)
    with etk.thru_policy_pool():
        etk.withdraw("LP1", None).assert_equal(withdrawable)


def test_unlock_scr(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")
    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
        etk.add_borrower(pa)
    assert etk.funds_available == _W(1000)
    policy = tenv.policy_factory(
        sr_scr=_W(600), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    assert etk.scr == _W(600)
    assert etk.scr_interest_rate == _W("0.0365")
    etk.token_interest_rate.assert_equal(_W("0.0365") * _W(600 / 1000))
    etk.funds_available.assert_equal(_W(400))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))
    tenv.time_control.fast_forward(3 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(5))

    with etk.thru(pa):
        etk.unlock_scr(policy.sr_scr, policy.sr_interest_rate, _W(0))


def test_unlock_scr_with_adjustment(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")
    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
        etk.add_borrower(pa)
    assert etk.funds_available == _W(1000)
    policy = tenv.policy_factory(
        sr_scr=_W(600), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    assert etk.scr == _W(600)
    assert etk.scr_interest_rate == _W("0.0365")
    etk.token_interest_rate.assert_equal(_W("0.0365") * _W(600 / 1000))
    etk.funds_available.assert_equal(_W(400))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))
    tenv.time_control.fast_forward(3 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(5))

    with etk.thru(pa):
        etk.unlock_scr(policy.sr_scr, policy.sr_interest_rate, policy.sr_coc - _W("0.06") * _W(5))


def test_unlock_scr_with_neg_adjustment(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")
    pa = tenv.fw_proxy_factory("PA", etk)  # Premiums Account
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        assert etk.deposit("LP1", _W(1000)) == _W(1000)
        etk.add_borrower(pa)
    assert etk.funds_available == _W(1000)
    policy = tenv.policy_factory(
        sr_scr=_W(600), sr_interest_rate=_W("0.0365"), expiration=tenv.time_control.now + WEEK
    )
    tenv.currency.transfer(tenv.currency.owner, etk, policy.sr_coc)
    with etk.thru(pa):
        etk.lock_scr(policy.sr_scr, policy.sr_interest_rate)
    assert etk.scr == _W(600)
    assert etk.scr_interest_rate == _W("0.0365")
    etk.token_interest_rate.assert_equal(_W("0.0365") * _W(600 / 1000))
    etk.funds_available.assert_equal(_W(400))

    tenv.time_control.fast_forward(2 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(2))
    tenv.time_control.fast_forward(8 * DAY)
    etk.balance_of("LP1").assert_equal(_W(1000) + _W("0.06") * _W(10))

    with etk.thru(pa):
        etk.unlock_scr(policy.sr_scr, policy.sr_interest_rate, policy.sr_coc - _W("0.06") * _W(10))


def test_mint_to_zero_address(tenv):
    if tenv.kind != "ethereum":
        pytest.skip("mint not fully implemented in Python")

    etk = tenv.etoken_class(name="eUSD1WEEK")
    tenv.currency.transfer(tenv.currency.owner, etk, _W(1000))
    with etk.thru_policy_pool():
        with pytest.raises(RevertError):
            assert etk.deposit(None, _W(1000)) == _W(1000)

    with etk.thru_policy_pool():
        with pytest.raises(RevertError):
            assert etk.deposit("LP1", _W(0))

        assert etk.deposit("LP1", _W(1000)) == _W(1000)
