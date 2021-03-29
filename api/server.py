import os
import re
import logging
from decimal import Decimal
import importlib
import yaml
from flask import Flask, jsonify, request, abort, Response, send_file
from environs import Env

from .wadray import Wad, Ray

app = Flask(__name__)
application = app

env = Env()

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


protocol = None


def load_config(yaml_config=None):
    """Loads the configuration

    @params yaml_config must be a file-like object or None
    """
    global protocol

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

# Routes
@app.route('/deposit/<etoken>/<provider>/', methods=["POST"])
def deposit(etoken, provider):
    data = request.json
    amount = Wad.from_value(data["amount"])
    return jsonify({"balance": str(protocol.deposit(etoken, provider, amount))})


@app.route('/balance-of/<etoken>/<provider>/', methods=["GET"])
def balance_of(etoken, provider):
    etoken_obj = protocol.etokens[etoken]
    return jsonify({"balance": str(etoken_obj.balance_of(provider))})


@app.route('/total-supply/<etoken>/', methods=["GET"])
def total_supply(etoken):
    etoken_obj = protocol.etokens[etoken]
    return jsonify({"total_supply": str(etoken_obj.total_supply())})


@app.route('/redeem/<etoken>/<provider>/', methods=["POST"])
def redeem(etoken, provider):
    data = request.json
    etoken_obj = protocol.etokens[etoken]
    if data and "amount" in data:
        amount = Wad.from_value(data["amount"])
    else:
        amount = None
    return jsonify({"amount": str(etoken_obj.redeem(provider, amount))})


@app.route('/new-policy/<risk_module>/', methods=["POST"])
def new_policy(risk_module):
    data = request.json
    if "expiration_period" in data:
        expiration = protocol.now() + data["expiration_period"]
    else:
        expiration = data["expiration"]

    policy = protocol.new_policy(
        risk_module,
        Wad.from_value(data["payout"]),
        Wad.from_value(data["premium"]),
        Ray.from_value(data["loss_prob"]),
        expiration,
    )

    return jsonify({
        "policy_id": policy.policy_id,
        "mcr": str(policy.mcr),
        "pure_premium": str(policy.pure_premium),
        "interest_rate": str(policy.interest_rate),
        "locked_funds": dict((etoken, str(amount)) for (etoken, amount) in policy.locked_funds)
    })


@app.route('/fast-forward-time/', methods=["POST"])
def fast_forward_time():
    data = request.json
    return jsonify({"now": protocol.fast_forward_time(data["secs"])})


# Connects Flask's log with Gunicorn's
if "gunicorn" in os.environ.get("SERVER_SOFTWARE", ""):
    gunicorn_logger = logging.getLogger('gunicorn.error')
    app.logger.handlers = gunicorn_logger.handlers
    app.logger.setLevel(gunicorn_logger.level)
