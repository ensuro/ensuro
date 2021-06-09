from unittest import TestCase
import pytest
from decimal import Decimal
from prototype.wadray import _W, _R


class TestWad(TestCase):

    def test_from_value(self):
        assert _W(1) == 10**18
        assert abs(int(_W(1.1)) - (10**18 + 10**17)) < 1000  # float precision problems
        assert _W("1.01") == (10 ** 18 + 10 ** 16)
        assert _W(Decimal("1.001")) == (10 ** 18 + 10 ** 15)

    def test_operations(self):
        assert (_W(1) + _W(1)) == _W(2)
        assert (_W(4) - _W(1)) == _W(3)
        assert (_W(8) // _W(2)) == _W(4)
        assert (_W(5) * _W(8)) == _W(40)
        assert (_W(9) // _W(2)) == _W("4.5")
        assert -_W(5) == _W(-5)

        with pytest.raises(AssertionError):
            _W(1) + 1
        with pytest.raises(AssertionError):
            _W(1) * 1
        with pytest.raises(AssertionError):
            _W(1) // 1

    def test_string_representation(self):
        assert str(_W(0)) == "0"
        assert str(_W("1.1")) == "1.1"
        assert str(_W(1) // _W(4)) == "0.25"
        assert repr(_W(1) // _W(4)) == "0.25"

    def test_to_ray(self):
        assert _W(1).to_ray() == _R(1)

    def test_equal(self):
        assert (_W(1) // _W(3)).equal(_W("0.3333"))
        assert not (_W(1) // _W(3)).equal(_W("0.3335"))
