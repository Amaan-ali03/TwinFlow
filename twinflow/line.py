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
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional

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
    nominal_cycle_s: float
    cycle_sigma_s: float
    out_buffer_cap: int
    has_camera: bool = False
    process_params: Dict[str, Dict[str, float]] = field(default_factory=dict)
    is_inspection: bool = False
    manual_check: bool = False

    @property
    def observed_signals(self) -> List[str]:
        if self.tier == TIER_A:
            return ["cycle_time"] + sorted(self.process_params.keys())
        if self.tier == TIER_B:
            return ["cycle_time"]
        return ["mes_scan"] + (["motion_duty"] if self.has_camera else [])


def _param(mean: float, sigma: float, lsl: float, usl: float,
           drift_sensitivity: float = 1.0) -> Dict[str, float]:
    return {
        "mean": mean,
        "sigma": sigma,
        "lsl": lsl,
        "usl": usl,
        "drift_sensitivity": drift_sensitivity,
    }


def build_line() -> List[Station]:
    """Return the 42 station mixed model line used by the prototype."""
    S: List[Station] = []
    idx = 0

    # ---------------- BODY CONSTRUCTION: 14 stations ----------------
    body_spec = [
        ("BS01", "Underbody framing", TIER_A, 56.0, 2.0),
        ("BS02", "Underbody weld 1", TIER_A, 58.0, 2.2),
        ("BS03", "Underbody weld 2", TIER_A, 58.0, 2.2),
        ("BS04", "Side frame left", TIER_A, 60.0, 2.5),
        ("BS05", "Side frame right", TIER_A, 60.0, 2.5),
        ("BS06", "Framing gate", TIER_A, 62.0, 2.0),
        ("BS07", "Respot weld cell", TIER_A, 58.0, 2.4),
        ("BS08", "Roof laser braze", TIER_A, 61.0, 2.0),
        ("BS09", "Hem and clinch", TIER_B, 57.0, 2.6),
        ("BS10", "Door fit", TIER_B, 59.0, 3.0),
        ("BS11", "Fender fit", TIER_A, 57.0, 2.3),
        ("BS12", "Metal finish", TIER_C, 63.0, 5.5),
        ("BS13", "Body geometry gate", TIER_A, 55.0, 1.8),
        ("BS14", "Body store transfer", TIER_B, 52.0, 2.0),
    ]
    for sid, name, tier, cyc, sig in body_spec:
        st = Station(sid, name, ZONE_BODY, idx, tier, cyc, sig,
                     out_buffer_cap=3 if sid != "BS14" else 12)
        if tier == TIER_A:
            st.process_params = {
                "weld_current_a": _param(9800, 55, 9450, 10150),
                "electrode_force_n": _param(3400, 40, 3200, 3600),
                "vibration_mm_s": _param(2.1, 0.18, 0.0, 3.2, 1.4),
                "cell_temp_c": _param(38.0, 1.2, 20.0, 52.0, 0.6),
            }
        if tier == TIER_C:
            st.manual_check = True
            st.has_camera = True
        if sid == "BS13":
            st.is_inspection = True
        S.append(st)
        idx += 1

    # ---------------- PAINT SHOP: 10 stations ----------------
    paint_spec = [
        ("PT01", "Pretreat and e-coat", TIER_A, 64.0, 2.0),
        ("PT02", "E-coat oven", TIER_A, 66.0, 1.6),
        ("PT03", "Sealer robot", TIER_B, 62.0, 3.0),
        ("PT04", "Sealer manual touch", TIER_C, 68.0, 6.0),
        ("PT05", "Primer booth", TIER_A, 63.0, 2.0),
        ("PT06", "Primer sand", TIER_C, 70.0, 6.5),
        ("PT07", "Base coat booth", TIER_A, 65.0, 2.1),
        ("PT08", "Clear coat booth", TIER_A, 64.0, 2.0),
        ("PT09", "Paint inspect deck", TIER_C, 61.0, 5.0),
        ("PT10", "Paint store transfer", TIER_B, 54.0, 2.2),
    ]
    for sid, name, tier, cyc, sig in paint_spec:
        st = Station(sid, name, ZONE_PAINT, idx, tier, cyc, sig,
                     out_buffer_cap=4 if sid != "PT10" else 15)
        if tier == TIER_A:
            st.process_params = {
                "booth_temp_c": _param(23.0, 0.5, 20.0, 26.0, 1.1),
                "humidity_pct": _param(62.0, 2.0, 50.0, 72.0, 1.0),
                "film_thickness_um": _param(38.0, 1.3, 32.0, 45.0, 1.3),
                "vibration_mm_s": _param(1.6, 0.15, 0.0, 2.8, 1.0),
            }
        if tier == TIER_C:
            st.manual_check = True
            st.has_camera = sid in ("PT06", "PT09")
        if sid == "PT09":
            st.is_inspection = True
        S.append(st)
        idx += 1

    # ---------------- FINAL ASSEMBLY: 18 stations ----------------
    final_spec = [
        ("FA01", "Door removal", TIER_B, 58.0, 2.8),
        ("FA02", "Harness lay in", TIER_C, 66.0, 6.0),
        ("FA03", "Cockpit module set", TIER_A, 62.0, 2.2),
        ("FA04", "Cockpit bolt torque", TIER_A, 59.0, 2.0),
        ("FA05", "Glass urethane", TIER_A, 60.0, 2.1),
        ("FA06", "Headliner", TIER_C, 64.0, 5.8),
        ("FA07", "Carpet and console", TIER_B, 61.0, 3.2),
        ("FA08", "Seat set", TIER_A, 57.0, 2.0),
        ("FA09", "Chassis marriage", TIER_A, 68.0, 2.6),
        ("FA10", "Suspension torque", TIER_A, 62.0, 2.2),
        ("FA11", "Brake line", TIER_A, 60.0, 2.0),
        ("FA12", "Wheel and tyre", TIER_B, 55.0, 2.4),
        ("FA13", "Fluid fill", TIER_A, 63.0, 2.0),
        ("FA14", "Door rehang", TIER_C, 65.0, 5.5),
        ("FA15", "Bumper and trim", TIER_C, 62.0, 5.2),
        ("FA16", "Electrical flash", TIER_A, 58.0, 1.9),
        ("FA17", "End of line test", TIER_A, 72.0, 3.0),
        ("FA18", "Roll out and audit", TIER_B, 54.0, 2.5),
    ]
    for sid, name, tier, cyc, sig in final_spec:
        st = Station(sid, name, ZONE_FINAL, idx, tier, cyc, sig,
                     out_buffer_cap=2)
        if tier == TIER_A:
            st.process_params = {
                "vibration_mm_s": _param(1.4, 0.14, 0.0, 2.6, 1.0),
                "cell_temp_c": _param(31.0, 1.0, 18.0, 45.0, 0.7),
            }
        if sid in ("FA04", "FA10"):
            st.process_params["bolt_torque_nm"] = _param(
                42.0, 0.55, 38.0, 46.0, 1.6)
            st.process_params["angle_deg"] = _param(88.0, 1.4, 80.0, 96.0, 1.1)
        if sid == "FA09":
            st.process_params["press_force_kn"] = _param(
                12.5, 0.3, 11.4, 13.6, 1.2)
        if tier == TIER_C:
            st.manual_check = True
            st.has_camera = sid in ("FA02", "FA14")
        if sid in ("FA16", "FA17", "FA18"):
            st.is_inspection = True
        S.append(st)
        idx += 1

    return S


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
