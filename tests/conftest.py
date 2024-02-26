import pytest
from ethproto import w3wrappers, wrappers
from web3 import Web3


def pytest_configure(config):
    wrappers.DEFAULT_PROVIDER = "w3"
    w3wrappers.CONTRACT_JSON_PATH = ["artifacts"]


@pytest.fixture(scope="module", autouse=True)
def reset_provider():
    """Resets the provider for each module. Mainly for addressbook and contract map cleanse"""

    wrappers.register_provider("w3", w3wrappers.W3Provider(Web3(), tx_kwargs={"gasPrice": 0}))
    yield
    wrappers.register_provider("w3", w3wrappers.W3Provider(Web3(), tx_kwargs={"gasPrice": 0}))
