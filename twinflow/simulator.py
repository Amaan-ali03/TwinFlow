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

from .line import Station, build_line, variant_mix, TIER_A, TIER_B, TIER_C

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
    """One injected cause.

    The first two kinds are single-station and monotone, which is the easy
    case and the one the prototype was originally built against. The brief
    asks for harder ones — causes that are shared across stations, that come
    from the operator rather than the equipment, that arrive on the part
    instead of originating here, and that switch on and off instead of
    ramping once.

      cycle     equipment wear at one station, cycle time creep
      param     calibration drift of one process parameter at one station
      ambient   a zone-wide environmental driver (booth temperature, humidity)
                that moves every parameter in the zone at once, each by its
                own drift_sensitivity. magnitude is in sigmas.
      operator  a manning change at one station: a different person, a
                different pace, switching at a break boundary
      carry_in  a defect that appears at `station` but is caused by `source`
                putting the part out of tolerance further upstream

    Any kind becomes intermittent by setting duty_on_s and duty_off_s: the
    cause is present for duty_on_s, absent for duty_off_s, repeating. A
    condition that keeps disappearing before anyone reaches the station is
    the one plants find hardest, and it is a different failure mode from a
    transient that self-corrects once.
    """
    kind: str
    station: str
    start_s: int
    ramp_s: int               # seconds to reach full magnitude
    end_s: int                # when the fault is repaired
    magnitude: float          # cycle: multiplier delta. param: shift in units
    param: Optional[str] = None
    label: str = ""
    zone: Optional[str] = None        # ambient: which zone it covers
    source: Optional[str] = None      # carry_in: where the real cause is
    duty_on_s: int = 0                # intermittent: 0 means continuous
    duty_off_s: int = 0

    def intensity(self, t: int) -> float:
        if t < self.start_s or t >= self.end_s:
            return 0.0
        if self.duty_on_s > 0 and self.duty_off_s > 0:
            phase = (t - self.start_s) % (self.duty_on_s + self.duty_off_s)
            if phase >= self.duty_on_s:
                return 0.0
        if t >= self.start_s + self.ramp_s:
            return 1.0
        return (t - self.start_s) / max(1.0, self.ramp_s)


@dataclass
class Unit:
    uid: int
    launched_s: int
    variant: Optional[str] = None      # which model this body is
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
        self.by_sid: Dict[str, Station] = {s.sid: s for s in self.stations}
        self._carry_in_sids = {f.station for f in self.faults
                               if f.kind == "carry_in"}
        mix = variant_mix(self.stations)
        self._variants: List[str] = sorted(mix)
        self._variant_p = [mix[v] for v in self._variants]

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
            # equipment wear and a manning change are both cycle-time causes;
            # they are separate kinds because they need separate fixes, and
            # because the twin should not be scored as if they were the same.
            if f.kind in ("cycle", "operator") and f.station == sid:
                m += f.magnitude * f.intensity(t)
        return m

    def _fault_param_shift(self, sid: str, param: str, t: int) -> float:
        d = 0.0
        st = self.by_sid.get(sid)
        for f in self.faults:
            if f.kind == "param" and f.station == sid and f.param == param:
                d += f.magnitude * f.intensity(t)
            elif f.kind == "ambient" and st is not None and f.zone == st.zone:
                # One driver, many stations. Each parameter responds by its
                # own declared sensitivity, which is what makes this hard to
                # tell apart from several independent tools drifting at once.
                spec = st.process_params.get(param)
                if spec is not None:
                    d += (f.magnitude * f.intensity(t) *
                          spec["sigma"] * spec["drift_sensitivity"])
        return d

    def _carry_in_boost(self, st: Station, u: Unit, t: int) -> Tuple[float, Optional[str]]:
        """Extra defect risk here caused by a part that arrived already bad.

        Nothing at this station is out of tolerance. The parameter that put
        the defect in was recorded on this body's passport several stations
        ago, which is exactly the trace genealogy has to find.
        """
        boost, origin = 0.0, None
        for f in self.faults:
            if f.kind != "carry_in" or f.station != st.sid:
                continue
            k = f.intensity(t)
            if k <= 0.0 or not f.source or not f.param:
                continue
            rec = u.passport.get(f.source)
            src = self.by_sid.get(f.source)
            if rec is None or src is None:
                continue
            spec = src.process_params.get(f.param)
            v = (rec.get("params") or {}).get(f.param)
            if spec is None or v is None:
                continue
            z = abs(v - spec["mean"]) / max(spec["sigma"], 1e-9)
            b = f.magnitude * k * max(0.0, z - 1.0)
            if b > boost:
                boost, origin = b, f.source
        return boost, origin

    def _sample_cycle(self, st: Station, t: int,
                      variant: Optional[str] = None) -> float:
        # Work content is per variant: an SUV's harness, headliner and seat
        # set take longer than a sedan's at the stations that fit them, and
        # are indistinguishable from a sedan's at the stations that do not.
        base = st.cycle_for(variant) * self._fault_cycle_mult(st.sid, t)
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

    def _defect_roll(self, st: Station, params: Dict[str, float],
                     u: Optional[Unit] = None,
                     t: int = 0) -> Optional[Tuple[str, str]]:
        """(defect type, origin station) or None.

        Origin is where an 8D would place the cause, which is not always
        where the defect was created: a part that arrived out of tolerance
        is the upstream station's doing, and that is the attribution the
        twin's genealogy has to reproduce from passport data alone.
        """
        base = 0.0011
        z_own = 0.0
        for p, v in params.items():
            spec = st.process_params[p]
            z = abs(v - spec["mean"]) / spec["sigma"] * spec["drift_sensitivity"]
            z_own = max(z_own, z)
        # a bad part arriving raises the risk here as surely as a bad tool
        z_carry, carry_origin = (self._carry_in_boost(st, u, t)
                                 if u is not None else (0.0, None))
        z_max = max(z_own, z_carry)
        p_def = min(0.55, base * math.exp(0.85 * max(0.0, z_max - 1.0)))
        if st.tier == TIER_C:
            p_def = max(p_def, 0.0022)          # manual work, no process trace
        if self.rng.random() < p_def:
            origin = (carry_origin if (carry_origin is not None
                                       and z_carry > z_own) else st.sid)
            return DEFECT_BY_ZONE[st.zone], origin
        return None

    # ------------------------------------------------------------------
    def _new_unit(self, t: int) -> Unit:
        self._uid += 1
        u = Unit(uid=self._uid, launched_s=t, variant=self._sample_variant())
        self._live.append(u)
        return u

    def _sample_variant(self) -> Optional[str]:
        """Draw the next body's model from the line's build mix.

        Independent draws, not a scheduled sequence. A real plant sequences
        deliberately to avoid consecutive labour-heavy bodies at one station;
        drawing independently is the harder case for the twin, not the easier
        one, because it puts more variance in the hand-off gaps L2 reads.
        """
        if not self._variants:
            return None
        i = int(self.rng.choice(len(self._variants), p=self._variant_p))
        return self._variants[i]

    def _complete(self, i: int, t: int) -> None:
        st = self.stations[i]
        s = self.state[i]
        u = s.unit
        dur = t - s.started_s
        params = self._sample_params(st, t)
        rollable = (st.process_params or st.tier == TIER_C
                    or st.sid in self._carry_in_sids)
        roll = self._defect_roll(st, params, u, t) if rollable else None
        dtype, origin_sid = roll if roll else (None, None)
        if dtype:
            u.latent.append((dtype, origin_sid))

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
            # The build order is MES data, known before the body is launched
            # and readable at every station including the dark ones. It is
            # not a sensor and not ground truth.
            "variant": u.variant,
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
            "variant": u.variant,
            "true_cycle_s": round(s.work_s, 2),
            "true_station_time_s": round(dur, 2),
            "true_blocked_s": s.blocked_s,
            "true_starved_s": s.starved_s,
            "defect_created": dtype,
            "defect_origin": origin_sid,
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
                s.remaining = self._sample_cycle(self.stations[i], t, u.variant)
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
