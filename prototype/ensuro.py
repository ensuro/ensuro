from contextlib import contextmanager
from hashlib import md5
from m9g import Model
from m9g.fields import StringField, IntField, DictField, CompositeField
from ethproto.contracts import AccessControlContract, ERC20Token, external, view, RayField, \
    WadField, AddressField, ContractProxyField, ContractProxy, require, only_role, Contract
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
    premiums_account = ContractProxyField()
    name = StringField()
    moc = WadField(default=_W(1))
    jr_coll_ratio = WadField(default=Wad(0))
    coll_ratio = WadField(default=Wad(0))
    ensuro_pp_fee = WadField(default=Wad(0))   # Ensuro fee as % of pure_premium
    ensuro_coc_fee = WadField(default=Wad(0))   # Ensuro fee as % of coc
    jr_roc = WadField(default=Wad(0))
    sr_roc = WadField(default=Wad(0))
    max_payout_per_policy = WadField(default=_W(1000000))
    exposure_limit = WadField(default=_W(10000000))
    active_exposure = WadField(default=_W(0))

    wallet = AddressField(default="RM")

    set_attr_roles = {
        "wallet": "RM_PROVIDER_ROLE",
    }

    pool_set_attr_roles = {
        "moc": "LEVEL2_ROLE",
        "jr_coll_ratio": "LEVEL2_ROLE",
        "coll_ratio": "LEVEL2_ROLE",
        "ensuro_pp_fee": "LEVEL2_ROLE",
        "jr_roc": "LEVEL2_ROLE",
        "sr_roc": "LEVEL2_ROLE",
        "max_payout_per_policy": "LEVEL2_ROLE",
        "exposure_limit": "LEVEL2_ROLE",
    }

    def _validate_setattr(self, attr_name, value):
        if attr_name in self.pool_set_attr_roles:
            require(
                self.policy_pool.config.has_role(self.pool_set_attr_roles[attr_name], self._running_as),
                f"AccessControl: AccessControl: account {self._running_as} is missing role "
                f"'{self.pool_set_attr_roles[attr_name]}'"
            )
        return super()._validate_setattr(attr_name, value)

    def make_policy_id(self, internal_id):
        prefix = md5(self.contract_id.encode("utf-8")).hexdigest()
        return (int(prefix, 16) << 96) + internal_id

    @external
    def new_policy(self, payout, premium, loss_prob, expiration, customer, internal_id):
        assert type(loss_prob) == Wad, "Loss prob MUST be wad"
        start = time_control.now
        require(self.policy_pool.currency.allowance(customer, self.policy_pool.contract_id) >= premium,
                "You must allow ENSURO to transfer the premium")
        policy = Policy(id=-1, risk_module=self, payout=payout, premium=premium,
                        loss_prob=loss_prob, start=start, expiration=expiration)

        require(policy.payout <= self.max_payout_per_policy,
                f"Policy Payout: {policy.payout} > maximum per policy {self.max_payout_per_policy}")
        active_exposure = self.active_exposure + policy.payout
        require(active_exposure <= self.exposure_limit, "RiskModule: Exposure limit exceeded")
        self.active_exposure = active_exposure

        policy.id = self.policy_pool.new_policy(policy, customer, internal_id)
        assert policy.id > 0
        return policy

    def get_minimum_premium(self, payout, loss_prob, expiration):
        pure_premium = payout * loss_prob * self.moc
        scr = payout * self.coll_ratio - pure_premium
        coc = scr * self.sr_roc * _W(expiration - time_control.now) // _W(SECONDS_IN_YEAR)
        ensuro_commission = pure_premium * self.ensuro_pp_fee + coc * self.ensuro_coc_fee
        return (pure_premium + ensuro_commission + coc)

    @external
    def remove_policy(self, policy):
        self.active_exposure -= policy.payout


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
    loss_prob = WadField()
    start = IntField()
    expiration = IntField()
    solvency_etoken = ContractProxyField(default=None, allow_none=True)
    pure_premium = WadField(default=Wad(0))
    ensuro_commission = WadField(default=Wad(0))
    partner_commission = WadField(default=Wad(0))
    coc = WadField(default=Wad(0))

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._do_premium_split()

    def _do_premium_split(self):
        self.pure_premium = self.payout * self.loss_prob * self.risk_module.moc
        self.scr = self.payout * self.risk_module.coll_ratio - self.pure_premium
        self.coc = self.scr * (
            self.risk_module.sr_roc * _W(self.expiration - self.start) // _W(SECONDS_IN_YEAR)
        )
        self.ensuro_commission = (
            self.pure_premium * self.risk_module.ensuro_pp_fee +
            self.coc * self.risk_module.ensuro_coc_fee
        )
        require(self.premium >= (self.pure_premium + self.coc + self.ensuro_commission),
                "Premium less than minimum")
        self.partner_commission = (
            self.premium - self.pure_premium - self.coc - self.ensuro_commission
        )
        self.interest_rate.assert_equal(self.risk_module.sr_roc)

    def premium_split(self):
        return self.pure_premium, self.ensuro_commission, self.partner_commission, self.coc

    @property
    def interest_rate(self):
        return (
            self.coc * _W(SECONDS_IN_YEAR) // (
                _W(self.expiration - self.start) * self.scr
            )
        )

    def accrued_interest(self):
        return (
            self.scr * _W(time_control.now - self.start) * self.interest_rate //
            _W(SECONDS_IN_YEAR)
        )


def non_negative(value):
    if value < 0:
        raise ValueError("Not allowed negative")


class ReserveMixin:
    @property
    def NEGLIGIBLE_AMOUNT(self):
        return Wad(10 ** (self.currency.decimals // 2))

    def _transfer_to(self, target, amount):
        if amount == _W(0):
            return
        balance = self.currency.balance_of(self.contract_id)

        if balance < amount and (amount - balance) < self.NEGLIGIBLE_AMOUNT:
            amount = balance

        return self.currency.transfer(self.contract_id, target, amount)


class EToken(ReserveMixin, ERC20Token):
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

    accept_all_rms = IntField(default=Wad(1))
    accept_exceptions = DictField(ContractProxyField(), IntField(), default={})

    set_attr_roles = {
        "pool_loan_interest_rate": "LEVEL2_ROLE"
    }

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._running_as = "ensuro"

    @property
    def currency(self):
        return self.policy_pool.currency

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
            self.scr_interest_rate = policy.interest_rate.to_ray()
        else:
            orig_scr = self.scr
            self.scr += scr_amount
            self.scr_interest_rate = (
                self.scr_interest_rate * orig_scr.to_ray() + (policy.interest_rate * scr_amount).to_ray()
            ) // self.scr.to_ray()  # weighted average of previous and policy interest_rate
        self._update_token_interest_rate()
        self._check_balance()

    def unlock_scr(self, policy, scr_amount, adjustment):
        # Pre condition: the pool needs to transfer the amount of the interests
        require(scr_amount <= self.scr, "Want to unlock more SCR than locked")
        self._update_current_scale()

        if self.scr == scr_amount:
            self.scr = Wad(0)
            self.scr_interest_rate = Ray(0)
        else:
            orig_scr = self.scr
            self.scr -= scr_amount
            self.scr_interest_rate = (
                self.scr_interest_rate * orig_scr.to_ray() - (policy.interest_rate * scr_amount).to_ray()
            ) // self.scr.to_ray()  # revert weighted average
        self._discrete_earning(adjustment)
        self._check_balance()

    def _discrete_earning(self, amount):
        self._update_current_scale()
        new_total_supply = amount + self.total_supply()
        self.scale_factor = new_total_supply.to_ray() // self._base_supply().to_ray()
        require(self.scale_factor >= self.MIN_SCALE, "Scale too small, can lead to rounding errors")
        self._update_token_interest_rate()

    def _check_balance(self):
        balance = self.currency.balance_of(self)
        require(
            balance >= self.total_supply() or
            (self.total_supply() - balance) < self.NEGLIGIBLE_AMOUNT,
            "Cash balance under total_supply"
        )

    def deposit(self, provider, amount):
        # Pre condition: the pool needs to transfer the amount
        require(
            self.policy_pool.config.lp_whitelist is None or
            self.policy_pool.config.lp_whitelist.accepts_deposit(self, provider, amount),
            "Liquidity Provider not whitelisted"
        )
        self._update_current_scale()
        scaled_amount = (amount.to_ray() // self.scale_factor).to_wad()
        self.mint(provider, scaled_amount)
        self._update_token_interest_rate()
        self._check_balance()
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
            self.scr.to_ray() * self.liquidity_requirement
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

        self._transfer_to(provider, amount)

        return amount

    def accepts(self, policy):
        if self.accept_all_rms and self.accept_exceptions.get(policy.risk_module, False):
            return False
        if not self.accept_all_rms and not self.accept_exceptions.get(policy.risk_module, False):
            return False
        return policy.expiration <= (time_control.now + self.expiration_period)

    def _update_pool_loan_scale(self):
        self.pool_loan_scale = self._get_pool_loan_scale()
        self.pool_loan_last_update = time_control.now

    def _max_negative_adjustment(self):
        return max(
            self.total_supply() - (self.MIN_SCALE * _R(10) * self._base_supply().to_ray()).to_wad(),
            _W(0)
        )

    def lend_to_pool(self, amount, receiver, from_ocean=True):
        amount_asked = amount
        amount = amount_asked

        if from_ocean:
            if amount > self.ocean:
                amount = self.ocean
        else:
            if amount > self.total_supply():
                amount = self.total_supply()
        if amount > self._max_negative_adjustment():
            amount = self._max_negative_adjustment()
            if amount <= 0:
                return amount_asked
        if self.pool_loan == 0:
            self.pool_loan = amount
            self.pool_loan_scale = Ray(RAY)
            self.pool_loan_last_update = time_control.now
        else:
            self._update_pool_loan_scale()
            self.pool_loan += (amount.to_ray() // self.pool_loan_scale).to_wad()
        self._update_current_scale()
        self._discrete_earning(-amount)
        self._transfer_to(receiver, amount)
        self._check_balance()
        return amount_asked - amount

    def repay_pool_loan(self, amount):
        self._update_pool_loan_scale()
        self.pool_loan = (
            (self.get_pool_loan() - amount).to_ray() // self.pool_loan_scale
        ).to_wad()
        self._update_current_scale()
        self._discrete_earning(amount)
        self._check_balance()

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

    @property
    def utilization_rate(self):
        return (self.scr // self.total_supply()).to_ray()

    def set_accept_exception(self, rm, is_exception):
        self.accept_exceptions[rm] = is_exception

    def is_accept_exception(self, rm):
        return self.accept_exceptions.get(rm, False)


class PolicyNFT(ERC721Token):
    def safeMint(self, customer, policy_id):
        self.mint(customer, policy_id)
        return policy_id


class PolicyPoolConfig(AccessControlContract):
    policy_pool = ContractProxyField(allow_none=True, default=None)
    treasury = AddressField(default="ENS")
    lp_whitelist = ContractProxyField(default=None, allow_none=True)
    risk_modules = DictField(StringField(), ContractProxyField(), default={})

    def connect(self, policy_pool):
        require(self.policy_pool is None, "PolicyPool already connected")
        require(self.contract_id == policy_pool.config.contract_id, "PolicyPool not connected to this config")
        self.policy_pool = policy_pool

    def add_risk_module(self, risk_module):
        # TODO: validate risk_module.premiums_account.pool = self.policy_pool
        self.risk_modules[risk_module.name] = ContractProxy(risk_module.contract_id)

    @only_role("LEVEL1_ROLE", "GUARDIAN_ROLE")
    def set_lp_whitelist(self, lp_whitelist):
        self.lp_whitelist = ContractProxy(lp_whitelist.contract_id) if lp_whitelist else None


class PremiumsAccount(ReserveMixin, AccessControlContract):
    pool = ContractProxyField()
    active_pure_premiums = WadField(default=Wad(0))
    borrowed_active_pp = WadField(default=Wad(0))
    won_pure_premiums = WadField(default=Wad(0))

    def has_role(self, role, account):
        return self.pool.config.has_role(role, account)

    @property
    def currency(self):
        return self.pool.currency

    @property
    def pure_premiums(self):
        return self.active_pure_premiums + self.won_pure_premiums - self.borrowed_active_pp

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
        self._transfer_to(self.pool.config.treasury, amount)
        return amount

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

    def new_policy(self, policy):
        self.active_pure_premiums += policy.pure_premium

    # TODO: restore repay_pool_loan?

    @external
    def policy_resolved_with_payout(self, customer, policy, payout):
        self.active_pure_premiums -= policy.pure_premium

        borrow_from_scr = Wad(0)
        if policy.pure_premium >= payout:
            self._store_pure_premium_won(policy.pure_premium - payout)
            # TODO: repay debt?
        else:
            borrow_from_scr = self._pay_from_pool(payout - policy.pure_premium)
            if borrow_from_scr > 0:
                amount_left = policy.solvency_etoken.lend_to_pool(borrow_from_scr, customer)
                require(amount_left <= self.NEGLIGIBLE_AMOUNT,
                        "Don't know where to take the rest of the money")

        self._transfer_to(customer, payout - borrow_from_scr)
        return borrow_from_scr

    @external
    def policy_expired(self, policy):
        self.active_pure_premiums -= policy.pure_premium

        # Pay Ensuro and RM
        pure_premium_won = policy.pure_premium
        # Cover first borrowed_active_pp
        if self.borrowed_active_pp > self.active_pure_premiums:
            to_cover = min(self.borrowed_active_pp - self.active_pure_premiums, pure_premium_won)
            self.borrowed_active_pp -= to_cover
            pure_premium_won -= to_cover

        etk = policy.solvency_etoken

        borrowed_from_etk = etk.get_pool_loan()
        if borrowed_from_etk and pure_premium_won:  # if debt with token, repay from pure_premium
            repay_amount = min(borrowed_from_etk, pure_premium_won)
            self._transfer_to(etk, repay_amount)
            etk.repay_pool_loan(repay_amount)
            pure_premium_won -= repay_amount

        self._store_pure_premium_won(pure_premium_won)


class PolicyPool(AccessControlContract):
    config = ContractProxyField()
    policy_nft = ContractProxyField()
    currency = ContractProxyField()
    etokens = DictField(StringField(), ContractProxyField(), default={})
    policies = DictField(IntField(), CompositeField(Policy), default={})

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.config.connect(self)
        self.NEGLIGIBLE_AMOUNT = Wad(10**(self.currency.decimals // 2))

    def has_role(self, role, account):
        return self.config.has_role(role, account)

    def add_etoken(self, etoken):
        self.etokens[etoken.name] = ContractProxy(etoken.contract_id)

    @external
    def deposit(self, etoken, provider, amount):
        token = self.etokens[etoken]
        self.currency.transfer_from(self.contract_id, provider, token.contract_id, amount)
        return token.deposit(provider, amount)

    @external
    def withdraw(self, etoken, provider, amount):
        token = self.etokens[etoken]
        return token.withdraw(provider, amount)

    def fast_forward_time(self, secs):
        global time_control
        return time_control.fast_forward(secs)

    def now(self):
        global time_control
        return time_control.now

    @external
    def new_policy(self, policy, customer, internal_id):
        policy.id = policy.risk_module.make_policy_id(internal_id)
        self.policy_nft.safeMint(customer, policy.id)

        assert policy.interest_rate >= 0

        policy.risk_module.premiums_account.new_policy(policy)

        self._lock_scr(policy)

        self.policies[policy.id] = policy
        self.currency.transfer_from(
            self.contract_id, customer,
            policy.risk_module.premiums_account, policy.pure_premium
        )
        self.currency.transfer_from(
            self.contract_id, customer,
            policy.solvency_etoken, policy.coc
        )
        self.currency.transfer_from(
            self.contract_id, customer,
            self.config.treasury, policy.ensuro_commission
        )
        if policy.partner_commission and policy.risk_module.wallet != customer:
            self.currency.transfer_from(
                self.contract_id, customer,
                policy.risk_module.wallet, policy.partner_commission
            )
        return policy.id

    def _lock_scr(self, policy):
        for etk_name in sorted(self.etokens.keys()):
            etk = self.etokens[etk_name]
            if not etk.accepts(policy):
                continue
            ocean_token = etk.ocean_for_new_scr
            if ocean_token < policy.scr:
                continue
            policy.solvency_etoken = etk
            etk.lock_scr(policy, policy.scr)
            break
        else:
            require(False, "Not enought ocean to cover the policy")

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

        require(payout == 0 or policy.expiration > time_control.now, "Can't pay expired policy")

        # Unlock SCR and adjust eToken
        for_lps = policy.coc
        adjustment = for_lps - policy.accrued_interest()
        etk = policy.solvency_etoken
        etk.unlock_scr(policy, policy.scr, adjustment)

        if customer_won:
            policy_owner = self.policy_nft.owner_of(policy.id)
            policy.risk_module.premiums_account.policy_resolved_with_payout(
                policy_owner, policy, payout
            )
        else:
            policy.risk_module.premiums_account.policy_expired(policy)

        policy.risk_module.remove_policy(policy)
        del self.policies[policy_id]


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
