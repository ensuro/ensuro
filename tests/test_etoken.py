"""Unitary tests for eToken contract"""

from collections import namedtuple
from functools import partial

import pytest
from ethproto.contracts import RevertError
from ethproto.wadray import _R, _W, Wad

from prototype import ensuro, wrappers
from prototype.utils import DAY, MONTH, WEEK

from . import TEST_VARIANTS
from .contracts import ForwardProxy, PolicyPoolMockForward

TEnv = namedtuple(
    "TEnv", "time_control etoken_class policy_factory kind currency fw_proxy_factory module pool_access"
)
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
        pp_access = ensuro.AccessManager()
        currency = ensuro.ERC20Token(name="Test", symbol="TEST", initial_supply=_W(10000))
        policy_pool = ensuro.PolicyPool(
            access=pp_access,
            currency=currency,
        )
        FakePolicy.time_control = ensuro.time_control

        def fw_proxy_factory(name, etk):
            currency.approve(name, etk, Wad(2**256 - 1))
            return name

        return TEnv(
            time_control=ensuro.time_control,
            pool_access=pp_access,
            policy_factory=FakePolicy,
            etoken_class=partial(ensuro.EToken, policy_pool=policy_pool),
            currency=currency,
            kind="prototype",
            fw_proxy_factory=fw_proxy_factory,
            module=ensuro,
        )
    elif request.param == "ethereum":
        currency = wrappers.TestCurrency(owner="owner", name="TEST", symbol="TEST", initial_supply=_W(10000))
        access = wrappers.AccessManager(owner="owner")

        def etoken_factory(**kwargs):
            pool = PolicyPoolMockForward(
                forwardTo=wrappers.AddressBook.ZERO, currency_=currency.contract, access_=access.contract
            )

            symbol = kwargs.pop("symbol", "ETK")
            etoken = wrappers.EToken(policy_pool=pool, symbol=symbol, **kwargs)
            pool.setForwardTo(etoken.contract, {"from": currency.owner})
            return etoken

        def fw_proxy_factory(name, etk):
            provider = wrappers.get_provider()
            fw_proxy = ForwardProxy(forwardTo=etk.contract)
            # Unlock the proxy's address on the node to be able to do the approval
            provider.unlock_account(fw_proxy.contract.address)

            # TODO: This fails unless the gasPrice is zero, because fw_proxy has no gas tokens.
            # Would it be better to transfer ETH to it?
            currency.approve(fw_proxy.contract.address, etk.contract, 2**256 - 1)
            return fw_proxy.contract.address

        FakePolicy.time_control = wrappers.get_provider().time_control

        return TEnv(
            time_control=FakePolicy.time_control,
            pool_access=access,
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
    with pytest.raises(RevertError, match="The caller must be the PolicyPool"):
        etk.deposit("LP1", _W(1000))
    with pytest.raises(RevertError, match="The caller must be the PolicyPool"):
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
    etk.increase_allowance("LP1", "SPEND", _W(50))
    with pytest.raises(RevertError):
        etk.decrease_allowance("LP1", "SPEND", _W(1000))
    etk.decrease_allowance("LP1", "SPEND", _W(20))
    etk.allowance("LP1", "SPEND").assert_equal(expected_balance // _W(2) + _W(30))
    etk.decrease_allowance("LP1", "SPEND", _W(30))

    with pytest.raises(RevertError, match="allowance"):
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

    with etk.as_("owner"):
        etk.grant_role("LEVEL2_ROLE", "SETRATE")

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


def test_etk_asset_manager(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")

    # Initial setup
    tenv.currency.transfer(tenv.currency.owner, etk, _W(3000))
    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(1000))
        etk.deposit("LP2", _W(2000))
    assert etk.total_supply() == _W(3000)
    assert etk.get_current_scale(True) == _R(1)
    assert etk.get_current_scale(False) == _R(1)
    tenv.currency.balance_of(etk).assert_equal(_W(3000))

    # Create vault
    vault = tenv.module.FixedRateVault(asset=tenv.currency)
    asset_manager = tenv.module.ERC4626AssetManager(
        vault=vault,
        reserve=etk,
    )

    with pytest.raises(RevertError, match="AccessControl"):
        etk.set_asset_manager(asset_manager, False)

    tenv.pool_access.grant_role("LEVEL1_ROLE", "ADMIN")

    # Set asset manager
    with etk.as_("ADMIN"):
        etk.set_asset_manager(asset_manager, False)

    with pytest.raises(RevertError, match="AccessControl"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", _W(100), _W(160), _W(200))

    tenv.pool_access.grant_component_role(etk, "LEVEL2_ROLE", "ADMIN")

    with etk.as_("ADMIN"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", _W(100), _W(160), _W(200))

    # Test invalid change only middle and max
    with etk.as_("ADMIN"), pytest.raises(RevertError, match="Validation"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", _W(300), None, None)

    # Test change only middle and max
    with etk.as_("ADMIN"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", None, _W(1000), _W(2000))

    # Rebalance
    vault.total_assets().assert_equal(_W(0))
    # After checkpoint the cash should be rebalanced
    etk.rebalance()
    vault.total_assets().assert_equal(_W(2000))
    tenv.currency.balance_of(etk).assert_equal(_W(1000))

    etk.record_earnings()
    etk.total_supply().assert_equal(_W(3000))  # Nothing earned yet

    # After one month record the earnings
    tenv.time_control.fast_forward(2 * MONTH)
    interest_earnings = _W(2000 * 0.05 * 60 / 365)  # ~ 17
    vault.total_assets().assert_equal(_W(2000) + interest_earnings)

    etk.checkpoint()
    etk.total_supply().assert_equal(_W(3000) + interest_earnings)
    etk.balance_of("LP1").assert_equal(_W(1000) + interest_earnings * _W(1 / 3))
    tenv.currency.balance_of(etk).assert_equal(_W(1000))  # USDC balance unchanged

    vault.discrete_earning(-_W(600))

    etk.checkpoint()
    tenv.currency.balance_of(etk).assert_equal(_W(1000))  # No rebalance
    vault.total_assets().assert_equal(_W(1400) + interest_earnings)
    etk.total_supply().assert_equal(_W(3000) + interest_earnings - _W(600))

    # One of the LP withdraws and etk cash is not enough - Triggers deinvestment
    lp2_balance = _W(2000) + interest_earnings * _W(2 / 3) - _W(600) * _W(2 / 3)
    with etk.thru_policy_pool():
        etk.withdraw("LP2", None).assert_equal(lp2_balance)

    lp1_balance = _W(1000) + interest_earnings * _W(1 / 3) - _W(600) * _W(1 / 3)
    etk.balance_of("LP1").assert_equal(lp1_balance)

    vault.total_assets().assert_equal(_W(0))

    # Change liquidity thresholds to rebalance
    with etk.as_("ADMIN"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", _W(200), _W(400), _W(600))

    etk.checkpoint()

    tenv.currency.balance_of(etk).assert_equal(_W(400))
    vault.total_assets().assert_equal(lp1_balance - _W(400))

    vault.discrete_earning(_W(200))
    etk.record_earnings()

    lp1_balance += _W(200)
    etk.balance_of("LP1").assert_equal(lp1_balance)

    vault_2 = tenv.module.FixedRateVault(asset=tenv.currency)
    asset_manager_2 = tenv.module.ERC4626AssetManager(
        vault=vault_2,
        reserve=etk,
    )

    with etk.as_("ADMIN"):
        etk.set_asset_manager(asset_manager_2, False)

    if tenv.kind == "prototype":
        assert etk.asset_manager == asset_manager_2.contract_id
    else:
        assert etk.asset_manager == asset_manager_2.contract.address

    vault.total_assets().assert_equal(_W(0))  # All deinvested
    tenv.currency.balance_of(etk).assert_equal(lp1_balance)

    vault_2.broken = True

    with etk.as_("ADMIN"), pytest.raises(RevertError):
        etk.set_asset_manager(asset_manager, False)

    with etk.as_("ADMIN"):
        etk.set_asset_manager(asset_manager_2, True)


def test_etk_change_asset_manager(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")

    # Initial setup
    tenv.currency.transfer(tenv.currency.owner, etk, _W(3000))
    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(1000))
        etk.deposit("LP2", _W(2000))
    assert etk.total_supply() == _W(3000)
    assert etk.get_current_scale(True) == _R(1)
    assert etk.get_current_scale(False) == _R(1)
    tenv.currency.balance_of(etk).assert_equal(_W(3000))

    # Create vault
    vault = tenv.module.FixedRateVault(asset=tenv.currency)
    asset_manager = tenv.module.ERC4626AssetManager(
        vault=vault,
        reserve=etk,
    )

    tenv.pool_access.grant_role("LEVEL1_ROLE", "ADMIN")

    # Set asset manager
    with etk.as_("ADMIN"):
        etk.set_asset_manager(asset_manager, False)

    tenv.pool_access.grant_component_role(etk, "LEVEL2_ROLE", "ADMIN")

    with etk.as_("ADMIN"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", _W(100), _W(160), _W(200))

    # Rebalance
    vault.total_assets().assert_equal(_W(0))
    # After checkpoint the cash should be rebalanced
    etk.rebalance()
    vault.total_assets().assert_equal(_W(2840))
    tenv.currency.balance_of(etk).assert_equal(_W(160))

    etk.record_earnings()
    etk.total_supply().assert_equal(_W(3000))  # Nothing earned yet

    vault_2 = tenv.module.FixedRateVault(asset=tenv.currency)
    asset_manager_2 = tenv.module.ERC4626AssetManager(
        vault=vault_2,
        reserve=etk,
    )

    with etk.as_("ADMIN"):
        etk.set_asset_manager(asset_manager_2, False)

    if tenv.kind == "prototype":
        assert etk.asset_manager == asset_manager_2.contract_id
    else:
        assert etk.asset_manager == asset_manager_2.contract.address

    with etk.as_("ADMIN"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", _W(100), _W(160), _W(200))

    vault.total_assets().assert_equal(_W(0))  # All deinvested
    tenv.currency.balance_of(etk).assert_equal(_W(3000))
    etk.rebalance()

    etk.record_earnings()
    tenv.currency.balance_of(etk).assert_equal(_W(160))
    etk.total_supply().assert_equal(_W(3000))  # Nothing earned yet


def test_etk_asset_manager_without_movements(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")

    # Create vault
    vault = tenv.module.FixedRateVault(asset=tenv.currency)
    asset_manager = tenv.module.ERC4626AssetManager(
        vault=vault,
        reserve=etk,
    )

    tenv.pool_access.grant_role("LEVEL1_ROLE", "ADMIN")

    # Set asset manager
    with etk.as_("ADMIN"):
        etk.set_asset_manager(asset_manager, False)

    if tenv.kind == "prototype":
        assert etk.asset_manager == asset_manager.contract_id
    else:
        assert etk.asset_manager == asset_manager.contract.address

    # Unset asset manager
    with etk.as_("ADMIN"):
        etk.set_asset_manager(None, False)

    assert etk.asset_manager is None or etk.asset_manager == "0x0000000000000000000000000000000000000000"


def test_etk_asset_manager_liquidity_under_minimum(tenv):
    etk = tenv.etoken_class(name="eUSD1WEEK")

    # Initial setup
    tenv.currency.transfer(tenv.currency.owner, etk, _W(300))
    with etk.thru_policy_pool():
        etk.deposit("LP1", _W(100))
        etk.deposit("LP2", _W(200))
    assert etk.total_supply() == _W(300)
    assert etk.get_current_scale(True) == _R(1)
    tenv.currency.balance_of(etk).assert_equal(_W(300))

    # Create vault
    vault = tenv.module.FixedRateVault(asset=tenv.currency)
    asset_manager = tenv.module.ERC4626AssetManager(
        vault=vault,
        reserve=etk,
    )

    with pytest.raises(RevertError, match="AccessControl"):
        etk.set_asset_manager(asset_manager, False)

    tenv.pool_access.grant_role("LEVEL1_ROLE", "ADMIN")

    # Set asset manager
    with etk.as_("ADMIN"):
        etk.set_asset_manager(asset_manager, False)

    with pytest.raises(RevertError, match="AccessControl"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", _W(100), _W(200), _W(250))

    tenv.pool_access.grant_component_role(etk, "LEVEL2_ROLE", "ADMIN")

    with etk.as_("ADMIN"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", _W(100), _W(200), _W(250))

    # Rebalance
    vault.total_assets().assert_equal(_W(0))
    # After checkpoint the cash should be rebalanced
    etk.rebalance()
    vault.total_assets().assert_equal(_W(100))
    tenv.currency.balance_of(etk).assert_equal(_W(200))

    etk.record_earnings()
    etk.total_supply().assert_equal(_W(300))  # Nothing earned yet

    # After two month record the earnings
    tenv.time_control.fast_forward(2 * MONTH)
    interest_earnings = _W(100 * 0.05 * 60 / 365)
    vault.total_assets().assert_equal(_W(100) + interest_earnings)

    etk.checkpoint()
    etk.total_supply().assert_equal(_W(300) + interest_earnings)
    etk.balance_of("LP1").assert_equal(_W(100) + interest_earnings * _W(1 / 3))
    tenv.currency.balance_of(etk).assert_equal(_W(200))  # USDC balance unchanged

    with etk.as_("ADMIN"):
        etk.forward_to_asset_manager("set_liquidity_thresholds", _W(500), _W(700), _W(1200))

    # After checkpoint the cash should be rebalanced
    etk.rebalance()
    vault.total_assets().assert_equal(0)
    tenv.currency.balance_of(etk).assert_equal(_W(300) + interest_earnings)

    etk.record_earnings()
    etk.total_supply().assert_equal(_W(300) + interest_earnings)  # Nothing earned yet


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

    with etk.as_("owner"):
        etk.grant_role("LEVEL2_ROLE", "SETRATE")
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


def test_getset_etk_parameters_tweaks(tenv):
    if tenv.kind != "ethereum":
        return
    etk = tenv.etoken_class(
        name="eUSD1WEEK", max_utilization_rate=_W("0.9"), internal_loan_interest_rate=_W("0.02")
    )
    with etk.as_("owner"):
        etk.grant_role("LEVEL2_ROLE", "L2_USER")
        etk.grant_role("LEVEL3_ROLE", "L3_USER")

    with etk.as_("UNAUTHORIZED_USER"), pytest.raises(RevertError, match="AccessControl"):
        setattr(etk, "liquidity_requirement", _W("0.7"))

    # Verifies hard-coded validations
    test_validations = [
        ("liquidity_requirement", _W("0.7")),  # [0.8, 1.3]
        ("liquidity_requirement", _W("1.4")),  # [0.8, 1.3]
        ("min_utilization_rate", _W(1.01)),  # <= [0, 1]
        ("max_utilization_rate", _W(1.01)),  # <= [0.5, 1]
        ("max_utilization_rate", _W(0.3)),  # <= [0.5, 1]
        ("internal_loan_interest_rate", _W("0.6")),  # <=50%
    ]

    for attr_name, attr_value in test_validations:
        with etk.as_("L2_USER"), pytest.raises(RevertError, match="Validation: "):
            setattr(etk, attr_name, attr_value)

    with etk.as_("L2_USER"):
        etk.min_utilization_rate = _W("0.5")

    # Verifies exceeded tweaks
    test_exceeded_tweaks = [
        ("liquidity_requirement", _W("0.6")),  # 10% allowed - previous 100%
        ("liquidity_requirement", _W("1.5")),  # 10% allowed - previous 100%
        ("max_utilization_rate", _W("0.4")),  # 30% allowed - previous 90%
        ("min_utilization_rate", _W("0.1")),  # 30% allowed - previous 10%
        ("internal_loan_interest_rate", _W("0.04")),  # 30% allowed - previous 2%
    ]

    for attr_name, attr_value in test_exceeded_tweaks:
        with etk.as_("L3_USER"), pytest.raises(RevertError, match="Tweak exceeded: "):
            setattr(etk, attr_name, attr_value)

    # Verifies OK tweaks
    test_ok_tweaks = [
        ("liquidity_requirement", _W("1.09")),  # 10% allowed - previous 100%
        ("max_utilization_rate", _W("0.8")),  # 30% allowed - previous 90%
        ("internal_loan_interest_rate", _W("0.025")),  # 30% allowed - previous 2%
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with etk.as_("L3_USER"):
            setattr(etk, attr_name, attr_value)
        assert getattr(etk, attr_name) == attr_value

    # Verifies L2_USER changes
    test_ok_l2_changes = [
        ("liquidity_requirement", _W("0.8")),  # previous 109%
        ("max_utilization_rate", _W("0.51")),  # previous 80%
        ("internal_loan_interest_rate", _W("0.07")),  # previous 2.5%
        ("accept_all_rms", False),  # previous True
        ("accept_all_rms", True),  # previous False
    ]

    for attr_name, attr_value in test_ok_l2_changes:
        with etk.as_("L2_USER"):
            setattr(etk, attr_name, attr_value)
        assert getattr(etk, attr_name) == attr_value

    tenv.time_control.fast_forward(WEEK)  # To avoid repeated tweaks

    # New OK tweaks
    test_ok_tweaks = [
        ("liquidity_requirement", _W("0.87")),  # previous 80%
        ("max_utilization_rate", _W("0.6")),  # previous 51%
        ("internal_loan_interest_rate", _W("0.06")),  # previous 7%
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with etk.as_("L3_USER"):
            setattr(etk, attr_name, attr_value)
        assert getattr(etk, attr_name) == attr_value

    # Other tweaks
    test_ok_tweaks = [
        ("liquidity_requirement", _W("0.9")),  # previous 87%
        ("max_utilization_rate", _W("0.66")),  # previous 60%
        ("internal_loan_interest_rate", _W("0.05")),  # previous 6%
    ]

    for attr_name, attr_value in test_ok_tweaks:
        with etk.as_("L3_USER"), pytest.raises(
            RevertError, match="You already tweaked this parameter recently"
        ):
            setattr(etk, attr_name, attr_value)

    tenv.time_control.fast_forward(2 * DAY)  # Tweaks expired

    for attr_name, attr_value in test_ok_tweaks:
        with etk.as_("L3_USER"):
            setattr(etk, attr_name, attr_value)
        assert getattr(etk, attr_name) == attr_value


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
