"""Courses: terrain layout, procedural generation, and the train / val / test split.

A course is laid out on slots x = 0, 1, ..., L.  Each slot may hold

* an obstacle, stored as the *safe gap* (lo, hi): the plane survives the slot
  only if lo < y < hi.  A pipe pair has 0 < lo < hi < Y, a tower from the
  ground has hi = Y, and a column hanging from the ceiling has lo = 0;
* a fuel drop at altitude y_fuel;
* both, or neither.

Obstacles are stored compactly as runs ``[x0, x1, lo, hi]`` (inclusive slot
range) and fuel drops as ``[x, y_fuel]``.

Generation guarantees that every obstacle is passable (with unlimited fuel):
a reference trajectory is simulated first and every gap is placed around it.
Whether the plane can *afford* that path is what fuel abundance p decides.
"""
import json
import random
from dataclasses import dataclass, field
from pathlib import Path

from .config import DEFAULT_CONFIG, GameConfig

ROOT = Path(__file__).resolve().parent.parent
LEVELS_DIR = ROOT / "levels"

NUM_LEVELS = 20
LEVEL_SEED_BASE = 238_000      # test levels:  238001 .. 238020
TRAIN_SEED_BASE = 1_000_000    # training pool
VAL_SEED_BASE = 2_000_000      # validation pool

LEVEL_NAMES = [
    "Morning Breeze", "Cloud Nine", "Paper Kite", "Tailwind", "Blue Yonder",
    "Golden Hour", "Amber Alley", "Dusk Patrol", "Ember Sky", "Last Light",
    "Moonlit Mile", "Starfield", "Neon Canyon", "Midnight Run", "Owl's Pass",
    "Thunderhead", "Squall Line", "Eye of the Storm", "Lightning Gate", "The Gauntlet",
]
THEMES = ["day", "sunset", "night", "storm"]


@dataclass
class Course:
    name: str
    seed: int
    L: int
    g: float
    p: float                      # hidden from the policy
    obstacles: list = field(default_factory=list)   # [[x0, x1, lo, hi], ...]
    fuel: list = field(default_factory=list)        # [[x, y_fuel], ...]
    difficulty: float = 0.5
    theme: str = "day"
    level: int = 0                # 1..20 for test levels, 0 otherwise

    # ---- per-slot views -------------------------------------------------
    def gap_array(self):
        """List of length L+1: (lo, hi) for obstacle slots, else None."""
        gaps = [None] * (self.L + 1)
        for x0, x1, lo, hi in self.obstacles:
            for x in range(int(x0), int(x1) + 1):
                if 0 <= x <= self.L:
                    gaps[x] = (float(lo), float(hi))
        return gaps

    def fuel_array(self):
        """List of length L+1: fuel altitude for slots with a drop, else None."""
        fuel = [None] * (self.L + 1)
        for x, y in self.fuel:
            if 0 <= int(x) <= self.L:
                fuel[int(x)] = float(y)
        return fuel

    # ---- serialisation --------------------------------------------------
    def to_dict(self):
        return {
            "level": self.level, "name": self.name, "theme": self.theme,
            "seed": self.seed, "difficulty": self.difficulty,
            "L": self.L, "g": self.g, "p": self.p,
            "obstacles": self.obstacles, "fuel": self.fuel,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            name=d["name"], seed=d["seed"], L=d["L"], g=d["g"], p=d["p"],
            obstacles=[list(o) for o in d["obstacles"]],
            fuel=[list(f) for f in d["fuel"]],
            difficulty=d.get("difficulty", 0.5), theme=d.get("theme", "day"),
            level=d.get("level", 0),
        )

    def save(self, path):
        Path(path).write_text(json.dumps(self.to_dict(), separators=(",", ":")))

    @classmethod
    def load(cls, path):
        return cls.from_dict(json.loads(Path(path).read_text()))


def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def generate_course(seed, difficulty=0.5, cfg: GameConfig = DEFAULT_CONFIG,
                    L=None, name=None, theme=None, level=0):
    """Procedurally generate a course. Same (seed, difficulty, cfg) -> same course."""
    rng = random.Random(seed)
    d = _clamp(float(difficulty), 0.0, 1.0)
    Y, u = cfg.Y, cfg.u

    if L is None:
        L = int(round((600 + 900 * d) / 50.0)) * 50
    g = round(rng.uniform(0.22 + 0.14 * d, 0.30 + 0.22 * d), 3)

    # Fuel abundance p (hidden).  "hover" is the fuel/slot needed just to hold
    # altitude; richness says how many times that the course supplies.
    hover = g / (2.0 * u)
    richness = (4.8 - 2.6 * d) * rng.uniform(0.75, 1.25)
    p = round(_clamp(richness * hover, 0.01, 0.6), 4)

    amp = u * u / (2.0 * g)            # height gained by a single flap
    margin = 2.0
    gap_base = 46.0 - 21.0 * d

    # ---- 1. reference trajectory (hop controller, unlimited fuel) --------
    t_lo, t_hi = 15.0, Y - amp - 15.0
    target = cfg.y0
    y, v = cfg.y0, cfg.v0
    ref = []
    next_change = rng.randint(50, 110)
    for x in range(L + 1):
        ref.append(y)
        if x >= next_change:
            target = _clamp(target + rng.uniform(-1, 1) * (15 + 30 * d), t_lo, t_hi)
            next_change = x + rng.randint(int(110 - 60 * d), int(170 - 80 * d))
        v = u if (y + v - g) < target else v - g
        y = _clamp(y + v, 0.5, Y - 0.5)

    # ---- 2. obstacles placed around the reference path ------------------
    obstacles = []
    s_min, s_max = int(round(46 - 24 * d)), int(round(70 - 34 * d))
    w_min, w_max = 3, int(round(5 + 4 * d))
    x = 45 + rng.randint(0, 15)
    while True:
        w = rng.randint(w_min, w_max)
        x1 = x + w - 1
        if x1 > L - 8:
            break
        seg = ref[x:x1 + 1]
        ymin, ymax = min(seg), max(seg)
        G = max(gap_base * rng.uniform(0.9, 1.1), ymax - ymin + 2 * margin)
        kind = rng.random()
        if kind < 0.16 and ymin - margin > 14:                  # tower from the ground
            lo = rng.uniform(max(8.0, ymin - margin - 25), ymin - margin)
            hi = Y
        elif kind < 0.32 and ymax + margin < Y - 14:            # column from the ceiling
            lo = 0.0
            hi = rng.uniform(ymax + margin, min(Y - 8.0, ymax + margin + 25))
        else:                                                   # pipe pair
            lo_min = max(0.0, ymax + margin - G)
            lo_max = max(lo_min, min(Y - G, ymin - margin))
            lo = rng.uniform(lo_min, lo_max)
            hi = min(Y, lo + G)
        obstacles.append([x, x1, round(lo, 2), round(hi, 2)])
        x = x1 + 1 + rng.randint(s_min, s_max)

    # ---- 3. fuel drops: Bernoulli(p) per slot ---------------------------
    gaps = [None] * (L + 1)
    for x0, x1, lo, hi in obstacles:
        for xx in range(x0, x1 + 1):
            gaps[xx] = (lo, hi)
    fuel = []
    for x in range(1, L + 1):
        if rng.random() < p:
            if rng.random() < 0.55:
                fy = ref[x] + rng.gauss(0, 7)
            else:
                fy = rng.uniform(6, Y - 6)
            if gaps[x] is not None:
                lo, hi = gaps[x]
                fy = _clamp(fy, lo + 2.5, hi - 2.5)
            fuel.append([x, round(_clamp(fy, 4.0, Y - 4.0), 2)])

    if theme is None:
        theme = THEMES[min(3, int(d * 4))]
    return Course(
        name=name or f"course-{seed}", seed=seed, L=L, g=g, p=p,
        obstacles=obstacles, fuel=fuel, difficulty=round(d, 4),
        theme=theme, level=level,
    )


# ---- the 20 fixed test levels ------------------------------------------
def make_level(i, cfg: GameConfig = DEFAULT_CONFIG):
    """Test level i in 1..20 (difficulty ramps from 0 to 1)."""
    d = (i - 1) / (NUM_LEVELS - 1)
    return generate_course(
        seed=LEVEL_SEED_BASE + i, difficulty=d, cfg=cfg,
        name=LEVEL_NAMES[i - 1], theme=THEMES[(i - 1) // 5], level=i,
    )


def load_level(i):
    path = LEVELS_DIR / f"level_{i:02d}.json"
    if path.exists():
        return Course.load(path)
    return make_level(i)


def load_levels(ids=None):
    ids = ids or list(range(1, NUM_LEVELS + 1))
    return [load_level(i) for i in ids]


# ---- training / validation pools (disjoint seeds from the test levels) --
def _pool(seed_base, n, d_range, cfg):
    rng = random.Random(seed_base)
    out = []
    for k in range(n):
        d = rng.uniform(*d_range)
        out.append(generate_course(seed_base + 1 + k, difficulty=d, cfg=cfg,
                                   name=f"{'train' if seed_base == TRAIN_SEED_BASE else 'val'}-{k:04d}"))
    return out


def train_courses(n=200, d_range=(0.0, 1.0), cfg: GameConfig = DEFAULT_CONFIG):
    """Training courses: replay these as often as you like."""
    return _pool(TRAIN_SEED_BASE, n, d_range, cfg)


def val_courses(n=50, d_range=(0.0, 1.0), cfg: GameConfig = DEFAULT_CONFIG):
    """Held-out validation courses (for model selection, not training)."""
    return _pool(VAL_SEED_BASE, n, d_range, cfg)
