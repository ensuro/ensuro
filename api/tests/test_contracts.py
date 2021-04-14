from unittest import TestCase
import pytest
from m9g.fields import IntField
from ..wadray import _W
from ..contracts import Contract, WadField, external, ERC20Token, RevertError


class MyTestContract(Contract):
    counter = IntField(default=10)
    amount = WadField(default=_W(0))

    @external
    def inc_counter(self, qty):
        self.counter += qty
        if qty <= 0:
            raise RevertError("qty cannot be equal or less than zero")

    @external
    def inc_amount(self, amount):
        self.amount += amount
        if amount <= _W(0):
            raise RevertError("amount cannot be equal or less than zero")


class TestReversion(TestCase):

    def test_revert_rolls_back_changes(self):
        tcontract = MyTestContract()
        assert tcontract.counter == 10
        assert tcontract.amount == _W(0)

        tcontract.inc_counter(5)
        assert tcontract.counter == 15

        with pytest.raises(RevertError):
            tcontract.inc_counter(-5)

        assert tcontract.counter == 15

        tcontract.inc_amount(_W(5))
        assert tcontract.amount == _W(5)

        with pytest.raises(RevertError):
            tcontract.inc_amount(_W(-5))

        assert tcontract.amount == _W(5)


class TestERC20Token(TestCase):

    def _validate_total_supply(self, token):
        "Validates total_supply equals to the sum of al users balances"
        total_supply = token.total_supply()
        total_supply_calculated = sum(token.balances.values(), _W(0))
        assert total_supply == total_supply_calculated

    def test_total_supply(self):
        token = ERC20Token(owner="Owner", name="TEST", symbol="TEST", initial_supply=_W(1000))
        assert token.total_supply() == _W(1000)
        assert token.balance_of("Owner") == _W(1000)
        self._validate_total_supply(token)

        token.mint("LP1", _W(200))
        assert token.balance_of("LP1") == _W(200)
        assert token.total_supply() == _W(1200)
        self._validate_total_supply(token)

        token.burn("Owner", _W(100))
        assert token.total_supply() == _W(1100)

        with pytest.raises(RevertError):
            token.burn("Owner", _W(1000))

    def test_transfer(self):
        token = ERC20Token(owner="Owner", name="TEST", symbol="TEST", initial_supply=_W(1000))
        token.transfer("Owner", "Guillo", _W(400))
        assert token.balance_of("Owner") == _W(600)
        assert token.balance_of("Guillo") == _W(400)
        self._validate_total_supply(token)

        with pytest.raises(RevertError):
            token.transfer("Guillo", "Marco", _W(450))

        assert token.balance_of("Guillo") == _W(400)  # unchanged
        token.transfer("Owner", "Marco", _W(600))
        assert token.balance_of("Owner") == _W(0)
        assert token.balance_of("Marco") == _W(600)
        assert token.total_supply() == _W(1000)
        self._validate_total_supply(token)

    def test_approve_flow(self):
        token = ERC20Token(owner="Owner", name="TEST", symbol="TEST", initial_supply=_W(2000))
        token.approve("Owner", "Spender", _W(500))
        assert token.allowance("Owner", "Spender") == _W(500)

        token.transfer_from("Spender", "Owner", "Guillo", _W(200))
        assert token.balance_of("Guillo") == _W(200)
        assert token.balance_of("Owner") == _W(1800)
        assert token.allowance("Owner", "Spender") == _W(300)

        with pytest.raises(RevertError):
            token.transfer_from("Spender", "Owner", "Luca", _W(400))

        token.transfer_from("Spender", "Owner", "Giacomo", _W(300))
        assert token.allowance("Owner", "Spender") == _W(0)

        with pytest.raises(RevertError):
            token.transfer_from("Spender", "Owner", "Luca", _W(1))

        assert token.balance_of("Guillo") == _W(200)
        assert token.balance_of("Owner") == _W(1500)
        assert token.balance_of("Giacomo") == _W(300)
        assert token.balance_of("Luca") == _W(0)
