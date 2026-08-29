"""
FastAPI backend for TwinFlow.

Endpoints:
  GET  /api/line-info       — static station metadata
  GET  /api/run-demo        — one-shift simulation, returns TwinData JSON
  GET  /api/unit-risk/{uid} — one body's passport, ranked by L4b origin_model belief
  POST /api/what-if         — perturb a station's cycle time, compare forecasts
  GET  /api/validate        — SSE stream, one event per shift, final event has full ValidationData

Run with:
  uvicorn server:app --reload --port 8000
"""

import json
import math
import secrets
import statistics as stats
from collections import defaultdict
from pathlib import Path
from typing import Dict, List

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from twinflow.line import build_line, tier_summary, variant_mix, TIER_C
from twinflow.simulator import LineSimulator, Fault, default_scenario
from twinflow.twin import TwinFlow
from twinflow.history import build_history
from twinflow.virtual_sensors import VirtualSensorBank
from twinflow.propagate import PropagationEngine
from twinflow import decision as D
# The scoring helpers below are deliberate copies of validate.py's (see
# CLAUDE.md); trust_loop_row is pure formatting over a ledger summary, so it
# is imported rather than copied a fifth time.
from validate import (trust_loop_row, variant_conditioning, run_multi_causal, buffer_score,
                      is_material_fault, forecast_accuracy, forecast_summary)

app = FastAPI(title="TwinFlow API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

HORIZON = 28800

_demo_cache: Dict[tuple, dict] = {}
_history_cache: Dict[int, dict] = {}
_validate_cache: Dict[int, List[str]] = {}
# Keyed the same as _demo_cache. Holds the live TwinFlow + LineSimulator
# objects a run-demo call built, so /api/unit-risk and /api/what-if can
# reuse the engine's own passports and PropagationEngine instead of
# recomputing a shift from scratch. Mirrors the pattern used everywhere
# else in this repo: server.py and validate.py duplicate scoring logic
# rather than importing each other, per CLAUDE.md — this cache exists so
# these two new endpoints don't have to duplicate run_demo() itself.
_demo_engine_cache: Dict[tuple, tuple] = {}

# ── auth ──────────────────────────────────────────────────────────────

_USERS_PATH = Path(__file__).parent / "users.json"
_USERS = {u["username"]: u for u in json.loads(_USERS_PATH.read_text())["users"]}
_active_tokens: Dict[str, dict] = {}


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def auth_login(body: LoginRequest):
    user = _USERS.get(body.username)
    if not user or user["password"] != body.password:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = secrets.token_hex(16)
    _active_tokens[token] = {"role": user["role"], "display_name": user["display_name"]}
    return {"token": token, "role": user["role"], "display_name": user["display_name"]}


@app.get("/api/auth/me")
def auth_me(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.removeprefix("Bearer ").strip()
    session = _active_tokens.get(token)
    if not session:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return {"role": session["role"], "display_name": session["display_name"]}


@app.post("/api/auth/logout")
def auth_logout(authorization: str = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
        _active_tokens.pop(token, None)
    return {"ok": True}


# ── helpers ported from validate.py ──────────────────────────────────

def _random_scenario(rng, stations) -> List[Fault]:
    cyc_pool = [s for s in stations if s.index not in (0, len(stations) - 1)]
    par_pool = [s for s in stations if any(
        k in s.process_params
        for k in ("bolt_torque_nm", "film_thickness_um", "weld_current_a")
    )]
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
    s = par_pool[int(rng.integers(0, len(par_pool)))]
    p = list(s.process_params.keys())[0]
    tstart = int(rng.integers(3000, 24000))
    faults.append(Fault(kind="param", station=s.sid, param=p, start_s=tstart,
                        ramp_s=45, end_s=tstart + int(rng.integers(150, 400)),
                        magnitude=float(rng.uniform(2.5, 4.0) *
                                        s.process_params[p]["sigma"]),
                        label="transient"))
    return faults


def _spec_limit_baseline(sim) -> Dict[str, int]:
    first: Dict[str, int] = {}
    stations_map = {s.sid: s for s in sim.stations}
    for ev in sim.events:
        st = stations_map[ev["sid"]]
        for p, v in (ev.get("params") or {}).items():
            spec = st.process_params[p]
            if v < spec["lsl"] or v > spec["usl"]:
                first.setdefault(f"{ev['sid']}/{p}", ev["t"])
    return first


def _detection_scoring(res, sim) -> dict:
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


def _sensor_sweep(seed: int = 11) -> List[dict]:
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


# ── streaming validation runner ──────────────────────────────────────

def _validate_stream(seeds: int = 8):
    """Yield per-shift SSE data dicts, then yield the final summary dict."""
    rows, fcs, variants, buf_scores = [], [], [], []
    per_kind = defaultdict(lambda: {"true": 0, "false": 0, "lead": []})
    saved_units, baseline_lead = [], []
    # mirrors validate.py: the ledger's threshold retune carries across shifts
    ledger_state = None
    trust_trend = []

    for k in range(seeds):
        rng = np.random.default_rng(1000 + k)
        stations = build_line()
        faults = _random_scenario(rng, stations)
        sim = LineSimulator(stations=stations, faults=faults,
                            horizon_s=HORIZON, seed=2000 + k).run()
        tw = TwinFlow(stations, ledger_state=ledger_state)
        res = tw.run(sim, frame_every_s=120)
        ledger_state = res["ledger_state"]
        trust_trend.append(trust_loop_row(k + 1, res["ledger"]))

        r = _detection_scoring(res, sim)
        rows.append(r)
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

        spec_first = _spec_limit_baseline(sim)
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
                n = sum(1 for x in sim.truth if x["sid"] == f.station
                        and twin_t <= x["t"] <= (spec_t or HORIZON))
                saved_units.append(n)

        yield {
            "shift": k + 1,
            "total": seeds,
            "recall": round(r["recall"], 3),
            "precision": round(r["precision"], 3) if r["precision"] is not None else None,
            "alerts_fired": r["alerts_fired"],
            "transient_false_alarms": r["transient_false_alarms"],
        }

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
        # mirrors validate.py — see the comment there for why this bounds
        # measured DEFECT_RISK precision more than the detector does
        "defect_risk_context": {
            "material_param_faults": int(sum(
                r.get("material_param_faults", 0) for r in rows)),
            "defect_alerts_graded": (per_kind[D.DEFECT_RISK]["true"] +
                                     per_kind[D.DEFECT_RISK]["false"]),
            "material_recall": (round(float(np.mean(
                [r["material_recall"] for r in rows
                 if r.get("material_recall") is not None])), 3)
                if any(r.get("material_recall") is not None for r in rows) else None),
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
            "build_mix": variant_mix(build_line()),
            "dark_mae_pooled_s": round(float(np.mean(
                [v["dark_mae_pooled_s"] for v in variants])), 2),
            "dark_mae_conditioned_s": round(float(np.mean(
                [v["dark_mae_conditioned_s"] for v in variants])), 2),
            "dark_mape_pooled_pct": round(float(np.mean(
                [v["dark_mape_pooled_pct"] for v in variants])), 2),
            "dark_mape_conditioned_pct": round(float(np.mean(
                [v["dark_mape_conditioned_pct"] for v in variants])), 2),
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
        "sensor_sweep": _sensor_sweep(),
        "buffer_reconstruction_mae_units": round(float(np.mean(buf_scores)), 3),
        # the hard-cause slice, same as validate.py's — runs its own shifts on
        # seeds disjoint from the ones streamed above
        "multi_causal": run_multi_causal(max(4, seeds // 2), verbose=False),
    }
    yield summary


# ── routes ───────────────────────────────────────────────────────────

@app.get("/api/line-info")
def line_info():
    stations = build_line()
    tiers = tier_summary(stations)
    line = [{
        "sid": s.sid, "name": s.name, "zone": s.zone, "index": s.index,
        "tier": s.tier, "nominal_cycle_s": s.nominal_cycle_s,
        "mix_cycle_s": round(s.mix_cycle_s, 2),
        "variant_cycle_mult": s.variant_cycle_mult,
        "has_camera": s.has_camera, "is_inspection": s.is_inspection,
        "manual_check": s.manual_check, "out_buffer_cap": s.out_buffer_cap,
        "params": list(s.process_params.keys()),
    } for s in stations]
    zone_totals = {}
    for s in stations:
        zone_totals.setdefault(s.zone, {"count": 0, "A": 0, "B": 0, "C": 0})
        zone_totals[s.zone]["count"] += 1
        zone_totals[s.zone][s.tier] += 1
    return {"stations": line, "tiers": tiers, "zone_totals": zone_totals}


@app.get("/api/run-demo")
def run_demo(
    horizon_s: int = Query(28800, ge=600, le=86400),
    seed: int = Query(7, ge=0),
):
    cache_key = (seed, horizon_s)
    if cache_key in _demo_cache:
        return _demo_cache[cache_key]

    stations = build_line()
    sim = LineSimulator(stations=stations, faults=default_scenario(),
                        horizon_s=horizon_s, seed=seed).run()
    tw = TwinFlow(stations)
    res = tw.run(sim, frame_every_s=120)
    _demo_engine_cache[cache_key] = (tw, sim)

    line = [{
        "sid": s.sid, "name": s.name, "zone": s.zone, "index": s.index,
        "tier": s.tier, "nominal_cycle_s": s.nominal_cycle_s,
        "mix_cycle_s": round(s.mix_cycle_s, 2),
        "variant_cycle_mult": s.variant_cycle_mult,
        "has_camera": s.has_camera, "is_inspection": s.is_inspection,
        "manual_check": s.manual_check, "out_buffer_cap": s.out_buffer_cap,
        "params": list(s.process_params.keys()),
    } for s in stations]

    fault_windows = [{
        "station": f.station, "kind": f.kind, "param": f.param,
        "start_s": f.start_s, "end_s": f.end_s, "label": f.label,
    } for f in sim.faults]

    zone_totals = {}
    for s in stations:
        zone_totals.setdefault(s.zone, {"count": 0, "A": 0, "B": 0, "C": 0})
        zone_totals[s.zone]["count"] += 1
        zone_totals[s.zone][s.tier] += 1

    quality = [{"t": q["t"], "uid": q["uid"], "inspection": q["inspection"],
                "result": q["result"], "defect_type": q.get("defect_type"),
                "origin": q.get("origin_station")} for q in sim.quality]

    throughput = sim.throughput_series(600)

    fails = [q for q in sim.quality if q["result"] == "FAIL"]
    # what the line actually built this shift, against the declared mix
    variant_counts = {}
    for u in sim.units().values():
        if u.variant:
            variant_counts[u.variant] = variant_counts.get(u.variant, 0) + 1
    origin_counts = {}
    for q in fails:
        origin_counts[q["origin_station"]] = origin_counts.get(q["origin_station"], 0) + 1

    tiers = tier_summary(stations)
    result = {
        "meta": {
            "horizon_s": horizon_s, "seed": seed,
            "n_stations": len(stations), "tiers": tiers,
            "n_events": len(sim.events), "n_completed": len(sim.completed),
            "n_quality_checks": len(sim.quality), "n_fails": len(fails),
            "build_mix": variant_mix(stations),
            "variant_counts": variant_counts,
        },
        "line": line,
        "zone_totals": zone_totals,
        "fault_windows": fault_windows,
        "frames": res["frames"],
        "alerts": res["alerts"],
        "ledger": res["ledger"],
        "throughput_series": throughput,
        "quality_origin_counts": origin_counts,
        "quality_events": quality[-400:],
    }
    _demo_cache[cache_key] = result
    return result


@app.get("/api/unit-risk/{uid}")
def unit_risk(
    uid: int,
    horizon_s: int = Query(28800, ge=600, le=86400),
    seed: int = Query(7, ge=0),
):
    """One body's passport, with the L4b origin_model's belief that each
    station it passed is what put a defect into it — "likely contributor",
    never "root cause". Needs an /api/run-demo call for this seed/horizon_s
    first (the dashboard always makes one); this route triggers it itself
    if that has not happened yet.
    """
    cache_key = (seed, horizon_s)
    if cache_key not in _demo_engine_cache:
        run_demo(horizon_s=horizon_s, seed=seed)
    tw, sim = _demo_engine_cache[cache_key]

    passport = tw.gen.passports.get(uid)
    if passport is None:
        raise HTTPException(status_code=404,
                            detail=f"unit {uid} not found in this run")

    stations = []
    for sid, rec in passport.items():
        row = tw.unit_features.get(uid, {}).get(sid)
        risk = tw.defect_model.body_risk(row) if tw.defect_model is not None else None
        stations.append({
            "sid": sid, "t": rec["t"], "cycle_s": rec.get("cycle_s"),
            "params": rec.get("params", {}),
            "risk": round(risk, 4) if risk is not None else None,
        })
    stations.sort(key=lambda s: tw.sids.index(s["sid"]))
    ranked = sorted([s for s in stations if s["risk"] is not None],
                    key=lambda s: -s["risk"])

    return {
        "uid": uid,
        "disposition": tw.gen.dispositions.get(uid),
        "stations": stations,
        "likely_contributors": ranked[:5],
        "model_available": tw.defect_model is not None,
    }


class WhatIfRequest(BaseModel):
    seed: int = 7
    horizon_s: int = 28800
    t: int
    overrides: Dict[str, float]   # sid -> delta seconds added to cycle time


@app.post("/api/what-if")
def what_if(body: WhatIfRequest):
    """Perturb one or more stations' cycle time at a point in an already-run
    shift and compare PropagationEngine.forecast() before and after.
    forecast() is a pure function of (cycles, buffers) — this is one extra
    call with a perturbed cycles dict, not a second simulation.
    """
    cache_key = (body.seed, body.horizon_s)
    if cache_key not in _demo_cache:
        run_demo(horizon_s=body.horizon_s, seed=body.seed)
    payload = _demo_cache[cache_key]

    frames = payload["frames"]
    if not frames:
        raise HTTPException(status_code=404, detail="no frames in this run")
    frame = min(frames, key=lambda f: abs(f["t"] - body.t))

    sids = [s["sid"] for s in payload["line"]]
    unknown = [sid for sid in body.overrides if sid not in sids]
    if unknown:
        raise HTTPException(status_code=400,
                            detail=f"unknown station id(s): {unknown}")

    cycles = {sid: frame["cyc"][i] for i, sid in enumerate(sids)}
    buffers = {sid: frame["buf"][i] for i, sid in enumerate(sids)}

    stations = build_line()
    eng = PropagationEngine(stations)

    def summarize(fc):
        return {
            "constraint_sid": fc.constraint_sid,
            "constraint_cycle_s": fc.constraint_cycle_s,
            "rate_loss_per_hr": fc.rate_loss_per_hr,
            "runway_min": round(fc.runway_s / 60.0, 1),
            "deficit_units": fc.deficit_units,
        }

    baseline_fc = eng.forecast(cycles, buffers, horizon_s=1800)
    perturbed = dict(cycles)
    for sid, delta in body.overrides.items():
        perturbed[sid] = max(1.0, perturbed[sid] + delta)
    what_if_fc = eng.forecast(perturbed, buffers, horizon_s=1800)

    return {
        "t": frame["t"], "overrides": body.overrides,
        "baseline": summarize(baseline_fc),
        "what_if": summarize(what_if_fc),
    }


@app.get("/api/history")
def history(shifts: int = Query(10, ge=2, le=30)):
    """A week of consecutive shifts for the Plant Manager view.

    Served from out/history.json when build_history.py has produced it —
    ten shifts take about 20 s to run, which is too long to sit behind a
    page load. Computed on demand and cached in memory otherwise.
    """
    if shifts in _history_cache:
        return _history_cache[shifts]

    path = Path(__file__).parent / "out" / "history.json"
    if path.exists():
        with open(path) as f:
            cached = json.load(f)
        if cached.get("shifts") == shifts:
            _history_cache[shifts] = cached
            return cached

    hist = build_history(shifts, seed0=300, scenario=_random_scenario)
    _history_cache[shifts] = hist
    return hist


@app.get("/api/validate")
def run_validate(
    shifts: int = Query(8, ge=1, le=32),
):
    if shifts in _validate_cache:
        def replay():
            for event in _validate_cache[shifts]:
                yield event
        return StreamingResponse(
            replay(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    def event_stream():
        events: List[str] = []
        gen = _validate_stream(seeds=shifts)
        for item in gen:
            if "shift" in item:
                event_str = f"event: progress\ndata: {json.dumps(item)}\n\n"
            else:
                event_str = f"event: result\ndata: {json.dumps(item)}\n\n"
            events.append(event_str)
            yield event_str
        _validate_cache[shifts] = events

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
