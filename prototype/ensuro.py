from contextlib import contextmanager
from hashlib import md5
from functools import wraps
from m9g import Model
from m9g.fields import StringField, IntField, DictField, CompositeField, ListField
from ethproto.contracts import (
    AccessControlContract,
    ERC20Token,
    external,
    view,
    RayField,
    WadField,
    AddressField,
    ContractProxyField,
    ContractProxy,
    require,
    only_role,
    Contract,
    RevertError,
)
from ethproto.contracts import ERC721Token
from ethproto.wadray import RAY, Ray, Wad, _W, _R
import time

DAYS_PER_YEAR = 365
HOURS_PER_DAY = 24
SECONDS_IN_HOUR = 3600
SECONDS_IN_YEAR = 365 * 24 * SECONDS_IN_HOUR
MAX_UINT = 2**256 - 1


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


def only_component_role(*roles):
    def decorator(method):
        @wraps(method)
        def inner(self, *args, **kwargs):
            contract_id = self.contract_id
            for role in roles:
                composed_role = f"{role}-{contract_id}"
                if self.has_role(composed_role, self.running_as):
                    break
            else:
                raise RevertError(
                    f"AccessControl: account {self.running_as} is missing role {role}"
                )
            return method(self, *args, **kwargs)

        return inner

    return decorator


class RiskModule(AccessControlContract):
    policy_pool = ContractProxyField()
    premiums_account = ContractProxyField()
    name = StringField()
    moc = WadField(default=_W(1))
    jr_coll_ratio = WadField(default=Wad(0))
    coll_ratio = WadField(default=_W(1))
    ensuro_pp_fee = WadField(default=Wad(0))  # Ensuro fee as % of pure_premium
    ensuro_coc_fee = WadField(default=Wad(0))  # Ensuro fee as % of coc
    jr_roc = WadField(default=Wad(0))
    sr_roc = WadField(default=Wad(0))
    max_payout_per_policy = WadField(default=_W(1000000))
    exposure_limit = WadField(default=_W(10000000))
    active_exposure = WadField(default=_W(0))
    max_duration = IntField(default=DAYS_PER_YEAR * HOURS_PER_DAY)

    wallet = AddressField(default="RM")

    pool_component_set_attr_roles = {
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
        "exposure_limit": "LEVEL1_ROLE",
        "max_duration": "LEVEL2_ROLE",
    }

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        require(
            self.coll_ratio <= _W(1) and self.coll_ratio > 0,
            "Validation: collRatio must be <=1",
        )
        require(self.jr_coll_ratio <= _W(1), "Validation: jrCollRatio must be <=1")
        require(
            self.jr_coll_ratio <= self.coll_ratio,
            "Validation: collRatio >= jrCollRatio",
        )
        require(
            self.moc <= _W(4) and self.moc >= _W("0.5"),
            "Validation: moc must be [0.5, 4]",
        )
        require(self.ensuro_pp_fee <= _W(1), "Validation: ensuroPpFee must be <= 1")
        require(self.ensuro_coc_fee <= _W(1), "Validation: ensuroCocFee must be <= 1")
        require(self.sr_roc <= _W(1), "Validation: srRoc must be <= 1 (100%)")
        require(self.jr_roc <= _W(1), "Validation: jrRoc must be <= 1 (100%)")
        #  _maxPayoutPerPolicy no limits
        require(
            self.exposure_limit >= self.active_exposure,
            "Validation: exposureLimit can't be less than actual activeExposure",
        )
        require(
            self.exposure_limit >= 0 and self.max_payout_per_policy > 0,
            "Exposure and MaxPayout must be >0",
        )
        require(self.wallet != 0, "Validation: Wallet can't be zero address")

    def has_role(self, role, account):
        return self.policy_pool.access.has_role(role, account)

    def _validate_setattr(self, attr_name, value):
        if attr_name in self.pool_set_attr_roles:
            require(
                self.policy_pool.access.has_role(
                    self.pool_set_attr_roles[attr_name], self._running_as
                ),
                f"AccessControl: AccessControl: account {self._running_as} is missing role "
                f"'{self.pool_set_attr_roles[attr_name]}'",
            )
        if attr_name in self.pool_component_set_attr_roles:
            composed_role = (
                f"{self.pool_component_set_attr_roles[attr_name]}-{self.contract_id}"
            )
            require(
                self.policy_pool.access.has_role(composed_role, self._running_as),
                f"AccessControl: AccessControl: account {self._running_as} is missing role "
                f"'{composed_role}'",
            )
        return super()._validate_setattr(attr_name, value)

    def make_policy_id(self, internal_id):
        prefix = md5(self.contract_id.encode("utf-8")).hexdigest()
        return (int(prefix, 16) << 96) + internal_id

    @external
    def new_policy(
        self, payout, premium, loss_prob, expiration, payer, on_behalf_of, internal_id
    ):
        assert type(loss_prob) == Wad, "Loss prob MUST be wad"
        start = time_control.now
        if premium is None:
            premium = self.get_minimum_premium(payout, loss_prob, expiration)

        require(premium < payout, "Premium must be less than payout")
        require(expiration > start, "Expiration must be in the future")
        require(
            ((expiration - start) / SECONDS_IN_HOUR) < self.max_duration,
            "Policy exceeds max duration"
        )
        require(on_behalf_of is not None, "Customer can't be zero address")
        require(
            self.policy_pool.currency.allowance(payer, self.policy_pool.contract_id)
            >= premium,
            "You must allow ENSURO to transfer the premium",
        )
        require(
            self._running_as == payer
            or self.policy_pool.currency.allowance(payer, self._running_as) >= premium,
            "Payer must allow PRICER to transfer the premium",
        )

        policy = Policy(
            id=-1,
            risk_module=self,
            payout=payout,
            premium=premium,
            loss_prob=loss_prob,
            start=start,
            expiration=expiration,
        )

        require(
            policy.payout <= self.max_payout_per_policy,
            f"Policy Payout is more than maximum: {policy.payout} > maximum {self.max_payout_per_policy}",
        )
        active_exposure = self.active_exposure + policy.payout
        require(
            active_exposure <= self.exposure_limit,
            "RiskModule: Exposure limit exceeded",
        )
        self.active_exposure = active_exposure

        policy.id = self.policy_pool.new_policy(
            policy, payer, on_behalf_of, internal_id
        )
        assert policy.id > 0
        return policy

    def get_minimum_premium(self, payout, loss_prob, expiration):
        pure_premium = payout * loss_prob * self.moc
        jr_scr = max(payout * self.jr_coll_ratio - pure_premium, _W(0))
        sr_scr = max(payout * self.coll_ratio - pure_premium - jr_scr, _W(0))
        jr_coc = (
            jr_scr
            * self.jr_roc
            * _W(expiration - time_control.now)
            // _W(SECONDS_IN_YEAR)
        )
        sr_coc = (
            sr_scr
            * self.sr_roc
            * _W(expiration - time_control.now)
            // _W(SECONDS_IN_YEAR)
        )
        ensuro_commission = (
            pure_premium * self.ensuro_pp_fee + (jr_coc + sr_coc) * self.ensuro_coc_fee
        )
        return pure_premium + ensuro_commission + jr_coc + sr_coc

    @external
    def remove_policy(self, policy):
        self.active_exposure -= policy.payout


class TrustfulRiskModule(RiskModule):
    @only_component_role("PRICER_ROLE")
    def new_policy(self, *args, **kwargs):
        payer = kwargs.get("on_behalf_of")
        if self._running_as != payer and self.policy_pool.currency.allowance(
            payer, self._running_as
        ) < (kwargs.get("premium") or MAX_UINT):
            payer = self._running_as
        kwargs["payer"] = payer

        return super().new_policy(*args, **kwargs)

    @external
    @only_component_role("RESOLVER_ROLE")
    def resolve_policy(self, policy_id, customer_won):
        with self.policy_pool.as_(self.contract_id):
            return self.policy_pool.resolve_policy(policy_id, customer_won)


class Policy(Model):
    id = IntField()
    risk_module = ContractProxyField()
    payout = WadField()
    premium = WadField()
    jr_scr = WadField(default=Wad(0))
    sr_scr = WadField(default=Wad(0))
    loss_prob = WadField()
    start = IntField()
    expiration = IntField()
    pure_premium = WadField(default=Wad(0))
    ensuro_commission = WadField(default=Wad(0))
    partner_commission = WadField(default=Wad(0))
    jr_coc = WadField(default=Wad(0))
    sr_coc = WadField(default=Wad(0))

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._do_premium_split()

    def _do_premium_split(self):
        self.pure_premium = self.payout * self.loss_prob * self.risk_module.moc
        if not self.risk_module.jr_coll_ratio:
            self.jr_scr = _W(0)
        elif self.payout * self.risk_module.jr_coll_ratio < self.pure_premium:
            self.jr_scr = _W(0)
        else:
            self.jr_scr = (
                self.payout * self.risk_module.jr_coll_ratio - self.pure_premium
            )
        self.sr_scr = max(
            self.payout * self.risk_module.coll_ratio - self.pure_premium - self.jr_scr,
            _W(0),
        )
        self.sr_coc = self.sr_scr * (
            self.risk_module.sr_roc
            * _W(self.expiration - self.start)
            // _W(SECONDS_IN_YEAR)
        )
        self.jr_coc = self.jr_scr * (
            self.risk_module.jr_roc
            * _W(self.expiration - self.start)
            // _W(SECONDS_IN_YEAR)
        )
        self.ensuro_commission = (
            self.pure_premium * self.risk_module.ensuro_pp_fee
            + (self.sr_coc + self.jr_coc) * self.risk_module.ensuro_coc_fee
        )
        require(
            self.premium
            >= (self.pure_premium + self.jr_coc + self.sr_coc + self.ensuro_commission),
            "Premium less than minimum",
        )
        self.partner_commission = (
            self.premium
            - self.pure_premium
            - self.jr_coc
            - self.sr_coc
            - self.ensuro_commission
        )

    @property
    def sr_interest_rate(self):
        return (
            self.sr_coc
            * _W(SECONDS_IN_YEAR)
            // (_W(self.expiration - self.start) * self.sr_scr)
        )

    @property
    def jr_interest_rate(self):
        return (
            self.jr_coc
            * _W(SECONDS_IN_YEAR)
            // (_W(self.expiration - self.start) * self.jr_scr)
        )

    def sr_accrued_interest(self):
        return (
            self.sr_scr
            * _W(time_control.now - self.start)
            * self.sr_interest_rate
            // _W(SECONDS_IN_YEAR)
        )

    def jr_accrued_interest(self):
        return (
            self.sr_scr
            * _W(time_control.now - self.start)
            * self.jr_interest_rate
            // _W(SECONDS_IN_YEAR)
        )


def non_negative(value):
    if value < 0:
        raise ValueError("Not allowed negative")


class ReserveMixin:
    @property
    def NEGLIGIBLE_AMOUNT(self):
        return Wad(10 ** (self.currency.decimals // 2))

    @only_role("LEVEL1_ROLE", "GUARDIAN_ROLE")
    def set_asset_manager(self, asset_manager, force):
        if self.asset_manager:
            if force:
                try:
                    self.asset_manager.deinvest_all()
                except Exception:
                    pass
            else:
                self.asset_manager.deinvest_all()
        self.asset_manager = asset_manager

    def _transfer_to(self, target, amount):
        if amount == _W(0):
            return
        balance = self.currency.balance_of(self.contract_id)

        if self.asset_manager and balance < amount:
            self.asset_manager.refill_wallet(amount)

        if balance < amount and (amount - balance) < self.NEGLIGIBLE_AMOUNT:
            amount = balance

        return self.currency.transfer(self.contract_id, target, amount)

    def asset_earnings(self, amount):
        """Called from the asset_manager to record the earnings - Must be implemented"""
        raise NotImplementedError()

    @external
    def checkpoint(self):
        self.asset_manager.checkpoint()

    @external
    def rebalance(self):
        self.asset_manager.rebalance()

    @external
    def record_earnings(self):
        self.asset_manager.record_earnings()

    @only_component_role("LEVEL2_ROLE")
    def forward_to_asset_manager(self, method, *args, **kwargs):
        return getattr(self.asset_manager, method)(*args, **kwargs)


class ScaledAmount(Model):
    amount = WadField(default=_W(0))
    scale = RayField(default=_R(1))
    last_update = IntField(default=None, allow_none=True)

    def _update_scale(self, interest_rate):
        if not self.last_update:
            self.scale = _R(1)
        else:
            self.scale = self._get_scale(interest_rate)
        self.last_update = time_control.now

    def _get_scale(self, interest_rate):
        seconds = time_control.now - self.last_update
        if seconds <= 0:
            return self.scale
        increment = (
            Ray.from_value(seconds)
            * interest_rate.to_ray()
            // Ray.from_value(SECONDS_IN_YEAR)
        )
        return self.scale * (Ray(RAY) + increment)

    def get_scaled_amount(self, interest_rate):
        if self.amount == 0:
            return self.amount
        return (self.amount.to_ray() * self._get_scale(interest_rate)).to_wad()

    def add(self, scaled_amount, interest_rate):
        self._update_scale(interest_rate)
        self.amount += (scaled_amount.to_ray() // self.scale).to_wad()

    def sub(self, scaled_amount, interest_rate):
        self._update_scale(interest_rate)
        self.amount = (
            (self.get_scaled_amount(interest_rate) - scaled_amount).to_ray()
            // self.scale
        ).to_wad()


class EToken(ReserveMixin, ERC20Token):
    MIN_SCALE = _R("0.0000000001")  # 1e-10
    policy_pool = ContractProxyField()
    asset_manager = ContractProxyField(default=None, allow_none=True)
    scale_factor = RayField(default=_R(1), validation_hook=non_negative)
    last_scale_update = IntField(default=time_control.now)

    scr = WadField(default=_W(0))
    scr_interest_rate = WadField(default=_W(0))
    token_interest_rate = WadField(default=_W(0))
    liquidity_requirement = WadField(default=_W(1))
    min_utilization_rate = WadField(default=_W(0))
    max_utilization_rate = WadField(default=_W(1))
    whitelist = ContractProxyField(default=None, allow_none=True)

    internal_loan_interest_rate = WadField(default=_W("0.05"))
    loans = DictField(ContractProxyField(), CompositeField(ScaledAmount), default={})

    set_attr_roles = {
        "min_utilization_rate": "LEVEL2_ROLE",
        "max_utilization_rate": "LEVEL2_ROLE",
        "liquidity_requirement": "LEVEL2_ROLE",
        "internal_loan_interest_rate": "LEVEL2_ROLE",
    }

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._running_as = "ensuro"

    def has_role(self, role, account):
        return self.policy_pool.access.has_role(role, account)

    def grant_role(self, role, user):
        """Adapter to save the roles in the access, not in this object, to simplify tests"""
        with self.policy_pool.access.as_(self.running_as):
            self.policy_pool.access.grant_role(role, user)

    @property
    def currency(self):
        return self.policy_pool.currency

    def _update_current_scale(self):
        self.scale_factor = self._calculate_current_scale()
        require(
            self.scale_factor >= self.MIN_SCALE,
            "Scale too small, can lead to rounding errors",
        )
        self.last_scale_update = time_control.now

    def _update_token_interest_rate(self):
        """Should be called each time total_supply changes or scr changes"""
        total_supply = self.total_supply()
        if total_supply:
            self.token_interest_rate = self.scr_interest_rate * self.scr // total_supply
        else:
            self.token_interest_rate = Wad(0)

    def _calculate_current_scale(self):
        seconds = time_control.now - self.last_scale_update
        if seconds <= 0:
            return self.scale_factor
        increment = (
            Ray.from_value(seconds)
            * self.token_interest_rate.to_ray()
            // Ray.from_value(SECONDS_IN_YEAR)
        )
        return self.scale_factor * (Ray(RAY) + increment)

    @contextmanager
    def thru_policy_pool(self):
        yield self

    @contextmanager
    def thru(self, address):
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
        return (
            super().total_supply().to_ray() * self._calculate_current_scale()
        ).to_wad()

    @property
    def funds_available(self):
        return max(self.total_supply() - self.scr, _W(0))

    @property
    def funds_available_to_lock(self):
        return max(self.total_supply() - self.scr, _W(0)) * self.max_utilization_rate

    @external
    def lock_scr(self, scr_amount, interest_rate):
        self._update_current_scale()
        require(
            scr_amount <= self.funds_available_to_lock,
            "Not enought funds available to cover the SCR " + self.symbol,
        )

        if self.scr == 0:
            self.scr = scr_amount
            self.scr_interest_rate = interest_rate
        else:
            orig_scr = self.scr
            self.scr += scr_amount
            self.scr_interest_rate = (
                self.scr_interest_rate * orig_scr + interest_rate * scr_amount
            ) // self.scr  # weighted average of previous and policy interest_rate
        self._update_token_interest_rate()
        self._check_balance()

    @external
    def unlock_scr(self, scr_amount, interest_rate, adjustment):
        # Pre condition: the pool needs to transfer the amount of the interests
        require(scr_amount <= self.scr, "Want to unlock more SCR than locked")
        self._update_current_scale()

        if self.scr == scr_amount:
            self.scr = Wad(0)
            self.scr_interest_rate = Wad(0)
        else:
            orig_scr = self.scr
            self.scr -= scr_amount
            self.scr_interest_rate = (
                self.scr_interest_rate * orig_scr - interest_rate * scr_amount
            ) // self.scr  # revert weighted average
        self._discrete_earning(adjustment)
        self._check_balance()

    def asset_earnings(self, amount):
        self._discrete_earning(amount)

    def _discrete_earning(self, amount):
        self._update_current_scale()
        new_total_supply = amount + self.total_supply()
        self.scale_factor = new_total_supply.to_ray() // self._base_supply().to_ray()
        require(
            self.scale_factor >= self.MIN_SCALE,
            "Scale too small, can lead to rounding errors",
        )
        self._update_token_interest_rate()

    def _check_balance(self):
        if self.asset_manager:
            return
        balance = self.currency.balance_of(self)
        require(
            balance >= self.total_supply() or (self.total_supply() - balance) < self.NEGLIGIBLE_AMOUNT,
            "Cash balance under total_supply",
        )

    @external
    def deposit(self, provider, amount):
        # Pre condition: the pool needs to transfer the amount
        require(
            self.whitelist is None
            or self.whitelist.accepts_deposit(self, provider, amount),
            "Liquidity Provider not whitelisted",
        )
        self._update_current_scale()
        scaled_amount = (amount.to_ray() // self.scale_factor).to_wad()
        self.mint(provider, scaled_amount)
        self._update_token_interest_rate()
        self._check_balance()
        require(
            self.utilization_rate >= self.min_utilization_rate,
            "Deposit rejected - Utilization Rate < min",
        )
        return self.balance_of(provider)

    def balance_of(self, provider):
        principal_balance = super().balance_of(provider)
        if not principal_balance:
            return Wad(0)
        scale_factor = self._calculate_current_scale()
        return (principal_balance.to_ray() * scale_factor).to_wad()

    def _transfer(self, sender, recipient, amount):
        require(
            self.whitelist is None
            or self.whitelist.accepts_transfer(self, sender, recipient, amount),
            "Transfer not allowed - Liquidity Provider not whitelisted",
        )
        scaled_amount = (amount.to_ray() // self._calculate_current_scale()).to_wad()
        super()._transfer(sender, recipient, scaled_amount)

    @view
    def total_withdrawable(self):
        """Returns the amount that's available to be withdrawed"""
        locked = self.scr * self.liquidity_requirement
        return max(_W(0), self.total_supply() - locked)

    @external
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

    def _max_negative_adjustment(self):
        return max(
            self.total_supply()
            - (self.MIN_SCALE * _R(10) * self._base_supply().to_ray()).to_wad(),
            _W(0),
        )

    @external
    def add_borrower(self, borrower):
        # Must be called ONLY by the PolicyPool
        borrower = ContractProxyField().adapt(borrower)
        if borrower not in self.loans:
            self.loans[borrower] = ScaledAmount()

    @external
    def internal_loan(self, borrower, amount, receiver, from_available=True):
        amount_asked = amount
        amount = amount_asked

        if from_available:
            if amount > self.funds_available:
                amount = self.funds_available
        else:
            if amount > self.total_supply():
                amount = self.total_supply()
        if amount > self._max_negative_adjustment():
            amount = self._max_negative_adjustment()
            if amount <= 0:
                return amount_asked
        loan = self.loans.get(ContractProxyField().adapt(borrower), None)
        require(loan is not None, "Borrower not registered")
        loan.add(amount, self.internal_loan_interest_rate)
        self._update_current_scale()
        self._discrete_earning(-amount)
        self._transfer_to(receiver, amount)
        self._check_balance()
        return amount_asked - amount

    @external
    def repay_loan(self, msg_sender, amount, on_behalf_of):
        borrower = on_behalf_of
        loan = self.loans.get(ContractProxyField().adapt(borrower), None)
        require(loan is not None, "Borrower not registered")
        loan.sub(amount, self.internal_loan_interest_rate)
        self._update_current_scale()
        self._discrete_earning(amount)
        self.currency.transfer_from(self, borrower, self, amount)
        self._check_balance()

    def get_loan(self, borrower):
        loan = self.loans.get(ContractProxyField().adapt(borrower), None)
        if loan is None:
            return _W(0)
        return loan.get_scaled_amount(self.internal_loan_interest_rate)

    @external
    def set_internal_loan_interest_rate(self, new_rate):
        for loan in self.loans.values():
            loan.add(_W(0), self.internal_loan_interest_rate)
        self.internal_loan_interest_rate = new_rate

    @external
    def set_max_utilization_rate(self, new_rate):
        self.max_utilization_rate = new_rate

    @external
    def set_min_utilization_rate(self, new_rate):
        self.min_utilization_rate = new_rate

    @property
    def utilization_rate(self):
        return self.scr // self.total_supply()

    @only_role("LEVEL1_ROLE", "GUARDIAN_ROLE")
    def set_whitelist(self, whitelist):
        self.whitelist = ContractProxy(whitelist.contract_id) if whitelist else None


class AccessManager(AccessControlContract):
    def grant_component_role(self, component, role, user):
        composed_role = f"{role}-{component.contract_id}"
        self.grant_role(composed_role, user)


class PremiumsAccount(ReserveMixin, AccessControlContract):
    pool = ContractProxyField()
    asset_manager = ContractProxyField(default=None, allow_none=True)
    junior_etk = ContractProxyField(allow_none=True, default=None)
    senior_etk = ContractProxyField(allow_none=True, default=None)
    active_pure_premiums = WadField(default=Wad(0))
    surplus = WadField(default=Wad(0))
    deficit_ratio = WadField(default=_W(1))

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Infinite approval for eTokens for pool loan repayment
        if self.junior_etk:
            self.currency.approve(self, self.junior_etk.contract_id, Wad(2**256 - 1))
        if self.senior_etk:
            self.currency.approve(self, self.senior_etk.contract_id, Wad(2**256 - 1))

    def has_role(self, role, account):
        return self.pool.access.has_role(role, account)

    @property
    def currency(self):
        return self.pool.currency

    @property
    def pure_premiums(self):
        return self.active_pure_premiums + self.surplus

    @property
    def borrowed_active_pp(self):
        return -self.surplus if self.surplus < 0 else Wad(0)

    @property
    def won_pure_premiums(self):
        return self.surplus if self.surplus >= 0 else Wad(0)

    @external
    @only_component_role("LEVEL2_ROLE")
    def set_deficit_ratio(self, new_ratio, adjustment):
        require(
            new_ratio <= _W(1) and new_ratio >= 0,
            "Validation: deficitRatio must be <= 1",
        )
        max_deficit = -self.active_pure_premiums * new_ratio
        if not adjustment:
            require(self.surplus >= max_deficit, "Validation: surplus must be >= maxDeficit")
            self.deficit_ratio = new_ratio
            return

        if self.surplus >= max_deficit:
            self.deficit_ratio = new_ratio
            return
        else:
            borrow = max_deficit - self.surplus
            self.surplus = max_deficit
            self.deficit_ratio = new_ratio
            self._borrow_from_etk(borrow, self, self.junior_etk is not None)

    def _store_pure_premium_won(self, pure_premium_won):
        if not pure_premium_won:
            return
        self.surplus += pure_premium_won

    def asset_earnings(self, amount):
        if amount >= 0:
            if self.senior_etk:
                amount = self._repay_loan(amount, self.senior_etk)
            if self.junior_etk:
                amount = self._repay_loan(amount, self.junior_etk)
            self._store_pure_premium_won(amount)
        else:
            left = self._pay_from_premiums(-amount)
            require(left == 0, "Return under zero not supported")

    @external
    def receive_grant(self, sender, amount):
        self.currency.transfer_from(self.contract_id, sender, self.contract_id, amount)
        self._store_pure_premium_won(amount)

    @external
    @only_component_role("WITHDRAW_WON_PREMIUMS_ROLE")
    def withdraw_won_premiums(self, amount, destination):
        s = self.surplus if self.surplus >= 0 else 0
        if amount > s:
            amount = s
        require(amount > 0, "No premiums to withdraw")
        self._pay_from_premiums(amount)
        self._transfer_to(destination, amount)
        return amount

    def _borrow_from_etk(self, borrow, receiver, jr_etk):
        if jr_etk:
            amount_left = self.junior_etk.internal_loan(
                self,
                borrow,
                receiver,
                False,  # Consume Junior Pool until exhausted
            )
        else:
            amount_left = borrow
        if amount_left > self.NEGLIGIBLE_AMOUNT:
            amount_left = self.senior_etk.internal_loan(
                self,
                amount_left,
                receiver,
                True,  # Consume Senior Pool only up to SCR
            )
            require(
                amount_left <= self.NEGLIGIBLE_AMOUNT,
                "Don't know where to take the rest of the money",
            )

    def _pay_from_premiums(self, to_pay):
        s = self.surplus - to_pay
        max_deficit = -self.active_pure_premiums * self.deficit_ratio
        if s >= max_deficit:
            self.surplus = s
            return Wad(0)
        self.surplus = max_deficit
        return -s + max_deficit

    @external
    def policy_created(self, policy):
        self.active_pure_premiums += policy.pure_premium
        if policy.sr_scr:
            self.senior_etk.lock_scr(
                policy.sr_scr, policy.sr_interest_rate
            )  # TODO take roc from RM
        if policy.jr_scr:
            self.junior_etk.lock_scr(policy.jr_scr, policy.jr_interest_rate)

    @external
    def policy_resolved_with_payout(self, customer, policy, payout):
        self.active_pure_premiums -= policy.pure_premium

        borrow_from_scr = Wad(0)
        if policy.pure_premium >= payout:
            pure_premium_won = policy.pure_premium - payout
            if self.senior_etk:
                pure_premium_won = self._repay_loan(pure_premium_won, self.senior_etk)
            if self.junior_etk:
                pure_premium_won = self._repay_loan(pure_premium_won, self.junior_etk)
            self._store_pure_premium_won(pure_premium_won)
            self._unlock_scr(policy)
        else:
            borrow_from_scr = self._pay_from_premiums(payout - policy.pure_premium)
            self._unlock_scr(policy)
            if borrow_from_scr > 0:
                self._borrow_from_etk(borrow_from_scr, customer, policy.jr_scr > Wad(0))

        self._transfer_to(customer, payout - borrow_from_scr)
        return borrow_from_scr

    def _repay_loan(self, pure_premium_won, etk):
        if pure_premium_won < self.NEGLIGIBLE_AMOUNT:
            return pure_premium_won
        borrowed_from_etk = etk.get_loan(self)
        if not borrowed_from_etk:
            return pure_premium_won
        repay_amount = min(borrowed_from_etk, pure_premium_won)

        # If not enought liquidity, it deinvests from the asset manager
        if self.currency.balance_of(self) < repay_amount:
            self.asset_manager.refill_wallet(repay_amount)

        etk.repay_loan(self, repay_amount, self)
        return pure_premium_won - repay_amount

    @external
    def policy_expired(self, policy):
        self.active_pure_premiums -= policy.pure_premium
        # Pay Ensuro and RM
        pure_premium_won = policy.pure_premium
        max_deficit = -self.active_pure_premiums * self.deficit_ratio
        if self.surplus < max_deficit:
            pure_premium_won -= -self.surplus + max_deficit
            self.surplus = max_deficit

        if self.senior_etk:
            pure_premium_won = self._repay_loan(pure_premium_won, self.senior_etk)
        if self.junior_etk:
            pure_premium_won = self._repay_loan(pure_premium_won, self.junior_etk)

        self._store_pure_premium_won(pure_premium_won)
        self._unlock_scr(policy)

    def _unlock_scr(self, policy):
        # Unlock SCR and adjust eToken
        if policy.sr_scr:
            adjustment = policy.sr_coc - policy.sr_accrued_interest()
            self.senior_etk.unlock_scr(
                policy.sr_scr, policy.sr_interest_rate, adjustment
            )

        if policy.jr_scr:
            adjustment = policy.jr_coc - policy.jr_accrued_interest()
            self.junior_etk.unlock_scr(
                policy.jr_scr, policy.jr_interest_rate, adjustment
            )

    @contextmanager
    def thru_policy_pool(self):
        yield self


class PolicyPool(ERC721Token):
    access = ContractProxyField()
    treasury = AddressField(default="ENS")
    currency = ContractProxyField()
    etokens = DictField(StringField(), ContractProxyField(), default={})
    premiums_accounts = ListField(ContractProxyField(), default=[])
    policies = DictField(IntField(), CompositeField(Policy), default={})
    risk_modules = DictField(StringField(), ContractProxyField(), default={})

    def __init__(self, *args, **kwargs):
        if "name" not in kwargs:
            kwargs["name"] = "Ensuro Policy"
        if "symbol" not in kwargs:
            kwargs["symbol"] = "EPOL"
        super().__init__(*args, **kwargs)
        self.NEGLIGIBLE_AMOUNT = Wad(10 ** (self.currency.decimals // 2))

    def has_role(self, role, account):
        return self.access.has_role(role, account)

    def add_etoken(self, etoken):
        self.etokens[etoken.name] = ContractProxy(etoken.contract_id)

    def add_risk_module(self, risk_module):
        # TODO: validate risk_module.premiums_account.pool = self.policy_pool
        self.risk_modules[risk_module.name] = ContractProxy(risk_module.contract_id)

    def add_premiums_account(self, premiums_account):
        self.premiums_accounts.append(ContractProxy(premiums_account.contract_id))
        if premiums_account.junior_etk:
            premiums_account.junior_etk.add_borrower(premiums_account)
        if premiums_account.senior_etk:
            premiums_account.senior_etk.add_borrower(premiums_account)

    @external
    def deposit(self, etoken, provider, amount):
        token = self.etokens[etoken]
        self.currency.transfer_from(
            self.contract_id, provider, token.contract_id, amount
        )
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
    def new_policy(self, policy, payer, policy_holder, internal_id):
        policy.id = policy.risk_module.make_policy_id(internal_id)
        self.mint(policy_holder, policy.id)

        assert policy.sr_interest_rate >= 0

        pa = policy.risk_module.premiums_account
        pa.policy_created(policy)

        self.policies[policy.id] = policy
        self.currency.transfer_from(self.contract_id, payer, pa, policy.pure_premium)
        policy.sr_coc and self.currency.transfer_from(
            self.contract_id, payer, pa.senior_etk, policy.sr_coc
        )
        policy.jr_coc and self.currency.transfer_from(
            self.contract_id, payer, pa.junior_etk, policy.jr_coc
        )
        self.currency.transfer_from(
            self.contract_id, payer, self.treasury, policy.ensuro_commission
        )
        if policy.partner_commission and policy.risk_module.wallet != policy_holder:
            self.currency.transfer_from(
                self.contract_id,
                payer,
                policy.risk_module.wallet,
                policy.partner_commission,
            )
        return policy.id

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

        require(
            payout == 0 or policy.expiration > time_control.now,
            "Can't pay expired policy",
        )

        if customer_won:
            policy_owner = self.owner_of(policy.id)
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
        return self.pool.access.has_role(role, account)

    @only_component_role("LP_WHITELIST_ROLE")
    def whitelist_address(self, address, whitelisted):
        self.whitelisted[address] = whitelisted

    def accepts_deposit(self, etoken, provider, amount):
        return self.whitelisted.get(provider, False)

    def accepts_transfer(self, etoken, from_, to_, amount):
        return self.whitelisted.get(to_, False)


class FixedRateVault(ERC20Token):
    """Vault following ERC4626 interface that generates returns at `interest_rate`"""

    asset = ContractProxyField()
    interest_rate = WadField(default=_W("0.05"))
    total_assets_ = CompositeField(ScaledAmount)
    broken = IntField(default=0)

    def __init__(self, **kwargs):
        if "name" not in kwargs:
            kwargs["name"] = "Test Vault"
        if "symbol" not in kwargs:
            kwargs["symbol"] = "TVAULT"
        kwargs["decimals"] = 18
        kwargs["total_assets_"] = ScaledAmount()
        super().__init__(**kwargs)

    @view
    def total_assets(self):
        require(not self.broken, "Vault it's broken")
        return self.total_assets_.get_scaled_amount(self.interest_rate)

    @view
    def convert_to_shares(self, assets):
        supply = self.total_supply()
        if supply == 0 or assets == 0:
            return Wad(
                int(assets) * (10**self.decimals) // (10**self.asset.decimals)
            )
        else:
            return Wad(int(assets) * int(supply) // int(self.total_assets()))

    @view
    def convert_to_assets(self, shares):
        supply = self.total_supply()
        if supply == 0:
            return Wad(
                int(shares) * (10**self.asset.decimals) // (10**self.decimals)
            )
        else:
            return Wad(int(shares) * self.total_assets() // int(supply))

    @external
    def deposit(self, caller, assets, receiver):
        shares = self.convert_to_shares(assets)
        self.total_assets_.add(assets, self.interest_rate)
        self.asset.transfer_from(self, caller, self, assets)
        self.mint(receiver, shares)
        return shares

    @external
    def withdraw(self, caller, assets, receiver, owner):
        require(not self.broken, "Vault it's broken")
        shares = self.convert_to_shares(assets)
        self.total_assets_.sub(assets, self.interest_rate)
        balance = self.asset.balance_of(self)
        if balance < assets:
            self.asset.mint(self.contract_id, assets - balance)
        require(caller == owner, "Only owner can withdraw for now")  # TODO: allowance
        self.burn(owner, shares)
        self.asset.transfer(self, receiver, assets)

    @external
    def discrete_earning(self, assets):
        if assets > 0:
            self.total_assets_.add(assets, self.interest_rate)
        else:
            self.total_assets_.sub(-assets, self.interest_rate)


class AssetManager(Contract):
    reserve = ContractProxyField()

    @external
    def rebalance(self):
        """Called externally to give the chance to rebalance liquid and invested money"""
        raise NotImplementedError()

    @external
    def record_earnings(self):
        """Called externally to update the reserve with the returns/losses comming from investment"""
        raise NotImplementedError()

    @external
    def checkpoint(self):
        self.record_earnings()
        self.rebalance()

    def refill_wallet(self, payment_amount):
        """
        Called from the reserve when the balance of the reserve is not enough to cover `payment_amount`
        """
        raise NotImplementedError()

    def deinvest_all(self):
        """
        Called from the reserve when the asset manager is unplugged to unwind all the investment
        """
        raise NotImplementedError()


class LiquidityThresholdAssetManager(AssetManager):
    """Asset management strategy that manages cash liquidity with thresholds"""

    liquidity_min = WadField(default=Wad(0))
    liquidity_middle = WadField(default=Wad(0))
    liquidity_max = WadField(default=Wad(0))

    # Any time balance_of(PolicyPool) < liquidity_min we refill up to liquidity_middle
    # Any time balance_of(PolicyPool) > liquidity_max take liquidity up liquidity_middle
    last_investment_value = WadField(default=Wad(0))

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._validate_params()

    def _validate_params(self):
        require(
            self.liquidity_min <= self.liquidity_middle
            and self.liquidity_middle <= self.liquidity_max,
            "Validation: Liquidity limits are invalid",
        )

    def set_liquidity_thresholds(self, liquidity_min, liquidity_middle, liquidity_max):
        if liquidity_min is not None:
            self.liquidity_min = liquidity_min
        if liquidity_middle is not None:
            self.liquidity_middle = liquidity_middle
        if liquidity_max is not None:
            self.liquidity_max = liquidity_max
        self._validate_params()

    def record_earnings(self):
        investment_value = self.get_investment_value()
        earnings = investment_value - self.last_investment_value
        self.reserve.asset_earnings(earnings)
        self.last_investment_value = investment_value

    def get_investment_value(self):
        """Returns the value in `reserve.currency` of the assets invested"""
        raise NotImplementedError()

    def rebalance(self):
        cash = self.reserve.currency.balance_of(self.reserve)

        if cash > self.liquidity_max:
            self._invest(cash - self.liquidity_middle)
        elif cash < self.liquidity_min:
            deinvest_amount = min(
                self.liquidity_middle - cash, self.get_investment_value()
            )
            if deinvest_amount > 0:
                self._deinvest(deinvest_amount)
        # else:
        # pool_cash between [self.liquidity_min, self.liquidity_max]
        # No need to transfer

    def refill_wallet(self, payment_amount):
        cash = self.reserve.currency.balance_of(self.reserve)
        investment_value = self.get_investment_value()
        # try to leave the pool balance at liquidity_middle after the payment
        deinvest = payment_amount + self.liquidity_middle - cash
        if deinvest > investment_value:
            deinvest = investment_value

        self._deinvest(deinvest)

    def _invest(self, amount):
        self.last_investment_value += amount
        # Must be reimplemented and do the actual cash movement

    def _deinvest(self, amount):
        self.last_investment_value -= amount
        # Must be reimplemented and do the actual cash movement

    def deinvest_all(self):
        self._deinvest(self.get_investment_value())


class ERC4626AssetManager(LiquidityThresholdAssetManager):
    vault = ContractProxyField()

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        assert self.vault.asset.contract_id == self.reserve.currency.contract_id
        self.reserve.currency.approve(self.reserve, self.vault, Wad(2**256 - 1))

    def _invest(self, amount):
        super()._invest(amount)
        self.vault.deposit(self.reserve, amount, self.reserve)

    def _deinvest(self, amount):
        super()._deinvest(amount)
        self.vault.withdraw(self.reserve, amount, self.reserve, self.reserve)

    def get_investment_value(self):
        return self.vault.convert_to_assets(self.vault.balance_of(self.reserve))
