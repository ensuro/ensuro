import os
import time
from decimal import Decimal
from functools import wraps
from contextlib import contextmanager
from m9g import Model
from m9g.fields import IntField, DictField, StringField, TupleField, ListField
from .wadray import Wad, Ray


class RevertError(Exception):
    pass


class WadField(IntField):
    FIELD_TYPE = Wad

    def adapt(self, value):
        if type(value) in (str, float, Decimal, int):
            return Wad.from_value(value)
        elif isinstance(value, Wad):
            return value
        raise ValueError("Invalid value")


class RayField(IntField):
    FIELD_TYPE = Ray

    def adapt(self, value):
        if type(value) in (str, float, Decimal, int):
            return Ray.from_value(value)
        elif isinstance(value, Ray):
            return value
        raise ValueError("Invalid value")


class AddressField(StringField):
    pass


class ContractProxy(str):
    def _get_contract(self):
        return Contract.manager.findByPrimaryKey(self)

    def __getattr__(self, attr_name):
        return getattr(self._get_contract(), attr_name)


class ContractProxyField(AddressField):
    FIELD_TYPE = ContractProxy

    def adapt(self, value):
        if type(value) == str:
            return ContractProxy(value)
        elif value is None:
            return None
        elif isinstance(value, ContractProxy):
            return value
        elif isinstance(value, Contract):
            return ContractProxy(value.contract_id)
        raise ValueError("Invalid value")


_current_transaction = None


class RWTransaction:
    def __init__(self):
        self.modified_contract_ids = set()
        self.modified_contracts = []
        self.track_count = 0

    @contextmanager
    def track(self, contract):
        if contract.contract_id not in self.modified_contract_ids:
            self.modified_contract_ids.add(contract.contract_id)
            self.modified_contracts.append(contract)
            contract.push_version()
        self.track_count += 1
        try:
            yield self
        except RevertError:
            self.track_count -= 1
            if self.track_count == 0:
                self.archive()
                self._on_revert()
            raise
        except Exception:
            self.track_count -= 1
            if self.track_count == 0:
                self.archive()
            raise
        else:
            self.track_count -= 1
            if self.track_count == 0:
                self.archive()
                self._on_end()

    def _on_revert(self):
        while self.modified_contracts:
            contract = self.modified_contracts.pop()
            self.modified_contract_ids.remove(contract.contract_id)
            contract.pop_version()

    def _on_end(self):
        pass

    def archive(self):
        "Archives the transaction - No longer current transaction"
        global _current_transaction
        _current_transaction = None
        # TODO: keep transaction somewhere to track events for example


class ROTransaction:
    def __init__(self):
        self.modified_contracts = []
        self.serialized_contracts = {}
        self.track_count = 0

    @contextmanager
    def track(self, contract):
        if contract.contract_id not in self.serialized_contracts:
            self.serialized_contracts[contract.contract_id] = contract.serialize("pydict")
            self.modified_contracts.append(contract)
        self.track_count += 1
        try:
            yield self
        finally:
            self.track_count -= 1
            if self.track_count == 0:
                self.archive()
                self._on_end()

    def _on_end(self):
        while self.modified_contracts:
            contract = self.modified_contracts.pop()
            assert contract.serialize("pydict") == self.serialized_contracts[
                contract.contract_id
            ], f"Contract {contract.contract_id} modified in view"
            del self.serialized_contracts[contract.contract_id]

    def archive(self):
        "Archives the transaction - No longer current transaction"
        global _current_transaction
        _current_transaction = None
        # TODO: keep transaction somewhere to track events for example


def external(method):
    if os.environ.get("DISABLE_EXTERNAL", None) == "T":
        return method

    @wraps(method)
    def rollback_on_error(self, *args, **kwargs):
        global _current_transaction
        if _current_transaction is None:
            _current_transaction = RWTransaction()
        elif isinstance(_current_transaction, ROTransaction):
            raise RuntimeError("Calling external from view")

        with _current_transaction.track(self):
            return method(self, *args, **kwargs)

    return rollback_on_error


def view(method):
    if os.environ.get("DISABLE_EXTERNAL", None) == "T":
        return method

    @wraps(method)
    def verify_unchanged(self, *args, **kwargs):
        global _current_transaction
        if _current_transaction is None:
            _current_transaction = ROTransaction()

        with _current_transaction.track(self):
            return method(self, *args, **kwargs)

    return verify_unchanged


class ContractManager:
    def __init__(self):
        self._contracts = {}

    def add_contract(self, pk, contract):
        self._contracts[pk] = contract

    def findByPrimaryKey(self, pk):
        return self._contracts[pk]

    def clean_all(self):
        self._contracts = {}


class Contract(Model):
    version_format = "pydict"
    max_versions = 10
    contract_id = StringField(pk=True)

    manager = ContractManager()

    def __init__(self, contract_id=None, **kwargs):
        if contract_id is None:
            contract_id = f"{self.__class__.__name__}-{id(self)}"
        super().__init__(contract_id=contract_id, **kwargs)
        self._versions = []
        self.manager.add_contract(self.contract_id, self)

    def push_version(self, version_name=None):
        if version_name is None:
            version_name = "v%.3f" % time.time()
        serialized = self.serialize(self.version_format)
        if not hasattr(self, "_versions"):
            self._versions = [(serialized, version_name)]
        else:
            self._versions.append((serialized, version_name))
        if len(self._versions) > self.max_versions:
            self._versions.pop(0)

    def pop_version(self, version_name=None):
        if version_name is None:
            serialized, _ = self._versions.pop()
        else:
            version_index = [i for i, (_, v) in enumerate(self._versions) if v == version_name]
            serialized, _ = self._versions.pop(version_index[0])
        self.in_place_deserialize(serialized, format=self.version_format)


class ERC20Token(Contract):
    ZERO = Wad(0)

    owner = AddressField()
    name = StringField()
    symbol = StringField(default="")
    digits = IntField(default=18)
    balances = DictField(AddressField(), WadField(), default={})
    allowances = DictField(
        TupleField((AddressField(), AddressField())),
        WadField(),
        default={}
    )

    _total_supply = WadField(default=ZERO)

    def __init__(self, **kwargs):
        if "initial_supply" in kwargs:
            initial_supply = kwargs.pop("initial_supply")
        else:
            initial_supply = None
        super().__init__(**kwargs)
        if initial_supply:
            self.mint(self.owner, initial_supply)

    def mint(self, address, amount):
        self.balances[address] = self.balances.get(address, self.ZERO) + amount
        self._total_supply += amount

    def burn(self, address, amount):
        if amount == self.ZERO:
            return
        balance = self.balances.get(address, self.ZERO)
        if amount > balance:
            raise RevertError("Not enought balance to burn")
        elif amount == balance:
            del self.balances[address]
        else:
            self.balances[address] -= amount
        self._total_supply -= amount

    def balance_of(self, account):
        return self.balances.get(account, self.ZERO)

    @external
    def transfer(self, sender, recipient, amount):
        return self._transfer(sender, recipient, amount)

    def _transfer(self, sender, recipient, amount):
        if self.balance_of(sender) < amount:
            raise RevertError("Not enought balance")
        elif self.balances[sender] == amount:
            del self.balances[sender]
        else:
            self.balances[sender] -= amount
        self.balances[recipient] = self.balances.get(recipient, self.ZERO) + amount
        return True

    @view
    def allowance(self, owner, spender):
        return self.allowances.get((owner, spender), self.ZERO)

    @external
    def approve(self, owner, spender, amount):
        if amount == self.ZERO:
            try:
                del self.allowances[(owner, spender)]
            except KeyError:
                pass
        else:
            self.allowances[(owner, spender)] = amount

    @external
    def transfer_from(self, spender, sender, recipient, amount):
        allowance = self.allowances.get((sender, spender), self.ZERO)
        if allowance < amount:
            raise RevertError("Not enought allowance")
        self._transfer(sender, recipient, amount)
        if amount == allowance:
            del self.allowances[(sender, spender)]
        else:
            self.allowances[(sender, spender)] -= amount
        return True

    def total_supply(self):
        return self._total_supply


class ERC721Token(Contract):   # NFT
    ZERO = Wad(0)

    owner = AddressField()
    name = StringField()
    symbol = StringField(default="")
    owners = DictField(IntField(), AddressField(), default={})
    balances = DictField(AddressField(), IntField(), default={})
    token_approvals = DictField(IntField(), AddressField(), default={})
    # operator_approvals[A] = [OP1, OP2]
    operator_approvals = DictField(AddressField(), ListField(AddressField()), default={})

    _token_count = IntField(default=0)

    @external
    def mint(self, to, token_id):
        if token_id is None:
            self._token_count += 1
            token_id = self._token_count
        if token_id in self.owners:
            raise RevertError("Already exists")
        self.balances[to] = self.balances.get(to, 0) + 1
        self.owners[token_id] = to

    @external
    def burn(self, owner, token_id):
        if self.owners.get(token_id, None) != owner:
            raise RevertError("Not the owner")
        del self.owners[token_id]
        self.balances[owner] -= 1
        if token_id in self.token_approvals:
            del self.token_approvals[token_id]

    @view
    def balance_of(self, address):
        return self.balances.get(address, 0)

    @view
    def owner_of(self, token_id):
        if token_id not in self.owners:
            raise RevertError("ERC721: owner query for nonexistent token")
        return self.owners[token_id]

    # def token_uri

    @external
    def approve(self, sender, spender, token_id):
        assert token_id in self.owners
        assert self.owners[token_id] == sender or sender in self.operator_approvals[self.owners[token_id]]
        self.token_approvals[token_id] = spender

    @view
    def get_approved(self, token_id):
        return self.token_approvals.get(token_id, None)

    @external
    def set_approval_for_all(self, sender, operator, approved):
        if approved:
            self.operator_approvals[sender] = self.operator_approvals.get(sender, []) + [operator]
        elif sender in self.operator_approvals and operator in self.operator_approvals[sender]:
            approvals = self.operator_approvals[sender]
            approvals.remove(operator)
            if not approvals:
                del self.operator_approvals[sender]
            else:
                self.operator_approvals[sender] = approvals

    def is_approved_for_all(self, owner, operator):
        return owner in self.operator_approvals and operator in self.operator_approvals[owner]

    @external
    def transfer_from(self, sender, from_, to, token_id):
        owner = self.owners[token_id]
        if sender != owner and self.token_approvals.get(token_id, None) != sender and \
                sender not in self.operator_approvals.get(owner, []):
            raise RevertError("ERC721: transfer caller is not owner nor approved")
        return self._transfer(from_, to, token_id)

    def _transfer(self, from_, to, token_id):
        if self.owners[token_id] != from_:
            raise RevertError("ERC721: transfer of token that is not own:")
        if token_id in self.token_approvals:
            del self.token_approvals[token_id]
        self.balances[from_] -= 1
        self.balances[to] = self.balances.get(to, 0) + 1
        self.owners[token_id] = to
