from contextlib import contextmanager
from m9g import Model
from m9g.fields import StringField, IntField, DictField, CompositeField
from ethproto.contracts import AccessControlContract, ERC20Token, external, view, RayField, WadField, AddressField, \
    ContractProxyField, ContractProxy, require, only_role, Contract
from ethproto.contracts import ERC721Token
from ethproto.wadray import RAY, Ray, Wad, _W, _R
import time

SECONDS_IN_YEAR = 365 * 24 * 3600


class TimeControl:
    def __init__(self, start_time=None):
        if start_time is None:
            self._now = int(time.time())
        else:
            self._now = start_time

    @property
    def now(self):
        return self._now

    def fast_forward(self, seconds):
        self._now += seconds
        return self._now


time_control = TimeControl()


class RiskModule(AccessControlContract):
    policy_pool = ContractProxyField()
    name = StringField()
    moc = RayField(default=_R(1))
    scr_percentage = RayField(default=Ray(0))
    ensuro_fee = RayField(default=Ray(0))   # Ensuro fee as % of pure_premium
    scr_interest_rate = RayField(default=Ray(0))
    max_scr_per_policy = WadField(default=_W(1000000))
    scr_limit = WadField(default=_W(10000000))
    total_scr = WadField(default=_W(0))

    wallet = AddressField(default="RM")
    shared_coverage_percentage = RayField(default=Ray(0))
    shared_coverage_min_percentage = RayField(default=Ray(0))
    shared_coverage_scr = WadField(default=_W(0))

    set_attr_roles = {
        "wallet": "RM_PROVIDER_ROLE",
        "shared_coverage_percentage": "RM_PROVIDER_ROLE",
    }

    pool_set_attr_roles = {
        "moc": "LEVEL2_ROLE",
        "scr_percentage": "LEVEL2_ROLE",
        "ensuro_fee": "LEVEL2_ROLE",
        "scr_interest_rate": "LEVEL2_ROLE",
        "max_scr_per_policy": "LEVEL2_ROLE",
        "scr_limit": "LEVEL2_ROLE",
        "shared_coverage_min_percentage": "LEVEL2_ROLE",
    }

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if self.shared_coverage_percentage < self.shared_coverage_min_percentage:
            with self._disable_role_validation():
                self.shared_coverage_percentage = self.shared_coverage_min_percentage

    def _validate_setattr(self, attr_name, value):
        if attr_name in self.pool_set_attr_roles:
            require(
                self.policy_pool.config.has_role(self.pool_set_attr_roles[attr_name], self._running_as),
                f"AccessControl: AccessControl: account {self._running_as} is missing role "
                f"'{self.pool_set_attr_roles[attr_name]}'"
            )
        if attr_name == "shared_coverage_percentage":
            require(value >= self.shared_coverage_min_percentage,
                    "RiskModule: shared_coverage_percentage can't be less than minimum")
        return super()._validate_setattr(attr_name, value)

    @external
    def new_policy(self, payout, premium, loss_prob, expiration, customer):
        start = time_control.now
        require(self.policy_pool.currency.allowance(customer, self.policy_pool.contract_id) >= premium,
                "You must allow ENSURO to transfer the premium")
        policy = Policy(id=-1, risk_module=self, payout=payout, premium=premium,
                        loss_prob=loss_prob, start=start, expiration=expiration)

        require(policy.scr <= self.max_scr_per_policy,
                f"Policy SCR: {policy.scr} > maximum per policy {self.max_scr_per_policy}")
        total_scr = self.total_scr + policy.scr
        require(total_scr <= self.scr_limit, "RiskModule: SCR limit exceeded")
        self.total_scr = total_scr
        self.shared_coverage_scr += policy.rm_scr

        policy.id = self.policy_pool.new_policy(policy, customer)
        assert policy.id > 0
        return policy

    @external
    def remove_policy(self, policy):
        self.total_scr -= policy.scr
        self.shared_coverage_scr -= policy.rm_scr


class TrustfulRiskModule(RiskModule):
    @only_role("PRICER_ROLE")
    def new_policy(self, *args, **kwargs):
        return super().new_policy(*args, **kwargs)

    @external
    @only_role("RESOLVER_ROLE")
    def resolve_policy(self, policy_id, customer_won):
        with self.policy_pool.as_(self.contract_id):
            return self.policy_pool.resolve_policy(policy_id, customer_won)


class Policy(Model):
    id = IntField()
    risk_module = ContractProxyField()
    payout = WadField()
    premium = WadField()
    scr = WadField(default=Wad(0))
    rm_coverage = WadField(default=Wad(0))
    loss_prob = RayField()
    start = IntField()
    expiration = IntField()
    locked_funds = DictField(StringField(), WadField(), default={})
    pure_premium = WadField(default=Wad(0))
    premium_for_ensuro = WadField(default=Wad(0))
    premium_for_rm = WadField(default=Wad(0))
    premium_for_lps = WadField(default=Wad(0))

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.rm_coverage = self.risk_module.shared_coverage_percentage.to_wad() * self.payout
        ens_premium, rm_premium = self._coverage_premium_split()
        self.scr = (self.payout - ens_premium - self.rm_coverage) * self.risk_module.scr_percentage.to_wad()
        self._do_premium_split()

    def _coverage_premium_split(self):
        ens_premium = self.premium * (self.payout - self.rm_coverage) // self.payout
        rm_premium = self.premium - ens_premium
        return ens_premium, rm_premium

    @property
    def rm_scr(self):
        ens_premium, rm_premium = self._coverage_premium_split()
        return self.rm_coverage - rm_premium

    def _do_premium_split(self):
        ens_premium, rm_premium = self._coverage_premium_split()
        payout = self.payout - self.rm_coverage
        self.pure_premium = (payout.to_ray() * self.loss_prob * self.risk_module.moc).to_wad()
        self.premium_for_lps = self.scr * (
            self.risk_module.scr_interest_rate * _R(self.expiration - self.start) // _R(SECONDS_IN_YEAR)
        ).to_wad()
        self.premium_for_ensuro = self.risk_module.ensuro_fee.to_wad() * self.pure_premium
        require(ens_premium >= (self.pure_premium + self.premium_for_lps + self.premium_for_ensuro),
                "Premium less than minimum")
        self.premium_for_rm = (
            rm_premium + ens_premium - self.pure_premium - self.premium_for_lps - self.premium_for_ensuro
        )
        self.interest_rate.assert_equal(self.risk_module.scr_interest_rate)

    def premium_split(self):
        return self.pure_premium, self.premium_for_ensuro, self.premium_for_rm, self.premium_for_lps

    def split_payout(self, payout):
        # returns (toBePaid_with_pool, premiumsWon, toReturnToRM)
        non_capital_premiums = self.pure_premium + self.premium_for_rm + self.premium_for_ensuro
        if payout == self.payout:
            return payout - non_capital_premiums, Wad(0), Wad(0)
        if non_capital_premiums >= payout:
            return Wad(0), non_capital_premiums - payout, self.rm_scr
        payout -= non_capital_premiums
        rm_payout = self.rm_coverage * payout // self.payout
        return payout - rm_payout, Wad(0), self.rm_scr - rm_payout

    @property
    def interest_rate(self):
        return (
            self.premium_for_lps * _W(SECONDS_IN_YEAR) // (
                _W(self.expiration - self.start) * self.scr
            )
        ).to_ray()

    def accrued_interest(self):
        seconds = Ray.from_value(time_control.now - self.start)
        return (
            self.scr.to_ray() * seconds * self.interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        ).to_wad()

    def get_scr_share(self, etoken_name):
        if etoken_name not in self.locked_funds:
            return Ray(0)
        return (self.locked_funds[etoken_name] // self.scr).to_ray()


def non_negative(value):
    if value < 0:
        raise ValueError("Not allowed negative")


class EToken(ERC20Token):
    MIN_SCALE = _R("0.0000000001")  # 1e-10
    policy_pool = ContractProxyField()
    expiration_period = IntField()
    scale_factor = RayField(default=_R(1), validation_hook=non_negative)
    last_scale_update = IntField(default=time_control.now)

    scr = WadField(default=_W(0))
    scr_interest_rate = RayField(default=_R(0))
    token_interest_rate = RayField(default=_R(0))
    liquidity_requirement = RayField(default=_R(1))
    max_utilization_rate = RayField(default=_R(1))

    pool_loan = WadField(default=_W(0))
    pool_loan_interest_rate = RayField(default=_R("0.05"))
    pool_loan_scale = RayField(default=_R(1))
    pool_loan_last_update = IntField(default=None, allow_none=True)

    set_attr_roles = {
        "pool_loan_interest_rate": "LEVEL2_ROLE"
    }

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._running_as = "ensuro"

    def _update_current_scale(self):
        self.scale_factor = self._calculate_current_scale()
        require(self.scale_factor >= self.MIN_SCALE, "Scale too small, can lead to rounding errors")
        self.last_scale_update = time_control.now

    def _update_token_interest_rate(self):
        """Should be called each time total_supply changes or scr changes"""
        total_supply = self.total_supply().to_ray()
        if total_supply:
            self.token_interest_rate = self.scr_interest_rate * self.scr.to_ray() // total_supply
        else:
            self.token_interest_rate = Ray(0)

    def _calculate_current_scale(self):
        seconds = time_control.now - self.last_scale_update
        if seconds <= 0:
            return self.scale_factor
        increment = (
            Ray.from_value(seconds) * self.token_interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        )
        return self.scale_factor * (Ray(RAY) + increment)

    @contextmanager
    def thru_policy_pool(self):
        yield self

    @view
    def get_current_scale(self, updated):
        if updated:
            return self._calculate_current_scale()
        else:
            return self.scale_factor

    def _base_supply(self):
        return super().total_supply()

    @view
    def total_supply(self):
        return (super().total_supply().to_ray() * self._calculate_current_scale()).to_wad()

    @property
    def ocean(self):
        return max(self.total_supply() - self.scr, _W(0))

    @property
    def ocean_for_new_scr(self):
        return max(self.total_supply() - self.scr, _W(0)) * self.max_utilization_rate.to_wad()

    def lock_scr(self, policy, scr_amount):
        self._update_current_scale()
        total_supply = self.total_supply()
        ocean = total_supply - self.scr
        require(scr_amount <= ocean, "Not enought OCEAN to cover the SCR")

        if self.scr == 0:
            self.scr = scr_amount
            self.scr_interest_rate = policy.interest_rate
        else:
            orig_scr = self.scr
            self.scr += scr_amount
            self.scr_interest_rate = (
                self.scr_interest_rate * orig_scr.to_ray() + policy.interest_rate * scr_amount.to_ray()
            ) // self.scr.to_ray()  # weighted average of previous and policy interest_rate
        self._update_token_interest_rate()

    def unlock_scr(self, policy, scr_amount):
        require(scr_amount <= self.scr, "Want to unlock more SCR than locked")
        self._update_current_scale()

        if self.scr == scr_amount:
            self.scr = Wad(0)
            self.scr_interest_rate = Ray(0)
        else:
            orig_scr = self.scr
            self.scr -= scr_amount
            self.scr_interest_rate = (
                self.scr_interest_rate * orig_scr.to_ray() - policy.interest_rate * scr_amount.to_ray()
            ) // self.scr.to_ray()  # revert weighted average
        self._update_token_interest_rate()

    def discrete_earning(self, amount):
        self._update_current_scale()
        new_total_supply = amount + self.total_supply()
        self.scale_factor = new_total_supply.to_ray() // self._base_supply().to_ray()
        require(self.scale_factor >= self.MIN_SCALE, "Scale too small, can lead to rounding errors")
        self._update_token_interest_rate()

    def asset_earnings(self, amount):
        self._update_current_scale()
        self.discrete_earning(amount)

    def deposit(self, provider, amount):
        require(
            self.policy_pool.config.lp_whitelist is None or
            self.policy_pool.config.lp_whitelist.accepts_deposit(self, provider, amount),
            "Liquidity Provider not whitelisted"
        )
        self._update_current_scale()
        scaled_amount = (amount.to_ray() // self.scale_factor).to_wad()
        self.mint(provider, scaled_amount)
        self._update_token_interest_rate()
        return self.balance_of(provider)

    def balance_of(self, provider):
        principal_balance = super().balance_of(provider)
        if not principal_balance:
            return Wad(0)
        scale_factor = self._calculate_current_scale()
        return (principal_balance.to_ray() * scale_factor).to_wad()

    def _transfer(self, sender, recipient, amount):
        require(
            self.policy_pool.config.lp_whitelist is None or
            self.policy_pool.config.lp_whitelist.accepts_transfer(self, sender, recipient, amount),
            "Transfer not allowed - Liquidity Provider not whitelisted"
        )
        scaled_amount = (amount.to_ray() // self._calculate_current_scale()).to_wad()
        super()._transfer(sender, recipient, scaled_amount)

    @view
    def total_withdrawable(self):
        """Returns the amount that's available to be withdrawed"""
        locked = (
            self.scr.to_ray() * (_R(1) + self.scr_interest_rate) * self.liquidity_requirement
        ).to_wad()
        return max(_W(0), self.total_supply() - locked)

    def withdraw(self, provider, amount):
        self._update_current_scale()
        balance = self.balance_of(provider)
        if balance == 0:
            return Wad(0)
        if amount is None or amount > balance:
            amount = balance
        amount = min(amount, self.total_withdrawable())
        if amount == 0:
            return Wad(0)

        scaled_amount = (amount.to_ray() // self.scale_factor).to_wad()
        self.burn(provider, scaled_amount)
        self._update_token_interest_rate()

        return amount

    def accepts(self, policy):
        return policy.expiration <= (time_control.now + self.expiration_period)

    def _update_pool_loan_scale(self):
        self.pool_loan_scale = self._get_pool_loan_scale()
        self.pool_loan_last_update = time_control.now

    def _max_negative_adjustment(self):
        return max(
            self.total_supply() - (self.MIN_SCALE * _R(10) * self._base_supply().to_ray()).to_wad(),
            _W(0)
        )

    def lend_to_pool(self, amount, from_ocean=True):
        if from_ocean:
            if amount > self.ocean:
                amount = self.ocean
        else:
            if amount > self.total_supply():
                amount = self.total_supply()
        if amount > self._max_negative_adjustment():
            amount = self._max_negative_adjustment()
            if amount <= 0:
                return Wad(0)
        if self.pool_loan == 0:
            self.pool_loan = amount
            self.pool_loan_scale = Ray(RAY)
            self.pool_loan_last_update = time_control.now
        else:
            self._update_pool_loan_scale()
            self.pool_loan += (amount.to_ray() // self.pool_loan_scale).to_wad()
        self._update_current_scale()
        self.discrete_earning(-amount)
        if not from_ocean and self.scr > self.total_supply():
            # Notify insolvency_hook - Insuficient solvency
            if self.policy_pool.config.insolvency_hook:
                self.policy_pool.config.insolvency_hook.insolvent_etoken(
                    self, self.scr - self.total_supply()
                )
        return amount

    def repay_pool_loan(self, amount):
        self._update_pool_loan_scale()
        self.pool_loan = (
            (self.get_pool_loan() - amount).to_ray() // self.pool_loan_scale
        ).to_wad()
        self._update_current_scale()
        self.discrete_earning(amount)

    def _get_pool_loan_scale(self):
        seconds = time_control.now - self.pool_loan_last_update
        if seconds <= 0:
            return self.pool_loan_scale
        increment = (
            Ray.from_value(seconds) * self.pool_loan_interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        )
        return self.pool_loan_scale * (Ray(RAY) + increment)

    def get_pool_loan(self):
        if self.pool_loan == 0:
            return self.pool_loan
        return (self.pool_loan.to_ray() * self._get_pool_loan_scale()).to_wad()

    def set_pool_loan_interest_rate(self, new_rate):
        self._update_pool_loan_scale()
        self.pool_loan_interest_rate = new_rate

    def set_max_utilization_rate(self, new_rate):
        self.max_utilization_rate = new_rate

    def get_investable(self):
        return self.scr + self.ocean + self.get_pool_loan()


class PolicyNFT(ERC721Token):
    policy_count = IntField(default=0)

    def safeMint(self, customer):
        self.policy_count += 1
        self.mint(customer, self.policy_count)
        return self.policy_count


class PolicyPoolConfig(AccessControlContract):
    policy_pool = ContractProxyField(allow_none=True, default=None)
    treasury = AddressField(default="ENS")
    asset_manager = ContractProxyField(default=None, allow_none=True)
    insolvency_hook = ContractProxyField(default=None, allow_none=True)
    lp_whitelist = ContractProxyField(default=None, allow_none=True)
    risk_modules = DictField(StringField(), ContractProxyField(), default={})

    def connect(self, policy_pool):
        require(self.policy_pool is None, "PolicyPool already connected")
        require(self.contract_id == policy_pool.config.contract_id, "PolicyPool not connected to this config")
        self.policy_pool = policy_pool

    def add_risk_module(self, risk_module):
        self.risk_modules[risk_module.name] = ContractProxy(risk_module.contract_id)

    @only_role("LEVEL1_ROLE", "GUARDIAN_ROLE")
    def set_insolvency_hook(self, insolvency_hook):
        self.insolvency_hook = ContractProxy(insolvency_hook.contract_id) if insolvency_hook else None

    @only_role("LEVEL1_ROLE", "GUARDIAN_ROLE")
    def set_lp_whitelist(self, lp_whitelist):
        self.lp_whitelist = ContractProxy(lp_whitelist.contract_id) if lp_whitelist else None

    @only_role("LEVEL1_ROLE", "GUARDIAN_ROLE")
    def set_asset_manager(self, asset_manager):
        self.policy_pool.set_asset_manager(asset_manager)
        self.asset_manager = asset_manager


class PolicyPool(AccessControlContract):
    NEGLIGIBLE_AMOUNT = _W("0.0001")

    config = ContractProxyField()
    policy_nft = ContractProxyField()
    currency = ContractProxyField()
    etokens = DictField(StringField(), ContractProxyField(), default={})
    policies = DictField(IntField(), CompositeField(Policy), default={})
    active_premiums = WadField(default=Wad(0))
    active_pure_premiums = WadField(default=Wad(0))
    borrowed_active_pp = WadField(default=Wad(0))
    won_pure_premiums = WadField(default=Wad(0))

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.config.connect(self)

    def has_role(self, role, account):
        return self.config.has_role(role, account)

    @property
    def pure_premiums(self):
        return self.active_pure_premiums + self.won_pure_premiums - self.borrowed_active_pp

    def add_etoken(self, etoken):
        self.etokens[etoken.name] = ContractProxy(etoken.contract_id)

    def set_asset_manager(self, asset_manager):
        if self.config.asset_manager:
            self.config.asset_manager.deinvest_all()
            self.currency.approve(self, self.config.asset_manager, _W(0))
        self.currency.approve(self, asset_manager, _W(1e20))

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

    def fast_forward_time(self, secs):
        global time_control
        return time_control.fast_forward(secs)

    def now(self):
        global time_control
        return time_control.now

    @external
    def new_policy(self, policy, customer):
        rm = policy.risk_module
        self.currency.transfer_from(self.contract_id, customer, self.contract_id, policy.premium)
        policy.id = self.policy_nft.safeMint(customer)

        if policy.rm_scr:
            self.currency.transfer_from(self.contract_id, rm.wallet, self.contract_id, policy.rm_scr)

        assert policy.interest_rate >= 0

        self.active_pure_premiums += policy.pure_premium
        self.active_premiums += policy.premium

        self._lock_scr(policy)

        self.policies[policy.id] = policy
        return policy.id

    def _lock_scr(self, policy):
        ocean = Wad(0)
        ocean_per_token = {}
        for etk in self.etokens.values():
            if not etk.accepts(policy):
                continue
            ocean_token = etk.ocean_for_new_scr
            if ocean_token == 0:
                continue
            ocean += ocean_token
            ocean_per_token[etk.name] = ocean_token

        require(ocean >= policy.scr, "Not enought ocean to cover the policy")

        scr_not_locked = policy.scr

        for index, (token_name, ocean_token) in enumerate(ocean_per_token.items()):
            if index < (len(ocean_per_token) - 1):
                scr_for_token = policy.scr * ocean_token // ocean
            else:  # Last one gets the rest
                scr_for_token = scr_not_locked
            self.etokens[token_name].lock_scr(policy, scr_for_token)
            policy.locked_funds[token_name] = scr_for_token
            scr_not_locked -= scr_for_token

    def _transfer_to(self, target, amount):
        if amount == _W(0):
            return
        balance = self.currency.balance_of(self.contract_id)
        if self.config.asset_manager and balance < amount:
            self.config.asset_manager.refill_wallet(amount)

        # Calculate again the balance and check if enought, if not call unsolvency_hook
        if self.config.insolvency_hook and self.currency.balance_of(self.contract_id) < amount:
            self.config.insolvency_hook.out_of_cash(amount - self.currency.balance_of(self.contract_id))
        return self.currency.transfer(self.contract_id, target, amount)

    def _pay_from_pool(self, to_pay):
        # 1. take from won_pure_premiums
        if to_pay <= self.won_pure_premiums:
            self.won_pure_premiums -= to_pay
            return Wad(0)
        elif self.won_pure_premiums > 0:
            to_pay -= self.won_pure_premiums
            self.won_pure_premiums = Wad(0)
        # 2. borrow from active pure premiums
        if to_pay <= (self.active_pure_premiums - self.borrowed_active_pp):
            self.borrowed_active_pp += to_pay
            return Wad(0)
        elif (self.active_pure_premiums - self.borrowed_active_pp) > 0:
            # Borrow some
            to_pay -= self.active_pure_premiums - self.borrowed_active_pp
            self.borrowed_active_pp = self.active_pure_premiums
        return to_pay

    def _store_pure_premium_won(self, pure_premium_won):
        if not pure_premium_won:
            return
        if self.borrowed_active_pp >= pure_premium_won:
            self.borrowed_active_pp -= pure_premium_won
            return
        elif self.borrowed_active_pp > 0:
            pure_premium_won -= self.borrowed_active_pp
            self.borrowed_active_pp = Wad(0)
        self.won_pure_premiums += pure_premium_won

    @external
    def receive_grant(self, sender, amount):
        self.currency.transfer_from(self.contract_id, sender, self.contract_id, amount)
        self._store_pure_premium_won(amount)

    @external
    @only_role("WITHDRAW_WON_PREMIUMS_ROLE")
    def withdraw_won_premiums(self, amount):
        if amount > self.won_pure_premiums:
            amount = self.won_pure_premiums
        require(amount > 0, "No premiums to withdraw")
        self._pay_from_pool(amount)
        self._transfer_to(self.config.treasury, amount)
        return amount

    @external
    def repay_etoken_loan(self, etoken):
        etk = self.etokens[etoken]
        pool_loan = etk.get_pool_loan()
        to_pay_later = self._pay_from_pool(pool_loan)
        etk.repay_pool_loan(pool_loan - to_pay_later)
        return pool_loan - to_pay_later

    @external
    def expire_policy(self, policy_id):
        policy = self.policies[policy_id]
        require(policy.expiration <= time_control.now, "Policy not expired yet")
        return self.resolve_policy(policy_id, Wad(0))

    @external
    def resolve_policy(self, policy_id, payout):
        policy = self.policies[policy_id]
        if type(payout) == bool:
            payout = policy.payout if payout is True else Wad(0)

        customer_won = payout > Wad(0)

        self.active_premiums -= policy.premium
        self.active_pure_premiums -= policy.pure_premium

        pure_premium, for_ensuro, for_rm, for_lps = policy.premium_split()
        adjustment = for_lps - policy.accrued_interest()

        if customer_won:
            policy_owner = self.policy_nft.owner_of(policy.id)
            self._transfer_to(policy_owner, payout)
            to_pay_from_pool, pure_premium_won, return_to_rm = policy.split_payout(payout)
            if return_to_rm:
                self._transfer_to(policy.risk_module.wallet, return_to_rm)
            borrow_from_scr = self._pay_from_pool(to_pay_from_pool)
        else:
            # Pay Ensuro and RM
            self._transfer_to(policy.risk_module.wallet, for_rm + policy.rm_scr)
            self._transfer_to(self.config.treasury, for_ensuro)
            pure_premium_won = pure_premium
            # Cover first borrowed_active_pp
            if self.borrowed_active_pp > self.active_pure_premiums:
                to_cover = min(self.borrowed_active_pp - self.active_pure_premiums, pure_premium_won)
                self.borrowed_active_pp -= to_cover
                pure_premium_won -= to_cover

        etk_borrow_left = Wad(0)
        for (etoken_name, scr_amount) in policy.locked_funds.items():
            etk = self.etokens[etoken_name]
            etk.unlock_scr(policy, scr_amount)
            etk_share = scr_amount // policy.scr
            # etk_adjustment always done because policy may last more or less than initially calculated
            etk_adjustment = adjustment * etk_share
            etk.discrete_earning(etk_adjustment)
            if not customer_won:
                borrowed_from_etk = etk.get_pool_loan()
                if borrowed_from_etk and pure_premium_won:  # if debt with token, repay from pure_premium
                    repay_amount = min(borrowed_from_etk, pure_premium * etk_share)
                    etk.repay_pool_loan(repay_amount)
                    pure_premium_won -= repay_amount
            elif borrow_from_scr:
                etk_borrow = borrow_from_scr * etk_share
                etk_borrow_left += etk_borrow - etk.lend_to_pool(etk_borrow)

        if etk_borrow_left > self.NEGLIGIBLE_AMOUNT:
            etk_borrow_left = self._take_loan_from_any_etk(etk_borrow_left)

        require(etk_borrow_left <= self.NEGLIGIBLE_AMOUNT, "Don't know where to take the rest of the money")

        self._store_pure_premium_won(pure_premium_won)

        policy.risk_module.remove_policy(policy)
        del self.policies[policy_id]

    def _take_loan_from_any_etk(self, etk_borrow_left):
        "When locked tokens don't have enought money, we take money from any token"
        for etk in self.etokens.values():
            etk_borrow_left -= etk.lend_to_pool(etk_borrow_left, False)
            if etk_borrow_left <= self.NEGLIGIBLE_AMOUNT:
                break
        return etk_borrow_left

    @external
    def rebalance_policy(self, policy_id):
        policy = self.policies[policy_id]

        # unlock previous SCR
        for (etoken_name, scr_amount) in policy.locked_funds.items():
            etk = self.etokens[etoken_name]
            etk.unlock_scr(policy, scr_amount)

        policy.locked_funds = {}
        self._lock_scr(policy)

    def get_investable(self):
        borrowed_from_etk = sum((etk.get_pool_loan() for etk in self.etokens.values()), Wad(0))
        return max(
            self.active_premiums + self.won_pure_premiums - self.borrowed_active_pp - borrowed_from_etk,
            Wad(0)
        )

    def asset_earnings(self, amount):
        if amount > 0:
            # earnings - first repay borrowed_active_pp then increase won_pure_premiums
            if self.borrowed_active_pp >= amount:
                self.borrowed_active_pp -= amount
                return
            elif self.borrowed_active_pp > 0:
                amount -= self.borrowed_active_pp
                self.borrowed_active_pp = Wad(0)
            self.won_pure_premiums += amount
        elif amount < 0:
            # losses - first consume won_pure_premiums then borrowed_active_pp
            amount = -amount
            if self.won_pure_premiums >= amount:
                self.won_pure_premiums -= amount
                return
            elif self.won_pure_premiums > 0:
                amount -= self.won_pure_premiums
                self.won_pure_premiums = Wad(0)
            self.borrowed_active_pp += amount
            # borrowed_active_pp should be < active_pure_premiums
            # TODO: validation and handling, but shouldn't happen

    def get_policy_fund_count(self, policy_id):
        return len(self.policies[policy_id].locked_funds)

    def get_policy_fund(self, policy_id, etoken):
        return self.policies[policy_id].locked_funds.get(etoken.name, _W(0))


class AssetManager(AccessControlContract):
    pool = ContractProxyField()

    cash_balance = WadField(default=Wad(0))
    liquidity_min = WadField()
    liquidity_middle = WadField()
    liquidity_max = WadField()

    # Any time balance_of(PolicyPool) < liquidity_min we refill up to liquidity_middle
    # Any time balance_of(PolicyPool) > liquidity_max take liquidity up liquidity_middle
    last_investment_value = WadField(default=Wad(0))

    def total_investable(self):
        "Estimation of all total assets available reinvest"
        pool_investable = self.pool.get_investable()
        token_investable = sum((etk.get_investable() for etk in self.pool.etokens.values()), Wad(0))

        return pool_investable + token_investable

    def distribute_earnings(self):
        investment_value = self.get_investment_value()
        total_investable = self.total_investable()
        earnings = investment_value - self.last_investment_value
        pool_share = self.pool.get_investable() // total_investable
        self.pool.asset_earnings(earnings * pool_share)

        for etk in self.pool.etokens.values():
            etk_share = etk.get_investable() // total_investable
            etk.asset_earnings(earnings * etk_share)

        self.last_investment_value = investment_value

    def get_investment_value(self):
        raise NotImplementedError()

    def rebalance(self):
        pool_cash = self.pool.currency.balance_of(self.pool.contract_id)

        if pool_cash > self.liquidity_max:
            self._invest(pool_cash - self.liquidity_middle)
        elif pool_cash < self.liquidity_min:
            self._deinvest(self.liquidity_middle - pool_cash)
        # else:
            # pool_cash between [self.liquidity_min, self.liquidity_max]
            # No need to transfer

    def checkpoint(self):
        self.distribute_earnings()
        self.rebalance()

    def refill_wallet(self, payment_amount):
        pool_cash = self.pool.currency.balance_of(self.pool.contract_id)
        investment_value = self.get_investment_value()
        # try to leave the pool balance at liquidity_middle after the payment
        deinvest = payment_amount + self.liquidity_middle - pool_cash
        if deinvest > investment_value:
            deinvest = investment_value

        self._deinvest(deinvest)

    def _invest(self, amount):
        self.cash_balance += amount
        self.last_investment_value += amount
        # Must be reimplemented and do the actual cash movement

    def _deinvest(self, amount):
        self.cash_balance -= amount
        self.last_investment_value -= amount
        # Must be reimplemented and do the actual cash movement

    def deinvest_all(self):
        self._deinvest(self.get_investment_value())


class FixedRateAssetManager(AssetManager):
    """Test asset manager that accrues interest at fixed rate"""

    interest_rate = RayField(default=_R("0.05"))
    last_mint_burn = IntField(default=time_control.now)

    def get_investment_value(self):
        balance = self.pool.currency.balance_of(self.contract_id)
        secs = time_control.now - self.last_mint_burn
        if secs <= 0:
            return balance
        interest_rate = self.interest_rate * _R(secs) // _R(SECONDS_IN_YEAR)
        return (balance.to_ray() * (_R(1) + interest_rate)).to_wad()

    def _mint_burn(self):
        if self.last_mint_burn == time_control.now:
            return
        balance = self.pool.currency.balance_of(self.contract_id)
        current_value = self.get_investment_value()
        if current_value > balance:
            self.pool.currency.mint(self.contract_id, current_value - balance)
        elif current_value < balance:
            self.pool.currency.burn(self.contract_id, balance - current_value)
        self.last_mint_burn = time_control.now

    def _invest(self, amount):
        self._mint_burn()
        super()._invest(amount)
        self.pool.currency.transfer(self.pool.contract_id, self.contract_id, amount)

    def _deinvest(self, amount):
        self._mint_burn()
        super()._deinvest(amount)
        self.pool.currency.transfer(self.contract_id, self.pool.contract_id, amount)


class FreeGrantInsolvencyHook(Contract):
    pool = ContractProxyField()
    cash_granted = WadField(default=Wad(0))

    def out_of_cash(self, amount):
        # Just a simple implementation that mints money and grants
        self.pool.currency.mint(self.contract_id, amount)
        self.pool.currency.approve(self.contract_id, self.pool.contract_id, amount)
        self.pool.receive_grant(self.contract_id, amount)
        self.cash_granted += amount

    def insolvent_etoken(self, etoken, amount):
        pass


class LPInsolvencyHook(Contract):
    pool = ContractProxyField()
    etoken = StringField()
    cash_deposited = WadField(default=Wad(0))
    cover_etoken = IntField(default=0)

    def out_of_cash(self, amount):
        self._mint_and_deposit(self.etoken, amount)

    def _mint_and_deposit(self, etoken, amount):
        # Just a simple implementation that mints money and grants
        self.pool.currency.mint(self.contract_id, amount)
        self.pool.currency.approve(self.contract_id, self.pool.contract_id, amount)
        self.pool.deposit(etoken, self.contract_id, amount)
        self.cash_deposited += amount

    def insolvent_etoken(self, etoken, amount):
        if self.cover_etoken:
            # Covers amount + 10% of the SCR
            self._mint_and_deposit(etoken.name, amount + etoken.scr * _W("0.1"))


class LPManualWhitelist(Contract):
    pool = ContractProxyField()
    whitelisted = DictField(AddressField(), IntField(), default={})

    def has_role(self, role, account):
        return self.pool.config.has_role(role, account)

    @only_role("LP_WHITELIST_ROLE")
    def whitelist_address(self, address, whitelisted):
        self.whitelisted[address] = whitelisted

    def accepts_deposit(self, etoken, provider, amount):
        return self.whitelisted.get(provider, False)

    def accepts_transfer(self, etoken, from_, to_, amount):
        return self.whitelisted.get(to_, False)
