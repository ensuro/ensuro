"""Unitary tests for eToken contract"""

from functools import wraps
from collections import namedtuple
import pytest
from prototype.contracts import RevertError
from prototype import ensuro
from prototype.wadray import _W, _R, Wad
from prototype.utils import WEEK, DAY
from brownie.network.contract import Contract
from . import wrappers

AAVE = namedtuple("AAVE", "address_provider lending_pool price_oracle")


AAVE_AP_ADDRESS = "0xd05e3E715d945B59290df0ae8eF85c1BdB684744"
WMATIC_ADDRESS = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"
USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
SUSHISWAP_ROUTER_ADDRESS = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"


@pytest.fixture
def USDC():
    return wrappers.IERC20.connect(USDC_ADDRESS)


@pytest.fixture
def aave():
    ILendingPoolAddressesProvider = wrappers.get_contract_factory("ILendingPoolAddressesProvider")
    ap = Contract.from_abi(
        "LendingPoolAddressesProvider", AAVE_AP_ADDRESS,
        ILendingPoolAddressesProvider.abi
    )

    addr = ap.getLendingPool()
    ILendingPool = wrappers.get_contract_factory("ILendingPool")
    lending_pool = Contract.from_abi("LendingPool", addr, ILendingPool.abi)

    addr = ap.getPriceOracle()
    IPriceOracle = wrappers.get_contract_factory("IPriceOracle")
    price_oracle = Contract.from_abi("PriceOracle", addr, IPriceOracle.abi)

    return AAVE(ap, lending_pool, price_oracle)


def get_account(name):
    return wrappers.AddressBook.instance.get_account(name)


@pytest.fixture
def WMATIC():
    return wrappers.IERC20.connect(WMATIC_ADDRESS)


def get_usdc_from_ether(account, USDC, aave, WMATIC, collat_ratio):
    account = get_account(account)
    wmatic_balance = WMATIC.balance_of(account)

    WMATIC.approve(account, aave.lending_pool, wmatic_balance)

    aave.lending_pool.deposit(
        WMATIC.contract.address,
        # "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        wmatic_balance, account, 0,
        {"from": account}
    )
    wmatic_in_eth = Wad(aave.price_oracle.getAssetPrice(WMATIC.contract))
    USDC_in_eth = Wad(aave.price_oracle.getAssetPrice(USDC.contract))
    wmatic_in_usdc = wmatic_in_eth // USDC_in_eth
    usd_amount = (wmatic_balance * wmatic_in_usdc * collat_ratio) // _W(10**12)

    aave.lending_pool.borrow(USDC.contract.address, usd_amount, 2, 0, account, {"from": account})

    usd_per_matic = (usd_amount * _W(10**12)) // (wmatic_balance * collat_ratio)

    return wmatic_balance, usd_amount, usd_per_matic


@pytest.fixture
def PolicyPoolAndConfig(USDC):
    from brownie import PolicyPoolMockForward

    config = wrappers.PolicyPoolConfig("owner")
    pool = PolicyPoolMockForward.deploy(get_account(None), USDC.contract, config.contract,
                                        {"from": config.owner})
    return config, pool


def donate_wmatic(WMATIC, ac_from, ac_to, amount=None):
    # First convert MATIC to WMATIC
    ac_from, ac_to = get_account(ac_from), get_account(ac_to)
    amount = amount or ac_from.balance()
    ac_from.transfer(WMATIC.contract.address, amount)
    # Then transfer to destination
    WMATIC.transfer(ac_from, ac_to, amount)


def skip_if_not_fork(f):
    from brownie._config import CONFIG
    if CONFIG.argv.get("network", None) == "polygon-main-fork":
        return f
    else:
        def test_foo():
            pass
        test_foo.__name__ = f.__name__

        return test_foo


# @pytest.mark.require_network("polygon-main-fork") - DOES NOT WORK
@skip_if_not_fork
def test_aave_asset_manager(USDC, aave, PolicyPoolAndConfig, WMATIC):
    AAVE_address = "0x1a13f4ca1d028320a707d99520abfefca3998b7f"
    assert int(USDC.balance_of(AAVE_address)) > (1000000 * 10**6)  # At least 1 millon if in the right fork

    # Donates matic so we have more balance
    for i in range(5):
        donate_wmatic(WMATIC, f"CHARITY{i}", "LP1")

    wmatic_balance, usd_amount, usd_per_matic = get_usdc_from_ether("LP1", USDC, aave, WMATIC, _W("0.3"))
    USDC.balance_of("LP1").assert_equal(usd_amount)

    config, pool = PolicyPoolAndConfig

    liquidity_min = usd_amount * _W("0.1")
    liquidity_middle = usd_amount * _W("0.5")
    liquidity_max = usd_amount * _W("0.8")

    aave_mgr = wrappers.AaveAssetManager(
        config.owner, pool,
        liquidity_min=liquidity_min,
        liquidity_middle=liquidity_middle,
        liquidity_max=liquidity_max,
        aave_address_provider=AAVE_AP_ADDRESS,
        swap_router=SUSHISWAP_ROUTER_ADDRESS
    )

    # Donate 2 matic to aave_mgr
    donate_wmatic(WMATIC, "VITALIK", aave_mgr.contract, _W(2))

    pool.setForwardTo(aave_mgr.contract, {"from": config.owner})

    aave_mgr.get_investment_value().assert_equal(_W(2) * usd_per_matic // _W(10**12))

    config.grant_role("LEVEL1_ROLE", config.owner)
    config.set_asset_manager(aave_mgr)

    # Transfer LP1 USD to PolicyPoolMockForward
    USDC.transfer("LP1", pool, usd_amount)
    USDC.balance_of(pool).assert_equal(usd_amount)

    aave_mgr.rebalance()
    aave_mgr.aToken.balance_of(aave_mgr).assert_equal(liquidity_middle)
    USDC.balance_of(pool).assert_equal(usd_amount - liquidity_middle)
    # Rewards are reinvested on each rebalance
    aave_mgr.rewardToken.balance_of(aave_mgr).assert_equal(_W(0))
    aave_mgr.rewardAToken.balance_of(aave_mgr).assert_equal(_W(2))

    # swapRewards
    with pytest.raises(RevertError, match="AccessControl"):
        swapIn, swapOut = aave_mgr.swap_rewards(_W(3))

    config.grant_role("SWAP_REWARDS_ROLE", "WHOKNOWSWHENTOSELL")

    with aave_mgr.as_("WHOKNOWSWHENTOSELL"):
        wmatic_in, usdc_out = aave_mgr.swap_rewards(_W(3))

    wmatic_in.assert_equal(_W(2))
    usdc_out.assert_equal(_W(2) * usd_per_matic // _W(10**12))
    aave_mgr.aToken.balance_of(aave_mgr).assert_equal(liquidity_middle + usdc_out)

    # Donate another 3 matic to aave_mgr
    donate_wmatic(WMATIC, "VITALIK", aave_mgr.contract, _W(1))

    aave_mgr.get_investment_value().assert_equal(
        liquidity_middle + usdc_out + _W(1) * usd_per_matic // _W(10**12)
    )

    one_dollar = _W(1) // _W(10**12)
    with aave_mgr.thru_policy_pool():
        aave_mgr.refill_wallet(usd_amount - liquidity_middle + one_dollar)
    # Money taken from aToken
    aave_mgr.aToken.balance_of(aave_mgr).assert_equal(liquidity_middle + usdc_out - one_dollar)

    USDC.balance_of(pool).assert_equal(usd_amount - liquidity_middle + one_dollar)
    aave_mgr.rebalance()
    USDC.balance_of(pool).assert_equal(usd_amount - liquidity_middle)  # Shouldn't change

    config.set_asset_manager(None)  # Should deinvestAll
    USDC.balance_of(pool).assert_equal(usd_amount + _W(3) * usd_per_matic // _W(10**12))

    # No funds in aave_mgr
    aave_mgr.aToken.balance_of(aave_mgr).assert_equal(_W(0))
    WMATIC.balance_of(aave_mgr).assert_equal(_W(0))
    aave_mgr.rewardAToken.balance_of(aave_mgr).assert_equal(_W(0))
