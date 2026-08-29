# AGENTS.md — TwinFlow

## Quick start

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cd frontend && npm install
```

Run the dashboard (two terminals):

```bash
# Terminal 1: FastAPI backend
uvicorn server:app --reload --port 8000

# Terminal 2: Vite dev server
cd frontend && npm run dev
# open http://localhost:5173/
```

The Vite dev server proxies `/api/*` to the FastAPI backend on :8000. The frontend fetches simulation data live from the backend — no pre-generated JSON files needed.

One exception: the Plant Manager view's cross-shift panels call `/api/history`, which runs ten
consecutive shifts (~20 s) unless `out/history.json` already holds a run of that length. Produce it
ahead of time so the view does not stall:

```bash
python3 build_history.py --shifts 10   # ~20 s, writes out/history.json
```

## Auth

Login credentials are in `users.json`. Each user sees only their own view:

| Username | Password | View |
|---|---|---|
| `floor` | `floor123` | Floor Supervisor |
| `manager` | `manager123` | Plant Manager |
| `leadership` | `leadership123` | Leadership |

Tokens are stored in-memory on the backend (`_active_tokens` dict). Sessions persist in the browser via `localStorage` and are validated against `/api/auth/me` on page refresh.

## Architecture (five layers, strict data flow)

```
L1  Line topology     line.py       — 42 stations, tiers A/B/C, buffers, build mix
L2  Virtual sensors   virtual_sensors.py — scans/PLC → work content + confidence
L3  Propagation       propagate.py  — starvation/blocking forecast, root cause
L4  Drift + genealogy drift.py, genealogy.py — process drift + containment list
L4b Defect-risk calib defect_model.py — two logistic models, fitted offline by fit_calibration.py
L5  Decision + trust  decision.py, twin.py — risk score, alert ledger, self-grading
```

**Critical rule**: Layers L2–L5 must never read simulator ground truth (`sim.truth`, `sim.faults`). The only exception is L5's `_grade()` scoring pass, which reads the plant's own downtime/quality log arriving late. L4b's coefficients are fitted entirely offline by `fit_calibration.py` on shifts `TwinFlow.run()` never sees — the twin only ever loads a finished `twinflow/calibration.json`, never trains on live data.

## Key constraints

- **No write path to PLCs.** Every output is a recommendation; humans decide.
- **No formal tests, linter, type checker, or CI.** Verify changes by running `run_demo.py` and `validate.py`.
- **Simulator is a stand-in, not fitted to real data.** Do not treat validation numbers as production benchmarks.

## Code structure

| File | Role |
|---|---|
| `twinflow/line.py` | `Station` dataclass, `build_line()` — loads the topology from `twinflow/lines/*.json`; `Station.cycle_for(variant)` / `.mix_cycle_s`, `variant_mix()` |
| `twinflow/lines/final_assembly_a.json` | The 42-station topology itself, as data — plus the `variants` build mix and per-station `variant_cycle_mult` |
| `twinflow/history.py` | `build_history()` — consecutive shifts with a carried-forward ledger, for the manager's weekly view |
| `twinflow/simulator.py` | `LineSimulator` — discrete-event plant stand-in, emits only what a real plant would |
| `twinflow/virtual_sensors.py` | `VirtualSensorBank` — infers work content at dark stations from barcode scans |
| `twinflow/propagate.py` | `PropagationEngine` — event-to-event starvation/blocking forecast |
| `twinflow/drift.py` | `DriftBank` — EWMA + CUSUM drift detection with hold counter |
| `twinflow/genealogy.py` | `GenealogyStore` — which station, which bodies at risk |
| `twinflow/defect_model.py` | `DefectRiskModel` — `alert_model` (informational confidence, not a firing gate — see gotchas) and `origin_model` (per-body containment ranking, live) |
| `twinflow/decision.py` | `risk_score()`, `AlertLedger`, action recommenders |
| `twinflow/twin.py` | `TwinFlow` — wires all layers, runs over event feed |
| `run_demo.py` | Entry point: one shift → JSON for dashboard |
| `validate.py` | Multi-seed validation harness. Also `multi_causal_scenario()` / `attribution_scoring()` for the hard-cause slice, and `variant_conditioning()` |
| `build_history.py` | Entry point: N consecutive shifts → `out/history.json` for the manager view |
| `fit_calibration.py` | Offline fit for `twinflow/calibration.json`, on shifts disjoint from `validate.py` and `run_demo.py` |
| `server.py` | FastAPI backend: `/api/run-demo`, `/api/unit-risk/{uid}`, `/api/what-if`, `/api/validate` (SSE), `/api/history`, `/api/line-info`, `/api/auth/login`, `/api/auth/me` |
| `users.json` | Login credentials: floor/floor123, manager/manager123, leadership/leadership123 |

## Event schema

All layers read: `{t, sid, uid, variant, zone, tier, scan_ok, mes_scan, cycle_s, station_time_s, blocked_s, motion_duty, params}`. `scan_ok` is load-bearing (gates departure recording at dark stations). `cycle_s`, `motion_duty`, `params` are conditionally `None`/`{}` by tier. `variant` is MES build-order data — present at every tier including dark stations, `None` on a line spec with no `variants` block. Layers never reference stations by name — lookups go through tier and declared process parameters.

## Mixed model

The line builds three variants (`SEDAN` 0.52 / `SUV` 0.34 / `WAGON` 0.14, declared in the line JSON's
`variants` block). A station's work content is `nominal_cycle_s × variant_cycle_mult[variant]`, with
the multiplier defaulting line-wide and overridden per station where the work genuinely differs
(seat set, harness, headliner, metal finish). Two consequences that are easy to get wrong:

- **Compare against `mix_cycle_s`, never `nominal_cycle_s`.** Every cycle time the twin observes is
  an average over the models that actually ran. `TwinFlow.nominal`, `PropagationEngine.nominal` and
  the naive takt baseline in `validate.py` are all mix-weighted for this reason. Scoring an observed
  cycle against the base variant's standard books the build mix as a process fault.
- **L2 keeps one EWMA per variant per station** (`_Track.by_variant`, used after
  `MIN_VARIANT_N` bodies of that model), falling back to the pooled track. `current_cycles()` still
  returns the pooled value — that is the right rate for a forecast over a horizon long enough to
  build the mix. `VirtualSensorBank(stations, use_variant=False)` restores the single-population
  behaviour, which is how `validate.py:variant_conditioning()` measures what the build order is worth.

## Gotchas

- `validate.py` takes about a minute for 8 shifts on current hardware — don't cancel early expecting
  a hang. `fit_calibration.py` is the slow one now: ~18 min for the 200 shifts the L4b defect-risk
  models need (see below).
- Dashboard is a Vite + React + TypeScript app in `frontend/`. It fetches `/api/run-demo` and the `/api/validate` SSE stream live, so after an engine change you only need to restart the backend — there is no build step to re-embed data. `run_demo.py` is for producing `out/twin_run.json` as a standalone artifact.
- `server.py` re-implements `validate.py`'s scoring helpers and `run_demo.py:build_payload()` rather than importing them. Change one, change the other, or the dashboard and the CLI will disagree. (`trust_loop_row`, `variant_conditioning`, `forecast_accuracy` and `forecast_summary` are the exceptions — `server.py` imports those from `validate` rather than keeping a copy.)
- **The 30-minute output forecast is scored on a split, and the twin does not win it outright.** `forecast_accuracy()` partitions probe windows by whether a *throughput-affecting* fault was live (`THROUGHPUT_FAULT_KINDS` — `cycle`/`operator`/`ambient`; a `param` calibration drift changes what comes off the line, not how fast, and counting those put 95% of windows in the "faulted" bucket). Pooled over 8 shifts the twin is ~6% better than a constant-takt baseline when throughput is degraded, level overall, and *worse* on a healthy line — a line running at takt is genuinely easy to predict. `forecast_summary()` pools raw errors across shifts rather than averaging per-shift MAEs, because splits differ wildly in size. Both estimators still over-call output by ~2 units per 30 min even after `PropagationEngine.forecast(availability=...)` scales the capable rate by what the end-of-line counter implies. The Leadership view states all of this rather than leading with a percentage.
- Defect-drift alert precision is ~24% by design — the README explains why (recall is 100%). `fit_calibration.py`'s `alert_model` was built to raise it. Evaluated with 5-fold CV + a Wilson lower bound over 200 shifts it *does* clear the precision floor (66.7% out-of-fold against a 19.4% base rate) — but at 18.7% recall, which is why `TwinFlow._defect_alerts()` still fires and gates on the original hand-tuned formula and `alert_model`'s output is attached as an extra evidence line only. Not gating is a deliberate trade, not an oversight; read `twinflow/defect_model.py`'s module docstring before changing it.
- **L4b features are load-bearing and easy to break silently.** `ALERT_FEATURE_NAMES` / `ORIGIN_FEATURE_NAMES` are written into `twinflow/calibration.json` and checked on load, so a schema change makes the twin ignore the file (and print why) rather than dot a stale coefficient vector against mismatched columns — but that also means **after changing either list you must re-run `fit_calibration.py`, or L4b silently switches off**. If you add a feature, check it actually varies across the collected training rows: two previous ones were constant by construction, and the fit reported nothing wrong.
- **The alert ledger's retune loop only works across shifts.** `AlertLedger._retune()` needs 5 graded
  alerts of a kind before it moves a threshold, and DEFECT_RISK fires ~2.5 per shift — so with a
  ledger that resets each shift it never engaged at all. `TwinFlow(stations, ledger_state=...)` plus
  `AlertLedger.export_state()` carries `threshold_bump` and per-kind TRUE/FALSE counts forward;
  `validate.py`, `server.py:_validate_stream()` and `twinflow/history.py` all thread it. `precision()`
  stays this-shift-only (what the dashboard shows); `lifetime_precision()` is what the loop acts on.
  The loop also adjusts only when the graded population *grows* — `resolve()` runs every frame, and
  bumping on every call saturates the threshold within minutes.
- **Simulator fault kinds beyond `cycle`/`param`:** `ambient` (zone-wide environmental driver, moves
  every parameter in the zone by its own `drift_sensitivity`, magnitude in sigmas), `operator` (a
  manning change, folded into `_fault_cycle_mult` but scored separately), `carry_in` (defect surfaces
  at `station`, caused by `source` upstream — `_defect_roll()` returns the origin an 8D would name,
  which for these is *not* the station the defect was created at). Any kind becomes intermittent via
  `duty_on_s`/`duty_off_s`. `validate.py:multi_causal_scenario()` builds shifts with one of each and
  `attribution_scoring()` scores them; they run as a separate slice so the headline single-cause
  numbers stay comparable.
- `run_demo.py`, `validate.py` and `build_history.py` have `__main__` guards; `server.py` has none and must be launched through uvicorn. There is no installable package — imports are direct (`from twinflow.line import ...`) and resolve via `sys.path`, so run everything from the repo root.
- The Vite proxy (`/api/*` → `localhost:8000`) is configured in `frontend/vite.config.ts`. Both servers must be running for the dashboard to load data.
