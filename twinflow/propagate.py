"""
Layer 3: propagation.

This is the part a dashboard cannot do. A dashboard reports the level of a
buffer. The twin knows the buffer is a tank with a measured inflow and a
measured outflow, so it can say when the tank runs dry and which station
upstream is responsible.

The line is treated as a chain of tanks. Each station has a capacity rate
1 / cycle_time. A station's effective rate is clamped by its upstream supply
when the feeding buffer is empty and by its downstream space when the buffer
it fills is full. Between two buffer boundary crossings every rate is
constant, so buffer levels move linearly and the next crossing time is exact
arithmetic rather than a stepped simulation. The forecast advances crossing
by crossing until the horizon is reached.

Root cause for a predicted starvation or blocking event is an argmin over the
relevant upstream or downstream slice of raw capacity rates — the slowest
station in the chain is the binding constraint. Explainable by construction,
not learned.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional
import math

STARVE = "STARVE"
BLOCK = "BLOCK"
EPS = 1e-9


@dataclass
class ForecastEvent:
    at_s: float                # seconds from now
    sid: str
    kind: str
    cause_sid: str
    cause_cycle_s: float
    confidence: float


@dataclass
class Forecast:
    horizon_s: int
    events: List[ForecastEvent] = field(default_factory=list)
    constraint_sid: str = ""
    constraint_cycle_s: float = 0.0
    takt_s: float = 0.0
    units_out_forecast: float = 0.0
    units_out_nominal: float = 0.0
    deficit_units: float = 0.0
    nominal_takt_s: float = 0.0
    rate_loss_per_hr: float = 0.0
    runway_s: float = 0.0
    runway_sid: str = ""
    confidence: float = 1.0
    buffer_trajectory: List[dict] = field(default_factory=list)

    def first_for(self, sid: str) -> Optional[ForecastEvent]:
        for e in self.events:
            if e.sid == sid:
                return e
        return None


class PropagationEngine:
    def __init__(self, stations, nominal_cycles: Optional[Dict[str, float]] = None):
        self.stations = stations
        self.sids = [s.sid for s in stations]
        self.caps = [s.out_buffer_cap for s in stations]
        self.n = len(stations)
        # Mix-weighted, not the base variant's cycle time. Observed cycles
        # arriving from L2 are an average over whatever mix actually ran, so
        # comparing them against a single-model standard would book a
        # scheduling effect — an SUV-heavy hour — as sustained rate loss.
        self.nominal = nominal_cycles or {s.sid: s.mix_cycle_s for s in stations}

    # ------------------------------------------------------------------
    def _effective_rates(self, cap_rate: List[float], buf: List[float]) -> List[float]:
        """Clamp capacity rates by empty upstream buffers and full downstream ones."""
        r = list(cap_rate)
        for _ in range(3):
            for i in range(1, self.n):                 # starvation travels down
                if buf[i - 1] <= EPS:
                    r[i] = min(r[i], r[i - 1])
            for i in range(self.n - 2, -1, -1):        # blocking travels up
                if buf[i] >= self.caps[i] - EPS:
                    r[i] = min(r[i], r[i + 1])
        return r

    def _root_cause(self, i: int, kind: str, cap_rate: List[float]) -> int:
        """The binding constraint for a predicted event.

        A station runs dry because the slowest station upstream cannot keep
        up with it. A station backs up because the slowest station downstream
        cannot take work away fast enough. Both are one argmin over a slice.
        """
        if kind == STARVE:
            rng = range(0, i)
        else:
            rng = range(i + 1, self.n)
        rng = list(rng) or [i]
        j = min(rng, key=lambda k: cap_rate[k])
        return j if cap_rate[j] < cap_rate[i] else i

    # ------------------------------------------------------------------
    def forecast(self, cycles: Dict[str, float], buffers: Dict[str, float],
                 horizon_s: int = 1800,
                 confidences: Optional[Dict[str, float]] = None,
                 trajectory_step_s: int = 60,
                 availability: float = 1.0) -> Forecast:
        """Propagate cycle times and buffer levels forward over the horizon.

        `availability` scales every station's capable rate to account for the
        output a line loses to causes this model does not represent — micro
        stoppages, tool changes, the operator stepping away. Left at 1.0 the
        forecast is a capacity ceiling and reads systematically optimistic;
        callers with an end of line counter to compare against can pass the
        observed shortfall instead. It never changes *which* station is the
        constraint, only how much the line produces.
        """
        avail = min(1.0, max(0.05, float(availability)))
        conf = confidences or {sid: 1.0 for sid in self.sids}
        cap_rate = [avail / max(1.0, cycles.get(sid, self.nominal[sid]))
                    for sid in self.sids]
        buf = [float(min(self.caps[i], max(0.0, buffers.get(self.sids[i], 0))))
               for i in range(self.n)]

        fc = Forecast(horizon_s=horizon_s)
        bi = int(min(range(self.n), key=lambda i: cap_rate[i]))
        fc.constraint_sid = self.sids[bi]
        # Reported cycle times stay the observed ones. `avail` is a whole-line
        # scalar, so it moves every rate together and cannot change which
        # station is slowest — dividing it back out here keeps the number a
        # supervisor reads equal to the number the station is running at.
        fc.constraint_cycle_s = round(avail / cap_rate[bi], 2)
        fc.takt_s = fc.constraint_cycle_s

        seen_events = set()
        t = 0.0
        out_units = 0.0
        traj_next = 0
        guard = 0

        while t < horizon_s and guard < 4000:
            guard += 1
            r = self._effective_rates(cap_rate, buf)

            while traj_next <= t and traj_next <= horizon_s:
                fc.buffer_trajectory.append(
                    {"t": traj_next, "buffers": [round(b, 2) for b in buf]})
                traj_next += trajectory_step_s

            # time until the next buffer boundary crossing
            dt_best = horizon_s - t
            hit: Optional[tuple] = None
            for i in range(self.n - 1):
                drain = r[i + 1] - r[i]
                if drain > EPS and buf[i] > EPS:
                    dt = buf[i] / drain
                    if dt < dt_best - EPS:
                        dt_best, hit = dt, (i, STARVE)
                fill = r[i] - r[i + 1]
                space = self.caps[i] - buf[i]
                if fill > EPS and space > EPS:
                    dt = space / fill
                    if dt < dt_best - EPS:
                        dt_best, hit = dt, (i, BLOCK)

            dt_best = max(dt_best, 0.5)
            for i in range(self.n - 1):
                buf[i] = min(self.caps[i], max(0.0, buf[i] + (r[i] - r[i + 1]) * dt_best))
            out_units += r[self.n - 1] * dt_best
            t += dt_best

            if hit is not None and t <= horizon_s:
                i, kind = hit
                sid = self.sids[i + 1] if kind == STARVE else self.sids[i]
                key = (sid, kind)
                if key not in seen_events:
                    seen_events.add(key)
                    si = i + 1 if kind == STARVE else i
                    cause_i = self._root_cause(si, kind, cap_rate)
                    csid = self.sids[cause_i]
                    fc.events.append(ForecastEvent(
                        at_s=round(t, 1), sid=sid, kind=kind, cause_sid=csid,
                        cause_cycle_s=round(avail / cap_rate[cause_i], 1),
                        confidence=round(min(conf.get(csid, 1.0),
                                             conf.get(sid, 1.0)), 3)))

        fc.events.sort(key=lambda e: e.at_s)
        fc.units_out_forecast = round(out_units, 2)
        nominal_rate = min(1.0 / self.nominal[s] for s in self.sids)
        fc.units_out_nominal = round(nominal_rate * horizon_s, 2)
        fc.deficit_units = round(fc.units_out_nominal - fc.units_out_forecast, 2)
        # Sustained rate loss is the honest severity number. A constraint
        # slower than takt costs this many bodies every hour it is left alone,
        # whether or not the end of line counter has noticed yet.
        fc.nominal_takt_s = round(max(self.nominal.values()), 2)
        if fc.constraint_cycle_s > fc.nominal_takt_s:
            fc.rate_loss_per_hr = round(
                3600.0 * (1.0 / fc.nominal_takt_s - 1.0 / fc.constraint_cycle_s), 2)
        else:
            fc.rate_loss_per_hr = 0.0

        # Runway is how long the buffers hide the problem for. It is the time
        # until starvation reaches the furthest downstream station, which is
        # the moment the loss becomes visible on the end of line counter.
        starves = [e for e in fc.events if e.kind == STARVE]
        if starves:
            deepest = max(starves, key=lambda e: self.sids.index(e.sid))
            fc.runway_s = deepest.at_s
            fc.runway_sid = deepest.sid
        else:
            fc.runway_s = float(horizon_s)
            fc.runway_sid = ""

        chain = [e.confidence for e in fc.events] or [1.0]
        fc.confidence = round(min(chain), 3)
        return fc


def describe(fc: Forecast, station_names: Dict[str, str], now_s: int = 0) -> List[str]:
    """Plain sentences a supervisor can read without a manual."""
    out = []
    for e in fc.events[:6]:
        mins = e.at_s / 60.0
        verb = "runs dry" if e.kind == STARVE else "backs up"
        out.append(
            f"{e.sid} {station_names.get(e.sid,'')} {verb} in {mins:.0f} min "
            f"because {e.cause_sid} is running at {e.cause_cycle_s:.0f} s "
            f"(confidence {e.confidence:.0%})")
    return out
