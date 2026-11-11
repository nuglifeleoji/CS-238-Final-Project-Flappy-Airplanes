"""Global game constants shared by every course.

Per-course quantities (gravity g, hidden fuel abundance p, length L, terrain)
live in :class:`flappy.course.Course`.
"""
from dataclasses import dataclass, asdict

COAST = 0
FLAP = 1


@dataclass(frozen=True)
class GameConfig:
    Y: float = 100.0   # ceiling altitude (ground is at 0); touching either ends the flight
    u: float = 3.5     # vertical velocity immediately after a flap
    F_max: int = 12    # tank capacity
    F0: int = 10       # fuel on board at the start of every course
    r: float = 4.0     # a fuel drop is collected if |y - y_fuel| <= r in its slot
    D: int = 40        # look-ahead horizon: the plane sees slots x+1 .. x+D
    y0: float = 50.0   # starting altitude
    v0: float = 0.0    # starting vertical velocity

    def to_dict(self):
        return asdict(self)


DEFAULT_CONFIG = GameConfig()
