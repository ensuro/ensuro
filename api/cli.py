import logging
import click
from environs import Env
import requests

env = Env()

server_url = "http://0.0.0.0:5000"


@click.group()
@click.option("--log-level", default="INFO")
@click.option("--server", default="http://0.0.0.0:5000")
def cli(log_level, server):
    global server_url
    logging.basicConfig(level=getattr(logging, log_level))
    server_url = server


def _call_server(path, method="GET", params={}):
    method = getattr(requests, method.lower())
    full_url = server_url + ("/" if path[0] != "/" else "") + path
    resp = method(full_url, json=params)
    resp.raise_for_status()
    return resp.json()


@cli.command()
@click.argument("etoken")
@click.argument("provider")
@click.argument("amount", type=str)
def deposit(etoken, provider, amount):
    print(_call_server(f"/deposit/{etoken}/{provider}/", "POST", {"amount": amount}))


@cli.command()
@click.argument("etoken")
@click.argument("provider")
@click.argument("amount", type=str, required=False)
def redeem(etoken, provider, amount=None):
    print(_call_server(f"/redeem/{etoken}/{provider}/", "POST", {"amount": amount} if amount else {}))


@cli.command()
@click.argument("etoken")
@click.argument("provider")
def balance(etoken, provider):
    print(_call_server(f"/balance-of/{etoken}/{provider}/", "GET"))


@cli.command()
@click.argument("etoken")
def total_supply(etoken):
    print(_call_server(f"/total-supply/{etoken}/", "GET"))


def _parse_period(period):
    if period.isdigit():
        return int(period)
    else:
        count = int(period[:-1])
        multiplier = {
            "h": 3600,
            "d": 3600 * 24,
            "w": 3600 * 24 * 7,
            "m": 3600 * 24 * 30,
            "y": 3600 * 24 * 365,
        }[period[-1]]
        return count * multiplier


@cli.command()
@click.argument("period")
def fast_forward_time(period):
    secs = _parse_period(period)
    print(_call_server(f"/fast-forward-time/", "POST", {"secs": secs}))


@cli.command()
@click.argument("risk_module")
@click.argument("payout")
@click.argument("premium")
@click.option("--loss_prob", default="0.1")
@click.option("--expiration_period", default="1w")
def new_policy(risk_module, payout, premium, loss_prob, expiration_period):
    print(_call_server(f"/new-policy/{risk_module}/", "POST", {
        "payout": payout,
        "premium": premium,
        "loss_prob": loss_prob,
        "expiration_period": _parse_period(expiration_period),
    }))


if __name__ == "__main__":
    cli()
