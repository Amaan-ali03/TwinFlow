# TwinFlow — Predictive Digital Twin for a Mixed Model Assembly Line

DigitalTwin.ai · Round 2 · Team Triumph (Amaan Ali, Pranjal Kole, Saatvik Pandey)

TwinFlow watches a plant's existing data exhaust — MES barcode scans, PLC handshakes, process
sensors where they exist, one or two retrofit webcams where they don't — and turns it into three
things a dashboard cannot produce on its own: a forecast of *when* a station runs dry or backs up
and *why*, an early warning that a process is drifting toward a defect while every reading is still
inside specification, and a numbered containment list instead of an open ended recall.

Nothing here writes to a PLC. Every output is a risk score, the evidence behind it, a named action
and an owner. A human decides. That is a design choice, not a limitation — it is what makes the
system installable during a normal production week instead of waiting for an annual shutdown.

## What's in this submission

| File | What it is |
|---|---|
| `frontend/` | Vite + React + TypeScript dashboard — three role-specific views, fed live by the backend |
| `twinflow/` | The five(-and-a-half) layer engine — line model, simulator, virtual sensors, propagation, drift, genealogy, decision, L4b defect-risk calibration |
| `twinflow/lines/` | Line topology as JSON — `build_line()` loads it instead of hardcoding a station list, so the same engine points at a different line by swapping the file |
| `server.py` | FastAPI backend the dashboard talks to — runs the engine on demand, answers what-if and per-body risk queries, and streams validation progress |
| `users.json` | The three demo logins, one per dashboard view |
| `run_demo.py` | Runs one full 8 hour shift and exports the JSON as a standalone artifact |
| `validate.py` | Multi seed validation harness — the numbers below come from this, not from the demo shift. Includes the multi-causal slice and the build-order conditioning comparison |
| `build_history.py` | A week of consecutive shifts with a carried-forward ledger → `out/history.json`, for the manager view's cross-shift panels |
| `fit_calibration.py` | Offline fit for the L4b defect-risk models, on shifts `validate.py` and `run_demo.py` never see |
| `out/validation.json` | Raw output of the last validation run |
| `ARCHITECTURE.md` | Five layer design, data contracts, and why each layer exists |

## Running it yourself

```bash
pip install -r requirements.txt
python3 fit_calibration.py --shifts 200           # ~25 min, fits twinflow/calibration.json — optional,
                                                    #   everything below still runs without it
python3 run_demo.py --out out/twin_run.json      # ~2s, one 8 hour shift
python3 validate.py --shifts 8                    # ~2 min, independently seeded shifts
python3 build_history.py --shifts 10             # ~20s, a week of shifts for the manager view
```

`fit_calibration.py` is optional. Defect-drift alerts always fire and gate on the original
hand-tuned confidence formula, calibration file or not (see "Alert quality" below for why). Without
`twinflow/calibration.json`, the only things missing are the `at_risk_ranked` per-body containment
ranking on those alerts and the informational learned-confidence evidence line — the rest of the
engine is unaffected either way.

Dashboard — the frontend fetches its data live from the backend, so both need to be running:

```bash
# Terminal 1
uvicorn server:app --reload --port 8000

# Terminal 2
cd frontend && npm install && npm run dev
# open http://localhost:5173/
```

Log in as `floor` / `floor123`, `manager` / `manager123` or `leadership` / `leadership123` — each
account opens the view written for that role.

## The line

42 stations, 30–50 as specified in the brief, across body construction (14), paint (10) and final
assembly (18). Sensor coverage is deliberately uneven, matching the brief's "majority instrumented,
meaningful minority manual":

| Tier | Count | What the twin sees |
|---|---|---|
| A — full sensors | 25 | PLC cycle handshake + torque, vibration, temperature, or similar process signals |
| B — cycle only | 9 | PLC handshake, no process sensor |
| C — dark / manual | 8 | Barcode scan only. 3 of these carry a retrofit webcam |

It is a mixed model line, in the data and not just in the description: three variants (SEDAN 0.52,
SUV 0.34, WAGON 0.14) with per-station work content that genuinely differs where the work differs —
11.9 s between the fastest and slowest model at FA02 harness lay-in, 9.6 s at FA06 headliner, 3.1 s
at PT09 paint inspect. This matters most exactly where the twin is weakest: at a dark station the
model mix makes work content multi-modal, and the spread between models is larger than the drift the
twin is trying to detect. Every standard the twin compares an observed cycle time against is
therefore mix-weighted, never the base variant's — otherwise an SUV-heavy hour books as a process
fault.

## What's validated, and how

All numbers below are from `validate.py` run over independently seeded shifts with **randomised**
fault stations, timings and magnitudes the twin has never been tuned against — this is a
counterfactual backtest, not a fit to the demo scenario. Every alert is graded after the fact
against the plant's own downtime log and quality dispositions, which arrive late, exactly as they
would in a real installation.

**Virtual sensors** — inferred work content at completely uninstrumented stations:
- 4.4 s mean absolute error, ≈6.4% MAPE, near zero bias
- Buffer level, reconstructed from barcode scan counters alone: 0.63 units MAE
- The twin identifies the unknown work-in-progress offset in each buffer on its own — no manual
  calibration needed to start mid shift
- **Conditioning on the build order is what gets it there.** Pooling every model into one estimate
  gives 5.1 s / 7.5% on the same shifts; per-variant tracks give 4.4 s / 6.4%. The gain follows how
  much the mix actually moves that station's work — +1.2 s at FA02 harness lay-in, +0.1 s at PT09
  paint inspect — and it costs nothing to acquire, because build order is MES data that is already
  readable at a dark station.

**Alert quality**, 8 shifts, random faults:
| Alert type | Fired/shift | Precision | Median lead time |
|---|---|---|---|
| Bottleneck propagation | ~5 | 98% | 73 min before the end-of-line counter would show it |
| Dark station inference | ~0.5 | 100% | — |
| Defect drift | ~2.5 | 5%* | — |

\* *Flagged honestly, not hidden — and read the denominator before reading the number.* Defect drift
alerts catch every material drift injected (material recall 100%, as they did at the 24% figure this
README used to quote). The precision figure is bounded by the scenario, not by the detector: across
these 8 shifts the randomised generator injected 11 parameter drifts, of which **1** raised the
station's own fallout enough to clear the grader's materiality bar (two-proportion z ≥ 1.64 *and* an
absolute rise ≥ 3 points). One gradeable-TRUE cause against 20 graded alerts caps measured precision
near 5% however good the detector is. The earlier 24% came from a run where 2 of 11 cleared that bar
— the metric moved because the number of material drifts moved, and a metric that swings 24% → 5% on
a count going 2 → 1 has almost no statistical power. Both numbers are in
`out/validation.json:defect_risk_context`; neither should be read to a point.

Making the mix real is what moved it: variants slow the line about 3% (367 → 357 bodies a shift), so
several borderline drifts fell below a materiality bar they had been clearing on sample size alone.
That is a fair thing to have happened — it says the old 24% was partly an artifact of a
single-model line — but the honest conclusion is that this harness cannot measure defect-drift
precision to better than a factor of several, and the generator was deliberately left alone rather
than retuned to produce a friendlier denominator.

The confidence calibration on *when* to say so was the next piece of work, and we did it:
`fit_calibration.py` fits a logistic model (`alert_model`) against this same grading logic over 200
held-out shifts — 554 fired alerts, 17.7% of them graded TRUE.

It works, and we still don't use it as a gate. The 5-fold out-of-fold precision/recall curve is a
clean monotone trade, not a flat line:

| Alerts fired | Recall | Precision | Wilson lower bound |
|---|---|---|---|
| 9 (the selected cutoff) | 7.1% | 77.8% | 56.6% |
| 25 | 13.3% | 52.0% | 39.5% |
| 75 | 33.7% | 44.0% | 36.9% |
| 150 | 49.0% | 32.0% | 27.3% |
| 300 | 74.5% | 24.3% | 21.3% |
| 554 | 100% | 17.7% | 15.7% |

There is a cutoff whose *lower* bound clears the 55% precision floor — and it sits at 7.1% recall,
nine alerts out of 554. Buying that precision by missing thirteen material drifts in fourteen is a
different product from the one this README opens by describing. So alerts still fire and gate on the
original formula, and the learned probability rides along as an extra evidence line, useful for
ordering which of several open drift alerts a supervisor walks to first. (The mixed-model refit moved
this operating point further out than the single-model line's did — it cleared the floor at 18.7%
recall before — which sharpens the conclusion rather than changing it.)

Worth saying plainly, because the previous version of this section said the opposite: it reported
that precision was flat across the whole recall range and concluded drift shape carries no
materiality signal at all. That was wrong, and wrong for an unglamorous reason — two of the six
features were structurally constant (one clipped to 1.0 on rows that had already cleared the hold
counter, one always 0.0 because the training collector overwrote the timestamp it was meant to read),
and rows were sampled once per station per shift instead of once per alert actually fired. The fit
returned plausible coefficients and a plausible cross-validated curve anyway. Full details in
`twinflow/defect_model.py`'s module docstring.

**Against a conventional specification-limit alarm** (the industry default): median lead time gain
was 174 minutes, and in 64% of tested cases the spec alarm never fired at all before the shift
ended, because the drift never left the specification window even though it was already producing
measurable fallout downstream.

**When the cause is not where the symptom is.** Everything above assumes one cause at one station,
ramping once. The brief says real root causes are multi-causal and intermittent, so the harness runs
a separate slice of shifts that break that assumption (`validate.py:multi_causal_scenario`, disjoint
seeds from the headline runs):

| Hard cause | What the twin does |
|---|---|
| **Carry-in** — a parameter drifts at station *i*, the defect surfaces at station *j* downstream where nothing is out of tolerance | Names the true source station in 4 of 4 cases, never the symptom station. The passport trace is what makes this work: genealogy separates failing from passing bodies on the *upstream* station's readings |
| **Intermittent** — an equipment fault duty-cycled on and off, distinct from a transient that self-corrects | Detected in 4 of 4, but at ~9 min median lead instead of the ~73 min a monotone fault gives. Each "on" phase has to re-establish itself |
| **Operator variation** — a manning change at a manual station at a break boundary, no equipment fault at all | Detected in 4 of 4, through the dark-station inference path. The twin cannot say *why*, which is correct: it recommends checking manning and material, and a human decides |
| **Ambient** — one zone-wide environmental driver moving every parameter in the zone at once | **Detected, and attributed wrongly.** It blames 7.5 stations on average, which is every instrumented station in the zone. One cause, up to ten alerts naming ten different tools |

The ambient result is the honest failure of this design and it is in `ARCHITECTURE.md` as such, not
in a footnote. Every detector from L4 up is univariate and per-station, which is exactly what makes
root cause explainable when there *is* one station — and makes a shared cause look like a
coincidence of ten. The fix is a zone-level correlation test that asks whether stations drifting
together share an environment before any of them raises a per-tool alert. It is not built.

**Across shifts, not just within one.** `build_history.py` runs consecutive shifts with the alert
ledger carried forward and writes `out/history.json`; the Plant Manager view reads it from
`/api/history`. Over ten randomised shifts, the recurring-constraint table is the output a weekly
planning meeting actually opens with — PT06 primer sand and BS05 side frame each bound the line in
2 of 10 shifts, and a station that recurs is a capacity decision while one that appears once is a
bad day. That question cannot be answered from a single shift no matter how it is rendered, which is
what previously made the manager tier a slower version of the floor tier.

**Per-body containment ranking** — the other half of L4b, `origin_model`, is a genuine improvement.
Trained on each body's own instantaneous process reading against the plant's own retrospective
root-cause attribution (which station a failed unit's quality disposition names as the origin), it
turns `genealogy.containment()`'s flat "these N bodies passed the station while it drifted" list
into a ranked one — "start inspecting these bodies first" — surfaced on every DEFECT_RISK alert as
`at_risk_ranked` and queryable per body via `/api/unit-risk/{uid}`. Its coefficients come out with
the signs you'd expect (this body's own reading is the strongest predictor, sign positive) and it
answers a different, easier question than alert_model above: not "is this station's drift material
population-wide" but "of the bodies already known to be at risk, which ones most likely got the
defect" — a relative ranking, not an absolute rate, which is why it doesn't need the same
population-level statistical power to be useful.

**What-if planning** — `/api/what-if` reuses the same L3 propagation engine as a pure function: pass
a station and a cycle-time delta, get back the forecast with and without it, for a manager
evaluating "what if I move a technician to station X" before committing headcount, not after.

**Retrofit camera sweep** — an honest capex finding that revises the Round 1 pitch: barcode
hand-off timing alone is sufficient for dark-station inference at normal scan quality. Cameras only
earn their keep once barcode scan miss rate exceeds roughly 30%. Recommendation: 2–3 targeted
cameras per line at the stations with genuinely poor scan coverage, not blanket retrofit — cutting
proposed hardware spend by roughly 70% versus the Round 1 concept.

## Design principles carried through from Round 1

- **AI suggests, humans approve.** No write path to any PLC exists in this codebase.
- **Never ask for what you can figure out.** Buffer levels, work-in-progress offsets and even which
  method to trust at a given station are all inferred from data the plant already produces.
- **Recommend but don't automate**, and **be honest about confidence** — every estimate carries a
  method-derived confidence score, and every alert is self-graded against outcomes with a
  self-retuning precision floor.

## Known limitations, stated plainly

- Defect-drift alert precision is low by choice, and the harness cannot measure how low with any
  precision of its own. Only 1 of 11 injected drifts cleared the grader's materiality bar in the
  current 8-shift run against 20 graded alerts, so the measured 5% is set mostly by that denominator;
  the same harness read 24% when 2 of 11 cleared it. Material recall is 100% either way, and that is
  the property this engine trades everything else for. The fallout-fitting pass
  (`fit_calibration.py`'s `alert_model`) does beat the base rate — 77.8% out-of-fold precision
  against 17.7%, Wilson lower bound 56.6% — but only at 7.1% recall. Firing stays on the original
  formula; the learned probability is evidence, not a gate. Raising precision without paying recall
  needs a genuinely better signal than drift shape (which station and parameter, plant history,
  maintenance records), not a better threshold on this one — and measuring the result needs a
  validation harness with more material drifts in it than this one generates.
- **The self-retuning precision floor makes defect-drift precision worse, not better, and we left it
  on.** The loop needs 5 graded alerts of a type before it moves a threshold; defect drift fires ~2.5
  a shift, so with a ledger that reset every shift the mechanism had never actually run. Carrying
  ledger state across shifts turns it on — and the defect-risk firing floor climbs from 55 to its
  ceiling of 70 by shift five while precision does not recover. Raising the bar dropped
  graded-TRUE alerts and no graded-FALSE ones, which is a direct measurement of the same thing this
  section already argues: the risk score does not separate material drift from immaterial drift, so
  no threshold on it can. The loop still earns its place capping a runaway alert type — it leaves
  BOTTLENECK untouched at 35, because 98% precision needs no correction — but it is not the answer
  to L4b, and reporting that is more useful than quietly not running it.
- **A zone-wide cause is attributed to every station in the zone.** See the multi-causal table above:
  one ambient driver produces up to ten DEFECT_RISK alerts naming ten different tools. This is the
  most likely thing in the system to erode floor trust in a real installation, and the fix — a
  zone-level correlation test gating per-tool alerts — is designed but not built.
- Variants change work content but not process parameters. On a real line a different model often
  carries different torque specs and different film-build targets too, which would give L4's drift
  detection a per-variant baseline problem this prototype does not have.
- The 30-minute aggregate throughput forecast does not beat a naive takt-based estimate — buffers
  absorb short-horizon variation either way. The value is in the earlier, station-level leading
  indicators (bottleneck and dark-station alerts), not in out-forecasting total output.
- The simulator is a discrete-event stand-in for a real line, tuned to be physically plausible
  (defect probability rises with distance from baseline, manual stations carry fatter cycle-time
  tails, barcode scanners miss reads more often on hand-held gear) but it is not fitted to any real
  plant's data, consistent with what the brief allows.
