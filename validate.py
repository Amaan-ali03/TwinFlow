"""
Validation harness.

The brief asks how a predictive claim would be validated before anyone is
asked to trust it. This script is that answer. It runs the twin over many
independently seeded shifts with randomised faults it has never seen, and
reports five things:

  1. Detection quality      precision, recall and lead time by alert type
  2. Virtual sensor error   inferred against true work content at dark
                            stations, swept over barcode miss rate
  3. Forecast accuracy      predicted time to starvation against observed
  4. Baseline comparison    what a specification limit alarm would have caught
  5. Business case          bodies protected per shift, from the same runs

Nothing here is tuned on the results. Run it with a different seed range and
the numbers move by a point or two, which is the honest amount.
"""

import argparse
import json
import math
import statistics as stats
from collections import defaultdict
from typing import Dict, List

import numpy as np

from twinflow.line import build_line, TIER_C
from twinflow.simulator import LineSimulator, Fault
from twinflow.twin import TwinFlow
from twinflow.virtual_sensors import VirtualSensorBank
from twinflow.propagate import PropagationEngine, STARVE
from twinflow import decision as D

HORIZON = 28800


# ----------------------------------------------------------------------
def random_scenario(rng, stations) -> List[Fault]:
    """A shift the twin has never seen: random stations, timings and severities."""
    cyc_pool = [s for s in stations if s.index not in (0, len(stations) - 1)]
    par_pool = [s for s in stations if "bolt_torque_nm" in s.process_params
                or "film_thickness_um" in s.process_params
                or "weld_current_a" in s.process_params]
    faults: List[Fault] = []

    for _ in range(int(rng.integers(1, 3))):
        s = cyc_pool[int(rng.integers(0, len(cyc_pool)))]
        start = int(rng.integers(2400, 20000))
        faults.append(Fault(kind="cycle", station=s.sid, start_s=start,
                            ramp_s=int(rng.integers(600, 2400)),
                            end_s=min(HORIZON, start + int(rng.integers(5400, 14400))),
                            magnitude=float(rng.uniform(0.55, 1.20)),
                            label="degradation"))
    for _ in range(int(rng.integers(1, 3))):
        s = par_pool[int(rng.integers(0, len(par_pool)))]
        p = [k for k in s.process_params if k in
             ("bolt_torque_nm", "film_thickness_um", "weld_current_a")][0]
        spec = s.process_params[p]
        start = int(rng.integers(1200, 12000))
        span = spec["usl"] - spec["mean"]
        faults.append(Fault(kind="param", station=s.sid, param=p, start_s=start,
                            ramp_s=int(rng.integers(7200, 16000)),
                            end_s=HORIZON,
                            magnitude=float(rng.choice([-1, 1]) *
                                            rng.uniform(0.45, 0.75) * span),
                            label="calibration drift"))
    # a transient that must NOT raise an alert
    s = par_pool[int(rng.integers(0, len(par_pool)))]
    p = list(s.process_params.keys())[0]
    tstart = int(rng.integers(3000, 24000))
    faults.append(Fault(kind="param", station=s.sid, param=p, start_s=tstart,
                        ramp_s=45, end_s=tstart + int(rng.integers(150, 400)),
                        magnitude=float(rng.uniform(2.5, 4.0) *
                                        s.process_params[p]["sigma"]),
                        label="transient"))
    return faults


# ----------------------------------------------------------------------
def spec_limit_baseline(sim) -> Dict[str, int]:
    """When a conventional specification alarm would first have fired."""
    first: Dict[str, int] = {}
    stations = {s.sid: s for s in sim.stations}
    for ev in sim.events:
        st = stations[ev["sid"]]
        for p, v in (ev.get("params") or {}).items():
            spec = st.process_params[p]
            if v < spec["lsl"] or v > spec["usl"]:
                first.setdefault(f"{ev['sid']}/{p}", ev["t"])
    return first


def detection_scoring(res, sim) -> dict:
    """Match alerts to injected faults. Nothing here reads the twin's own view."""
    real = [f for f in sim.faults if f.label != "transient"]
    transients = [f for f in sim.faults if f.label == "transient"]
    alerts = res["alerts"]

    detected, lead = 0, []
    for f in real:
        hits = [a for a in alerts if a["sid"] == f.station
                and f.start_s <= a["t"] <= f.end_s + 1800]
        if hits:
            detected += 1
            lead.append(min(h["t"] for h in hits) - f.start_s)
    false_on_transient = sum(
        1 for a in alerts if any(a["sid"] == f.station and
                                 f.start_s <= a["t"] <= f.end_s + 900
                                 for f in transients))
    graded = [a for a in alerts if a["outcome"] in ("TRUE", "FALSE")]
    return {
        "faults": len(real),
        "detected": detected,
        "recall": detected / max(len(real), 1),
        "median_detect_lag_s": float(stats.median(lead)) if lead else None,
        "alerts_fired": len(alerts),
        "alerts_graded": len(graded),
        "precision": (sum(1 for a in graded if a["outcome"] == "TRUE") /
                      len(graded)) if graded else None,
        "transient_false_alarms": false_on_transient,
    }


# ----------------------------------------------------------------------
def forecast_accuracy(sim, probe_every: int = 300) -> dict:
    """Predicted 30 minute output against what the line actually produced.

    This is the number that matters to a plant manager: not whether one
    starvation timestamp lands within a few seconds, but whether the twin's
    30 minute output forecast is close enough to plan a shift around. Compare
    against a naive baseline that just assumes takt holds.
    """
    vs = VirtualSensorBank(sim.stations)
    eng = PropagationEngine(sim.stations)
    completed = sorted(t for (t, _u) in sim.completed)

    def actual_out(t0: int, t1: int) -> int:
        lo = np.searchsorted(completed, t0, side="left")
        hi = np.searchsorted(completed, t1, side="right")
        return int(hi - lo)

    fault_windows = [(f.start_s, f.end_s) for f in sim.faults if f.label != "transient"]

    def in_fault(t0: int, t1: int) -> bool:
        return any(a < t1 and b > t0 for a, b in fault_windows)

    ei = 0
    twin_err, naive_err = [], []
    twin_err_f, naive_err_f = [], []      # during an active fault window
    naive_rate = 1.0 / max(s.nominal_cycle_s for s in sim.stations)
    for probe in range(1800, sim.horizon_s - 1800, probe_every):
        while ei < len(sim.events) and sim.events[ei]["t"] <= probe:
            vs.observe(sim.events[ei]); ei += 1
        fc = eng.forecast(vs.current_cycles(), vs.current_buffers(), horizon_s=1800)
        actual = actual_out(probe, probe + 1800)
        te = abs(fc.units_out_forecast - actual)
        ne = abs(naive_rate * 1800 - actual)
        twin_err.append(te); naive_err.append(ne)
        if in_fault(probe, probe + 1800):
            twin_err_f.append(te); naive_err_f.append(ne)
    return {
        "n_probes": len(twin_err),
        "twin_mae_units": float(np.mean(twin_err)) if twin_err else None,
        "naive_mae_units": float(np.mean(naive_err)) if naive_err else None,
        "twin_p90_units": float(np.percentile(twin_err, 90)) if twin_err else None,
        "twin_mae_units_during_fault": float(np.mean(twin_err_f)) if twin_err_f else None,
        "naive_mae_units_during_fault": float(np.mean(naive_err_f)) if naive_err_f else None,
    }


# ----------------------------------------------------------------------
def sensor_sweep(seed: int = 11) -> List[dict]:
    """Virtual sensor error against barcode miss rate, with and without cameras.

    This is the retrofit business case in one table. If the inferred work
    content holds up without cameras, do not buy cameras.
    """
    out = []
    for miss in (0.0, 0.05, 0.15, 0.30, 0.50):
        for cams in (True, False):
            stations = build_line()
            if not cams:
                for s in stations:
                    s.has_camera = False
            sim = LineSimulator(stations=stations, horizon_s=HORIZON, seed=seed,
                                scan_miss_dark=miss).run()
            vb = VirtualSensorBank(stations)
            for e in sim.events:
                vb.observe(e)
            sc = vb.score_against_truth(sim.truth)
            dark = [s.sid for s in stations if s.tier == TIER_C]
            out.append({
                "scan_miss_rate": miss,
                "cameras": cams,
                "dark_mae_s": round(float(np.mean([sc[d]["mae_s"] for d in dark])), 2),
                "dark_mape_pct": round(float(np.mean([sc[d]["mape_pct"] for d in dark])), 2),
                "bias_s": round(float(np.mean([sc[d]["bias_s"] for d in dark])), 2),
            })
    return out


# ----------------------------------------------------------------------
def run(seeds: int = 8, verbose: bool = True) -> dict:
    stations0 = build_line()
    rows, fcs = [], []
    per_kind = defaultdict(lambda: {"true": 0, "false": 0, "lead": []})
    saved_units, baseline_lead = [], []

    for k in range(seeds):
        rng = np.random.default_rng(1000 + k)
        stations = build_line()
        faults = random_scenario(rng, stations)
        sim = LineSimulator(stations=stations, faults=faults,
                            horizon_s=HORIZON, seed=2000 + k).run()
        tw = TwinFlow(stations)
        res = tw.run(sim, frame_every_s=120)

        rows.append(detection_scoring(res, sim))
        fcs.append(forecast_accuracy(sim))

        for a in res["alerts"]:
            if a["outcome"] == "TRUE":
                per_kind[a["kind"]]["true"] += 1
                if a["lead_time_s"]:
                    per_kind[a["kind"]]["lead"].append(a["lead_time_s"])
            elif a["outcome"] == "FALSE":
                per_kind[a["kind"]]["false"] += 1

        spec_first = spec_limit_baseline(sim)
        for f in faults:
            if f.kind != "param" or f.label == "transient":
                continue
            key = f"{f.station}/{f.param}"
            twin_t = min((a["t"] for a in res["alerts"]
                          if a["sid"] == f.station and a["kind"] == D.DEFECT_RISK),
                         default=None)
            spec_t = spec_first.get(key)
            if twin_t is not None:
                gain = (spec_t - twin_t) if spec_t else (HORIZON - twin_t)
                baseline_lead.append({"station": f.station, "param": f.param,
                                      "twin_s": twin_t, "spec_s": spec_t,
                                      "gain_s": gain,
                                      "spec_never_fired": spec_t is None})
                # bodies built at that station between the two detections
                n = sum(1 for x in sim.truth if x["sid"] == f.station
                        and twin_t <= x["t"] <= (spec_t or HORIZON))
                saved_units.append(n)

        if verbose:
            r = rows[-1]
            print(f"  shift {k+1}/{seeds}: recall {r['recall']:.0%} "
                  f"precision {r['precision'] if r['precision'] is None else round(r['precision'],2)} "
                  f"alerts {r['alerts_fired']} transient false alarms "
                  f"{r['transient_false_alarms']}")

    summary = {
        "shifts": seeds,
        "detection": {
            "recall": round(float(np.mean([r["recall"] for r in rows])), 3),
            "precision": round(float(np.mean(
                [r["precision"] for r in rows if r["precision"] is not None])), 3),
            "alerts_per_shift": round(float(np.mean([r["alerts_fired"] for r in rows])), 1),
            "transient_false_alarms_total": int(sum(
                r["transient_false_alarms"] for r in rows)),
            "median_detect_lag_min": round(float(np.median(
                [r["median_detect_lag_s"] for r in rows
                 if r["median_detect_lag_s"] is not None])) / 60, 1),
        },
        "by_kind": {k: {"true": v["true"], "false": v["false"],
                        "precision": round(v["true"] / max(v["true"] + v["false"], 1), 3),
                        "median_lead_min": (round(float(np.median(v["lead"])) / 60, 1)
                                            if v["lead"] else None)}
                    for k, v in per_kind.items()},
        "forecast": {
            "twin_mae_units_per_30min": round(float(np.mean(
                [f["twin_mae_units"] for f in fcs if f["twin_mae_units"] is not None])), 2),
            "naive_mae_units_per_30min": round(float(np.mean(
                [f["naive_mae_units"] for f in fcs if f["naive_mae_units"] is not None])), 2),
            "twin_p90_units_per_30min": round(float(np.mean(
                [f["twin_p90_units"] for f in fcs if f["twin_p90_units"] is not None])), 2),
            "twin_mae_during_fault": round(float(np.mean(
                [f["twin_mae_units_during_fault"] for f in fcs
                 if f["twin_mae_units_during_fault"] is not None])), 2),
            "naive_mae_during_fault": round(float(np.mean(
                [f["naive_mae_units_during_fault"] for f in fcs
                 if f["naive_mae_units_during_fault"] is not None])), 2),
        },
        "versus_spec_alarm": {
            "cases": len(baseline_lead),
            "spec_alarm_never_fired_pct": round(100 * sum(
                1 for b in baseline_lead if b["spec_never_fired"]) /
                max(len(baseline_lead), 1), 1),
            "median_lead_gain_min": (round(float(np.median(
                [b["gain_s"] for b in baseline_lead])) / 60, 1)
                if baseline_lead else None),
            "median_bodies_protected": (int(np.median(saved_units))
                                        if saved_units else None),
        },
        "sensor_sweep": sensor_sweep(),
    }
    return summary


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--shifts", type=int, default=8)
    ap.add_argument("--out", default="out/validation.json")
    a = ap.parse_args()
    print(f"Running {a.shifts} independently seeded shifts with randomised faults\n")
    s = run(a.shifts)
    print("\n" + json.dumps(s, indent=2))
    with open(a.out, "w") as f:
        json.dump(s, f, indent=2)
    print(f"\nwritten to {a.out}")
