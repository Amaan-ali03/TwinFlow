import { useEffect, useState } from "react";
import type { HistoryData } from "../../types";
import { loadHistory } from "../../dataLoader";

/**
 * The manager's dimension the rest of the dashboard does not have: more than
 * one shift. A floor supervisor needs to know which station is the constraint
 * right now; a plant manager needs to know which station has been the
 * constraint all week, because that is the one worth spending a maintenance
 * window on.
 */
export function HistoryPanel() {
  const [hist, setHist] = useState<HistoryData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadHistory(10)
      .then((h) => live && setHist(h))
      .catch((e) => live && setErr(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, []);

  if (err) {
    return (
      <div className="card">
        <h2>Across the week</h2>
        <div className="faint" style={{ fontSize: 12 }}>{err}</div>
      </div>
    );
  }
  if (!hist) {
    return (
      <div className="card">
        <h2>Across the week</h2>
        <div className="faint" style={{ fontSize: 12 }}>
          Running consecutive shifts…
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div className="card">
          <h2>
            Constraint station, last {hist.shifts} shifts{" "}
            <span className="faint" style={{ textTransform: "none", fontWeight: 400 }}>
              — the station that held the line back, shift by shift
            </span>
          </h2>
          <ShiftTable hist={hist} />
        </div>
        <div className="card">
          <h2>
            Recurring constraints{" "}
            <span className="faint" style={{ textTransform: "none", fontWeight: 400 }}>
              — where a maintenance window would pay back
            </span>
          </h2>
          <RecurringBars hist={hist} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>
          Alert trust over the week{" "}
          <span className="faint" style={{ textTransform: "none", fontWeight: 400 }}>
            — measured precision per type, and the firing threshold the ledger
            moved in response
          </span>
        </h2>
        <TrustTrend hist={hist} />
      </div>
    </>
  );
}

/* ---------- shift by shift ---------- */
function ShiftTable({ hist }: { hist: HistoryData }) {
  const names = new Map(hist.recurring_constraints.map((c) => [c.sid, c.name]));
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="ledgertable">
        <thead>
          <tr>
            <th>Shift</th>
            <th>Constraint</th>
            <th>Share</th>
            <th>Bodies</th>
            <th>Fallout</th>
            <th>Alerts</th>
          </tr>
        </thead>
        <tbody>
          {hist.per_shift.map((s) => (
            <tr key={s.shift}>
              <td className="mono">{s.shift}</td>
              <td className="mono">
                {s.constraint_sid ?? "—"}{" "}
                <span className="faint">
                  {names.get(s.constraint_sid ?? "") ?? ""}
                </span>
              </td>
              <td className="mono">
                {s.constraint_share != null
                  ? `${(s.constraint_share * 100).toFixed(0)}%`
                  : "—"}
              </td>
              <td className="mono">{s.bodies_out}</td>
              <td className="mono">{s.fallout_pct.toFixed(2)}%</td>
              <td className="mono">{s.alerts_fired}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- recurring constraints ---------- */
function RecurringBars({ hist }: { hist: HistoryData }) {
  const rows = hist.recurring_constraints.slice(0, 8);
  const max = Math.max(...rows.map((r) => r.shifts), 1);
  const top = rows[0];
  return (
    <>
      {rows.map((r) => (
        <div key={r.sid} className="barrow">
          <div className="barrow-label mono">{r.sid}</div>
          <div className="barrow-track">
            <div
              className="barrow-fill"
              style={{ width: `${(r.shifts / max) * 100}%` }}
            />
          </div>
          <div className="barrow-val mono">{r.shifts}</div>
        </div>
      ))}
      {top && (
        <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
          {top.sid} {top.name} was the binding constraint in {top.shifts} of{" "}
          {hist.shifts} shifts. A station that recurs is a capacity decision;
          one that appears once is a bad day.
        </div>
      )}
    </>
  );
}

/* ---------- precision + threshold trend ---------- */
const KINDS: [string, string, string][] = [
  ["BOTTLENECK", "Bottleneck", "var(--andon-green)"],
  ["DEFECT_RISK", "Defect drift", "var(--andon-red)"],
  ["DARK_STATION", "Dark station", "var(--andon-amber)"],
];

function TrustTrend({ hist }: { hist: HistoryData }) {
  const w = 760;
  const h = 210;
  const pad = 38;
  const n = hist.shifts;
  const plotW = w - pad - 16;
  const plotH = h - pad - 16;
  const xAt = (i: number) => pad + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yAt = (v: number) => 16 + (1 - v) * plotH;

  const floors = hist.trend["DEFECT_RISK_fire_floor"] ?? [];

  return (
    <>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line
              x1={pad}
              y1={yAt(g)}
              x2={w - 16}
              y2={yAt(g)}
              stroke="var(--line-soft)"
              strokeWidth={1}
            />
            <text
              x={pad - 6}
              y={yAt(g) + 3}
              fontSize={9}
              fill="var(--ink-faint)"
              fontFamily="IBM Plex Mono"
              textAnchor="end"
            >
              {(g * 100).toFixed(0)}%
            </text>
          </g>
        ))}

        {KINDS.map(([kind, , colour]) => {
          const series = hist.trend[`${kind}_lifetime_precision`] ?? [];
          const pts = series
            .map((v, i) => (v == null ? null : { x: xAt(i), y: yAt(v) }))
            .filter((p): p is { x: number; y: number } => p !== null);
          if (pts.length === 0) return null;
          const d =
            "M " + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
          return (
            <g key={kind}>
              <path d={d} fill="none" stroke={colour} strokeWidth={2} />
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={colour} />
              ))}
            </g>
          );
        })}

        {hist.per_shift.map((s, i) => (
          <text
            key={s.shift}
            x={xAt(i)}
            y={h - 8}
            fontSize={9}
            fill="var(--ink-faint)"
            fontFamily="IBM Plex Mono"
            textAnchor="middle"
          >
            {s.shift}
          </text>
        ))}
      </svg>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 6 }}>
        {KINDS.map(([kind, label, colour]) => (
          <span key={kind} className="mono" style={{ fontSize: 11 }}>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                background: colour,
                marginRight: 6,
                verticalAlign: "middle",
              }}
            />
            {label}
          </span>
        ))}
      </div>

      <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>
        Cumulative precision, graded against the plant's own downtime log and
        quality dispositions. The ledger raises a type's firing threshold when
        its precision sits below the floor: the defect-drift threshold{" "}
        {floors.length === 0
          ? "has no graded data yet"
          : floors[0] === floors[floors.length - 1]
          ? `held at ${floors[0]}`
          : `moved from ${floors[0]} to ${floors[floors.length - 1]}`}{" "}
        across these {hist.shifts} shifts. That loop cannot run inside a single
        shift — defect-drift fires about 2.5 times a shift and the retune needs
        five graded alerts before it will move anything.
      </div>
    </>
  );
}
