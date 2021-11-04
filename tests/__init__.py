def extract_vars(vars, keys):
    """Utility function to extract vars from dict

    >>> a, c = extract_vars({"a": 1, "b": 2", "c": 3}, "a,c")
    """
    keys = keys.split(",")
    for k in keys:
        yield vars[k.strip()]
