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

    def __str__(self):
        return str(Decimal(self) / Decimal(WAD))

    def to_ray(self):
        return Ray(int(self) * 10**9)

    @classmethod
    def from_value(cls, value):
        if type(value) == str:
            value = Decimal(value)
        return cls(int(value * WAD))


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

    def __str__(self):
        return str(Decimal(self) / Decimal(RAY))

    def to_wad(self):
        return Wad(int(self) // 10**9)

    @classmethod
    def from_value(cls, value):
        if type(value) == str:
            value = Decimal(value)
        return cls(int(value * RAY))
