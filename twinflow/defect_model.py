"""
Layer 4b: learned defect-risk calibration.

The fixed sigma rule in drift.py answers "has the process centre moved."
It cannot answer "will this move actually raise fallout enough to be worth
a line-side intervention" — that is a different question, and it is exactly
the gap validate.py's grader tests against: DEFECT_RISK alerts fire on
|ewma_z| >= 4.5 and cusum_z >= 9, but are graded true only if post-alert
fallout beats baseline with z >= 1.64 and an absolute rise >= 0.03. A drift
that is statistically real but too small to ever clear that bar still fires,
which is why measured precision (out/validation.json) sits at 24% against
100% recall.

alert_model was built to close that gap by gating firing directly on a
learned P(graded TRUE). It carries real signal — but not enough of it at
the recall this twin is built to hold, so it still does not gate.

A 5-fold cross-validated, Wilson-lower-bound evaluation over 200 training
shifts (552 fired alerts, 19.4% of them graded TRUE) gives this out-of-fold
curve:

    fired   recall   precision   Wilson LB
       25    15.9%       68.0%       55.3%
       75    30.8%       44.0%       36.9%
      150    46.7%       33.3%       28.6%
      300    68.2%       24.3%       21.3%
      552   100.0%       19.4%       17.3%

That is a working ranker, not a coin flip: precision falls monotonically
from 3.5x the base rate down to it. The top decile of drift episodes by
predicted probability really is materially different from the rest, and
`select_fire_threshold` does find a cutoff (0.379) whose lower bound clears
AlertLedger.PRECISION_FLOOR[DEFECT_RISK].

It clears it at 18.7% recall. That is the whole problem. TwinFlow's claim
is that it catches the underlying condition every time and says honestly
how sure it is; trading 100% recall for 19% to move measured precision from
24% to 67% is a different product, and not one a plant asked for. So
`TwinFlow._defect_alerts()` still fires and gates on the original hand-tuned
formula, and alert_model's calibrated probability is surfaced as an extra
evidence line — now a number that actually discriminates, for a human
deciding which of several open drift alerts to walk to first.

Read the history here as a warning about the evaluation, not just the
result. An earlier version of this file reported the opposite finding —
precision "flat at 23-30% across the entire recall range, within noise of
the base rate" — and concluded that drift shape simply does not predict
materiality. That conclusion was an artifact of two bugs, both invisible in
the fitted output unless you looked at the feature matrix:

  * two of the six shape features were structurally constant. streak_frac
    was min(1.0, streak/HOLD) scored only on stations already past HOLD, so
    it was always exactly 1.0 and collinear with the intercept; elapsed_min
    was always exactly 0.0 because the training collector stamped the drift
    onset time itself before the engine could. The fit dutifully returned a
    coefficient identical to the intercept's for the first and exactly zero
    for the second.
  * rows were sampled once per station per shift, at drift onset. The ledger
    grades every alert a station fires, and a long drift fires several as
    each one resolves and the cooldown lapses. Training saw ~1.5 rows per
    shift where serving produces ~2.8, and saw them all at elapsed 0 with a
    single 30 min containment window — so the feature the fit leaned on
    hardest was one whose live range it had never observed.

Both are fixed (see fit_calibration.py). The lesson that survives: a
logistic fit on a degenerate design does not fail loudly. It returns
plausible coefficients and an honest-looking cross-validated curve, and the
only tell is that a column has one distinct value in it.

This module fits two small logistic models offline (fit_calibration.py),
over shifts with faults the twin has never seen and never tuned itself
against. Nothing in twinflow/ trains on live data; the twin only ever loads
coefficients that were fitted before this run started. That is the same
read-only discipline the rest of the engine keeps toward sim.truth, applied
to model fitting instead of alerting.

Two models, not one, because they answer different questions and need
different absolute scales:

  alert_model    "if I fired a DEFECT_RISK alert on this station right now,
                 would twin._grade()'s own after-the-fact test call it
                 TRUE?" Trained directly against _grade()'s own verdict, so
                 its output lands on the right scale by construction. It
                 does discriminate, but only sharply enough to be worth
                 gating on at a recall this twin will not give up (see
                 above). Surfaced as an evidence line for triage ordering,
                 not used to gate firing.

  origin_model   "of the bodies known to be at risk once a station is
                 already confirmed drifting, which ones did this specific
                 station most likely put the defect into?" Trained against
                 the plant's own retrospective root-cause attribution
                 (origin_station on a FAIL disposition — see
                 fit_calibration.py for why that is a legitimate offline
                 training label). This is what ranks a containment list.

An earlier version of this file tried to make one model do both jobs by
predicting P(this body eventually fails) from a body's own drift features,
then comparing a window average of that against a fixed baseline. It
predicted the right relative ordering but the wrong absolute scale: origin
probabilities cap out around a few percent even for a genuine drift, while
the grader's bar is a rise of three points on a baseline fail rate near
15-20%. Splitting the two questions apart removes the scale mismatch
instead of fudging around it.

Hand rolled rather than scikit-learn, to match the rest of the engine (numpy
only, everywhere), to keep the fitted coefficients printable for the
explainability story the README already makes, and to avoid shipping a
pickle for something this small.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional
import json
import math
import os
import numpy as np

# Must match StationDriftMonitor.HOLD in drift.py — the consecutive-body
# count a drift condition needs to survive before it counts as DRIFTING.
# Duplicated here rather than imported to keep this module free of any
# dependency on the live monitor; feature_row() / drifting_stations() are
# the only contracts between them, and both sides document it.
DRIFT_HOLD = 20

# origin_model features — one row per (body, station) a body passed.
#
# There is no "dark" indicator here. An earlier version carried one, fed by a
# features(None) branch for bodies that passed a station with no process
# sensors — but TwinFlow.unit_features only ever records param-carrying
# stations, so that column was constant 0 in training, its coefficient fitted
# to exactly 0.0, and features(None) scored sigmoid(bias) ~= 0.05% from a
# region the model had never seen. body_risk() returns None for such a body
# now, and callers say "no process data here" instead of showing a number.
ORIGIN_FEATURE_NAMES = ["bias", "raw_z_abs", "raw_z_signed", "abs_ewma_z",
                         "ewma_z", "cusum_z", "streak_frac", "t2_ratio"]

# alert_model features — one row per DEFECT_RISK alert actually fired, taken
# at the instant it fired.
#
# Three of these are log1p rather than raw or clipped, for reasons that cost a
# whole fitted model to learn:
#
#   log1p_streak      was min(1.0, streak / DRIFT_HOLD). drifting_stations()
#                     only returns stations whose worst param already has
#                     streak >= HOLD, so the clip made this the constant 1.0 —
#                     perfectly collinear with bias, and the fit split the
#                     weight between them to identical coefficients. Real
#                     episodes hold for 139, 281, 283 consecutive bodies; that
#                     spread is signal the clip was throwing away.
#   log1p_cusum_z     raw cusum_z reached ~51 in the old training rows and
#                     1084 in a live shift. A linear term on a value that
#                     leaves its fitted range by 20x is extrapolation, not
#                     inference.
#   log1p_elapsed_min was elapsed_min, and was the constant 0.0 in training —
#                     the old collector stamped _drift_since itself before the
#                     engine could, so every row was recorded at elapsed == 0.
#                     Rows now come from real firings, including a station's
#                     second and third, where hours have passed.
ALERT_FEATURE_NAMES = ["bias", "ewma_z_abs", "ewma_z", "log1p_cusum_z",
                        "log1p_streak", "t2_ratio", "log1p_n_affected",
                        "log1p_elapsed_min"]


# ----------------------------------------------------------------------
class LogisticModel:
    """Plain penalised logistic regression, fit by Newton-Raphson (IRLS).

    Ridge penalty keeps this stable even though defect rows are rare-event
    and can be near separable for a station with only a handful of fails.
    """

    def __init__(self, coef: Optional[np.ndarray] = None, l2: float = 1.0):
        self.coef = coef
        self.l2 = l2

    def fit(self, X: np.ndarray, y: np.ndarray, iters: int = 50,
            tol: float = 1e-8) -> "LogisticModel":
        n, d = X.shape
        beta = np.zeros(d)
        for _ in range(iters):
            z = X @ beta
            p = 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))
            p = np.clip(p, 1e-9, 1 - 1e-9)
            w = p * (1 - p)
            grad = X.T @ (y - p) - self.l2 * beta
            hess = X.T @ (X * w[:, None]) + self.l2 * np.eye(d)
            try:
                delta = np.linalg.solve(hess, grad)
            except np.linalg.LinAlgError:
                delta = np.linalg.lstsq(hess, grad, rcond=None)[0]
            beta = beta + delta
            if np.max(np.abs(delta)) < tol:
                break
        self.coef = beta
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        z = X @ self.coef
        return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))

    def to_dict(self) -> dict:
        return {"coef": [float(c) for c in self.coef], "l2": self.l2}

    @classmethod
    def from_dict(cls, d: dict) -> "LogisticModel":
        return cls(coef=np.array(d["coef"], dtype=float), l2=d.get("l2", 1.0))


# ----------------------------------------------------------------------
@dataclass
class DefectRiskModel:
    origin_model: LogisticModel
    alert_model: LogisticModel
    n_origin_rows: int = 0
    n_alert_rows: int = 0
    n_train_shifts: int = 0
    # NOT used to gate firing — see twin.py:_defect_alerts(), which always
    # fires on the hand-tuned formula's confidence, exactly as before L4b
    # existed. This is fit_calibration.py's best cross-validated cutoff for
    # alert_model against AlertLedger.PRECISION_FLOOR[DEFECT_RISK], and at
    # 200 shifts it does clear that floor: out-of-fold precision 66.7%,
    # Wilson lower bound 55.0%, against a 19.4% base rate.
    #
    # It clears it at 18.7% recall. Gating here would raise measured
    # DEFECT_RISK precision from ~24% to ~67% and drop recall from 100% to
    # under a fifth — trading away the property the rest of the engine is
    # built around to improve the number the README already explains. The
    # cutoff is kept live and honest so the trade stays visible and
    # re-measurable, not because anything applies it.
    alert_fire_threshold: float = 0.5

    # ------------------------------------------------------------------
    @staticmethod
    def features(row: dict) -> np.ndarray:
        """row is a drift.DriftBank.feature_row() dict, for one body at one
        param-carrying station. There is no None branch: a station with no
        process sensors produces no row, and the model has nothing to say
        about it — see body_risk().

        raw_z is this body's own instantaneous reading (before any
        smoothing) and is the strongest single predictor of origin, because
        it is what the simulator's own defect probability is keyed off.
        ewma_z / cusum_z / streak carry the complementary persistence
        signal.
        """
        t2_ratio = 0.0
        if row.get("t2_p95", 0):
            t2_ratio = min(5.0, row["t2"] / max(row["t2_p95"], 1e-9))
        raw_z = row.get("raw_z", 0.0)
        return np.array([
            1.0,
            abs(raw_z),
            raw_z,
            abs(row["ewma_z"]),
            row["ewma_z"],
            row["cusum_z"],
            min(1.0, row["streak"] / DRIFT_HOLD),
            t2_ratio,
        ])

    def body_risk(self, row: Optional[dict]) -> Optional[float]:
        """P(this station is the origin of a defect on this body) — a
        containment-ranking score, not a calibrated absolute fail rate.

        None when the body has no drift feature row at this station, i.e.
        the station carries no process sensors. That is genuinely "no
        opinion", not "low risk", and callers must render it as such rather
        than sorting a fabricated number into the ranking.
        """
        if row is None:
            return None
        return float(self.origin_model.predict_proba(self.features(row)[None, :])[0])

    # ------------------------------------------------------------------
    @staticmethod
    def station_features(snap: dict, elapsed_s: float, n_affected: int) -> np.ndarray:
        """snap is one entry from drift.DriftBank.drifting_stations() —
        the station-level drift snapshot, not a per-body reading. elapsed_s
        is time since this station entered DRIFTING; n_affected is the
        containment count so far.

        See ALERT_FEATURE_NAMES for why streak, cusum_z and elapsed are
        log1p'd rather than raw or clipped.
        """
        p = snap["params"][snap["worst_param"]]
        t2_ratio = 0.0
        if snap.get("t2_p95", 0):
            t2_ratio = min(5.0, snap["t2"] / max(snap["t2_p95"], 1e-9))
        return np.array([
            1.0,
            abs(p["ewma_z"]),
            p["ewma_z"],
            math.log1p(max(0.0, p["cusum_z"])),
            math.log1p(max(0, p["streak"])),
            t2_ratio,
            math.log1p(max(0, n_affected)),
            math.log1p(max(0.0, elapsed_s) / 60.0),
        ])

    def alert_confidence(self, snap: dict, elapsed_s: float, n_affected: int) -> float:
        """P(a DEFECT_RISK alert fired on this station right now would be
        graded TRUE) — fitted directly against twin.TwinFlow._grade()'s own
        verdict, so this lands on the right scale by construction. Surfaced
        as an evidence line in twin.py, not used to gate firing — see this
        module's docstring for why (it does not discriminate true from
        false beyond the base rate at current training volume).
        """
        feats = self.station_features(snap, elapsed_s, n_affected)
        return float(self.alert_model.predict_proba(feats[None, :])[0])

    # ------------------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "origin_feature_names": ORIGIN_FEATURE_NAMES,
            "alert_feature_names": ALERT_FEATURE_NAMES,
            "origin_model": self.origin_model.to_dict(),
            "alert_model": self.alert_model.to_dict(),
            "n_origin_rows": self.n_origin_rows,
            "n_alert_rows": self.n_alert_rows,
            "n_train_shifts": self.n_train_shifts,
            "alert_fire_threshold": self.alert_fire_threshold,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "DefectRiskModel":
        return cls(origin_model=LogisticModel.from_dict(d["origin_model"]),
                    alert_model=LogisticModel.from_dict(d["alert_model"]),
                    n_origin_rows=d.get("n_origin_rows", 0),
                    n_alert_rows=d.get("n_alert_rows", 0),
                    n_train_shifts=d.get("n_train_shifts", 0),
                    alert_fire_threshold=d.get("alert_fire_threshold", 0.5))

    def save(self, path: str) -> None:
        """Write via a temp file and rename, so the file a running server is
        loading is either the old fit or the new one, never half of either.
        os.replace is atomic within a filesystem.
        """
        tmp = f"{path}.tmp"
        with open(tmp, "w") as f:
            json.dump(self.to_dict(), f, indent=2)
            f.write("\n")
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: str) -> Optional["DefectRiskModel"]:
        """Returns None if no usable calibration file exists — callers must
        fall back to the hand-tuned confidence formula in that case, so a
        clean clone with no fit_calibration.py run still works end to end.

        "Usable" includes a feature-schema check. The names are written into
        the file by to_dict() precisely so a coefficient vector fitted
        against an older feature layout cannot be silently dotted with a
        differently-ordered one — that failure is invisible at runtime
        (the arithmetic still works, it is just meaningless) and would be
        found only by noticing that a probability looked wrong.
        """
        try:
            with open(path) as f:
                d = json.load(f)
        except FileNotFoundError:
            return None
        except (json.JSONDecodeError, OSError) as e:
            print(f"[L4b] ignoring {path}: {e}")
            return None
        if (d.get("origin_feature_names") != ORIGIN_FEATURE_NAMES or
                d.get("alert_feature_names") != ALERT_FEATURE_NAMES):
            print(f"[L4b] ignoring {path}: fitted against a different feature "
                  f"schema. Re-run fit_calibration.py.")
            return None
        return cls.from_dict(d)
