from contextlib import contextmanager

from eth_abi import encode
from eth_utils import keccak
from ethproto.wadray import _W, Wad
from ethproto.wrappers import AddressBook  # noqa: F401
from ethproto.wrappers import IERC20, IERC721, ETHWrapper, MethodAdapter, get_provider

SECONDS_IN_YEAR = 365 * 24 * 3600
MAX_UINT = 2**256 - 1


def eth_call(wrapper, fn_name, *args):
    return wrapper.provider.eth_call.get_eth_function(wrapper, fn_name)(*args)


# Utility classes to adapt
class GetParam:
    def __init__(self, paramIndex):
        self.paramIndex = paramIndex

    def __call__(self, wrapper):
        return Wad(wrapper.params()[self.paramIndex])


class SetParam:
    def __init__(self, paramIndex):
        self.paramIndex = paramIndex

    def __call__(self, wrapper, value):
        return wrapper.set_param(self.paramIndex, value)


class GetProperty:
    def __init__(self, methodName):
        self.methodName = methodName

    def __call__(self, wrapper):
        return getattr(wrapper, self.methodName)


class TestCurrency(IERC20):
    eth_contract = "TestCurrency"
    __test__ = False

    def __init__(
        self,
        owner="owner",
        name="Test Currency",
        symbol="TEST",
        initial_supply=Wad(0),
        decimals=18,
    ):
        super().__init__(owner, name, symbol, initial_supply, decimals)

    mint = MethodAdapter((("recipient", "address"), ("amount", "amount")))
    burn = MethodAdapter((("recipient", "address"), ("amount", "amount")))

    @property
    def balances(self):
        return dict(
            (name, self.balance_of(name))
            for name, address in self.provider.address_book.name_to_address.items()
        )


def _adapt_signed_amount(args, kwargs):
    amount = args[0] if args else kwargs["amount"]
    if amount > 0:
        return (amount, True), {}
    else:
        return (-amount, False), {}


class ReserveMixin:
    currency = MethodAdapter((), "address", is_property=True)
    forward_to_asset_manager_ = MethodAdapter((("functionCall", "bytes"),))

    set_asset_manager = MethodAdapter((("assetManager", "address"), ("force", "bool")))
    asset_manager = MethodAdapter((), "address", is_property=True)
    checkpoint = MethodAdapter(())
    record_earnings = MethodAdapter(())
    rebalance = MethodAdapter(())

    def forward_to_asset_manager(self, method, *args, **kwargs):
        if method == "set_liquidity_thresholds":
            min, middle, max = [MAX_UINT if arg is None else arg for arg in args]
            selector = keccak(b"setLiquidityThresholds(uint256,uint256,uint256)")[:4]
            data = encode(["uint256", "uint256", "uint256"], [min, middle, max])
            return self.forward_to_asset_manager_((selector + data))
        else:
            raise NotImplementedError()


class EToken(ReserveMixin, IERC20):
    eth_contract = "EToken"
    proxy_kind = "uups"
    constructor_args = (("policy_pool", "address"),)
    initialize_args = (
        ("name", "string"),
        ("symbol", "string"),
        ("max_utilization_rate", "wad"),
        ("internal_loan_interest_rate", "wad"),
    )

    def __init__(
        self,
        name,
        symbol,
        policy_pool,
        max_utilization_rate=_W(1),
        internal_loan_interest_rate=_W("0.05"),
        owner="owner",
    ):
        internal_loan_interest_rate = _W(internal_loan_interest_rate)
        max_utilization_rate = _W(max_utilization_rate)

        super().__init__(
            owner,
            policy_pool,
            name,
            symbol,
            max_utilization_rate,
            internal_loan_interest_rate,
        )
        if isinstance(policy_pool, ETHWrapper):
            self._policy_pool = policy_pool.contract
        else:  # is just an address or raw contract - for tests
            self._policy_pool = self._get_account(policy_pool)
        self._auto_from = self._get_account("JOHNDOE")

    @contextmanager
    def thru_policy_pool(self):
        prev_contract = self.contract
        contract_factory = self.provider.get_contract_factory(self.eth_contract)
        self.contract = self.provider.build_contract(
            self._policy_pool.address, contract_factory, self.eth_contract
        )
        try:
            yield self
        finally:
            self.contract = prev_contract

    @contextmanager
    def thru(self, address):
        prev_contract = self.contract
        contract_factory = self.provider.get_contract_factory(self.eth_contract)
        self.contract = self.provider.build_contract(address, contract_factory, self.eth_contract)
        try:
            yield self
        finally:
            self.contract = prev_contract

    policy_pool = MethodAdapter((), "address", is_property=True)
    funds_available = MethodAdapter((), "amount", is_property=True)
    funds_available_to_lock = MethodAdapter((), "amount", is_property=True)
    scr = MethodAdapter((), "amount", is_property=True)
    scr_interest_rate = MethodAdapter((), "wad", is_property=True)
    token_interest_rate = MethodAdapter((), "wad", is_property=True)
    utilization_rate = MethodAdapter((), "wad", is_property=True)
    set_whitelist = MethodAdapter((("whitelist", "contract"),))

    set_param = MethodAdapter((("param", "int"), ("value", "wad")))

    liquidity_requirement_ = MethodAdapter((), "wad", is_property=True)
    min_utilization_rate_ = MethodAdapter((), "wad", is_property=True)
    max_utilization_rate_ = MethodAdapter((), "wad", is_property=True)
    internal_loan_interest_rate_ = MethodAdapter((), "wad", is_property=True)

    liquidity_requirement = property(GetProperty("liquidity_requirement_"), SetParam(0))
    min_utilization_rate = property(GetProperty("min_utilization_rate_"), SetParam(1))
    max_utilization_rate = property(GetProperty("max_utilization_rate_"), SetParam(2))
    internal_loan_interest_rate = property(GetProperty("internal_loan_interest_rate_"), SetParam(3))

    def set_min_utilization_rate(self, value):
        return self.set_param(1, value)

    def set_max_utilization_rate(self, value):
        return self.set_param(2, value)

    def set_internal_loan_interest_rate(self, value):
        return self.set_param(3, value)

    add_borrower = MethodAdapter((("borrower", "address"),))

    lock_scr = MethodAdapter(
        (
            ("scr_amount", "amount"),
            ("policy_interest_rate", "wad"),
        ),
    )

    unlock_scr = MethodAdapter(
        (
            ("scr_amount", "amount"),
            ("policy_interest_rate", "wad"),
            ("adjustment", "amount"),
        ),
    )

    deposit_ = MethodAdapter((("provider", "address"), ("amount", "amount")))

    def deposit(self, provider, amount):
        self.deposit_(provider, amount)
        return self.balance_of(provider)

    total_withdrawable = MethodAdapter((), "amount")
    withdraw_ = MethodAdapter((("provider", "address"), ("amount", "amount")))

    def withdraw(self, provider, amount):
        receipt = self.withdraw_(provider, amount)
        if "Transfer" in receipt.events:
            return Wad(receipt.events["Transfer"]["value"])
        else:
            return Wad(0)

    max_negative_adjustment = MethodAdapter((), "amount")

    internal_loan_ = MethodAdapter(
        (
            ("borrower", "msg.sender"),
            ("amount", "amount"),
            ("receiver", "address"),
        )
    )

    def internal_loan(self, borrower, amount, receiver):
        receipt = self.internal_loan_(borrower, amount, receiver)
        if "InternalLoan" in receipt.events:
            evt = receipt.events["InternalLoan"]
            return Wad(evt["amountAsked"]) - Wad(evt["value"])
        else:
            return Wad(0)

    repay_loan = MethodAdapter((("sender", "msg.sender"), ("amount", "amount"), ("on_behalf_of", "address")))

    get_loan = MethodAdapter((("borrower", "address"),), "amount")
    get_investable = MethodAdapter((), "amount")

    get_current_scale = MethodAdapter((("updated", "bool"),), "ray")

    scaled_total_supply = MethodAdapter((), "amount")
    scaled_balance_of = MethodAdapter((("provider", "address"),), "amount")
    get_scaled_user_balance_and_supply = MethodAdapter((("provider", "address"),), "(amount, amount)")

    def grant_role(self, role, user):
        # EToken doesn't haves grant_role
        policy_pool = PolicyPool.connect(self._policy_pool)
        access = policy_pool.access
        with access.as_(self._auto_from):
            return access.grant_role(role, user)

    @property
    def whitelist(self):
        if not hasattr(self, "_whitelist"):
            whitelist_address = eth_call(self, "whitelist")
            if int(whitelist_address, 16) == 0:
                self._whitelist = None
            else:
                self._whitelist = LPManualWhitelist.connect(whitelist_address)
        return self._whitelist


class Policy:
    def __init__(
        self,
        id,
        payout,
        premium,
        jr_scr,
        sr_scr,
        loss_prob,
        pure_premium,
        ensuro_commission,
        partner_commission,
        jr_coc,
        sr_coc,
        risk_module,
        start,
        expiration,
        address_book,
    ):
        self.id = id
        self._risk_module = risk_module
        self.risk_module = address_book.get_name(risk_module)
        self.payout = Wad(payout)
        self.premium = Wad(premium)
        self.jr_scr = Wad(jr_scr)
        self.sr_scr = Wad(sr_scr)
        self.loss_prob = Wad(loss_prob)
        self.start = start
        self.expiration = expiration
        self.pure_premium = Wad(pure_premium)
        self.ensuro_commission = Wad(ensuro_commission)
        self.partner_commission = Wad(partner_commission)
        self.sr_coc = Wad(sr_coc)
        self.jr_coc = Wad(jr_coc)

    @property
    def sr_interest_rate(self):
        return self.sr_coc * _W(SECONDS_IN_YEAR) // (_W(self.expiration - self.start) * self.sr_scr)

    def sr_accrued_interest(self):
        seconds = Wad.from_value(get_provider().time_control.now - self.start)
        return self.sr_scr * seconds * self.sr_interest_rate // _W(SECONDS_IN_YEAR)

    @property
    def jr_interest_rate(self):
        return self.jr_coc * _W(SECONDS_IN_YEAR) // (_W(self.expiration - self.start) * self.jr_scr)

    def jr_accrued_interest(self):
        seconds = Wad.from_value(get_provider().time_control.now - self.start)
        return self.jr_scr * seconds * self.jr_interest_rate // _W(SECONDS_IN_YEAR)

    def as_tuple(self):
        return (
            self.id,
            self.payout,
            self.premium,
            self.jr_scr,
            self.sr_scr,
            self.loss_prob,
            self.pure_premium,
            self.ensuro_commission,
            self.partner_commission,
            self.jr_coc,
            self.sr_coc,
            self._risk_module,
            self.start,
            self.expiration,
        )

    FIELDS = (
        "(int, amount, amount, amount, amount, wad, "
        "amount, amount, amount, amount, amount, address, int, int)"
    )

    @classmethod
    def from_prototype_policy(cls, policy, address_book):
        fake_rm_address = "0x7291Ba1DC551b666c49Da22dE76eC7ceEB51AeDC"
        return cls(
            policy.id,
            policy.payout,
            policy.premium,
            policy.jr_scr,
            policy.sr_scr,
            policy.loss_prob,
            policy.pure_premium,
            policy.ensuro_commission,
            policy.partner_commission,
            policy.jr_coc,
            policy.sr_coc,
            fake_rm_address,
            policy.start,
            policy.expiration,
            address_book,
        )

    @classmethod
    def from_policy_data(cls, policy_data, address_book):
        """Creates a Policy object from a PolicyData struct (see Policy.sol)"""
        return cls(
            policy_data.id,
            policy_data.payout,
            policy_data.premium,
            policy_data.jrScr,
            policy_data.srScr,
            policy_data.lossProb,
            policy_data.purePremium,
            policy_data.ensuroCommission,
            policy_data.partnerCommission,
            policy_data.jrCoc,
            policy_data.srCoc,
            policy_data.riskModule,
            policy_data.start,
            policy_data.expiration,
            address_book,
        )


class PolicyDB:
    def __init__(self):
        self._policies = {}

    def add_policy(self, pool_address, policy):
        self._policies[(pool_address, policy.id)] = policy

    def get_policy(self, pool_address, policy_id):
        return self._policies[(pool_address, policy_id)]


policy_db = PolicyDB()


class RiskModule(ETHWrapper):
    eth_contract = "IRiskModule"

    constructor_args = (
        ("pool", "address"),
        ("premiums_account", "address"),
    )
    initialize_args = (
        ("name", "string"),
        ("coll_ratio", "wad"),
        ("ensuro_pp_fee", "wad"),
        ("sr_roc", "wad"),
        ("max_payout_per_policy", "amount"),
        ("exposure_limit", "amount"),
        ("wallet", "address"),
    )

    def __init__(
        self,
        name,
        policy_pool,
        premiums_account,
        coll_ratio=_W(1),
        ensuro_pp_fee=_W(0),
        sr_roc=_W(0),
        max_payout_per_policy=_W(1000000),
        exposure_limit=_W(1000000),
        wallet="RM",
        owner="owner",
    ):
        coll_ratio = _W(coll_ratio)
        ensuro_pp_fee = _W(ensuro_pp_fee)
        sr_roc = _W(sr_roc)
        max_payout_per_policy = _W(max_payout_per_policy)
        exposure_limit = _W(exposure_limit)
        super().__init__(
            owner,
            policy_pool.contract,
            premiums_account,
            name,
            coll_ratio,
            ensuro_pp_fee,
            sr_roc,
            max_payout_per_policy,
            exposure_limit,
            wallet,
        )
        self.policy_pool = policy_pool
        self._premiums_account = premiums_account
        self._auto_from = self.owner

    name = MethodAdapter((), "string", is_property=True)

    last_tweak = MethodAdapter((), "tuple")

    params = MethodAdapter((), "tuple")
    set_param = MethodAdapter((("param", "int"), ("value", "wad")))

    moc = property(GetParam(0), SetParam(0))
    jr_coll_ratio = property(GetParam(1), SetParam(1))
    coll_ratio = property(GetParam(2), SetParam(2))
    ensuro_pp_fee = property(GetParam(3), SetParam(3))
    ensuro_coc_fee = property(GetParam(4), SetParam(4))
    jr_roc = property(GetParam(5), SetParam(5))
    sr_roc = property(GetParam(6), SetParam(6))

    max_payout_per_policy_ = MethodAdapter((), "amount", is_property=True)
    exposure_limit_ = MethodAdapter((), "amount", is_property=True)
    max_duration_ = MethodAdapter((), "int", is_property=True)

    max_payout_per_policy = property(GetProperty("max_payout_per_policy_"), SetParam(7))
    exposure_limit = property(GetProperty("exposure_limit_"), SetParam(8))
    max_duration = property(GetProperty("max_duration_"), SetParam(9))

    active_exposure = MethodAdapter((), "amount", is_property=True)
    wallet = MethodAdapter((), "address", is_property=True)
    get_minimum_premium = MethodAdapter(
        (("payout", "amount"), ("loss_prob", "wad"), ("expiration", "int")), "amount"
    )

    premiums_account_ = MethodAdapter((), "address", is_property=True)

    @property
    def premiums_account(self):
        if getattr(self, "_premiums_account", None):
            self._premiums_account = PremiumsAccount.connect(self.premiums_account_, self.owner)
        return self._premiums_account

    def new_policy(self, *args, **kwargs):
        if "premium" not in kwargs:
            kwargs["premium"] = MAX_UINT
        if "payer" not in kwargs:
            kwargs["payer"] = kwargs.get("on_behalf_of")
        receipt = self.new_policy_(*args, **kwargs)
        if "NewPolicy" in receipt.events:
            policy_data = receipt.events["NewPolicy"]["policy"]
            policy = Policy.from_policy_data(policy_data, address_book=self.provider.address_book)
            policy_db.add_policy(self.policy_pool.contract.address, policy)
            return policy
        else:
            return None

    def make_policy_id(self, internal_id):
        rm_addr = self.contract.address
        return (int(rm_addr, 16) << 96) + internal_id


class TrustfulRiskModule(RiskModule):
    eth_contract = "TrustfulRiskModule"
    proxy_kind = "uups"

    new_policy_ = MethodAdapter(
        (
            ("payout", "amount"),
            ("premium", "amount"),
            ("loss_prob", "wad"),
            ("expiration", "int"),
            ("on_behalf_of", "address"),
            ("internal_id", "int"),
        ),
        "receipt",
    )

    replace_policy_ = MethodAdapter(
        (
            ("old_policy", Policy.FIELDS),
            ("payout", "amount"),
            ("premium", "amount"),
            ("loss_prob", "wad"),
            ("expiration", "int"),
            ("payer", "msg.sender"),
            ("internal_id", "int"),
        )
    )

    resolve_policy_full_payout = MethodAdapter((("policy", Policy.FIELDS), ("customer_won", "bool")))
    resolve_policy_ = MethodAdapter((("policy", Policy.FIELDS), ("payout", "amount")))

    def resolve_policy(self, policy_id, customer_won_or_amount):
        global policy_db
        policy = policy_db.get_policy(self.policy_pool.contract.address, policy_id)
        if customer_won_or_amount is True or customer_won_or_amount is False:
            return self.resolve_policy_full_payout(policy.as_tuple(), customer_won_or_amount)
        else:
            return self.resolve_policy_(policy.as_tuple(), customer_won_or_amount)

    def replace_policy(self, *args, **kwargs):
        kwargs["old_policy"] = kwargs["old_policy"].as_tuple()
        if "premium" not in kwargs:
            kwargs["premium"] = MAX_UINT
        receipt = self.replace_policy_(*args, **kwargs)
        if "NewPolicy" in receipt.events:
            policy_data = receipt.events["NewPolicy"]["policy"]
            policy = Policy.from_policy_data(policy_data, address_book=self.provider.address_book)
            policy_db.add_policy(self.policy_pool.contract.address, policy)
            return policy
        else:
            return None


class SignedQuoteRiskModule(RiskModule):
    eth_contract = "SignedQuoteRiskModule"
    proxy_kind = "uups"

    constructor_args = (
        ("pool", "address"),
        ("premiums_account", "address"),
        ("creation_is_open", "bool"),
    )

    new_policy_ = MethodAdapter(
        (
            ("payout", "amount"),
            ("premium", "amount"),
            ("loss_prob", "wad"),
            ("expiration", "int"),
            ("on_behalf_of", "address"),
            ("policy_data", "bytes32"),
            ("quote_signature_r", "bytes32"),
            ("quote_signature_vs", "bytes32"),
            ("quote_valid_until", "int"),
        ),
        "receipt",
    )

    new_policy_paid_by_holder_ = MethodAdapter(
        (
            ("payout", "amount"),
            ("premium", "amount"),
            ("loss_prob", "wad"),
            ("expiration", "int"),
            ("on_behalf_of", "address"),
            ("policy_data", "bytes32"),
            ("quote_signature_r", "bytes32"),
            ("quote_signature_vs", "bytes32"),
            ("quote_valid_until", "int"),
        ),
        "receipt",
    )

    def __init__(
        self,
        name,
        policy_pool,
        premiums_account,
        creation_is_open,
        coll_ratio=_W(1),
        ensuro_pp_fee=_W(0),
        sr_roc=_W(0),
        max_payout_per_policy=_W(1000000),
        exposure_limit=_W(1000000),
        wallet="RM",
        owner="owner",
    ):
        # FIXME: Improve this classes design so we don't have to repeat the whole RiskModule constructor
        coll_ratio = _W(coll_ratio)
        ensuro_pp_fee = _W(ensuro_pp_fee)
        sr_roc = _W(sr_roc)
        max_payout_per_policy = _W(max_payout_per_policy)
        exposure_limit = _W(exposure_limit)
        ETHWrapper.__init__(
            self,
            owner,
            policy_pool.contract,
            premiums_account,
            creation_is_open,
            name,
            coll_ratio,
            ensuro_pp_fee,
            sr_roc,
            max_payout_per_policy,
            exposure_limit,
            wallet,
        )
        self.policy_pool = policy_pool
        self._premiums_account = premiums_account
        self._auto_from = self.owner

    def new_policy_paid_by_holder(self, *args, **kwargs):
        if "premium" not in kwargs:
            kwargs["premium"] = MAX_UINT
        if "payer" not in kwargs:
            kwargs["payer"] = kwargs.get("on_behalf_of")
        receipt = self.new_policy_paid_by_holder_(*args, **kwargs)
        if "NewPolicy" in receipt.events:
            policy_data = receipt.events["NewPolicy"]["policy"]
            policy = Policy.from_policy_data(policy_data, address_book=self.provider.address_book)
            policy_db.add_policy(self.policy_pool.contract.address, policy)
            return policy
        else:
            return None

    resolve_policy_full_payout = MethodAdapter((("policy", Policy.FIELDS), ("customer_won", "bool")))
    resolve_policy_ = MethodAdapter((("policy", Policy.FIELDS), ("payout", "amount")))

    def resolve_policy(self, policy_id, customer_won_or_amount):
        global policy_db
        policy = policy_db.get_policy(self.policy_pool.contract.address, policy_id)
        if customer_won_or_amount is True or customer_won_or_amount is False:
            return self.resolve_policy_full_payout(policy.as_tuple(), customer_won_or_amount)
        else:
            return self.resolve_policy_(policy.as_tuple(), customer_won_or_amount)


class SignedBucketRiskModule(SignedQuoteRiskModule):

    constructor_args = (
        ("pool", "address"),
        ("premiums_account", "address"),
    )

    eth_contract = "SignedBucketRiskModule"
    proxy_kind = "uups"

    set_bucket_params = MethodAdapter((("bucket_id", "wad"), ("params", "tuple")))

    delete_bucket = MethodAdapter((("bucket_id", "wad"),))

    bucket_params = MethodAdapter((("bucket_id", "wad"),), return_type="tuple")

    get_minimum_premium_for_bucket = MethodAdapter(
        (("payout", "amount"), ("loss_prob", "wad"), ("expiration", "int", "bucket_id", "wad")),
        return_type="amount",
    )

    def __init__(
        self,
        name,
        policy_pool,
        premiums_account,
        coll_ratio=_W(1),
        ensuro_pp_fee=_W(0),
        sr_roc=_W(0),
        max_payout_per_policy=_W(1000000),
        exposure_limit=_W(1000000),
        wallet="RM",
        owner="owner",
    ):
        # FIXME: Improve this classes design so we don't have to repeat the whole RiskModule constructor
        coll_ratio = _W(coll_ratio)
        ensuro_pp_fee = _W(ensuro_pp_fee)
        sr_roc = _W(sr_roc)
        max_payout_per_policy = _W(max_payout_per_policy)
        exposure_limit = _W(exposure_limit)
        ETHWrapper.__init__(
            self,
            owner,
            policy_pool.contract,
            premiums_account,
            name,
            coll_ratio,
            ensuro_pp_fee,
            sr_roc,
            max_payout_per_policy,
            exposure_limit,
            wallet,
        )
        self.policy_pool = policy_pool
        self._premiums_account = premiums_account
        self._auto_from = self.owner

    def fetch_buckets(self):
        new_bucket_events = self.provider.get_events(self, "NewBucket")
        delete_bucket_events = self.provider.get_events(self, "BucketDeleted")
        all_events = sorted(
            new_bucket_events + delete_bucket_events, key=lambda evt: (evt.blockNumber, evt.transactionIndex)
        )
        buckets = {}
        bucket_tuple_fields = (
            "moc",
            "jrCollRatio",
            "collRatio",
            "ensuroPpFee",
            "ensuroCocFee",
            "jrRoc",
            "srRoc",
        )
        for evt in all_events:
            if evt.event == "NewBucket":
                buckets[evt.args.bucketId] = tuple(evt.args.params[field] for field in bucket_tuple_fields)
            elif evt.event == "BucketDeleted":
                buckets.pop(evt.args.bucketId)

        return buckets


class AccessManager(ETHWrapper):
    eth_contract = "AccessManager"

    proxy_kind = "uups"

    initialize_args = ()

    def __init__(self, owner):
        super().__init__(owner)
        self._auto_from = self.owner

    grant_component_role = MethodAdapter(
        (("component", "address"), ("role", "keccak256"), ("user", "address"))
    )


class PolicyPool(IERC721):
    eth_contract = "PolicyPool"

    constructor_args = (("access", "address"), ("currency", "address"))
    initialize_args = (
        ("name", "string"),
        ("symbol", "string"),
        ("treasury", "address"),
    )
    proxy_kind = "uups"

    def __init__(self, access, currency, name="Ensuro Policy", symbol="EPOL", treasury="ENS"):
        self._access = access
        self._currency = currency
        super().__init__(access.owner, access.contract, currency.contract, name, symbol, treasury)
        self._auto_from = self.owner
        self._etokens = {}
        self._risk_modules = {}
        self._premiums_accounts = {}

    @property
    def currency(self):
        if hasattr(self, "_currency"):
            return self._currency
        else:
            return IERC20.connect(eth_call(self, "currency"))

    @property
    def access(self):
        if hasattr(self, "_access"):
            return self._access
        else:
            return AccessManager.connect(eth_call(self, "access"))

    @property
    def etokens(self):
        if not hasattr(self, "_etokens"):
            self._etokens = self.fetch_etokens(self)
        return self._etokens

    @classmethod
    def connect(cls, contract, owner=None):
        obj = super(PolicyPool, cls).connect(contract, owner)
        current_address = eth_call(obj, "currency")
        obj._currency = IERC20.connect(current_address)
        obj._auto_from = obj.owner
        return obj

    add_component = MethodAdapter(
        (
            ("component", "contract"),
            ("kind", "int"),
        )
    )

    @classmethod
    def fetch_etokens(cls, wrapper):
        events = wrapper.provider.get_events(wrapper, "ComponentStatusChanged")
        etokens = {}
        for evt in events:
            if evt["args"]["kind"] != 1:
                continue
            etk_address = evt["args"]["component"]
            etk = EToken.connect(etk_address)
            etk_status = evt["args"]["newStatus"]
            if etk_status == 1:  # active
                etokens[etk.name] = etk
            elif etk.name in etokens:
                etokens.pop(etk.name)
        return etokens

    def add_etoken(self, etoken):
        self.add_component(etoken, 1)
        self.etokens[etoken.name] = etoken

    def add_premiums_account(self, pa):
        self.add_component(pa, 3)

    @property
    def premiums_accounts(self):
        if not hasattr(self, "_premiums_accounts"):
            self._premiums_accounts = self.fetch_premiums_accounts(self)
        return self._premiums_accounts

    @classmethod
    def fetch_premiums_accounts(cls, wrapper):
        events = wrapper.provider.get_events(wrapper, "ComponentStatusChanged")
        premiums_accounts = {}
        for evt in events:
            if evt["args"]["kind"] != 3:
                continue
            pa_address = evt["args"]["component"]
            pa_status = evt["args"]["newStatus"]
            if pa_status == 1:  # active
                premiums_accounts[pa_address] = PremiumsAccount.connect(pa_address)
            elif pa_address in premiums_accounts:
                premiums_accounts.pop(pa_address)
        return premiums_accounts

    @property
    def risk_modules(self):
        if not hasattr(self, "_risk_modules"):
            self._risk_modules = self.fetch_riskmodules(self)
        return self._risk_modules

    @classmethod
    def fetch_riskmodules(cls, wrapper):
        events = wrapper.provider.get_events(wrapper, "ComponentStatusChanged")
        risk_modules = {}
        for evt in events:
            if evt["args"]["kind"] != 2:
                continue
            rm_address = evt["args"]["component"]
            rm_status = evt["args"]["newStatus"]
            if rm_status == 1:  # active
                risk_modules[rm_address] = RiskModule.connect(rm_address)
            elif rm_address in risk_modules:
                risk_modules.pop(rm_address)
        return risk_modules

    def add_risk_module(self, risk_module):
        self.add_component(risk_module, 2)
        self._risk_modules[risk_module.name] = risk_module

    deposit_ = MethodAdapter((("etoken", "contract"), ("provider", "msg.sender"), ("amount", "amount")))

    def deposit(self, etoken_name, provider, amount):
        etoken = self.etokens[etoken_name]
        self.deposit_(etoken, provider, amount)
        return etoken.balance_of(provider)

    withdraw_ = MethodAdapter((("etoken", "contract"), ("provider", "msg.sender"), ("amount", "amount")))

    def withdraw(self, etoken_name, provider, amount):
        etoken = self.etokens[etoken_name]
        receipt = self.withdraw_(etoken, provider, amount)
        if "Transfer" in receipt.events:
            return Wad(receipt.events["Transfer"]["value"])
        else:
            return Wad(0)

    def get_policy(self, policy_id):
        policy_data = eth_call(self, "getPolicy", policy_id)
        if policy_data:
            return Policy.from_policy_data(policy_data, self.provider.address_book)

    get_policy_fund_count = MethodAdapter((("policy_id", "int"),), "int")
    get_policy_fund = MethodAdapter((("policy_id", "int"), ("etoken", "contract")), "amount")
    get_investable = MethodAdapter((), "amount")

    expire_policy_ = MethodAdapter((("policy", "tuple"),))
    expire_policies_ = MethodAdapter((("policies", "list"),))

    def expire_policy(self, policy_id):
        if isinstance(policy_id, tuple):
            return self.expire_policy_(policy_id)
        global policy_db
        policy = policy_db.get_policy(self.contract.address, policy_id)
        return self.expire_policy_(policy.as_tuple())

    def expire_policies(self, policies):
        assert policies, "Empty list not accepted"
        if isinstance(policies[0], tuple):
            return self.expire_policies(policies)
        global policy_db
        policies = [
            policy_db.get_policy(self.contract.address, policy_id).as_tuple() for policy_id in policies
        ]
        return self.expire_policies_(policies)


class PremiumsAccount(ReserveMixin, ETHWrapper):
    eth_contract = "PremiumsAccount"

    constructor_args = (
        ("pool", "address"),
        ("junior_etk", "address"),
        ("senior_etk", "address"),
    )
    initialize_args = ()
    proxy_kind = "uups"

    def __init__(self, pool, junior_etk=None, senior_etk=None, ratio=_W(1), owner="owner"):
        ratio = _W(ratio)
        super().__init__(
            owner,
            pool,
            junior_etk and junior_etk.contract,
            senior_etk and senior_etk.contract,
        )
        if isinstance(pool, ETHWrapper):
            self._policy_pool = pool.contract
        else:  # is just an address or raw contract - for tests
            self._policy_pool = self._get_account(pool)

    junior_etk = MethodAdapter((), "address", is_property=True)
    senior_etk = MethodAdapter((), "address", is_property=True)
    pure_premiums = MethodAdapter((), "amount", is_property=True)
    funds_available = MethodAdapter((), "amount", is_property=True)
    surplus = MethodAdapter((), "amount", is_property=True)
    won_pure_premiums = MethodAdapter((), "amount", is_property=True)
    active_pure_premiums = MethodAdapter((), "amount", is_property=True)
    deficit_ratio = MethodAdapter((), "wad", is_property=True)

    borrowed_active_pp = MethodAdapter((), "amount", is_property=True, eth_method="borrowedActivePP")

    withdraw_won_premiums_ = MethodAdapter((("amount", "amount"), ("destination", "address")))
    policy_created_ = MethodAdapter((("policy", "tuple"),))
    policy_expired_ = MethodAdapter((("policy", "tuple"),))
    set_deficit_ratio = MethodAdapter((("new_ratio", "wad"), ("adjustment", "bool")))
    set_loan_limits = MethodAdapter((("new_jr_loan_limit", "amount"), ("new_sr_loan_limit", "amount")))

    jr_loan_limit = MethodAdapter((), "amount", is_property=True)
    sr_loan_limit = MethodAdapter((), "amount", is_property=True)

    policy_resolved_with_payout_ = MethodAdapter(
        (("customer", "address"), ("policy", "tuple"), ("payout", "amount"))
    )

    def withdraw_won_premiums(self, amount, destination):
        receipt = self.withdraw_won_premiums_(amount, destination)
        if "WonPremiumsInOut" in receipt.events:
            return Wad(receipt.events["WonPremiumsInOut"]["value"])
        else:
            return Wad(0)

    receive_grant = MethodAdapter((("sender", "msg.sender"), ("amount", "amount")))
    repay_loans = MethodAdapter(())

    def policy_created(self, policy):
        p = Policy.from_prototype_policy(policy, self.provider.address_book)
        return self.policy_created_(p.as_tuple())

    def policy_expired(self, policy):
        p = Policy.from_prototype_policy(policy, self.provider.address_book)
        return self.policy_expired_(p.as_tuple())

    def policy_resolved_with_payout(self, customer, policy, payout):
        p = Policy.from_prototype_policy(policy, self.provider.address_book)
        return self.policy_resolved_with_payout_(customer, p.as_tuple(), payout)

    @contextmanager
    def thru_policy_pool(self):
        prev_contract = self.contract
        contract_factory = self.provider.get_contract_factory(self.eth_contract)
        self.contract = self.provider.build_contract(
            self._policy_pool.address, contract_factory, self.eth_contract
        )
        try:
            yield self
        finally:
            self.contract = prev_contract


class Exchange(ETHWrapper):
    eth_contract = "Exchange"
    proxy_kind = "uups"

    constructor_args = (("pool", "address"),)
    initialize_args = (
        ("oracle", "address"),
        ("swap_router", "address"),
        ("max_slippage", "wad"),
    )

    max_slippage = MethodAdapter((), "wad", is_property=True)

    def __init__(self, owner, pool, oracle, swap_router, max_slippage=_W("0.01")):
        max_slippage = _W(max_slippage)
        super(Exchange, self).__init__(
            owner,
            pool,  # constructor_args
            oracle,
            swap_router,
            max_slippage,
        )
        if isinstance(pool, ETHWrapper):
            self._policy_pool = pool.contract
        else:  # is just an address or raw contract - for tests
            self._policy_pool = self._get_account(pool)

        self._auto_from = self.owner


class LPManualWhitelist(ETHWrapper):
    eth_contract = "LPManualWhitelist"
    proxy_kind = "uups"

    initialize_args = (("default_status", "tuple"),)
    constructor_args = (("pool", "address"),)

    ST_BLACKLISTED = 2
    ST_WHITELISTED = 1
    ST_UNDEFINED = 0

    def __init__(self, pool, default_status=(ST_BLACKLISTED,) * 4):
        super().__init__("owner", pool.contract, default_status)

    whitelist_address = MethodAdapter(
        (("address", "address"), ("whitelisted", "bool")),
    )

    get_whitelist_defaults = MethodAdapter((), "tuple")

    set_whitelist_defaults = MethodAdapter((("new_status", "tuple"),))


ERC20Token = TestCurrency


class FixedRateVault(IERC20):
    eth_contract = "FixedRateVault"

    constructor_args = (
        ("name", "string"),
        ("symbol", "string"),
        ("asset", "address"),
        ("interest_rate", "wad"),
    )

    def __init__(
        self,
        asset,
        owner="owner",
        name="Test Vault",
        symbol="TVAULT",
        interest_rate=_W("0.05"),
    ):
        interest_rate = _W(interest_rate)
        super().__init__(owner, name, symbol, asset, interest_rate)

    total_assets = MethodAdapter((), "amount")
    convert_to_assets = MethodAdapter((("shares", "wad"),), "amount")
    convert_to_shares = MethodAdapter((("assets", "amount"),), "wad")
    deposit = MethodAdapter(
        (
            ("caller", "msg.sender"),
            ("assets", "amount"),
            ("receiver", "address"),
        )
    )
    withdraw = MethodAdapter(
        (
            ("caller", "msg.sender"),
            ("assets", "amount"),
            ("receiver", "address"),
            ("owner", "address"),
        )
    )
    discrete_earning = MethodAdapter((("assets", "amount"),))
    broken = MethodAdapter((), "bool", is_property=True)


class LiquidityThresholdAssetManager(ETHWrapper):
    def _set_liquidity(self, reserve, liquidity_min, liquidity_middle, liquidity_max):
        liquidity_min = liquidity_min if liquidity_min is None else _W(liquidity_min)
        liquidity_middle = liquidity_middle if liquidity_middle is None else _W(liquidity_middle)
        liquidity_max = liquidity_max if liquidity_max is None else _W(liquidity_max)
        reserve.forward_to_asset_manager(
            "set_liquidity_thresholds", liquidity_min, liquidity_middle, liquidity_max
        )


class ERC4626AssetManager(LiquidityThresholdAssetManager):
    eth_contract = "ERC4626AssetManager"

    constructor_args = (
        ("asset", "address"),
        ("vault", "address"),
    )

    def __init__(self, reserve, vault):
        super().__init__(reserve.owner, reserve.currency, vault)
