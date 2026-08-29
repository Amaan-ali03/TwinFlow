"""
Builds out/history.json — a week of consecutive shifts, for the Plant Manager
view's trend panels.

The engine runs one shift at a time. A manager plans across a week, so the
questions that view has to answer ("which station has been the constraint",
"is alert precision improving") need more than one shift of the twin's own
output, kept. This is the only place that produces it.

Ten shifts take about 20 s. Run it from the repo root:

    python3 build_history.py --shifts 10
"""

import argparse
import json
import os

from twinflow.history import build_history
# Each shift gets its own randomised faults, so the week has variety the way
# a real one does. The generator lives with the validation harness because
# that is what it was written for; twinflow/ does not depend on it.
from validate import random_scenario


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--shifts", type=int, default=10)
    ap.add_argument("--seed0", type=int, default=300)
    ap.add_argument("--out", default="out/history.json")
    args = ap.parse_args()

    print(f"Running {args.shifts} consecutive shifts with a carried ledger\n")
    hist = build_history(args.shifts, args.seed0, verbose=True,
                         scenario=random_scenario)

    top = hist["recurring_constraints"][:3]
    print("\n  recurring constraints: " +
          ", ".join(f"{c['sid']} {c['share']:.0%}" for c in top))
    print(f"  bodies out: {hist['totals']['bodies_out']}  "
          f"mean fallout: {hist['totals']['mean_fallout_pct']}%  "
          f"alerts: {hist['totals']['alerts_fired']}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(hist, f, indent=2)
    print(f"\nwritten to {args.out}")
