import time
from functools import wraps
from m9g import Model
from m9g.fields import IntField, DictField, StringField, TupleField
from .wadray import Wad, Ray


class RevertError(Exception):
    pass


class WadField(IntField):
    FIELD_TYPE = Wad


class RayField(IntField):
    FIELD_TYPE = Ray


class AddressField(StringField):
    pass


def external(method):
    @wraps(method)
    def rollback_on_error(self, *args, **kwargs):
        self.push_version()
        try:
            ret = method(self, *args, **kwargs)
        except Exception:
            self.pop_version()
            raise
        return ret

    return rollback_on_error


def view(method):
    @wraps(method)
    def verify_unchanged(self, *args, **kwargs):
        before = self.serialize("pydict")
        try:
            ret = method(self, *args, **kwargs)
        finally:
            after = self.serialize("pydict")
            if before != after:
                raise RuntimeError("Object changed in a view")
        return ret

    return verify_unchanged


class ContractManager:
    def __init__(self):
        self._contracts = {}

    def add_contract(self, pk, contract):
        self._contracts[pk] = contract

    def findByPrimaryKey(self, pk):
        return self._contracts[pk]


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

    @external
    def mint(self, address, amount):
        self.balances[address] = self.balances.get(address, self.ZERO) + amount
        self._total_supply += amount

    @external
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

    def transfer(self, sender, recipient, amount):
        if self.balance_of(sender) < amount:
            raise RevertError("Not enought balance")
        elif self.balances[sender] == amount:
            del self.balances[sender]
        else:
            self.balances[sender] -= amount
        self.balances[recipient] = self.balances.get(recipient, self.ZERO) + amount
        return True

    def allowance(self, owner, spender):
        return self.allowances.get((owner, spender), self.ZERO)

    def approve(self, owner, spender, amount):
        if amount == self.ZERO:
            try:
                del self.allowances[(owner, spender)]
            except KeyError:
                pass
        else:
            self.allowances[(owner, spender)] = amount

    def transfer_from(self, spender, sender, recipient, amount):
        allowance = self.allowances.get((sender, spender), self.ZERO)
        if allowance < amount:
            raise RevertError("Not enought allowance")
        self.transfer(sender, recipient, amount)
        if amount == allowance:
            del self.allowances[(sender, spender)]
        else:
            self.allowances[(sender, spender)] -= amount
        return True

    def total_supply(self):
        return self._total_supply
