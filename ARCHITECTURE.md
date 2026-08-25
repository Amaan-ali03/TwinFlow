# TwinFlow — Architecture

## Design thesis

A dashboard reports the level of a buffer. TwinFlow knows the buffer is a tank with a measured
inflow and outflow, so it can say *when* the tank runs dry and *which* upstream station is
responsible. Everything in this architecture exists to make that one sentence true without ever
asking a plant to change how it already runs.

Five layers, each reading only what the layer below actually produces:

```
 L1  Line topology         the plant as data: stations, tiers, buffers
 L2  Virtual sensors        raw scans/PLC signals -> work content + confidence
 L3  Propagation            per-station state -> forecast of starvation/blocking, root cause
 L4  Drift + genealogy      per-station process values -> leading defect indicator + containment
 L5  Decision + trust       evidence -> risk score, tiered action, self-graded alert ledger
```

No layer above L1 is allowed to read simulator ground truth. The one exception is the grading pass
in L5, which reads the plant's own downtime log and quality dispositions — arriving late, exactly as
it would in a real installation. That boundary is what makes the validation numbers in `README.md`
honest rather than circular.

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
│  ┌────────────┐   events   ┌───────────────┐  cycles, buffers ┌─────────────┐│
│  │ L1 Line    │───────────▶│ L2 Virtual     │─────────────────▶│ L3 Propagate││
│  │ topology   │            │ sensors        │                   │ engine      ││
│  │            │            │                │◀──confidence──────│             ││
│  │ line.py    │            │ virtual_       │                   │ propagate.py││
│  └────────────┘            │ sensors.py     │                   └──────┬──────┘│
│                              └───────┬───────┘                          │       │
│                                      │ process params                   │forecast│
│                                      ▼                                  │        │
│                              ┌───────────────┐   suspects, containment  │        │
│                              │ L4 Drift +     │◀─────────────────────────┘        │
│                              │ genealogy      │                                   │
│                              │                │                                   │
│                              │ drift.py       │───────┐                           │
│                              │ genealogy.py   │        │ evidence                  │
│                              └───────────────┘        ▼                           │
│                                              ┌───────────────────────┐            │
│                                              │ L5 Decision + trust    │            │
│                                              │                        │            │
│                                              │ decision.py, twin.py   │            │
│                                              │  - risk_score()        │            │
│                                              │  - AlertLedger         │            │
│                                              │  - self-grading        │            │
│                                              └───────────┬───────────┘            │
└──────────────────────────────────────────────────────────┼───────────────────────┘
                                                             ▼
                                              alerts, evidence, action, owner
                                              (dashboard: floor / manager / leadership)
```

## Layer by layer

### L1 — Line topology (`line.py`)

The plant expressed as data, not code: 42 `Station` objects across body, paint and final assembly,
each with a sensor `tier` (A full, B cycle-only, C dark/manual), a nominal cycle time, an out-buffer
capacity, and — for instrumented stations — a dict of process parameters with their spec limits.
Adding a new line or site means writing a new station list, not touching any other layer.

### L2 — Virtual sensors (`virtual_sensors.py`)

The hardest constraint in the brief: a dark station gives the twin nothing but a barcode scan. Two
things make that enough.

1. **Buffer level is a difference of two counters.** The units waiting between station *j-1* and
   station *j* is exactly `departures(j-1) − departures(j) − (1 if j is holding a unit)`. No
   estimation needed — it's arithmetic on data that already exists. The twin doesn't even need to
   be told the initial work-in-progress: because a buffer level is bounded between 0 and its
   capacity, watching the raw counter difference for a few minutes identifies the unknown starting
   offset on its own.
2. **Hand-off decomposition recovers work content per body**, keyed by barcode, not by a bare timer
   gap. A gap between two departures is only a clean measurement of work when the station was
   neither starved waiting for the previous body nor blocked because its own out-buffer was full —
   both of which are detectable from scan counters alone. When the gap is ambiguous, a retrofit
   camera's MOG2 motion duty cycle splits it into working time and standing-still time. When neither
   is available, the twin falls back to a bounded estimate and **says so**, via a method-derived
   confidence score (direct PLC 0.99, clean hand-off 0.85, camera-assisted 0.62, bounded fallback
   0.35) that every downstream layer is required to discount by.

Validated result: 4.6 s MAE / ≈7% MAPE at completely uninstrumented stations, against ground truth
the twin never sees.

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
hold counter is the entire mechanism that separates a fixture rattle that self-corrects from a
nutrunner that has actually lost calibration, and it is the reason the transient scenario built into
the demo shift never raises an alert. A Hotelling T² statistic runs alongside for the case where two
correlated parameters (torque and angle, say) have each individually stayed inside a normal range
but moved together in a way the joint distribution says is rare.

Genealogy answers the two questions that follow a drift: *which station made this* (a two-sample
t-test between the process values recorded on failing bodies' passports versus passing bodies',
station by station, ranked by separation) and *which other bodies are at risk* (every body whose
barcode passport shows it passed the suspect station while the drift was active — a numbered
containment list, not an open ended recall).

### L5 — Decision and trust (`decision.py`, `twin.py`)

`risk_score()` combines severity, confidence and urgency into one number; `tier_for()` buckets it
into MONITOR / ADVISE / ACT NOW. A condition that is still true updates the alert already on
screen rather than firing a new one — interrupting a supervisor seven times about one nutrunner is
how a system gets muted within a fortnight. Every alert carries a `falsifier` (a plain sentence
describing what would prove it wrong) and a `verify_by` time; the `AlertLedger` grades every alert
against the plant's own downtime log and quality dispositions once that time passes, and when
measured precision for an alert type falls below its floor, the firing threshold for that type rises
automatically. This is the mechanism, not a claim: the numbers in `README.md` are its output.

## Why this generalises beyond one line

The only per-site inputs are the station list, tiers, and buffer capacities in L1. Layers 2 through
5 read a fixed event schema (`{t, sid, uid, cycle_s, mes_scan, motion_duty, params}`) and never
reference a station by name — every lookup goes through the station's tier and its declared process
parameters. A second line, a second plant, or a re-instrumented station is a data change, not a code
change.
