"""
Layer 4b: genealogy and containment.

A torque fault at station FA04 does not show up at FA04. It shows up at
FA17, fourteen stations and roughly seventeen minutes of line time later.
By then more bodies carrying the same fault have been built, some are still
on the line and some have already rolled out to the yard.

Two questions follow, and the twin answers both from the same object: the
unit passport, which is the barcode history of one body with the process
values recorded at every station it touched.

  Which station made this  -> compare the passports of failing bodies with
                              the passports of passing bodies, station by
                              station, and rank by separation.
  Which other bodies are at risk -> replay the passports and select every
                              body that passed the suspect station while it
                              was in the drifting state.

The second answer is the one that saves money, because it turns an unbounded
recall into a numbered list.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import math
import numpy as np


@dataclass
class Suspect:
    sid: str
    param: str
    t_stat: float
    fail_mean: float
    pass_mean: float
    baseline_sigma: float
    direction: str
    n_fail: int
    n_pass: int

    @property
    def shift_sigma(self) -> float:
        return (self.fail_mean - self.pass_mean) / max(self.baseline_sigma, 1e-9)

    def as_dict(self) -> dict:
        return {
            "sid": self.sid, "param": self.param,
            "t_stat": round(self.t_stat, 2),
            "shift_sigma": round(self.shift_sigma, 2),
            "fail_mean": round(self.fail_mean, 3),
            "pass_mean": round(self.pass_mean, 3),
            "direction": self.direction,
            "n_fail": self.n_fail, "n_pass": self.n_pass,
        }


class GenealogyStore:
    """Barcode history for every body, assembled from the MES scan stream."""

    def __init__(self, stations):
        self.stations = stations
        self.order = {s.sid: i for i, s in enumerate(stations)}
        self.passports: Dict[int, Dict[str, dict]] = {}
        self.last_station: Dict[int, str] = {}
        self.dispositions: Dict[int, dict] = {}

    def observe(self, ev: dict) -> None:
        p = self.passports.setdefault(ev["uid"], {})
        p[ev["sid"]] = {"t": ev["t"], "params": ev.get("params") or {},
                        "cycle_s": ev.get("cycle_s")}
        self.last_station[ev["uid"]] = ev["sid"]

    def observe_quality(self, q: dict) -> None:
        if q["result"] == "FAIL":
            self.dispositions[q["uid"]] = q

    # ------------------------------------------------------------------
    def backtrace(self, inspection_sid: str, window_s: Tuple[int, int],
                  min_fail: int = 6, top_k: int = 3) -> List[Suspect]:
        """Rank upstream stations by how strongly they separate fail from pass."""
        lo, hi = window_s
        fails, passes = [], []
        cut = self.order[inspection_sid]
        for uid, pp in self.passports.items():
            if inspection_sid not in pp:
                continue
            t = pp[inspection_sid]["t"]
            if not (lo <= t <= hi):
                continue
            (fails if uid in self.dispositions else passes).append(uid)
        if len(fails) < min_fail or len(passes) < min_fail:
            return []

        out: List[Suspect] = []
        for st in self.stations:
            if self.order[st.sid] >= cut or not st.process_params:
                continue
            for param, spec in st.process_params.items():
                fv = [self.passports[u][st.sid]["params"].get(param)
                      for u in fails if st.sid in self.passports[u]]
                pv = [self.passports[u][st.sid]["params"].get(param)
                      for u in passes if st.sid in self.passports[u]]
                fv = [v for v in fv if v is not None]
                pv = [v for v in pv if v is not None]
                if len(fv) < min_fail or len(pv) < min_fail:
                    continue
                fa, pa = np.array(fv), np.array(pv)
                sp = math.sqrt(max(fa.var(ddof=1) / len(fa) +
                                   pa.var(ddof=1) / len(pa), 1e-12))
                t_stat = float((fa.mean() - pa.mean()) / sp)
                out.append(Suspect(
                    sid=st.sid, param=param, t_stat=t_stat,
                    fail_mean=float(fa.mean()), pass_mean=float(pa.mean()),
                    baseline_sigma=float(spec["sigma"]),
                    direction="low" if t_stat < 0 else "high",
                    n_fail=len(fa), n_pass=len(pa)))
        out.sort(key=lambda s: -abs(s.t_stat))
        return out[:top_k]

    # ------------------------------------------------------------------
    def containment(self, sid: str, t_from: int, t_to: int,
                    rolled_out_sid: Optional[str] = None) -> dict:
        """Every body that passed the suspect station while it was drifting."""
        rolled_out_sid = rolled_out_sid or self.stations[-1].sid
        in_line, shipped = [], []
        for uid, pp in self.passports.items():
            rec = pp.get(sid)
            if rec is None or not (t_from <= rec["t"] <= t_to):
                continue
            if rolled_out_sid in pp:
                shipped.append(uid)
            else:
                in_line.append(uid)
        return {
            "suspect_station": sid,
            "window": [t_from, t_to],
            "total": len(in_line) + len(shipped),
            "still_on_line": sorted(in_line),
            "already_rolled_out": sorted(shipped),
            "n_on_line": len(in_line),
            "n_rolled_out": len(shipped),
        }

    def lag_to_detection(self, origin_sid: str, inspection_sid: str) -> Optional[float]:
        """Median line time between making a fault and finding it."""
        gaps = []
        for uid in self.dispositions:
            pp = self.passports.get(uid, {})
            if origin_sid in pp and inspection_sid in pp:
                gaps.append(pp[inspection_sid]["t"] - pp[origin_sid]["t"])
        return float(np.median(gaps)) if gaps else None
