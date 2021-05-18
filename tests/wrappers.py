from functools import partial
from prototype.contracts import RevertError
from prototype.wadray import Wad, _R, Ray
from brownie import accounts
import brownie
from brownie.network.account import Account
from brownie.exceptions import VirtualMachineError
from brownie.network.state import Chain

chain = Chain()


class TimeControl:
    def fast_forward(self, secs):
        chain.sleep(secs)
        chain.mine()

    @property
    def now(self):
        return chain.time()


time_control = TimeControl()


class AddressBook:
    def __init__(self, eth_accounts):
        self.eth_accounts = eth_accounts  # brownie.network.account.Accounts
        self.name_to_address = {}
        self.last_account_used = -1

    def get_account(self, name):
        if name is None:
            return "0x0000000000000000000000000000000000000000"
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


class MethodAdapter:
    def __init__(self, args=(), return_type="", eth_method=None, adapt_args=None, is_property=False):
        self.eth_method = eth_method
        self.return_type = return_type
        self.args = args
        self.adapt_args = adapt_args
        self.is_property = is_property

    def __set_name__(self, owner, name):
        self._method_name = name
        if self.eth_method is None:
            self.eth_method = self.snake_to_camel(name)

    @staticmethod
    def snake_to_camel(name):
        components = name.split('_')
        return components[0] + ''.join(x.title() for x in components[1:])

    @property
    def method_name(self):
        return self._method_name or self.eth_method

    def __get__(self, instance, owner=None):
        if self.is_property:
            return self.call(instance)
        return partial(self.call, instance)

    def call(self, wrapper, *args, **kwargs):
        call_args = []
        msg_args = {}

        if self.adapt_args:
            args, kwargs = self.adapt_args(args, kwargs)

        for i, (arg_name, arg_type) in enumerate(self.args):
            if i < len(args):
                arg_value = args[i]
            elif arg_name in kwargs:
                arg_value = kwargs[arg_name]
            else:
                raise TypeError(f"{self.method_name}() missing required argument: '{arg_name}'")
            if arg_type == "msg.sender":
                msg_args["from"] = self.parse("address", arg_value)
            elif arg_type == "msg.value":
                msg_args["value"] = self.parse("amount", arg_value)
            else:
                call_args.append(self.parse(arg_type, arg_value))

        if "from" not in msg_args and hasattr(wrapper, "_auto_from"):
            msg_args["from"] = wrapper._auto_from
        call_args.append(msg_args)

        try:
            ret_value = getattr(wrapper.contract, self.eth_method)(*call_args)
        except VirtualMachineError as err:
            if err.revert_type == "revert":
                raise RevertError(err.revert_msg)
            raise
        return self.unparse(self.return_type, ret_value)

    def parse(self, value_type, value):
        if value_type == "address":
            return AddressBook.instance.get_account(value)
        if value_type == "amount" and value is None:
            return MAXUINT256
        return value

    def unparse(self, value_type, value):
        if value_type == "amount":
            return Wad(value)
        if value_type == "ray":
            return Ray(value)
        if value_type == "address":
            return AddressBook.instance.get_name(value)
        return value


class IERC20:
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
    __test__ = False

    def __init__(self, owner="Owner", name="Test Currency", symbol="TEST", initial_supply=Wad(0)):
        self.owner = AddressBook.instance.get_account(owner)
        self.contract = brownie.TestCurrency.deploy(initial_supply, {"from": self.owner})

    mint = MethodAdapter((("recipient", "address"), ("amount", "amount")))
    burn = MethodAdapter((("recipient", "address"), ("amount", "amount")))

    @property
    def balances(self):
        return dict(
            (name, self.balance_of(name))
            for name, address in AddressBook.instance.name_to_address.items()
        )


class TestNFT:
    __test__ = False

    def __init__(self, owner="Owner", name="Test NFT", symbol="NFTEST"):
        self.owner = AddressBook.instance.get_account(owner)
        self.contract = brownie.TestNFT.deploy({"from": self.owner})

    mint = MethodAdapter((("to", "address"), ("token_id", "int")))
    burn = MethodAdapter((("owner", "msg.sender"), ("token_id", "int")))
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
    total_supply = MethodAdapter((), "int")


def _adapt_signed_amount(args, kwargs):
    amount = args[0] if args else kwargs["amount"]
    if amount > 0:
        return (amount, True), {}
    else:
        return (-amount, False), {}


class ETokenETH(IERC20):
    def __init__(self, owner, name, symbol, policy_pool, expiration_period, liquidity_requirement=_R(1),
                 pool_loan_interest_rate=_R("0.05")):
        self.owner = AddressBook.instance.get_account(owner)
        policy_pool = AddressBook.instance.get_account(policy_pool)
        self._auto_from = policy_pool
        self.contract = brownie.EToken.deploy(
            name, symbol, policy_pool, expiration_period, liquidity_requirement,
            pool_loan_interest_rate,
            {"from": self.owner}
        )

    SET_LOAN_RATE_ROLE = "0xe62d393ed571d580b9dadf5969acac0f8be619cc47180ce14b5292f9984ec0c2"

    ocean = MethodAdapter((), "amount", is_property=True)
    scr = MethodAdapter((), "amount", is_property=True)
    scr_interest_rate = MethodAdapter((), "ray", is_property=True)
    token_interest_rate = MethodAdapter((), "ray", is_property=True)
    pool_loan_interest_rate = MethodAdapter((), "ray", is_property=True)
    set_pool_loan_interest_rate_ = MethodAdapter((("user", "msg.sender"), ("new_rate", "ray"), ))

    def set_pool_loan_interest_rate(self, rate):
        if not hasattr(self, "_role_set_rate"):
            self._role_set_rate = AddressBook.instance.get_account("SETRATE")
            self.contract.grantRole(
                self.SET_LOAN_RATE_ROLE, self._role_set_rate, {"from": self.owner}
            )
        return self.set_pool_loan_interest_rate_("SETRATE", rate)

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

    lend_to_pool = MethodAdapter((("amount", "amount"), ))
    repay_pool_loan = MethodAdapter((("amount", "amount"), ))
    get_pool_loan = MethodAdapter((), "amount")
    get_investable = MethodAdapter((), "amount")

    get_current_index = MethodAdapter((("updated", "bool"), ), "ray")
