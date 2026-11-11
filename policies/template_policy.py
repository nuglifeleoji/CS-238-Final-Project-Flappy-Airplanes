"""
Flappy Airplanes — POLICY SUBMISSION TEMPLATE
=============================================

Copy this file, rename it (e.g. `pomcp_policy.py`), and implement `act`.
A submission is ONE .py file that defines a class named `Policy`:

    class Policy:
        def __init__(self):            # called once per run (load weights here)
        def reset(self, info):         # called at the start of EVERY level
        def act(self, obs) -> int:     # called once per time step, return COAST (0) or FLAP (1)

The same Policy instance flies all 20 levels in order, so you may carry
knowledge across levels (but the hidden fuel abundance p differs per course).

info : dict — public constants of the current level
    level, name   level number (1..20) and name
    L             course length in slots (completing the course = flying L slots)
    g             gravity of this course            (known)
    u             vertical velocity right after a flap
    Y             ceiling altitude (ground = 0)     touching either = crash
    F_max, F0     tank capacity, starting fuel
    r             fuel pickup radius: collected iff |y - y_fuel| <= r in that slot
    D             look-ahead horizon (slots)

obs : flappy.Observation
    obs.t / obs.x   current step == current slot
    obs.y, obs.v    altitude, vertical velocity (+ is up)
    obs.fuel        fuel on board (FLAP with 0 fuel is treated as COAST)
    obs.g           gravity
    obs.window      list of Slot(x, gap, fuel) for slots x+1 .. x+D
                      gap  = (lo, hi): an obstacle; you survive the slot iff lo < y < hi
                             None    : no obstacle
                      fuel = altitude of a fuel drop in that slot, or None
    NOT observed: the fuel abundance p and terrain beyond the horizon.

Dynamics (deterministic given the action; see flappy/env.py):
    v' = u if FLAP else v - g ;  y' = y + v' ;  f' = min(F_max, f - flap + collected)

Helpers you may import:  from flappy import COAST, FLAP, step_dynamics

Run it:
    python run.py policies/your_policy.py           # headless, prints a report
    python server.py                                # UI: drop the file in the browser

This template is a working baseline: a "hop tracker" that keeps the plane
bouncing just below the middle of the next gap.
"""
from flappy import COAST, FLAP


class Policy:
    def __init__(self):
        pass

    def reset(self, info):
        self.u = info["u"]
        self.g = info["g"]
        self.Y = info["Y"]

    def act(self, obs):
        if obs.fuel < 1:
            return COAST
        hop = self.u ** 2 / (2 * self.g)          # height gained by one flap
        target = 0.45 * self.Y
        for slot in obs.window:                    # aim for the next obstacle's gap
            if slot.gap is not None:
                lo, hi = slot.gap
                target = max(lo + 2.0, min((lo + hi) / 2 - hop / 2, hi - hop - 2.0))
                break
        # flap only when coasting one more step would drop us below the target
        return FLAP if obs.y + obs.v - self.g < target else COAST
