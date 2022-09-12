from collections import namedtuple
from io import StringIO
import pytest
from ethproto.contracts import RevertError
from ethproto.wadray import _W, _R, set_precision, Wad, make_integer_float
from ethproto.wrappers import get_provider
from prototype.utils import load_config, WEEK, DAY, HOUR
from . import extract_vars, is_brownie_coverage_enabled, TEST_VARIANTS

TEnv = namedtuple("TEnv", "time_control module kind")

USDC = make_integer_float(6, "USDC")
_D = USDC.from_value


@pytest.fixture(params=TEST_VARIANTS)
def tenv(request):
    if request.param == "prototype":
        from prototype import ensuro
        return TEnv(
            time_control=ensuro.time_control,
            module=ensuro,
            kind="prototype"
        )
    elif request.param == "ethereum":
        from prototype import wrappers
        # Resets the address book on every test, to avoid some strange errors
        # like EOA addresses recognized as contracts
        from brownie import accounts
        from ethproto.brwrappers import AddressBook
        from ethproto.brwrappers import BrownieAddressBook
        address_book = BrownieAddressBook(accounts)
        AddressBook.set_instance(address_book)
        get_provider().address_book = address_book

        return TEnv(
            time_control=get_provider().time_control,
            module=wrappers,
            kind="ethereum"
        )


def _calculate_shares(balances, total_supply):
    return dict((k, v // total_supply) for (k, v) in balances.items())


def _deposit(pool, etk_name, lp, amount, assert_deposit=True):
    """Approves and deposits a given amount"""
    pool.currency.approve(lp, pool.contract_id, amount)
    if assert_deposit:
        pool.deposit(etk_name, lp, amount).assert_equal(amount)
    else:
        pool.deposit(etk_name, lp, amount)


def test_transfers(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: 1
        sr_roc: "0.01"
        ensuro_pp_fee: 0
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 3503
        - user: CUST1
          amount: 100
    etokens:
      - name: eUSD1YEAR
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]

    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)

    scr = _W(3500 + (100/37)) + _W("0.0001")  # Rounding error

    _deposit(pool, "eUSD1YEAR", "LP1", scr)
    etoken = pool.etokens["eUSD1YEAR"]

    pool.currency.approve("CUST1", pool.contract_id, _W(100))
    policy = rm.new_policy(
        payout=_W(3600), premium=_W(100), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=123
    )

    etoken.funds_available.assert_equal(_W(0))
    timecontrol.fast_forward(3 * DAY)

    interest = policy.sr_coc

    etoken.balance_of("LP1").assert_equal(
        scr + interest * _W(3/7)
    )
    lp1_balance = etoken.balance_of("LP1")

    etoken.transfer("LP1", "LP2", lp1_balance // _W(2))
    etoken.approve("LP1", "SPEND", lp1_balance // _W(6))
    etoken.transfer_from("SPEND", "LP1", "LP3", lp1_balance // _W(6))

    # lp1_balance split in
    # LP2 1/2 = 50%
    # LP3 1/6 = 16.67%
    # LP1 1/3 = 33.33%
    etoken.balance_of("LP1").assert_equal(lp1_balance // _W(3))
    etoken.balance_of("LP2").assert_equal(lp1_balance // _W(2))
    etoken.balance_of("LP3").assert_equal(lp1_balance // _W(6))

    timecontrol.fast_forward(2 * DAY)

    etoken.balance_of("LP1").assert_equal(lp1_balance // _W(3) + interest * _W(2/7) // _W(3))
    etoken.balance_of("LP2").assert_equal(lp1_balance // _W(2) + interest * _W(2/7) // _W(2))
    etoken.balance_of("LP3").assert_equal(lp1_balance // _W(6) + interest * _W(2/7) // _W(6))

    rm.resolve_policy(policy.id, True)
    # All solvency used, only the intest remains
    etoken.balance_of("LP1").assert_equal(interest // _W(3))
    etoken.balance_of("LP2").assert_equal(interest // _W(2))
    etoken.balance_of("LP3").assert_equal(interest // _W(6))


def test_transfers_usdc(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: 1
        sr_roc: "0.01"
        ensuro_pp_fee: 0
    currency:
        name: USD
        decimals: 6
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 3503
        - user: CUST1
          amount: 100
    premiums_accounts:
    - senior_etk: eUSD1YEAR
    etokens:
      - name: eUSD1YEAR
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]

    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)

    scr = Wad(_D(3500 + (100/37)) + _D("0.0001"))  # Rounding error

    etoken = pool.etokens["eUSD1YEAR"]
    _deposit(pool, "eUSD1YEAR", "LP1", scr)

    pool.currency.approve("CUST1", pool.contract_id, Wad(_D(100)))
    policy = rm.new_policy(
        payout=Wad(_D(3600)), premium=Wad(_D(100)), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=123
    )

    etoken.funds_available.assert_equal(Wad(_D(0)))
    timecontrol.fast_forward(3 * DAY)

    interest = policy.sr_coc

    etoken.balance_of("LP1").assert_equal(
        Wad(_D(3500)) + interest * _W(3/7)
    )
    lp1_balance = etoken.balance_of("LP1")

    etoken.transfer("LP1", "LP2", lp1_balance // _W(2))
    etoken.approve("LP1", "SPEND", lp1_balance // _W(6))
    etoken.transfer_from("SPEND", "LP1", "LP3", lp1_balance // _W(6))

    # lp1_balance split in
    # LP2 1/2 = 50%
    # LP3 1/6 = 16.67%
    # LP1 1/3 = 33.33%
    etoken.balance_of("LP1").assert_equal(lp1_balance // _W(3))
    etoken.balance_of("LP2").assert_equal(lp1_balance // _W(2))
    etoken.balance_of("LP3").assert_equal(lp1_balance // _W(6))

    timecontrol.fast_forward(2 * DAY)

    etoken.balance_of("LP1").assert_equal(lp1_balance // _W(3) + interest * _W(2/7) // _W(3))
    etoken.balance_of("LP2").assert_equal(lp1_balance // _W(2) + interest * _W(2/7) // _W(2))
    etoken.balance_of("LP3").assert_equal(lp1_balance // _W(6) + interest * _W(2/7) // _W(6))

    rm.resolve_policy(policy.id, True)
    # All solvency used, only the intest remains
    etoken.balance_of("LP1").assert_equal(interest // _W(3))
    etoken.balance_of("LP2").assert_equal(interest // _W(2))
    etoken.balance_of("LP3").assert_equal(interest // _W(6))


def xtest_not_accept_rm(tenv):
    # TODO: rewrite this test without using rebalance_policy
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: 1
        ensuro_pp_fee: 0
        sr_roc: "0.01"
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 2037
        - user: LP2
          amount: 1000
        - user: LP3
          amount: 1000
        - user: CUST1
          amount: 100
    etokens:
      - name: eUSD1WEEK
      - name: eUSD1MONTH
      - name: eCASINO
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    pool.access.grant_role("LEVEL2_ROLE", rm.owner)

    eUSD1MONTH = pool.etokens["eUSD1MONTH"]
    eUSD1WEEK = pool.etokens["eUSD1WEEK"]

    with eUSD1MONTH.as_(rm.owner):
        eUSD1MONTH.accept_all_rms = False
    with eUSD1WEEK.as_(rm.owner):
        eUSD1WEEK.set_accept_exception(rm, True)

    _deposit(pool, "eCASINO", "LP1", _W(2037))
    _deposit(pool, "eUSD1MONTH", "LP3", _W(1000))
    _deposit(pool, "eUSD1WEEK", "LP2", _W(1000))

    pool.currency.approve("CUST1", pool.contract_id, _W(100))
    policy = rm.new_policy(
        payout=_W(2100), premium=_W(100), customer="CUST1",
        loss_prob=_W("0.03"), expiration=timecontrol.now + 10 * DAY,
        internal_id=123
    )
    assert policy.sr_scr == _W(2037)
    for_lps = policy.sr_coc
    for_lps.assert_equal(_W(2037) * _W("0.01") * _W(10/365))

    # Only eCASINO accepts the policy
    # eUSD1MONTH rejects because it rejects any RM unless exception
    # eUSD1WEEK rejects because of expiration
    assert pool.etokens["eCASINO"].funds_available == _W(0)
    assert eUSD1MONTH.funds_available == _W(1000)
    assert eUSD1WEEK.funds_available == _W(1000)

    assert pool.get_policy_fund_count(policy.id) == 1

    timecontrol.fast_forward(4 * DAY)

    # Calculate oceans when policy unlocked to be relocked
    oceans = {
        "eCASINO": pool.etokens["eCASINO"].total_supply(),
        "eUSD1MONTH": eUSD1MONTH.total_supply(),
        "eUSD1WEEK": eUSD1WEEK.total_supply(),
    }

    total_ocean = _W(3000) + for_lps * _W(4/10)

    # After four days, now the policy expires in less than a week. Anyway still RM is exclusive, nothing
    # changes
    pool.access.grant_role("REBALANCE_ROLE", "REBALANCER_USER")
    with pool.as_("REBALANCER_USER"):
        pool.rebalance_policy(policy.id)

    ocean_shares = _calculate_shares(oceans, total_ocean)

    # SCR is allocated in all tokens
    for etk_name, scr_share in ocean_shares.items():
        if etk_name == "eCASINO":
            pool.etokens[etk_name].scr.assert_equal(policy.sr_scr)
        else:
            pool.etokens[etk_name].scr.assert_equal(_W(0))

    with eUSD1WEEK.as_(rm.owner):
        eUSD1WEEK.set_accept_exception(rm, False)
    with eUSD1MONTH.as_(rm.owner):
        eUSD1MONTH.set_accept_exception(rm, True)

    # Now reallocation should have effect
    with pool.as_("REBALANCER_USER"):
        pool.rebalance_policy(policy.id)

    # SCR is allocated in all tokens
    total_scr = _W(0)
    for etk_name, scr_share in ocean_shares.items():
        assert not pool.etokens[etk_name].scr.equal(_W(0))
        total_scr += pool.etokens[etk_name].scr

    eUSD1MONTH.scr.assert_equal(policy.sr_scr * _W(1000/4037), decimals=1)
    eUSD1WEEK.scr.assert_equal(policy.sr_scr * _W(1000/4037), decimals=1)
    total_scr.assert_equal(policy.sr_scr)


@set_precision(Wad, 3)
def test_walkthrough(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: 1
        ensuro_pp_fee: 0
        sr_roc: "0.040233686"  # interest rate to make partner_commission=0
      - name: Flight-Insurance
        coll_ratio: "0.9"
        ensuro_pp_fee: "0.015"
      - name: Fire-Insurance
        coll_ratio: "0.8"
        ensuro_pp_fee: "0.005"
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 1000
        - user: LP2
          amount: 2000
        - user: LP3
          amount: 2000
        - user: CUST1
          amount: 1
        - user: CUST2
          amount: 2
        - user: CUST3
          amount: 130
    etokens:
      - name: eUSD1YEAR
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    premiums_account = rm.premiums_account
    pool.access.grant_role("LEVEL2_ROLE", rm.owner)  # For setting sr_roc

    with pytest.raises(RevertError, match="transfer amount exceeds allowance|insufficient allowance"):
        pool.deposit("eUSD1YEAR", "LP1", _W(1000))

    assert pool.currency.balance_of("LP1") == _W(1000)  # unchanged

    _deposit(pool, "eUSD1YEAR", "LP1", _W(1000))

    eUSD1YEAR = pool.etokens["eUSD1YEAR"]
    USD = pool.currency

    assert eUSD1YEAR.balance_of("LP1") == _W(1000)
    assert eUSD1YEAR.funds_available == _W(1000)
    assert USD.balance_of("LP1") == _W(0)

    timecontrol.fast_forward(WEEK)

    assert eUSD1YEAR.balance_of("LP1") == _W(1000)  # Unchanged

    with pytest.raises(RevertError, match="You must allow ENSURO"):
        policy = policy_1 = policy = rm.new_policy(
            payout=_W(36), premium=_W(1), customer="CUST1",
            loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
            internal_id=111
        )

    pool.currency.approve("CUST1", pool.contract_id, _W(1))
    policy_1 = policy = rm.new_policy(
        payout=_W(36), premium=_W(1), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=111
    )

    assert policy.sr_scr.equal(_W(35 + 1/37))
    assert policy.pure_premium.equal(_W(36) * _W(1/37))
    policy.sr_interest_rate.assert_equal(_W("0.0402336860"), decimals=4)

    assert eUSD1YEAR.balance_of('LP1').equal(_W("1000"))
    # After one day, balance increases because of accrued interest of policy
    timecontrol.fast_forward(DAY)
    p1_one_day_interest = policy.sr_coc // _W(7)  # 1/7 since the policy lasts 1 WEEK
    assert eUSD1YEAR.balance_of('LP1').equal(_W("1000") + p1_one_day_interest)

    _deposit(pool, "eUSD1YEAR", "LP2", _W(2000))

    # After one day both balances increase
    timecontrol.fast_forward(DAY)
    assert eUSD1YEAR.balance_of('LP1').equal(
        _W(1000) + p1_one_day_interest + p1_one_day_interest * _W(1) // _W(3)
    )
    assert eUSD1YEAR.balance_of('LP2').equal(
        _W(2000) + p1_one_day_interest * _W(2) // _W(3)
    )

    # New deposits
    pool.currency.approve("LP3", pool.contract_id, _W(2000))
    _deposit(pool, "eUSD1YEAR", "LP3", _W(2000))

    balances_1y = dict((lp, eUSD1YEAR.balance_of(lp)) for lp in ("LP1", "LP2", "LP3"))
    shares_1y = _calculate_shares(balances_1y, eUSD1YEAR.total_supply())

    pool.currency.approve("CUST2", pool.contract_id, _W(2))

    # With 10 days, the same interest rate is not possible, need to reduce the interest to keep
    # the same premium proportion
    with pytest.raises(RevertError, match="Premium less than minimum"):
        policy_2 = policy = rm.new_policy(
            payout=_W(72), premium=_W(2), customer="CUST2",
            loss_prob=_W(1/37), expiration=timecontrol.now + 10 * DAY,
            internal_id=222
        )

    p2_for_lps = _W(2 - 72/37)
    rm.sr_roc = (
        p2_for_lps * _W(365 / 10) // _W(72 - 72/37)
    ).round(6)  # too much precision

    policy_2 = policy = rm.new_policy(
        payout=_W(72), premium=_W(2), customer="CUST2",
        loss_prob=_W(1/37), expiration=timecontrol.now + 10 * DAY,
        internal_id=333
    )

    assert policy.sr_scr.equal(_W(72 - 72/37))
    assert policy.pure_premium.equal(_W(72) * _W(1/37))
    policy.sr_interest_rate.assert_equal(
        (policy.premium - policy.pure_premium) * _W(365 / 10) // policy.sr_scr
    )
    p2_one_day_interest = policy.sr_coc // _W(10)

    timecontrol.fast_forward(DAY)

    for lp in ("LP1", "LP2", "LP3"):
        balance = eUSD1YEAR.balance_of(lp)
        assert balance.equal(
            balances_1y[lp] + (p1_one_day_interest + p2_one_day_interest) * shares_1y[lp]
        )
        balances_1y[lp] = balance
    shares_1y = _calculate_shares(balances_1y, eUSD1YEAR.total_supply())

    # Resolve 1st policy
    accrued_interest = p1_one_day_interest * _W(3)
    assert accrued_interest.equal(policy_1.sr_accrued_interest())

    borrow_from_scr = policy_1.payout - premiums_account.pure_premiums
    adjustment = policy_1.sr_coc - accrued_interest
    rm.resolve_policy(policy_1.id, True)

    assert USD.balance_of("CUST1") == _W(36)
    assert USD.balance_of(eUSD1YEAR).equal(_W(1000 + 2000 + 2000 + 2 - 35))

    borrow_from_scr.assert_equal(eUSD1YEAR.get_loan(premiums_account))
    daily_pool_loan_interest = eUSD1YEAR.internal_loan_interest_rate // _W(365)

    for lp in ("LP1", "LP2", "LP3"):
        balance = eUSD1YEAR.balance_of(lp)
        balance.assert_equal(
            balances_1y[lp] + (adjustment - borrow_from_scr) * shares_1y[lp]
        )
        balances_1y[lp] = balance
    shares_1y = _calculate_shares(balances_1y, eUSD1YEAR.total_supply())
    total_supply_before = eUSD1YEAR.total_supply()

    timecontrol.fast_forward(2 * DAY)

    balances_after = dict((lp, eUSD1YEAR.balance_of(lp)) for lp in ("LP1", "LP2", "LP3"))
    shares_after = _calculate_shares(balances_after, eUSD1YEAR.total_supply())
    assert shares_1y == shares_after
    assert (eUSD1YEAR.total_supply() - total_supply_before).equal(
        p2_one_day_interest * _W(2)
    )
    balances_1y = balances_after

    p2_accrued_interest = p2_one_day_interest * _W(3)
    assert p2_accrued_interest.equal(policy_2.sr_accrued_interest())
    p2_for_lps = policy_2.sr_coc
    adjustment = p2_for_lps - p2_accrued_interest
    rm.resolve_policy(policy_2.id, False)

    assert USD.balance_of("CUST2") == _W(0)
    USD.balance_of(pool.contract_id).assert_equal(_W(0))  # Balance no longer in the pool
    USD.balance_of(eUSD1YEAR).assert_equal(
        _W(1000 + 2000 + 2000 + 2 - 35)
    )  # unchanged

    for lp in ("LP1", "LP2", "LP3"):
        balance = eUSD1YEAR.balance_of(lp)

        (balance - balances_1y[lp]).assert_equal(
            adjustment * shares_1y[lp]
        )
        balances_1y[lp] = balance
    shares_1y = _calculate_shares(balances_1y, eUSD1YEAR.total_supply())

    assert eUSD1YEAR.get_loan(premiums_account).equal((
        borrow_from_scr * (_W(1) + daily_pool_loan_interest * _W(2))
    ).to_wad())  # pool_loan is the same but with 2 days interest
    eUSD1YEAR.total_supply().assert_equal(_W("4967"))

    pool.withdraw("eUSD1YEAR", "LP2", None).assert_equal(_W("1986.7994"))

    policies = []

    pool.currency.approve("CUST3", pool.contract_id, _W(130))

    if is_brownie_coverage_enabled(tenv):
        return  # This test never ends if coverage is activated

    won_count = 0

    # Adjust interest rate to make for_rm = 0
    rm.sr_roc = (
        _W(2 - 72/37) * _W(365 / 6) // _W(72 - 72/37)
    ).round(6)  # too much precision

    for day in range(65):
        pool_loan = eUSD1YEAR.get_loan(premiums_account)
        new_p = rm.new_policy(
            payout=_W(72), premium=_W(2),
            loss_prob=_W(1/37), expiration=timecontrol.now + 6 * DAY,
            customer="CUST3",
            internal_id=1000 + day
        )
        customer_won = day % 37 == 36
        for p in list(policies):
            if p.expiration > (timecontrol.now + DAY):
                break
            if customer_won:
                won_count += 1
                if p.payout < premiums_account.pure_premiums:
                    change = _W(0)
                else:
                    change = (premiums_account.pure_premiums - p.payout)
            else:
                change = min(pool_loan, p.pure_premium)
            rm.resolve_policy(p.id, customer_won)
            policies.pop(0)

            assert eUSD1YEAR.get_loan(premiums_account).equal(pool_loan - change)
            pool_loan = eUSD1YEAR.get_loan(premiums_account)

        timecontrol.fast_forward(DAY)
        policies.append(new_p)
        assert eUSD1YEAR.get_loan(premiums_account).equal(
            pool_loan * (_W(1) + daily_pool_loan_interest)
        )

    pool_loan = eUSD1YEAR.get_loan(premiums_account)

    for i, p in enumerate(policies):
        day = 65 + i
        customer_won = day % 37 == 36
        rm.resolve_policy(p.id, customer_won)
        if customer_won:
            won_count += 1
            repay = _W(0)
        else:
            repay = min(
                pool_loan, p.pure_premium
            )
        assert eUSD1YEAR.get_loan(premiums_account).equal(pool_loan - repay)

        timecontrol.fast_forward(DAY)
        assert eUSD1YEAR.get_loan(premiums_account).equal(
            (pool_loan - repay) * (_W(1) + daily_pool_loan_interest)
        )
        pool_loan = eUSD1YEAR.get_loan(premiums_account)

    assert eUSD1YEAR.get_loan(premiums_account) == _W(0)
    premiums_account.pure_premiums.assert_equal(
        _W("21.296283705442503107"), decimals=2
    )  # from jypiter prints

    USD.balance_of(eUSD1YEAR).assert_equal(
        _W(1000 + 2000 + 2 - 35 + 2 * 65 - 72 * won_count) +
        _W(2000) - _W("1986.7994") - premiums_account.pure_premiums, decimals=2
    )

    USD.balance_of(premiums_account).assert_equal(premiums_account.pure_premiums)

    pool.withdraw("eUSD1YEAR", "LP1", None).assert_equal(
        _W("1005.638186186546873425"), decimals=2
    )
    pool.withdraw("eUSD1YEAR", "LP3", None).assert_equal(
        _W("2011.266018358631673932"), decimals=2
    )
    USD.balance_of(premiums_account.contract_id).assert_equal(
        _W("21.296283705442503146"), decimals=2
    )

    USD.balance_of(pool.contract_id).assert_equal(_W(0))

    USD.balance_of("LP1").assert_equal(
        _W("1005.638186186546873425"), decimals=2
    )
    USD.balance_of("LP3").assert_equal(
        _W("2011.266018358631673932"), decimals=2
    )
    USD.balance_of("CUST3").assert_equal(_W(72))


def test_nfts(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: 1
        ensuro_pp_fee: 0
    nft:
        name: Ensuro Policy NFT
        symbol: EPOL
    currency:
        name: USD
        symbol: $
        initial_supply: 9000
        initial_balances:
        - user: LP1
          amount: 7006
        - user: CUST1
          amount: 200
    etokens:
      - name: eUSD1YEAR
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    nft = pool.policy_nft
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)

    usd = pool.currency

    _deposit(pool, "eUSD1YEAR", "LP1", _W(3503))

    usd.approve("CUST1", pool.contract_id, _W(100))
    policy = rm.new_policy(
        payout=_W(3600), premium=_W(100), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=2**96 - 1
    )

    assert nft.balance_of("CUST1") == 1
    assert nft.owner_of(policy.id) == "CUST1"
    assert policy.id % (2**96) == (2**96 - 1)
    assert policy.id == rm.make_policy_id(2**96 - 1)

    nft.transfer_from("CUST1", "CUST1", "CUST2", policy.id)

    timecontrol.fast_forward(WEEK - DAY)
    rm.resolve_policy(policy.id, True)
    assert usd.balance_of("CUST1") == _W(100)
    assert usd.balance_of("CUST2") == _W(3600)

    _deposit(pool, "eUSD1YEAR", "LP1", _W(3503), assert_deposit=False)
    usd.approve("CUST1", pool.contract_id, _W(100))
    with pytest.raises(RevertError, match="Already exists|token already minted"):
        policy = rm.new_policy(
            payout=_W(1800), premium=_W(50), customer="CUST1",
            loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
            internal_id=2**96 - 1
        )


def test_policy_holder_contract(tenv):
    if tenv.kind != "ethereum":
        return

    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: 1
        ensuro_pp_fee: 0
    nft:
        name: Ensuro Policy NFT
        symbol: EPOL
    currency:
        name: USD
        symbol: $
        initial_supply: 9000
        initial_balances:
        - user: LP1
          amount: 7006
        - user: CUST1
          amount: 200
    etokens:
      - name: eUSD1YEAR
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    nft = pool.policy_nft
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)

    PolicyHolderMock = get_provider().get_contract_factory("PolicyHolderMock")
    ph_mock = PolicyHolderMock.deploy(False, {"from": rm.owner})

    assert ph_mock.policyId() == 0

    usd = pool.currency

    _deposit(pool, "eUSD1YEAR", "LP1", _W(3503))

    usd.approve("CUST1", pool.contract_id, _W(100))
    policy = rm.new_policy(
        payout=_W(3600), premium=_W(100), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=2**96 - 1
    )

    assert nft.balance_of("CUST1") == 1
    assert nft.owner_of(policy.id) == "CUST1"
    assert policy.id % (2**96) == (2**96 - 1)
    assert policy.id == rm.make_policy_id(2**96 - 1)

    nft.safe_transfer_from("CUST1", "CUST1", ph_mock, policy.id)
    assert ph_mock.policyId() == policy.id

    timecontrol.fast_forward(WEEK - DAY)

    ph_mock.setFail(True)
    with pytest.raises(RevertError, match="onPayoutReceived: They told me I have to fail"):
        rm.resolve_policy(policy.id, True)

    ph_mock.setFail(False)
    rm.resolve_policy(policy.id, True)

    assert ph_mock.policyId() == policy.id
    assert ph_mock.payout() == _W(3600)

    assert usd.balance_of("CUST1") == _W(100)
    assert usd.balance_of(ph_mock) == _W(3600)

    _deposit(pool, "eUSD1YEAR", "LP1", _W(3503), assert_deposit=False)
    usd.approve("CUST1", pool.contract_id, _W(100))

    # Create a 2nd policy
    policy = rm.new_policy(
        payout=_W(1800), premium=_W(50), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=2**96 - 3
    )

    nft.transfer_from("CUST1", "CUST1", ph_mock, policy.id)
    rm.resolve_policy(policy.id, False)

    assert ph_mock.policyId() == policy.id
    assert ph_mock.payout() == _W(0)

    # Create a 3rd policy - just to verify failing holder doesn't reverts
    policy = rm.new_policy(
        payout=_W(1800), premium=_W(50), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=2**96 - 4
    )

    nft.transfer_from("CUST1", "CUST1", ph_mock, policy.id)
    ph_mock.setFail(True)
    rm.resolve_policy(policy.id, False)


@set_precision(Wad, 2)
def test_partial_payout(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: "0.8"
        ensuro_pp_fee: 0
        sr_roc: "0.0506438"  # interest rate to make partner_commission=0
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 3500
        - user: CUST1
          amount: 100
    etokens:
      - name: eUSD1YEAR
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    premiums_account = rm.premiums_account

    usd = pool.currency

    _deposit(pool, "eUSD1YEAR", "LP1", _W(3500))

    usd.approve("CUST1", pool.contract_id, _W(100))
    policy = rm.new_policy(
        payout=_W(3600), premium=_W(100), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=111
    )

    policy.partner_commission.assert_equal(_W(0))
    policy.sr_scr.assert_equal(_W(3600 * .8) - _W(3600/37))

    assert pool.etokens["eUSD1YEAR"].funds_available.equal(_W(3500) - policy.sr_scr)
    assert pool.etokens["eUSD1YEAR"].scr == _W(policy.sr_scr)
    timecontrol.fast_forward(WEEK - HOUR)
    rm.resolve_policy(policy.id, _W(1900))
    assert usd.balance_of("CUST1") == _W(1900)
    pool.etokens["eUSD1YEAR"].funds_available.assert_equal(_W(1700))
    pool.etokens["eUSD1YEAR"].scr.assert_equal(_W(0))
    pool.etokens["eUSD1YEAR"].get_loan(premiums_account).assert_equal(
        _W(1800) + _W(100/37)
    )  # The pool owes the loss + the capital gain


def test_internal_loan_partial_payout(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: "0.8"
        ensuro_pp_fee: 0
        sr_roc: "0.0506438"  # interest rate to make partner_commission=0
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 3500
        - user: CUST1
          amount: 2000
    etokens:
      - name: eUSD1YEAR
    """
    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    premiums_account = rm.premiums_account

    usd = pool.currency

    _deposit(pool, "eUSD1YEAR", "LP1", _W(3500))
    usd.approve("CUST1", pool.contract_id, _W(2000))

    policy = rm.new_policy(
        payout=_W(3600), premium=_W(2000), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + 2 * WEEK,
        internal_id=123
    )

    policy.pure_premium.assert_equal(_W(3600/37))
    policy.sr_scr.assert_equal(_W(3600 * .8) - policy.pure_premium)

    eUSD1YEAR = pool.etokens["eUSD1YEAR"]
    premiums_account.won_pure_premiums.assert_equal(_W(0))
    eUSD1YEAR.get_loan(premiums_account).assert_equal(_W(0))

    assert eUSD1YEAR.funds_available.equal(_W(3500) - policy.sr_scr)
    assert eUSD1YEAR.scr == policy.sr_scr
    timecontrol.fast_forward(2 * WEEK - HOUR)
    rm.resolve_policy(policy.id, _W(1999))
    assert usd.balance_of("CUST1") == _W(1999)

    eUSD1YEAR.get_loan(premiums_account).assert_equal(_W(1999) - policy.pure_premium)
    assert premiums_account.pure_premiums == _W(0)


def test_increase_won_pure_premiums(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: "0.8"
        ensuro_pp_fee: 0
        sr_roc: "0.0506438"  # interest rate to make partner_commission=0
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 3500
        - user: CUST1
          amount: 2000
    etokens:
      - name: eUSD1YEAR
    """
    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    premiums_account = rm.premiums_account

    usd = pool.currency

    _deposit(pool, "eUSD1YEAR", "LP1", _W(3500))
    usd.approve("CUST1", pool.contract_id, _W(2000))

    policy = rm.new_policy(
        payout=_W(3600), premium=_W(2000), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=222
    )
    policy.pure_premium.assert_equal(_W(3600/37))
    policy.sr_scr.assert_equal(_W(3600 * .8) - policy.pure_premium)

    eUSD1YEAR = pool.etokens["eUSD1YEAR"]
    premiums_account.won_pure_premiums.assert_equal(_W(0))
    eUSD1YEAR.get_loan(premiums_account).assert_equal(_W(0))

    assert eUSD1YEAR.funds_available.equal(_W(3500) - policy.sr_scr)
    timecontrol.fast_forward(WEEK - HOUR)
    rm.resolve_policy(policy.id, _W(60))
    assert usd.balance_of("CUST1") == _W(60)

    assert _W(60) < policy.pure_premium

    premiums_account.won_pure_premiums.assert_equal(policy.pure_premium - _W(60))


def test_payout_bigger_than_pure_premium(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: "0.8"
        ensuro_pp_fee: 0
        sr_roc: "0.0506438"  # interest rate to make partner_commission=0
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 3500
        - user: CUST1
          amount: 2000
    etokens:
      - name: eUSD1YEAR
    """
    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    premiums_account = rm.premiums_account

    usd = pool.currency

    _deposit(pool, "eUSD1YEAR", "LP1", _W(3500))
    usd.approve("CUST1", pool.contract_id, _W(2000))

    policy = rm.new_policy(
        payout=_W(3600), premium=_W(2000), customer="CUST1",
        loss_prob=_W(1/37), expiration=timecontrol.now + WEEK,
        internal_id=333
    )
    policy.pure_premium.assert_equal(_W("97.297297"))

    eUSD1YEAR = pool.etokens["eUSD1YEAR"]
    premiums_account.won_pure_premiums.assert_equal(_W(0))
    eUSD1YEAR.get_loan(premiums_account).assert_equal(_W(0))

    timecontrol.fast_forward(WEEK - HOUR)
    rm.resolve_policy(policy.id, _W(100))
    assert usd.balance_of("CUST1") == _W(100)
    premiums_account.won_pure_premiums.assert_equal(_W(0))
    eUSD1YEAR.get_loan(premiums_account).assert_equal(_W(100) - policy.pure_premium)


# TODO: define later if partial payouts pay to ensuro_commission and partner_commission if possible


@set_precision(Wad, 3)
def xtest_asset_manager(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: 1
        sr_roc: "0.02"
    currency:
        name: USD
        symbol: $
        initial_supply: 20000
        initial_balances:
        - user: LP1
          amount: 10000
        - user: CUST1
          amount: 200
    etokens:
      - name: eUSD1YEAR
    asset_manager:
        class: FixedRateAssetManager
        liquidity_min: 1000
        liquidity_middle: 1500
        liquidity_max: 2000
        interest_rate: "0.05"
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    premiums_account = rm.premiums_account

    USD = pool.currency
    etk = pool.etokens["eUSD1YEAR"]
    asset_manager = pool.access.asset_manager

    _deposit(pool, "eUSD1YEAR", "LP1", _W(10000))

    asset_manager.checkpoint()  # Rebalance cash

    assert USD.balance_of(pool.contract_id) == _W(1500)
    assert USD.balance_of(asset_manager.contract_id) == _W(8500)

    timecontrol.fast_forward(365 * DAY)
    assert etk.balance_of("LP1") == _W(10000)
    asset_manager.checkpoint()
    assert USD.balance_of(pool.contract_id) == _W(1500)  # unchanged
    etk.balance_of("LP1").assert_equal(_W(10000) + _W(8500) * _W("0.05"))  # All earnings for the LP
    lp1_balance = etk.balance_of("LP1")

    USD.approve("CUST1", pool.contract_id, _W(200))
    policy = rm.new_policy(
        payout=_W(9200), premium=_W(200), customer="CUST1",
        loss_prob=_W("0.01"), expiration=timecontrol.now + 365 * DAY // 2,
        internal_id=22
    )
    for_lps = policy.sr_coc

    asset_manager.checkpoint()
    USD.balance_of(pool.contract_id).assert_equal(
        _W(1500) + policy.pure_premium + policy.coc
    )
    etk.balance_of("LP1").assert_equal(lp1_balance)
    pool.get_investable().assert_equal(policy.pure_premium)
    etk.get_investable().assert_equal(lp1_balance)
    # policy.coc is not accounted neither as investable from the pool nor the ETK.
    # That's fine because it's money moving second by second from one to the other
    # It only affects the share of the earnings
    # TODO: think a better approach for get_investable

    timecontrol.fast_forward(365 * DAY // 2 - 60)
    pool.get_investable().assert_equal(policy.pure_premium)
    etk.get_investable().assert_equal(lp1_balance + for_lps, decimals=2)

    pool_share = _W(policy.pure_premium) // asset_manager.total_investable()
    etk_share = etk.get_investable() // asset_manager.total_investable()
    asset_manager.checkpoint()

    premiums_account.won_pure_premiums.assert_equal(_W(8500) * _W("0.025") * pool_share)
    etk.balance_of("LP1").assert_equal(
        lp1_balance + for_lps + _W(8500) * _W("0.025") * etk_share, decimals=2
    )
    rm.resolve_policy(policy.id, True)
    assert USD.balance_of(pool.contract_id) == _W(1500)  # balance back to middle
    USD.balance_of(asset_manager.contract_id).assert_equal(
        _W(10000) +                # initial LP investment
        _W(8500) * _W("0.075") +   # earned interest
        policy.pure_premium + policy.coc -  # part of the premium retained in the pool
        _W(9200) -  # payout
        _W(1500)    # 1500 (liquidity_middle)
    )

    assert pool.get_investable() == _W(0)
    assert etk.get_investable() == (
        etk.funds_available + etk.get_loan(premiums_account)
        # not really the money available but used for etk_share
    )


def xtest_assets_under_liquidity_middle(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: "0.3734"
        sr_roc: "0.1"
        scr_limit: 250000
        ensuro_pp_fee: "0.0392"
        max_payout_per_policy: 500
    currency:
        name: USD
        symbol: $
        initial_supply: 20000
        initial_balances:
        - user: LP1
          amount: 10000
        - user: LP2
          amount: 1000
        - user: CUST1
          amount: 200
    etokens:
      - name: eUSD1YEAR
    asset_manager:
        class: FixedRateAssetManager
        liquidity_min: 1000
        liquidity_middle: 1500
        liquidity_max: 2000
    """
    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    premiums_account = rm.premiums_account

    pool.access.grant_role("LEVEL2_ROLE", rm.owner)  # For setting moc

    with rm.as_(rm.owner):
        rm.moc = _W("1.285")

    rm.moc.assert_equal(_W(1.285))

    USD = pool.currency
    etk = pool.etokens["eUSD1YEAR"]
    asset_manager = pool.access.asset_manager

    _deposit(pool, "eUSD1YEAR", "LP1", _W(100))

    USD.approve("CUST1", pool.contract_id, _W(100))
    policy = rm.new_policy(
        payout=_W(10), premium=_W("1.5"), customer="CUST1",
        loss_prob=_W("0.103"), expiration=timecontrol.now + 45 * DAY,
        internal_id=11
    )
    pure_premium, for_ensuro = policy.pure_premium, policy.ensuro_commission
    for_rm, for_lps = policy.partner_commission, policy.sr_coc
    etk.scr.assert_equal(_W(10) * _W("0.3734") - pure_premium)

    asset_manager.checkpoint()
    pure_premium.assert_equal(_W("1.3236"))
    for_lps.assert_equal(policy.sr_scr * _W("0.1") * _W(45/365), decimals=4)
    for_ensuro.assert_equal((pure_premium + for_lps) * _W("0.0392"))
    for_rm.assert_equal(_W("1.5") - pure_premium - for_lps - for_ensuro)

    rm.resolve_policy(policy.id, False)

    policy_2 = rm.new_policy(
        payout=_W(5), premium=_W("0.705"), customer="CUST1",
        loss_prob=_W("0.103"), expiration=timecontrol.now + 45 * DAY,
        internal_id=22
    )

    pure_premium, for_ensuro = policy_2.pure_premium, policy_2.ensuro_commission
    for_rm, for_lps = policy_2.partner_commission, policy_2.sr_coc

    pure_premium.assert_equal(_W("0.6618"))
    for_lps.assert_equal(policy_2.scr * _W("0.1") * _W(45/365), decimals=4)
    for_ensuro.assert_equal((pure_premium + for_lps) * _W("0.0392"))
    for_rm.assert_equal(_W("0.705") - pure_premium - for_lps - for_ensuro)

    rm.resolve_policy(policy_2.id, _W(3))

    pool.withdraw("eUSD1YEAR", "LP1", _W(80)).assert_equal(_W(80))
    premiums_account.pure_premiums.assert_equal(_W(0))
    etk.get_loan(premiums_account).assert_equal(_W(3) - policy.pure_premium - policy_2.pure_premium)


def xtest_distribute_negative_earnings(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: "0.2448"
        sr_roc: "0.0729"
        scr_limit: 250000
        ensuro_pp_fee: "0.0321"
        max_payout_per_policy: 500
    currency:
        name: USD
        symbol: $
        initial_supply: 20000
        initial_balances:
        - user: LP1
          amount: 10000
        - user: LP2
          amount: 1000
        - user: CUST1
          amount: 200
    etokens:
      - name: eUSD1YEAR
    asset_manager:
        class: FixedRateAssetManager
        liquidity_min: 1000
        liquidity_middle: 1500
        liquidity_max: 2000
    """
    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)

    asset_manager = pool.access.asset_manager

    _deposit(pool, "eUSD1YEAR", "LP1", _W(5000))

    asset_manager.rebalance()
    asset_manager.get_investment_value().assert_equal(_W(3500))
    timecontrol.fast_forward(365 * DAY)
    asset_manager.get_investment_value().assert_equal(_W(3500) * _W("1.05"))

    asset_manager.distribute_earnings()
    timecontrol.fast_forward(365 * DAY)
    asset_manager.get_investment_value().assert_equal(_W(3500) * _W("1.1"), decimals=0)

    # Now change the asset manager to negative interest rate
    asset_manager.positive = False
    timecontrol.fast_forward(365 * DAY)
    asset_manager.distribute_earnings()
    asset_manager.get_investment_value().assert_equal(_W(3500) * _W("1.1") * _W("0.95"))


def xtest_distribute_negative_earnings_full_capital_from_etokens(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: "0.2448"
        sr_roc: "0.0729"
        scr_limit: 250000
        ensuro_pp_fee: "0.0321"
        max_payout_per_policy: 500
    currency:
        name: USD
        symbol: $
        initial_supply: 20000
        initial_balances:
        - user: LP1
          amount: 10000
        - user: LP2
          amount: 1000
        - user: CUST1
          amount: 200
    etokens:
      - name: eUSD1YEAR
    asset_manager:
        class: FixedRateAssetManager
        liquidity_min: 1000
        liquidity_middle: 1500
        liquidity_max: 2000
    """
    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)

    USD = pool.currency
    etk = pool.etokens["eUSD1YEAR"]
    asset_manager = pool.access.asset_manager
    etk.balance_of("LP1").assert_equal(_W(0))

    _deposit(pool, "eUSD1YEAR", "LP1", _W(5000))
    etk.balance_of("LP1").assert_equal(_W(5000))

    USD.approve("CUST1", pool.contract_id, _W(100))
    policy = rm.new_policy(
        payout=_W(10), premium=_W(1.5), customer="CUST1",
        loss_prob=_W("0.105"), expiration=timecontrol.now + 45 * DAY,
        internal_id=123
    )

    etk.get_loan(premiums_account).assert_equal(_W(0))

    asset_manager.rebalance()
    initial_investment_value = (
        _W(5000) - asset_manager.liquidity_middle + policy.pure_premium + policy.coc
    )
    asset_manager.get_investment_value().assert_equal(initial_investment_value)
    timecontrol.fast_forward(45 * DAY - HOUR)
    rm.resolve_policy(policy.id, True)
    etk.get_loan(premiums_account).assert_equal(_W(10) - policy.pure_premium)
    investment_earning = initial_investment_value * _W("0.05") * _W(45/365)
    asset_manager.get_investment_value().assert_equal(
        initial_investment_value + investment_earning,
        decimals=1
    )
    pre_investment_value = asset_manager.get_investment_value()

    USD.balance_of(pool.contract_id).assert_equal(_W(1490))
    asset_manager.distribute_earnings()
    etk.balance_of("LP1").assert_equal(
        _W(5000) - (_W(10) - policy.pure_premium) + investment_earning,
        decimals=2
    )
    lp1_balance = etk.balance_of("LP1")

    policy_2 = rm.new_policy(
        payout=_W(5), premium=_W("0.75"), customer="CUST1",
        loss_prob=_W("0.105"), expiration=timecontrol.now + 45 * DAY,
        internal_id=232
    )

    timecontrol.fast_forward(45 * DAY - HOUR)
    asset_manager.distribute_earnings()
    post_investment_value = asset_manager.get_investment_value()
    earnings = post_investment_value - pre_investment_value
    earnings.assert_equal(
        pre_investment_value * _W("0.05") * _W(45/365), decimals=0
    )

    USD.balance_of(pool.contract_id).assert_equal(_W(1490) + policy_2.pure_premium, decimals=2)
    etk.balance_of("LP1").assert_equal(lp1_balance + earnings, decimals=2)
    lp1_balance = etk.balance_of("LP1")

    # Now change the asset manager to negative interest rate
    asset_manager.distribute_earnings()
    pre_investment_value = asset_manager.get_investment_value()
    asset_manager.positive = False
    timecontrol.fast_forward(45 * DAY)
    asset_manager.distribute_earnings()
    post_investment_value = asset_manager.get_investment_value()
    losses = pre_investment_value - post_investment_value
    losses.assert_equal(
        pre_investment_value * _W("0.05") * _W(45/365), decimals=0
    )

    USD.balance_of(pool.contract_id).assert_equal(_W(1490) + policy_2.pure_premium, decimals=2)  # same
    etk.balance_of("LP1").assert_equal(lp1_balance - losses, decimals=2)


def xtest_distribute_negative_earnings_from_pool_and_etokens(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: 1
        sr_roc: "0.02"
    currency:
        name: USD
        symbol: $
        initial_supply: 20000
        initial_balances:
        - user: LP1
          amount: 10000
        - user: CUST1
          amount: 200
    etokens:
      - name: eUSD1YEAR
    asset_manager:
        class: FixedRateAssetManager
        liquidity_min: 1000
        liquidity_middle: 1500
        liquidity_max: 2000
    """
    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)

    USD = pool.currency
    etk = pool.etokens["eUSD1YEAR"]
    asset_manager = pool.access.asset_manager

    _deposit(pool, "eUSD1YEAR", "LP1", _W(10000))

    assert USD.balance_of(asset_manager.contract_id) == _W(0)
    assert etk.balance_of("LP1") == _W(10000)

    USD.approve("CUST1", pool.contract_id, _W(200))
    policy = rm.new_policy(
        payout=_W(9200), premium=_W(200), customer="CUST1",
        loss_prob=_W("0.01"), expiration=timecontrol.now + 365 * DAY // 2,
        internal_id=111
    )
    etk.get_loan(premiums_account).assert_equal(_W(0))

    asset_manager.rebalance()
    expected_investment_value = (
        _W(10000) - asset_manager.liquidity_middle + policy.pure_premium + policy.coc
    )
    asset_manager.get_investment_value().assert_equal(expected_investment_value)
    timecontrol.fast_forward(365 * DAY)
    expected_investment_value_with_interest = expected_investment_value * _W("1.05")  # interest_rate=5%
    asset_manager.get_investment_value().assert_equal(expected_investment_value_with_interest)

    asset_manager.distribute_earnings()
    timecontrol.fast_forward(365 * DAY)

    assert USD.balance_of(pool.contract_id) == _W(1500)
    pool.get_investable().assert_equal(premiums_account.pure_premiums)
    assert premiums_account.pure_premiums > policy.pure_premium  # Increased because of earnings
    prev_pp = premiums_account.pure_premiums
    etk.get_investable().assert_equal(etk.funds_available + etk.scr + etk.get_loan(premiums_account))

    pre_investment_value = asset_manager.get_investment_value()
    asset_manager.positive = False
    timecontrol.fast_forward(365 * DAY)
    asset_manager.distribute_earnings()
    post_investment_value = asset_manager.get_investment_value()
    (pre_investment_value - post_investment_value).assert_equal(
        pre_investment_value * _W("0.05"), decimals=2
    )
    pool.get_investable().assert_equal(premiums_account.pure_premiums)
    assert premiums_account.pure_premiums < prev_pp  # Reduced negative earnings
    etk.get_investable().assert_equal(etk.funds_available + etk.scr + etk.get_loan(premiums_account))


def xtest_insolvency_without_hook(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: "0.1"
        sr_roc: "0.02"
    currency:
        name: USD
        symbol: $
        initial_supply: 20000
        initial_balances:
        - user: LP1
          amount: 5000
        - user: LP2
          amount: 3000
        - user: LP3
          amount: 8000
        - user: CUST1
          amount: 200
        - user: CUST2
          amount: 200
    etokens:
      - name: eUSD1YEAR
        internal_loan_interest_rate: "0.06"
      - name: eUSD1MONTH
        internal_loan_interest_rate: "0.04"
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)

    USD = pool.currency
    etk = pool.etokens["eUSD1YEAR"]

    _deposit(pool, "eUSD1YEAR", "LP1", _W(1000))

    USD.approve("CUST1", pool.contract_id, _W(200))
    policy = rm.new_policy(
        payout=_W(9200), premium=_W(200), customer="CUST1",
        loss_prob=_W("0.01"), expiration=timecontrol.now + 365 * DAY // 2,
        internal_id=122
    )
    etk.scr.assert_equal(_W(9200) * _W("0.1") - policy.pure_premium)

    assert USD.balance_of(pool.contract_id) == (_W(1000) + policy.pure_premium + policy.coc)

    timecontrol.fast_forward(365 * DAY // 2 - 60)

    with pytest.raises(RevertError, match="ERC20: transfer amount exceeds balance"):
        rm.resolve_policy(policy.id, True)

    return locals()


def xtest_grant_insolvency_hook(tenv):
    vars = test_insolvency_without_hook(tenv)
    pool, rm, policy = extract_vars(vars, "pool,rm,policy")
    ins_hook = tenv.module.FreeGrantInsolvencyHook(pool=pool)
    pool.access.set_insolvency_hook(ins_hook)

    rm.resolve_policy(policy.id, True)

    ins_hook.cash_granted.assert_equal(_W(8000) + policy.ensuro_commission + policy.partner_commission)


def xtest_lp_insolvency_hook(tenv):
    vars = test_insolvency_without_hook(tenv)
    pool, rm, etk, policy = extract_vars(vars, "pool,rm,etk,for_lps,policy,USD")
    ins_hook = tenv.module.LPInsolvencyHook(pool=pool, etoken="eUSD1YEAR")
    pool.access.set_insolvency_hook(ins_hook)

    rm.resolve_policy(policy.id, True)

    ins_hook.cash_deposited.assert_equal(_W(8000) + policy.ensuro_commission + policy.partner_commission)
    etk.funds_available.assert_equal(_W(0))
    etk.scr.assert_equal(_W(0))
    etk.get_loan(premiums_account).assert_equal(_W(9200) - policy.pure_premium, decimals=2)

    etk.balance_of("LP1").assert_equal(_W(0))
    etk.balance_of(ins_hook).assert_equal(_W(0))

    _deposit(pool, "eUSD1YEAR", "LP2", _W(3000))
    etk.balance_of("LP1").assert_equal(_W(0))
    etk.balance_of(ins_hook).assert_equal(_W(0))


def xtest_lp_insolvency_hook_negative_ocean(tenv):
    """
    Two policies, pool balance is enought for covering the payout, but leaves the EToken
    with less supply than SCR (negative funds_available).
    """
    vars = test_insolvency_without_hook(tenv)
    pool, rm, etk, for_lps, policy, USD, timecontrol = extract_vars(
        vars, "pool,rm,etk,for_lps,policy,USD,timecontrol"
    )
    ins_hook = tenv.module.LPInsolvencyHook(pool=pool, etoken="eUSD1YEAR")
    pool.access.set_insolvency_hook(ins_hook)

    etk.total_supply().assert_equal(_W(1000) + for_lps, decimals=2)

    _deposit(pool, "eUSD1YEAR", "LP3", _W(8000))
    lp3_share = _W(8000) // (_W(9000) + for_lps)

    USD.approve("CUST2", pool.contract_id, _W(200))
    policy_2 = rm.new_policy(
        payout=_W(9200), premium=_W(200), customer="CUST2",
        loss_prob=_W("0.01"), expiration=timecontrol.now + 365 * DAY // 2,
        internal_id=333
    )
    etk.scr.assert_equal(policy_2.scr + policy.sr_scr)

    USD.balance_of(pool.contract_id).assert_equal(
        _W(9000) +
        policy.pure_premium + policy.coc +
        policy_2.pure_premium + policy_2.coc
    )

    rm.resolve_policy(policy.id, _W(9190))

    ins_hook.cash_deposited.assert_equal(_W(0))  # Not needed
    etk.funds_available.assert_equal(_W(0))
    etk.scr.assert_equal(policy_2.scr)
    etk.get_loan(premiums_account).assert_equal(
        _W(9190) - policy.pure_premium - policy_2.pure_premium
    )

    etk.total_supply().assert_equal(
        _W(9000) -  # Money deposited
        _W(9190) +   # Payout
        policy.pure_premium + policy_2.pure_premium +
        policy.coc  # Other for_lps not yet accrued
    )
    pool.borrowed_active_pp.assert_equal(policy_2.pure_premium)

    etk.balance_of("LP3").assert_equal(etk.total_supply() * lp3_share)
    etk.balance_of("LP1").assert_equal(etk.total_supply() * (_W(1) - lp3_share))
    etk.balance_of(ins_hook).assert_equal(_W(0))


def xtest_lp_insolvency_hook_cover_etoken(tenv):
    """
    Two policies, pool balance is enought for covering the payout. On insolvent etoken (SCR>total_supply)
    calls the insolvency_hook that deposits some extra cash.
    """
    vars = test_insolvency_without_hook(tenv)
    pool, rm, etk, for_lps, policy, USD, timecontrol = extract_vars(
        vars, "pool,rm,etk,for_lps,policy,USD,timecontrol"
    )
    ins_hook = tenv.module.LPInsolvencyHook(pool=pool, etoken="eUSD1YEAR", cover_etoken=1)
    pool.access.set_insolvency_hook(ins_hook)

    etk.total_supply().assert_equal(_W(1000) + for_lps, decimals=2)

    _deposit(pool, "eUSD1YEAR", "LP3", _W(8000))

    USD.approve("CUST2", pool.contract_id, _W(200))
    policy_2 = rm.new_policy(
        payout=_W(9200), premium=_W(200), customer="CUST2",
        loss_prob=_W("0.01"), expiration=timecontrol.now + 365 * DAY // 2,
        internal_id=12
    )
    etk.scr.assert_equal(policy_2.scr + policy.sr_scr)
    etk.funds_available.assert_equal(_W(9000) - etk.scr + for_lps)

    USD.balance_of(pool.contract_id).assert_equal(
        _W(9000) +
        policy.pure_premium + policy.coc +
        policy_2.pure_premium + policy_2.coc
    )

    rm.resolve_policy(policy.id, _W("9192.2"))

    pool_loan = _W("9192.2") - policy.pure_premium - policy_2.pure_premium
    etk.get_loan(premiums_account).assert_equal(
        pool_loan
    )

    ins_hook.cash_deposited.assert_equal(policy_2.scr * _W("1.1"), decimals=1)
    etk.funds_available.assert_equal(policy_2.scr * _W("0.1"))  # The insolvency_hook leaves 10% of extra funds_available
    etk.scr.assert_equal(policy_2.scr)
    etk.total_supply().assert_equal(policy_2.scr * _W("1.1"))
    pool.borrowed_active_pp.assert_equal(policy_2.pure_premium)

    etk.balance_of("LP3").assert_equal(_W(0), decimals=0)
    etk.balance_of("LP1").assert_equal(_W(0), decimals=0)
    etk.balance_of(ins_hook).assert_equal(policy_2.scr * _W("1.1"), decimals=1)


@set_precision(Wad, 3)
def xtest_lp_insolvency_hook_other_etk(tenv):
    vars = test_insolvency_without_hook(tenv)
    pool, premiums_account, rm, etk, for_lps, policy, USD, timecontrol = extract_vars(
        vars, "pool,premiums_account,rm,etk,for_lps,policy,USD,timecontrol"
    )
    etk1m = pool.etokens["eUSD1MONTH"]
    ins_hook = tenv.module.LPInsolvencyHook(pool=pool, etoken="eUSD1MONTH")
    pool.access.set_insolvency_hook(ins_hook)

    rm.resolve_policy(policy.id, True)
    USD.balance_of("CUST1").assert_equal(_W(9200))

    ins_hook.cash_deposited.assert_equal(_W(8000) + policy.ensuro_commission + policy.partner_commission)
    etk.funds_available.assert_equal(_W(0))
    etk.scr.assert_equal(_W(0))
    etk.get_loan(premiums_account).assert_equal(_W(1000) + for_lps)
    etk1m.get_loan(premiums_account).assert_equal(_W(8000) + policy.ensuro_commission + policy.partner_commission)

    etk.balance_of("LP1").assert_equal(_W(0))
    etk.balance_of(ins_hook).assert_equal(_W(0))
    etk1m.balance_of(ins_hook).assert_equal(_W(0))

    _deposit(pool, "eUSD1YEAR", "LP2", _W(3000))

    # Now our charitative customers gives some of the money back as grant
    USD.approve("CUST1", pool.contract_id, _W(9200))
    pool.receive_grant("CUST1", _W(4000))
    premiums_account.won_pure_premiums.assert_equal(_W(4000))  # The grant is on premium pool

    pool.repay_etoken_loan("eUSD1MONTH").assert_equal(_W(4000))
    etk1m.get_loan(premiums_account).assert_equal(_W(4000) + policy.ensuro_commission + policy.partner_commission,
                                       decimals=2)
    etk1m_pool_loan = etk1m.get_loan(premiums_account)

    etk1m.balance_of(ins_hook).assert_equal(_W(4000), decimals=2)
    premiums_account.won_pure_premiums.assert_equal(_W(0))  # The grant is no longer in premium pool

    # After some time and send another grant
    timecontrol.fast_forward(30 * DAY)
    pool.receive_grant("CUST1", _W(5000))
    pool_loan_1y = etk.get_loan(premiums_account)
    pool_loan_1y.assert_equal((_W(1000) + for_lps) * _W(1.0 + 0.06 * 30 / 365))
    # Only is repaid up to pool loan
    pool.repay_etoken_loan("eUSD1YEAR").assert_equal(pool_loan_1y)

    pool.repay_etoken_loan("eUSD1MONTH").assert_equal(_W(5000) - pool_loan_1y)
    etk1m.get_loan(premiums_account).assert_equal(
        etk1m_pool_loan - (_W(5000) - pool_loan_1y) + etk1m_pool_loan * _W(0.04 * 30/365)
    )


def test_lp_whitelist(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: "0.1"
        sr_roc: "0.02"
    currency:
        name: USD
        symbol: $
        initial_supply: 20000
        initial_balances:
        - user: LP1
          amount: 5000
        - user: LP2
          amount: 3000
        - user: CUST1
          amount: 200
    etokens:
      - name: eUSD1YEAR
        internal_loan_interest_rate: "0.06"
      - name: eUSD1MONTH
        internal_loan_interest_rate: "0.04"
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    USD = pool.currency
    etk = pool.etokens["eUSD1YEAR"]

    # Without whitelist, anyone can deposit
    _deposit(pool, "eUSD1YEAR", "LP1", _W(1000))

    whitelist = tenv.module.LPManualWhitelist(pool=pool)

    with pool.access.as_("johndoe"), pytest.raises(RevertError, match="AccessControl"):
        etk.set_whitelist(whitelist)

    pool.access.grant_role("GUARDIAN_ROLE", "admin")
    with etk.as_("admin"):
        etk.set_whitelist(whitelist)

    # Now only whitelisted can deposit
    USD.approve("LP2", pool.contract_id, _W(3000))
    with pytest.raises(RevertError, match="Liquidity Provider not whitelisted"):
        pool.deposit("eUSD1YEAR", "LP2", _W(1000))

    # Whitelisting requires permission
    with whitelist.as_("johndoe"), pytest.raises(RevertError, match="AccessControl"):
        whitelist.whitelist_address("LP2", True)

    pool.access.grant_component_role(whitelist, "LP_WHITELIST_ROLE", "amlcompliance")
    with whitelist.as_("amlcompliance"):
        whitelist.whitelist_address("LP2", True)

    assert pool.deposit("eUSD1YEAR", "LP2", _W(2000)) == _W(2000)

    # Transfer targets need to be whitelisted too
    with pytest.raises(RevertError, match="Transfer not allowed - Liquidity Provider not whitelisted"):
        etk.transfer("LP2", "LP3", _W(500))

    with whitelist.as_("amlcompliance"):
        whitelist.whitelist_address("LP3", True)
    etk.transfer("LP2", "LP3", _W(500))

    etk.balance_of("LP2").assert_equal(_W(1500))
    etk.balance_of("LP3").assert_equal(_W(500))
    etk.balance_of("LP1").assert_equal(_W(1000))

    pool.withdraw("eUSD1YEAR", "LP1", None).assert_equal(_W(1000))  # Non whitelisted can withdraw

    # De-whitelist can't deposit anymore
    with whitelist.as_("amlcompliance"):
        whitelist.whitelist_address("LP2", False)
    with pytest.raises(RevertError, match="Liquidity Provider not whitelisted"):
        pool.deposit("eUSD1YEAR", "LP2", _W(1000))

    # But can withdraw
    pool.withdraw("eUSD1YEAR", "LP2", _W(300)).assert_equal(_W(300))


def test_expire_policy(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Flight Insurance
        coll_ratio: "0.1"
        ensuro_pp_fee: "0.05"
        sr_roc: "0.01"
        wallet: "MGA"
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 1000
        - user: LP2
          amount: 1000
        - user: LP3
          amount: 1000
        - user: CUST1
          amount: 100
    etokens:
      - name: eUSD1YEAR
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    etk = pool.etokens["eUSD1YEAR"]
    USD = pool.currency
    rm = pool.risk_modules["Flight Insurance"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    pool.access.grant_role("LEVEL2_ROLE", rm.owner)  # For setting moc
    premiums_account = rm.premiums_account

    with rm.as_(rm.owner):
        rm.moc = _W("1.1")
        rm.ensuro_coc_fee = _W("0.05")

    _deposit(pool, "eUSD1YEAR", "LP1", _W(1000))

    pool.currency.approve("CUST1", pool.contract_id, _W(100))
    policy = rm.new_policy(
        payout=_W(2100), premium=_W(100), customer="CUST1",
        loss_prob=_W("0.03"), expiration=timecontrol.now + 10 * DAY,
        internal_id=122
    )

    # Check for_rm and for_ensuro are paid upfront
    pool.currency.balance_of("MGA").assert_equal(policy.partner_commission)
    pool.currency.balance_of("ENS").assert_equal(policy.ensuro_commission)

    policy.sr_scr.assert_equal(_W(2100) * _W("0.1") - policy.pure_premium)
    etk.scr.assert_equal(_W(2100) * _W("0.1") - policy.pure_premium)
    rm.active_exposure.assert_equal(policy.payout)
    pure_premium, for_ensuro, for_rm, for_lps = (
        policy.pure_premium, policy.ensuro_commission,
        policy.partner_commission, policy.sr_coc
    )

    for_lps.assert_equal(policy.sr_scr * _W("0.01") * _W(10/365))
    pure_premium.assert_equal(_W(2100) * _W("0.03") * _W("1.1"))
    for_ensuro.assert_equal((pure_premium + for_lps) * _W("0.05"))
    for_rm.assert_equal(_W(100) - for_lps - for_ensuro - pure_premium)

    timecontrol.fast_forward(4 * DAY)

    with pytest.raises(RevertError, match="Policy not expired yet"):
        pool.expire_policy(policy.id)

    timecontrol.fast_forward(7 * DAY)

    pool.expire_policy(policy.id)
    etk.scr.assert_equal(_W(0))
    etk.funds_available.assert_equal(_W(1000) + for_lps)

    USD.balance_of("ENS").assert_equal(for_ensuro)
    USD.balance_of("MGA").assert_equal(for_rm)
    USD.balance_of("CUST1").assert_equal(_W(0))
    premiums_account.won_pure_premiums.assert_equal(pure_premium)
    rm.active_exposure.assert_equal(_W(0))

    return locals()


def test_expire_policy_payout(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Flight Insurance
        coll_ratio: "0.1"
        ensuro_pp_fee: "0.05"
        sr_roc: "0.01"
        wallet: "MGA"
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 1000
        - user: LP2
          amount: 1000
        - user: LP3
          amount: 1000
        - user: CUST1
          amount: 100
    etokens:
      - name: eUSD1YEAR
    """

    pool = load_config(StringIO(YAML_SETUP), tenv.module)
    timecontrol = tenv.time_control
    etk = pool.etokens["eUSD1YEAR"]  # noqa
    USD = pool.currency  # noqa
    rm = pool.risk_modules["Flight Insurance"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)
    pool.access.grant_role("LEVEL2_ROLE", rm.owner)  # For setting moc

    with rm.as_(rm.owner):
        rm.moc = _W("1.1")

    _deposit(pool, "eUSD1YEAR", "LP1", _W(1000))

    pool.currency.approve("CUST1", pool.contract_id, _W(100))
    policy = rm.new_policy(
        payout=_W(2100), premium=_W(100), customer="CUST1",
        loss_prob=_W("0.03"), expiration=timecontrol.now + 10 * DAY,
        internal_id=123
    )

    timecontrol.fast_forward(12 * DAY)
    with pytest.raises(RevertError, match="Can't pay expired policy"):
        rm.resolve_policy(policy.id, True)

    rm.resolve_policy(policy.id, False)


def test_withdraw_won_premiums(tenv):
    if is_brownie_coverage_enabled(tenv):
        return  # This test never ends if coverage is activated
    vars = test_expire_policy(tenv)
    pool, premiums_account, USD = extract_vars(vars, "pool,premiums_account,USD")
    treasury_balance = USD.balance_of("ENS")
    won_pure_premiums = premiums_account.won_pure_premiums

    with pytest.raises(RevertError, match="AccessControl"):
        premiums_account.withdraw_won_premiums(_W(1), "ENS")

    pool.access.grant_component_role(
        premiums_account, "WITHDRAW_WON_PREMIUMS_ROLE", "PREMIUM_WITHDRAWER"
    )
    with premiums_account.as_("PREMIUM_WITHDRAWER"):
        premiums_account.withdraw_won_premiums(_W(10), "ENS").assert_equal(_W(10))

    USD.balance_of("ENS").assert_equal(treasury_balance + _W(10))
    premiums_account.won_pure_premiums.assert_equal(won_pure_premiums - _W(10))

    with premiums_account.as_("PREMIUM_WITHDRAWER"):
        premiums_account.withdraw_won_premiums(_W(999999), "ENS").assert_equal(
            won_pure_premiums - _W(10)
        )

    USD.balance_of("ENS").assert_equal(treasury_balance + won_pure_premiums)
    premiums_account.won_pure_premiums.assert_equal(0)


def test_risk_provider_cant_drain_liquidity_provider(tenv):
    YAML_SETUP = """
    risk_modules:
      - name: Roulette
        coll_ratio: 1
        sr_roc: "0.01"
        ensuro_pp_fee: 0
    currency:
        name: USD
        symbol: $
        initial_supply: 6000
        initial_balances:
        - user: LP1
          amount: 3000
    etokens:
      - name: eUSD1YEAR
    """

    # Given an lp LP1
    pool = load_config(StringIO(YAML_SETUP), tenv.module)

    # LP1 approved the pool to access their funds
    USD = pool.currency
    USD.approve("LP1", pool.contract_id, _W(2000))

    # LP1 provided funds
    pool.deposit("eUSD1YEAR", "LP1", _W(1000))
    assert USD.balance_of("LP1") ==  _W(2000)

    # Risk Provider creates a policy for LP1
    rm = pool.risk_modules["Roulette"]
    pool.access.grant_component_role(rm, "PRICER_ROLE", rm.owner)
    pool.access.grant_component_role(rm, "RESOLVER_ROLE", rm.owner)

    policy = rm.new_policy(
        payout=_W(100), premium=_W(10), customer="LP1",
        loss_prob=_W(1/101), expiration=tenv.time_control.now + WEEK,
        internal_id=123
    )

    # The policy is held by LP1
    assert pool.policy_nft.owner_of(policy.id) == "LP1"

    # Premium was paid by caller
    assert USD.balance_of("owner") == _W(2900)

    # LP1's balance should not be affected
    assert USD.balance_of("LP1") ==  _W(2000)