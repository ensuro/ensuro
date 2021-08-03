import re
import importlib
import random
import yaml
from environs import Env
import numpy as np
from .wadray import _W

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

    pool_params = config.get("policy_pool", {})
    pool_params.setdefault("owner", "owner")
    pool_params["policy_nft"] = nft
    pool_params["currency"] = currency
    pool = module.PolicyPool(**pool_params)
    pool.grant_role("ENSURO_DAO_ROLE", pool.owner)

    with nft.as_(nft.owner):
        nft.grant_role("MINTER_ROLE", pool)

    for risk_module_dict in config.get("risk_modules", []):
        risk_module_dict["policy_pool"] = pool
        rm = module.TrustfulRiskModule(**risk_module_dict)
        pool.add_risk_module(rm)

    for etoken_dict in config.get("etokens", []):
        if "symbol" not in etoken_dict:
            etoken_dict["symbol"] = etoken_dict["name"]
        etoken_dict["policy_pool"] = pool
        etoken_dict["owner"] = pool.owner
        etk = module.EToken(**etoken_dict)
        pool.add_etoken(etk)

    asset_manager = config.get("asset_manager", {})
    if asset_manager:
        asset_manager_class = asset_manager.pop("class")
        asset_manager["owner"] = pool.owner
        asset_manager["pool"] = pool
        asset_manager = getattr(module, asset_manager_class)(**asset_manager)
        pool.set_asset_manager(asset_manager)

    return pool


def random_distribute(total_count, step_count):
    """Distributes total_count in step_count periods ramdomly"""
    missing = total_count
    for step in range(step_count - 1):
        value = min(missing, random.randint(0, total_count * 2 // step_count))
        yield value
        missing -= value
    yield missing


def evenly_distribute(total_count, step_count):
    """Distributes total_count in step_count periods"""
    missing = total_count
    for step in range(step_count - 1):
        value = total_count // step_count
        yield value
        missing -= value
    yield missing


def run_simulation(pool, period, policy_count_by_period, policy_factory, policy_resolver,
                   observer):
    observer("start", **locals())

    to_resolve = set()

    new_policies = []
    resolved_count = 0
    won_count = 0

    for period_idx, policy_count in enumerate(policy_count_by_period):
        today = pool.now()

        # Create new policies
        if policy_count:
            for i in range(policy_count):
                policy = policy_factory(pool, period_idx, i)
                new_policies.append(policy)
                to_resolve.add((policy.id, policy.risk_module.name))

        # Resolve policies
        resolved = set()
        for policy_id, rm_name in to_resolve:
            customer_won = policy_resolver(**locals())
            if customer_won is None:
                continue
            pool.resolve_policy(rm_name, policy_id, customer_won)
            won_count += 1
            resolved_count += 1
            resolved.add((policy_id, rm_name))

        to_resolve.difference_update(resolved)

        observer("step", **locals())

        pool.fast_forward_time(period)

    observer("end", **locals())


class SimulationObserver:
    """
    Observer to record metrics of different simulations.

    """

    def __init__(self, metrics=[]):
        self.metrics = metrics or self.metrics  # reads from class
        self.metric_values = []

    def default_start(self, **kwargs):
        return []

    def __call__(self, phase, **kwargs):
        return getattr(self, phase)(**kwargs)

    def start(self, **kwargs):
        self.metric_values.append({})
        for metric in self.metrics:
            self.metric_values[-1][metric] = getattr(
                self, f"{metric}_start", self.default_start
            )(**kwargs)

    def step(self, **kwargs):
        for metric in self.metrics:
            self.metric_values[-1][metric].append(getattr(self, f"get_{metric}")(**kwargs))

    def end(self, **kwargs):
        pass

    def mean(self, metric):
        return np.mean([values[metric] for values in self.metric_values], axis=0)

    def std(self, metric):
        return np.std([values[metric] for values in self.metric_values], axis=0)
