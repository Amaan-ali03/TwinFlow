import { useId } from "react";
import type { TwinData } from "../../../types";
import { fmtClock } from "../../../utils";

function SvgChart({
  w,
  h,
  children,
}: {
  w: number;
  h: number;
  children: React.ReactNode;
}) {
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
      {children}
    </svg>
  );
}

/* ---------- throughput ---------- */
export function ThroughputChart({ twin }: { twin: TwinData }) {
  const gradId = useId();
  const data = twin.throughput_series;
  const w = 760;
  const h = 200;
  const padL = 30;
  const padB = 22;
  const padT = 14;

  if (data.length === 0) {
    return <p className="faint chart-empty">No throughput data for this shift.</p>;
  }

  const maxY = Math.max(...data.map((d) => d[1]), 1) * 1.15;
  const plotW = w - padL - 14;
  const plotH = h - padT - padB;
  const xw = plotW / (data.length - 1);
  const pts = data.map((d, i) => ({
    x: padL + i * xw,
    y: padT + plotH - (d[1] / maxY) * plotH,
  }));

  const linePath = "M " + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
  const areaPath =
    linePath +
    ` L ${pts[pts.length - 1].x.toFixed(1)} ${padT + plotH} L ${pts[0].x.toFixed(1)} ${
      padT + plotH
    } Z`;

  // mean rate across the shift — anything meaningfully below it is a dip
  const mean = data.reduce((s, d) => s + d[1], 0) / data.length;

  return (
    <SvgChart w={w} h={h}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--cyan)" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--cyan)" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* fault windows — amber degraded-zone highlight */}
      {twin.fault_windows
        .filter((f) => !f.label.includes("Transient"))
        .map((f) => {
          const x1 = padL + (f.start_s / twin.meta.horizon_s) * plotW;
          const x2 = padL + (f.end_s / twin.meta.horizon_s) * plotW;
          return (
            <rect
              key={`${f.station}-${f.start_s}`}
              x={x1}
              y={padT}
              width={Math.max(1, x2 - x1)}
              height={plotH}
              fill="var(--andon-amber)"
              opacity={0.06}
            />
          );
        })}

      {/* minimal gridlines */}
      {[0, 0.5, 1].map((g) => {
        const gy = padT + g * plotH;
        return (
          <line
            key={g}
            x1={padL}
            y1={gy}
            x2={w - 14}
            y2={gy}
            stroke="var(--line-soft)"
            strokeWidth={1}
          />
        );
      })}

      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke="var(--cyan)" strokeWidth={2} />

      {/* mark dip buckets in amber */}
      {pts.map((p, i) =>
        data[i][1] < mean * 0.7 ? (
          <circle key={i} cx={p.x} cy={p.y} r={2.6} fill="var(--andon-amber)" />
        ) : null
      )}

      {[0, 0.25, 0.5, 0.75, 1].map((fr) => (
        <text
          key={fr}
          x={padL + fr * plotW}
          y={h - 6}
          fontSize={9}
          fill="var(--ink-faint)"
          fontFamily="IBM Plex Mono"
          textAnchor="middle"
        >
          {fmtClock(fr * twin.meta.horizon_s)}
        </text>
      ))}
      <text x={padL} y={10} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono">
        bodies / 10 min
      </text>
    </SvgChart>
  );
}

/* ---------- quality fallout by origin ---------- */
export function OriginChart({ twin }: { twin: TwinData }) {
  const entries = Object.entries(twin.quality_origin_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (entries.length === 0) {
    return <p className="faint chart-empty">No quality fallout this shift.</p>;
  }
  const max = Math.max(...entries.map((e) => e[1]), 1);

  return (
    <>
      <table className="datatable">
        <thead>
          <tr>
            <th>Origin</th>
            <th>Share of fallout</th>
            <th className="num">Units</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([sid, n], i) => (
            <tr key={sid}>
              <td className="mono">{sid}</td>
              <td>
                <span className="minibar">
                  <span className="minibar-track">
                    <span
                      className={`minibar-fill${i === 0 ? " crit" : i < 3 ? " warn" : ""}`}
                      style={{ width: `${(n / max) * 100}%` }}
                    />
                  </span>
                </span>
              </td>
              <td className="num mono">{n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {twin.meta.n_fails > 0 && (
        <p className="faint chart-note">
          Top origin accounts for{" "}
          {((entries[0][1] / twin.meta.n_fails) * 100).toFixed(0)}% of all shift
          fallout — a single tool, not a random spread.
        </p>
      )}
    </>
  );
}

/* ---------- fault timeline ---------- */
export function FaultTimeline({ twin }: { twin: TwinData }) {
  const w = 560;
  const faults = twin.fault_windows;
  if (faults.length === 0) {
    return <p className="faint chart-empty">No fault windows this shift.</p>;
  }
  const rowH = 22;
  const h = faults.length * rowH + 10;
  const labelW = 54;
  const plotW = w - labelW - 8;

  return (
    <>
      <SvgChart w={w} h={h}>
        {faults.map((f, i) => {
          const y = 6 + i * rowH;
          const x1 = labelW + (f.start_s / twin.meta.horizon_s) * plotW;
          const x2 = labelW + (f.end_s / twin.meta.horizon_s) * plotW;
          const alert = twin.alerts.find(
            (a) => a.sid === f.station && a.t >= f.start_s && a.t <= f.end_s + 2000
          );
          const isTransient = f.label.includes("Transient");
          const color = isTransient
            ? "var(--ink-faint)"
            : alert
            ? "var(--andon-green)"
            : "var(--andon-red)";
          return (
            <g key={`${f.station}-${f.start_s}`}>
              <text
                x={0}
                y={y + 11}
                fontSize={10}
                fill="var(--ink-dim)"
                fontFamily="IBM Plex Mono"
              >
                {f.station}
              </text>
              <rect
                x={x1}
                y={y}
                width={Math.max(2, x2 - x1)}
                height={12}
                rx={3}
                fill={color}
                opacity={0.4}
              />
              {alert && (
                <line
                  x1={labelW + (alert.t / twin.meta.horizon_s) * plotW}
                  y1={y - 2}
                  x2={labelW + (alert.t / twin.meta.horizon_s) * plotW}
                  y2={y + 14}
                  stroke="var(--andon-amber)"
                  strokeWidth={2}
                />
              )}
            </g>
          );
        })}
      </SvgChart>
      <p className="faint chart-note">
        Amber tick = twin's first alert on that condition. Grey bar = a deliberate
        transient it correctly ignored. Green = flagged, red = missed.
      </p>
    </>
  );
}

/* ---------- alert ledger by type ---------- */
export function LedgerTable({ twin }: { twin: TwinData }) {
  const L = twin.ledger;
  const kinds: [string, string][] = [
    ["BOTTLENECK", "Bottleneck propagation"],
    ["DEFECT_RISK", "Defect drift"],
    ["DARK_STATION", "Dark station inference"],
  ];

  return (
    <table className="datatable">
      <thead>
        <tr>
          <th>Alert type</th>
          <th className="num">Fired</th>
          <th className="num">Confirmed</th>
          <th className="num">False</th>
          <th className="num">Precision</th>
          <th className="num">Median lead</th>
        </tr>
      </thead>
      <tbody>
        {kinds.map(([k, label]) => {
          const d = L[k];
          if (!d || typeof d !== "object" || !("fired" in d)) return null;
          const e = d as {
            fired: number;
            true: number;
            false: number;
            precision: number | null;
            mean_lead_s: number | null;
          };
          return (
            <tr key={k}>
              <td>{label}</td>
              <td className="num mono">{e.fired}</td>
              <td className="num mono">{e.true}</td>
              <td className="num mono">{e.false}</td>
              <td className="num mono">
                {e.precision != null ? `${(e.precision * 100).toFixed(0)}%` : "—"}
              </td>
              <td className="num mono">
                {e.mean_lead_s ? `${(e.mean_lead_s / 60).toFixed(0)} min` : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---------- sensor tier mix by zone ---------- */
export function ZoneMix({ twin }: { twin: TwinData }) {
  const zones = ["BODY", "PAINT", "FINAL"];
  return (
    <div className="zonemix">
      {zones.map((z) => {
        const t = twin.zone_totals[z];
        const wa = (t.A / t.count) * 100;
        const wb = (t.B / t.count) * 100;
        const wc = (t.C / t.count) * 100;
        return (
          <div key={z} className="zonemix-row">
            <div className="zonemix-label">
              {z} <span className="faint mono">({t.count})</span>
            </div>
            <div className="zonemix-bar">
              <div style={{ width: `${wa}%`, background: "var(--tier-a)" }} title={`Tier A: ${t.A}`} />
              <div style={{ width: `${wb}%`, background: "var(--tier-b)" }} title={`Tier B: ${t.B}`} />
              <div style={{ width: `${wc}%`, background: "var(--tier-c)" }} title={`Tier C: ${t.C}`} />
            </div>
            <div className="zonemix-counts mono faint">
              A {t.A} · B {t.B} · C {t.C}
            </div>
          </div>
        );
      })}
    </div>
  );
}
