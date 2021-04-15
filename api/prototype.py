from m9g import Model
from m9g.fields import StringField, IntField, DictField, CompositeField, ReferenceField
from .contracts import Contract, ERC20Token, external, view, RayField, WadField, AddressField
from .wadray import RAY, Ray, Wad, _W, _R
import time

_now = int(time.time())

SECONDS_IN_YEAR = 365 * 24 * 3600


def now():
    global _now
    return _now


class RiskModuleSettings(Model):
    name = StringField()
    mcr_percentage = RayField(default=Ray(0))
    premium_share = RayField(default=Ray(0))
    ensuro_share = RayField(default=Ray(0))

    @classmethod
    def build(cls, name, mcr_percentage=100, premium_share=0, ensuro_share=0):
        return cls(
            name=name, mcr_percentage=Ray.from_value(mcr_percentage) // Ray.from_value(100),
            premium_share=Ray.from_value(premium_share) // Ray.from_value(100),
            ensuro_share=Ray.from_value(ensuro_share) // Ray.from_value(100)
        )


class Policy(Model):
    id = IntField()
    payout = WadField()
    premium = WadField()
    loss_prob = RayField()
    start = IntField()
    expiration = IntField()
    customer = AddressField()
    locked_funds = DictField(StringField(), WadField(), default={})

    def __init__(self, **kwargs):
        self.risk_module = kwargs.pop("risk_module")
        super().__init__(**kwargs)
        self.mcr = ((self.payout - self.premium).to_ray() * self.risk_module.mcr_percentage).to_wad()

    @property
    def pure_premium(self):
        return (self.payout.to_ray() * self.loss_prob).to_wad()

    def premium_split(self):
        pure_premium = self.pure_premium
        profit_premium = self.premium - pure_premium
        for_ensuro = (profit_premium.to_ray() * self.risk_module.ensuro_share).to_wad()
        for_risk_module = (profit_premium.to_ray() * self.risk_module.premium_share).to_wad()
        for_lps = profit_premium - for_ensuro - for_risk_module
        return pure_premium, for_ensuro, for_risk_module, for_lps

    @property
    def interest_rate(self):
        _, for_ensuro, for_risk_module, for_lps = self.premium_split()
        return (
            for_lps * _W(SECONDS_IN_YEAR) // (
                _W(self.expiration - self.start) * self.mcr
            )
        ).to_ray()

    def accrued_interest(self):
        seconds = Ray.from_value(now() - self.start)
        return (
            self.mcr.to_ray() * seconds * self.interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        ).to_wad()

    def get_mcr_share(self, etoken_name):
        if etoken_name not in self.locked_funds:
            return Ray(0)
        return (self.locked_funds[etoken_name] // self.mcr).to_ray()


class EToken(ERC20Token):
    expiration_period = IntField()
    current_index = RayField(default=_R(1))
    last_index_update = IntField(default=now)

    mcr = WadField(default=_W(0))
    mcr_interest_rate = RayField(default=_R(0))
    token_interest_rate = RayField(default=_R(0))

    protocol_loan = WadField(default=_W(0))
    protocol_loan_interest_rate = RayField(default=_R("0.05"))
    protocol_loan_index = RayField(default=_R(1))
    protocol_loan_last_index_update = IntField(default=None, allow_none=True)

    @classmethod
    def build(cls, **kwargs):
        return cls(**kwargs)

    def _update_current_index(self):
        self.current_index = self._calculate_current_index()
        self.last_index_update = now()

    def _update_token_interest_rate(self):
        """Should be called each time total_supply changes or mcr changes"""
        total_supply = self.total_supply().to_ray()
        if total_supply:
            self.token_interest_rate = self.mcr_interest_rate * self.mcr.to_ray() // total_supply
        else:
            self.token_interest_rate = Ray(0)

    def _calculate_current_index(self):
        seconds = now() - self.last_index_update
        if seconds <= 0:
            return self.current_index
        increment = (
            Ray.from_value(seconds) * self.token_interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        )
        return self.current_index * (Ray(RAY) + increment)

    def get_interest_rates(self):
        return self.token_interest_rate, self.mcr_interest_rate

    def _base_supply(self):
        return super().total_supply()

    def total_supply(self):
        return (super().total_supply().to_ray() * self._calculate_current_index()).to_wad()

    @property
    def ocean(self):
        return self.total_supply() - self.mcr

    def lock_mcr(self, policy, mcr_amount):
        total_supply = self.total_supply()
        ocean = total_supply - self.mcr
        assert mcr_amount <= ocean
        self._update_current_index()

        if self.mcr == 0:
            self.mcr = mcr_amount
            self.mcr_interest_rate = policy.interest_rate
        else:
            orig_mcr = self.mcr
            self.mcr += mcr_amount
            self.mcr_interest_rate = (
                self.mcr_interest_rate * orig_mcr.to_ray() + policy.interest_rate * mcr_amount.to_ray()
            ) // self.mcr.to_ray()  # weighted average of previous and policy interest_rate
        self._update_token_interest_rate()

    def unlock_mcr(self, policy, mcr_amount):
        assert mcr_amount <= self.mcr
        self._update_current_index()

        if self.mcr == mcr_amount:
            self.mcr = Wad(0)
            self.mcr_interest_rate = Ray(0)
        else:
            orig_mcr = self.mcr
            self.mcr -= mcr_amount
            self.mcr_interest_rate = (
                self.mcr_interest_rate * orig_mcr.to_ray() - policy.interest_rate * mcr_amount.to_ray()
            ) // self.mcr.to_ray()  # revert weighted average
        self._update_token_interest_rate()

    def discrete_earning(self, amount):
        assert now() == self.last_index_update
        new_total_supply = amount + self.total_supply()
        self.current_index = new_total_supply.to_ray() // self._base_supply().to_ray()
        self._update_token_interest_rate()

    def deposit(self, provider, amount):
        self._update_current_index()
        scaled_amount = (amount.to_ray() // self.current_index).to_wad()
        self.mint(provider, scaled_amount)
        self._update_token_interest_rate()
        return self.balance_of(provider)

    def balance_of(self, provider):
        principal_balance = super().balance_of(provider)
        if not principal_balance:
            return Wad(0)
        current_index = self._calculate_current_index()
        return (principal_balance.to_ray() * current_index).to_wad()

    def redeem(self, provider, amount):
        self._update_current_index()
        balance = self.balance_of(provider)
        if balance == 0:
            return Wad(0)
        if amount is None or amount > balance:
            amount = balance
        scaled_amount = (amount.to_ray() // self.current_index).to_wad()
        self.burn(provider, scaled_amount)
        self._update_token_interest_rate()
        return amount

    def accepts(self, policy):
        return policy.expiration <= (now() + self.expiration_period)

    def lend_to_protocol(self, amount):
        if self.protocol_loan == 0:
            self.protocol_loan = amount
            self.protocol_loan_index = Ray(RAY)
            self.protocol_loan_last_index_update = now()
        else:
            self.protocol_loan_index = self._get_protocol_loan_index()
            self.protocol_loan_last_index_update = now()
            self.protocol_loan += (amount.to_ray() // self.protocol_loan_index).to_wad()
        self.discrete_earning(-amount)

    def repay_protocol_loan(self, amount):
        self.protocol_loan_index = self._get_protocol_loan_index()
        self.protocol_loan_last_index_update = now()
        self.protocol_loan = (
            (self.get_protocol_loan() - amount).to_ray() // self.protocol_loan_index
        ).to_wad()
        self.discrete_earning(amount)

    def _get_protocol_loan_index(self):
        seconds = now() - self.protocol_loan_last_index_update
        if seconds <= 0:
            return self.protocol_loan_index
        increment = (
            Ray.from_value(seconds) * self.protocol_loan_interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        )
        return self.protocol_loan_index * (Ray(RAY) + increment)

    def get_protocol_loan(self):
        if self.protocol_loan == 0:
            return self.protocol_loan
        return (self.protocol_loan.to_ray() * self._get_protocol_loan_index()).to_wad()


class Protocol(Contract):
    currency = ReferenceField(ERC20Token, allow_none=False)
    risk_modules = DictField(StringField(), CompositeField(RiskModuleSettings), default={})
    etokens = DictField(StringField(), ReferenceField(EToken), default={})
    policies = DictField(IntField(), CompositeField(Policy), default={})
    policy_count = IntField(default=0)
    pure_premiums = WadField(default=Wad(0))

    @classmethod
    def build(cls, **kwargs):
        return cls(**kwargs)

    def add_risk_module(self, risk_module):
        self.risk_modules[risk_module.name] = risk_module

    def add_etoken(self, etoken):
        self.etokens[etoken.name] = etoken

    @external
    def deposit(self, etoken, provider, amount):
        self.currency.transfer_from(self.contract_id, provider, self.contract_id, amount)
        token = self.etokens[etoken]
        return token.deposit(provider, amount)

    @external
    def redeem(self, etoken, provider, amount):
        token = self.etokens[etoken]
        redeemed = token.redeem(provider, amount)
        if redeemed:
            self.currency.transfer(self.contract_id, provider, redeemed)
        return redeemed

    def fast_forward_time(self, secs):
        global _now
        _now += secs
        return _now

    def now(self):
        return now()

    @external
    def new_policy(self, risk_module_name, payout, premium, loss_prob, expiration, customer):
        rm = self.risk_modules[risk_module_name]
        start = now()
        self.policy_count += 1
        self.currency.transfer_from(self.contract_id, customer, self.contract_id, premium)
        policy = Policy(id=self.policy_count, risk_module=rm, payout=payout, premium=premium,
                        loss_prob=loss_prob, start=start, expiration=expiration, customer=customer)
        assert policy.interest_rate > 0

        self.pure_premiums += policy.pure_premium

        ocean = Wad(0)
        ocean_per_token = {}
        for etk in self.etokens.values():
            if not etk.accepts(policy):
                continue
            ocean_token = etk.ocean
            if ocean_token == 0:
                continue
            ocean += ocean_token
            ocean_per_token[etk.name] = ocean_token

        assert ocean >= policy.mcr

        mcr_not_locked = policy.mcr

        for index, (token_name, ocean_token) in enumerate(ocean_per_token.items()):
            if index < (len(ocean_per_token) - 1):
                mcr_for_token = policy.mcr * ocean_token // ocean
            else:  # Last one gets the rest
                mcr_for_token = mcr_not_locked
            self.etokens[token_name].lock_mcr(policy, mcr_for_token)
            policy.locked_funds[token_name] = mcr_for_token
            mcr_not_locked -= mcr_for_token

        self.policies[policy.id] = policy
        return policy

    def resolve_policy(self, risk_module_name, policy_id, customer_won):
        policy = self.policies[policy_id]

        if customer_won:
            from_premiums = min(self.pure_premiums, policy.payout)
            self.pure_premiums -= from_premiums
            borrow_from_mcr = policy.payout - from_premiums
            self.currency.transfer(self.contract_id, policy.customer, policy.payout)
        else:
            pure_premium, _, _, for_lps = policy.premium_split()
            pure_premium = min(pure_premium, self.pure_premiums)
            adjustment = for_lps - policy.accrued_interest()

        for (etoken_name, mcr_amount) in policy.locked_funds.items():
            etk = self.etokens[etoken_name]
            etk.unlock_mcr(policy, mcr_amount)
            if not customer_won:
                etk_adjustment = adjustment * mcr_amount // policy.mcr
                etk.discrete_earning(etk_adjustment)
                borrowed_from_etk = etk.get_protocol_loan()
                if borrowed_from_etk and pure_premium:  # if debt with token, repay from pure_premium
                    repay_amount = min(borrowed_from_etk, pure_premium * mcr_amount // policy.mcr)
                    etk.repay_protocol_loan(repay_amount)
                    self.pure_premiums -= repay_amount
            elif borrow_from_mcr:
                etk_borrow = borrow_from_mcr * mcr_amount // policy.mcr
                etk.lend_to_protocol(etk_borrow)

        del self.policies[policy_id]
