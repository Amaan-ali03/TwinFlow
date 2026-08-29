"""
Cross-shift history.

Everything else in this package answers a question about the shift running
right now. A plant manager's questions are not about right now: which station
has been the constraint this week, whether last Tuesday's fix held, whether
the alerts are getting more trustworthy or less. Those need the twin's own
output from more than one shift, kept.

This module runs consecutive shifts the way a real installation would — the
alert ledger carries forward, so its precision-driven threshold retune spans
the week instead of restarting every morning — and reduces each one to the
handful of numbers a weekly planning conversation actually uses.

It reads the twin's output only. No simulator ground truth appears here.
"""

from collections import Counter
from typing import Dict, List, Optional

import numpy as np

from .line import build_line, variant_mix
from .simulator import LineSimulator, default_scenario
from .twin import TwinFlow
from . import decision as D

HORIZON_S = 28800
KINDS = (D.BOTTLENECK, D.DEFECT_RISK, D.DARK_STATION)


def shift_summary(shift: int, seed: int, res: dict, sim) -> dict:
    """One shift reduced to what a weekly review asks for."""
    frames = res["frames"]
    ledger = res["ledger"]

    constraints = Counter(f["constraint"] for f in frames if f.get("constraint"))
    top = constraints.most_common(1)
    rate_losses = [f["rate_loss"] for f in frames if f.get("rate_loss") is not None]
    runways = [f["runway_min"] for f in frames if f.get("runway_min") is not None]

    fails = sum(1 for q in sim.quality if q["result"] == "FAIL")
    checks = len(sim.quality)

    built: Dict[str, int] = {}
    for u in sim.units().values():
        if u.variant:
            built[u.variant] = built.get(u.variant, 0) + 1

    by_kind = {}
    for k in KINDS:
        row = ledger.get(k, {})
        by_kind[k] = {
            "fired": row.get("fired", 0),
            "true": row.get("true", 0),
            "false": row.get("false", 0),
            "precision": row.get("precision"),
            "lifetime_precision": row.get("lifetime_precision"),
            "threshold_bump": row.get("threshold_bump", 0.0),
            "fire_floor": row.get("fire_floor"),
        }

    return {
        "shift": shift,
        "seed": seed,
        "bodies_out": len(sim.completed),
        "constraint_sid": top[0][0] if top else None,
        # how much of the shift that station was the binding constraint
        "constraint_share": (round(top[0][1] / max(len(frames), 1), 3)
                             if top else None),
        "mean_rate_loss_per_hr": (round(sum(rate_losses) / len(rate_losses), 2)
                                  if rate_losses else None),
        "min_runway_min": round(min(runways), 1) if runways else None,
        "quality_checks": checks,
        "quality_fails": fails,
        "fallout_pct": round(100.0 * fails / max(checks, 1), 2),
        "alerts_fired": len(res["alerts"]),
        "precision_all": ledger.get("precision_all"),
        "by_kind": by_kind,
        "built": built,
    }


def build_history(shifts: int = 10, seed0: int = 300,
                  verbose: bool = False, scenario=None) -> dict:
    """Run consecutive shifts with a carried-forward ledger.

    scenario(rng, stations) -> list of Fault, called once per shift so each
    day of the week has its own problems. Defaults to the demo's fixed four,
    which makes for a repetitive week; the entry point passes the validation
    harness's randomised generator instead.
    """
    stations0 = build_line()
    ledger_state: Optional[dict] = None
    rows: List[dict] = []
    rng = np.random.default_rng(seed0)

    for k in range(shifts):
        stations = build_line()
        faults = scenario(rng, stations) if scenario else default_scenario()
        sim = LineSimulator(stations=stations, faults=faults,
                            horizon_s=HORIZON_S, seed=seed0 + k).run()
        tw = TwinFlow(stations, ledger_state=ledger_state)
        res = tw.run(sim, frame_every_s=120)
        ledger_state = res["ledger_state"]
        rows.append(shift_summary(k + 1, seed0 + k, res, sim))
        if verbose:
            r = rows[-1]
            print(f"  shift {r['shift']}/{shifts}: constraint "
                  f"{r['constraint_sid']} ({r['constraint_share']:.0%} of shift), "
                  f"{r['bodies_out']} bodies, fallout {r['fallout_pct']}%, "
                  f"{r['alerts_fired']} alerts")

    # Which station has held the line back most often across the week — the
    # question a weekly planning meeting opens with, and one a single shift
    # cannot answer.
    counts = Counter(r["constraint_sid"] for r in rows if r["constraint_sid"])
    names = {s.sid: s.name for s in stations0}
    recurring = [{"sid": sid, "name": names.get(sid, ""), "shifts": n,
                  "share": round(n / max(len(rows), 1), 3)}
                 for sid, n in counts.most_common()]

    def kind_series(kind: str, field: str) -> List[Optional[float]]:
        return [r["by_kind"][kind][field] for r in rows]

    return {
        "shifts": len(rows),
        "horizon_s": HORIZON_S,
        "build_mix": variant_mix(stations0),
        "per_shift": rows,
        "recurring_constraints": recurring,
        "trend": {
            "bodies_out": [r["bodies_out"] for r in rows],
            "fallout_pct": [r["fallout_pct"] for r in rows],
            "precision_all": [r["precision_all"] for r in rows],
            **{f"{k}_precision": kind_series(k, "precision") for k in KINDS},
            **{f"{k}_lifetime_precision": kind_series(k, "lifetime_precision")
               for k in KINDS},
            **{f"{k}_fire_floor": kind_series(k, "fire_floor") for k in KINDS},
        },
        "totals": {
            "bodies_out": sum(r["bodies_out"] for r in rows),
            "quality_fails": sum(r["quality_fails"] for r in rows),
            "alerts_fired": sum(r["alerts_fired"] for r in rows),
            "mean_fallout_pct": (round(sum(r["fallout_pct"] for r in rows)
                                       / max(len(rows), 1), 2) if rows else None),
        },
    }
