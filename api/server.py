import os
import logging
from flask import Flask, jsonify, request

from .wadray import Wad, Ray
from .config_loader import load_config

app = Flask(__name__)
application = app

protocol = load_config()

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


@app.route('/get-interest-rates/<etoken>/', methods=["GET"])
def get_interest_rates(etoken):
    etoken_obj = protocol.etokens[etoken]
    token_interest_rate, mcr_interest_rate = etoken_obj.get_interest_rates()
    return jsonify({
        "token_interest_rate": str(token_interest_rate),
        "mcr_interest_rate": str(mcr_interest_rate),
    })


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
        "policy_id": policy.id,
        "mcr": str(policy.mcr),
        "pure_premium": str(policy.pure_premium),
        "interest_rate": str(policy.interest_rate),
        "locked_funds": dict((etoken, str(amount)) for (etoken, amount) in policy.locked_funds)
    })


@app.route('/resolve-policy/<risk_module>/<policy_id>/<customer_won>/', methods=["POST"])
def resolve_policy(risk_module, policy_id, customer_won):
    policy_id = int(policy_id)
    customer_won = customer_won.lower() == "true"
    ret = protocol.resolve_policy(risk_module, policy_id, customer_won)

    return jsonify(ret)


@app.route('/fast-forward-time/', methods=["POST"])
def fast_forward_time():
    data = request.json
    return jsonify({"now": protocol.fast_forward_time(data["secs"])})


# Connects Flask's log with Gunicorn's
if "gunicorn" in os.environ.get("SERVER_SOFTWARE", ""):
    gunicorn_logger = logging.getLogger('gunicorn.error')
    app.logger.handlers = gunicorn_logger.handlers
    app.logger.setLevel(gunicorn_logger.level)
