"""Regenerate the 20 fixed test levels into levels/level_XX.json.

    python scripts/make_levels.py

Only needed if you change the generator or GameConfig; the JSON files are the
source of truth for evaluation so results stay comparable across runs.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flappy.course import LEVELS_DIR, NUM_LEVELS, make_level  # noqa: E402

if __name__ == "__main__":
    LEVELS_DIR.mkdir(exist_ok=True)
    for i in range(1, NUM_LEVELS + 1):
        c = make_level(i)
        c.save(LEVELS_DIR / f"level_{i:02d}.json")
        print(f"level {i:2d}  {c.name:<18} theme={c.theme:<6} L={c.L:<5} g={c.g:.3f} "
              f"p={c.p:.3f} obstacles={len(c.obstacles):<3} fuel={len(c.fuel)}")
