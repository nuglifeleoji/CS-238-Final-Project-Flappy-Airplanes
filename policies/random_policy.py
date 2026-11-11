"""Lower-bound baseline: flap at random, a bit more often when low."""
import random

from flappy import COAST, FLAP


class Policy:
    def __init__(self):
        self.rng = random.Random(0)

    def reset(self, info):
        self.Y = info["Y"]

    def act(self, obs):
        p_flap = 0.15 if obs.y < 0.5 * self.Y else 0.03
        return FLAP if self.rng.random() < p_flap else COAST
