"""Load a submitted policy file and fly it through the test levels.

Results are streamed to a JSON-lines file, one line per event:

    {"type": "meta", ...}                         run header
    {"type": "level", ...}                        one per level, includes the full trajectory
    {"type": "summary", ...}                      written when every level is done

CLI:  python -m flappy.evaluate --policy policies/rollout_policy.py --out results/x.jsonl
"""
import argparse
import importlib.util
import json
import math
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

from .config import COAST, FLAP, DEFAULT_CONFIG, GameConfig
from .course import NUM_LEVELS, load_levels
from .env import FlappyEnv

ROOT = Path(__file__).resolve().parent.parent
CRASH_TEXT = {
    None: "cleared", "obstacle": "hit obstacle", "ground": "hit ground",
    "ceiling": "hit ceiling", "error": "policy error", "timeout": "time limit",
}


# ---------------------------------------------------------------------------
class _FunctionPolicy:
    """Adapter for submissions that define module-level act(obs) [and reset(info)]."""

    def __init__(self, module):
        self._m = module

    def reset(self, info):
        if hasattr(self._m, "reset"):
            self._m.reset(info)

    def act(self, obs):
        return self._m.act(obs)


def load_policy(path):
    """Import a policy file and return an object with .reset(info) and .act(obs)."""
    path = Path(path).resolve()
    if not path.exists():
        raise FileNotFoundError(path)
    for p in (str(ROOT), str(path.parent)):
        if p not in sys.path:
            sys.path.insert(0, p)
    spec = importlib.util.spec_from_file_location(f"submitted_{path.stem}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if hasattr(module, "Policy"):
        return module.Policy()
    if hasattr(module, "act"):
        return _FunctionPolicy(module)
    raise AttributeError(f"{path.name} must define a class `Policy` (or a function `act(obs)`)")


def _parse_action(a):
    if isinstance(a, str):
        return FLAP if a.strip().upper() == "FLAP" else COAST
    return FLAP if int(a) == FLAP else COAST


# ---------------------------------------------------------------------------
def run_level(policy, course, cfg: GameConfig = DEFAULT_CONFIG, time_limit=120.0):
    """Fly one course. Returns a result dict (with the full trajectory)."""
    env = FlappyEnv(course, cfg)
    obs = env.reset()
    ys, vs, fs, acts = [obs.y], [obs.v], [obs.fuel], []
    crash, error = None, None
    t0 = time.perf_counter()
    act_time = 0.0
    try:
        if hasattr(policy, "reset"):
            policy.reset(env.public_info())
        while not env.done:
            ta = time.perf_counter()
            a = _parse_action(policy.act(obs))
            act_time += time.perf_counter() - ta
            obs, _, done, info = env.step(a)
            acts.append(info["action"])
            ys.append(obs.y), vs.append(obs.v), fs.append(obs.fuel)
            if time.perf_counter() - t0 > time_limit and not done:
                crash, error = "timeout", f"exceeded {time_limit:.0f}s on this level"
                break
        if crash is None:
            crash = env.crash
    except Exception as e:  # policy bug: the flight ends here, the run continues
        crash = "error"
        error = "".join(traceback.format_exception_only(type(e), e)).strip()
        tb = traceback.format_exc()
        error += "\n" + "\n".join(tb.strip().splitlines()[-6:])

    distance = env.distance if crash in (None, "obstacle", "ground", "ceiling") else env.x
    steps = len(acts)
    fuel_passed = sum(1 for x, _ in course.fuel if x <= env.x)
    return {
        "type": "level",
        "level": course.level, "name": course.name, "theme": course.theme,
        "L": course.L, "g": course.g, "p": course.p,
        "distance": distance,
        "completion": round(distance / course.L, 6),
        "completed": distance >= course.L,
        "crash": crash, "error": error,
        "flaps": env.flaps, "invalid_flaps": env.invalid_flaps,
        "fuel_collected": len(env.collected), "fuel_passed": fuel_passed,
        "final_fuel": env.fuel,
        "time_s": round(time.perf_counter() - t0, 4),
        "ms_per_step": round(1000 * act_time / max(1, steps), 4),
        "collected": env.collected,
        "traj": {
            "y": [round(y, 4) for y in ys],
            "v": [round(v, 4) for v in vs],
            "f": fs,
            "a": acts,
        },
    }


def summarize(results, total_time=None):
    n = len(results)
    cleared = sum(1 for r in results if r["completed"])
    mean_c = sum(r["completion"] for r in results) / n if n else 0.0
    return {
        "type": "summary",
        "n": n, "cleared": cleared,
        "mean_completion": round(mean_c, 6),
        "total_distance": sum(r["distance"] for r in results),
        "total_length": sum(r["L"] for r in results),
        "fuel_collected": sum(r["fuel_collected"] for r in results),
        "flaps": sum(r["flaps"] for r in results),
        "errors": sum(1 for r in results if r["crash"] in ("error", "timeout")),
        "time_s": round(total_time, 3) if total_time is not None else None,
    }


def evaluate(policy_path, level_ids=None, out_path=None, cfg: GameConfig = DEFAULT_CONFIG,
             time_limit=120.0, on_level=None, policy_name=None):
    """Run a policy file over the test levels; stream JSONL to out_path if given."""
    level_ids = level_ids or list(range(1, NUM_LEVELS + 1))
    courses = load_levels(level_ids)
    out = open(out_path, "w") if out_path else None

    def emit(obj):
        if out:
            out.write(json.dumps(obj, separators=(",", ":")) + "\n")
            out.flush()

    meta = {
        "type": "meta",
        "policy": policy_name or Path(policy_path).name,
        "path": str(policy_path),
        "started": datetime.now().isoformat(timespec="seconds"),
        "levels": level_ids,
        "config": cfg.to_dict(),
    }
    emit(meta)
    t0 = time.perf_counter()
    try:
        policy = load_policy(policy_path)
    except Exception as e:
        msg = "".join(traceback.format_exception(type(e), e, e.__traceback__))
        emit({"type": "fatal", "error": msg})
        if out:
            out.close()
        raise

    results = []
    for course in courses:
        res = run_level(policy, course, cfg, time_limit)
        results.append(res)
        emit(res)
        if on_level:
            on_level(res)
    summary = summarize(results, time.perf_counter() - t0)
    emit(summary)
    if out:
        out.close()
    return meta, results, summary


# ---------------------------------------------------------------------------
def _c(text, code, enable):
    return f"\033[{code}m{text}\033[0m" if enable else text


def format_level_line(r, color=True):
    pct = 100 * r["completion"]
    width = 20
    filled = int(round(width * r["completion"]))
    bar = "█" * filled + "·" * (width - filled)
    if r["completed"]:
        status, code = "✔ cleared", "32"
    elif r["crash"] in ("error", "timeout"):
        status, code = "✖ " + CRASH_TEXT[r["crash"]], "31"
    else:
        status, code = "✖ " + CRASH_TEXT.get(r["crash"], str(r["crash"])), "33" if pct >= 50 else "31"
    return (f"  {r['level']:>3}  {r['name'][:18]:<18} {r['g']:>5.3f} {r['L']:>5} "
            f"{r['distance']:>6}  {_c(bar, code, color)} {pct:6.1f}%  "
            f"{r['fuel_collected']:>3}/{r['fuel_passed']:<3}  {_c(status, code, color)}")


def format_report(meta, results, summary, color=True):
    lines = [
        "",
        _c("  FLAPPY AIRPLANES — evaluation report", "1", color),
        f"  policy: {meta['policy']}",
        "",
        f"  {'lvl':>3}  {'name':<18} {'g':>5} {'L':>5} {'dist':>6}  {'progress':<20} {'compl':>7}  {'fuel':<7}  result",
        "  " + "─" * 92,
    ]
    lines += [format_level_line(r, color) for r in results]
    lines.append("  " + "─" * 92)
    cleared = _c(f"{summary['cleared']}/{summary['n']}", "1", color)
    mean_c = _c("%.1f%%" % (100 * summary["mean_completion"]), "1", color)
    lines.append(
        f"  levels cleared: {cleared}   "
        f"mean completion: {mean_c}   "
        f"distance: {summary['total_distance']}/{summary['total_length']}   "
        f"time: {summary['time_s']:.1f}s"
    )
    errs = [r for r in results if r["error"]]
    for r in errs[:3]:
        lines.append(_c(f"  level {r['level']} error: {r['error'].splitlines()[0]}", "31", color))
    lines.append("")
    return "\n".join(lines)


def parse_levels(spec):
    """'1-20' or '1,3,5' or '4' -> list of ints."""
    ids = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            ids.extend(range(int(a), int(b) + 1))
        else:
            ids.append(int(part))
    return [i for i in ids if 1 <= i <= NUM_LEVELS]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Evaluate a Flappy Airplanes policy file.")
    ap.add_argument("--policy", required=True, help="path to the policy .py file")
    ap.add_argument("--out", default=None, help="JSONL output path")
    ap.add_argument("--levels", default="1-20", help="e.g. 1-20, 1,2,3")
    ap.add_argument("--time-limit", type=float, default=120.0, help="seconds per level")
    ap.add_argument("--name", default=None, help="display name of the policy")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    color = sys.stdout.isatty()

    def on_level(r):
        if not args.quiet:
            print(format_level_line(r, color), flush=True)

    meta, results, summary = evaluate(args.policy, parse_levels(args.levels), args.out,
                                      time_limit=args.time_limit, on_level=on_level,
                                      policy_name=args.name)
    if not args.quiet:
        print(format_report(meta, results, summary, color))
    return 0


if __name__ == "__main__":
    sys.exit(main())
