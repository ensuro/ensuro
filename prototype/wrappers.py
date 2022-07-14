from collections import namedtuple
from contextlib import contextmanager
from ethproto.wadray import Wad, _R, Ray, _W
from ethproto.wrappers import AddressBook, IERC20, IERC721, ETHWrapper, MethodAdapter, get_provider


SECONDS_IN_YEAR = 365 * 24 * 3600


def eth_call(wrapper, fn_name, *args):
    return wrapper.provider.eth_call.get_eth_function(wrapper, fn_name)(*args)


class TestCurrency(IERC20):
    eth_contract = "TestCurrency"
    __test__ = False

    def __init__(self, owner="owner", name="Test Currency", symbol="TEST", initial_supply=Wad(0),
                 decimals=18):
        super().__init__(owner, name, symbol, initial_supply, decimals)

    mint = MethodAdapter((("recipient", "address"), ("amount", "amount")))
    burn = MethodAdapter((("recipient", "address"), ("amount", "amount")))

    @property
    def balances(self):
        return dict(
            (name, self.balance_of(name))
            for name, address in self.provider.address_book.name_to_address.items()
        )


class TestNFT(IERC721):
    __test__ = False

    eth_contract = "TestNFT"

    def __init__(self, owner="Owner", name="Test NFT", symbol="NFTEST"):
        super().__init__(owner, name, symbol)

    mint = MethodAdapter((("to", "address"), ("token_id", "int")))
    burn = MethodAdapter((("owner", "msg.sender"), ("token_id", "int")))


class PolicyNFT(IERC721):
    eth_contract = "PolicyNFT"
    proxy_kind = "uups"

    initialize_args = (
        ("name", "string"), ("symbol", "string"), ("policy_pool", "address"),
    )

    def __init__(self, owner="Owner", name="Test NFT", symbol="NFTEST"):
        super().__init__(owner, name, symbol, AddressBook.ZERO)

    safe_transfer_from = MethodAdapter((
        ("spender", "msg.sender"), ("from", "address"), ("to", "address"), ("token_id", "int")
    ), "receipt", eth_variant="address, address, uint256")


def _adapt_signed_amount(args, kwargs):
    amount = args[0] if args else kwargs["amount"]
    if amount > 0:
        return (amount, True), {}
    else:
        return (-amount, False), {}


class EToken(IERC20):
    eth_contract = "EToken"
    proxy_kind = "uups"
    constructor_args = (("policy_pool", "address"), )
    initialize_args = (
        ("name", "string"), ("symbol", "string"), ("expiration_period", "int"),
        ("liquidity_requirement", "ray"), ("max_utilization_rate", "ray"),
        ("pool_loan_interest_rate", "ray"),
    )

    def __init__(self, name, symbol, policy_pool, expiration_period, liquidity_requirement=_R(1),
                 max_utilization_rate=_R(1),
                 pool_loan_interest_rate=_R("0.05"), owner="owner"):
        pool_loan_interest_rate = _R(pool_loan_interest_rate)
        liquidity_requirement = _R(liquidity_requirement)
        max_utilization_rate = _R(max_utilization_rate)

        super().__init__(
            owner, policy_pool,
            name, symbol, expiration_period, liquidity_requirement,
            max_utilization_rate, pool_loan_interest_rate
        )
        if isinstance(policy_pool, ETHWrapper):
            self._policy_pool = policy_pool.contract
        else:  # is just an address or raw contract - for tests
            self._policy_pool = self._get_account(policy_pool)
        self._auto_from = self._get_account("johhdoe")

    @contextmanager
    def thru_policy_pool(self):
        prev_contract = self.contract
        contract_factory = self.provider.get_contract_factory(self.eth_contract)
        self.contract = self.provider.build_contract(self._policy_pool, contract_factory, self.eth_contract)
        try:
            yield self
        finally:
            self.contract = prev_contract

    ocean = MethodAdapter((), "amount", is_property=True)
    ocean_for_new_scr = MethodAdapter((), "amount", is_property=True)
    scr = MethodAdapter((), "amount", is_property=True)
    scr_interest_rate = MethodAdapter((), "ray", is_property=True)
    token_interest_rate = MethodAdapter((), "ray", is_property=True)
    pool_loan_interest_rate = MethodAdapter((), "ray", is_property=True)
    liquidity_requirement = MethodAdapter((), "ray", is_property=True)
    max_utilization_rate = MethodAdapter((), "ray", is_property=True)
    utilization_rate = MethodAdapter((), "ray", is_property=True)
    set_pool_loan_interest_rate = MethodAdapter((("new_rate", "ray"), ))
    set_max_utilization_rate = MethodAdapter((("new_rate", "ray"), ))

    accept_all_rms = MethodAdapter((), "bool", is_property=True, eth_method="acceptAllRMs")

    is_accept_exception = MethodAdapter((("risk_module", "address"),), "bool")
    set_accept_exception = MethodAdapter((("risk_module", "address"), ("is_exception", "bool")))

    lock_scr = MethodAdapter(
        (("policy_interest_rate", "ray"), ("scr_amount", "amount")),
        adapt_args=lambda args, kwargs: ((), {
            "policy_interest_rate": (args[0] if args else kwargs["policy"]).interest_rate,
            "scr_amount": args[1] if len(args) > 1 else kwargs["scr_amount"],
        })
    )

    unlock_scr = MethodAdapter(
        (("policy_interest_rate", "ray"), ("scr_amount", "amount"), ("adjustment", "amount")),
        adapt_args=lambda args, kwargs: ([], {
            "policy_interest_rate": (args[0] if args else kwargs["policy"]).interest_rate,
            "scr_amount": args[1] if len(args) > 1 else kwargs["scr_amount"],
            "adjustment": args[2] if len(args) > 2 else kwargs["adjustment"],
        })
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

    accepts = MethodAdapter(
        (("risk_module", "address"), ("policy_expiration", "int")), "bool",
        adapt_args=lambda args, kwargs: ((None, args[0].expiration, ), {})
    )

    lend_to_pool_ = MethodAdapter((("amount", "amount"), ("receiver", "address"), ("from_ocean", "bool")))

    def lend_to_pool(self, amount, receiver, from_ocean=True):
        receipt = self.lend_to_pool_(amount, receiver, from_ocean)
        if "PoolLoan" in receipt.events:
            evt = receipt.events["PoolLoan"]
            return Wad(evt["amountAsked"]) - Wad(evt["value"])
        else:
            return Wad(0)

    repay_pool_loan = MethodAdapter((("amount", "amount"), ))
    get_pool_loan = MethodAdapter((), "amount")
    get_investable = MethodAdapter((), "amount")

    get_current_scale = MethodAdapter((("updated", "bool"), ), "ray")

    def grant_role(self, role, user):
        # EToken doesn't haves grant_role
        policy_pool = PolicyPool.connect(self._policy_pool)
        config = policy_pool.config
        with config.as_(self._auto_from):
            return config.grant_role(role, user)


class Policy:

    def __init__(self, id, payout, premium, scr, loss_prob,
                 pure_premium, ensuro_commission, premium_for_rm, coc,
                 risk_module, start, expiration, address_book):
        self.id = id
        self._risk_module = risk_module
        self.risk_module = address_book.get_name(risk_module)
        self.payout = Wad(payout)
        self.premium = Wad(premium)
        self.scr = Wad(scr)
        self.loss_prob = Ray(loss_prob)
        self.start = start
        self.expiration = expiration
        self.pure_premium = Wad(pure_premium)
        self.ensuro_commission = Wad(ensuro_commission)
        self.premium_for_rm = Wad(premium_for_rm)
        self.coc = Wad(coc)

    def premium_split(self):
        return self.pure_premium, self.ensuro_commission, self.premium_for_rm, self.coc

    @property
    def interest_rate(self):
        return (
            self.coc * _W(SECONDS_IN_YEAR) // (
                _W(self.expiration - self.start) * self.scr
            )
        ).to_ray()

    def accrued_interest(self):
        seconds = Ray.from_value(get_provider().time_control.now - self.start)
        return (
            self.scr.to_ray() * seconds * self.interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        ).to_wad()

    def as_tuple(self):
        return (
            self.id, self.payout, self.premium, self.scr, self.loss_prob,
            self.pure_premium, self.ensuro_commission, self.premium_for_rm, self.coc,
            self._risk_module, self.start, self.expiration
        )

    FIELDS = "(int, amount, amount, amount, ray, amount, amount, amount, amount, address, int, int)"


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

    constructor_args = (("pool", "address"), ("premiums_account", "address"), )
    initialize_args = (
        ("name", "string"), ("coll_ratio", "ray"), ("ensuro_fee", "ray"),
        ("roc", "ray"), ("max_payout_per_policy", "amount"), ("exposure_limit", "amount"),
        ("wallet", "address")
    )

    def __init__(self, name, policy_pool, premiums_account, coll_ratio=_R(1), ensuro_fee=_R(0),
                 roc=_R(0), max_payout_per_policy=_W(1000000), exposure_limit=_W(1000000),
                 wallet="RM", owner="owner"):
        coll_ratio = _R(coll_ratio)
        ensuro_fee = _R(ensuro_fee)
        roc = _R(roc)
        max_payout_per_policy = _W(max_payout_per_policy)
        exposure_limit = _W(exposure_limit)
        super().__init__(owner, policy_pool.contract, premiums_account, name, coll_ratio, ensuro_fee,
                         roc,
                         max_payout_per_policy, exposure_limit, wallet)
        self.policy_pool = policy_pool
        self._premiums_account = premiums_account
        self._auto_from = self.owner

    name = MethodAdapter((), "string", is_property=True)
    coll_ratio = MethodAdapter((), "ray", is_property=True)
    moc = MethodAdapter((), "ray", is_property=True)
    ensuro_fee = MethodAdapter((), "ray", is_property=True)
    roc = MethodAdapter((), "ray", is_property=True)
    max_payout_per_policy = MethodAdapter((), "amount", is_property=True)
    exposure_limit = MethodAdapter((), "amount", is_property=True)
    active_exposure = MethodAdapter((), "amount", is_property=True)
    wallet = MethodAdapter((), "address", is_property=True)
    get_minimum_premium = MethodAdapter(
        (("payout", "amount"), ("loss_prob", "ray"), ("expiration", "int")),
        "amount"
    )

    premiums_account_ = MethodAdapter((), "address", is_property=True)

    @property
    def premiums_account(self):
        if getattr(self, "_premiums_account", None):
            self._premiums_account = PremiumsAccount.connect(self.premiums_account_, self.owner)
        return self._premiums_account

    def new_policy(self, *args, **kwargs):
        receipt = self.new_policy_(*args, **kwargs)
        if "NewPolicy" in receipt.events:
            policy_data = receipt.events["NewPolicy"]["policy"]
            policy = Policy(*policy_data, address_book=self.provider.address_book)
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

    new_policy_ = MethodAdapter((
        ("payout", "amount"), ("premium", "amount"), ("loss_prob", "ray"), ("expiration", "int"),
        ("customer", "address"), ("internal_id", "int"),
    ), "receipt")

    resolve_policy_full_payout = MethodAdapter((("policy", Policy.FIELDS), ("customer_won", "bool")))
    resolve_policy_ = MethodAdapter((("policy", Policy.FIELDS), ("payout", "amount")))

    def resolve_policy(self, policy_id, customer_won_or_amount):
        global policy_db
        policy = policy_db.get_policy(self.policy_pool.contract.address, policy_id)
        if customer_won_or_amount is True or customer_won_or_amount is False:
            return self.resolve_policy_full_payout(policy.as_tuple(),  customer_won_or_amount)
        else:
            return self.resolve_policy_(policy.as_tuple(), customer_won_or_amount)


class FlightDelayRiskModule(RiskModule):
    eth_contract = "FlightDelayRiskModule"
    proxy_kind = "uups"

    initialize_args = RiskModule.initialize_args + (
        ("linkToken", "address"), ("oracleParams", "(address, int, amount, bytes16, bytes16)")
    )

    new_policy_ = MethodAdapter((
        ("flight", "string"), ("departure", "int"), ("expectedArrival", "int"), ("tolerance", "int"),
        ("payout", "amount"), ("premium", "amount"), ("loss_prob", "ray"), ("customer", "address"),
        ("internal_id", "int"),
    ), "receipt")

    resolve_policy = MethodAdapter((("policy_id", "int"), ))

    OracleParams = namedtuple("OracleParams", "oracle delay_time fee data_job_id sleep_job_id")

    oracle_params = MethodAdapter((), "(address, int, amount, bytes16, bytes16)", is_property=True)

    def __init__(self, name, policy_pool, premiums_account, coll_ratio=_R(1), ensuro_fee=_R(0),
                 roc=_R(0), max_payout_per_policy=_W(1000000), exposure_limit=_W(1000000),
                 wallet="RM", owner="owner",
                 link_token=None, oracle_params=None):
        coll_ratio = _R(coll_ratio)
        ensuro_fee = _R(ensuro_fee)
        roc = _R(roc)
        max_payout_per_policy = _W(max_payout_per_policy)
        exposure_limit = _W(exposure_limit)
        super(RiskModule, self).__init__(
            owner, policy_pool.contract, premiums_account, name, coll_ratio, ensuro_fee,
            roc,
            max_payout_per_policy, exposure_limit, wallet,
            link_token, oracle_params
        )
        self.policy_pool = policy_pool
        self._auto_from = self.owner


class PolicyPoolConfig(ETHWrapper):
    eth_contract = "PolicyPoolConfig"

    proxy_kind = "uups"

    initialize_args = (("policy_pool", "address"), ("treasury", "address"))

    def __init__(self, owner, treasury="ENS"):
        super().__init__(owner, AddressBook.ZERO, treasury)
        self._auto_from = self.owner
        self._risk_modules = {}

    @property
    def risk_modules(self):
        if not hasattr(self, "_risk_modules"):
            self._risk_modules = self.fetch_riskmodules(self)
        return self._risk_modules

    @classmethod
    def fetch_riskmodules(cls, wrapper):
        events = wrapper.provider.get_events(wrapper, "RiskModuleStatusChanged")
        risk_modules = {}
        for evt in events:
            rm_address = evt["args"]["riskModule"]
            rm_status = evt["args"]["newStatus"]
            if rm_status == 1:  # active
                risk_modules[rm_address] = RiskModule.connect(rm_address)
            elif rm_address in risk_modules:
                risk_modules.pop(rm_address)
        return risk_modules

    add_risk_module_ = MethodAdapter((("risk_module", "contract"), ))

    def add_risk_module(self, risk_module):
        self.add_risk_module_(risk_module)
        self._risk_modules[risk_module.name] = risk_module

    set_asset_manager_ = MethodAdapter((("asset_manager", "contract"), ))

    def set_asset_manager(self, asset_manager):
        self.set_asset_manager_(asset_manager)
        self._asset_manager = asset_manager

    @property
    def asset_manager(self):
        am = eth_call(self, "assetManager")
        if getattr(self, "_asset_manager", None) and self._asset_manager.contract.address == am:
            return self._asset_manager
        return BaseAssetManager.connect(am, self.owner)

    set_exchange_ = MethodAdapter((("exchange", "contract"), ))

    def set_exchange(self, exchange):
        self.set_exchange_(exchange)
        self._exchange = exchange

    @property
    def exchange(self):
        ex = eth_call(self, "exchange")
        if getattr(self, "_exchange", None) and self._exchange.contract.address == ex:
            return self._exchange
        return Exchange.connect(ex, self.owner)

    set_insolvency_hook_ = MethodAdapter((("insolvency_hook", "contract"), ))

    def set_insolvency_hook(self, insolvency_hook):
        self.set_insolvency_hook_(insolvency_hook)
        self._insolvency_hook = insolvency_hook

    @property
    def insolvency_hook(self):
        ih = eth_call(self, "insolvencyHook")
        if getattr(self, "_insolvency_hook", None) and self._insolvency_hook.contract.address == ih:
            return self._insolvency_hook
        return FreeGrantInsolvencyHook.connect(ih, self.owner)

    set_lp_whitelist = MethodAdapter((("whitelist", "contract"), ), eth_method="setLPWhitelist")


class PolicyPool(ETHWrapper):
    eth_contract = "PolicyPool"

    constructor_args = (("config", "address"), ("nftToken", "address"), ("currency", "address"))
    initialize_args = ()
    proxy_kind = "uups"

    def __init__(self, config, policy_nft, currency):
        self._config = config
        self._currency = currency
        self._policy_nft = policy_nft
        super().__init__(config.owner, config.contract, policy_nft.contract, currency.contract)
        self._auto_from = self.owner
        self._etokens = {}

    @property
    def currency(self):
        if hasattr(self, "_currency"):
            return self._currency
        else:
            return IERC20.connect(eth_call(self, "currency"))

    @property
    def config(self):
        if hasattr(self, "_config"):
            return self._config
        else:
            return PolicyPoolConfig.connect(eth_call(self, "config"))

    @property
    def policy_nft(self):
        if hasattr(self, "_policy_nft"):
            return self._policy_nft
        else:
            return IERC721.connect(eth_call(self, "policyNFT"))

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

    @classmethod
    def fetch_etokens(cls, wrapper):
        etk_count = eth_call(wrapper, "getETokenCount")
        etokens = {}
        for i in range(etk_count):
            etk_address = eth_call(wrapper, "getETokenAt", i)
            etk = EToken.connect(etk_address)
            etokens[etk.name] = etk
        return etokens

    add_etoken_ = MethodAdapter((("etoken", "contract"), ), eth_method="addEToken")

    def add_etoken(self, etoken):
        self.add_etoken_(etoken)
        self.etokens[etoken.name] = etoken

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
            return Policy(*policy_data, self.provider.address_book)

    get_policy_fund_count = MethodAdapter((("policy_id", "int"), ), "int")
    get_policy_fund = MethodAdapter((("policy_id", "int"), ("etoken", "contract")), "amount")
    get_investable = MethodAdapter((), "amount")

    expire_policy_ = MethodAdapter((("policy", "tuple"), ))

    def expire_policy(self, policy_id):
        if type(policy_id) == tuple:
            return self.expire_policy_(policy_id)
        global policy_db
        policy = policy_db.get_policy(self.contract.address, policy_id)
        return self.expire_policy_(policy.as_tuple())


class PremiumsAccount(ETHWrapper):
    eth_contract = "PremiumsAccount"

    constructor_args = (("pool", "address"), )
    initialize_args = ()
    proxy_kind = "uups"

    def __init__(self, pool, owner="owner"):
        super().__init__(owner, pool.contract)

    pure_premiums = MethodAdapter((), "amount", is_property=True)
    won_pure_premiums = MethodAdapter((), "amount", is_property=True)
    active_pure_premiums = MethodAdapter((), "amount", is_property=True)
    borrowed_active_pp = MethodAdapter((), "amount", is_property=True, eth_method="borrowedActivePP")

    withdraw_won_premiums_ = MethodAdapter((("amount", "amount"), ))

    def withdraw_won_premiums(self, amount):
        receipt = self.withdraw_won_premiums_(amount)
        if "WonPremiumsInOut" in receipt.events:
            return Wad(receipt.events["WonPremiumsInOut"]["value"])
        else:
            return Wad(0)

    receive_grant = MethodAdapter((("sender", "msg.sender"), ("amount", "amount")))

    repay_etoken_loan_ = MethodAdapter((("etoken", "contract"), ), eth_method="repayETokenLoan")

    def repay_etoken_loan(self, etoken_name):
        etoken = self.etokens[etoken_name]
        receipt = self.repay_etoken_loan_(etoken)
        if "PoolLoanRepaid" in receipt.events:
            return Wad(receipt.events["PoolLoanRepaid"]["value"])
        else:
            return Wad(0)


class Exchange(ETHWrapper):
    eth_contract = "Exchange"
    proxy_kind = "uups"

    constructor_args = (("pool", "address"), )
    initialize_args = (
        ("oracle", "address"), ("swap_router", "address"),
        ("max_slippage", "wad")
    )

    max_slippage = MethodAdapter((), "wad", is_property=True)

    def __init__(self, owner, pool, oracle, swap_router, max_slippage=_W("0.01")):
        max_slippage = _W(max_slippage)
        super(Exchange, self).__init__(
            owner,
            pool,  # constructor_args
            oracle, swap_router, max_slippage,
        )
        if isinstance(pool, ETHWrapper):
            self._policy_pool = pool.contract
        else:  # is just an address or raw contract - for tests
            self._policy_pool = self._get_account(pool)

        self._auto_from = self.owner


class LPManualWhitelist(ETHWrapper):
    eth_contract = "LPManualWhitelist"
    proxy_kind = "uups"

    initialize_args = ()
    constructor_args = (("pool", "address"), )

    def __init__(self, pool):
        super().__init__("owner", pool.contract)

    whitelist_address = MethodAdapter((("address", "address"), ("whitelisted", "bool")), )


ERC20Token = TestCurrency
