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
from typing import Dict, List, Optional

import numpy as np

from twinflow.line import build_line, variant_mix, TIER_C
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


def multi_causal_scenario(rng, stations) -> List[Fault]:
    """A shift where the cause is not where the symptom is.

    `random_scenario` injects one cause per station, monotone, with a repair
    time — the case the engine was built against. The brief calls out the
    harder ones explicitly: causes that are shared across stations, that come
    from the operator rather than the equipment, that arrive on the part, and
    that switch on and off. Each scenario carries exactly one of each so the
    attribution can be scored per cause type.
    """
    par_pool = [s for s in stations
                if {"bolt_torque_nm", "film_thickness_um", "weld_current_a"}
                & set(s.process_params)]
    faults: List[Fault] = []

    # 1. Zone-wide environmental driver: one cause, many stations drifting.
    zone = str(rng.choice(["PAINT", "BODY"]))
    a_start = int(rng.integers(2400, 9000))
    faults.append(Fault(kind="ambient", station="", zone=zone,
                        start_s=a_start, ramp_s=int(rng.integers(3600, 9000)),
                        end_s=HORIZON,
                        magnitude=float(rng.uniform(1.6, 2.6)),
                        label="ambient"))

    # 2. Carry-in: the defect surfaces downstream of the station that caused
    #    it, and nothing at the station where it surfaces is out of spec.
    src = par_pool[int(rng.integers(0, max(1, len(par_pool) - 6)))]
    p = [k for k in src.process_params if k in
         ("bolt_torque_nm", "film_thickness_um", "weld_current_a")]
    if p:
        p = p[0]
        spec = src.process_params[p]
        c_start = int(rng.integers(1800, 10000))
        downstream = [s for s in stations if s.index > src.index + 2]
        if downstream:
            victim = downstream[int(rng.integers(0, len(downstream)))]
            faults.append(Fault(kind="param", station=src.sid, param=p,
                                start_s=c_start,
                                ramp_s=int(rng.integers(5400, 12000)),
                                end_s=HORIZON,
                                magnitude=float(rng.choice([-1, 1]) *
                                                rng.uniform(0.5, 0.8) *
                                                (spec["usl"] - spec["mean"])),
                                label="carry_in_source"))
            faults.append(Fault(kind="carry_in", station=victim.sid,
                                source=src.sid, param=p, start_s=c_start,
                                ramp_s=600, end_s=HORIZON,
                                magnitude=float(rng.uniform(1.5, 2.5)),
                                label="carry_in"))

    # 3. Operator variation at a manual station, switching at a break.
    manual = [s for s in stations if s.tier == TIER_C]
    if manual:
        m = manual[int(rng.integers(0, len(manual)))]
        o_start = int(rng.choice([9000, 14400, 19800]))
        faults.append(Fault(kind="operator", station=m.sid, start_s=o_start,
                            ramp_s=120, end_s=min(HORIZON, o_start + 9000),
                            magnitude=float(rng.uniform(0.25, 0.45)),
                            label="operator"))

    # 4. Intermittent equipment fault: present, gone, present again.
    cyc_pool = [s for s in stations if s.index not in (0, len(stations) - 1)]
    s = cyc_pool[int(rng.integers(0, len(cyc_pool)))]
    i_start = int(rng.integers(3600, 16000))
    faults.append(Fault(kind="cycle", station=s.sid, start_s=i_start,
                        ramp_s=300, end_s=min(HORIZON, i_start + 12600),
                        magnitude=float(rng.uniform(0.5, 0.9)),
                        duty_on_s=int(rng.integers(600, 1200)),
                        duty_off_s=int(rng.integers(600, 1500)),
                        label="intermittent"))
    return faults


def attribution_scoring(res, sim) -> dict:
    """Does the twin name the station that actually caused the problem?

    Three questions, one per hard cause type:

      carry-in     the defect surfaces at one station, the cause is at
                   another. Naming the station where bodies fail is the
                   plausible wrong answer, so both are counted.
      ambient      one environmental driver moves a whole zone. There is no
                   single station to name, and the failure mode is an alert
                   storm — this counts how many stations get blamed.
      intermittent a cause that keeps vanishing before anyone reaches it.
                   Only detection is scored, not attribution.
    """
    alerts = res["alerts"]
    out: Dict[str, object] = {}

    # --- carry-in -----------------------------------------------------
    links = [f for f in sim.faults if f.kind == "carry_in"]
    if links:
        f = links[0]
        window = [a for a in alerts if a["kind"] == D.DEFECT_RISK
                  and f.start_s <= a["t"] <= f.end_s]
        named = {a["sid"] for a in window}
        # the plant's own retrospective attribution, for the same window
        origins = [q["origin_station"] for q in sim.quality
                   if q["result"] == "FAIL" and f.start_s <= q["t"] <= f.end_s]
        out["carry_in"] = {
            "source": f.source,
            "symptom_station": f.station,
            "named_source": f.source in named,
            "named_symptom_only": (f.station in named and f.source not in named),
            "named_nothing": not named,
            "true_fails_attributed_to_source": sum(
                1 for o in origins if o == f.source),
            "true_fails_in_window": len(origins),
        }

    # --- ambient ------------------------------------------------------
    amb = [f for f in sim.faults if f.kind == "ambient"]
    if amb:
        f = amb[0]
        zone_sids = {s.sid for s in sim.stations if s.zone == f.zone}
        fired = [a for a in alerts if a["kind"] == D.DEFECT_RISK
                 and f.start_s <= a["t"] <= f.end_s]
        in_zone = {a["sid"] for a in fired if a["sid"] in zone_sids}
        out["ambient"] = {
            "zone": f.zone,
            "stations_in_zone_with_params": sum(
                1 for s in sim.stations if s.zone == f.zone and s.process_params),
            "stations_blamed": len(in_zone),
            "alerts_in_zone": len([a for a in fired if a["sid"] in zone_sids]),
            "detected": len(in_zone) > 0,
        }

    # --- intermittent -------------------------------------------------
    inter = [f for f in sim.faults if f.label == "intermittent"]
    if inter:
        f = inter[0]
        hits = [a for a in alerts if a["sid"] == f.station
                and f.start_s <= a["t"] <= f.end_s + 1800]
        out["intermittent"] = {
            "station": f.station,
            "duty_on_s": f.duty_on_s,
            "duty_off_s": f.duty_off_s,
            "detected": bool(hits),
            "lead_s": (min(h["t"] for h in hits) - f.start_s) if hits else None,
        }

    # --- operator -----------------------------------------------------
    op = [f for f in sim.faults if f.kind == "operator"]
    if op:
        f = op[0]
        hits = [a for a in alerts if a["sid"] == f.station
                and f.start_s <= a["t"] <= f.end_s + 1800]
        out["operator"] = {
            "station": f.station,
            "detected": bool(hits),
            "kinds": sorted({a["kind"] for a in hits}),
        }
    return out


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


def is_material_fault(f: Fault, sim) -> bool:
    """Did this parameter fault actually raise the station's own fallout
    rate enough to clear the same bar twin.py's TwinFlow._grade() tests
    DEFECT_RISK alerts against — a two-proportion z >= 1.64 AND an absolute
    rise >= 0.03? Evaluated on the fault's own true window against ground
    truth quality dispositions, independent of whether any alert fired.

    Some injected drifts are real but genuinely too small to be worth an
    intervention; plain recall treats missing those the same as missing an
    obviously material one. This is the fairer number.
    """
    if f.kind != "param":
        return False
    fails = {q["uid"] for q in sim.quality if q["result"] == "FAIL"}
    made = {x["uid"] for x in sim.truth
            if x["sid"] == f.station and f.start_s <= x["t"] <= f.end_s}
    base = {x["uid"] for x in sim.truth
            if x["sid"] == f.station and x["t"] < 2700}
    if len(made) < 8:
        return False
    n_a, n_b = len(made), max(len(base), 1)
    k_a, k_b = len(made & fails), len(base & fails)
    r_after, r_before = k_a / n_a, k_b / n_b
    pool = (k_a + k_b) / (n_a + n_b)
    se = math.sqrt(max(pool * (1 - pool) * (1 / n_a + 1 / n_b), 1e-12))
    z = (r_after - r_before) / se if se > 0 else 0.0
    return bool(z >= 1.64 and (r_after - r_before) >= 0.03)


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

    material = [f for f in real if is_material_fault(f, sim)]
    material_detected = sum(
        1 for f in material
        if any(a["sid"] == f.station and a["kind"] == D.DEFECT_RISK and
              f.start_s <= a["t"] <= f.end_s + 1800 for a in alerts))

    false_on_transient = sum(
        1 for a in alerts if any(a["sid"] == f.station and
                                 f.start_s <= a["t"] <= f.end_s + 900
                                 for f in transients))
    graded = [a for a in alerts if a["outcome"] in ("TRUE", "FALSE")]
    return {
        "faults": len(real),
        "detected": detected,
        "recall": detected / max(len(real), 1),
        "material_param_faults": len(material),
        "material_detected": material_detected,
        "material_recall": (material_detected / len(material)) if material else None,
        "median_detect_lag_s": float(stats.median(lead)) if lead else None,
        "alerts_fired": len(alerts),
        "alerts_graded": len(graded),
        "precision": (sum(1 for a in graded if a["outcome"] == "TRUE") /
                      len(graded)) if graded else None,
        "transient_false_alarms": false_on_transient,
    }


# ----------------------------------------------------------------------
# Fault kinds that move the rate. A `param` calibration drift changes what
# comes off the line, not how fast — and `random_scenario` runs those to the
# end of the shift, so counting them made 95% of probe windows "during a
# fault" and turned that split into the whole shift restated.
THROUGHPUT_FAULT_KINDS = ("cycle", "operator", "ambient")

# The fluid model is a capacity ceiling: it assumes the line runs at its
# bottleneck rate for the whole horizon. Real lines lose output to micro
# stoppages and short manual interruptions that no station level cycle time
# reports. Floor the correction so one starved probe cannot collapse it.
AVAILABILITY_FLOOR = 0.70


def forecast_accuracy(sim, probe_every: int = 300) -> dict:
    """Predicted 30 minute output against what the line actually produced.

    This is the number that matters to a plant manager: not whether one
    starvation timestamp lands within a few seconds, but whether the twin's
    30 minute output forecast is close enough to plan a shift around. Compare
    against a naive baseline that just assumes takt holds.

    Reported three ways, because one number hid the shape of the error. When
    the line is healthy there is nothing to model and the naive takt should
    win; the twin only earns its keep once throughput is actually degraded.
    Signed bias is reported alongside absolute error — both estimators run
    optimistic, and averaging that away would be the flattering choice.
    """
    vs = VirtualSensorBank(sim.stations)
    eng = PropagationEngine(sim.stations)
    completed = sorted(t for (t, _u) in sim.completed)

    def actual_out(t0: int, t1: int) -> int:
        lo = np.searchsorted(completed, t0, side="left")
        hi = np.searchsorted(completed, t1, side="right")
        return int(hi - lo)

    fault_windows = [(f.start_s, f.end_s) for f in sim.faults
                     if f.label != "transient" and f.kind in THROUGHPUT_FAULT_KINDS]

    def in_fault(t0: int, t1: int) -> bool:
        return any(a < t1 and b > t0 for a, b in fault_windows)

    ei = 0
    twin_err, naive_err = [], []
    twin_err_f, naive_err_f = [], []      # during an active fault window
    twin_err_h, naive_err_h = [], []      # line healthy
    twin_signed, naive_signed = [], []
    # takt over the mix the line actually builds, not over the base variant
    naive_rate = 1.0 / max(s.mix_cycle_s for s in sim.stations)
    for probe in range(1800, sim.horizon_s - 1800, probe_every):
        while ei < len(sim.events) and sim.events[ei]["t"] <= probe:
            vs.observe(sim.events[ei]); ei += 1
        cycles = vs.current_cycles()
        # What the line delivered over the trailing 30 minutes against what
        # its own slowest station could have delivered over the same window.
        # Both halves are things a plant already has — the end of line counter
        # and L2's cycle estimates — so this is a correction the twin can make
        # in production, not a peek at simulator truth.
        capable_cycle = max(cycles.get(sid, eng.nominal[sid]) for sid in eng.sids)
        capable = 1800.0 / capable_cycle
        avail = (actual_out(probe - 1800, probe) / capable) if capable > 0 else 1.0
        fc = eng.forecast(cycles, vs.current_buffers(), horizon_s=1800,
                          confidences=vs.current_confidences(),
                          availability=max(AVAILABILITY_FLOOR, min(1.0, avail)))
        actual = actual_out(probe, probe + 1800)
        ts = fc.units_out_forecast - actual
        ns = naive_rate * 1800 - actual
        te, ne = abs(ts), abs(ns)
        twin_err.append(te); naive_err.append(ne)
        twin_signed.append(ts); naive_signed.append(ns)
        if in_fault(probe, probe + 1800):
            twin_err_f.append(te); naive_err_f.append(ne)
        else:
            twin_err_h.append(te); naive_err_h.append(ne)

    def mean(xs):
        return float(np.mean(xs)) if xs else None

    # The per shift means are here for reading one shift; `forecast_summary`
    # pools the raw errors across shifts instead of averaging these, because a
    # shift whose fault never bit contributes eight faulted probes and a shift
    # with a real slowdown contributes eighty. Weighting those equally let a
    # handful of near empty splits move the headline.
    return {
        "n_probes": len(twin_err),
        "n_probes_during_fault": len(twin_err_f),
        "n_probes_healthy": len(twin_err_h),
        "twin_mae_units": mean(twin_err),
        "naive_mae_units": mean(naive_err),
        "twin_p90_units": float(np.percentile(twin_err, 90)) if twin_err else None,
        "twin_mae_units_during_fault": mean(twin_err_f),
        "naive_mae_units_during_fault": mean(naive_err_f),
        "twin_mae_units_healthy": mean(twin_err_h),
        "naive_mae_units_healthy": mean(naive_err_h),
        "twin_bias_units": mean(twin_signed),
        "naive_bias_units": mean(naive_signed),
        "_errors": {
            "twin": twin_err, "naive": naive_err,
            "twin_fault": twin_err_f, "naive_fault": naive_err_f,
            "twin_healthy": twin_err_h, "naive_healthy": naive_err_h,
            "twin_signed": twin_signed, "naive_signed": naive_signed,
        },
    }


def forecast_summary(fcs: List[dict]) -> dict:
    """Average the per shift `forecast_accuracy` dicts into the payload block.

    Imported by `server.py` rather than copied — the dashboard and the CLI
    disagreeing about the headline forecast number is exactly the divergence
    the two entry points keep threatening to produce.
    """
    def pooled(name):
        vals = [x for f in fcs for x in f.get("_errors", {}).get(name, [])]
        return vals

    def mae(name, digits=2):
        vals = pooled(name)
        return round(float(np.mean(vals)), digits) if vals else None

    twin_all = pooled("twin")
    return {
        "twin_mae_units_per_30min": mae("twin"),
        "naive_mae_units_per_30min": mae("naive"),
        "twin_p90_units_per_30min": (round(float(np.percentile(twin_all, 90)), 2)
                                     if twin_all else None),
        "twin_mae_during_fault": mae("twin_fault"),
        "naive_mae_during_fault": mae("naive_fault"),
        "twin_mae_healthy": mae("twin_healthy"),
        "naive_mae_healthy": mae("naive_healthy"),
        "twin_bias_units": mae("twin_signed"),
        "naive_bias_units": mae("naive_signed"),
        "probes_during_fault": len(pooled("twin_fault")),
        "probes_healthy": len(pooled("twin_healthy")),
    }


def buffer_score(sim) -> float:
    """Validation only. How close are inferred buffer levels to ground truth.

    Creates a fresh VirtualSensorBank, replays all events, then compares
    inferred buffer levels against the simulator's snapshots at each
    recorded timestamp. Returns MAE in units across all non-terminal buffers.
    """
    vs = VirtualSensorBank(sim.stations)
    for e in sim.events:
        vs.observe(e)
    result = vs.score_buffers_against_truth(sim.events, sim.snapshots)
    return result["buffer_mae_units"]


# ----------------------------------------------------------------------
def variant_conditioning(sim, stations) -> dict:
    """What the build order is worth at a dark station.

    The line runs a mixed model sequence, so work content at an
    uninstrumented station is multi-modal: the same fixture takes longer on
    the body with the third seat row. A pooled estimator sits between the
    modes and is wrong for every body by roughly half the spread. Conditioning
    on the variant costs nothing to acquire — build order is MES data, known
    before the body is launched and readable at a dark station — so the only
    question is what it buys. Scored per body against ground truth the twin
    never sees, both ways, on the same shift.
    """
    dark = [s.sid for s in stations if s.tier == TIER_C]
    spread = {s.sid: ((max(s.variant_cycle_mult.values()) -
                       min(s.variant_cycle_mult.values())) * s.nominal_cycle_s
                      if s.variant_cycle_mult else 0.0)
              for s in stations}
    scored = {}
    for cond in (True, False):
        vb = VirtualSensorBank(stations, use_variant=cond)
        for e in sim.events:
            vb.observe(e)
        scored[cond] = vb.score_against_truth(sim.truth)

    per_station = []
    for d in dark:
        if d not in scored[True] or d not in scored[False]:
            continue
        per_station.append({
            "sid": d,
            "variant_spread_s": round(spread[d], 1),
            "pooled_mae_s": round(scored[False][d]["mae_s"], 2),
            "conditioned_mae_s": round(scored[True][d]["mae_s"], 2),
        })
    ok = [d for d in dark if d in scored[True] and d in scored[False]]
    return {
        "dark_mae_pooled_s": round(float(np.mean(
            [scored[False][d]["mae_s"] for d in ok])), 2),
        "dark_mae_conditioned_s": round(float(np.mean(
            [scored[True][d]["mae_s"] for d in ok])), 2),
        "dark_mape_pooled_pct": round(float(np.mean(
            [scored[False][d]["mape_pct"] for d in ok])), 2),
        "dark_mape_conditioned_pct": round(float(np.mean(
            [scored[True][d]["mape_pct"] for d in ok])), 2),
        "per_station": per_station,
    }


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
def trust_loop_row(shift: int, ledger: dict) -> dict:
    """One row of the self-retuning trust loop's trajectory.

    The precision floor mechanism only acts once a kind has 5 graded alerts,
    so with a ledger that resets every shift it never engages on DEFECT_RISK
    (~2.5 alerts a shift). Carrying ledger state across shifts is what lets it
    move at all; this row is what makes the movement, or its absence, visible.
    """
    row = {"shift": shift}
    for kind in (D.BOTTLENECK, D.DEFECT_RISK, D.DARK_STATION):
        k = ledger.get(kind, {})
        row[kind] = {
            "fired": k.get("fired", 0),
            "graded": k.get("graded", 0),
            "shift_precision": (round(k["precision"], 3)
                                if k.get("precision") is not None else None),
            "lifetime_graded": k.get("lifetime_true", 0) + k.get("lifetime_false", 0),
            "lifetime_precision": (round(k["lifetime_precision"], 3)
                                   if k.get("lifetime_precision") is not None else None),
            "threshold_bump": k.get("threshold_bump", 0.0),
            "fire_floor": k.get("fire_floor"),
        }
    return row


def run_multi_causal(seeds: int = 6, verbose: bool = True) -> dict:
    """The hard slice: shifts where cause and symptom are not the same thing.

    Run separately from the headline numbers rather than mixed into them, so
    the single-cause results stay comparable with earlier versions and the
    degradation under multi-causal conditions is legible on its own.
    """
    rows = []
    for k in range(seeds):
        rng = np.random.default_rng(7000 + k)
        stations = build_line()
        faults = multi_causal_scenario(rng, stations)
        sim = LineSimulator(stations=stations, faults=faults,
                            horizon_s=HORIZON, seed=9000 + k).run()
        tw = TwinFlow(stations)
        res = tw.run(sim, frame_every_s=120)
        r = attribution_scoring(res, sim)
        rows.append(r)
        if verbose:
            ci = r.get("carry_in", {})
            am = r.get("ambient", {})
            print(f"  multi-causal shift {k+1}/{seeds}: carry-in "
                  f"{'source named' if ci.get('named_source') else ('symptom only' if ci.get('named_symptom_only') else 'nothing named')}"
                  f"  |  ambient blamed {am.get('stations_blamed', 0)}"
                  f"/{am.get('stations_in_zone_with_params', 0)} stations in "
                  f"{am.get('zone', '?')}")

    def frac(key: str, field: str) -> Optional[float]:
        vals = [r[key][field] for r in rows if key in r]
        return round(sum(1 for v in vals if v) / len(vals), 3) if vals else None

    carry = [r["carry_in"] for r in rows if "carry_in" in r]
    amb = [r["ambient"] for r in rows if "ambient" in r]
    inter = [r["intermittent"] for r in rows if "intermittent" in r]
    op = [r["operator"] for r in rows if "operator" in r]
    lead = [i["lead_s"] for i in inter if i["lead_s"] is not None]
    return {
        "shifts": seeds,
        "carry_in": {
            "cases": len(carry),
            "named_true_source": frac("carry_in", "named_source"),
            "named_symptom_station_only": frac("carry_in", "named_symptom_only"),
            "named_nothing": frac("carry_in", "named_nothing"),
        },
        "ambient": {
            "cases": len(amb),
            "detected": frac("ambient", "detected"),
            "mean_stations_blamed": (round(float(np.mean(
                [a["stations_blamed"] for a in amb])), 2) if amb else None),
            "mean_stations_in_zone": (round(float(np.mean(
                [a["stations_in_zone_with_params"] for a in amb])), 2)
                if amb else None),
        },
        "intermittent": {
            "cases": len(inter),
            "detected": frac("intermittent", "detected"),
            "median_lead_min": (round(float(np.median(lead)) / 60, 1)
                                if lead else None),
        },
        "operator": {
            "cases": len(op),
            "detected": frac("operator", "detected"),
        },
        "per_shift": rows,
    }


def run(seeds: int = 8, verbose: bool = True) -> dict:
    stations0 = build_line()
    rows, fcs, variants, buf_scores = [], [], [], []
    per_kind = defaultdict(lambda: {"true": 0, "false": 0, "lead": []})
    saved_units, baseline_lead = [], []
    # The alert ledger's threshold retune carries from shift to shift, the way
    # a real installation's would. Detection scoring below is still per shift.
    ledger_state = None
    trust_trend = []

    for k in range(seeds):
        rng = np.random.default_rng(1000 + k)
        stations = build_line()
        faults = random_scenario(rng, stations)
        sim = LineSimulator(stations=stations, faults=faults,
                            horizon_s=HORIZON, seed=2000 + k).run()
        tw = TwinFlow(stations, ledger_state=ledger_state)
        res = tw.run(sim, frame_every_s=120)
        ledger_state = res["ledger_state"]
        trust_trend.append(trust_loop_row(k + 1, res["ledger"]))

        rows.append(detection_scoring(res, sim))
        fcs.append(forecast_accuracy(sim))
        variants.append(variant_conditioning(sim, stations))
        buf_scores.append(buffer_score(sim))

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
            dr = trust_trend[-1][D.DEFECT_RISK]
            print(f"  shift {k+1}/{seeds}: recall {r['recall']:.0%} "
                  f"precision {r['precision'] if r['precision'] is None else round(r['precision'],2)} "
                  f"alerts {r['alerts_fired']} transient false alarms "
                  f"{r['transient_false_alarms']}  |  defect-risk floor "
                  f"{dr['fire_floor']:.0f} (bump +{dr['threshold_bump']:.0f}, "
                  f"lifetime precision {dr['lifetime_precision']})")

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
            "material_param_faults": int(sum(r["material_param_faults"] for r in rows)),
            "material_recall": (round(float(np.mean(
                [r["material_recall"] for r in rows
                 if r["material_recall"] is not None])), 3)
                if any(r["material_recall"] is not None for r in rows) else None),
        },
        # Why DEFECT_RISK precision reads as low as it does, in the two
        # numbers that set its ceiling. The twin fires ~2.5 defect alerts a
        # shift; of the parameter drifts randomly injected across the same
        # shifts, only the ones that clear the grader's materiality bar
        # (two-proportion z >= 1.64 AND an absolute fallout rise >= 3 points)
        # can be graded TRUE at all. When that count is 1 or 2 against 20
        # graded alerts, measured precision is bounded near 10% by the
        # scenario, not by the detector — which is also why this metric has
        # very little statistical power and should not be read to a point.
        "defect_risk_context": {
            "material_param_faults": int(sum(r["material_param_faults"] for r in rows)),
            "defect_alerts_graded": (per_kind[D.DEFECT_RISK]["true"] +
                                     per_kind[D.DEFECT_RISK]["false"]),
            "material_recall": (round(float(np.mean(
                [r["material_recall"] for r in rows
                 if r["material_recall"] is not None])), 3)
                if any(r["material_recall"] is not None for r in rows) else None),
        },
        "by_kind": {k: {"true": v["true"], "false": v["false"],
                        "precision": round(v["true"] / max(v["true"] + v["false"], 1), 3),
                        "median_lead_min": (round(float(np.median(v["lead"])) / 60, 1)
                                            if v["lead"] else None)}
                    for k, v in per_kind.items()},
        "forecast": forecast_summary(fcs),
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
        "variant_conditioning": {
            "build_mix": variant_mix(stations0),
            "dark_mae_pooled_s": round(float(np.mean(
                [v["dark_mae_pooled_s"] for v in variants])), 2),
            "dark_mae_conditioned_s": round(float(np.mean(
                [v["dark_mae_conditioned_s"] for v in variants])), 2),
            "dark_mape_pooled_pct": round(float(np.mean(
                [v["dark_mape_pooled_pct"] for v in variants])), 2),
            "dark_mape_conditioned_pct": round(float(np.mean(
                [v["dark_mape_conditioned_pct"] for v in variants])), 2),
            # gain per station, averaged over shifts, against how much the
            # build mix actually moves that station's work content
            "per_station": [
                {"sid": sid,
                 "variant_spread_s": rows_[0]["variant_spread_s"],
                 "pooled_mae_s": round(float(np.mean(
                     [r["pooled_mae_s"] for r in rows_])), 2),
                 "conditioned_mae_s": round(float(np.mean(
                     [r["conditioned_mae_s"] for r in rows_])), 2),
                 "gain_s": round(float(np.mean(
                     [r["pooled_mae_s"] - r["conditioned_mae_s"] for r in rows_])), 2)}
                for sid, rows_ in sorted(
                    ((sid, [r for v in variants for r in v["per_station"]
                            if r["sid"] == sid])
                     for sid in {r["sid"] for v in variants
                                 for r in v["per_station"]}),
                    key=lambda kv: -kv[1][0]["variant_spread_s"])],
        },
        "trust_loop": {
            "per_shift": trust_trend,
            "final_threshold_bump": ledger_state["threshold_bump"],
            "final_lifetime_precision": {
                kind: (round(g["true"] / (g["true"] + g["false"]), 3)
                       if (g["true"] + g["false"]) else None)
                for kind, g in ledger_state["graded"].items()},
        },
        "sensor_sweep": sensor_sweep(),
        "buffer_reconstruction_mae_units": round(float(np.mean(buf_scores)), 3),
        "multi_causal": run_multi_causal(
            max(4, seeds // 2), verbose=verbose),
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
