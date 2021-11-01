from ethproto import wrappers


def pytest_addoption(parser):
    parser.addoption(
        '--use-w3', action='store_true', dest="w3",
        default=False, help="enable longrundecorated tests"
    )


def pytest_configure(config):
    if not config.option.w3:
        from ethproto.brwrappers import BrownieProvider
        wrappers.register_provider("brownie", BrownieProvider())
    else:
        from ethproto.w3wrappers import W3Provider
        from web3 import Web3
        wrappers.DEFAULT_PROVIDER = "w3"
        wrappers.register_provider("w3", W3Provider(Web3()))
