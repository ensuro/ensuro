import re
import importlib
import yaml
from environs import Env
from ethproto.wadray import _W, make_integer_float, Wad

env = Env()

HOUR = 3600
DAY = 24 * HOUR
WEEK = 7 * DAY
MONTH = 30 * DAY
YEAR = 365 * DAY


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


envvar_matcher = re.compile(r'\$\{([A-Za-z0-9_]+)(:-[^\}]*)?\}')


def envvar_constructor(loader, node):
    '''
    Extract the matched value, expand env variable, and replace the match
    ${REQUIRED_ENV_VARIABLE} or ${ENV_VARIABLE:-default}
    '''
    global env
    value = node.value
    match = envvar_matcher.match(value)
    env_var = match.group(1)
    default_value = match.group(2)
    if default_value is not None:
        return env.str(env_var, default_value[2:]) + value[match.end():]
    else:
        return env.str(env_var) + value[match.end():]


def load_config(yaml_config=None, module=None):
    """Loads the configuration

    @params yaml_config must be a file-like object or None
    """
    if yaml_config is None:
        yaml_config_filename = env.path("SETUP_FILE")
        yaml_config = open(yaml_config_filename)

    yaml.add_implicit_resolver('!envvar', envvar_matcher, Loader=yaml.FullLoader)
    yaml.add_constructor('!envvar', envvar_constructor, Loader=yaml.FullLoader)
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

    nft_params = config.get("nft", {})
    nft_params.setdefault("owner", "owner")
    nft_params.setdefault("name", "Ensuro Policy")
    nft_params.setdefault("symbol", "EPOLI")
    nft = module.PolicyNFT(**nft_params)

    pool_config_params = config.get("access_manager", {})
    pool_config_params.setdefault("owner", "owner")
    pool_config = module.AccessManager(**pool_config_params)

    pool_params = config.get("policy_pool", {})
    pool_params["policy_nft"] = nft
    pool_params["currency"] = currency
    pool_params["access"] = pool_config
    pool = module.PolicyPool(**pool_params)
    pool.access.grant_role("LEVEL1_ROLE", pool_config.owner)

    default_etk = None

    for etoken_dict in config.get("etokens", []):
        if "symbol" not in etoken_dict:
            etoken_dict["symbol"] = etoken_dict["name"]
        etoken_dict["policy_pool"] = pool
        etoken_dict["owner"] = pool_config.owner
        etk = module.EToken(**etoken_dict)
        pool.add_etoken(etk)
        if default_etk is None:
            default_etk = etk

    default_premiums_account = None
    for premiums_account_dict in config.get("premiums_accounts", []):
        premiums_account_dict["pool"] = pool
        if "senior_etk" in premiums_account_dict:
            premiums_account_dict["senior_etk"] = pool.etokens[premiums_account_dict["senior_etk"]]
        else:
            premiums_account_dict["senior_etk"] = default_etk
        if "junior_etk" in premiums_account_dict:
            premiums_account_dict["junior_etk"] = pool.etokens[premiums_account_dict["junior_etk"]]
        default_premiums_account = module.PremiumsAccount(**premiums_account_dict)
        pool.add_premiums_account(default_premiums_account)

    if default_premiums_account is None:
        default_premiums_account = module.PremiumsAccount(pool=pool, senior_etk=default_etk)
        pool.add_premiums_account(default_premiums_account)

    for risk_module_dict in config.get("risk_modules", []):
        role_assignments = risk_module_dict.pop("roles", [])
            
        risk_module_dict["policy_pool"] = pool
        if "premiums_account" not in risk_module_dict:
            risk_module_dict["premiums_account"] = default_premiums_account
        rm = module.TrustfulRiskModule(**risk_module_dict)

        for role_assignment in role_assignments:
            pool.access.grant_component_role(rm, role_assignment["role"], role_assignment["user"])

        pool.add_risk_module(rm)
    

    return pool
