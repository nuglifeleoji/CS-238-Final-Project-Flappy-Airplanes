"""The Flappy Airplanes POMDP.

Dynamics (one decision per slot, x_t = t):

    v_{t+1} = u            if a_t = FLAP (needs fuel >= 1)
            = v_t - g      otherwise
    y_{t+1} = y_t + v_{t+1}           (crash if y_{t+1} <= 0 or >= Y)
    f_{t+1} = min(F_max, f_t - b_t + e_t)

The plane crashes moving into slot x+1 if it touches the ground/ceiling or the
slot holds an obstacle with y_{t+1} outside the safe gap (lo, hi).  A fuel drop
in slot x+1 is collected iff |y_{t+1} - y_fuel| <= r.  Reward is +1 per slot
advanced; the return is the distance flown (L if the course is completed).
"""
from collections import namedtuple
from dataclasses import dataclass

from .config import COAST, FLAP, DEFAULT_CONFIG, GameConfig
from .course import Course

# One visible slot.  gap = (lo, hi) safe interval if there is an obstacle, else None.
# fuel = altitude of a fuel drop in this slot, else None.
Slot = namedtuple("Slot", ["x", "gap", "fuel"])


@dataclass
class Observation:
    t: int            # time step (== x)
    x: int            # current slot
    y: float          # altitude
    v: float          # vertical velocity, + is up
    fuel: int         # fuel units on board
    g: float          # gravity of this course (known)
    window: list      # [Slot] for slots x+1 .. min(x+D, L)

    @property
    def can_flap(self):
        return self.fuel >= 1

    def __repr__(self):
        return (f"Observation(t={self.t}, y={self.y:.2f}, v={self.v:.2f}, "
                f"fuel={self.fuel}, g={self.g}, window=<{len(self.window)} slots>)")


def step_dynamics(y, v, action, g, cfg: GameConfig = DEFAULT_CONFIG):
    """Deterministic plane dynamics (no terrain). Returns (y_next, v_next), unclipped.

    Useful for model-based planning: the next state crashes if
    y_next <= 0 or y_next >= cfg.Y, or if it falls outside an obstacle gap.
    """
    v2 = cfg.u if action == FLAP else v - g
    return y + v2, v2


class FlappyEnv:
    """Gym-style environment for a single course.

    >>> env = FlappyEnv(course)
    >>> obs = env.reset()
    >>> obs, reward, done, info = env.step(FLAP)
    """

    def __init__(self, course: Course, cfg: GameConfig = DEFAULT_CONFIG):
        self.course = course
        self.cfg = cfg
        self.L = course.L
        self.g = course.g
        gaps = course.gap_array()
        fuel = course.fuel_array()
        self._slots = [Slot(x, gaps[x], fuel[x]) for x in range(self.L + 1)]
        self.reset()

    # ------------------------------------------------------------------
    def public_info(self):
        """Constants a policy is allowed to know (everything except p and unseen terrain)."""
        c = self.cfg
        return {
            "level": self.course.level, "name": self.course.name,
            "L": self.L, "g": self.g, "u": c.u, "Y": c.Y,
            "F_max": c.F_max, "F0": c.F0, "r": c.r, "D": c.D,
            "y0": c.y0, "v0": c.v0,
        }

    def reset(self):
        c = self.cfg
        self.x = 0
        self.y = float(c.y0)
        self.v = float(c.v0)
        self.fuel = int(c.F0)
        self.done = False
        self.crash = None
        self.flaps = 0
        self.invalid_flaps = 0
        self.collected = []
        return self.observe()

    def observe(self):
        hi = min(self.x + self.cfg.D, self.L)
        return Observation(t=self.x, x=self.x, y=self.y, v=self.v, fuel=self.fuel,
                           g=self.g, window=self._slots[self.x + 1: hi + 1])

    def step(self, action):
        if self.done:
            raise RuntimeError("step() called on a finished episode; call reset()")
        c = self.cfg
        a = FLAP if action == FLAP else COAST
        if a == FLAP and self.fuel < 1:
            a = COAST
            self.invalid_flaps += 1

        if a == FLAP:
            v2 = c.u
            fuel = self.fuel - 1
            self.flaps += 1
        else:
            v2 = self.v - self.g
            fuel = self.fuel
        y2 = self.y + v2
        x2 = self.x + 1

        crash = None
        if y2 <= 0.0:
            crash, y2 = "ground", 0.0
        elif y2 >= c.Y:
            crash, y2 = "ceiling", c.Y
        slot = self._slots[x2]
        if crash is None and slot.gap is not None and not (slot.gap[0] < y2 < slot.gap[1]):
            crash = "obstacle"

        collected = False
        if crash is None and slot.fuel is not None and abs(y2 - slot.fuel) <= c.r:
            fuel = min(c.F_max, fuel + 1)
            collected = True
            self.collected.append(x2)

        self.x, self.y, self.v, self.fuel = x2, y2, v2, fuel
        self.crash = crash
        self.done = crash is not None or x2 >= self.L
        reward = 0 if crash else 1
        info = {"action": a, "crash": crash, "collected": collected,
                "distance": self.distance}
        return self.observe(), reward, self.done, info

    @property
    def distance(self):
        """Slots successfully advanced so far."""
        return self.x - 1 if self.crash else self.x
