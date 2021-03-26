import time

_now = int(time.time())

SECONDS_IN_YEAR = 365 * 24 * 3600


def now():
    global _now
    return _now


class RiskModule:
    def __init__(self, name, mcr_percentage):
        self.name = name
        self.mcr_percentage = mcr_percentage

    @classmethod
    def build(cls, name, mcr_percentage=100.0):
        return cls(name=name, mcr_percentage=mcr_percentage)


class Policy:
    def __init__(self, risk_module, premium, payout, loss_prob, expiration, parameters={}):
        self.risk_module = risk_module
        self.premium = premium
        self.payout = payout
        self.mcr = (payout - premium) * risk_module.mcr_percentage / 100.0
        self.loss_prob = loss_prob
        self.expiration = expiration
        self.parameters = parameters or {}


class EToken:
    INTEREST_RATE = int(2e5)
    HUNDRED_PERCENT = int(100e5)

    def __init__(self, name, expiration_period, decimals=18):
        self.name = name
        self.expiration_period = expiration_period
        self.current_index = int(1e27)
        self.last_index_update = now()
        self.balances = {}
        self.indexes = {}
        self.timestamps = {}
        self.decimals = decimals

    @classmethod
    def build(cls, **kwargs):
        return cls(**kwargs)

    def _update_current_index(self):
        self.current_index = self._calculate_current_index()
        self.last_index_update = now()

    def _calculate_current_index(self):
        increment = self.current_index * (
            now() - self.last_index_update
        ) * self.INTEREST_RATE // (SECONDS_IN_YEAR * self.HUNDRED_PERCENT)
        return self.current_index + increment

    def float_to_int(self, amount_float):
        return int(amount_float * (10 ** self.decimals))

    def int_to_float(self, amount):
        return float(amount / (10 ** self.decimals))

    def deposit(self, provider, amount):
        self._update_current_index()
        self.balances[provider] = self.balance_of(provider) + amount
        self.indexes[provider] = self.current_index
        self.timestamps[provider] = now()
        return self.balances[provider]

    def balance_of(self, provider):
        if provider not in self.balances:
            return 0
        self._update_current_index()
        principal_balance = self.balances[provider]
        return principal_balance * self.current_index // self.indexes[provider]

    def redeem(self, provider, amount):
        if amount > self.balance_of(provider):
            amount = self.balance_of(provider)


class Protocol:
    def __init__(self, risk_modules={}, etokens={}):
        self.risk_modules = risk_modules or {}
        self.etokens = etokens or {}
        self.policies = []

    @classmethod
    def build(cls, **kwargs):
        return cls(**kwargs)

    def add_risk_module(self, risk_module):
        self.risk_modules[risk_module.name] = risk_module

    def add_etoken(self, etoken):
        self.etokens[etoken.name] = etoken

    def deposit(self, etoken, provider, amount):
        token = self.etokens[etoken]
        return token.deposit(provider, amount)

    def fast_forward_time(self, secs):
        global _now
        _now += secs
        return _now
