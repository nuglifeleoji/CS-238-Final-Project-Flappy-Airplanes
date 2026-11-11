# Flappy Airplanes: CS 238 testbed

A POMDP testbed for the *Flappy Airplanes* final project. A policy is one Python
file. The testbed flies that policy through **20 fixed levels**, animates every
flight in the browser, and reports how much of each course the policy
completed.

Python 3.9+ standard library only. No `pip install` needed.

## Quick start

```bash
python server.py                                  # opens http://localhost:8000
```

Then either drop your policy `.py` onto the page, or pick one from `policies/`
and press **Run**. The policy is evaluated in a subprocess and each level is
replayed as soon as its result is ready. When the last level finishes, the
report opens automatically.

Headless (no browser):

```bash
python run.py policies/rollout_policy.py          # prints the report table
python run.py my_policy.py --levels 1-5           # a subset of levels
```

Every run is saved to `results/<run-id>.jsonl` and shows up on the in-app
leaderboard. To replay a saved run, open `http://localhost:8000/?run=<run-id>`.
You can add `&level=12`, `&sensors=1`, `&speed=4` or `&report=1`.

## Writing a policy

Copy `policies/template_policy.py`. A submission defines one class:

```python
from flappy import COAST, FLAP

class Policy:
    def __init__(self):          # once per run (load weights here)
        ...
    def reset(self, info):       # at the start of every level
        ...                      # info: level, name, L, g, u, Y, F_max, F0, r, D
    def act(self, obs):          # every step -> COAST (0) or FLAP (1)
        ...
```

`obs` holds `t`/`x` (step = slot), `y`, `v`, `fuel`, `g` and `window`. The
`window` is the next `D` slots, each a `Slot(x, gap, fuel)`:

* `gap = (lo, hi)` means an obstacle in that slot. The plane survives the slot only if `lo < y < hi`.
* `fuel = y_fuel` means a fuel drop. It is collected if `|y - y_fuel| <= r` in that slot.

The policy does **not** observe the fuel abundance `p` or any terrain beyond
the horizon. One `Policy` instance flies all 20 levels in order.

If `act` raises an exception, that level ends where it failed and the run
moves on to the next level. The error is shown in the UI. Each level has a
120-second time limit (`--time-limit`).

> Honor system: the level files in `levels/` contain the hidden `p`. A
> submission must not read them.

## The model (matches the proposal)

| | |
|---|---|
| dynamics | `v' = u` if FLAP (costs 1 fuel), else `v - g`;  `y' = y + v'` |
| crash | `y' <= 0` (ground), `y' >= Y` (ceiling), or outside the gap of an obstacle slot |
| fuel | `f' = min(F_max, f - flap + collected)`. FLAP with 0 fuel counts as COAST |
| reward | +1 per slot advanced. Return = distance flown (`L` if completed) |
| constants | `Y=100, u=3.5, F_max=12, F0=10, r=4, D=40` (`flappy/config.py`) |
| per course | gravity `g` (known), fuel abundance `p` (hidden), length `L`, terrain |

Reported metrics: per-level **completion = distance / L**, levels cleared, and
**mean completion** over all 20 levels (the headline score).

## Levels and data splits

* **Test levels 1–20**: `levels/level_XX.json`, with difficulty rising from 1
  to 20. Gravity, gap width, obstacle density and fuel scarcity all increase.
  There are four themes: day, sunset, night and storm.
* **Train / validation pools**: generated with seeds that do not overlap the test levels.

```python
from flappy import FlappyEnv, train_courses, val_courses, FLAP, COAST

for course in train_courses(200):          # replay as often as you like
    env = FlappyEnv(course)
    obs = env.reset()
    done = False
    while not done:
        obs, reward, done, info = env.step(my_action(obs))
```

`flappy.step_dynamics(y, v, action, g)` exposes the deterministic plane model
for planning (MCTS, POMCP, rollouts, …). Run `python scripts/make_levels.py`
only if you change the generator or `GameConfig`. It rewrites the test
levels, so results from before the change are no longer comparable.

## Baselines

| policy | idea | levels cleared | mean completion |
|---|---|---|---|
| `random_policy.py` | random flaps | 0 / 20 | 6.9% |
| `template_policy.py` | hop toward the next gap | 1 / 20 | 37.2% |
| `rollout_policy.py` | one-step lookahead + heuristic rollouts over the window | 10 / 20 | 75.5% |

None of the baselines reasons about the unknown `p`. That gap is what the
project is about.

## UI controls

`Space` play/pause (or flap in manual mode) · `←/→` previous/next level · `1–5` speed ·
`S` sensors overlay (safe gaps, pickup windows, predicted coast/flap arcs) ·
`H` show/hide terrain beyond the horizon · **Play** = fly a level yourself
(`R` retry, `N` next, `Esc` quit).

## Layout

```
flappy/            environment package: config, course generator, env, evaluator
levels/            the 20 fixed test levels (JSON)
policies/          template + baseline policies
web/               UI (canvas renderer, JS physics mirror for manual play)
server.py          local server + JSON API
run.py             headless evaluation
results/           saved runs (*.jsonl), created on first run
submissions/       copies of files uploaded through the UI
```
# CS-238-Final-Project-Flappy-Airplanes
