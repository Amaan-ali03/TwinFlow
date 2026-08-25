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
| `dashboard/twinflow_dashboard.html` *(also at top level as the shared deliverable)* | Self contained interactive prototype — open it in any browser, no server needed |
| `twinflow/` | The five layer engine — line model, simulator, virtual sensors, propagation, drift, genealogy, decision |
| `run_demo.py` | Runs one full 8 hour shift and exports the JSON the dashboard reads |
| `validate.py` | Multi seed validation harness — the numbers below come from this, not from the demo shift |
| `out/validation.json` | Raw output of the last validation run |
| `ARCHITECTURE.md` | Five layer design, data contracts, and why each layer exists |

## Running it yourself

```bash
pip install numpy pandas scikit-learn scipy networkx
python3 run_demo.py --out out/twin_run.json      # ~2s, one 8 hour shift
python3 validate.py --shifts 8                    # ~5 min, independently seeded shifts
```

The dashboard is already built with a run baked in — open `twinflow_dashboard.html` directly.
To rebuild it after changing the engine, run `run_demo.py` then re-embed the JSON (see the
assembly step noted at the top of `dashboard/twinflow_dashboard.html`).

## The line

42 stations, 30–50 as specified in the brief, across body construction (14), paint (10) and final
assembly (18). Sensor coverage is deliberately uneven, matching the brief's "majority instrumented,
meaningful minority manual":

| Tier | Count | What the twin sees |
|---|---|---|
| A — full sensors | 25 | PLC cycle handshake + torque, vibration, temperature, or similar process signals |
| B — cycle only | 9 | PLC handshake, no process sensor |
| C — dark / manual | 8 | Barcode scan only. 3 of these carry a retrofit webcam |

## What's validated, and how

All numbers below are from `validate.py` run over independently seeded shifts with **randomised**
fault stations, timings and magnitudes the twin has never been tuned against — this is a
counterfactual backtest, not a fit to the demo scenario. Every alert is graded after the fact
against the plant's own downtime log and quality dispositions, which arrive late, exactly as they
would in a real installation.

**Virtual sensors** — inferred work content at completely uninstrumented stations:
- 4.6 s mean absolute error, ≈7% MAPE, near zero bias
- Buffer level, reconstructed from barcode scan counters alone: 0.63 units MAE
- The twin identifies the unknown work-in-progress offset in each buffer on its own — no manual
  calibration needed to start mid shift

**Alert quality**, 6 shifts, random faults:
| Alert type | Fired/shift | Precision | Median lead time |
|---|---|---|---|
| Bottleneck propagation | ~5 | 97% | 68 min before the end-of-line counter would show it |
| Dark station inference | ~1 | 100% | — |
| Defect drift | ~2.5 | 27%* | 79 min before spec-limit breach |

\* *Flagged honestly, not hidden.* Defect drift alerts correctly catch the underlying condition
100% of the time (recall) but some fire before enough bodies have passed the station to prove
fallout is materially worse than baseline within the grading window. The physical detection is
right; the confidence calibration on *when* to say so needs one more pass — fitting drift magnitude
to observed fallout rate on historical shifts, instead of a fixed sigma threshold. That is the next
piece of work, not a number we've smoothed over.

**Against a conventional specification-limit alarm** (the industry default): median lead time gain
was 182 minutes, and in half of tested cases the spec alarm never fired at all before the shift
ended, because the drift never left the specification window even though it was already producing
measurable fallout downstream.

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

- Defect-drift alert calibration needs the fallout-fitting pass described above before it should be
  treated as production ready.
- The 30-minute aggregate throughput forecast does not beat a naive takt-based estimate — buffers
  absorb short-horizon variation either way. The value is in the earlier, station-level leading
  indicators (bottleneck and dark-station alerts), not in out-forecasting total output.
- The simulator is a discrete-event stand-in for a real line, tuned to be physically plausible
  (defect probability rises with distance from baseline, manual stations carry fatter cycle-time
  tails, barcode scanners miss reads more often on hand-held gear) but it is not fitted to any real
  plant's data, consistent with what the brief allows.
