import pytest
from collections import namedtuple
from ethproto.wadray import _W, make_integer_float, Wad
from ethproto.contracts import RevertError
from prototype import ensuro
from prototype import wrappers
from prototype.utils import MONTH
from . import TEST_VARIANTS

TEnv = namedtuple("TEnv", "time_control currency FixedRateVault")
SECONDS_IN_YEAR = 365 * 3600 * 24

USDC = make_integer_float(6, "USDC")
_D = USDC.from_value
USD1K = Wad(_D(1000))


def USDCWAD(x):
    return Wad(_D(x))


@pytest.fixture(params=TEST_VARIANTS)
def tenv(request):
    if request.param == "prototype":
        currency = ensuro.ERC20Token(name="Test", symbol="TEST", initial_supply=Wad(_D(10000)), decimals=6)
        return TEnv(
            time_control=ensuro.time_control,
            currency=currency,
            FixedRateVault=ensuro.FixedRateVault
        )
    elif request.param == "ethereum":
        currency = wrappers.TestCurrency(owner="owner", name="TEST", symbol="TEST",
                                         initial_supply=Wad(_D(10000)), decimals=6)
        return TEnv(
            wrappers.get_provider().time_control,
            currency=currency,
            FixedRateVault=wrappers.FixedRateVault
        )


def test_constructor_uses_same_decimals_as_asset(tenv):
    vault = tenv.FixedRateVault(asset=tenv.currency)
    assert vault.decimals == 6
    assert tenv.currency.decimals == 6

    assert vault.total_assets() == _W(0)


def test_deposit_withdraw_one_lp(tenv):
    vault = tenv.FixedRateVault(asset=tenv.currency)

    with pytest.raises(RevertError, match="allowance"):
        vault.deposit(tenv.currency.owner, USD1K, "LP1")

    tenv.currency.approve(tenv.currency.owner, vault, USD1K)

    vault.deposit(tenv.currency.owner, USD1K, "LP1")

    vault.total_assets().assert_equal(USD1K)

    assert vault.balance_of("LP1") == USDCWAD(1000)
    vault.convert_to_shares(USD1K).assert_equal(USDCWAD(1000))

    with pytest.raises(RevertError):
        vault.withdraw("SOMEONE", USD1K, "LP1", "LP1")

    vault.withdraw("LP1", USD1K, "CHARITY", "LP1")

    tenv.currency.balance_of("CHARITY").assert_equal(USD1K)
    vault.balance_of("LP1").assert_equal(_W(0))
    vault.total_assets().assert_equal(_W(0))


def test_deposit_withdraw_two_lp(tenv):
    vault = tenv.FixedRateVault(asset=tenv.currency)

    tenv.currency.approve(tenv.currency.owner, vault, USD1K * _W(3))

    vault.deposit(tenv.currency.owner, USD1K, "LP1")
    vault.deposit(tenv.currency.owner, USD1K * _W(2), "LP2")

    vault.total_assets().assert_equal(USD1K * _W(3))

    vault.balance_of("LP1").assert_equal(USD1K)
    vault.balance_of("LP2").assert_equal(USD1K * _W(2))
    vault.convert_to_shares(USD1K).assert_equal(USD1K)

    vault.withdraw("LP1", USD1K, "LP1", "LP1")
    tenv.currency.balance_of("LP1").assert_equal(USD1K)
    vault.balance_of("LP1").assert_equal(_W(0))

    vault.total_assets().assert_equal(USD1K * _W(2))
    vault.withdraw("LP2", USD1K, "LP2", "LP2")
    tenv.currency.balance_of("LP2").assert_equal(USD1K)
    vault.total_assets().assert_equal(USD1K)


def test_value_grows_with_interest_rate(tenv):
    vault = tenv.FixedRateVault(asset=tenv.currency)

    tenv.currency.approve(tenv.currency.owner, vault, USD1K)

    vault.deposit(tenv.currency.owner, USD1K, "LP1")

    vault.total_assets().assert_equal(USD1K)
    vault.total_supply().assert_equal(USD1K)

    tenv.time_control.fast_forward(MONTH)
    after_one_month = USD1K * _W(1 + 0.05 / 12)
    vault.total_assets().assert_equal(after_one_month)
    vault.total_supply().assert_equal(USD1K)

    after_one_month_exact = vault.convert_to_assets(vault.balance_of("LP1"))
    after_one_month.assert_equal(after_one_month_exact)
    after_one_month = after_one_month_exact

    vault.withdraw("LP1", after_one_month, "LP1", "LP1")
    tenv.currency.balance_of("LP1").assert_equal(after_one_month)
    vault.balance_of("LP1").assert_equal(_W(0))
    vault.total_assets().assert_equal(_W(0))

    # Test currency was minted
    tenv.currency.total_supply().assert_equal(USD1K * _W(10) + after_one_month - USD1K)
