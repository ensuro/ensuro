import os
import time
from decimal import Decimal
from functools import wraps
from contextlib import contextmanager
from m9g import Model
from m9g.fields import IntField, DictField, StringField, TupleField
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
        elif isinstance(value, ContractProxy):
            return value
        elif isinstance(value, Contract):
            return value.contract_id
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
