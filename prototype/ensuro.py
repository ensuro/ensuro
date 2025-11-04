import time
from collections import namedtuple
from contextlib import contextmanager
from hashlib import md5

from ethproto.contracts import (
    AccessControlContract,
    AddressField,
    Contract,
    ContractProxy,
    ContractProxyField,
    ERC20Token,
    ERC721Token,
    RevertCustomError,
    WadField,
    external,
    require,
    view,
)
from ethproto.wadray import _W, Wad
from m9g import Model
from m9g.fields import (
    CompositeField,
    DictField,
    IntField,
    ListField,
    StringField,
    TupleField,
)

DAYS_PER_YEAR = 365
HOURS_PER_DAY = 24
SECONDS_IN_HOUR = 3600
SECONDS_IN_YEAR = 365 * 24 * SECONDS_IN_HOUR
MAX_UINT = 2**256 - 1

PremiumComposition = namedtuple(
    "PremiumComposition",
    ["pure_premium", "ensuro_commission", "jr_coc", "sr_coc", "total"],
)


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


class BucketParams(Model):
    moc = WadField(default=_W(1))
    jr_coll_ratio = WadField(default=Wad(0))
    coll_ratio = WadField(default=_W(0))
    ensuro_pp_fee = WadField(default=Wad(0))
    ensuro_coc_fee = WadField(default=Wad(0))
    jr_roc = WadField(default=Wad(0))
    sr_roc = WadField(default=Wad(0))

    def __str__(self):
        return (
            "BucketParams(moc={}, jr_coll_ratio={}, coll_ratio={}, ensuro_pp_fee={}, "
            "ensuro_coc_fee={}, jr_roc={}, sr_roc={})"
        ).format(*self.as_tuple())

    def as_tuple(self):
        return (
            self.moc,
            self.jr_coll_ratio,
            self.coll_ratio,
            self.ensuro_pp_fee,
            self.ensuro_coc_fee,
            self.jr_roc,
            self.sr_roc,
        )

    @classmethod
    def from_contract_bucket_params(cls, params: tuple):
        """Build BucketParams from the tuple returned by the contract"""
        return cls(
            moc=Wad(params[0]),
            jr_coll_ratio=Wad(params[1]),
            coll_ratio=Wad(params[2]),
            ensuro_pp_fee=Wad(params[3]),
            ensuro_coc_fee=Wad(params[4]),
            jr_roc=Wad(params[5]),
            sr_roc=Wad(params[6]),
        )

    @classmethod
    def from_rm(cls, rm):
        return cls(
            moc=rm.moc,
            jr_coll_ratio=rm.jr_coll_ratio,
            coll_ratio=rm.coll_ratio,
            ensuro_pp_fee=rm.ensuro_pp_fee,
            ensuro_coc_fee=rm.ensuro_coc_fee,
            jr_roc=rm.jr_roc,
            sr_roc=rm.sr_roc,
        )


class RiskModule(AccessControlContract):
    policy_pool = ContractProxyField()
    premiums_account = ContractProxyField()
    name = StringField(default="Dummy")
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

    def make_policy_id(self, internal_id):
        prefix = md5(self.contract_id.encode("utf-8")).hexdigest()
        return (int(prefix, 16) << 96) + internal_id

    @external
    def new_policy(self, payout, premium, loss_prob, expiration, on_behalf_of, internal_id):
        assert isinstance(loss_prob, Wad), "Loss prob MUST be wad"
        start = time_control.now
        if premium is None:
            premium = self.get_minimum_premium(payout, loss_prob, expiration)

        require(premium < payout, self._error("PremiumExceedsPayout", premium, payout))
        require(expiration > start, self._error("ExpirationMustBeInTheFuture", expiration, start))
        require(
            ((expiration - start) / SECONDS_IN_HOUR) < self.max_duration,
            self._error("PolicyExceedsMaxDuration", self.max_duration),
        )
        require(on_behalf_of is not None, self._error("InvalidCustomer", on_behalf_of))
        require(
            payout <= self.max_payout_per_policy,
            self._error("PayoutExceedsMaxPerPolicy", payout, self.max_payout_per_policy),
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

        active_exposure = self.active_exposure + policy.payout
        require(
            active_exposure <= self.exposure_limit,
            self._error("ExposureLimitExceeded", active_exposure, self.exposure_limit),
        )
        self.active_exposure = active_exposure

        policy.id = self.policy_pool.new_policy(policy, self._running_as, on_behalf_of, internal_id)
        assert policy.id > 0
        return policy

    @external
    def replace_policy(self, old_policy, payout, premium, loss_prob, expiration, payer, internal_id):
        assert isinstance(loss_prob, Wad), "Loss prob MUST be wad"
        start = old_policy.start
        require(old_policy.expiration > time_control.now, "Old policy is expired")
        if premium is None:
            premium = self.get_minimum_premium(payout, loss_prob, expiration)
        require(
            payout >= old_policy.payout
            and expiration >= old_policy.expiration
            and premium >= old_policy.premium,
            "Policy replacement must be greater or equal than old policy",
        )

        require(premium < payout, self._error("PremiumExceedsPayout", premium, payout))
        require(
            ((expiration - start) / SECONDS_IN_HOUR) < self.max_duration,
            self._error("PolicyExceedsMaxDuration", self.max_duration),
        )
        require(self._running_as == payer, "Payer must be caller")
        require(
            payout <= self.max_payout_per_policy,
            self._error("PayoutExceedsMaxPerPolicy", payout, self.max_payout_per_policy),
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

        active_exposure = self.active_exposure + policy.payout - old_policy.payout
        require(
            active_exposure <= self.exposure_limit,
            self._error("ExposureLimitExceeded", active_exposure, self.exposure_limit),
        )
        self.active_exposure = active_exposure

        policy.id = self.policy_pool.replace_policy(old_policy, policy, payer, internal_id)
        assert policy.id > 0
        return policy

    def get_minimum_premium(self, payout, loss_prob, expiration):
        return self.get_minimum_premium_composition(payout, loss_prob, expiration).total

    def get_minimum_premium_composition(self, payout, loss_prob, expiration, params: BucketParams = None):
        if params is None:
            params = BucketParams.from_rm(self)

        pure_premium = payout * loss_prob * params.moc
        jr_scr = max(payout * params.jr_coll_ratio - pure_premium, _W(0))
        sr_scr = max(payout * params.coll_ratio - pure_premium - jr_scr, _W(0))
        jr_coc = jr_scr * params.jr_roc * _W(expiration - time_control.now) // _W(SECONDS_IN_YEAR)
        sr_coc = sr_scr * params.sr_roc * _W(expiration - time_control.now) // _W(SECONDS_IN_YEAR)
        ensuro_commission = pure_premium * params.ensuro_pp_fee + (jr_coc + sr_coc) * params.ensuro_coc_fee
        total = pure_premium + ensuro_commission + jr_coc + sr_coc
        return PremiumComposition(pure_premium, ensuro_commission, jr_coc, sr_coc, total)

    @external
    def remove_policy(self, policy):
        self.active_exposure -= policy.payout

    @external
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
            self.jr_scr = self.payout * self.risk_module.jr_coll_ratio - self.pure_premium
        self.sr_scr = max(
            self.payout * self.risk_module.coll_ratio - self.pure_premium - self.jr_scr,
            _W(0),
        )
        self.sr_coc = self.sr_scr * (
            self.risk_module.sr_roc * _W(self.expiration - self.start) // _W(SECONDS_IN_YEAR)
        )
        self.jr_coc = self.jr_scr * (
            self.risk_module.jr_roc * _W(self.expiration - self.start) // _W(SECONDS_IN_YEAR)
        )
        self.ensuro_commission = (
            self.pure_premium * self.risk_module.ensuro_pp_fee
            + (self.sr_coc + self.jr_coc) * self.risk_module.ensuro_coc_fee
        )
        require(
            self.premium >= (self.pure_premium + self.jr_coc + self.sr_coc + self.ensuro_commission),
            RevertCustomError(
                "PremiumLessThanMinimum",
                self.premium,
                self.pure_premium + self.jr_coc + self.sr_coc + self.ensuro_commission,
            ),
        )
        self.partner_commission = (
            self.premium - self.pure_premium - self.jr_coc - self.sr_coc - self.ensuro_commission
        )

    @property
    def sr_interest_rate(self):
        return self.sr_coc * _W(SECONDS_IN_YEAR) // (_W(self.expiration - self.start) * self.sr_scr)

    @property
    def jr_interest_rate(self):
        return self.jr_coc * _W(SECONDS_IN_YEAR) // (_W(self.expiration - self.start) * self.jr_scr)

    def sr_accrued_interest(self):
        return self.sr_scr * _W(time_control.now - self.start) * self.sr_interest_rate // _W(SECONDS_IN_YEAR)

    def jr_accrued_interest(self):
        return self.jr_scr * _W(time_control.now - self.start) * self.jr_interest_rate // _W(SECONDS_IN_YEAR)


def non_negative(value):
    if value < 0:
        raise ValueError("Not allowed negative")


class ReserveMixin:
    def set_yield_vault(self, yield_vault, force):
        raise NotImplementedError()

    def _transfer_to(self, target, amount):
        require(target != 0, "Reserve: transfer to the zero address")
        if amount == _W(0):
            return
        return self.currency.transfer(self.contract_id, target, amount)

    def yield_earnings(self, amount):
        """Called from the asset_manager to record the earnings - Must be implemented"""
        raise NotImplementedError()


class ScaledAmount(Model):
    amount = WadField(default=_W(0))
    scale = WadField(default=_W(1))
    last_update = IntField(default=None, allow_none=True)

    def _update_scale(self, interest_rate):
        if not self.last_update:
            self.scale = _W(1)
        else:
            self.scale = self._get_scale(interest_rate)
        self.last_update = time_control.now

    def _get_scale(self, interest_rate):
        seconds = time_control.now - self.last_update
        if seconds <= 0:
            return self.scale
        increment = Wad.from_value(seconds) * interest_rate // Wad.from_value(SECONDS_IN_YEAR)
        return self.scale * (_W(1) + increment)

    def get_scaled_amount(self, interest_rate):
        if self.amount == 0:
            return self.amount
        return self.amount * self._get_scale(interest_rate)

    def add(self, scaled_amount, interest_rate):
        self._update_scale(interest_rate)
        self.amount += scaled_amount // self.scale

    def sub(self, scaled_amount, interest_rate):
        self._update_scale(interest_rate)
        self.amount = (self.get_scaled_amount(interest_rate) - scaled_amount) // self.scale


class EToken(ReserveMixin, ERC20Token):
    MIN_SCALE = _W("0.0000000001")  # 1e-10
    policy_pool = ContractProxyField()
    yield_vault = ContractProxyField(default=None, allow_none=True)
    scale_factor = WadField(default=_W(1), validation_hook=non_negative)
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

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._running_as = "ensuro"

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
        increment = Wad.from_value(seconds) * self.token_interest_rate // Wad.from_value(SECONDS_IN_YEAR)
        return self.scale_factor * (_W(1) + increment)

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
        return super().total_supply() * self._calculate_current_scale()

    # Methods following AAVE's IScaledBalanceToken, to simplify future integrations
    @view
    def scaled_total_supply(self):
        return self._base_supply()

    @view
    def get_scaled_user_balance_and_supply(self, provider):
        return (super().balance_of(provider), self._base_supply())

    @view
    def scaled_balance_of(self, provider):
        return super().balance_of(provider)

    @property
    def funds_available(self):
        return max(self.total_supply() - self.scr, _W(0))

    @property
    def funds_available_to_lock(self):
        return max(self.total_supply() * self.max_utilization_rate - self.scr, _W(0))

    @external
    def lock_scr(self, policy_id, scr_amount, interest_rate):
        self._update_current_scale()
        require(
            scr_amount <= self.funds_available_to_lock,
            self._error("NotEnoughScrFunds", scr_amount, self.funds_available_to_lock),
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
    def unlock_scr(self, policy_id, scr_amount, interest_rate, adjustment):
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

    def yield_earnings(self, amount):
        self._discrete_earning(amount)

    def _discrete_earning(self, amount):
        self._update_current_scale()
        new_total_supply = amount + self.total_supply()
        self.scale_factor = new_total_supply // self._base_supply()
        require(
            self.scale_factor >= self.MIN_SCALE,
            self._error("ScaleTooSmall", self.scale_factor),
        )
        self._update_token_interest_rate()

    def _check_balance(self):
        if hasattr(self, "_check_balance_disabled"):
            return
        balance = self.currency.balance_of(self)
        # This validation doesn't make sense in general, because if you are late to expire policies and
        # there are many policies, then this will fail (because total_supply keeps accruing interests
        # besides the CoC received in premiums). Anyway I keep the validation (only in the prototype code)
        # because it can help to find other potential issues
        require(
            balance >= self.total_supply() or (self.total_supply() - balance) < Wad(0),
            f"Cash balance under total_supply {balance} {self.total_supply()}",
        )

    @external
    def deposit(self, provider, amount):
        # Pre condition: the pool needs to transfer the amount
        require(
            self.whitelist is None or self.whitelist.accepts_deposit(self, provider, amount),
            self._error("DepositNotWhitelisted", provider, amount),
        )
        self._update_current_scale()
        scaled_amount = amount // self.scale_factor
        self.mint(provider, scaled_amount)
        self._update_token_interest_rate()
        self._check_balance()
        require(
            self.utilization_rate >= self.min_utilization_rate,
            self._error("UtilizationRateTooLow", self.utilization_rate, self.min_utilization_rate),
        )
        return self.balance_of(provider)

    def balance_of(self, provider):
        principal_balance = super().balance_of(provider)
        if not principal_balance:
            return Wad(0)
        scale_factor = self._calculate_current_scale()
        return principal_balance * scale_factor

    def _transfer(self, sender, recipient, amount):
        require(
            self.whitelist is None or self.whitelist.accepts_transfer(self, sender, recipient, amount),
            self._error("TransferNotWhitelisted", sender, recipient, amount),
        )
        scaled_amount = amount // self._calculate_current_scale()
        super()._transfer(sender, recipient, scaled_amount)

    @view
    def total_withdrawable(self):
        """Returns the amount that's available to be withdrawed"""
        locked = self.scr * self.liquidity_requirement
        return max(_W(0), self.total_supply() - locked)

    @external
    def withdraw(self, provider, amount):
        self._update_current_scale()
        max_withdraw = min(self.balance_of(provider), self.total_withdrawable())
        if amount is None:
            amount = max_withdraw
        if amount == 0:
            return Wad(0)
        require(amount <= max_withdraw, self._error("ExceedsMaxWithdraw", amount, max_withdraw))

        require(
            self.whitelist is None or self.whitelist.accepts_withdrawal(self, provider, amount),
            self._error("WithdrawalNotWhitelisted", provider, amount),
        )

        scaled_amount = amount // self.scale_factor
        self.burn(provider, scaled_amount)
        self._update_token_interest_rate()

        self._transfer_to(provider, amount)

        return amount

    @external
    def add_borrower(self, borrower):
        require(borrower is not None, self._error("InvalidBorrower", borrower))
        # Must be called ONLY by the PolicyPool
        borrower = ContractProxyField().adapt(borrower)
        if borrower not in self.loans:
            self.loans[borrower] = ScaledAmount()

    @view
    def max_negative_adjustment(self):
        return max(
            self.total_supply() - (self.MIN_SCALE * _W(10) * self._base_supply()),
            _W(0),
        )

    @external
    def internal_loan(self, borrower, amount, receiver):
        amount_asked = amount
        amount = amount_asked

        if amount > self.total_supply():
            amount = self.total_supply()
        if amount > self.max_negative_adjustment():
            amount = self.max_negative_adjustment()
            if amount <= 0:
                return amount_asked
        loan = self.loans.get(ContractProxyField().adapt(borrower), None)
        require(loan is not None, self._error("InvalidBorrower", borrower))
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
        require(loan is not None, self._error("InvalidBorrower", borrower))
        loan.sub(amount, self.internal_loan_interest_rate)
        self._update_current_scale()
        self._discrete_earning(amount)
        self.currency.transfer_from(self, borrower, self, amount)
        self._check_balance()

    def get_loan(self, borrower):
        loan = self.loans.get(ContractProxyField().adapt(borrower), None)
        require(loan is not None, self._error("InvalidBorrower", borrower))
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

    def set_whitelist(self, whitelist):
        self.whitelist = ContractProxy(whitelist.contract_id) if whitelist else None


class PremiumsAccount(ReserveMixin, AccessControlContract):
    pool = ContractProxyField()
    yield_vault = ContractProxyField(default=None, allow_none=True)
    junior_etk = ContractProxyField(allow_none=True, default=None)
    senior_etk = ContractProxyField(allow_none=True, default=None)
    active_pure_premiums = WadField(default=Wad(0))
    surplus = WadField(default=Wad(0))
    deficit_ratio = WadField(default=_W(1))
    jr_loan_limit_ = WadField(default=Wad(0))
    sr_loan_limit_ = WadField(default=Wad(0))

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

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
    def set_loan_limits(self, new_jr_loan_limit, new_sr_loan_limit):
        if new_jr_loan_limit is not None:
            self.jr_loan_limit_ = new_jr_loan_limit

        if new_sr_loan_limit is not None:
            self.sr_loan_limit_ = new_sr_loan_limit

    @property
    def jr_loan_limit(self):
        if self.jr_loan_limit_ == Wad(0):
            return Wad(MAX_UINT)
        return self.jr_loan_limit_

    @property
    def sr_loan_limit(self):
        if self.sr_loan_limit_ == Wad(0):
            return Wad(MAX_UINT)
        return self.sr_loan_limit_

    @external
    def set_deficit_ratio(self, new_ratio, adjustment):
        require(
            new_ratio <= _W(1) and new_ratio >= 0,
            self._error("InvalidDeficitRatio", new_ratio),
        )
        require(
            (int(new_ratio) // 1e14) * 1e14 == new_ratio,
            self._error("InvalidDeficitRatio", new_ratio),
        )
        max_deficit = -self.active_pure_premiums * new_ratio
        if not adjustment:
            require(
                self.surplus >= max_deficit,
                self._error("DeficitExceedsMaxDeficit", self.surplus, max_deficit),
            )
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

    def yield_earnings(self, amount):
        if amount >= 0:
            self._store_pure_premium_won(amount)
        else:
            left = self._pay_from_premiums(-amount)
            require(left == 0, "Return under zero not supported")

    @external
    def receive_grant(self, sender, amount):
        self.currency.transfer_from(self.contract_id, sender, self.contract_id, amount)
        self._store_pure_premium_won(amount)

    @external
    def withdraw_won_premiums(self, amount, destination):
        require(destination is not None, self._error("InvalidDestination", destination))
        s = self.surplus if self.surplus >= 0 else 0
        if amount is None:
            amount = s
        require(amount <= s, self._error("WithdrawExceedsSurplus", amount, self.surplus))
        self._pay_from_premiums(amount)
        self._transfer_to(destination, amount)
        return amount

    def _borrow_from_etk(self, borrow, receiver, jr_etk):
        require(receiver is not None, "PremiumsAccount: receiver cannot be the zero address")
        amount_left = borrow
        if jr_etk:
            if self.junior_etk.get_loan(self) + borrow <= self.jr_loan_limit:
                amount_left = self.junior_etk.internal_loan(self, borrow, receiver)
            elif self.junior_etk.get_loan(self) < self.jr_loan_limit:
                loan_excess = self.junior_etk.get_loan(self) + borrow - self.jr_loan_limit
                # Partial loan
                amount_left = loan_excess + self.junior_etk.internal_loan(
                    self, borrow - loan_excess, receiver
                )
        if amount_left:
            if self.senior_etk.get_loan(self) + amount_left <= self.sr_loan_limit:
                # In the senior doesn't make sense to handle partial loan
                amount_left = self.senior_etk.internal_loan(self, amount_left, receiver)
            require(
                amount_left == Wad(0),
                self._error("CannotBeBorrowed", amount_left),
            )

    def _max_deficit(self):
        return -self.active_pure_premiums * self.deficit_ratio

    def _pay_from_premiums(self, to_pay):
        s = self.surplus - to_pay
        max_deficit = self._max_deficit()
        if s >= max_deficit:
            self.surplus = s
            return Wad(0)
        self.surplus = max_deficit
        return -s + max_deficit

    @property
    @view
    def funds_available(self):
        return self.surplus - self._max_deficit()

    @external
    def repay_loans(self):
        funds_available = self.funds_available
        if funds_available and self.senior_etk:
            funds_available = self._repay_loan(funds_available, self.senior_etk)
        if self.junior_etk:
            funds_available = self._repay_loan(funds_available, self.junior_etk)
        return funds_available

    @external
    def policy_created(self, policy):
        self.active_pure_premiums += policy.pure_premium
        if policy.sr_scr:
            self.senior_etk.lock_scr(
                policy.id, policy.sr_scr, policy.sr_interest_rate
            )  # TODO take roc from RM
        if policy.jr_scr:
            self.junior_etk.lock_scr(policy.id, policy.jr_scr, policy.jr_interest_rate)

    @external
    def policy_replaced(self, old_policy, new_policy):
        if new_policy.sr_scr > 0 and old_policy.sr_scr > 0:
            require(
                new_policy.sr_interest_rate.equal(old_policy.sr_interest_rate, 4),
                "Interest rate can't change",
            )
        if new_policy.jr_scr > 0 and old_policy.jr_scr > 0:
            require(
                new_policy.jr_interest_rate.equal(old_policy.jr_interest_rate, 4),
                "Interest rate can't change",
            )
        # Supporting interest rate change is possible, but it would require complex computations.
        # If new IR > old IR, then we must adjust positivelly to accrue the interests not accrued
        # If new IR < old IR, then we must adjust negativelly to substract the interests accrued in excess
        self.active_pure_premiums += new_policy.pure_premium - old_policy.pure_premium
        if old_policy.sr_scr > 0:
            self.senior_etk.unlock_scr(old_policy.id, old_policy.sr_scr, old_policy.sr_interest_rate, Wad(0))
        if new_policy.sr_scr > 0:
            self.senior_etk.lock_scr(new_policy.id, new_policy.sr_scr, new_policy.sr_interest_rate)
        if old_policy.jr_scr > 0:
            self.junior_etk.unlock_scr(old_policy.id, old_policy.jr_scr, old_policy.jr_interest_rate, Wad(0))
        if new_policy.jr_scr > 0:
            self.junior_etk.lock_scr(new_policy.id, new_policy.jr_scr, new_policy.jr_interest_rate)

    @external
    def policy_resolved_with_payout(self, customer, policy, payout):
        self.active_pure_premiums -= policy.pure_premium
        borrow_from_scr = self._pay_from_premiums(payout - policy.pure_premium)

        if borrow_from_scr:
            self._unlock_scr(policy)
            self._borrow_from_etk(borrow_from_scr, customer, policy.jr_scr > Wad(0))
        else:
            self._unlock_scr(policy)

        self._transfer_to(customer, payout - borrow_from_scr)
        return borrow_from_scr

    def _repay_loan(self, funds_available, etk):
        if funds_available == Wad(0):
            return funds_available
        borrowed_from_etk = etk.get_loan(self)
        if not borrowed_from_etk:
            return funds_available
        repay_amount = min(borrowed_from_etk, funds_available)

        if self.currency.allowance(self, etk) < repay_amount:
            self.currency.approve(self, etk.contract_id, borrowed_from_etk)

        etk.repay_loan(self, repay_amount, self)
        self.surplus -= repay_amount
        assert self.surplus >= self._max_deficit(), "Error, this shouldn't happen"
        return funds_available - repay_amount

    @external
    def policy_expired(self, policy):
        self.active_pure_premiums -= policy.pure_premium
        self._store_pure_premium_won(policy.pure_premium)
        self._unlock_scr(policy)

    def _unlock_scr(self, policy):
        # Unlock SCR and adjust eToken
        if policy.sr_scr:
            adjustment = policy.sr_coc - policy.sr_accrued_interest()
            self.senior_etk.unlock_scr(policy.id, policy.sr_scr, policy.sr_interest_rate, adjustment)

        if policy.jr_scr:
            adjustment = policy.jr_coc - policy.jr_accrued_interest()
            self.junior_etk.unlock_scr(policy.id, policy.jr_scr, policy.jr_interest_rate, adjustment)

    @contextmanager
    def thru_policy_pool(self):
        yield self


class PolicyPool(ERC721Token):
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
    def new_policy(self, policy, payer, policy_holder, internal_id):
        policy.id = policy.risk_module.make_policy_id(internal_id)
        self.mint(policy_holder, policy.id)

        pa = policy.risk_module.premiums_account
        pa.policy_created(policy)

        self.policies[policy.id] = policy
        self.currency.transfer_from(self.contract_id, payer, pa, policy.pure_premium)
        policy.sr_coc and self.currency.transfer_from(self.contract_id, payer, pa.senior_etk, policy.sr_coc)
        policy.jr_coc and self.currency.transfer_from(self.contract_id, payer, pa.junior_etk, policy.jr_coc)
        self.currency.transfer_from(self.contract_id, payer, self.treasury, policy.ensuro_commission)
        if policy.partner_commission and policy.risk_module.wallet != policy_holder:
            self.currency.transfer_from(
                self.contract_id,
                payer,
                policy.risk_module.wallet,
                policy.partner_commission,
            )
        return policy.id

    @external
    def replace_policy(self, old_policy, new_policy, payer, internal_id):
        require(old_policy.id in self.policies, self._error("PolicyNotFound", old_policy.id))
        old_policy = self.policies[old_policy.id]  # To make sure is the same, in solidity check with hash
        require(new_policy.start == old_policy.start, "Both policies must have the same starting date")
        require(
            old_policy.payout <= new_policy.payout
            and old_policy.pure_premium <= new_policy.pure_premium
            and old_policy.ensuro_commission <= new_policy.ensuro_commission
            and old_policy.jr_coc <= new_policy.jr_coc
            and old_policy.sr_coc <= new_policy.sr_coc
            and old_policy.jr_scr <= new_policy.jr_scr
            and old_policy.sr_scr <= new_policy.sr_scr
            and old_policy.partner_commission <= new_policy.partner_commission
            and old_policy.expiration <= new_policy.expiration
            and old_policy.risk_module == new_policy.risk_module,
            "New policy must be greater or equal than old policy",
        )
        new_policy.id = new_policy.risk_module.make_policy_id(internal_id)
        policy_holder = self.owner_of(old_policy.id)
        self.mint(policy_holder, new_policy.id)

        pa = new_policy.risk_module.premiums_account
        pa.policy_replaced(old_policy, new_policy)

        self.policies[new_policy.id] = new_policy
        if new_policy.pure_premium > old_policy.pure_premium:
            self.currency.transfer_from(
                self.contract_id, payer, pa, new_policy.pure_premium - old_policy.pure_premium
            )
        if new_policy.sr_coc > old_policy.sr_coc:
            self.currency.transfer_from(
                self.contract_id, payer, pa.senior_etk, new_policy.sr_coc - old_policy.sr_coc
            )
        if new_policy.jr_coc > old_policy.jr_coc:
            self.currency.transfer_from(
                self.contract_id, payer, pa.junior_etk, new_policy.jr_coc - old_policy.jr_coc
            )
        if new_policy.ensuro_commission > old_policy.ensuro_commission:
            self.currency.transfer_from(
                self.contract_id,
                payer,
                self.treasury,
                new_policy.ensuro_commission - old_policy.ensuro_commission,
            )
        if (
            new_policy.partner_commission
            and new_policy.risk_module.wallet != policy_holder
            and new_policy.partner_commission > old_policy.partner_commission
        ):
            self.currency.transfer_from(
                self.contract_id,
                payer,
                new_policy.risk_module.wallet,
                new_policy.partner_commission - old_policy.partner_commission,
            )
        del self.policies[old_policy.id]
        return new_policy.id

    @external
    def expire_policy(self, policy_id):
        require(policy_id in self.policies, self._error("PolicyNotFound", policy_id))
        policy = self.policies[policy_id]
        require(
            policy.expiration <= time_control.now,
            self._error("PolicyNotExpired", policy_id, policy.expiration, time_control.now),
        )
        return self.resolve_policy(policy_id, Wad(0))

    @external
    def expire_policies(self, policy_ids):
        for policy_id in policy_ids:
            require(policy_id in self.policies, self._error("PolicyNotFound", policy_id))
            policy = self.policies[policy_id]
            require(
                policy.expiration <= time_control.now,
                self._error("PolicyNotExpired", policy_id, policy.expiration, time_control.now),
            )
            self.resolve_policy(policy_id, Wad(0))

    @external
    def resolve_policy(self, policy_id, payout):
        require(policy_id in self.policies, self._error("PolicyNotFound", policy_id))
        policy = self.policies[policy_id]
        if isinstance(payout, bool):
            payout = policy.payout if payout is True else Wad(0)

        customer_won = payout > Wad(0)

        require(
            payout == 0 or policy.expiration > time_control.now,
            self._error("PolicyAlreadyExpired", policy.id),
        )

        if customer_won:
            policy_owner = self.owner_of(policy.id)
            policy.risk_module.premiums_account.policy_resolved_with_payout(policy_owner, policy, payout)
        else:
            policy.risk_module.premiums_account.policy_expired(policy)

        policy.risk_module.remove_policy(policy)
        del self.policies[policy_id]


class LPManualWhitelist(Contract):
    pool = ContractProxyField()
    wl_status = DictField(
        AddressField(), TupleField((StringField(), StringField(), StringField(), StringField())), default={}
    )

    ST_BLACKLISTED = "blacklisted"
    ST_WHITELISTED = "whitelisted"
    ST_UNDEFINED = "undefined"

    default_status = TupleField(
        (StringField(), StringField(), StringField(), StringField()),
        default=(ST_BLACKLISTED, ST_BLACKLISTED, ST_BLACKLISTED, ST_BLACKLISTED),
    )

    OP_DEPOSIT = 0
    OP_WITHDRAW = 1
    OP_SEND_TRANSFER = 2
    OP_RECEIVE_TRANSFER = 3

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._check_defaults(self.default_status)

    def _check_defaults(self, default_status):
        require(
            all(st != self.ST_UNDEFINED for st in default_status),
            self._error("InvalidWhitelistStatus", default_status),
        )

    def whitelist_address(self, address, whitelisted):
        self.wl_status[address] = whitelisted

    def set_whitelist_defaults(self, new_defaults):
        self._check_defaults(new_defaults)
        self.default_status = new_defaults

    def get_whitelist_defaults(self):
        return self.default_status

    def _get_status(self, provider, operation):
        status = self.wl_status.get(provider, self.default_status)[operation]
        if status == self.ST_UNDEFINED:
            status = self.default_status[operation]
        return status

    def accepts_deposit(self, etoken, provider, amount):
        return self._get_status(provider, self.OP_DEPOSIT) == self.ST_WHITELISTED

    def accepts_withdrawal(self, etoken, provider, amount):
        return self._get_status(provider, self.OP_WITHDRAW) == self.ST_WHITELISTED

    def accepts_transfer(self, etoken, from_, to_, amount):
        return (
            self._get_status(from_, self.OP_SEND_TRANSFER) == self.ST_WHITELISTED
            and self._get_status(to_, self.OP_RECEIVE_TRANSFER) == self.ST_WHITELISTED
        )
