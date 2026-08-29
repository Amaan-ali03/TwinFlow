import { Fragment } from "react";
import type { HistoryData } from "../../../types";

/* ---------- constraint station, shift by shift ---------- */
export function ConstraintLedger({ hist }: { hist: HistoryData }) {
  const names = new Map(hist.recurring_constraints.map((c) => [c.sid, c.name]));
  return (
    <div className="table-scroll">
      <table className="datatable">
        <thead>
          <tr>
            <th>Shift</th>
            <th>Constraint</th>
            <th className="num">Share</th>
            <th className="num">Bodies</th>
            <th className="num">Fallout</th>
            <th className="num">Alerts</th>
          </tr>
        </thead>
        <tbody>
          {hist.per_shift.map((s) => (
            <tr key={s.shift}>
              <td className="mono">{s.shift}</td>
              <td className="mono">
                {s.constraint_sid ?? "—"}{" "}
                <span className="faint">{names.get(s.constraint_sid ?? "") ?? ""}</span>
              </td>
              <td className="num mono">
                {s.constraint_share != null
                  ? `${(s.constraint_share * 100).toFixed(0)}%`
                  : "—"}
              </td>
              <td className="num mono">{s.bodies_out}</td>
              <td className="num mono">{s.fallout_pct.toFixed(2)}%</td>
              <td className="num mono">{s.alerts_fired}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- recurring constraints ---------- */
export function RecurringBars({ hist }: { hist: HistoryData }) {
  const rows = hist.recurring_constraints.slice(0, 8);
  const max = Math.max(...rows.map((r) => r.shifts), 1);
  const top = rows[0];
  return (
    <>
      <table className="datatable">
        <thead>
          <tr>
            <th>Station</th>
            <th>Shifts as constraint</th>
            <th className="num">n</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sid}>
              <td className="mono">
                {r.sid} <span className="faint">{r.name}</span>
              </td>
              <td>
                <span className="minibar">
                  <span className="minibar-track">
                    <span
                      className="minibar-fill warn"
                      style={{ width: `${(r.shifts / max) * 100}%` }}
                    />
                  </span>
                </span>
              </td>
              <td className="num mono">{r.shifts}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {top && (
        <p className="faint chart-note">
          {top.sid} {top.name} bound the line in {top.shifts} of {hist.shifts}{" "}
          shifts. A station that recurs is a capacity decision; one that appears
          once is a bad day.
        </p>
      )}
    </>
  );
}

/* ---------- alert trust over the week ---------- */
const KINDS: [string, string, string][] = [
  ["BOTTLENECK", "Bottleneck", "var(--andon-green)"],
  ["DEFECT_RISK", "Defect drift", "var(--andon-red)"],
  ["DARK_STATION", "Dark station", "var(--andon-amber)"],
];

export function TrustTrend({ hist }: { hist: HistoryData }) {
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
        {[0, 0.5, 1].map((g) => (
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
          const d = "M " + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
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

      <div className="legend-row">
        {KINDS.map(([kind, label, colour]) => (
          <span key={kind} className="mono legend-item">
            <span className="legend-swatch" style={{ background: colour }} />
            {label}
          </span>
        ))}
      </div>

      <p className="faint chart-note">
        Cumulative precision, graded against the plant's own downtime log and
        quality dispositions. The ledger raises a type's firing threshold when its
        precision sits below the floor: the defect-drift threshold{" "}
        {floors.length === 0
          ? "has no graded data yet"
          : floors[0] === floors[floors.length - 1]
          ? `held at ${floors[0]}`
          : `moved from ${floors[0]} to ${floors[floors.length - 1]}`}{" "}
        across these {hist.shifts} shifts. That loop cannot run inside a single
        shift — defect-drift fires about 2.5 times a shift and the retune needs
        five graded alerts before it moves anything.
      </p>
    </>
  );
}
