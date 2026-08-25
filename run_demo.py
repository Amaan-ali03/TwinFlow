"""
Runs one full shift through the twin and writes everything the dashboard
needs into a single JSON file. This is the only place that touches the
filesystem for output; twinflow/ itself has no I/O side effects.
"""

import argparse
import json
import os

from twinflow.line import build_line, tier_summary
from twinflow.simulator import LineSimulator, default_scenario
from twinflow.twin import TwinFlow


def build_payload(horizon_s: int = 28800, seed: int = 7) -> dict:
    stations = build_line()
    sim = LineSimulator(stations=stations, faults=default_scenario(),
                        horizon_s=horizon_s, seed=seed).run()
    tw = TwinFlow(stations)
    res = tw.run(sim, frame_every_s=120)

    line = [{
        "sid": s.sid, "name": s.name, "zone": s.zone, "index": s.index,
        "tier": s.tier, "nominal_cycle_s": s.nominal_cycle_s,
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
    origin_counts = {}
    for q in fails:
        origin_counts[q["origin_station"]] = origin_counts.get(q["origin_station"], 0) + 1

    tiers = tier_summary(stations)
    payload = {
        "meta": {
            "horizon_s": horizon_s, "seed": seed,
            "n_stations": len(stations), "tiers": tiers,
            "n_events": len(sim.events), "n_completed": len(sim.completed),
            "n_quality_checks": len(sim.quality), "n_fails": len(fails),
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
    return payload


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--horizon", type=int, default=28800)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="out/twin_run.json")
    args = ap.parse_args()

    print("Building the 42 station line and running an 8 hour shift...")
    payload = build_payload(args.horizon, args.seed)
    m = payload["meta"]
    print(f"  stations: {m['n_stations']}  tiers A/B/C: "
          f"{m['tiers']['A']}/{m['tiers']['B']}/{m['tiers']['C']}")
    print(f"  bodies completed: {m['n_completed']}  quality checks: "
          f"{m['n_quality_checks']}  fails: {m['n_fails']}")
    print(f"  alerts fired: {len(payload['alerts'])}")
    print(f"  ledger precision: {payload['ledger']['precision_all']}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f)
    size_kb = os.path.getsize(args.out) / 1024
    print(f"\nwritten to {args.out} ({size_kb:.0f} KB)")
