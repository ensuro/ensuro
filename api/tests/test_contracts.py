from unittest import TestCase
import pytest
from m9g.fields import IntField
from ..wadray import _W
from ..contracts import Contract, WadField, external, ERC20Token, RevertError, view, ERC721Token


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

    @view
    def bad_view(self):
        self.counter += 1

    @view
    def bad_view_two(self):
        self.inc_counter(5)

    @view
    def good_view(self):
        return self.amount


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

    def test_view_cannot_modify(self):
        tcontract = MyTestContract()
        with pytest.raises(AssertionError, match="Contract .* modified in view"):
            tcontract.bad_view()

    def test_view_cannot_call_external(self):
        tcontract = MyTestContract()
        with pytest.raises(RuntimeError):
            tcontract.bad_view_two()


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


class TestERC721Token(TestCase):

    def test_mint_burn(self):
        nft = ERC721Token(owner="Owner", name="TEST", symbol="TEST")

        nft.mint("CUST1", 1234)
        assert nft.balance_of("CUST1") == 1
        nft.mint("CUST1", 1235)
        assert nft.balance_of("CUST1") == 2
        assert nft.owner_of(1234) == "CUST1"
        assert nft.owner_of(1235) == "CUST1"
        nft.burn("CUST1", 1235)
        assert nft.balance_of("CUST1") == 1
        assert nft.owner_of(1235) is None
        nft.burn("CUST1", 1234)
        assert nft.balance_of("CUST1") == 0

    def test_transfer(self):
        nft = ERC721Token(owner="Owner", name="TEST", symbol="TEST")

        nft.mint("CUST1", 1234)
        assert nft.balance_of("CUST1") == 1
        assert nft.owner_of(1234) == "CUST1"
        nft.transfer_from("CUST1", "CUST1", "CUST2", 1234)
        assert nft.balance_of("CUST1") == 0
        assert nft.balance_of("CUST2") == 1
        assert nft.owner_of(1234) == "CUST2"

    def test_approve_transfer(self):
        nft = ERC721Token(owner="Owner", name="TEST", symbol="TEST")

        nft.mint("CUST1", 1234)
        assert nft.balance_of("CUST1") == 1
        assert nft.owner_of(1234) == "CUST1"
        nft.approve("CUST1", "SPEND", 1234)
        assert nft.get_approved(1234) == "SPEND"

        nft.transfer_from("SPEND", "CUST1", "CUST2", 1234)
        assert nft.balance_of("CUST1") == 0
        assert nft.balance_of("CUST2") == 1
        assert nft.owner_of(1234) == "CUST2"

    def test_approve_for_all(self):
        nft = ERC721Token(owner="Owner", name="TEST", symbol="TEST")

        nft.mint("CUST1", 1234)
        nft.mint("CUST1", 1235)
        nft.mint("CUST1", 1236)
        assert nft.balance_of("CUST1") == 3
        assert not nft.is_approved_for_all("CUST1", "SPEND")
        nft.set_approval_for_all("CUST1", "SPEND", True)
        assert nft.is_approved_for_all("CUST1", "SPEND")

        nft.transfer_from("SPEND", "CUST1", "CUST2", 1234)
        assert nft.balance_of("CUST1") == 2
        assert nft.balance_of("CUST2") == 1

        with pytest.raises(RevertError):
            nft.transfer_from("SPEND", "CUST2", "CUST3", 1236)
        nft.transfer_from("SPEND", "CUST1", "CUST2", 1236)
        assert nft.owner_of(1234) == "CUST2"
        assert nft.owner_of(1236) == "CUST2"
        assert nft.owner_of(1235) == "CUST1"
        assert nft.balance_of("CUST1") == 1
        assert nft.balance_of("CUST2") == 2
        nft.set_approval_for_all("CUST1", "SPEND", False)

        with pytest.raises(RevertError, match="ERC721: transfer caller is not owner nor approved"):
            nft.transfer_from("SPEND", "CUST1", "CUST2", 1235)
