from decimal import Decimal

WAD = 10**18
RAY = 10**27


class Wad(int):
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

    def equal(self, other, decimal_digits=4):
        return abs(other - self) < (10**(18-decimal_digits))

    @classmethod
    def from_value(cls, value):
        if type(value) == str:
            value = Decimal(value)
        return cls(int(value * WAD))

    def to_float(self):
        return int(self) / WAD

    def to_decimal(self):
        return Decimal(int(self)) / Decimal(WAD)


class Ray(int):
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

    def equal(self, other, decimal_digits=8):
        return abs(other - self) < (10**(27-decimal_digits))

    @classmethod
    def from_value(cls, value):
        if type(value) == str:
            value = Decimal(value)
        return cls(int(value * RAY))

    def to_float(self):
        return int(self) / RAY

    def to_decimal(self):
        return Decimal(int(self)) / Decimal(RAY)


_R = Ray.from_value
_W = Wad.from_value
