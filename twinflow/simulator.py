"""
Discrete event simulator for a mixed model vehicle assembly line.

This stands in for the plant. It emits exactly the feeds a real twin would
receive and nothing more:

  * MES hand off scans      every station, every unit  (barcode read)
  * PLC cycle handshakes    Tier A and Tier B stations only
  * Process signals         Tier A stations only
  * Retrofit camera motion  the small number of Tier C stations with a webcam
  * Quality dispositions    inspection stations only, with realistic lag

Ground truth (true cycle time at dark stations, true latent defect, true
fault injection schedule) is recorded separately and is never handed to the
twin. It exists only so the validation harness can score the twin honestly.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import math
import numpy as np

from .line import Station, build_line, TIER_A, TIER_B, TIER_C

WORK = "WORK"
STARVED = "STARVED"
BLOCKED = "BLOCKED"

DEFECT_BY_ZONE = {
    "BODY": "weld_integrity",
    "PAINT": "paint_finish",
    "FINAL": "torque_joint",
}

# probability that an inspection station catches a defect of a given type
DETECTION = {
    ("BS13", "weld_integrity"): 0.45,
    ("PT09", "paint_finish"): 0.70,
    ("PT09", "weld_integrity"): 0.05,
    ("FA16", "torque_joint"): 0.15,
    ("FA17", "torque_joint"): 0.90,
    ("FA17", "weld_integrity"): 0.50,
    ("FA17", "paint_finish"): 0.20,
    ("FA18", "torque_joint"): 0.40,
    ("FA18", "weld_integrity"): 0.30,
    ("FA18", "paint_finish"): 0.45,
}


@dataclass
class Fault:
    kind: str                 # "cycle" or "param"
    station: str
    start_s: int
    ramp_s: int               # seconds to reach full magnitude
    end_s: int                # when the fault is repaired
    magnitude: float          # cycle: multiplier delta. param: shift in units
    param: Optional[str] = None
    label: str = ""

    def intensity(self, t: int) -> float:
        if t < self.start_s or t >= self.end_s:
            return 0.0
        if t >= self.start_s + self.ramp_s:
            return 1.0
        return (t - self.start_s) / max(1.0, self.ramp_s)


@dataclass
class Unit:
    uid: int
    launched_s: int
    passport: Dict[str, dict] = field(default_factory=dict)
    latent: List[Tuple[str, str]] = field(default_factory=list)  # (type, origin)
    caught_at: Optional[str] = None
    caught_type: Optional[str] = None
    escaped: bool = False


@dataclass
class _StState:
    unit: Optional[Unit] = None
    remaining: float = 0.0
    started_s: int = 0
    motion_s: int = 0
    work_s: float = 0.0
    last_dep_t: int = 0
    starved_s: int = 0
    blocked_s: int = 0
    status: str = STARVED


def default_scenario() -> List[Fault]:
    """The four situations the prototype is built to demonstrate."""
    return [
        Fault(kind="cycle", station="BS07", start_s=3600, ramp_s=1200,
              end_s=14400, magnitude=0.95,
              label="Respot weld cell electrode wear, cycle time creep"),
        Fault(kind="param", station="FA04", param="bolt_torque_nm",
              start_s=1800, ramp_s=12600, end_s=28800, magnitude=-2.4,
              label="Cockpit nutrunner calibration drift, inside spec"),
        Fault(kind="cycle", station="PT06", start_s=13500, ramp_s=1500,
              end_s=19800, magnitude=0.45,
              label="Primer sand deck understaffed, no sensors present"),
        Fault(kind="param", station="BS11", param="vibration_mm_s",
              start_s=7200, ramp_s=60, end_s=7500, magnitude=0.9,
              label="Transient fixture rattle that self corrects"),
    ]


class LineSimulator:
    def __init__(self, stations: Optional[List[Station]] = None,
                 faults: Optional[List[Fault]] = None,
                 horizon_s: int = 28800, seed: int = 7,
                 warmup_units: int = 40,
                 scan_miss_dark: float = 0.055,
                 scan_miss_auto: float = 0.012):
        self.stations = stations or build_line()
        self.faults = faults if faults is not None else default_scenario()
        self.horizon_s = horizon_s
        self.rng = np.random.default_rng(seed)
        self.n = len(self.stations)
        self.state = [_StState() for _ in self.stations]
        self.buffers: List[List[Unit]] = [[] for _ in self.stations]
        self.warmup_units = warmup_units
        self.scan_miss_dark = scan_miss_dark
        self.scan_miss_auto = scan_miss_auto

        self.events: List[dict] = []        # station completion events (the feed)
        self.quality: List[dict] = []       # inspection dispositions
        self.snapshots: List[dict] = []     # line state, one every snap_every s
        self.truth: List[dict] = []         # ground truth, validation only
        self._uid = 0
        self._live: List[Unit] = []
        self.completed: List = []

    # ------------------------------------------------------------------
    def _fault_cycle_mult(self, sid: str, t: int) -> float:
        m = 1.0
        for f in self.faults:
            if f.kind == "cycle" and f.station == sid:
                m += f.magnitude * f.intensity(t)
        return m

    def _fault_param_shift(self, sid: str, param: str, t: int) -> float:
        d = 0.0
        for f in self.faults:
            if f.kind == "param" and f.station == sid and f.param == param:
                d += f.magnitude * f.intensity(t)
        return d

    def _sample_cycle(self, st: Station, t: int) -> float:
        base = st.nominal_cycle_s * self._fault_cycle_mult(st.sid, t)
        # manual stations have fatter tails, operators are not robots
        if st.tier == TIER_C:
            v = self.rng.normal(base, st.cycle_sigma_s)
            if self.rng.random() < 0.06:
                v += abs(self.rng.normal(0, 9.0))
        else:
            v = self.rng.normal(base, st.cycle_sigma_s)
        return float(max(6.0, v))

    def _sample_params(self, st: Station, t: int) -> Dict[str, float]:
        out = {}
        for p, spec in st.process_params.items():
            shift = self._fault_param_shift(st.sid, p, t)
            out[p] = float(self.rng.normal(spec["mean"] + shift, spec["sigma"]))
        return out

    def _defect_roll(self, st: Station, params: Dict[str, float]) -> Optional[str]:
        base = 0.0011
        z_max = 0.0
        for p, v in params.items():
            spec = st.process_params[p]
            z = abs(v - spec["mean"]) / spec["sigma"] * spec["drift_sensitivity"]
            z_max = max(z_max, z)
        p_def = min(0.55, base * math.exp(0.85 * max(0.0, z_max - 1.0)))
        if st.tier == TIER_C:
            p_def = max(p_def, 0.0022)          # manual work, no process trace
        if self.rng.random() < p_def:
            return DEFECT_BY_ZONE[st.zone]
        return None

    # ------------------------------------------------------------------
    def _new_unit(self, t: int) -> Unit:
        self._uid += 1
        u = Unit(uid=self._uid, launched_s=t)
        self._live.append(u)
        return u

    def _complete(self, i: int, t: int) -> None:
        st = self.stations[i]
        s = self.state[i]
        u = s.unit
        dur = t - s.started_s
        params = self._sample_params(st, t)
        dtype = self._defect_roll(st, params) if st.process_params or st.tier == TIER_C else None
        if dtype:
            u.latent.append((dtype, st.sid))

        u.passport[st.sid] = {
            "t": t, "cycle_s": dur, "params": params,
            "starved_s": s.starved_s, "blocked_s": s.blocked_s,
        }

        # barcode readers miss reads. Dark stations rely on hand scanners and
        # miss more often than fixed gantry readers on the automated zones.
        miss_p = self.scan_miss_dark if st.tier == TIER_C else self.scan_miss_auto
        scan_ok = bool(self.rng.random() > miss_p)

        ev = {
            "t": t, "sid": st.sid, "uid": u.uid, "zone": st.zone,
            "tier": st.tier,
            "scan_ok": scan_ok,
            "mes_scan": t if scan_ok else None,
            "cycle_s": round(s.work_s, 2) if st.tier in (TIER_A, TIER_B) else None,
            "station_time_s": round(dur, 2),
            "blocked_s": s.blocked_s if st.tier in (TIER_A, TIER_B) else None,
            # A retrofit camera watches the station continuously, so the duty
            # cycle covers the whole window since the previous body left, not
            # just the time this body was on the fixture. That is what makes
            # gap x duty recover work content instead of a mixture of work,
            # waiting for parts and waiting for space.
            "motion_duty": (round(min(1.0, s.motion_s /
                                      max(1.0, t - s.last_dep_t)), 3)
                            if st.has_camera else None),
            "params": params if st.tier == TIER_A else {},
        }
        self.events.append(ev)
        self.truth.append({
            "t": t, "sid": st.sid, "uid": u.uid,
            "true_cycle_s": round(s.work_s, 2),
            "true_station_time_s": round(dur, 2),
            "true_blocked_s": s.blocked_s,
            "true_starved_s": s.starved_s,
            "defect_created": dtype,
            "cycle_mult": round(self._fault_cycle_mult(st.sid, t), 4),
        })

        # inspection disposition
        if st.is_inspection and u.latent:
            for (dt_, origin) in list(u.latent):
                p = DETECTION.get((st.sid, dt_), 0.0)
                if self.rng.random() < p:
                    u.latent.remove((dt_, origin))
                    u.caught_at, u.caught_type = st.sid, dt_
                    self.quality.append({
                        "t": t, "uid": u.uid, "inspection": st.sid,
                        "defect_type": dt_, "origin_station": origin,
                        "result": "FAIL",
                    })
                    break
            else:
                self.quality.append({"t": t, "uid": u.uid, "inspection": st.sid,
                                     "defect_type": None, "origin_station": None,
                                     "result": "PASS"})
        elif st.is_inspection:
            self.quality.append({"t": t, "uid": u.uid, "inspection": st.sid,
                                 "defect_type": None, "origin_station": None,
                                 "result": "PASS"})

        s.starved_s = 0
        s.blocked_s = 0
        s.motion_s = 0
        s.work_s = 0.0
        s.last_dep_t = t

    # ------------------------------------------------------------------
    def run(self, snap_every: int = 30, progress: bool = False) -> "LineSimulator":
        n = self.n
        caps = [s.out_buffer_cap for s in self.stations]

        # warm start so the demo does not open on an empty line
        for i in range(n):
            fill = min(caps[i], max(0, self.warmup_units // (i + 2)))
            for _ in range(fill):
                self.buffers[i].append(self._new_unit(0))

        for t in range(self.horizon_s):
            # push phase, downstream first so space frees up before upstream tries
            for i in range(n - 1, -1, -1):
                s = self.state[i]
                if s.unit is None:
                    continue
                if s.remaining > 0:
                    s.remaining -= 1
                    s.work_s += 1
                    s.status = WORK
                    s.motion_s += 1 if self.rng.random() < 0.94 else 0
                    continue
                if len(self.buffers[i]) < caps[i]:
                    self._complete(i, t)
                    self.buffers[i].append(s.unit)
                    s.unit = None
                    s.status = STARVED
                else:
                    s.status = BLOCKED
                    s.blocked_s += 1

            # roll out sink: finished bodies leave the line
            while self.buffers[n - 1]:
                self.completed.append((t, self.buffers[n - 1].pop(0)))

            # pull phase, upstream first
            for i in range(n):
                s = self.state[i]
                if s.unit is not None:
                    continue
                if i == 0:
                    u = self._new_unit(t)
                else:
                    if not self.buffers[i - 1]:
                        s.status = STARVED
                        s.starved_s += 1
                        continue
                    u = self.buffers[i - 1].pop(0)
                s.unit = u
                s.remaining = self._sample_cycle(self.stations[i], t)
                s.started_s = t
                s.status = WORK

            if t % snap_every == 0:
                self.snapshots.append(self._snapshot(t))

            if progress and t % 3600 == 0:
                print(f"  sim t={t//3600}h units_out={len(self.buffers[n-1])}")

        # anything still carrying a latent defect at roll out escaped
        for u in self._live:
            if u.latent:
                u.escaped = True
        return self

    def _snapshot(self, t: int) -> dict:
        return {
            "t": t,
            "buffers": [len(b) for b in self.buffers],
            "status": [s.status for s in self.state],
            "occupancy": [1 if s.unit is not None else 0 for s in self.state],
        }

    # ------------------------------------------------------------------
    def units(self) -> Dict[int, Unit]:
        return {u.uid: u for u in self._live}

    def throughput_series(self, bucket_s: int = 300) -> List[Tuple[int, int]]:
        counts: Dict[int, int] = {}
        for (t, _u) in self.completed:
            b = (t // bucket_s) * bucket_s
            counts[b] = counts.get(b, 0) + 1
        return sorted(counts.items())
