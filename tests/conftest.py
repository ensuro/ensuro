import pytest
from ethproto import wrappers


def pytest_configure(config):
    wrappers.DEFAULT_PROVIDER = "w3"


@pytest.fixture(scope="module", autouse=True)
def reset_provider():
    """Resets the provider for each module. Mainly for addressbook and contract map cleanse"""
    from ethproto.w3wrappers import W3Provider
    from web3 import Web3

    wrappers.register_provider("w3", W3Provider(Web3()))
    yield
    wrappers.register_provider("w3", W3Provider(Web3()))
