"""
Layer 2: virtual sensors.

A dark station gives us nothing but a barcode scan when a body leaves it.
That is still enough, because two scans at neighbouring stations reconstruct
the buffer between them exactly:

    level(j-1, t) = departures from station j-1 by t
                  - departures from station j by t
                  - (1 if station j is currently holding a unit)

Once buffer level is known, the inter departure gap at a dark station can be
decomposed. The gap is only a clean measurement of work content when the
station was neither starved nor blocked during it. When it was, a retrofit
webcam running MOG2 background subtraction supplies a motion duty cycle, and
work content is recovered as gap x duty. When neither is available the twin
returns a bounded estimate and, more importantly, a low confidence, so that
downstream decisions can discount it rather than silently trust it.

No PLC is touched. No line control logic is modified. Everything here reads
data the plant already produces.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional
import numpy as np

from .line import Station, TIER_A, TIER_B, TIER_C

CLEAN = "clean_gap"
MOTION = "motion_duty"
BOUNDED = "bounded_estimate"
DIRECT = "direct_plc"


@dataclass
class VirtualReading:
    t: int
    sid: str
    uid: int
    cycle_hat_s: float
    confidence: float
    method: str
    state: str
    buf_up: int
    buf_down: int


@dataclass
class _Track:
    last_dep: Optional[int] = None
    ewma: Optional[float] = None
    n: int = 0


class VirtualSensorBank:
    """Streaming estimator, one track per station."""

    CONF = {DIRECT: 0.99, CLEAN: 0.85, MOTION: 0.62, BOUNDED: 0.35}
    LAMBDA = 0.25

    def __init__(self, stations: List[Station]):
        self.stations = stations
        self.idx = {s.sid: i for i, s in enumerate(stations)}
        self.caps = [s.out_buffer_cap for s in stations]
        self.n_st = len(stations)
        self.dep_count = [0 for _ in stations]
        # The twin starts mid shift and does not know how much work in
        # progress is already sitting in each buffer. It does not need to be
        # told. A buffer count is bounded below by zero and above by its
        # capacity, so watching the raw scan difference for a few minutes
        # identifies the unknown offset on its own.
        self.raw_min = [0 for _ in stations]
        self.raw_max = [0 for _ in stations]
        self.tracks: Dict[str, _Track] = {s.sid: _Track() for s in stations}
        self.dep_time: Dict[tuple, int] = {}
        self.full_since: List[Optional[int]] = [None for _ in stations]
        self.full_seen: List[bool] = [False for _ in stations]
        self.readings: List[VirtualReading] = []

    # ---- observable buffer reconstruction, MES scans only -------------
    def _raw(self, k: int) -> int:
        """Scan counter difference across buffer k, before offset removal."""
        if k >= self.n_st - 1:
            return 0
        return self.dep_count[k] - self.dep_count[k + 1]

    def out_level(self, k: int) -> int:
        """Units waiting in the buffer that station k fills."""
        if k >= self.n_st - 1:
            return 0
        raw = self._raw(k)
        offset = max(self.raw_min[k], self.raw_max[k] - self.caps[k])
        return int(np.clip(raw - offset, 0, self.caps[k]))

    def buffer_level(self, j: int) -> int:
        """Units waiting in the buffer feeding station j."""
        if j == 0:
            return self.caps[0]
        return self.out_level(j - 1)

    def _state(self, buf_up: int, buf_down: int, j: int) -> str:
        if buf_up <= 0:
            return "STARVED"
        if buf_down >= self.caps[j]:
            return "BLOCKED"
        return "WORK"

    # ------------------------------------------------------------------
    def observe(self, ev: dict) -> VirtualReading:
        sid = ev["sid"]
        j = self.idx[sid]
        st = self.stations[j]
        tr = self.tracks[sid]

        buf_up = self.buffer_level(j)
        buf_down = self.out_level(j)
        state = self._state(buf_up, buf_down, j)

        # Hand off decomposition. The barcode on the body is scanned at every
        # station, so the twin knows exactly when this unit left the previous
        # station. Work on this unit could not have begun before both
        #   (a) the unit arrived, and
        #   (b) the station released the unit before it.
        arrived = (self.dep_time.get((self.stations[j - 1].sid, ev["uid"]))
                   if (j > 0 and ev.get("scan_ok", True)) else None)
        released = tr.last_dep
        if arrived is None and released is None:
            start = None
        else:
            start = max([x for x in (arrived, released) if x is not None])

        # Two things make a timing measurement unusable as a work content
        # estimate, and both are detectable from scan counters alone.
        #
        #   no arrival scan   the body cannot be tied back to its hand off, so
        #                     the start of work is unknown
        #   buffer was full   the station finished and then sat stuck. Timing
        #                     alone cannot say how much of the elapsed time was
        #                     work and how much was waiting, because a slow
        #                     station and a blocked station produce the same
        #                     inter departure gap
        #
        # The second case is the entire justification for a retrofit camera.
        # Motion duty cycle from MOG2 background subtraction splits the gap
        # into working and standing still. Without it the twin must fall back
        # to a bounded estimate and say so.
        blocked_in_window = self.full_seen[j]
        ambiguous = (arrived is None and j > 0) or blocked_in_window

        if st.tier in (TIER_A, TIER_B) and ev.get("cycle_s") is not None:
            cycle_hat, method = float(ev["cycle_s"]), DIRECT
        elif start is None:
            cycle_hat, method = float(st.nominal_cycle_s), BOUNDED
        elif not ambiguous:
            cycle_hat = float(max(1.0, ev["t"] - start))
            method = CLEAN
        elif ev.get("motion_duty") is not None:
            span = max(1.0, (ev["t"] - (start if start else ev["t"] - st.nominal_cycle_s)))
            cycle_hat, method = span * float(ev["motion_duty"]), MOTION
        else:
            # never let a blocked station masquerade as a slow one
            prior = tr.ewma if tr.ewma is not None else st.nominal_cycle_s
            span = max(1.0, ev["t"] - start)
            cycle_hat, method = float(min(span, prior * 1.05)), BOUNDED

        conf = self.CONF[method]
        if tr.ewma is None:
            tr.ewma = cycle_hat
        else:
            lam = self.LAMBDA * conf
            tr.ewma = (1 - lam) * tr.ewma + lam * cycle_hat
        tr.n += 1
        tr.last_dep = ev["t"]
        self.full_seen[j] = False
        self._refresh_full(j, ev["t"])
        if ev.get("scan_ok", True):
            self.dep_time[(sid, ev["uid"])] = ev["t"]
        self.dep_count[j] += 1

        r = VirtualReading(t=ev["t"], sid=sid, uid=ev["uid"],
                           cycle_hat_s=round(float(tr.ewma), 2),
                           confidence=conf, method=method, state=state,
                           buf_up=buf_up, buf_down=buf_down)
        self.readings.append(r)
        return r

    # ------------------------------------------------------------------
    def _refresh_full(self, j: int, t: int) -> None:
        """Track when each out buffer is at capacity, from scan counters only."""
        for k in (j - 1, j):
            if k < 0 or k >= self.n_st - 1:
                continue
            raw = self._raw(k)
            self.raw_min[k] = min(self.raw_min[k], raw)
            self.raw_max[k] = max(self.raw_max[k], raw)
            lvl = self.out_level(k)
            if lvl >= self.caps[k]:
                if self.full_since[k] is None:
                    self.full_since[k] = t
                self.full_seen[k] = True
            else:
                self.full_since[k] = None

    def current_cycles(self) -> Dict[str, float]:
        return {sid: (tr.ewma if tr.ewma is not None
                      else self.stations[self.idx[sid]].nominal_cycle_s)
                for sid, tr in self.tracks.items()}

    def current_buffers(self) -> Dict[str, int]:
        """Out buffer level for every station, keyed by the station that fills it."""
        return {s.sid: self.out_level(i) for i, s in enumerate(self.stations)}

    def score_against_truth(self, truth: List[dict]) -> Dict[str, dict]:
        """Validation only. How close is an inferred cycle time to reality."""
        by_sid: Dict[str, List[tuple]] = {}
        tmap = {(x["sid"], x["uid"]): x["true_cycle_s"] for x in truth}
        for r in self.readings:
            key = (r.sid, r.uid)
            if key in tmap:
                by_sid.setdefault(r.sid, []).append(
                    (r.cycle_hat_s, tmap[key], r.method, r.confidence))
        out = {}
        for sid, rows in by_sid.items():
            rows = rows[5:]
            if not rows:
                continue
            hat = np.array([r[0] for r in rows])
            tru = np.array([r[1] for r in rows])
            out[sid] = {
                "n": len(rows),
                "mae_s": float(np.mean(np.abs(hat - tru))),
                "mape_pct": float(np.mean(np.abs(hat - tru) / np.maximum(tru, 1)) * 100),
                "bias_s": float(np.mean(hat - tru)),
                "methods": {m: sum(1 for r in rows if r[2] == m)
                            for m in {r[2] for r in rows}},
            }
        return out
