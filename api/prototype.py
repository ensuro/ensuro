from m9g import Model
from m9g.fields import StringField, IntField, DictField, CompositeField, ListField
from .contracts import Contract, ERC20Token, external, view, RayField, WadField, AddressField, \
    ContractProxyField, ContractProxy, RevertError
from .wadray import RAY, Ray, Wad, _W, _R
import time

_now = int(time.time())

SECONDS_IN_YEAR = 365 * 24 * 3600


def now():
    global _now
    return _now


class RiskModule(Contract):
    name = StringField()
    mcr_percentage = RayField(default=Ray(0))
    premium_share = RayField(default=Ray(0))
    ensuro_share = RayField(default=Ray(0))
    max_mcr_per_policy = WadField(default=_W(1000000))
    mcr_limit = WadField(default=_W(10000000))
    total_mcr = WadField(default=_W(0))

    wallet = AddressField(default="RM")
    shared_coverage_percentage = RayField(default=Ray(0))
    shared_coverage_min_percentage = RayField(default=Ray(0))

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if self.shared_coverage_percentage < self.shared_coverage_min_percentage:
            self.shared_coverage_percentage = self.shared_coverage_min_percentage

    @external
    def add_policy(self, policy):
        if policy.mcr > self.max_mcr_per_policy:
            raise RevertError(f"Policy MCR: {policy.mcr} > max for this module {self.max_mcr_per_policy}")
        total_mcr = self.total_mcr + policy.mcr
        if total_mcr > self.mcr_limit:
            raise RevertError(f"MCR exceeds the allowed for this module")
        self.total_mcr = total_mcr

    @external
    def remove_policy(self, policy):
        self.total_mcr -= policy.mcr


class Policy(Model):
    id = IntField()
    risk_module = ContractProxyField()
    payout = WadField()
    premium = WadField()
    mcr = WadField(default=Wad(0))
    rm_coverage = WadField(default=Wad(0))
    loss_prob = RayField()
    start = IntField()
    expiration = IntField()
    customer = AddressField()
    locked_funds = DictField(StringField(), WadField(), default={})

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.rm_coverage = self.risk_module.shared_coverage_percentage.to_wad() * self.payout
        ens_premium, rm_premium = self._coverage_premium_split()
        self.mcr = (self.payout - ens_premium - self.rm_coverage) * self.risk_module.mcr_percentage.to_wad()

    def _coverage_premium_split(self):
        ens_premium = self.premium * (self.payout - self.rm_coverage) // self.payout
        rm_premium = self.premium - ens_premium
        return ens_premium, rm_premium

    @property
    def pure_premium(self):
        payout = self.payout - self.rm_coverage
        return (payout.to_ray() * self.loss_prob).to_wad()

    @property
    def rm_mcr(self):
        ens_premium, rm_premium = self._coverage_premium_split()
        return self.rm_coverage - rm_premium

    def premium_split(self):
        ens_premium, rm_premium = self._coverage_premium_split()

        pure_premium = self.pure_premium
        profit_premium = ens_premium - pure_premium
        for_ensuro = (profit_premium.to_ray() * self.risk_module.ensuro_share).to_wad()
        for_risk_module = (profit_premium.to_ray() * self.risk_module.premium_share).to_wad()
        for_lps = profit_premium - for_ensuro - for_risk_module
        for_risk_module += rm_premium  # after calculating for_lps...
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
    liquidity_requirement = RayField(default=_R(1))

    min_queued_withdraw = WadField(default=_W(0))
    withdraw_queue = ListField(AddressField(), default=[])
    withdrawers = DictField(AddressField(), WadField(), default={})
    to_withdraw_amount = WadField(default=_W(0))

    protocol_loan = WadField(default=_W(0))
    protocol_loan_interest_rate = RayField(default=_R("0.05"))
    protocol_loan_index = RayField(default=_R(1))
    protocol_loan_last_index_update = IntField(default=None, allow_none=True)

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

    @view
    def total_supply(self):
        return (super().total_supply().to_ray() * self._calculate_current_index()).to_wad()

    @property
    def ocean(self):
        return max(self.total_supply() - self.mcr - self.to_withdraw_amount, _W(0))

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

    def _transfer(self, sender, recipient, amount):
        scaled_amount = (amount.to_ray() // self._calculate_current_index()).to_wad()
        super()._transfer(sender, recipient, scaled_amount)

    @view
    def total_withdrawable(self):
        """Returns the amount that's available to be withdrawed"""
        locked = (
            self.mcr.to_ray() * (_R(1) + self.mcr_interest_rate) * self.liquidity_requirement
        ).to_wad()
        return max(_W(0), self.total_supply() - locked)

    def withdraw(self, provider, amount):
        self._update_current_index()
        balance = self.balance_of(provider)
        if balance == 0:
            return Wad(0)
        if amount is None or amount > balance:
            amount = balance
        amount = min(amount, self.total_withdrawable())
        if amount == 0:
            return Wad(0)

        self._withdraw(provider, amount)
        self._update_token_interest_rate()

        # If provider in withdraws and remaining balance < to_withdraw, remove from queue
        if provider in self.withdrawers and (balance - amount) < self.withdrawers[provider]:
            self.to_withdraw_amount -= self.withdrawers[provider]
            del self.withdrawers[provider]
        return amount

    def _withdraw(self, provider, amount):
        scaled_amount = (amount.to_ray() // self.current_index).to_wad()
        self.burn(provider, scaled_amount)

    @external
    def queue_withdraw(self, provider, amount):
        balance = self.balance_of(provider)
        if amount is None or amount > balance:
            amount = balance

        if provider in self.withdrawers:
            # clean first
            self.to_withdraw_amount -= self.withdrawers[provider]
            del self.withdrawers[provider]

        if amount < self.min_queued_withdraw:
            return _W(0)

        self.withdrawers[provider] = amount
        self.withdraw_queue.append(provider)
        self.to_withdraw_amount += amount
        return amount

    def process_withdrawers(self):
        self._update_current_index()
        withdrawable = self.total_withdrawable()
        transfer_amounts = []
        total_transfer = Wad(0)

        while self.to_withdraw_amount and withdrawable >= self.min_queued_withdraw:
            provider = self.withdraw_queue.pop(0)
            provider_amount = self.withdrawers.get(provider, Wad(0))
            if not provider_amount:
                continue
            if provider_amount < self.min_queued_withdraw:
                # skip provider - amount < min_queued_withdraw must do manual withdraw
                del self.withdrawers[provider]
                self.to_withdraw_amount -= provider_amount
                continue
            provider_amount = min(provider_amount, self.balance_of(provider))
            if provider_amount <= withdrawable:
                full_withdraw = True
            elif (provider_amount - withdrawable) < self.min_queued_withdraw:
                full_withdraw = True
                provider_amount = withdrawable
            else:
                full_withdraw = False
            if full_withdraw:
                self._withdraw(provider, provider_amount)
                transfer_amounts.append((provider, provider_amount))
                total_transfer += provider_amount
                withdrawable -= provider_amount
                del self.withdrawers[provider]
                self.to_withdraw_amount -= provider_amount
            else:  # partial withdraw
                self._withdraw(provider, withdrawable)
                transfer_amounts.append((provider, withdrawable))
                total_transfer += withdrawable
                self.withdrawers[provider] = provider_amount - withdrawable
                self.withdraw_queue.append(provider)  # requeue at the end
                withdrawable = Wad(0)
                self.to_withdraw_amount -= withdrawable

        return total_transfer, transfer_amounts

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
    currency = ContractProxyField()
    risk_modules = DictField(StringField(), ContractProxyField(), default={})
    etokens = DictField(StringField(), ContractProxyField(), default={})
    policies = DictField(IntField(), CompositeField(Policy), default={})
    policy_count = IntField(default=0)
    active_policy_premiums = WadField(default=Wad(0))
    rm_mcr = WadField(default=Wad(0))
    pure_premiums = WadField(default=Wad(0))
    treasury = AddressField(default="ENS")

    def add_risk_module(self, risk_module):
        self.risk_modules[risk_module.name] = ContractProxy(risk_module.contract_id)

    def add_etoken(self, etoken):
        self.etokens[etoken.name] = ContractProxy(etoken.contract_id)

    @external
    def deposit(self, etoken, provider, amount):
        self.currency.transfer_from(self.contract_id, provider, self.contract_id, amount)
        token = self.etokens[etoken]
        return token.deposit(provider, amount)

    @external
    def withdraw(self, etoken, provider, amount):
        token = self.etokens[etoken]
        withdrawed = token.withdraw(provider, amount)
        if withdrawed:
            self._transfer_to(provider, withdrawed)
        return withdrawed

    @external
    def process_withdrawers(self, etoken):
        token = self.etokens[etoken]
        total_transfer, transfer_amounts = token.process_withdrawers()
        if total_transfer:
            for provider, amount in transfer_amounts:
                self._transfer_to(provider, amount)
        return total_transfer

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

        rm.add_policy(policy)
        if policy.rm_mcr:
            self.currency.transfer_from(self.contract_id, rm.wallet, self.contract_id, policy.rm_mcr)
            self.rm_mcr += policy.rm_mcr

        assert policy.interest_rate >= 0

        self.pure_premiums += policy.pure_premium
        self.active_policy_premiums += policy.premium

        self._lock_mcr(policy)

        self.policies[policy.id] = policy
        return policy

    def _lock_mcr(self, policy):
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

    def _transfer_to(self, target, amount):
        # TODO: here we need to verify we have balance or call the asset manager
        if amount == _W(0):
            return
        return self.currency.transfer(self.contract_id, target, amount)

    @external
    def resolve_policy(self, risk_module_name, policy_id, customer_won):
        policy = self.policies[policy_id]

        if customer_won:
            from_premiums = min(self.pure_premiums, policy.payout)
            self.pure_premiums -= from_premiums
            borrow_from_mcr = policy.payout - from_premiums
            self._transfer_to(policy.customer, policy.payout)
        else:
            pure_premium, for_ensuro, for_rm, for_lps = policy.premium_split()
            pure_premium = min(pure_premium, self.pure_premiums)
            adjustment = for_lps - policy.accrued_interest()
            self._transfer_to(policy.risk_module.wallet, for_rm + policy.rm_mcr)
            self._transfer_to(self.treasury, for_ensuro)

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
                self.process_withdrawers(etoken_name)
            elif borrow_from_mcr:
                etk_borrow = borrow_from_mcr * mcr_amount // policy.mcr
                etk.lend_to_protocol(etk_borrow)

        self.active_policy_premiums -= policy.premium
        policy.risk_module.remove_policy(policy)
        self.rm_mcr -= policy.rm_mcr
        del self.policies[policy_id]

    @external
    def rebalance_policy(self, risk_module_name, policy_id):
        policy = self.policies[policy_id]

        modified_etokens = set()

        # unlock previous MCR
        for (etoken_name, mcr_amount) in policy.locked_funds.items():
            etk = self.etokens[etoken_name]
            etk.unlock_mcr(policy, mcr_amount)
            modified_etokens.add(etoken_name)

        policy.locked_funds = {}
        self._lock_mcr(policy)

        for etoken_name in modified_etokens:
            self.process_withdrawers(etoken_name)
