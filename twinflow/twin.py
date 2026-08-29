"""
The twin itself: wires the five layers together and runs them over the feed.

Nothing in this file is allowed to read simulator ground truth. It sees only
what the plant would emit. The one exception is grade(), which is the after
the fact scoring pass and is explicitly the plant's own downtime and quality
record, arriving late, exactly as it would in a real installation.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import math
import os
import numpy as np

from .line import build_line, TIER_A, TIER_B, TIER_C
from .virtual_sensors import VirtualSensorBank
from .propagate import PropagationEngine, STARVE, BLOCK
from .drift import DriftBank, DRIFTING, EXCURSION, WATCH
from .genealogy import GenealogyStore
from .defect_model import DefectRiskModel
from . import decision as D

STATE_CODE = {"WORK": 0, "STARVED": 1, "BLOCKED": 2}
DRIFT_CODE = {"STABLE": 0, "WATCH": 1, "DRIFTING": 2, "EXCURSION": 3}

# Fitted offline by fit_calibration.py, over shifts this run has never seen.
# Absent on a clean clone, in which case _defect_alerts() falls back to the
# hand-tuned confidence formula it always used.
_CALIBRATION_PATH = os.path.join(os.path.dirname(__file__), "calibration.json")


class TwinFlow:
    HORIZON_S = 1800
    BOTTLENECK_MARGIN = 1.15     # constraint must exceed takt by this much
    DARK_MARGIN = 1.22

    def __init__(self, stations=None, ledger_state=None):
        """ledger_state: an earlier run's AlertLedger.export_state(), so the
        precision-driven threshold retune carries across shifts instead of
        restarting from zero every time the twin is constructed."""
        self.stations = stations or build_line()
        self.sids = [s.sid for s in self.stations]
        self.names = {s.sid: s.name for s in self.stations}
        # Mix-weighted standard, not the base variant's. Every cycle time the
        # twin observes is an average over the models that actually ran, so a
        # single-model standard would read the build mix as a process fault.
        self.nominal = {s.sid: s.mix_cycle_s for s in self.stations}
        self.takt = max(self.nominal.values())

        self.vs = VirtualSensorBank(self.stations)
        self.drift = DriftBank(self.stations)
        self.gen = GenealogyStore(self.stations)
        self.eng = PropagationEngine(self.stations)
        self.ledger = D.AlertLedger(ledger_state)

        self.frames: List[dict] = []
        self.last_conf: Dict[str, float] = {s: 0.99 for s in self.sids}
        self.last_state: Dict[str, str] = {s: "WORK" for s in self.sids}
        self._drift_since: Dict[str, int] = {}
        self._first_alert_t: Dict[Tuple[str, str], int] = {}
        self.units_out: int = 0

        # uid -> sid -> drift.DriftBank.feature_row() at the moment that
        # body passed that station. Feeds the L4b origin_model's per-body
        # containment ranking. Only populated for param-carrying stations;
        # a body that only ever touches dark stations has no entries here.
        self.unit_features: Dict[int, Dict[str, dict]] = {}
        self.defect_model: Optional[DefectRiskModel] = DefectRiskModel.load(_CALIBRATION_PATH)

    # ------------------------------------------------------------------
    def run(self, sim, frame_every_s: int = 120, verbose: bool = False) -> dict:
        events = sorted(sim.events, key=lambda e: e["t"])
        quality = sorted(sim.quality, key=lambda q: q["t"])
        ei = qi = 0
        completed = sorted(sim.completed, key=lambda c: c[0])
        ci = 0
        last_sid = self.sids[-1]

        for t in range(0, sim.horizon_s + 1, frame_every_s):
            while ei < len(events) and events[ei]["t"] <= t:
                ev = events[ei]
                r = self.vs.observe(ev)
                self.drift.observe(ev)
                frow = self.drift.feature_row(ev)
                if frow is not None:
                    self.unit_features.setdefault(ev["uid"], {})[ev["sid"]] = frow
                self.gen.observe(ev)
                self.last_conf[ev["sid"]] = r.confidence
                self.last_state[ev["sid"]] = r.state
                ei += 1
            while qi < len(quality) and quality[qi]["t"] <= t:
                self.gen.observe_quality(quality[qi]); qi += 1
            while ci < len(completed) and completed[ci][0] <= t:
                self.units_out += 1; ci += 1

            if t < 900:                      # let the estimators find a baseline
                continue

            cycles = self.vs.current_cycles()
            buffers = self.vs.current_buffers()
            fc = self.eng.forecast(cycles, buffers, horizon_s=self.HORIZON_S,
                                   confidences=self.last_conf)

            new = []
            new += self._bottleneck_alerts(t, fc, cycles)
            new += self._dark_alerts(t, cycles)
            new += self._defect_alerts(t)

            self.ledger.resolve(t, lambda a: self._grade(a, sim))
            self.frames.append(self._frame(t, cycles, buffers, fc, new))

            if verbose and new:
                for a in new:
                    print(f"  [{t//3600:02d}:{(t%3600)//60:02d}] {a.tier:8s} "
                          f"risk {a.risk:5.1f}  {a.headline}")

        # final grading pass with everything that arrived late
        self.ledger.resolve(sim.horizon_s + 10 ** 6, lambda a: self._grade(a, sim))
        return {"frames": self.frames,
                "alerts": [a.as_dict() for a in self.ledger.alerts],
                "ledger": self.ledger.summary(),
                "ledger_state": self.ledger.export_state()}

    # ------------------------------------------------------------------
    def _bottleneck_alerts(self, t: int, fc, cycles) -> List[D.Alert]:
        out = []
        csid = fc.constraint_sid
        if not csid:
            return out
        if fc.constraint_cycle_s < self.nominal[csid] * self.BOTTLENECK_MARGIN:
            return out
        if fc.rate_loss_per_hr <= 0.5:
            return out
        victims = [e for e in fc.events if e.cause_sid == csid]
        if not victims:
            return out
        # The victim worth naming is the furthest downstream one, because that
        # is where the loss stops being absorbed and starts being counted.
        v = max(victims, key=lambda e: self._idx(e.sid))
        conf = min(self.last_conf.get(csid, 0.9), v.confidence)
        sev = fc.rate_loss_per_hr
        runway = fc.runway_s if fc.runway_s > 0 else v.at_s
        risk = D.risk_score(sev, conf, runway, self.HORIZON_S)
        act, owner, impact = D.bottleneck_action(
            csid, self.names[csid], fc.constraint_cycle_s, self.nominal[csid],
            v.sid, v.at_s / 60.0)
        verb = "runs dry" if v.kind == STARVE else "backs up"
        a = self.ledger.fire(
            t=t, kind=D.BOTTLENECK, sid=csid,
            headline=(f"{csid} {self.names[csid]} is the constraint at "
                      f"{fc.constraint_cycle_s:.0f} s. {v.sid} "
                      f"{self.names[v.sid]} {verb} in {v.at_s/60:.0f} min."),
            risk=risk, confidence=conf, tier=D.tier_for(risk),
            severity_units=sev,
            evidence=[
                f"{csid} work content {fc.constraint_cycle_s:.1f} s against "
                f"standard {self.nominal[csid]:.0f} s and takt "
                f"{fc.nominal_takt_s:.0f} s",
                f"sustained rate loss {fc.rate_loss_per_hr:.1f} bodies per hour "
                f"for as long as this persists",
                f"buffers hide it for another {runway/60:.0f} min, then the "
                f"end of line counter starts to fall",
                f"{len(victims)} stations downstream are affected in the "
                f"30 min forecast",
            ],
            action=act, owner=owner, expected_impact=impact,
            falsifier=(f"If {v.sid} loses less than two minutes to "
                       f"{'starvation' if v.kind == STARVE else 'blocking'} "
                       f"over the next {(v.at_s+600)/60:.0f} min, this alert "
                       f"was wrong."),
            verify_by=int(t + v.at_s + 900),
            lead_time_s=None)
        if a:
            a._victim = v.sid
            a._kind_pred = v.kind
            out.append(a)
        return out

    def _dark_alerts(self, t: int, cycles) -> List[D.Alert]:
        out = []
        for s in self.stations:
            if s.tier != TIER_C:
                continue
            std = self.nominal[s.sid]
            hat = cycles.get(s.sid, std)
            if hat < std * self.DARK_MARGIN:
                continue
            conf = self.last_conf.get(s.sid, 0.5)
            sev = (hat - std) / max(self.takt, 1.0) * 12.0
            risk = D.risk_score(max(sev, 1.0), conf, 600.0, self.HORIZON_S)
            act, owner, impact = D.dark_station_action(
                s.sid, s.name, hat, std, conf)
            a = self.ledger.fire(
                t=t, kind=D.DARK_STATION, sid=s.sid,
                headline=(f"{s.sid} {s.name} is slow. No sensors here, "
                          f"inferred work content {hat:.0f} s against "
                          f"{std:.0f} s standard for the mix built."),
                risk=risk, confidence=conf, tier=D.tier_for(risk),
                severity_units=max(sev, 1.0),
                evidence=[
                    f"inferred from hand off scans, method confidence {conf:.0%}",
                    f"no PLC and no process sensor at this station",
                    f"upstream buffer state: {self.last_state.get(s.sid)}",
                ],
                action=act, owner=owner, expected_impact=impact,
                falsifier=(f"If the floor confirms {s.sid} is running to "
                           f"standard, the inference was wrong and this "
                           f"station needs a scan point, not a technician."),
                verify_by=int(t + 900), lead_time_s=None)
            if a:
                out.append(a)
        return out

    def _defect_alerts(self, t: int) -> List[D.Alert]:
        out = []
        drifting = self.drift.drifting_stations()
        self._forget_recovered({s["sid"] for s in drifting})
        for snap in drifting:
            sid = snap["sid"]
            pname = snap["worst_param"]
            p = snap["params"][pname]
            self._drift_since.setdefault(sid, t)
            since = self._drift_since[sid]
            cont = self.gen.containment(sid, max(0, since - 1800), t)
            ttl_min = (p["ttl_spec_s"] / 60.0) if p["ttl_spec_s"] else None
            limit = p["lsl"] if p["ewma_z"] < 0 else p["usl"]

            # Confidence that gates firing is always the hand-tuned formula
            # below. A 200-shift, 5-fold cross-validated, Wilson-lower-bound
            # evaluation of L4b's alert_model (see defect_model.py) shows it
            # does discriminate — 66.7% out-of-fold precision against a
            # 19.4% base rate — but only at 18.7% recall. Gating here would
            # buy the precision number at the cost of missing four material
            # drifts in five, and catching every one of them is the claim
            # this engine is built on. So the alert fires on every DRIFTING
            # episode exactly as it always did, and the learned probability
            # rides along as evidence.
            hold_factor = min(1.0, p["streak"] / (self.drift.monitors[sid].HOLD * 3))
            conf = 0.45 + 0.35 * min(1.0, abs(p["ewma_z"]) / 10.0) + 0.15 * hold_factor
            if snap["t2_flag"]:
                conf = min(0.97, conf + 0.05)

            # The learned probability is surfaced as additional evidence,
            # not as the firing gate. Its useful job is ordering: given
            # three open drift alerts, it says which one to walk to first.
            learned_note = None
            if self.defect_model is not None:
                learned_conf = self.defect_model.alert_confidence(
                    snap, elapsed_s=t - since, n_affected=cont["total"])
                learned_note = (f"learned confidence {learned_conf:.0%} "
                                 f"(offline calibration against "
                                 f"{self.defect_model.n_train_shifts} training "
                                 f"shifts — informational, not a firing gate; "
                                 f"see fit_calibration.py)")
            sev = min(14.0, cont["total"] * 0.35 + 2.0)
            risk = D.risk_score(sev, conf, 900.0, self.HORIZON_S)
            act, owner, impact = D.defect_action(
                sid, self.names[sid], pname, p["ewma"], p["baseline_mean"],
                limit, ttl_min, cont["n_on_line"], cont["n_rolled_out"])
            insp = next((x.sid for x in self.stations
                         if x.is_inspection and x.index > self._idx(sid)), None)
            lag = self.gen.lag_to_detection(sid, insp) if insp else None
            a = self.ledger.fire(
                t=t, kind=D.DEFECT_RISK, sid=sid,
                headline=(f"{sid} {self.names[sid]} is drifting inside spec. "
                          f"{pname} centre moved {p['ewma_z']:+.1f} sigma. "
                          f"{cont['total']} bodies affected so far."),
                risk=risk, confidence=conf, tier=D.tier_for(risk),
                severity_units=sev,
                evidence=[
                    f"EWMA centre {p['ewma']:.2f} against baseline "
                    f"{p['baseline_mean']:.2f}, limit {limit:.2f}",
                    f"CUSUM {p['cusum_z']:.1f} sigma, condition held for "
                    f"{p['streak']} consecutive bodies",
                    (f"projected to reach the limit in {ttl_min:.0f} min at the "
                     f"current rate" if ttl_min else
                     "rate of movement not yet stable enough to project"),
                    (f"normal detection lag from {sid} to {insp} is "
                     f"{lag/60:.0f} min of line time" if lag else
                     f"first inspection downstream is {insp}"),
                    f"every individual reading is still inside specification",
                ] + ([learned_note] if learned_note else []),
                action=act, owner=owner, expected_impact=impact,
                falsifier=(f"If the fallout rate for bodies built at {sid} "
                           f"after this alert is no worse than the shift "
                           f"baseline, this alert was wrong."),
                verify_by=int(t + 10800), lead_time_s=None)

            # fire() returns None when it folded this tick into the alert
            # already on screen, refreshing that alert's headline and
            # evidence. The containment ranking has to be refreshed with
            # them: it used to be set only on the new-alert branch, so a
            # supervisor read "285 bodies affected so far" in the headline
            # next to "ranked by likely contributor (144 bodies)" in the
            # list right below it.
            target = a or self.ledger.open_for(D.DEFECT_RISK, sid)
            if target is not None:
                target._window = (since, t)
                target.at_risk_ranked = self._ranked_containment(sid, cont)
            if a:
                # Exactly what alert_model was scored on at the moment this
                # alert fired, kept for fit_calibration.py to train against.
                # Only on the firing tick: the decision being modelled is
                # "should this alert exist", which is taken once.
                a._l4b = {"snap": snap, "elapsed_s": t - since,
                          "n_affected": cont["total"]}
                self._first_alert_t.setdefault((a.kind, a.sid), t)
                out.append(a)
        return out

    def _forget_recovered(self, drifting_sids: set) -> None:
        """Drop _drift_since for stations that have stopped drifting.

        Without this the entry set on a station's first drift lives for the
        whole run, so a station that recovers and drifts again hours later
        gets a containment window reaching back across the healthy stretch
        in between. The 20-body hold counter in drift.py is what filters
        transients, so leaving DRIFTING is already a considered judgement,
        not a flicker — but hold the window open while an alert about it is
        still on screen, since that alert's own counts are derived from it.
        """
        for sid in list(self._drift_since):
            if sid in drifting_sids:
                continue
            if self.ledger.open_for(D.DEFECT_RISK, sid) is not None:
                continue
            del self._drift_since[sid]

    def _ranked_containment(self, sid: str, cont: dict) -> List[dict]:
        """Bodies the containment window caught, ranked by the origin
        model's belief that sid specifically is what put a defect into that
        body — turns a flat "here are 40 bodies" list into "start with
        these 12". Empty on a clean clone with no calibration.json.

        A body with no drift feature row at sid gets risk None, not a
        number, and sorts last. It is still listed: the list length has to
        keep matching the containment count the headline quotes.
        """
        if self.defect_model is None:
            return []
        on_line = set(cont["still_on_line"])
        ranked = []
        for uid in cont["still_on_line"] + cont["already_rolled_out"]:
            row = self.unit_features.get(uid, {}).get(sid)
            risk = self.defect_model.body_risk(row)
            ranked.append({
                "uid": uid,
                "risk": None if risk is None else round(risk, 4),
                "status": "on_line" if uid in on_line else "rolled_out",
            })
        ranked.sort(key=lambda r: -(r["risk"] if r["risk"] is not None else -1.0))
        return ranked

    def _idx(self, sid: str) -> int:
        return self.sids.index(sid)

    # ------------------------------------------------------------------
    def _grade(self, a: D.Alert, sim) -> Tuple[bool, str]:  # noqa: C901
        """Score an alert against what the plant actually recorded.

        These tests use the plant's own downtime log and quality dispositions,
        which arrive hours after the alert. That lag is the point: the ledger
        is a retrospective audit, not a second opinion available at the time.
        """
        if a.kind == D.BOTTLENECK:
            victim = getattr(a, "_victim", None)
            want = "true_starved_s" if getattr(a, "_kind_pred", STARVE) == STARVE \
                else "true_blocked_s"
            lost = sum(x.get(want, 0) for x in sim.truth
                       if x["sid"] == victim and a.t <= x["t"] <= a.verify_by + 600)
            if lost >= 120:
                a.lead_time_s = self._counter_lead(a, sim)
                return True, (f"{victim} lost {lost:.0f} s to "
                              f"{'starvation' if want.endswith('starved_s') else 'blocking'}")
            return False, f"{victim} lost only {lost:.0f} s, below the 120 s test"

        if a.kind == D.DARK_STATION:
            rows = [x["true_cycle_s"] for x in sim.truth
                    if x["sid"] == a.sid and a.t - 900 <= x["t"] <= a.verify_by]
            if not rows:
                return False, "no bodies processed in the window"
            m = float(np.mean(rows))
            ok = m >= self.nominal[a.sid] * 1.12
            return ok, f"true mean work content {m:.1f} s against {self.nominal[a.sid]:.0f} s standard"

        if a.kind == D.DEFECT_RISK:
            # Reference period: the first 45 minutes of the shift, which is
            # the stable stretch every plant already uses to set its first
            # time through target.
            made = {x["uid"] for x in sim.truth
                    if x["sid"] == a.sid and a.t <= x["t"] <= a.verify_by}
            base = {x["uid"] for x in sim.truth
                    if x["sid"] == a.sid and x["t"] < 2700}
            fails = {q["uid"] for q in sim.quality if q["result"] == "FAIL"}
            if len(made) < 8:
                return False, "too few bodies built after the alert to judge"
            n_a, n_b = len(made), max(len(base), 1)
            k_a, k_b = len(made & fails), len(base & fails)
            r_after, r_before = k_a / n_a, k_b / n_b
            # Materiality has two parts, exactly as a quality engineer would
            # argue it: the rise has to be real, and it has to be big enough
            # to be worth a line side intervention.
            pool = (k_a + k_b) / (n_a + n_b)
            se = math.sqrt(max(pool * (1 - pool) * (1 / n_a + 1 / n_b), 1e-12))
            z = (r_after - r_before) / se
            ok = bool(z >= 1.64 and (r_after - r_before) >= 0.03)
            a.lead_time_s = self._conventional_lead(a, sim)
            return ok, (f"fallout {r_after:.1%} after the alert against "
                        f"{r_before:.1%} before, z={z:.2f}")
        return False, "unknown alert kind"

    def _counter_lead(self, a: D.Alert, sim, window_s: int = 1800) -> Optional[float]:
        """How long before the end of line counter turned red.

        A conventional throughput dashboard notices a constraint only once
        rolling output falls below plan. That is the moment the alert is
        being compared against, not the moment the fault physically began.
        """
        takt = max(self.nominal.values())
        target = window_s / takt
        outs = sorted(t for (t, _u) in sim.completed)
        if not outs:
            return None
        for probe in range(int(a.t), sim.horizon_s, 120):
            n = sum(1 for t in outs if probe - window_s <= t <= probe)
            if probe - window_s < 0:
                continue
            if n < 0.92 * target:
                return float(probe - a.t)
        return None

    def _conventional_lead(self, a: D.Alert, sim) -> Optional[float]:
        """How much earlier than the plant's own process the alert arrived.

        A quality engineer opens an investigation once a handful of end of
        line failures trace back to the same station. Take the third such
        failure as the conventional detection point.
        """
        traced = sorted(q["t"] for q in sim.quality
                        if q["result"] == "FAIL" and q["origin_station"] == a.sid)
        if len(traced) < 3:
            return None
        return max(0.0, traced[2] - a.t)

    # ------------------------------------------------------------------
    def _frame(self, t: int, cycles, buffers, fc, new_alerts) -> dict:
        drift_snap = self.drift.snapshot()
        ev_by_sid = {}
        for e in fc.events:
            ev_by_sid.setdefault(e.sid, e)
        rows_cyc, rows_cf, rows_st, rows_buf, rows_dr, rows_fc = [], [], [], [], [], []
        for s in self.stations:
            rows_cyc.append(round(cycles.get(s.sid, self.nominal[s.sid]), 1))
            rows_cf.append(round(self.last_conf.get(s.sid, 0.9), 2))
            rows_st.append(STATE_CODE.get(self.last_state.get(s.sid, "WORK"), 0))
            rows_buf.append(int(buffers.get(s.sid, 0)))
            d = drift_snap.get(s.sid)
            rows_dr.append(DRIFT_CODE.get(d["state"], 0) if d else 0)
            e = ev_by_sid.get(s.sid)
            rows_fc.append([1 if e.kind == STARVE else 2, round(e.at_s / 60, 1)]
                           if e else None)
        return {
            "t": t,
            "cyc": rows_cyc, "cf": rows_cf, "st": rows_st,
            "buf": rows_buf, "dr": rows_dr, "fc": rows_fc,
            "constraint": fc.constraint_sid,
            "constraint_cycle": fc.constraint_cycle_s,
            "deficit": fc.deficit_units,
            "rate_loss": fc.rate_loss_per_hr,
            "runway_min": round(fc.runway_s / 60.0, 1),
            "units_out": self.units_out,
            "new_alerts": [a.aid for a in new_alerts],
            "open_alerts": [a.aid for a in self.ledger.alerts
                            if a.outcome == "OPEN"][-6:],
            "ledger": {"precision": self.ledger.precision(),
                       "fired": len(self.ledger.alerts)},
        }
