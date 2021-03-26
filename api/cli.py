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
@click.argument("amount", type=float)
def deposit(etoken, provider, amount):
    print(_call_server(f"/deposit/{etoken}/{provider}/", "POST", {"amount": amount}))


@cli.command()
@click.argument("etoken")
@click.argument("provider")
def balance(etoken, provider):
    print(_call_server(f"/balance-of/{etoken}/{provider}/", "GET"))


@cli.command()
@click.argument("period")
def fast_forward_time(period):
    if period.isdigit():
        secs = int(period)
    else:
        count = int(period[:-1])
        multiplier = {
            "h": 3600,
            "d": 3600 * 24,
            "w": 3600 * 24 * 7,
            "m": 3600 * 24 * 30,
            "y": 3600 * 24 * 365,
        }[period[-1]]
        secs = count * multiplier

    print(_call_server(f"/fast-forward-time/", "POST", {"secs": secs}))


if __name__ == "__main__":
    cli()
