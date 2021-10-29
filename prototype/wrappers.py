from contextlib import contextmanager
from ethproto.wadray import Wad, _R, Ray, _W
from ethproto.wrappers import AddressBook, IERC20, IERC721, ETHWrapper, MethodAdapter, get_provider


SECONDS_IN_YEAR = 365 * 24 * 3600


def eth_call(wrapper, fn_name, *args):
    return wrapper.provider.eth_call.get_eth_function(wrapper, fn_name)(*args)


class TestCurrency(IERC20):
    eth_contract = "TestCurrency"
    __test__ = False

    def __init__(self, owner="owner", name="Test Currency", symbol="TEST", initial_supply=Wad(0)):
        super().__init__(owner, name, symbol, initial_supply)

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

    constructor_args = (
        ("name", "string"), ("symbol", "string"), ("policy_pool", "address"),
    )

    def __init__(self, owner="Owner", name="Test NFT", symbol="NFTEST"):
        super().__init__(owner, name, symbol, AddressBook.ZERO)


def _adapt_signed_amount(args, kwargs):
    amount = args[0] if args else kwargs["amount"]
    if amount > 0:
        return (amount, True), {}
    else:
        return (-amount, False), {}


class EToken(IERC20):
    eth_contract = "EToken"
    proxy_kind = "uups"
    constructor_args = (
        ("name", "string"), ("symbol", "string"), ("policy_pool", "address"), ("expiration_period", "int"),
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
            owner, name, symbol, policy_pool, expiration_period, liquidity_requirement,
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
    set_pool_loan_interest_rate = MethodAdapter((("new_rate", "ray"), ))
    set_max_utilization_rate = MethodAdapter((("new_rate", "ray"), ))

    lock_scr = MethodAdapter(
        (("policy_interest_rate", "ray"), ("scr_amount", "amount")),
        adapt_args=lambda args, kwargs: ((), {
            "policy_interest_rate": (args[0] if args else kwargs["policy"]).interest_rate,
            "scr_amount": args[1] if len(args) > 1 else kwargs["scr_amount"],
        })
    )

    unlock_scr = MethodAdapter(
        (("policy_interest_rate", "ray"), ("scr_amount", "amount")),
        adapt_args=lambda args, kwargs: ([], {
            "policy_interest_rate": (args[0] if args else kwargs["policy"]).interest_rate,
            "scr_amount": args[1] if len(args) > 1 else kwargs["scr_amount"],
        })
    )

    discrete_earning = MethodAdapter((("amount", "amount"), ("positive", "bool")),
                                     adapt_args=_adapt_signed_amount)

    asset_earnings = MethodAdapter((("amount", "amount"), ("positive", "bool")),
                                   adapt_args=_adapt_signed_amount)

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
        (("policy_expiration", "int"), ), "bool",
        adapt_args=lambda args, kwargs: ((args[0].expiration, ), {})
    )

    lend_to_pool_ = MethodAdapter((("amount", "amount"), ("from_ocean", "bool")))

    def lend_to_pool(self, amount, from_ocean=True):
        receipt = self.lend_to_pool_(amount, from_ocean)
        if "PoolLoan" in receipt.events:
            return Wad(receipt.events["PoolLoan"]["value"])
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

    def __init__(self, id, payout, premium, scr, rm_coverage, loss_prob,
                 pure_premium, premium_for_ensuro, premium_for_rm, premium_for_lps,
                 risk_module, start, expiration, address_book):
        self.id = id
        self.risk_module = address_book.get_name(risk_module)
        self.payout = Wad(payout)
        self.premium = Wad(premium)
        self.scr = Wad(scr)
        self.rm_coverage = Wad(rm_coverage)
        self.loss_prob = Ray(loss_prob)
        self.start = start
        self.expiration = expiration
        self.pure_premium = Wad(pure_premium)
        self.premium_for_ensuro = Wad(premium_for_ensuro)
        self.premium_for_rm = Wad(premium_for_rm)
        self.premium_for_lps = Wad(premium_for_lps)

    def _coverage_premium_split(self):
        ens_premium = self.premium * (self.payout - self.rm_coverage) // self.payout
        rm_premium = self.premium - ens_premium
        return ens_premium, rm_premium

    @property
    def rm_scr(self):
        ens_premium, rm_premium = self._coverage_premium_split()
        return self.rm_coverage - rm_premium

    def premium_split(self):
        return self.pure_premium, self.premium_for_ensuro, self.premium_for_rm, self.premium_for_lps

    @property
    def interest_rate(self):
        return (
            self.premium_for_lps * _W(SECONDS_IN_YEAR) // (
                _W(self.expiration - self.start) * self.scr
            )
        ).to_ray()

    def accrued_interest(self):
        seconds = Ray.from_value(get_provider().time_control.now - self.start)
        return (
            self.scr.to_ray() * seconds * self.interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        ).to_wad()


class RiskModuleETH(ETHWrapper):

    constructor_args = (
        ("name", "string"), ("pool", "address"), ("scr_percentage", "ray"), ("ensuro_fee", "ray"),
        ("scr_interest_rate", "ray"), ("max_scr_per_policy", "amount"), ("scr_limit", "amount"),
        ("wallet", "address"), ("shared_coverage_min_percentage", "ray")
    )

    def __init__(self, name, policy_pool, scr_percentage=_R(1), ensuro_fee=_R(0),
                 scr_interest_rate=_R(0), max_scr_per_policy=_W(1000000), scr_limit=_W(1000000),
                 wallet="RM", shared_coverage_min_percentage=_R(0), owner="owner"):
        scr_percentage = _R(scr_percentage)
        ensuro_fee = _R(ensuro_fee)
        scr_interest_rate = _R(scr_interest_rate)
        max_scr_per_policy = _W(max_scr_per_policy)
        scr_limit = _W(scr_limit)
        shared_coverage_min_percentage = _R(shared_coverage_min_percentage)
        super().__init__(owner, name, policy_pool.contract, scr_percentage, ensuro_fee,
                         scr_interest_rate,
                         max_scr_per_policy, scr_limit, wallet, shared_coverage_min_percentage)
        self.policy_pool = policy_pool
        self._auto_from = self.owner

    name = MethodAdapter((), "string", is_property=True)
    scr_percentage = MethodAdapter((), "ray", is_property=True)
    moc = MethodAdapter((), "ray", is_property=True)
    ensuro_fee = MethodAdapter((), "ray", is_property=True)
    scr_interest_rate = MethodAdapter((), "ray", is_property=True)
    max_scr_per_policy = MethodAdapter((), "amount", is_property=True)
    scr_limit = MethodAdapter((), "amount", is_property=True)
    total_scr = MethodAdapter((), "amount", is_property=True)
    wallet = MethodAdapter((), "address", is_property=True)
    shared_coverage_min_percentage = MethodAdapter((), "ray", is_property=True)
    shared_coverage_percentage = MethodAdapter((), "ray", is_property=True)


class TrustfulRiskModule(RiskModuleETH):
    eth_contract = "TrustfulRiskModule"
    proxy_kind = "uups"

    new_policy_ = MethodAdapter((
        ("payout", "amount"), ("premium", "amount"), ("loss_prob", "ray"), ("expiration", "int"),
        ("customer", "address")
    ), "int")

    resolve_policy_full_payout = MethodAdapter((("policy_id", "int"), ("customer_won", "bool")))
    resolve_policy_ = MethodAdapter((("policy_id", "int"), ("payout", "amount")))

    def resolve_policy(self, policy_id, customer_won_or_amount):
        if customer_won_or_amount is True or customer_won_or_amount is False:
            return self.resolve_policy_full_payout(policy_id,  customer_won_or_amount)
        else:
            return self.resolve_policy_(policy_id,  customer_won_or_amount)

    def new_policy(self, *args, **kwargs):
        receipt = self.new_policy_(*args, **kwargs)
        if "NewPolicy" in receipt.events:
            policy_id = receipt.events["NewPolicy"]["policyId"]
            policy_data = self.policy_pool.contract.getPolicy(policy_id)
            return Policy(*policy_data, address_book=self.provider.address_book)
        else:
            return None


class PolicyPoolConfig(ETHWrapper):
    eth_contract = "PolicyPoolConfig"

    proxy_kind = "uups"

    constructor_args = (("policy_pool", "address"), ("treasury", "address"))

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
        raise NotImplementedError()  # TODO

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
        if getattr(self, "_asset_manager") and self._asset_manager.contract.address == am:
            return self._asset_manager
        return BaseAssetManager.connect(am, self.owner)

    set_insolvency_hook_ = MethodAdapter((("insolvency_hook", "contract"), ))

    def set_insolvency_hook(self, insolvency_hook):
        self.set_insolvency_hook_(insolvency_hook)
        self._insolvency_hook = insolvency_hook

    @property
    def insolvency_hook(self):
        ih = eth_call(self, "insolvencyHook")
        if getattr(self, "_insolvency_hook") and self._insolvency_hook.contract.address == ih:
            return self._insolvency_hook
        return FreeGrantInsolvencyHook.connect(ih, self.owner)

    set_lp_whitelist = MethodAdapter((("whitelist", "contract"), ), eth_method="setLPWhitelist")


class PolicyPool(ETHWrapper):
    eth_contract = "PolicyPool"

    constructor_args = (("config", "address"), ("nftToken", "address"), ("currency", "address"))
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

    pure_premiums = MethodAdapter((), "amount", is_property=True)
    won_pure_premiums = MethodAdapter((), "amount", is_property=True)
    active_premiums = MethodAdapter((), "amount", is_property=True)
    active_pure_premiums = MethodAdapter((), "amount", is_property=True)
    borrowed_active_pp = MethodAdapter((), "amount", is_property=True, eth_method="borrowedActivePP")
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
        if "Withdrawal" in receipt.events:
            return Wad(receipt.events["Withdrawal"]["value"])
        else:
            return Wad(0)

    withdraw_won_premiums_ = MethodAdapter((("amount", "amount"), ))

    def withdraw_won_premiums(self, amount):
        receipt = self.withdraw_won_premiums_(amount)
        if "WonPremiumsInOut" in receipt.events:
            return Wad(receipt.events["WonPremiumsInOut"]["value"])
        else:
            return Wad(0)

    def get_policy(self, policy_id):
        policy_data = eth_call(self, "getPolicy", policy_id)
        if policy_data:
            return Policy(*policy_data, self.provider.address_book)

    get_policy_fund_count = MethodAdapter((("policy_id", "int"), ), "int")
    get_policy_fund = MethodAdapter((("policy_id", "int"), ("etoken", "contract")), "amount")
    rebalance_policy = MethodAdapter((("policy_id", "int"), ))
    get_investable = MethodAdapter((), "amount")
    receive_grant = MethodAdapter((("sender", "msg.sender"), ("amount", "amount")))

    repay_etoken_loan_ = MethodAdapter((("etoken", "contract"), ), eth_method="repayETokenLoan")

    def repay_etoken_loan(self, etoken_name):
        etoken = self.etokens[etoken_name]
        receipt = self.repay_etoken_loan_(etoken)
        if "PoolLoanRepaid" in receipt.events:
            return Wad(receipt.events["PoolLoanRepaid"]["value"])
        else:
            return Wad(0)

    expire_policy = MethodAdapter((("policy_id", "int"), ))


class BaseAssetManager(ETHWrapper):
    eth_contract = "BaseAssetManager"
    proxy_kind = "uups"

    constructor_args = (
        ("pool", "address"), ("liquidity_min", "amount"), ("liquidity_middle", "amount"),
        ("liquidity_max", "amount")
    )

    def __init__(self, owner, pool, liquidity_min, liquidity_middle, liquidity_max, *args):
        liquidity_min = _W(liquidity_min)
        liquidity_middle = _W(liquidity_middle)
        liquidity_max = _W(liquidity_max)

        super().__init__(
            owner, pool, liquidity_min, liquidity_middle, liquidity_max, *args
        )
        if isinstance(pool, ETHWrapper):
            self._policy_pool = pool.contract
        else:  # is just an address or raw contract - for tests
            self._policy_pool = self._get_account(pool)

        self._auto_from = self.owner

    checkpoint = MethodAdapter()
    rebalance = MethodAdapter()
    distribute_earnings = MethodAdapter()
    total_investable = MethodAdapter((), "amount")
    get_investment_value = MethodAdapter((), "amount")
    refill_wallet = MethodAdapter((("amount", "amount"),))

    liquidity_min = MethodAdapter((), "amount", is_property=True)
    liquidity_middle = MethodAdapter((), "amount", is_property=True)
    liquidity_max = MethodAdapter((), "amount", is_property=True)

    def grant_role(self, role, user):
        # AssetManager doesn't haves grant_role
        policy_pool = PolicyPool.connect(self._policy_pool)
        config = policy_pool.config
        with config.as_(self._auto_from):
            return config.grant_role(role, user)

    @contextmanager
    def thru_policy_pool(self):
        prev_contract = self.contract
        contract_factory = self.provider.get_contract_factory("IAssetManager")
        self.contract = self.provider.build_contract(self._policy_pool, contract_factory, "IAssetManager")
        try:
            yield self
        finally:
            self.contract = prev_contract


class FixedRateAssetManager(BaseAssetManager):
    eth_contract = "FixedRateAssetManager"
    constructor_args = (
        ("pool", "address"), ("liquidity_min", "amount"), ("liquidity_middle", "amount"),
        ("liquidity_max", "amount"), ("interest_rate", "ray"),
    )

    def __init__(self, owner, pool, liquidity_min, liquidity_middle, liquidity_max,
                 interest_rate=_R("0.05")):
        interest_rate = _R(interest_rate)
        super().__init__(
            owner, pool, liquidity_min, liquidity_middle, liquidity_max, interest_rate
        )


class AaveAssetManager(BaseAssetManager):
    eth_contract = "AaveAssetManager"

    def __init__(self, owner, pool, liquidity_min, liquidity_middle, liquidity_max,
                 aave_address_provider, swap_router, claim_rewards_min=_W(0),
                 reinvest_rewards_min=_W(0), max_slippage=_W("0.01")):
        super().__init__(
            owner, pool, liquidity_min, liquidity_middle, liquidity_max, aave_address_provider,
            swap_router, claim_rewards_min, reinvest_rewards_min, max_slippage
        )

    @property
    def currency(self):
        return IERC20.connect(eth_call(self, "currency"))

    @property
    def rewardToken(self):
        return IERC20.connect(eth_call(self, "rewardToken"))

    @property
    def rewardAToken(self):
        return IERC20.connect(eth_call(self, "rewardAToken"))

    @property
    def aToken(self):
        return IERC20.connect(eth_call(self, "aToken"))

    swap_rewards_ = MethodAdapter((("amount", "amount"), ))

    def swap_rewards(self, amount):
        receipt = self.swap_rewards_(amount)
        if "RewardSwapped" in receipt.events:
            event = receipt.events["RewardSwapped"]
            return Wad(event["rewardIn"]), Wad(event["currencyOut"])
        else:
            return Wad(0)

    max_slippage = MethodAdapter((), "amount", is_property=True)
    claim_rewards_min = MethodAdapter((), "amount", is_property=True)
    reinvest_rewards_min = MethodAdapter((), "amount", is_property=True)


class FreeGrantInsolvencyHook(ETHWrapper):
    eth_contract = "FreeGrantInsolvencyHook"

    def __init__(self, pool):
        super().__init__("owner", pool.contract)

    cash_granted = MethodAdapter((), "amount", is_property=True)


class LPInsolvencyHook(ETHWrapper):
    eth_contract = "LPInsolvencyHook"

    def __init__(self, pool, etoken, cover_etoken=False):
        etoken = pool.etokens[etoken]
        super().__init__("owner", pool.contract, etoken.contract, cover_etoken)

    cash_deposited = MethodAdapter((), "amount", is_property=True)


class LPManualWhitelist(ETHWrapper):
    eth_contract = "LPManualWhitelist"
    proxy_kind = "uups"

    def __init__(self, pool):
        super().__init__("owner", pool.contract)

    whitelist_address = MethodAdapter((("address", "address"), ("whitelisted", "bool")), )


ERC20Token = TestCurrency
