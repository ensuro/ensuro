import yaml
import time
import brownie
from brownie import accounts
from brownie.project import get_loaded_projects
from prototype.wadray import _R, _W


YAML_FILE = "flyion-params.yaml"

dev_account = None

project = get_loaded_projects()[-1]


def _load_params():
    try:
        params_file = open(YAML_FILE, "rt")
    except FileNotFoundError:
        return {}
    return yaml.safe_load(params_file) or {}


def get_param(key):
    params = _load_params()
    return params.get(key, None)


def set_param(key, value):
    params = _load_params()
    params[key] = value
    params_file = open(YAML_FILE, "wt")
    yaml.safe_dump(params, params_file)
    return value


def _account():
    global dev_account
    if dev_account is None:
        account_id = get_param("account_id")
        if account_id is None:
            account_id = set_param("account_id", "guillodev")
        dev_account = accounts.load(account_id)
    return dev_account


def currency():
    ret = get_param("currency")
    if ret is None:
        contract = brownie.TestCurrency.deploy("Test Token", "TST", 1e23, {'from': _account()})
        ret = set_param("currency", contract.address)
    return ret


def policypool():
    currecy_addr = currency()
    ret = get_param("pool")
    if ret is None:
        contract = brownie.PolicyPoolMock.deploy(currecy_addr, {'from': _account()})
        ret = set_param("pool", contract.address)
    return ret


def _link():
    return project.interface.IERC20("0xa36085f69e2889c224210f603d836748e7dc0088")


def flyionrm():
    pool_addr = policypool()
    ret = get_param("flyionrm")
    if ret is None:
        _ = brownie.Policy.deploy({"from": _account()})
        contract = brownie.FlyionRiskModule.deploy(
            "FlyionRM", pool_addr,
            _R(1),
            0,  # premiumShare
            0,  # ensuroShare
            _W(1000),  # maxScrPerPolicy
            _W(10000),  # scrLimit
            "0x20Ce2e29ca6a7Ca6820D6DD3959A4761EE000091",
            0,  # sharedCoverageMinPercentage
            {"from": _account()}
        )
        contract.grantRole(contract.PRICER_ROLE(), accounts[0], {"from": _account()})
        ret = set_param("flyionrm", contract.address)
    return ret


ORACLE_FEE = _W("0.1")


def _new_policy(flight, departure, estimated_arrival, tolerance):
    import ipdb; ipdb.set_trace()
    rm_addr = flyionrm()
    pool_addr = policypool()
    currency_addr = currency()
    test_currency = project.interface.IERC20(currency_addr)
    premium = _W(10)
    if test_currency.allowance(_account(), pool_addr) < premium:
        test_currency.approve(pool_addr, _W(1000), {"from": _account()})
    link = _link()
    if link.balanceOf(rm_addr) < ORACLE_FEE:
        link.transfer(rm_addr, _W(10) * ORACLE_FEE, {"from": _account()})

    rm = project.FlyionRiskModule.at(rm_addr)

    receipt = rm.newPolicy(
        flight,   # Flight Number
        departure,  # Departure
        estimated_arrival,  # Estimated Arrival
        tolerance,        # Tolerance
        premium * _W(60),  # Payout
        premium,           # Premium
        _R("0.01"),        # lossProb
        int(time.time()) + 7200,  # expiration
        _account(),    # customer
        {"from": accounts[0], "gas_limit": 52458 * 10, "allow_revert": True}
    )
    policy_id = receipt.events["NewPolicy"]["policyId"]
    return receipt, policy_id


def newpolicy1():
    _, policy_id = _new_policy("ARG1670", 1624202400, 1624210200, 3600)
    set_param("policy_id_1", int(policy_id))


def newpolicy2():
    # parse("WEDNESDAY 23-JUN-2021 06:25PM EDT", tzinfos={"EDT": pytz.timezone("America/New_York")}).astimezone(pytz.utc).timestamp()
    # parse("24-JUN-2021 05:40AM BST", tzinfos={"BST": pytz.timezone("Europe/London")}).astimezone(pytz.utc).timestamp()
    _, policy_id = _new_policy("AAL100", 1624490460, 1624513260, 600)
    set_param("policy_id_2", int(policy_id))


def newpolicy3():
    # parse("WEDNESDAY 23-JUN-2021 06:25PM EDT", tzinfos={"EDT": pytz.timezone("America/New_York")}).astimezone(pytz.utc).timestamp()
    # parse("24-JUN-2021 05:40AM BST", tzinfos={"BST": pytz.timezone("Europe/London")}).astimezone(pytz.utc).timestamp()
    _, policy_id = _new_policy("ARG1934", 1624482900, 1624490100, 600)
    set_param("policy_id_3", int(policy_id))
