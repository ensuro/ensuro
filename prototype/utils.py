import re
import importlib
import yaml
from environs import Env
from ethproto.wadray import _W

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

    currency_params = config.get("currency", {})
    currency_params["owner"] = currency_params.get("owner", "owner")
    if "initial_supply" in currency_params:
        currency_params["initial_supply"] = _W(currency_params["initial_supply"])
    initial_balances = currency_params.pop("initial_balances", {})
    currency = module.ERC20Token(**currency_params)
    for balance in initial_balances:
        currency.transfer(currency.owner, balance["user"], _W(balance["amount"]))

    nft_params = config.get("nft", {})
    nft_params.setdefault("owner", "owner")
    nft_params.setdefault("name", "Ensuro Policy")
    nft_params.setdefault("symbol", "EPOLI")
    nft = module.PolicyNFT(**nft_params)

    pool_config_params = config.get("policy_pool_config", {})
    pool_config_params.setdefault("owner", "owner")
    pool_config = module.PolicyPoolConfig(**pool_config_params)

    pool_params = config.get("policy_pool", {})
    pool_params["policy_nft"] = nft
    pool_params["currency"] = currency
    pool_params["config"] = pool_config
    pool = module.PolicyPool(**pool_params)
    pool.config.grant_role("LEVEL1_ROLE", pool_config.owner)

    for risk_module_dict in config.get("risk_modules", []):
        risk_module_dict["policy_pool"] = pool
        rm = module.TrustfulRiskModule(**risk_module_dict)
        pool.config.add_risk_module(rm)

    for etoken_dict in config.get("etokens", []):
        if "symbol" not in etoken_dict:
            etoken_dict["symbol"] = etoken_dict["name"]
        etoken_dict["policy_pool"] = pool
        etoken_dict["owner"] = pool_config.owner
        etk = module.EToken(**etoken_dict)
        pool.add_etoken(etk)

    asset_manager = config.get("asset_manager", {})
    if asset_manager:
        asset_manager_class = asset_manager.pop("class")
        asset_manager["owner"] = pool_config.owner
        asset_manager["pool"] = pool
        asset_manager = getattr(module, asset_manager_class)(**asset_manager)
        pool.config.set_asset_manager(asset_manager)

    insolvency_hook = config.get("insolvency_hook", {})
    if insolvency_hook:
        insolvency_hook_class = insolvency_hook.pop("class")
        insolvency_hook["pool"] = pool
        insolvency_hook = getattr(module, insolvency_hook_class)(**insolvency_hook)
        pool.config.set_insolvency_hook(insolvency_hook)

    return pool
