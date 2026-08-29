import { useState, useRef, useCallback, useEffect } from "react";
import type { TwinData } from "../../types";
import { fmtT, fmtClock, STATE_NAME, DRIFT_NAME, STATE_CLASS, DRIFT_CLASS, TIER_LABEL } from "../../utils";

export function FloorView({ twin }: { twin: TwinData }) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedSid, setSelectedSid] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const scrubRef = useRef<HTMLInputElement>(null);

  const togglePlay = useCallback(() => {
    setPlaying((p) => !p);
  }, []);

  useEffect(() => {
    if (!playing) return;
    timerRef.current = window.setInterval(() => {
      setIdx((prev) => {
        const next = (prev + 1) % twin.frames.length;
        if (scrubRef.current) scrubRef.current.value = String(next);
        if (next === twin.frames.length - 1) {
          setPlaying(false);
        }
        return next;
      });
    }, 140);
    return () => {
      clearInterval(timerRef.current!);
    };
  }, [playing, twin.frames.length]);

  const jumpToAlert = useCallback(() => {
    if (!twin.alerts.length) return;
    const t0 = twin.alerts[0].t;
    const found = twin.frames.findIndex((f) => f.t >= t0);
    const newIdx = Math.max(0, found);
    setIdx(newIdx);
    if (scrubRef.current) scrubRef.current.value = String(newIdx);
  }, [twin]);

  const onScrub = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setIdx(+e.target.value);
    },
    []
  );

  const f = twin.frames[idx];

  return (
    <div className="view-enter">
      {/* Scrubber */}
      <div className="scrubber card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <button className="playbtn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "⏸" : "▶"}
          </button>
          <input
            ref={scrubRef}
            type="range"
            min={0}
            max={twin.frames.length - 1}
            defaultValue={0}
            onChange={onScrub}
            style={{ flex: 1, minWidth: 220 }}
          />
          <div className="mono clock">{fmtClock(f.t)} · t+{fmtT(f.t)}</div>
          <button className="jumpbtn" onClick={jumpToAlert}>
            Jump to first alert
          </button>
        </div>
      </div>

      {/* KPI tiles */}
      <KpiTiles twin={twin} f={f} />

      {/* Line map */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>
          Line — 42 stations, body → paint → final assembly
          <span className="legend">
            <span className="dot" style={{ background: "var(--panel-2)", border: "1px solid var(--line)" }} /> work
            <span className="dot" style={{ background: "var(--andon-amber)" }} /> starved
            <span className="dot" style={{ background: "var(--andon-red)" }} /> blocked
            <span className="dot ring" style={{ borderColor: "var(--andon-amber)" }} /> drifting
          </span>
        </h2>
        <LineMap twin={twin} f={f} selectedSid={selectedSid} onSelect={setSelectedSid} />
        <StationDetail twin={twin} idx={idx} selectedSid={selectedSid} />
      </div>

      {/* Alert feed */}
      <div className="card">
        <h2>
          Live alert feed
          <span className="dim mono" style={{ fontWeight: 400 }}>
            {(() => {
              const visible = twin.alerts.filter((a) => a.t <= f.t);
              return visible.length ? `${visible.length} shown` : "";
            })()}
          </span>
        </h2>
        <AlertFeed twin={twin} nowT={f.t} />
      </div>
    </div>
  );
}

/* ---------- KPI tiles ---------- */
function KpiTiles({ twin, f }: { twin: TwinData; f: TwinData["frames"][number] }) {
  const cSid = f.constraint;
  const cStation = twin.line.find((s) => s.sid === cSid);
  const rl = f.rate_loss || 0;

  return (
    <div className="grid g4" style={{ marginBottom: 16 }}>
      <div className="card kpi">
        <h2>Constraint station</h2>
        <div className="kpi-val mono">
          {cSid ? `${cSid} · ${f.constraint_cycle.toFixed(0)}s` : "—"}
        </div>
        <div className="kpi-sub">
          {cStation
            ? `${cStation.name} (standard ${(cStation.mix_cycle_s ?? cStation.nominal_cycle_s).toFixed(0)}s)`
            : ""}
        </div>
      </div>
      <div className="card kpi">
        <h2>Sustained rate loss</h2>
        <div
          className="kpi-val mono"
          style={{
            color: rl > 3 ? "var(--andon-red)" : rl > 0.5 ? "var(--andon-amber)" : "var(--andon-green)",
          }}
        >
          {(rl > 0 ? "+" : "") + rl.toFixed(1)}
        </div>
        <div className="kpi-sub">bodies / hour, vs takt</div>
      </div>
      <div className="card kpi">
        <h2>Runway before it's visible</h2>
        <div className="kpi-val mono">
          {f.runway_min ? `${f.runway_min.toFixed(0)} min` : "—"}
        </div>
        <div className="kpi-sub">until end-of-line counter falls</div>
      </div>
      <div className="card kpi">
        <h2>Bodies out this shift</h2>
        <div className="kpi-val mono">{f.units_out}</div>
        <div className="kpi-sub">
          plan pace ≈ {(f.t / twin.meta.horizon_s * twin.meta.n_completed).toFixed(0)}
        </div>
      </div>
    </div>
  );
}

/* ---------- Line map ---------- */
function LineMap({
  twin,
  f,
  selectedSid,
  onSelect,
}: {
  twin: TwinData;
  f: TwinData["frames"][number];
  selectedSid: string | null;
  onSelect: (sid: string | null) => void;
}) {
  const zones = ["BODY", "PAINT", "FINAL"];
  return (
    <div className="linemap">
      {zones.map((z) => {
        const stations = twin.line.filter((s) => s.zone === z);
        return (
          <div key={z}>
            <div className="zone-label">{z}</div>
            <div className="zone-row">
              {stations.map((s) => {
                const i = s.index;
                const stateCls = STATE_CLASS[f.st[i]] || "";
                const driftCls = DRIFT_CLASS[f.dr[i]] || "";
                const selCls = s.sid === selectedSid ? "selected" : "";
                return (
                  <div
                    key={s.sid}
                    className={`stbox tier-${s.tier} ${stateCls} ${driftCls} ${selCls}`}
                    title={`${s.sid} ${s.name} — ${STATE_NAME[f.st[i]]}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(s.sid === selectedSid ? null : s.sid)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(s.sid === selectedSid ? null : s.sid);
                      }
                    }}
                  >
                    <div className="stbox-id">{s.sid}</div>
                    {s.tier === "C" && <div className="stbox-tag">DARK</div>}
                    <div className="stbox-cyc mono">
                      {f.cyc[i].toFixed(0)}s
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Station detail ---------- */
function StationDetail({
  twin,
  idx,
  selectedSid,
}: {
  twin: TwinData;
  idx: number;
  selectedSid: string | null;
}) {
  if (!selectedSid) {
    return (
      <div className="station-detail faint" style={{ padding: "10px 2px" }}>
        Click a station to inspect its current reading.
      </div>
    );
  }
  const f = twin.frames[idx];
  const i = twin.line.findIndex((s) => s.sid === selectedSid);
  if (i < 0) return null;
  const s = twin.line[i];
  const fc = f.fc[i];

  return (
    <div className="station-detail">
      <div className="detail-grid">
        <div>
          <div className="faint dlabel">Station</div>
          <div className="mono">{s.sid} — {s.name}</div>
        </div>
        <div>
          <div className="faint dlabel">Sensor tier</div>
          <div>{s.tier} · {TIER_LABEL[s.tier]}</div>
        </div>
        <div>
          <div className="faint dlabel">Work content</div>
          <div className="mono">
            {f.cyc[i].toFixed(1)} s <span className="faint">(standard {(s.mix_cycle_s ?? s.nominal_cycle_s).toFixed(0)}s)</span>
          </div>
        </div>
        <div>
          <div className="faint dlabel">Estimate confidence</div>
          <div className="mono">{(f.cf[i] * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className="faint dlabel">State</div>
          <div>{STATE_NAME[f.st[i]]}</div>
        </div>
        <div>
          <div className="faint dlabel">Out buffer</div>
          <div className="mono">{f.buf[i]} / {s.out_buffer_cap}</div>
        </div>
        <div>
          <div className="faint dlabel">Drift status</div>
          <div>{DRIFT_NAME[f.dr[i]]}</div>
        </div>
        <div>
          <div className="faint dlabel">Forecast</div>
          <div>
            {fc
              ? `${fc[0] === 1 ? "runs dry" : "backs up"} in ${fc[1].toFixed(0)} min`
              : "no event in 30 min horizon"}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Alert feed ---------- */
function AlertFeed({ twin, nowT }: { twin: TwinData; nowT: number }) {
  const visible = twin.alerts
    .filter((a) => a.t <= nowT)
    .sort((a, b) => b.last_update_t - a.last_update_t || b.t - a.t);

  if (!visible.length) {
    return (
      <div className="faint" style={{ padding: "16px 2px" }}>
        No conditions yet. The line is inside a normal warm-up window.
      </div>
    );
  }

  return (
    <>
      {visible.map((a) => {
        const tierCls =
          a.tier === "ACT NOW"
            ? "act"
            : a.tier === "ADVISE"
            ? "advise"
            : "monitor";

        let outcome: React.ReactNode;
        if (a.outcome === "OPEN") {
          outcome = <span className="outbadge ob-open">OPEN</span>;
        } else if (a.outcome === "PENDING") {
          outcome = <span className="outbadge ob-pending">PENDING</span>;
        } else if (a.outcome === "TRUE") {
          outcome = (
            <span className="outbadge ob-true">
              CONFIRMED · lead{" "}
              {a.lead_time_s ? `${(a.lead_time_s / 60).toFixed(0)}m` : "—"}
            </span>
          );
        } else {
          outcome = <span className="outbadge ob-false">FALSE ALARM</span>;
        }

        return (
          <div key={a.aid} className={`alertcard tier-border-${tierCls}`}>
            <div className="alertcard-top">
              <span className={`tierbadge tb-${tierCls}`}>{a.tier}</span>
              <span className="mono faint">{fmtT(a.t)}</span>
              <span className="mono faint">risk {a.risk}</span>
              {a.updates > 0 && (
                <span className="faint">
                  · updated {a.updates}×, last {fmtT(a.last_update_t)}
                </span>
              )}
              <span style={{ flex: 1 }} />
              {nowT >= a.verify_by
                ? outcome
                : <span className="outbadge ob-open">verifies {fmtT(a.verify_by)}</span>}
            </div>
            <div className="alertcard-head">{a.headline}</div>
            <div className="alertcard-action">
              <b>Action —</b> {a.action}
            </div>
            <div className="alertcard-meta faint">
              {a.owner} · {a.expected_impact}
            </div>
            <details className="alertcard-ev">
              <summary>Evidence ({a.evidence.length})</summary>
              <ul>
                {a.evidence.map((e, j) => (
                  <li key={j}>{e}</li>
                ))}
              </ul>
              <div className="faint" style={{ marginTop: 6 }}>
                <b>Falsifier —</b> {a.falsifier}
              </div>
            </details>
            {a.kind === "DEFECT_RISK" && a.at_risk_ranked.length > 0 && (
              <details className="alertcard-ev">
                <summary>
                  Containment, ranked by likely contributor ({a.at_risk_ranked.length} bodies)
                </summary>
                <ul>
                  {a.at_risk_ranked.slice(0, 12).map((b) => (
                    <li key={b.uid} className="mono">
                      #{b.uid} —{" "}
                      {b.risk === null ? (
                        <span className="faint">no process data here</span>
                      ) : (
                        `${(b.risk * 100).toFixed(1)}%`
                      )}{" "}
                      <span className="faint">
                        · {b.status === "on_line" ? "still on line" : "already rolled out"}
                      </span>
                    </li>
                  ))}
                </ul>
                {a.at_risk_ranked.length > 12 && (
                  <div className="faint">
                    +{a.at_risk_ranked.length - 12} more, lower ranked
                  </div>
                )}
                <div className="faint" style={{ marginTop: 6 }}>
                  Likely contributors, not root cause — inspect highest ranked first.
                </div>
              </details>
            )}
          </div>
        );
      })}
    </>
  );
}
