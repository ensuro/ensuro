from contextlib import contextmanager
from decimal import Decimal

WAD = 10**18
RAY = 10**27


class Wad(int):
    DEFAULT_EQ_PRECISION = 4

    def __mul__(self, other):
        assert isinstance(other, Wad)
        return Wad(int(self) * int(other) // WAD)

    def __floordiv__(self, other):
        assert isinstance(other, Wad)
        return Wad(int(self) * WAD // other)

    def __add__(self, other):
        assert isinstance(other, Wad)
        return Wad(int(self) + int(other))

    def __sub__(self, other):
        assert isinstance(other, Wad)
        return Wad(int(self) - int(other))

    def __neg__(self):
        return Wad(-int(self))

    def __str__(self):
        return str(Decimal(self) / Decimal(WAD))

    def __repr__(self):
        return str(Decimal(self) / Decimal(WAD))

    def to_ray(self):
        return Ray(int(self) * 10**9)

    def equal(self, other, decimals=None):
        if decimals is None:
            decimals = self.DEFAULT_EQ_PRECISION
        return abs(other - self) < (10**(18-decimals))

    def assert_equal(self, other, decimals=None):
        if decimals is None:
            decimals = self.DEFAULT_EQ_PRECISION
        diff = abs(other - self)
        max_diff = (10**(18-decimals))
        assert diff < max_diff, f"{self} != {other} diff {self - other}"

    @classmethod
    def from_value(cls, value):
        if type(value) == str:
            value = Decimal(value)
        elif type(value) == cls:
            return value
        return cls(int(value * WAD))

    def to_float(self):
        return int(self) / WAD

    def to_decimal(self):
        return Decimal(int(self)) / Decimal(WAD)


class Ray(int):
    DEFAULT_EQ_PRECISION = 4

    def __mul__(self, other):
        assert isinstance(other, Ray)
        return Ray(int(self) * int(other) // RAY)

    def __floordiv__(self, other):
        assert isinstance(other, Ray)
        return Ray(int(self) * RAY // other)

    def __add__(self, other):
        assert isinstance(other, Ray)
        return Ray(int(self) + int(other))

    def __sub__(self, other):
        assert isinstance(other, Ray)
        return Ray(int(self) - int(other))

    def __neg__(self):
        return Ray(-int(self))

    def __str__(self):
        return str(Decimal(self) / Decimal(RAY))

    def __repr__(self):
        return str(Decimal(self) / Decimal(RAY))

    def to_wad(self):
        return Wad(int(self) // 10**9)

    def equal(self, other, decimals=None):
        if decimals is None:
            decimals = self.DEFAULT_EQ_PRECISION
        return abs(other - self) < (10**(27-decimals))

    def assert_equal(self, other, decimals=4):
        if decimals is None:
            decimals = self.DEFAULT_EQ_PRECISION
        diff = abs(other - self)
        max_diff = (10**(27-decimals))
        assert diff < max_diff, f"{self} != {other} diff {self - other}"

    @classmethod
    def from_value(cls, value):
        if type(value) == str:
            value = Decimal(value)
        elif type(value) == cls:
            return value
        return cls(int(value * RAY))

    def to_float(self):
        return int(self) / RAY

    def to_decimal(self):
        return Decimal(int(self)) / Decimal(RAY)


_R = Ray.from_value
_W = Wad.from_value


@contextmanager
def set_precision(cls, precision):
    old_precision = cls.DEFAULT_EQ_PRECISION
    cls.DEFAULT_EQ_PRECISION = precision
    try:
        yield
    finally:
        cls.DEFAULT_EQ_PRECISION = old_precision
