import re
import importlib
import yaml
from environs import Env

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


def load_config(yaml_config=None):
    """Loads the configuration

    @params yaml_config must be a file-like object or None
    """
    if yaml_config is None:
        yaml_config_filename = env.path("SETUP_FILE")
        yaml_config = open(yaml_config_filename)

    yaml.add_implicit_resolver('!envvar', envvar_matcher, Loader=yaml.FullLoader)
    yaml.add_constructor('!envvar', envvar_constructor, Loader=yaml.FullLoader)
    config = yaml.load(yaml_config, Loader=yaml.FullLoader)

    module = importlib.import_module(config["module"])

    protocol = module.Protocol.build(**config.get("protocol", {}))

    for risk_module_dict in config.get("risk_modules", []):
        rm = module.RiskModule.build(**risk_module_dict)
        protocol.add_risk_module(rm)

    for etoken_dict in config.get("etokens", []):
        etk = module.EToken.build(**etoken_dict)
        protocol.add_etoken(etk)

    return protocol


load_config()

