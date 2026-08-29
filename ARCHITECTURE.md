# TwinFlow — Architecture

## Design thesis

A dashboard reports the level of a buffer. TwinFlow knows the buffer is a tank with a measured
inflow and outflow, so it can say *when* the tank runs dry and *which* upstream station is
responsible. Everything in this architecture exists to make that one sentence true without ever
asking a plant to change how it already runs.

Five layers, each reading only what the layer below actually produces:

```
 L1  Line topology         the plant as data: stations, tiers, buffers, build mix
 L2  Virtual sensors        raw scans/PLC signals -> work content + confidence
 L3  Propagation            per-station state -> forecast of starvation/blocking, root cause
 L4  Drift + genealogy      per-station process values -> leading defect indicator + containment
 L4b Defect-risk calib      drift features -> P(alert would be graded true), P(this body is origin)
 L5  Decision + trust       evidence -> risk score, tiered action, self-graded alert ledger
```

No layer above L1 is allowed to read simulator ground truth at runtime. The one exception is the
grading pass in L5, which reads the plant's own downtime log and quality dispositions — arriving late,
exactly as it would in a real installation. That boundary is what makes the validation numbers in
`README.md` honest rather than circular. For validation and demo purposes, `score_against_truth()`
exists on the L2 class (called only from the validation harness), and the Manager dashboard receives
fault windows derived from simulator faults — both outside the runtime layer path.

## C4 — System Context

```
                         ┌───────────────────────┐
                         │   Floor Supervisor      │  real-time andon-style view,
                         │   (Person)               │  acknowledges alerts, acts
                         └───────────┬───────────┘
                                     │ alerts, recommended action
                                     ▼
   MES / SCADA  ──┐          ┌─────────────┐          ┌────────────────────┐
   Station PLCs ──┼─────────▶│  TwinFlow    │─────────▶│  Plant Manager      │
   Retrofit cams ─┤          │ (Software     │ trends,  │  (Person)           │
   Quality mgmt ──┘          │  System)      │ ledger   └────────────────────┘
                              └──────┬───────┘
                                     │ business case, ROI
                                     ▼
                         ┌───────────────────────┐
                         │   Leadership             │
                         │   (Person)               │
                         └───────────────────────┘
```

TwinFlow has **no outbound edge to a PLC or line control system.** Every arrow into the plant is
read-only. The only actuation in this diagram is a human being handed a recommendation.

## C4 — Container view, the five layers

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  TwinFlow                                                                     │
│                                                                                 │
│  ┌────────────┐                ┌───────────────┐  cycles, buffers ┌───────────┐│
│  │ L1 Line    │                │ L2 Virtual     │────────────────▶│ L3 Propag.││
│  │ topology   │                │ sensors        │                  │ engine    ││
│  │            │                │                │──confidence─────▶│           ││
│  │ line.py    │                │ virtual_       │                  │ propagate ││
│  └────────────┘                │ sensors.py     │                  └─────┬─────┘│
│                                  └───────┬───────┘                        │     │
│           plant event feed               │ process params          forecast│     │
│          ┌──────────────────┐            ▼                              │     │
│          │  MES / PLC /     │    ┌───────────────┐                      │     │
│          │  scans, motion   │───▶│ L4 Drift +     │◀─────────────────────┘     │
│          │  quality, params │    │ genealogy      │                             │
│          └──────────────────┘    │                │                             │
│                                  │ drift.py       │───────┐                     │
│                                  │ genealogy.py   │        │ evidence          │
│                                  └───────────────┘        ▼                    │
│                                              ┌───────────────────────┐         │
│                                              │ L5 Decision + trust    │         │
│                                              │                        │         │
│                                              │ decision.py, twin.py   │         │
│                                              │  - risk_score()        │         │
│                                              │  - AlertLedger         │         │
│                                              │  - self-grading        │         │
│                                              └───────────┬───────────┘         │
└──────────────────────────────────────────────────────────┼─────────────────────┘
                                                             ▼
                                              alerts, evidence, action, owner
                                              (dashboard: floor / manager / leadership)
```

L4b (`defect_model.py`) is not drawn as a box in its own right because it does not sit on the live
event-feed path — it is a side channel that runs entirely offline (`fit_calibration.py`, disjoint
seeds from every validated run), writes `twinflow/calibration.json`, and is loaded once at `TwinFlow`
construction. Once loaded it adds two things to L5's DEFECT_RISK alerts without changing whether they
fire: a per-body containment ranking (`origin_model`) and an extra "learned confidence" evidence line
(`alert_model`) alongside the original fixed-sigma confidence formula, which is still what decides
whether an alert fires and how it is scored. `alert_model` discriminates well enough to gate on —
cross-validated precision 66.7% against a 19.4% base rate — but only at 18.7% recall, which is the
reason it does not gate. See `### L4b` below. Absent the file, both additions are simply missing; the
firing/scoring path is identical either way.

## Layer by layer

### L1 — Line topology (`line.py`)

The plant expressed as data, not code: 42 `Station` objects across body, paint and final assembly,
each with a sensor `tier` (A full, B cycle-only, C dark/manual), a nominal cycle time, an out-buffer
capacity, and — for instrumented stations — a dict of process parameters with their spec limits.
The topology itself lives in `twinflow/lines/final_assembly_a.json`, not as a literal in this file —
`build_line(spec_path=None)` loads the bundled file by default, or any other path. Adding a new line
or site means writing a new JSON file, not touching any other layer or any other file.

The same file declares the **build mix**: three variants (SEDAN 0.52, SUV 0.34, WAGON 0.14) with a
line-wide cycle multiplier each, overridden per station where the work genuinely differs — seat set,
harness lay-in, headliner, metal finish. This is not decoration. On a mixed model line the work
content at a given station is multi-modal, and the difference between models at a manual station
(up to 12 s at FA02 harness lay-in) is larger than the drift the twin is trying to detect. Two
things follow, and both are enforced throughout the layers above:

- `Station.mix_cycle_s`, not `nominal_cycle_s`, is the standard an observed cycle time is compared
  against. Every cycle the twin sees is an average over whatever mix actually ran; scoring it
  against the base variant's standard books a scheduling decision as a process fault.
- `Station.cycle_for(variant)` is what L2 conditions its per-body estimate on. The variant comes
  off the MES build order, which is known before the body is launched and readable at a dark station
  exactly as easily as at an instrumented one — it costs nothing to acquire, which is what makes it
  the cheapest accuracy available at the stations with no sensors at all.

### L2 — Virtual sensors (`virtual_sensors.py`)

The hardest constraint in the brief: a dark station gives the twin nothing but a barcode scan. Two
things make that enough.

1. **Buffer level is a difference of two counters with a learned offset.** The units waiting
   between station *j-1* and station *j* is `clip(departures(j-1) − departures(j) − offset, 0, cap)`,
   where the offset is learned from the min and max of the raw counter difference seen so far. The
   twin doesn't need to be told the initial work-in-progress: once a buffer empties or fills, the
   offset is pinned and subsequent readings are accurate. Boundary cases: buffer 0 is assumed full
   (infinite supply), and the last station returns 0.
2. **Hand-off decomposition recovers work content per body**, keyed by barcode, not by a bare timer
   gap. A gap between two departures is only a clean measurement of work when the station was
   neither starved waiting for the previous body nor blocked because its own out-buffer was full —
   both of which are detectable from scan counters alone. When the gap is ambiguous, a retrofit
   camera's motion duty cycle (MOG2 in the intended real-world deployment; modelled as a Bernoulli
   stand-in in the simulator) splits it into working time and standing-still time. Of the 8 tier-C
   stations, 5 carry a retrofit webcam (BS12, PT06, PT09, FA02, FA14); the remaining 3 (PT04, FA06,
   FA15) are fully dark. When neither camera nor clean hand-off is available, the twin falls back to
   a bounded estimate and **says so**, via a method-derived confidence score (direct PLC 0.99, clean
   hand-off 0.85, camera-assisted 0.62, bounded fallback 0.35) that downstream layers discount by
   when available.

3. **Work content is estimated per model, not per station.** Each station carries one EWMA per
   variant alongside the pooled one, and a body is scored against its own model's track once four
   bodies of that model have passed (the pooled track until then, so a rare variant never reports a
   number the station has not actually produced). `current_cycles()` still hands L3 the *pooled*
   value: over a forecast horizon long enough to build the mix, the mix average is the correct rate.

Validated result: 4.5 s MAE / ≈6.6% MAPE at completely uninstrumented stations, against ground truth
the twin never sees. Pooling every model into one estimate instead — which is what the twin did
before the build order was part of the feed — gives 5.2 s. The gain tracks how much the mix actually
moves that station's work: +1.2 s at FA02 harness lay-in (11.9 s spread between models), +0.1 s at
PT09 paint inspect (3.1 s spread). `VirtualSensorBank(stations, use_variant=False)` reproduces the
pooled number, which is how `validate.py:variant_conditioning()` measures the difference on the
same shift.

### L3 — Propagation (`propagate.py`)

The line as a chain of tanks. Each station has a capacity rate `1 / cycle_time`; that rate is
clamped by an empty upstream buffer or a full downstream one. Between two buffer-boundary crossings
every rate is constant, so the next crossing time is exact arithmetic rather than a stepped
simulation — the engine advances event to event, not second to second, which is what makes a 30
minute forecast run in milliseconds. Root cause for a predicted starvation or blocking event is an
`argmin` over the relevant upstream or downstream slice of capacity rates — explainable by
construction, not learned. Severity is expressed as **sustained rate loss** (bodies/hour lost for as
long as the condition persists), not a single deficit number, because that is the figure a plant
manager can multiply by a shift length.

### L4 — Drift and genealogy (`drift.py`, `genealogy.py`)

Two estimators must agree before a process is called "drifting": an EWMA tracks the current centre
(fast, but noise-sensitive), a CUSUM accumulates small persistent offsets (slow, but immune to a
single wild reading). Both are also required to *keep* agreeing for 20 consecutive bodies — that
hold counter is the mechanism that separates a fixture rattle that self-corrects from a nutrunner
that has actually lost calibration. A single out-of-spec reading is tracked as EXCURSION but does
not fire an alert; only DRIFTING (which requires the full hold) enters `drifting_stations()` and
triggers DEFECT_RISK. A Hotelling T² statistic runs alongside and contributes a +0.05 confidence
nudge to alerts already raised by univariate drift — it is not an independent detector, because at
its current threshold it would flag roughly 20 stations per shift and destroy precision.

Genealogy answers the two questions that follow a drift: *which station made this* (a two-sample
t-test between the process values recorded on failing bodies' passports versus passing bodies',
station by station, ranked by separation) and *which other bodies are at risk* (every body whose
barcode passport shows it passed the suspect station while the drift was active — a numbered
containment list, not an open ended recall).

### L4b — Defect-risk calibration (`defect_model.py`, trained by `fit_calibration.py`)

Two small logistic models, hand-rolled (numpy IRLS, no scikit-learn) so the fitted coefficients stay
printable and no pickle ships. They answer different questions and are trained on different labels,
because one model trying to do both jobs at once picks up the wrong absolute scale — see
`defect_model.py`'s module docstring for the failed first attempt and why.

- **`alert_model`** — "if a DEFECT_RISK alert fired on this station right now, would L5's own
  after-the-fact grader call it TRUE?" Its training rows are the DEFECT_RISK alerts a shift actually
  fired, at the features they fired on, labelled with the ledger's own verdict — the production
  grading logic itself, not a proxy for it. Over 200 training shifts that is 552 alerts, 19.4% of
  them graded TRUE. It was built to gate whether `_defect_alerts()` fires, replacing the fixed
  EWMA/CUSUM-derived confidence formula that produces the 24% precision reported in `README.md`.

  It does discriminate. The 5-fold out-of-fold curve falls monotonically from 68.0% precision at
  15.9% recall through 44.0% at 30.8% and 33.3% at 46.7% to the 19.4% base rate at full recall, and
  `select_fire_threshold` finds a cutoff whose Wilson lower bound (55.0%) clears
  `AlertLedger.PRECISION_FLOOR[DEFECT_RISK]`. **It clears it at 18.7% recall**, and that is why it
  still does not gate. Raising measured precision from 24% to 67% by missing four material drifts in
  five is a different product from the one the rest of this document describes. `_defect_alerts()`
  fires and gates on the original formula; `alert_model`'s output is attached to every alert as an
  extra evidence line, useful for deciding which of several open drift alerts to walk to first.

  This replaces an earlier and opposite finding — that precision was "flat across the entire recall
  range, within noise of the base rate", and that drift shape therefore carries no materiality
  signal. That result came from a degenerate fit: two of the six shape features were structurally
  constant (`streak_frac` was clipped to 1.0 on rows that by definition had already cleared the hold
  counter; `elapsed_min` was 0.0 because the collector stamped the drift onset itself), and rows were
  sampled once per station per shift at drift onset, so the model was fitted on a containment-count
  range an order of magnitude below the one it is asked to score live. Full account in
  `defect_model.py`'s module docstring.
- **`origin_model`** — "of the bodies a containment window catches, which ones did *this station*
  most likely put a defect into?" Trained on each body's own instantaneous parameter reading against
  the plant's retrospective root-cause attribution (a quality disposition's `origin_station` — the
  offline equivalent of an 8D/RCA report, used only as a training label, never as a live feature).
  This ranks `genealogy.containment()`'s flat list into "start with these bodies first" —
  `Alert.at_risk_ranked`, surfaced as "likely contributors", never "root cause".

Training labels are allowed information a live alert never sees — that is what makes them useful
supervision. The boundary L4b protects is narrower and non-negotiable: the *features* both models
score at inference time (EWMA, CUSUM, streak, this body's own reading) are exactly what `TwinFlow`
already computes from the live event feed, nothing from `sim.truth`. Training happens once, offline,
before the run being judged ever starts.

### L5 — Decision and trust (`decision.py`, `twin.py`)

`risk_score()` combines severity, confidence and urgency into one number; `tier_for()` buckets it
into MONITOR / ADVISE / ACT NOW. A condition that is still true updates the alert already on
screen rather than firing a new one — interrupting a supervisor seven times about one nutrunner is
how a system gets muted within a fortnight. Every alert carries a `falsifier` (a plain sentence
describing what would prove it wrong) and a `verify_by` time; the `AlertLedger` grades every alert
against the plant's own downtime log and quality dispositions once that time passes, and when
measured precision for an alert type falls below its floor, the firing threshold for that type rises
automatically. This is the mechanism, not a claim: the numbers in `README.md` are its output.

**The retune loop only exists across shifts.** `_retune()` needs five graded alerts of a kind before
it will move that kind's threshold, and DEFECT_RISK fires about 2.5 times a shift. A ledger
constructed fresh every shift therefore never reached the bar on the one alert type whose precision
sits furthest below its floor — the trust mechanism was real code that never ran. `AlertLedger` now
takes and exports a small state (`threshold_bump`, per-kind TRUE/FALSE counts, nothing else;
the alert objects stay with the shift that fired them), `TwinFlow(stations, ledger_state=...)`
threads it, and `validate.py`, `server.py` and `twinflow/history.py` carry it shift to shift the way
a real installation would. `precision()` stays this-shift-only, which is what the dashboard shows;
`lifetime_precision()` is the population the loop acts on. It also adjusts only when that population
grows — `resolve()` runs every frame, and bumping on every call saturates a threshold within
minutes of a shift start.

What the loop then does is reported rather than assumed, and the honest answer is that it does not
rescue defect-drift precision. Over eight shifts the defect-risk firing floor climbs from 55 to its
ceiling of 70 by shift five and stays there, and measured precision does not recover — it falls, from
23.8% to 15.8%, because raising the risk-score threshold removed graded-TRUE alerts and no
graded-FALSE ones. That is a direct measurement of something `README.md` argues on other grounds:
the risk score does not discriminate material drift from immaterial drift, so no threshold on it can.
The loop is worth keeping — it is what caps a runaway alert type, and it holds BOTTLENECK at its
floor of 35 with no bumping because 97.6% precision needs none — but it is not the answer to L4b.

## Where the cause is not where the symptom is

Everything above is built around one cause at one station, ramping once, until someone fixes it.
The brief says plainly that real root causes are "multi-causal, intermittent … hard to isolate from
data alone", so the simulator now injects four kinds that break that assumption, and `validate.py`
scores them as a separate slice (`multi_causal_scenario()` / `attribution_scoring()`, disjoint seeds
from the headline runs so those stay comparable). Results over the slice, and what they mean:

| Hard cause | What it is | What the twin does |
|---|---|---|
| **carry-in** | A parameter drifts at station *i*; the defect surfaces at station *j* downstream, where nothing is out of tolerance | Names the true source station, not the symptom station. The upstream drift is a real univariate drift and L4 sees it directly; genealogy's t-test then separates failing from passing bodies on the *source*'s passport values |
| **intermittent** | An equipment fault duty-cycled on and off, distinct from the transient that self-corrects | Detected in every case, but on the bottleneck path with a median lead of ~9 min rather than the ~66 min a monotone fault gives — each "on" phase has to re-establish itself |
| **operator** | A manning change at a manual station at a break boundary, a different pace, no equipment fault at all | Detected, via the dark-station inference path. The twin cannot say *why* it is slower, which is correct: the recommendation is to check manning and material, and a human decides |
| **ambient** | One zone-wide environmental driver — booth temperature, humidity — moving every parameter in the zone at once, each by its own `drift_sensitivity` | **Detected, and attributed wrongly.** The twin blames every instrumented station in the zone: 7.5 stations on average, which is all of them. One cause, up to ten simultaneous DEFECT_RISK alerts naming ten different tools |

The ambient result is the honest failure of this architecture, and it is worth stating in the design
document rather than in a footnote. Every detector from L4 up is univariate and per-station by
construction, which is exactly what makes the root cause explainable when there is one cause; the
same choice makes a shared cause look like a coincidence of ten. The Hotelling T² statistic in
`drift.py` is the right shape of instrument for this and is deliberately not wired as a detector —
at its current threshold it flags roughly 20 stations per shift. The fix is not a better threshold on
T²; it is a zone-level correlation test that asks whether the stations drifting together share an
environment before any of them raises a per-tool alert. That is the next piece of work, and it is
not built.

Note also what the carry-in case demands of the ground truth: `_defect_roll()` returns the origin an
8D report would name, which for a carry-in defect is the upstream station, not the station that
assembled the bad part. That is what the genealogy backtrace is scored against, and it is the same
label `origin_model` trains on.

## The manager's dimension: more than one shift

The engine runs one shift. A plant manager plans across a week, and the questions that view has to
answer — which station has been the constraint, whether alert precision is improving, whether last
Tuesday's fix held — cannot be answered from a single shift no matter how it is rendered. Without
this the manager tier is a slower floor tier.

`twinflow/history.py` runs consecutive shifts with the alert ledger carried forward and reduces each
to the handful of numbers a weekly review uses: which station was the binding constraint and for what
share of the shift, bodies out, fallout, alerts and precision by kind, and the firing floor the
ledger moved. It reads the twin's own output only — no simulator ground truth appears in it.
`build_history.py` writes `out/history.json`; `/api/history` serves it, computing on demand when the
file is absent. Over ten randomised shifts the recurring-constraint table is the output that matters:
a station that binds in one shift is a bad day, and one that binds in four is a capacity decision
with a maintenance window attached.

## Why this generalises beyond one line

The only per-site inputs are the station list, tiers, buffer capacities and build mix in L1's JSON
file. Layers 2 through 5 read a fixed event schema (`{t, sid, uid, variant, zone, tier, scan_ok,
mes_scan, cycle_s, station_time_s, blocked_s, motion_duty, params}`) and never reference a station by
name — every lookup goes through the station's tier and its declared process parameters. `scan_ok` is
load-bearing: it gates whether a departure time is recorded at dark stations. `cycle_s`,
`motion_duty`, and `params` are conditionally `None`/`{}` by tier (cycle data only at tier A/B,
camera data only where installed, params only at tier A). `variant` is present at every tier because
build order is MES data rather than a sensor reading, and is `None` on a line spec that declares no
`variants` block — such a file loads unchanged and every station behaves as a single model line, so
an existing topology needs no migration. A second line, a second plant, or a
re-instrumented station is a data change, not a code change: a new `lines/*.json` file, and — if the
new line's process signals differ enough from the training shifts — a re-run of
`fit_calibration.py` against it.
