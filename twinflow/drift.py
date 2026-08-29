"""
Layer 4a: drift detection.

Conventional quality alarms fire when a reading leaves the specification
window. By then the bad units already exist. TwinFlow watches the parameter
move inside the window and asks a different question: is the centre of this
process walking, and if it keeps walking at this rate, when does it reach the
edge.

Three estimators run side by side because they fail in different ways.

  EWMA        tracks the current centre. Fast, but a single wild reading
              nudges it.
  CUSUM       accumulates small persistent offsets. Slow to react to noise,
              which is exactly why it survives transient rattles that would
              move an EWMA.
  Hotelling   one number per station across correlated parameters. Catches
              the case where torque and angle each look fine alone but have
              moved together in a way the joint distribution says is rare.

An alert needs EWMA and CUSUM to agree. That single rule is what separates
the real nutrunner drift from the fixture rattle that self corrects.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import math
import numpy as np

STABLE = "STABLE"
WATCH = "WATCH"
DRIFTING = "DRIFTING"
EXCURSION = "EXCURSION"


@dataclass
class ParamState:
    param: str
    baseline_mean: float
    baseline_sigma: float
    lsl: float
    usl: float
    ewma: float = 0.0
    cusum_hi: float = 0.0
    cusum_lo: float = 0.0
    n: int = 0
    recent: List[Tuple[int, float]] = field(default_factory=list)

    ewma_z: float = 0.0
    cusum_z: float = 0.0
    slope_per_hr: float = 0.0
    ttl_spec_s: Optional[float] = None
    state: str = STABLE
    in_spec_now: bool = True
    streak: int = 0
    slope_se_per_hr: float = 0.0
    last_z: float = 0.0        # this single reading's z, before any smoothing

    def as_dict(self) -> dict:
        return {
            "param": self.param, "ewma": round(self.ewma, 4),
            "ewma_z": round(self.ewma_z, 3), "cusum_z": round(self.cusum_z, 3),
            "slope_per_hr": round(self.slope_per_hr, 4),
            "slope_se_per_hr": round(self.slope_se_per_hr, 4),
            "streak": self.streak,
            "ttl_spec_s": None if self.ttl_spec_s is None else round(self.ttl_spec_s),
            "state": self.state, "baseline_mean": round(self.baseline_mean, 3),
            "lsl": self.lsl, "usl": self.usl, "n": self.n,
        }


class StationDriftMonitor:
    LAMBDA = 0.12
    K = 0.5           # CUSUM slack, in sigma
    H = 9.0           # CUSUM decision interval, in sigma
    EWMA_WARN = 2.5   # sigma of the EWMA statistic
    EWMA_ALERT = 4.5  # raised for multiplicity: ~130 series are watched at once
    HOLD = 20         # consecutive units the condition must survive
    WINDOW = 80       # samples used for the slope fit
    BASELINE_N = 40

    def __init__(self, sid: str, param_specs: Dict[str, Dict[str, float]]):
        self.sid = sid
        self.params: Dict[str, ParamState] = {}
        for p, spec in param_specs.items():
            self.params[p] = ParamState(
                param=p, baseline_mean=spec["mean"], baseline_sigma=spec["sigma"],
                lsl=spec["lsl"], usl=spec["usl"], ewma=spec["mean"])
        self._baseline_buf: Dict[str, List[float]] = {p: [] for p in self.params}
        self._cov_buf: List[List[float]] = []
        self._cov_inv: Optional[np.ndarray] = None
        self._cov_mean: Optional[np.ndarray] = None
        self.t2: float = 0.0
        self.t2_p95: float = 0.0
        # This body's own reading, not the smoothed EWMA centre — the
        # instantaneous excursion is what the simulator's defect roll
        # actually keys off, and the L4b model needs that signal per body,
        # separate from the persistence-over-time signal EWMA/CUSUM carry.
        self.last_max_z: float = 0.0
        self.last_max_z_param: Optional[str] = None

    # ------------------------------------------------------------------
    def update(self, t: int, values: Dict[str, float]) -> None:
        keys = list(self.params.keys())
        this_call_z: Dict[str, float] = {}
        for p in keys:
            if p not in values:
                continue
            ps = self.params[p]
            x = float(values[p])
            ps.n += 1

            # learn the real baseline from the first stable stretch of the run
            if ps.n <= self.BASELINE_N:
                self._baseline_buf[p].append(x)
                if ps.n == self.BASELINE_N:
                    arr = np.array(self._baseline_buf[p])
                    ps.baseline_mean = float(arr.mean())
                    ps.baseline_sigma = float(max(arr.std(ddof=1), 1e-6))
                    ps.ewma = ps.baseline_mean

            sig = ps.baseline_sigma
            z = (x - ps.baseline_mean) / sig
            ps.last_z = z
            this_call_z[p] = z

            ps.ewma = (1 - self.LAMBDA) * ps.ewma + self.LAMBDA * x
            # variance of the EWMA statistic in steady state
            lam = self.LAMBDA
            ewma_sigma = sig * math.sqrt(lam / (2 - lam) *
                                         (1 - (1 - lam) ** (2 * max(ps.n, 1))))
            ps.ewma_z = (ps.ewma - ps.baseline_mean) / max(ewma_sigma, 1e-9)

            ps.cusum_hi = max(0.0, ps.cusum_hi + z - self.K)
            ps.cusum_lo = max(0.0, ps.cusum_lo - z - self.K)
            ps.cusum_z = max(ps.cusum_hi, ps.cusum_lo)

            ps.recent.append((t, x))
            if len(ps.recent) > self.WINDOW:
                ps.recent.pop(0)
            if len(ps.recent) >= 12:
                ts = np.array([r[0] for r in ps.recent], dtype=float)
                xs = np.array([r[1] for r in ps.recent], dtype=float)
                tt = ts - ts[0]
                slope, icpt = np.polyfit(tt, xs, 1)
                resid = xs - (slope * tt + icpt)
                denom = float(np.sum((tt - tt.mean()) ** 2)) or 1.0
                se = float(np.sqrt(max(np.sum(resid ** 2), 1e-12) /
                                   max(len(tt) - 2, 1) / denom))
                ps.slope_per_hr = float(slope) * 3600.0
                ps.slope_se_per_hr = se * 3600.0
            else:
                ps.slope_per_hr = 0.0
                ps.slope_se_per_hr = 0.0

            ps.in_spec_now = ps.lsl <= x <= ps.usl
            ps.ttl_spec_s = self._time_to_spec(ps)
            ps.state = self._classify(ps)

        if this_call_z:
            worst_p = max(this_call_z, key=lambda p: abs(this_call_z[p]))
            self.last_max_z_param = worst_p
            self.last_max_z = this_call_z[worst_p]

        # multivariate view once the baseline is learned
        vals = [values.get(p) for p in keys]
        if all(v is not None for v in vals):
            self._cov_buf.append([float(v) for v in vals])
            if len(self._cov_buf) == self.BASELINE_N * 2:
                A = np.array(self._cov_buf)
                self._cov_mean = A.mean(axis=0)
                C = np.cov(A, rowvar=False) + np.eye(A.shape[1]) * 1e-9
                self._cov_inv = np.linalg.pinv(C)
                d = A - self._cov_mean
                t2s = np.einsum("ij,jk,ik->i", d, self._cov_inv, d)
                self.t2_p95 = float(np.percentile(t2s, 95))
            if self._cov_inv is not None:
                d = np.array([float(v) for v in vals]) - self._cov_mean
                self.t2 = float(d @ self._cov_inv @ d)

    # ------------------------------------------------------------------
    def _time_to_spec(self, ps: ParamState) -> Optional[float]:
        if abs(ps.slope_per_hr) < 1e-6:
            return None
        target = ps.usl if ps.slope_per_hr > 0 else ps.lsl
        margin = target - ps.ewma
        if margin * ps.slope_per_hr <= 0:
            return None
        return abs(margin / ps.slope_per_hr) * 3600.0

    def _classify(self, ps: ParamState) -> str:
        """Two estimators must agree, and they must keep agreeing.

        The hold counter is the transient filter. A fixture that rattles for
        four bodies and settles never reaches the count, so it never becomes
        an alert, while a nutrunner that loses calibration keeps the condition
        true for every body after it and does.

        EXCURSION means a single reading went outside the spec window. It is
        a state observation, not an alert trigger — only DRIFTING (which
        requires EWMA + CUSUM agreement held for HOLD consecutive bodies)
        enters drifting_stations() and fires DEFECT_RISK.
        """
        if not ps.in_spec_now:
            ps.streak = self.HOLD
            return EXCURSION
        candidate = (abs(ps.ewma_z) >= self.EWMA_ALERT and ps.cusum_z >= self.H)
        ps.streak = ps.streak + 1 if candidate else 0
        if ps.streak >= self.HOLD:
            return DRIFTING
        if candidate or abs(ps.ewma_z) >= self.EWMA_WARN or ps.cusum_z >= self.H * 0.6:
            return WATCH
        return STABLE

    # ------------------------------------------------------------------
    def worst(self) -> Optional[ParamState]:
        if not self.params:
            return None
        order = {EXCURSION: 3, DRIFTING: 2, WATCH: 1, STABLE: 0}
        return max(self.params.values(),
                   key=lambda p: (order[p.state], abs(p.ewma_z)))

    def snapshot(self) -> dict:
        w = self.worst()
        return {
            "sid": self.sid,
            "t2": round(self.t2, 2),
            "t2_p95": round(self.t2_p95, 2),
            "t2_flag": bool(self.t2_p95 > 0 and self.t2 > self.t2_p95 * 1.8),
            "worst_param": w.param if w else None,
            "state": w.state if w else STABLE,
            "params": {p: ps.as_dict() for p, ps in self.params.items()},
        }


class DriftBank:
    def __init__(self, stations):
        self.monitors: Dict[str, StationDriftMonitor] = {
            s.sid: StationDriftMonitor(s.sid, s.process_params)
            for s in stations if s.process_params
        }

    def observe(self, ev: dict) -> None:
        m = self.monitors.get(ev["sid"])
        if m is not None and ev.get("params"):
            m.update(ev["t"], ev["params"])

    def feature_row(self, ev: dict) -> Optional[dict]:
        """Live drift features for the station in ev, captured the instant
        this body's reading was folded into the monitor.

        Call this immediately after observe(ev) in the run loop. Nothing
        later in time can leak into it, because the monitor for this sid has
        only just been updated with this body's own values and no other
        body's event can move it before the next one arrives.
        """
        m = self.monitors.get(ev["sid"])
        if m is None or not ev.get("params"):
            return None
        w = m.worst()
        if w is None:
            return None
        return {
            "sid": ev["sid"], "param": w.param,
            "ewma_z": w.ewma_z, "cusum_z": w.cusum_z, "streak": w.streak,
            "t2": m.t2, "t2_p95": m.t2_p95,
            "t2_flag": bool(m.t2_p95 > 0 and m.t2 > m.t2_p95 * 1.8),
            # This body's own instantaneous reading, not the smoothed
            # centre — the strongest per-body predictor, since it is what
            # the simulator's own defect roll is keyed off.
            "raw_z": m.last_max_z, "raw_z_param": m.last_max_z_param,
        }

    def snapshot(self) -> Dict[str, dict]:
        return {sid: m.snapshot() for sid, m in self.monitors.items()}

    def drifting_stations(self) -> List[dict]:
        out = []
        for sid, m in self.monitors.items():
            snap = m.snapshot()
            if snap["state"] == DRIFTING:
                out.append(snap)
        return sorted(out, key=lambda s: -abs(
            s["params"][s["worst_param"]]["ewma_z"]))
