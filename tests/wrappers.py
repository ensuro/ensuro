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
    def __init__(self, eth_method, return_type, args=(), method_name=None):
        self.eth_method = eth_method
        self.return_type = return_type
        self.args = args
        self._method_name = method_name

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

    total_supply = MethodAdapter("totalSupply", "amount")
    mint = MethodAdapter("mint", "", (("recipient", "address"), ("amount", "amount")))
    burn = MethodAdapter("burn", "", (("recipient", "address"), ("amount", "amount")))
    balance_of = MethodAdapter("balanceOf", "amount", (("account", "address"), ))
    transfer = MethodAdapter("transfer", "bool", (
        ("sender", "msg.sender"), ("recipient", "address"), ("amount", "amount")
    ))

    allowance = MethodAdapter("allowance", "amount", (("owner", "address"), ("spender", "address")))
    approve = MethodAdapter("approve", "bool", (("owner", "msg.sender"), ("spender", "address"),
                                                ("amount", "amount")))

    transfer_from = MethodAdapter("transferFrom", "bool", (
        ("spender", "msg.sender"), ("sender", "address"), ("recipient", "address"), ("amount", "amount")
    ))

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

    mint = MethodAdapter("mint", "", (("to", "address"), ("token_id", "int")))
    burn = MethodAdapter("burn", "", (("owner", "msg.sender"), ("token_id", "int")))
    balance_of = MethodAdapter("balanceOf", "int", (("account", "address"), ))
    owner_of = MethodAdapter("ownerOf", "address", (("token_id", "int"), ))
    approve = MethodAdapter("approve", "bool", (
        ("sender", "msg.sender"), ("spender", "address"), ("token_id", "int")
    ))
    get_approved = MethodAdapter("getApproved", "address", (("token_id", "int"), ))
    set_approval_for_all = MethodAdapter("setApprovalForAll", "", (
        ("sender", "msg.sender"), ("operator", "address"), ("approved", "bool")
    ))
    is_approved_for_all = MethodAdapter("isApprovedForAll", "bool", (
        ("owner", "address"), ("operator", "address")
    ))
    transfer_from = MethodAdapter("transferFrom", "bool", (
        ("spender", "msg.sender"), ("from", "address"), ("to", "address"), ("token_id", "int")
    ))
    transfer = MethodAdapter("transfer", "bool", (
        ("sender", "msg.sender"), ("recipient", "address"), ("amount", "amount")
    ))
    total_supply = MethodAdapter("totalSupply", "int")
