"""
Line topology for the TwinFlow digital twin.

The plant is modelled as a directed chain of stations connected by buffers.
Every station carries a sensor tier that decides which signals the twin can
observe directly and which it must infer.

Tier A  full PLC + process sensors (cycle time, torque, vibration, temperature)
Tier B  PLC handshake only (cycle time, no process signals)
Tier C  dark station, manual checklist, only MES barcode scans at hand off
        plus an optional retrofit webcam motion duty cycle

Reference parameters from the brief: 30 to 50 stations across body, paint and
final assembly, majority instrumented, meaningful minority manual.

The topology itself is data, not code. It lives in lines/*.json so the same
engine can be pointed at a different line, a different zone or a different
plant without touching a single estimator. Nothing downstream of here refers
to a station by name: layers select on tier and on declared process
parameters, so a line with a different station list needs a new JSON file and
nothing else.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional
import json
import os

TIER_A = "A"
TIER_B = "B"
TIER_C = "C"

ZONE_BODY = "BODY"
ZONE_PAINT = "PAINT"
ZONE_FINAL = "FINAL"


@dataclass
class Station:
    sid: str
    name: str
    zone: str
    index: int
    tier: str
    nominal_cycle_s: float          # the base variant's cycle time
    cycle_sigma_s: float
    out_buffer_cap: int
    has_camera: bool = False
    process_params: Dict[str, Dict[str, float]] = field(default_factory=dict)
    is_inspection: bool = False
    manual_check: bool = False
    # Mixed model: work content is not one number per station. A body with a
    # third seat row, a longer roof and a bigger harness takes measurably
    # longer at the stations that fit those things, and the same station is
    # unremarkable on the base variant. Both dicts are resolved at load time
    # from the line spec, so every layer reads them off the station.
    variant_cycle_mult: Dict[str, float] = field(default_factory=dict)
    variant_share: Dict[str, float] = field(default_factory=dict)

    @property
    def observed_signals(self) -> List[str]:
        if self.tier == TIER_A:
            return ["cycle_time"] + sorted(self.process_params.keys())
        if self.tier == TIER_B:
            return ["cycle_time"]
        return ["mes_scan"] + (["motion_duty"] if self.has_camera else [])

    def cycle_for(self, variant: Optional[str] = None) -> float:
        """Nominal cycle time for one variant, or the mix average for None."""
        if variant is None:
            return self.mix_cycle_s
        return self.nominal_cycle_s * self.variant_cycle_mult.get(variant, 1.0)

    @property
    def mix_cycle_s(self) -> float:
        """Nominal cycle time averaged over the line's declared build mix.

        This, not nominal_cycle_s, is the honest baseline to compare an
        observed cycle time against: an estimator watching a mixed sequence
        converges on the mix average, so scoring it against the base variant
        would read a pure scheduling effect as a process problem.
        """
        if not self.variant_share:
            return self.nominal_cycle_s
        return sum(sh * self.cycle_for(v) for v, sh in self.variant_share.items())


def _param(mean: float, sigma: float, lsl: float, usl: float,
           drift_sensitivity: float = 1.0) -> Dict[str, float]:
    return {
        "mean": mean,
        "sigma": sigma,
        "lsl": lsl,
        "usl": usl,
        "drift_sensitivity": drift_sensitivity,
    }


_LINES_DIR = os.path.join(os.path.dirname(__file__), "lines")
_DEFAULT_LINE = os.path.join(_LINES_DIR, "final_assembly_a.json")


def _variant_defaults(spec: dict) -> tuple:
    """(share by variant, default cycle multiplier by variant) from a line spec.

    A spec with no "variants" block yields two empty dicts, and every station
    then behaves exactly as a single model line — which is what an older
    lines/*.json file gets, with no migration.
    """
    block = spec.get("variants") or {}
    if not block:
        return {}, {}
    total = sum(float(v.get("share", 0.0)) for v in block.values())
    if total <= 0:
        return {}, {}
    share = {k: float(v.get("share", 0.0)) / total for k, v in block.items()}
    mult = {k: float(v.get("cycle_mult", 1.0)) for k, v in block.items()}
    return share, mult


def _station_from_spec(idx: int, spec: dict,
                       share: Optional[Dict[str, float]] = None,
                       default_mult: Optional[Dict[str, float]] = None) -> Station:
    st = Station(
        sid=spec["sid"], name=spec["name"], zone=spec["zone"], index=idx,
        tier=spec["tier"], nominal_cycle_s=spec["nominal_cycle_s"],
        cycle_sigma_s=spec["cycle_sigma_s"], out_buffer_cap=spec["out_buffer_cap"],
        has_camera=spec.get("has_camera", False),
        is_inspection=spec.get("is_inspection", False),
        manual_check=spec.get("manual_check", False),
    )
    # process_params keys are param name -> {mean, sigma, lsl, usl,
    # drift_sensitivity}; JSON round-trips this shape exactly, so no
    # per-field defaulting is needed here the way _param() used to do it.
    st.process_params = {p: dict(v) for p, v in spec.get("process_params", {}).items()}
    # Line-wide multiplier per variant, overridden per station where this
    # station's work genuinely differs by model (seat set, harness, roof).
    st.variant_share = dict(share or {})
    st.variant_cycle_mult = dict(default_mult or {})
    st.variant_cycle_mult.update(
        {k: float(v) for k, v in (spec.get("variant_cycle_mult") or {}).items()})
    return st


def build_line(spec_path: Optional[str] = None) -> List[Station]:
    """Return the station chain for one line, loaded from a JSON spec.

    The topology used to be a hardcoded literal in this function. It is now
    data: lines/final_assembly_a.json is the 42 station mixed model line used
    by the prototype, and a different line is a different file passed here.
    Station order in the file is the line order — index is assigned by
    position, not stored in the file.
    """
    path = spec_path or _DEFAULT_LINE
    with open(path) as f:
        spec = json.load(f)
    share, mult = _variant_defaults(spec)
    return [_station_from_spec(i, s, share, mult)
            for i, s in enumerate(spec["stations"])]


def variant_mix(stations: List[Station]) -> Dict[str, float]:
    """The line's build mix, read back off the stations that carry it."""
    for s in stations:
        if s.variant_share:
            return dict(s.variant_share)
    return {}


def tier_summary(stations: List[Station]) -> Dict[str, int]:
    out: Dict[str, int] = {TIER_A: 0, TIER_B: 0, TIER_C: 0}
    for s in stations:
        out[s.tier] += 1
    return out


def station_map(stations: List[Station]) -> Dict[str, Station]:
    return {s.sid: s for s in stations}


def downstream_of(stations: List[Station], sid: str) -> List[Station]:
    m = station_map(stations)
    return stations[m[sid].index + 1:]


def find_inspection_after(stations: List[Station], sid: str) -> Optional[Station]:
    for s in downstream_of(stations, sid):
        if s.is_inspection:
            return s
    return None
