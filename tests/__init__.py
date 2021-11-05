import sys


def extract_vars(vars, keys):
    """Utility function to extract vars from dict

    >>> a, c = extract_vars({"a": 1, "b": 2", "c": 3}, "a,c")
    """
    keys = keys.split(",")
    for k in keys:
        yield vars[k.strip()]


def is_brownie_coverage_enabled(tenv):
    if tenv.kind == "ethereum" and "brownie" in sys.modules:
        from brownie._config import CONFIG
        if CONFIG.argv.get("coverage", False):
            return True
    return False
