import os
import re
import logging
import importlib
import yaml
from flask import Flask, jsonify, request, abort, Response, send_file
from environs import Env

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
    etoken_obj = protocol.etokens[etoken]
    amount = etoken_obj.float_to_int(data["amount"])
    return jsonify({"balance": etoken_obj.int_to_float(protocol.deposit(etoken, provider, amount))})


@app.route('/balance-of/<etoken>/<provider>/', methods=["GET"])
def balance_of(etoken, provider):
    etoken_obj = protocol.etokens[etoken]
    return jsonify({"balance": etoken_obj.int_to_float(etoken_obj.balance_of(provider))})


@app.route('/fast-forward-time/', methods=["POST"])
def fast_forward_time():
    data = request.json
    return jsonify({"now": protocol.fast_forward_time(data["secs"])})


# Connects Flask's log with Gunicorn's
if "gunicorn" in os.environ.get("SERVER_SOFTWARE", ""):
    gunicorn_logger = logging.getLogger('gunicorn.error')
    app.logger.handlers = gunicorn_logger.handlers
    app.logger.setLevel(gunicorn_logger.level)
