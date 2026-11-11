"""Rollout baseline (Kochenderfer et al., Ch. 9: rollout with a heuristic base policy).

At every step, for each first action a0 in {COAST, FLAP} and each target offset,
simulate the deterministic dynamics over the visible window using a hop-tracking
base policy, and pick the first action of the best rollout.  It only uses what
is observable: the visible window, gravity, and the plane's own state.  It
ignores the unknown fuel abundance p (a POMDP-aware policy should do better).
"""
from flappy import COAST, FLAP

OFFSETS = (-6.0, 0.0, 6.0)


class Policy:
    def reset(self, info):
        self.u, self.g, self.Y = info["u"], info["g"], info["Y"]
        self.r, self.Fmax = info["r"], info["F_max"]
        self.hop = self.u ** 2 / (2 * self.g)

    def act(self, obs):
        if obs.fuel < 1:
            return COAST
        W = obs.window
        n = len(W)
        if n == 0:
            return COAST
        gaps = [s.gap for s in W]
        fuels = [s.fuel for s in W]
        nxt = [None] * (n + 1)                      # next obstacle gap at/after index i
        for i in range(n - 1, -1, -1):
            nxt[i] = gaps[i] if gaps[i] is not None else nxt[i + 1]

        best_a, best_score = COAST, -1e18
        for a0 in (COAST, FLAP):
            for off in OFFSETS:
                s = self._rollout(obs.y, obs.v, obs.fuel, a0, off, gaps, fuels, nxt, n)
                if s > best_score + 1e-9:
                    best_score, best_a = s, a0
        return best_a

    def _rollout(self, y, v, f, a0, off, gaps, fuels, nxt, n):
        u, g, Y, r, Fmax, hop = self.u, self.g, self.Y, self.r, self.Fmax, self.hop
        for k in range(n):
            if k == 0:
                a = a0
            else:
                ng = nxt[k]
                if ng is None:
                    target = 0.45 * Y + off
                else:
                    lo, hi = ng
                    target = max(lo + 2.0, min((lo + hi) / 2 - hop / 2 + off, hi - hop - 2.0))
                a = FLAP if (y + v - g < target) else COAST
                gk = gaps[k]
                if a == FLAP and gk is not None and y + u >= gk[1] - 0.5:
                    a = COAST
            if a == FLAP and f >= 1:
                v = u
                f -= 1
            else:
                v = v - g
            y = y + v
            if y <= 0 or y >= Y:
                return -1000.0 + k
            gk = gaps[k]
            if gk is not None and not (gk[0] < y < gk[1]):
                return -1000.0 + k
            fk = fuels[k]
            if fk is not None and abs(y - fk) <= r:
                f = min(Fmax, f + 1)
        return 10.0 * f - 0.1 * abs(y - 0.5 * Y)
