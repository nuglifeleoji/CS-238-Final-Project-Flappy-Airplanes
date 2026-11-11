#!/usr/bin/env python3
"""Headless evaluation: fly a policy through the 20 levels and print a report.

    python run.py policies/rollout_policy.py
    python run.py my_policy.py --levels 1-5 --time-limit 60

The full run (with trajectories) is saved to results/<run-id>.jsonl and can be
replayed in the UI:  python server.py  →  http://localhost:8000/?run=<run-id>
"""
import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from flappy.evaluate import evaluate, format_level_line, format_report, parse_levels  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("policy", help="path to your policy .py file")
    ap.add_argument("--levels", default="1-20")
    ap.add_argument("--time-limit", type=float, default=120.0, help="seconds per level")
    ap.add_argument("--no-save", action="store_true", help="don't write results/*.jsonl")
    args = ap.parse_args()

    policy = Path(args.policy)
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "_" + re.sub(r"[^\w.-]", "_", policy.stem)
    out = None
    if not args.no_save:
        (ROOT / "results").mkdir(exist_ok=True)
        base, k = run_id, 1
        while (ROOT / "results" / f"{run_id}.jsonl").exists():
            k += 1
            run_id = f"{base}-{k}"
        out = ROOT / "results" / f"{run_id}.jsonl"

    color = sys.stdout.isatty()
    print(f"\n  flying {policy.name} through levels {args.levels} ...\n")
    meta, results, summary = evaluate(policy, parse_levels(args.levels), out,
                                      time_limit=args.time_limit,
                                      on_level=lambda r: print(format_level_line(r, color), flush=True))
    print(format_report(meta, results, summary, color))
    if out:
        print(f"  saved  results/{out.name}")
        print(f"  replay python server.py  →  http://localhost:8000/?run={run_id}\n")


if __name__ == "__main__":
    main()
