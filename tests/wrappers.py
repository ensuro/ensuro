from functools import partial
from prototype.contracts import RevertError
from prototype.wadray import Wad
from brownie import accounts
import brownie
from brownie.network.account import Account
from brownie.exceptions import VirtualMachineError


class AddressBook:
    def __init__(self, eth_accounts):
        self.eth_accounts = eth_accounts  # brownie.network.account.Accounts
        self.name_to_address = {}
        self.last_account_used = -1

    def get_account(self, name):
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


class MethodAdapter:
    def __init__(self, args=(), return_type="", eth_method=None):
        self.eth_method = eth_method
        self.return_type = return_type
        self.args = args

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
        return partial(self.call, instance)

    def call(self, wrapper, *args, **kwargs):
        call_args = []
        msg_args = {}

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
        return value

    def unparse(self, value_type, value):
        if value_type == "amount":
            return Wad(value)
        if value_type == "address":
            return AddressBook.instance.get_name(value)
        return value


class TestCurrency:
    __test__ = False

    def __init__(self, owner="Owner", name="Test Currency", symbol="TEST", initial_supply=Wad(0)):
        self.owner = AddressBook.instance.get_account(owner)
        self.contract = brownie.TestCurrency.deploy(initial_supply, {"from": self.owner})

    total_supply = MethodAdapter((), "amount")
    mint = MethodAdapter((("recipient", "address"), ("amount", "amount")))
    burn = MethodAdapter((("recipient", "address"), ("amount", "amount")))
    balance_of = MethodAdapter((("account", "address"), ), "amount")
    transfer = MethodAdapter((
        ("sender", "msg.sender"), ("recipient", "address"), ("amount", "amount")
    ), "bool")

    allowance = MethodAdapter((("owner", "address"), ("spender", "address")), "amount")
    approve = MethodAdapter((("owner", "msg.sender"), ("spender", "address"), ("amount", "amount")),
                            "bool")

    transfer_from = MethodAdapter((
        ("spender", "msg.sender"), ("sender", "address"), ("recipient", "address"), ("amount", "amount")
    ), "bool")

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
