"""
Offline fit for twinflow/defect_model.py's L4b defect-risk calibration.

Fits two models — see defect_model.py's module docstring for why there are
two, not one, for the cross-validated precision/recall curve, and for the
earlier version of that curve that was wrong because of how this file used
to collect its rows. TwinFlow._defect_alerts() fires and gates on its
original fixed-sigma confidence formula regardless of whether
twinflow/calibration.json exists, which is why out/validation.json shows
DEFECT_RISK precision at 24% against 100% recall: statistically real drifts
too small to ever matter still fire. alert_model does discriminate well
enough to clear the precision floor, but only at ~19% recall, so it stays
an evidence line rather than a gate; its calibrated probability is attached
to every alert when the calibration file is present.

alert_model's rows are the alerts the ledger actually fired, at the features
they fired on, labelled with the ledger's own verdict — collect_alert_rows()
explains at length why they are not reconstructed from drift state instead,
and what that reconstruction got wrong. If you change how DEFECT_RISK alerts
fire, this file needs nothing: it reads whatever the engine did.

Seeds here are disjoint from every other seeded run in this repo, so nothing
this model is later judged against was seen while fitting it:
  run_demo.py    demo seed        7
  validate.py    scenario rng     1000 + k,  sim seed 2000 + k
  fit_calibration.py (here)       scenario rng 5000 + k, sim seed 6000 + k

alert_model is trained directly against twin.TwinFlow._grade()'s own
verdict: for every instant a station is in DRIFTING state during a training
shift, record its live drift snapshot, then after the shift ends — with the
whole shift's quality dispositions available, exactly as _grade() always
has them at its own verify_by time — construct a stand-in Alert at that
instant and ask _grade() itself whether it would have called it TRUE. That
reuses the exact production grading logic as the training label, so nothing
about the pass/fail bar can drift out of sync between training and serving.

origin_model's label is the (body, station) pair a quality disposition's
origin_station names, not every station-visit of a body that eventually
failed. A body typically passes ~25 param-carrying stations, so labelling
all of them for a failing body would make ~24 of every 25 "positive" rows
noise from stations that had nothing to do with the defect — an earlier
version of this file did exactly that, and the fitted coefficient on the
strongest real signal (a body's own instantaneous reading) came out
*negative*. origin_station is the plant's own retrospective root-cause
attribution — the equivalent of an 8D or RCA report tracing a defect back
to the process step that produced it using timestamped process logs, which
real plants do after the fact. Using it here is an offline-training-only
choice: it only ever touches this file, never twinflow/ itself, and the
features both live models are scored on stay exactly what the twin can
compute in real time. That is the same boundary the rest of the engine
draws around sim.truth, applied to where a label may come from rather than
to what a feature may see.
"""

import argparse
import math

import numpy as np

from twinflow.line import build_line
from twinflow.simulator import LineSimulator
from twinflow.twin import TwinFlow
from twinflow.defect_model import DefectRiskModel, LogisticModel
from twinflow.defect_model import ORIGIN_FEATURE_NAMES, ALERT_FEATURE_NAMES
from twinflow import decision as D
from validate import random_scenario, HORIZON

SEED_OFFSET = 5000       # scenario rng base, disjoint from validate.py's 1000+k
SIM_SEED_OFFSET = 6000   # sim seed base, disjoint from validate.py's 2000+k


def _run_training_shift(k: int):
    """One shift, run exactly as run_demo.py runs it — no shadowing, no
    instrumentation. Everything alert_model needs is already on the alerts
    the ledger fired: _defect_alerts() stamps each new alert with the L4b
    feature inputs it was scored on (`_l4b`), and the ledger's own grading
    pass stamps the verdict (`outcome`).
    """
    rng = np.random.default_rng(SEED_OFFSET + k)
    stations = build_line()
    faults = random_scenario(rng, stations)
    sim = LineSimulator(stations=stations, faults=faults,
                        horizon_s=HORIZON, seed=SIM_SEED_OFFSET + k).run()
    tw = TwinFlow(stations)
    tw.run(sim, frame_every_s=120)
    return tw, sim


def collect_origin_rows(tw: TwinFlow, sim) -> tuple:
    origins = {(q["uid"], q["origin_station"]) for q in sim.quality
               if q["result"] == "FAIL" and q["origin_station"]}
    X, y = [], []
    for uid, by_sid in tw.unit_features.items():
        for sid, row in by_sid.items():
            X.append(DefectRiskModel.features(row))
            y.append(1.0 if (uid, sid) in origins else 0.0)
    return X, y


def collect_alert_rows(tw: TwinFlow) -> tuple:
    """One row per DEFECT_RISK alert the shift actually fired, at the
    features it fired on, labelled with the ledger's own verdict.

    An earlier version of this reconstructed the rows instead: it shadowed
    _defect_alerts(), recorded the first tick each station spent DRIFTING,
    and built a stub Alert to re-ask _grade(). Three things were wrong with
    it, all of which this version avoids by construction rather than by
    being more careful.

      * It assumed one alert per (kind, sid) per shift. The ledger updates
        an open alert, but once that alert resolves at verify_by and
        COOLDOWN_S has passed, the same drifting station fires again — a
        single long drift on FA04 produces three separately graded alerts.
        Training saw the first and missed the rest, ~1.5 rows per shift
        against a serving population several times larger.
      * Recording at the onset tick meant every row had elapsed_s == 0 (the
        recorder called _drift_since.setdefault itself, before the engine
        could) and a containment count from a single 30 min window. The
        fitted model therefore never saw the ranges it is asked to score in
        production: n_affected 16-27 in training against 143-287 live.
      * Re-grading a stub is a second implementation of a decision the
        ledger has already made. `a.outcome` is that decision.

    PENDING means the shift ended before the alert's verification window
    closed — "too few bodies built after the alert to judge", by its own
    name in twin._grade(). Those rows have no label and are skipped.
    """
    X, y, skipped = [], [], 0
    for a in tw.ledger.alerts:
        if a.kind != D.DEFECT_RISK:
            continue
        l4b = getattr(a, "_l4b", None)
        if l4b is None:
            continue
        if a.outcome not in ("TRUE", "FALSE"):
            skipped += 1
            continue
        X.append(DefectRiskModel.station_features(
            l4b["snap"], l4b["elapsed_s"], l4b["n_affected"]))
        y.append(1.0 if a.outcome == "TRUE" else 0.0)
    return X, y, skipped


def wilson_lower_bound(k: float, n: float, z: float = 1.28) -> float:
    """One-sided ~90% lower confidence bound on a binomial proportion
    (Wilson score interval). At n=9, k=6 (66.7% raw) this returns roughly
    0.40, not 0.667 — the gap is the point of using it: a handful of lucky
    coin flips should not be trusted at face value.
    """
    if n <= 0:
        return 0.0
    phat = k / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = phat + z2 / (2 * n)
    margin = z * math.sqrt(max(0.0, phat * (1 - phat) + z2 / (4 * n)) / n)
    return max(0.0, (center - margin) / denom)


def cross_val_predict_proba(X: np.ndarray, y: np.ndarray, l2: float,
                            n_folds: int = 5, seed: int = 0) -> np.ndarray:
    """Out-of-fold predicted probabilities: each row is scored by a model
    that never saw its label during fitting. A threshold picked against
    plain in-sample predict_proba() (the model's own fit target) is
    doubly optimistic — the model already minimised loss on these exact
    rows, and then a threshold search on top of that picks whichever cutoff
    got lucky. Out-of-fold predictions remove the first source of
    optimism; wilson_lower_bound() above guards the second.
    """
    n = len(y)
    rng = np.random.default_rng(seed)
    idx = rng.permutation(n)
    folds = np.array_split(idx, min(n_folds, n))
    oof = np.zeros(n)
    for i in range(len(folds)):
        test_idx = folds[i]
        train_idx = np.concatenate([folds[j] for j in range(len(folds)) if j != i])
        m = LogisticModel(l2=l2).fit(X[train_idx], y[train_idx])
        oof[test_idx] = m.predict_proba(X[test_idx])
    return oof


def select_fire_threshold(p: np.ndarray, y: np.ndarray, precision_floor: float,
                          min_fired: int = 8):
    """Pick the probability cutoff alert_model must clear before an alert is
    built at all, directly off the training set's own precision/recall
    trade-off — not decision.py's fixed risk>=55 floor, which was tuned
    against the old hand-formula's inflated 0.45-0.97 confidence range and
    would silence a properly calibrated model almost entirely (see
    defect_model.py's DefectRiskModel.alert_fire_threshold docstring).

    p must be out-of-fold predictions (cross_val_predict_proba), not the
    model's own in-sample predict_proba — an earlier version of this
    function used in-sample predictions and picked a threshold that scored
    66.7% precision on the 9 rows it was chosen from, then 0% on an
    independent 40-shift validation run: searching hundreds of cutoffs
    against the same rows the model was fit to is a multiple-comparisons
    problem, and at this sample size (hundreds of rows, dozens of
    positives) it is a severe one.

    Among every cutoff whose *Wilson lower bound* clears precision_floor,
    picks the one admitting the most rows (best recall). The lower bound,
    not the point estimate, is what is compared to the floor — that is
    what keeps a lucky small-n cutoff from being selected in the first
    place, rather than relying on catching it after the fact.
    """
    order = np.argsort(-p)
    p_sorted, y_sorted = p[order], y[order]
    n_pos = float(y.sum())
    best = None            # (threshold, precision, recall, n_fired, lb)
    fallback = None        # highest lower-bound cutoff seen, any n >= min_fired
    tp = 0.0
    for i in range(len(p_sorted)):
        tp += y_sorted[i]
        n = i + 1
        if n < min_fired:
            continue
        precision = tp / n
        lb = wilson_lower_bound(tp, n)
        recall = tp / n_pos if n_pos else 0.0
        thr = float(p_sorted[i])
        if fallback is None or lb > fallback[4]:
            fallback = (thr, precision, recall, n, lb)
        if lb >= precision_floor and (best is None or recall > best[2]):
            best = (thr, precision, recall, n, lb)
    chosen = best if best is not None else fallback
    if chosen is None:
        return 0.5, None, None, 0, 0.0, False
    thr, precision, recall, n, lb = chosen
    return thr, precision, recall, n, lb, best is not None


def collect_rows(seeds: int, verbose: bool = True):
    origin_X, origin_y = [], []
    alert_X, alert_y = [], []
    for k in range(seeds):
        tw, sim = _run_training_shift(k)

        ox, oy = collect_origin_rows(tw, sim)
        origin_X += ox; origin_y += oy

        ax, ay, skipped = collect_alert_rows(tw)
        alert_X += ax; alert_y += ay

        if verbose:
            n_origin_pos = int(sum(oy))
            n_alert_pos = int(sum(ay))
            print(f"  shift {k+1}/{seeds}: {len(oy)} origin rows "
                  f"({n_origin_pos} positive), {len(ay)} fired-alert rows "
                  f"({n_alert_pos} graded TRUE, {skipped} skipped as "
                  f"still PENDING at end of shift)")
    return (np.array(origin_X), np.array(origin_y),
            np.array(alert_X), np.array(alert_y))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shifts", type=int, default=12,
                    help="training shifts, seeds 5000..5000+shifts-1 (default 12)")
    ap.add_argument("--l2", type=float, default=2.0, help="ridge penalty")
    ap.add_argument("--out", default="twinflow/calibration.json")
    ap.add_argument("--save-rows", default=None,
                    help="optional .npz path to dump the collected training "
                         "rows (origin_X/y, alert_X/y) — lets a later run "
                         "retune alert_fire_threshold without resimulating "
                         "every shift, since that is the expensive part")
    args = ap.parse_args()

    print(f"Fitting L4b defect-risk calibration over {args.shifts} shifts "
          f"(scenario seeds {SEED_OFFSET}-{SEED_OFFSET + args.shifts - 1}, "
          f"never used by validate.py or run_demo.py)\n")
    origin_X, origin_y, alert_X, alert_y = collect_rows(args.shifts)
    print(f"\norigin_model: {len(origin_y)} rows, {int(origin_y.sum())} "
          f"positive ({origin_y.mean():.2%})")
    print(f"alert_model:  {len(alert_y)} rows, {int(alert_y.sum())} "
          f"graded TRUE ({alert_y.mean():.1%})" if len(alert_y) else
          "alert_model:  0 rows — no station ever reached DRIFTING in these "
          "shifts, try more shifts")

    if args.save_rows:
        np.savez(args.save_rows, origin_X=origin_X, origin_y=origin_y,
                 alert_X=alert_X, alert_y=alert_y)
        print(f"\nraw training rows saved to {args.save_rows}")

    origin_model = LogisticModel(l2=args.l2).fit(origin_X, origin_y)
    alert_model = LogisticModel(l2=args.l2).fit(alert_X, alert_y)

    floor = D.AlertLedger.PRECISION_FLOOR[D.DEFECT_RISK]
    oof_p = cross_val_predict_proba(alert_X, alert_y, args.l2)
    thr, thr_p, thr_r, thr_n, thr_lb, cleared_floor = select_fire_threshold(
        oof_p, alert_y, floor)

    dr = DefectRiskModel(origin_model=origin_model, alert_model=alert_model,
                        n_origin_rows=len(origin_y), n_alert_rows=len(alert_y),
                        n_train_shifts=args.shifts, alert_fire_threshold=thr)
    dr.save(args.out)

    print(f"\norigin_model coefficients:")
    for name, c in zip(ORIGIN_FEATURE_NAMES, origin_model.coef):
        print(f"  {name:14s} {c:+.4f}")
    print(f"\nalert_model coefficients:")
    for name, c in zip(ALERT_FEATURE_NAMES, alert_model.coef):
        print(f"  {name:14s} {c:+.4f}")
    if thr_p is not None:
        print(f"\nalert_fire_threshold: {thr:.3f} -> 5-fold out-of-fold "
              f"precision {thr_p:.1%} (Wilson lower bound {thr_lb:.1%}), "
              f"recall {thr_r:.1%} ({thr_n} of {len(alert_y)} rows fire)")
        print(f"  base rate {alert_y.mean():.1%}; the floor is compared "
              f"against the lower bound, not the point estimate — "
              f"{'cleared' if cleared_floor else f'no cutoff cleared {floor:.0%}, this is the best available'}")
    else:
        print(f"\nalert_fire_threshold: {thr:.3f} (default — too few "
              f"alert-instant rows to select one, try more shifts)")
    print(f"\nwritten to {args.out}")


if __name__ == "__main__":
    main()
