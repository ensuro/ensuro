import importlib
import re

import yaml
from environs import Env
from ethproto.wadray import _W, Wad, make_integer_float

env = Env()

DAYS_IN_YEAR = 365

HOUR = 3600
DAY = 24 * HOUR
WEEK = 7 * DAY
MONTH = 30 * DAY
YEAR = DAYS_IN_YEAR * DAY


def parse_period(period):
    if period.isdigit():
        return int(period)
    else:
        count = int(period[:-1])
        multiplier = {
            "h": HOUR,
            "d": DAY,
            "w": WEEK,
            "m": MONTH,
            "y": YEAR,
        }[period[-1]]
        return count * multiplier


envvar_matcher = re.compile(r"\$\{([A-Za-z0-9_]+)(:-[^\}]*)?\}")


def envvar_constructor(loader, node):
    """
    Extract the matched value, expand env variable, and replace the match
    ${REQUIRED_ENV_VARIABLE} or ${ENV_VARIABLE:-default}
    """
    global env
    value = node.value
    match = envvar_matcher.match(value)
    env_var = match.group(1)
    default_value = match.group(2)
    if default_value is not None:
        return env.str(env_var, default_value[2:]) + value[match.end() :]
    else:
        return env.str(env_var) + value[match.end() :]


def load_config(yaml_config=None, module=None):
    """Loads the configuration

    @params yaml_config must be a file-like object or None
    """
    if yaml_config is None:
        yaml_config_filename = env.path("SETUP_FILE")
        yaml_config = open(yaml_config_filename)

    yaml.add_implicit_resolver("!envvar", envvar_matcher, Loader=yaml.FullLoader)
    yaml.add_constructor("!envvar", envvar_constructor, Loader=yaml.FullLoader)
    config = yaml.load(yaml_config, Loader=yaml.FullLoader)

    if module is None:
        module = importlib.import_module(config["module"])

    currency_params = dict(config.get("currency", {}))
    if currency_params.get("decimals", 18) == 18:
        to_wad = _W
    else:

        def to_wad(x):
            return Wad(make_integer_float(currency_params["decimals"]).from_value(x))

    currency_params["owner"] = currency_params.get("owner", "owner")
    if "initial_supply" in currency_params:
        currency_params["initial_supply"] = to_wad(currency_params["initial_supply"])
    initial_balances = currency_params.pop("initial_balances", {})
    currency = module.ERC20Token(**currency_params)
    for balance in initial_balances:
        currency.transfer(currency.owner, balance["user"], to_wad(balance["amount"]))

    access_mgr_params = config.get("access_manager", {})
    access_mgr_params.setdefault("owner", "owner")
    access_mgr = module.AccessManager(**access_mgr_params)

    pool_params = config.get("policy_pool", {})
    pool_params.setdefault("name", "Ensuro Policy")
    pool_params.setdefault("symbol", "EPOLI")
    pool_params["currency"] = currency
    pool_params["access"] = access_mgr
    pool = module.PolicyPool(**pool_params)
    pool.access.grant_role("LEVEL1_ROLE", access_mgr.owner)
    pool.access.grant_role("LEVEL2_ROLE", access_mgr.owner)

    default_etk = None

    for etoken_dict in config.get("etokens", []):
        if "symbol" not in etoken_dict:
            etoken_dict["symbol"] = etoken_dict["name"]
        etoken_dict["policy_pool"] = pool
        etoken_dict["owner"] = access_mgr.owner
        etk = module.EToken(**etoken_dict)
        pool.add_etoken(etk)
        if default_etk is None:
            default_etk = etk

    default_premiums_account = None
    for premiums_account_dict in config.get("premiums_accounts", []):
        premiums_account_dict["pool"] = pool
        premiums_account_dict["owner"] = access_mgr.owner
        if "senior_etk" in premiums_account_dict:
            premiums_account_dict["senior_etk"] = pool.etokens[premiums_account_dict["senior_etk"]]
        else:
            premiums_account_dict["senior_etk"] = default_etk
        if "junior_etk" in premiums_account_dict:
            premiums_account_dict["junior_etk"] = pool.etokens[premiums_account_dict["junior_etk"]]
        if "deficit_ratio" in premiums_account_dict:
            deficit_ratio = _W(premiums_account_dict.pop("deficit_ratio"))
        else:
            deficit_ratio = None
        if "jr_loan_limit" in premiums_account_dict:
            jr_loan_limit = to_wad(premiums_account_dict.pop("jr_loan_limit"))
        else:
            jr_loan_limit = None
        if "sr_loan_limit" in premiums_account_dict:
            sr_loan_limit = to_wad(premiums_account_dict.pop("sr_loan_limit"))
        else:
            sr_loan_limit = None
        pa = default_premiums_account = module.PremiumsAccount(**premiums_account_dict)

        if deficit_ratio is not None:
            pa.set_deficit_ratio(deficit_ratio, True)
        if jr_loan_limit is not None or sr_loan_limit is not None:
            pa.set_loan_limits(jr_loan_limit, sr_loan_limit)
        pool.add_premiums_account(default_premiums_account)

    if default_premiums_account is None:
        default_premiums_account = module.PremiumsAccount(pool=pool, senior_etk=default_etk)
        pool.add_premiums_account(default_premiums_account)

    for risk_module_dict in config.get("risk_modules", []):
        role_assignments = risk_module_dict.pop("roles", [])

        risk_module_dict["policy_pool"] = pool
        if "premiums_account" not in risk_module_dict:
            risk_module_dict["premiums_account"] = default_premiums_account

        post_init_attributes = {}
        for key in "jr_coll_ratio,jr_roc".split(","):
            if key in risk_module_dict:
                post_init_attributes[key] = _W(risk_module_dict.pop(key))
        rm = module.TrustfulRiskModule(**risk_module_dict)
        for key, value in post_init_attributes.items():
            setattr(rm, key, value)

        for role_assignment in role_assignments:
            pool.access.grant_component_role(rm, role_assignment["role"], role_assignment["user"])

        pool.add_risk_module(rm)

    for role_assignment in config.get("roles", []):
        pool.access.grant_role(role_assignment["role"], role_assignment["user"])

    return pool
