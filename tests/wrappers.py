from contextlib import contextmanager
from functools import partial
from prototype.contracts import RevertError
from prototype.wadray import Wad, _R, Ray, _W
from Crypto.Hash import keccak
from brownie import accounts
import eth_utils
import brownie
from brownie.network.account import Account, LocalAccount
from brownie.exceptions import VirtualMachineError
from brownie.network.state import Chain
from brownie.network.contract import Contract, ProjectContract
from environs import Env

env = Env()
chain = Chain()

SECONDS_IN_YEAR = 365 * 24 * 3600

SKIP_PROXY = env.bool("SKIP_PROXY", False)


class TimeControl:
    def fast_forward(self, secs):
        chain.sleep(secs)
        chain.mine()

    @property
    def now(self):
        if len(chain) > 0:
            return chain[-1].timestamp
        return chain.time()


time_control = TimeControl()


def get_contract_factory(eth_contract):
    ret = getattr(brownie, eth_contract, None)
    if ret is not None:
        return ret
    # Might be an interface
    project = brownie.project.get_loaded_projects()[0]
    return getattr(project.interface, eth_contract)


class AddressBook:
    ZERO = "0x0000000000000000000000000000000000000000"

    def __init__(self, eth_accounts):
        self.eth_accounts = eth_accounts  # brownie.network.account.Accounts
        self.name_to_address = {}
        self.last_account_used = -1

    def get_account(self, name):
        if isinstance(name, (Account, LocalAccount)):
            return name
        if isinstance(name, (Contract, ProjectContract)):
            return name
        if name is None:
            return self.ZERO
        if name not in self.name_to_address:
            self.last_account_used += 1
            if (len(self.eth_accounts) - 1) > self.last_account_used:
                self.eth_accounts.add()
                self.name_to_address[name] = self.eth_accounts[self.last_account_used].address
        return self.eth_accounts.at(self.name_to_address[name])

    def get_name(self, account_or_address):
        if isinstance(account_or_address, Account):
            account_or_address = account_or_address.address

        for name, addr in self.name_to_address.items():
            if addr == account_or_address:
                return name
        return None


AddressBook.instance = AddressBook(accounts)

MAXUINT256 = 2**256 - 1


class ETHCall:
    def __init__(self, eth_method, eth_args, eth_return_type="", adapt_args=None, eth_variant=None):
        self.eth_method = eth_method
        self.eth_args = eth_args
        self.eth_return_type = eth_return_type
        self.adapt_args = adapt_args
        self.eth_variant = eth_variant

    def __call__(self, wrapper, *args, **kwargs):
        call_args = []
        msg_args = {}

        if self.adapt_args:
            args, kwargs = self.adapt_args(args, kwargs)

        for i, (arg_name, arg_type) in enumerate(self.eth_args):
            if i < len(args):
                arg_value = args[i]
            elif arg_name in kwargs:
                arg_value = kwargs[arg_name]
            else:
                raise TypeError(f"{self.eth_method}() missing required argument: '{arg_name}'")
            if arg_type == "msg.sender":
                msg_args["from"] = self.parse("address", arg_value)
            elif arg_type == "msg.value":
                msg_args["value"] = self.parse("amount", arg_value)
            else:
                call_args.append(self.parse(arg_type, arg_value))

        if "from" not in msg_args and hasattr(wrapper, "_auto_from"):
            msg_args["from"] = wrapper._auto_from
        call_args.append(msg_args)

        if self.eth_variant:
            eth_function = getattr(wrapper.contract, self.eth_method)[self.eth_variant]
        else:
            eth_function = getattr(wrapper.contract, self.eth_method)

        try:
            ret_value = eth_function(*call_args)
        except VirtualMachineError as err:
            if err.revert_type == "revert":
                raise RevertError(err.revert_msg)
            raise
        return self.unparse(self.eth_return_type, ret_value)

    @classmethod
    def parse(cls, value_type, value):
        if value_type == "address":
            if isinstance(value, (LocalAccount, Account)):
                return value
            elif isinstance(value, (Contract, ProjectContract)):
                return value.address
            elif isinstance(value, ETHWrapper):
                return value.contract.address
            elif isinstance(value, str) and value.startswith("0x"):
                return value
            return AddressBook.instance.get_account(value)
        if value_type == "keccak256":
            if not value.startswith("0x"):
                k = keccak.new(digest_bits=256)
                k.update(value.encode("utf-8"))
                return k.hexdigest()
        if value_type == "contract":
            if isinstance(value, ETHWrapper):
                return value.contract.address
            elif value is None:
                return AddressBook.ZERO
            raise RuntimeError(f"Invalid contract: {value}")
        if value_type == "amount" and value is None:
            return MAXUINT256
        return value

    @classmethod
    def unparse(cls, value_type, value):
        if value_type == "amount":
            return Wad(value)
        if value_type == "ray":
            return Ray(value)
        if value_type == "address":
            return AddressBook.instance.get_name(value)
        return value


class MethodAdapter:
    def __init__(self, args=(), return_type="", eth_method=None, adapt_args=None, is_property=False,
                 set_eth_method=None, eth_variant=None):
        self.eth_method = eth_method
        self.set_eth_method = set_eth_method
        self.return_type = return_type
        self.args = args
        self.adapt_args = adapt_args
        self.is_property = is_property
        self.eth_variant = eth_variant

    def __set_name__(self, owner, name):
        self._method_name = name
        if self.eth_method is None:
            self.eth_method = self.snake_to_camel(name)
        if self.set_eth_method is None:
            self.set_eth_method = "set" + self.eth_method[0].upper() + self.eth_method[1:]

    @staticmethod
    def snake_to_camel(name):
        components = name.split('_')
        return components[0] + ''.join(x.title() for x in components[1:])

    @property
    def method_name(self):
        return self._method_name or self.eth_method

    def __get__(self, instance, owner=None):
        eth_call = ETHCall(self.eth_method, self.args, self.return_type, self.adapt_args,
                           eth_variant=self.eth_variant)
        if self.is_property:
            return eth_call(instance)
        return partial(eth_call, instance)

    def __set__(self, instance, value):
        if not self.is_property:
            raise NotImplementedError()
        eth_call = ETHCall(self.set_eth_method, (("new_value", self.return_type), ))
        return eth_call(instance, value)


def encode_function_data(initializer=None, *args):
    """Encodes the function call so we can work with an initializer.
    Args:
        initializer ([brownie.network.contract.ContractTx], optional):
        The initializer function we want to call. Example: `box.store`.
        Defaults to None.
        args (Any, optional):
        The arguments to pass to the initializer function
    Returns:
        [bytes]: Return the encoded bytes.
    """
    if len(args) == 0 or not initializer:
        return eth_utils.to_bytes(hexstr="0x")
    else:
        return initializer.encode_input(*args)


class ETHWrapper:
    proxy_kind = None
    libraries_required = []

    def __init__(self, owner="owner", *init_params):
        self.owner = AddressBook.instance.get_account(owner)
        for library in self.libraries_required:
            get_contract_factory(library).deploy({"from": self.owner})
        eth_contract = get_contract_factory(self.eth_contract)
        if self.proxy_kind is None:
            self.contract = eth_contract.deploy(*init_params, {"from": self.owner})
        elif self.proxy_kind == "uups" and not SKIP_PROXY:
            real_contract = eth_contract.deploy({"from": self.owner})
            proxy_contract = brownie.ERC1967Proxy.deploy(
                real_contract, encode_function_data(real_contract.initialize, *init_params),
                {"from": self.owner}
            )
            self.contract = Contract.from_abi(self.eth_contract, proxy_contract.address, eth_contract.abi)
        elif self.proxy_kind == "uups" and SKIP_PROXY:
            self.contract = eth_contract.deploy({"from": self.owner})
            self.contract.initialize(*init_params, {"from": self.owner})

    @classmethod
    def connect(cls, contract, owner=None):
        """Connects a wrapper to an existing deployed object"""
        obj = cls.__new__(cls)
        if isinstance(contract, str):
            eth_contract = get_contract_factory(cls.eth_contract)
            contract = Contract.from_abi(cls.eth_contract, contract, eth_contract.abi)
        obj.contract = contract
        obj.owner = owner
        return obj

    @property
    def contract_id(self):
        return self.contract.address

    def _get_account(self, name):
        return AddressBook.instance.get_account(name)

    def _get_name(self, account):
        return AddressBook.instance.get_name(account)

    grant_role = MethodAdapter((("role", "keccak256"), ("user", "address")))

    @contextmanager
    def as_(self, user):
        prev_auto_from = getattr(self, "_auto_from", "missing")
        self._auto_from = self._get_account(user)
        try:
            yield self
        finally:
            if prev_auto_from == "missing":
                del self._auto_from
            else:
                self._auto_from = prev_auto_from


class IERC20(ETHWrapper):
    eth_contract = "IERC20Metadata"

    name = MethodAdapter((), "string", is_property=True)
    symbol = MethodAdapter((), "string", is_property=True)
    decimals = MethodAdapter((), "int", is_property=True)
    total_supply = MethodAdapter((), "amount")
    balance_of = MethodAdapter((("account", "address"), ), "amount")
    transfer = MethodAdapter((
        ("sender", "msg.sender"), ("recipient", "address"), ("amount", "amount")
    ), "bool")

    allowance = MethodAdapter((("owner", "address"), ("spender", "address")), "amount")
    approve = MethodAdapter((("owner", "msg.sender"), ("spender", "address"), ("amount", "amount")),
                            "bool")
    increase_allowance = MethodAdapter(
        (("owner", "msg.sender"), ("spender", "address"), ("amount", "amount"))
    )
    decrease_allowance = MethodAdapter(
        (("owner", "msg.sender"), ("spender", "address"), ("amount", "amount"))
    )

    transfer_from = MethodAdapter((
        ("spender", "msg.sender"), ("sender", "address"), ("recipient", "address"), ("amount", "amount")
    ), "bool")


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
            for name, address in AddressBook.instance.name_to_address.items()
        )


class IERC721(ETHWrapper):
    name = MethodAdapter((), "string", is_property=True)
    symbol = MethodAdapter((), "string", is_property=True)
    total_supply = MethodAdapter((), "int")
    balance_of = MethodAdapter((("account", "address"), ), "int")
    owner_of = MethodAdapter((("token_id", "int"), ), "address")
    approve = MethodAdapter((
        ("sender", "msg.sender"), ("spender", "address"), ("token_id", "int")
    ), "bool")
    get_approved = MethodAdapter((("token_id", "int"), ), "address")
    set_approval_for_all = MethodAdapter((
        ("sender", "msg.sender"), ("operator", "address"), ("approved", "bool")
    ))
    is_approved_for_all = MethodAdapter((("owner", "address"), ("operator", "address")), "bool")
    transfer_from = MethodAdapter((
        ("spender", "msg.sender"), ("from", "address"), ("to", "address"), ("token_id", "int")
    ), "bool")
    transfer = MethodAdapter((
        ("sender", "msg.sender"), ("recipient", "address"), ("amount", "amount")
    ), "bool")


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

    def __init__(self, owner="Owner", name="Test NFT", symbol="NFTEST"):
        super().__init__(owner, name, symbol)


def _adapt_signed_amount(args, kwargs):
    amount = args[0] if args else kwargs["amount"]
    if amount > 0:
        return (amount, True), {}
    else:
        return (-amount, False), {}


class ETokenETH(IERC20):
    eth_contract = "EToken"
    proxy_kind = "uups"

    def __init__(self, name, symbol, policy_pool, expiration_period, liquidity_requirement=_R(1),
                 max_utilization_rate=_R(1),
                 pool_loan_interest_rate=_R("0.05"), owner="owner"):
        pool_loan_interest_rate = _R(pool_loan_interest_rate)
        liquidity_requirement = _R(liquidity_requirement)
        max_utilization_rate = _R(max_utilization_rate)
        if isinstance(policy_pool, ETHWrapper):
            self._policy_pool = policy_pool.contract
        else:  # is just an address or raw contract - for tests
            self._policy_pool = self._get_account(policy_pool)
        self._auto_from = self._get_account("johhdoe")

        super().__init__(
            owner, name, symbol, self._policy_pool, expiration_period, liquidity_requirement,
            max_utilization_rate, pool_loan_interest_rate
        )

    @contextmanager
    def thru_policy_pool(self):
        prev_contract = self.contract
        self.contract = Contract.from_abi(self.eth_contract, self._policy_pool, brownie.EToken.abi)
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

    lend_to_pool_ = MethodAdapter((("amount", "amount"), ))

    def lend_to_pool(self, amount):
        receipt = self.lend_to_pool_(amount)
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
                 risk_module, start, expiration):
        self.id = id
        self.risk_module = AddressBook.instance.get_name(risk_module)
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
        seconds = Ray.from_value(time_control.now - self.start)
        return (
            self.scr.to_ray() * seconds * self.interest_rate //
            Ray.from_value(SECONDS_IN_YEAR)
        ).to_wad()


class RiskModuleETH(ETHWrapper):

    def __init__(self, name, policy_pool, scr_percentage=_R(1), ensuro_fee=_R(0),
                 scr_interest_rate=_R(0), max_scr_per_policy=_W(1000000), scr_limit=_W(1000000),
                 wallet="RM", shared_coverage_min_percentage=_R(0), owner="owner"):
        scr_percentage = _R(scr_percentage)
        ensuro_fee = _R(ensuro_fee)
        scr_interest_rate = _R(scr_interest_rate)
        max_scr_per_policy = _W(max_scr_per_policy)
        scr_limit = _W(scr_limit)
        wallet = self._get_account(wallet)
        shared_coverage_min_percentage = _R(shared_coverage_min_percentage)
        self.policy_pool = policy_pool
        super().__init__(owner, name, policy_pool.contract, scr_percentage, ensuro_fee,
                         scr_interest_rate,
                         max_scr_per_policy, scr_limit, wallet, shared_coverage_min_percentage)
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

    resolve_policy_bool = MethodAdapter((("policy_id", "int"), ("customer_won", "bool")),
                                        eth_variant="uint,bool", eth_method="resolvePolicy")
    resolve_policy_amount = MethodAdapter((("policy_id", "int"), ("payout", "amount")),
                                          eth_variant="uint,uint", eth_method="resolvePolicy")

    def resolve_policy(self, policy_id, customer_won_or_amount):
        if customer_won_or_amount is True or customer_won_or_amount is False:
            return self.resolve_policy_bool(policy_id,  customer_won_or_amount)
        else:
            return self.resolve_policy_amount(policy_id,  customer_won_or_amount)

    def new_policy(self, *args, **kwargs):
        receipt = self.new_policy_(*args, **kwargs)
        if "NewPolicy" in receipt.events:
            policy_id = receipt.events["NewPolicy"]["policyId"]
            policy_data = self.policy_pool.contract.getPolicy(policy_id)
            return Policy(*policy_data)
        else:
            return None


class PolicyPoolConfig(ETHWrapper):
    eth_contract = "PolicyPoolConfig"

    proxy_kind = "uups"

    def __init__(self, owner, treasury="ENS"):
        treasury = self._get_account(treasury)
        super().__init__(owner, treasury)
        self._auto_from = self.owner
        self.risk_modules = {}

    add_risk_module_ = MethodAdapter((("risk_module", "contract"), ))

    def add_risk_module(self, risk_module):
        self.add_risk_module_(risk_module)
        self.risk_modules[risk_module.name] = risk_module

    set_asset_manager_ = MethodAdapter((("asset_manager", "contract"), ))

    def set_asset_manager(self, asset_manager):
        self.set_asset_manager_(asset_manager)
        self._asset_manager = asset_manager

    @property
    def asset_manager(self):
        am = self.contract.assetManager()
        if getattr(self, "_asset_manager") and self._asset_manager.contract.address == am:
            return self._asset_manager
        return BaseAssetManager.connect(am, self.owner)

    set_insolvency_hook_ = MethodAdapter((("insolvency_hook", "contract"), ))

    def set_insolvency_hook(self, insolvency_hook):
        self.set_insolvency_hook_(insolvency_hook)
        self._insolvency_hook = insolvency_hook

    @property
    def insolvency_hook(self):
        ih = self.contract.insolvencyHook()
        if getattr(self, "_insolvency_hook") and self._insolvency_hook.contract.address == ih:
            return self._insolvency_hook
        return FreeGrantInsolvencyHook.connect(ih, self.owner)

    set_lp_whitelist = MethodAdapter((("whitelist", "contract"), ), eth_method="setLPWhitelist")


class PolicyPool(ETHWrapper):
    eth_contract = "PolicyPool"

    proxy_kind = "uups"

    def __init__(self, config, policy_nft, currency):
        self._config = config
        self._currency = currency
        self._policy_nft = policy_nft
        super().__init__(config.owner, config.contract, policy_nft.contract, currency.contract)
        self._auto_from = self.owner
        self.etokens = {}

    @property
    def currency(self):
        if hasattr(self, "_currency"):
            return self._currency
        else:
            return IERC20.connect(self.contract.currency())

    @property
    def config(self):
        if hasattr(self, "_config"):
            return self._config
        else:
            return PolicyPoolConfig.connect(self.contract.config())

    @property
    def policy_nft(self):
        if hasattr(self, "_policy_nft"):
            return self._policy_nft
        else:
            return IERC721.connect(self.contract.policyNFT())

    @classmethod
    def connect(cls, contract, owner=None):
        obj = super(PolicyPool, cls).connect(contract, owner)
        obj.etokens = {}  # TODO: load from object
        obj.risk_modules = {}  # TODO: load from object
        obj._auto_from = obj.owner
        return obj

    pure_premiums = MethodAdapter((), "amount", is_property=True)
    won_pure_premiums = MethodAdapter((), "amount", is_property=True)
    active_premiums = MethodAdapter((), "amount", is_property=True)
    active_pure_premiums = MethodAdapter((), "amount", is_property=True)
    borrowed_active_pp = MethodAdapter((), "amount", is_property=True)
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
        policy_data = self.contract.getPolicy(policy_id)
        if policy_data:
            return Policy(*policy_data)

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

    def __init__(self, owner, pool, liquidity_min, liquidity_middle, liquidity_max, *args):
        liquidity_min = _W(liquidity_min)
        liquidity_middle = _W(liquidity_middle)
        liquidity_max = _W(liquidity_max)

        if isinstance(pool, ETHWrapper):
            self._policy_pool = pool.contract
        else:  # is just an address or raw contract - for tests
            self._policy_pool = self._get_account(pool)

        super().__init__(
            owner, self._policy_pool, liquidity_min, liquidity_middle, liquidity_max, *args
        )
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
        abi = get_contract_factory("IAssetManager").abi
        self.contract = Contract.from_abi(self.eth_contract, self._policy_pool, abi)
        try:
            yield self
        finally:
            self.contract = prev_contract


class FixedRateAssetManager(BaseAssetManager):
    eth_contract = "FixedRateAssetManager"

    def __init__(self, owner, pool, liquidity_min, liquidity_middle, liquidity_max,
                 interest_rate=_R("0.05")):
        interest_rate = _R(interest_rate)
        super().__init__(
            owner, pool, liquidity_min, liquidity_middle, liquidity_max, interest_rate
        )


class AaveAssetManager(BaseAssetManager):
    eth_contract = "AaveAssetManager"

    def __init__(self, owner, pool, liquidity_min, liquidity_middle, liquidity_max,
                 aave_address_provider, swap_router):
        super().__init__(
            owner, pool, liquidity_min, liquidity_middle, liquidity_max, aave_address_provider, swap_router
        )

    @property
    def currency(self):
        return IERC20.connect(self.contract.currency())

    @property
    def rewardToken(self):
        return IERC20.connect(self.contract.rewardToken())

    @property
    def rewardAToken(self):
        return IERC20.connect(self.contract.rewardAToken())

    @property
    def aToken(self):
        return IERC20.connect(self.contract.aToken())

    swap_rewards_ = MethodAdapter((("amount", "amount"), ))

    def swap_rewards(self, amount):
        receipt = self.swap_rewards_(amount)
        if "RewardSwapped" in receipt.events:
            event = receipt.events["RewardSwapped"]
            return Wad(event["rewardIn"]), Wad(event["currencyOut"])
        else:
            return Wad(0)


class FreeGrantInsolvencyHook(ETHWrapper):
    eth_contract = "FreeGrantInsolvencyHook"

    def __init__(self, pool):
        super().__init__("owner", pool.contract)

    cash_granted = MethodAdapter((), "amount", is_property=True)


class LPInsolvencyHook(ETHWrapper):
    eth_contract = "LPInsolvencyHook"

    def __init__(self, pool, etoken):
        etoken = pool.etokens[etoken]
        super().__init__("owner", pool.contract, etoken.contract)

    cash_deposited = MethodAdapter((), "amount", is_property=True)


class LPManualWhitelist(ETHWrapper):
    eth_contract = "LPManualWhitelist"
    proxy_kind = "uups"

    def __init__(self, pool):
        super().__init__("owner", pool.contract)

    whitelist_address = MethodAdapter((("address", "address"), ("whitelisted", "bool")), )


ERC20Token = TestCurrency
EToken = ETokenETH
