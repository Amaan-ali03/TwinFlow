"""
Layer 5: decision and trust.

Two rules govern everything here.

Recommend, never actuate. TwinFlow has no write path to a PLC. It produces a
risk score, the evidence behind it, a named action and an owner. A human
decides. This is not timidity, it is what makes the system installable during
a normal week instead of during an annual shutdown.

Every alert is scored after the fact. An alert carries a verify_by time and a
falsifiable outcome test. When that time arrives the ledger marks the alert
true or false against what the line actually did. Precision by alert type is
published on the same screen as the alerts, and when precision for a type
falls below its floor the threshold for that type rises automatically. A
prediction system that cannot be audited by the people it interrupts will be
ignored by them within a fortnight.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import itertools

MONITOR = "MONITOR"
ADVISE = "ADVISE"
ACT_NOW = "ACT NOW"

BOTTLENECK = "BOTTLENECK"
DEFECT_RISK = "DEFECT_RISK"
DARK_STATION = "DARK_STATION"

_ids = itertools.count(1)


@dataclass
class Alert:
    aid: int
    t: int
    kind: str
    sid: str
    headline: str
    risk: float
    confidence: float
    tier: str
    severity_units: float
    evidence: List[str] = field(default_factory=list)
    action: str = ""
    owner: str = ""
    expected_impact: str = ""
    falsifier: str = ""
    verify_by: int = 0
    outcome: Optional[str] = None      # TRUE / FALSE / OPEN
    outcome_note: str = ""
    lead_time_s: Optional[float] = None
    acknowledged: bool = False
    updates: int = 0
    last_update_t: int = 0
    peak_risk: float = 0.0

    def as_dict(self) -> dict:
        return {
            "aid": self.aid, "t": self.t, "kind": self.kind, "sid": self.sid,
            "headline": self.headline, "risk": round(self.risk, 1),
            "confidence": round(self.confidence, 3), "tier": self.tier,
            "severity_units": round(self.severity_units, 2),
            "evidence": self.evidence, "action": self.action,
            "owner": self.owner, "expected_impact": self.expected_impact,
            "falsifier": self.falsifier, "verify_by": self.verify_by,
            "updates": self.updates, "last_update_t": self.last_update_t,
            "peak_risk": round(self.peak_risk, 1),
            "outcome": self.outcome, "outcome_note": self.outcome_note,
            "lead_time_s": self.lead_time_s,
        }


def risk_score(severity_units: float, confidence: float,
               urgency_s: float, horizon_s: float = 1800.0) -> float:
    """Severity times belief times how little time is left to react."""
    sev = min(1.0, severity_units / 12.0)
    urg = max(0.15, 1.0 - min(1.0, urgency_s / horizon_s))
    return round(100.0 * sev * confidence * (0.55 + 0.45 * urg), 1)


def tier_for(risk: float, floors: Tuple[float, float] = (35.0, 62.0)) -> str:
    if risk >= floors[1]:
        return ACT_NOW
    if risk >= floors[0]:
        return ADVISE
    return MONITOR


class AlertLedger:
    """Fires alerts, dedupes them, then grades itself."""

    COOLDOWN_S = {BOTTLENECK: 2700, DEFECT_RISK: 7200, DARK_STATION: 2700}
    PRECISION_FLOOR = {BOTTLENECK: 0.70, DEFECT_RISK: 0.55, DARK_STATION: 0.65}

    def __init__(self):
        self.alerts: List[Alert] = []
        self.last_fired: Dict[Tuple[str, str], int] = {}
        self.threshold_bump: Dict[str, float] = {
            BOTTLENECK: 0.0, DEFECT_RISK: 0.0, DARK_STATION: 0.0}

    # ------------------------------------------------------------------
    def can_fire(self, kind: str, sid: str, t: int) -> bool:
        last = self.last_fired.get((kind, sid))
        return last is None or (t - last) >= self.COOLDOWN_S[kind]

    def open_for(self, kind: str, sid: str) -> Optional[Alert]:
        for a in reversed(self.alerts):
            if a.kind == kind and a.sid == sid and a.outcome == "OPEN":
                return a
        return None

    def fire(self, **kw) -> Optional[Alert]:
        """One card per condition.

        A condition that is still true is an update to the alert already on
        the supervisor's screen, not a second alert. Interrupting someone
        seven times about one nutrunner is how a system gets muted.
        """
        kind, sid, t = kw["kind"], kw["sid"], kw["t"]
        floor = 35.0 + self.threshold_bump[kind]
        if kind == DEFECT_RISK:
            floor = max(floor, 55.0)   # defect claims need more belief before they interrupt anyone
        if kw["risk"] < floor:
            return None

        live = self.open_for(kind, sid)
        if live is not None:
            live.updates += 1
            live.last_update_t = t
            live.peak_risk = max(live.peak_risk, kw["risk"])
            live.risk = kw["risk"]
            live.tier = kw["tier"]
            live.headline = kw["headline"]
            live.evidence = kw["evidence"]
            live.severity_units = kw["severity_units"]
            live.confidence = kw["confidence"]
            return None

        if not self.can_fire(kind, sid, t):
            return None
        a = Alert(aid=next(_ids), outcome="OPEN", **kw)
        a.peak_risk = kw["risk"]
        a.last_update_t = t
        self.alerts.append(a)
        self.last_fired[(kind, sid)] = t
        return a

    # ------------------------------------------------------------------
    def resolve(self, now: int, observed) -> None:
        """observed(alert) -> (True/False, note). Called once past verify_by."""
        for a in self.alerts:
            if a.outcome != "OPEN" or now < a.verify_by:
                continue
            ok, note = observed(a)
            if note == "too few bodies built after the alert to judge":
                a.outcome = "PENDING"      # the shift ended before the test
                a.outcome_note = "verification window ran past the end of shift"
                continue
            a.outcome = "TRUE" if ok else "FALSE"
            a.outcome_note = note
        self._retune()

    def _retune(self) -> None:
        for kind, floor in self.PRECISION_FLOOR.items():
            p = self.precision(kind)
            n = sum(1 for a in self.alerts
                    if a.kind == kind and a.outcome in ("TRUE", "FALSE"))
            if n < 5 or p is None:
                continue
            if p < floor:
                self.threshold_bump[kind] = min(35.0, self.threshold_bump[kind] + 6.0)
            elif p > floor + 0.20:
                self.threshold_bump[kind] = max(0.0, self.threshold_bump[kind] - 3.0)

    # ------------------------------------------------------------------
    def precision(self, kind: Optional[str] = None) -> Optional[float]:
        rows = [a for a in self.alerts
                if a.outcome in ("TRUE", "FALSE") and (kind is None or a.kind == kind)]
        if not rows:
            return None
        return sum(1 for a in rows if a.outcome == "TRUE") / len(rows)

    def mean_lead_time_s(self, kind: Optional[str] = None) -> Optional[float]:
        rows = [a.lead_time_s for a in self.alerts
                if a.outcome == "TRUE" and a.lead_time_s is not None
                and (kind is None or a.kind == kind)]
        return sum(rows) / len(rows) if rows else None

    def summary(self) -> dict:
        out = {"total": len(self.alerts)}
        for kind in (BOTTLENECK, DEFECT_RISK, DARK_STATION):
            rows = [a for a in self.alerts if a.kind == kind]
            graded = [a for a in rows if a.outcome in ("TRUE", "FALSE")]
            out[kind] = {
                "fired": len(rows),
                "graded": len(graded),
                "true": sum(1 for a in graded if a.outcome == "TRUE"),
                "false": sum(1 for a in graded if a.outcome == "FALSE"),
                "precision": self.precision(kind),
                "mean_lead_s": self.mean_lead_time_s(kind),
                "threshold_bump": self.threshold_bump[kind],
            }
        out["precision_all"] = self.precision()
        return out


# ----------------------------------------------------------------------
# Recommendation templates. Deliberately boring and specific: a supervisor
# should be able to act without interpreting anything.
# ----------------------------------------------------------------------

def bottleneck_action(sid: str, name: str, cycle_s: float, nominal_s: float,
                      victim: str, eta_min: float) -> Tuple[str, str, str]:
    over = cycle_s - nominal_s
    action = (f"Send a technician to {sid} {name} now. Cycle is {cycle_s:.0f} s "
              f"against a standard of {nominal_s:.0f} s, so it is losing "
              f"{over:.0f} s on every body. Check tooling and fixture clamp "
              f"before touching the line speed.")
    owner = "Zone team leader, body shop"
    impact = (f"Recovering {sid} to standard prevents {victim} from running dry "
              f"in about {eta_min:.0f} min and holds the shift plan.")
    return action, owner, impact


def defect_action(sid: str, name: str, param: str, ewma: float,
                  baseline: float, limit: float, ttl_min: Optional[float],
                  n_at_risk: int, n_shipped: int) -> Tuple[str, str, str]:
    ttl = f"about {ttl_min:.0f} min" if ttl_min else "an unknown time"
    action = (f"Recalibrate the tool at {sid} {name}. {param} has moved from "
              f"{baseline:.2f} to {ewma:.2f} while staying inside the limit of "
              f"{limit:.2f}, and reaches that limit in {ttl}. Hold and re check "
              f"the {n_at_risk} bodies still on the line that passed this "
              f"station during the drift.")
    owner = "Quality engineer, final assembly"
    impact = (f"Containment is {n_at_risk} bodies on line plus {n_shipped} "
              f"already rolled out, instead of an open ended recall.")
    return action, owner, impact


def dark_station_action(sid: str, name: str, cycle_hat: float, nominal: float,
                        confidence: float) -> Tuple[str, str, str]:
    action = (f"Check manning and material at {sid} {name}. There is no sensor "
              f"here, so this is inferred from hand off scans: work content "
              f"looks like {cycle_hat:.0f} s against a standard of "
              f"{nominal:.0f} s. Confirm on the floor before acting.")
    owner = "Shift supervisor"
    impact = (f"Inference confidence is {confidence:.0%}. Confirming on the "
              f"floor either clears the station or converts this into a "
              f"manning decision within one cycle.")
    return action, owner, impact
