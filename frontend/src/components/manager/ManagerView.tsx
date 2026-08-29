import { useState, useCallback } from "react";
import type { TwinData, WhatIfResult } from "../../types";
import { fmtClock } from "../../utils";
import { runWhatIf } from "../../dataLoader";
import { HistoryPanel } from "./HistoryPanel";

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

export function ManagerView({ twin }: { twin: TwinData }) {
  const L = twin.ledger;
  return (
    <div className="view-enter">
      {/* KPI row */}
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="card kpi">
          <h2>Bodies completed</h2>
          <div className="kpi-val mono">{twin.meta.n_completed}</div>
          <div className="kpi-sub">of an 8 hour shift</div>
        </div>
        <div className="card kpi">
          <h2>Quality fallout</h2>
          <div className="kpi-val mono">{twin.meta.n_fails}</div>
          <div className="kpi-sub">
            of {twin.meta.n_quality_checks} inspections (
            {twin.meta.n_quality_checks > 0
              ? `${(100 * twin.meta.n_fails / twin.meta.n_quality_checks).toFixed(1)}%`
              : "—"})
          </div>
        </div>
        <div className="card kpi">
          <h2>Alert precision</h2>
          <div className="kpi-val mono">
            {L.precision_all != null ? `${(L.precision_all * 100).toFixed(0)}%` : "—"}
          </div>
          <div className="kpi-sub">{L.total} alerts fired, graded against outcomes</div>
        </div>
        <div className="card kpi">
          <h2>Sensor coverage</h2>
          <div className="kpi-val mono">
            {twin.meta.tiers.A}/{twin.meta.tiers.B}/{twin.meta.tiers.C}
          </div>
          <div className="kpi-sub">full / cycle-only / dark stations</div>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div className="card">
          <h2>Throughput — bodies rolled out, 10 min buckets</h2>
          <ThroughputChart twin={twin} />
        </div>
        <div className="card">
          <h2>
            Quality fallout by origin station{" "}
            <span className="faint" style={{ textTransform: "none", fontWeight: 400 }}>
              — traced by genealogy backtrace, not by where it was caught
            </span>
          </h2>
          <OriginChart twin={twin} />
        </div>
      </div>

      {/* Ledger + timeline */}
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div className="card">
          <h2>Alert ledger by type</h2>
          <LedgerTable twin={twin} />
        </div>
        <div className="card">
          <h2>
            Shift fault timeline{" "}
            <span className="faint" style={{ textTransform: "none", fontWeight: 400 }}>
              — what actually happened vs. when the twin flagged it
            </span>
          </h2>
          <FaultTimeline twin={twin} />
        </div>
      </div>

      {/* Cross-shift trends — the planning horizon a single shift cannot show */}
      <HistoryPanel />

      {/* What-if planning */}
      <div style={{ marginBottom: 16 }}>
        <WhatIfPanel twin={twin} />
      </div>

      {/* Zone mix */}
      <div className="card">
        <h2>Sensor tier mix by zone</h2>
        <ZoneMix twin={twin} />
      </div>
    </div>
  );
}

/* ---------- What-if planning ---------- */
function WhatIfPanel({ twin }: { twin: TwinData }) {
  const [sid, setSid] = useState(twin.line[0]?.sid ?? "");
  const [delta, setDelta] = useState(5);
  const [frameIdx, setFrameIdx] = useState(twin.frames.length - 1);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const t = twin.frames[frameIdx]?.t ?? 0;
      const r = await runWhatIf(t, { [sid]: delta });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sid, delta, frameIdx, twin.frames]);

  const b = result?.baseline;
  const w = result?.what_if;

  return (
    <div className="card">
      <h2>
        What if — planning simulator{" "}
        <span className="faint" style={{ textTransform: "none", fontWeight: 400 }}>
          — perturb one station's cycle time, compare the 30 min forecast
        </span>
      </h2>
      <div
        style={{
          display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end",
          marginBottom: 14,
        }}
      >
        <label className="faint dlabel" style={{ display: "block" }}>
          Station
          <select
            value={sid}
            onChange={(e) => setSid(e.target.value)}
            style={{ display: "block", marginTop: 4 }}
          >
            {twin.line.map((s) => (
              <option key={s.sid} value={s.sid}>
                {s.sid} — {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="faint dlabel" style={{ display: "block" }}>
          Δ seconds
          <input
            type="number"
            value={delta}
            step={1}
            onChange={(e) => setDelta(Number(e.target.value))}
            style={{ display: "block", marginTop: 4, width: 80 }}
          />
        </label>
        <label className="faint dlabel" style={{ display: "block", flex: 1, minWidth: 220 }}>
          Snapshot — {fmtClock(twin.frames[frameIdx]?.t ?? 0)}
          <input
            type="range"
            min={0}
            max={Math.max(0, twin.frames.length - 1)}
            value={frameIdx}
            onChange={(e) => setFrameIdx(Number(e.target.value))}
            style={{ display: "block", marginTop: 8, width: "100%" }}
          />
        </label>
        <button className="jumpbtn" onClick={run} disabled={loading}>
          {loading ? "Running…" : "Run what-if"}
        </button>
      </div>
      {error && (
        <div className="faint" style={{ color: "var(--andon-red)", marginBottom: 10 }}>
          {error}
        </div>
      )}
      {b && w ? (
        <div className="grid g4">
          <WhatIfTile label="Constraint station" base={b.constraint_sid} next={w.constraint_sid} />
          <WhatIfTile
            label="Constraint cycle (s)"
            base={b.constraint_cycle_s}
            next={w.constraint_cycle_s}
          />
          <WhatIfTile
            label="Rate loss (bodies/hr)"
            base={b.rate_loss_per_hr}
            next={w.rate_loss_per_hr}
          />
          <WhatIfTile label="Runway (min)" base={b.runway_min} next={w.runway_min} />
        </div>
      ) : (
        <div className="faint">Pick a station, a Δ, and a snapshot, then run it.</div>
      )}
    </div>
  );
}

function WhatIfTile({
  label,
  base,
  next,
}: {
  label: string;
  base: string | number;
  next: string | number;
}) {
  const changed = base !== next;
  return (
    <div className="card kpi">
      <h2>{label}</h2>
      <div className="kpi-val mono" style={{ color: changed ? "var(--andon-amber)" : undefined }}>
        {next}
      </div>
      <div className="kpi-sub">{changed ? `was ${base}` : "unchanged"}</div>
    </div>
  );
}

/* ---------- Throughput chart ---------- */
function ThroughputChart({ twin }: { twin: TwinData }) {
  const data = twin.throughput_series;
  const w = 760;
  const h = 190;
  const pad = 34;

  if (data.length === 0) {
    return (
      <div className="faint" style={{ padding: "16px 2px" }}>
        No throughput data for this shift.
      </div>
    );
  }

  const maxY = Math.max(...data.map((d) => d[1]), 1) * 1.15;
  const xw = (w - pad * 1.2 - 14) / (data.length - 1);

  const pts = data.map((d, i) => ({
    x: pad + i * xw,
    y: h - pad - (d[1] / maxY) * (h - pad - 14),
  }));

  const linePath =
    "M " + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
  const areaPath =
    linePath +
    ` L ${pts[pts.length - 1].x.toFixed(1)} ${h - pad} L ${pts[0].x.toFixed(1)} ${h - pad} Z`;

  const plotW = w - pad * 1.2 - 14;

  return (
    <SvgChart w={w} h={h}>
      {twin.fault_windows
        .filter((f) => !f.label.includes("Transient"))
        .map((f) => {
          const x1 = pad + (f.start_s / twin.meta.horizon_s) * plotW;
          const x2 = pad + (f.end_s / twin.meta.horizon_s) * plotW;
          return (
            <rect
              key={`${f.station}-${f.start_s}`}
              x={x1}
              y={14}
              width={Math.max(1, x2 - x1)}
              height={h - pad - 14}
              fill="var(--andon-amber)"
              opacity={0.06}
            />
          );
        })}

      {Array.from({ length: 5 }, (_, i) => {
        const gy = 14 + (i * (h - pad - 14)) / 4;
        return (
          <line key={i} x1={pad} y1={gy} x2={w - 14} y2={gy} stroke="var(--line-soft)" strokeWidth={1} />
        );
      })}

      <path d={areaPath} fill="var(--andon-amber)" opacity={0.12} />
      <path d={linePath} fill="none" stroke="var(--andon-amber)" strokeWidth={2} />

      {[0, 0.25, 0.5, 0.75, 1].map((fr) => {
        const t = fr * twin.meta.horizon_s;
        const x = pad + fr * plotW;
        return (
          <text key={fr} x={x} y={h - 8} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono" textAnchor="middle">
            {fmtClock(t)}
          </text>
        );
      })}

      <text x={pad} y={10} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono">
        bodies / 10min
      </text>
    </SvgChart>
  );
}

/* ---------- Origin chart ---------- */
function OriginChart({ twin }: { twin: TwinData }) {
  const entries = Object.entries(twin.quality_origin_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (entries.length === 0) {
    return (
      <div className="faint" style={{ padding: "16px 2px" }}>
        No quality fallout this shift.
      </div>
    );
  }

  const max = Math.max(...entries.map((e) => e[1]), 1);

  return (
    <>
      {entries.map(([sid, n]) => {
        const pct = (n / max) * 100;
        return (
          <div key={sid} className="barrow">
            <div className="barrow-label mono">{sid}</div>
            <div className="barrow-track">
              <div className="barrow-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="barrow-val mono">{n}</div>
          </div>
        );
      })}
      <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
        {entries.length > 0 && twin.meta.n_fails > 0
          ? `Top origin accounts for ${((entries[0][1] / twin.meta.n_fails) * 100).toFixed(0)}% of all shift fallout — a single tool, not a random spread.`
          : "No quality fallout to attribute."}
      </div>
    </>
  );
}

/* ---------- Ledger table ---------- */
function LedgerTable({ twin }: { twin: TwinData }) {
  const L = twin.ledger;
  const kinds: [string, string][] = [
    ["BOTTLENECK", "Bottleneck propagation"],
    ["DEFECT_RISK", "Defect drift"],
    ["DARK_STATION", "Dark station inference"],
  ];

  return (
    <table className="ledgertable">
      <thead>
        <tr>
          <th>Alert type</th>
          <th>Fired</th>
          <th>Confirmed</th>
          <th>False</th>
          <th>Precision</th>
          <th>Median lead</th>
        </tr>
      </thead>
      <tbody>
        {kinds.map(([k, label]) => {
          const d = L[k];
          if (!d || typeof d !== "object" || !("fired" in d)) return null;
          const entry = d as { fired: number; true: number; false: number; precision: number | null; mean_lead_s: number | null };
          const prec = entry.precision != null ? `${(entry.precision * 100).toFixed(0)}%` : "—";
          return (
            <tr key={k}>
              <td>{label}</td>
              <td className="mono">{entry.fired}</td>
              <td className="mono">{entry.true}</td>
              <td className="mono">{entry.false}</td>
              <td className="mono">{prec}</td>
              <td className="mono">
                {entry.mean_lead_s ? `${(entry.mean_lead_s / 60).toFixed(0)} min` : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---------- Fault timeline ---------- */
function FaultTimeline({ twin }: { twin: TwinData }) {
  const w = 560;
  const h = 150;
  const pad = 8;
  const faults = twin.fault_windows;

  if (faults.length === 0) {
    return (
      <div className="faint" style={{ padding: "16px 2px" }}>
        No fault windows this shift.
      </div>
    );
  }

  const rowH = (h - pad * 2) / faults.length;
  const plotW = w - 140;

  return (
    <>
      <SvgChart w={w} h={h}>
        {faults.map((f, i) => {
          const y = pad + i * rowH + 6;
          const x1 = (f.start_s / twin.meta.horizon_s) * plotW + 130;
          const x2 = (f.end_s / twin.meta.horizon_s) * plotW + 130;
          const alert = twin.alerts.find(
            (a) => a.sid === f.station && a.t >= f.start_s && a.t <= f.end_s + 2000
          );
          const isTransient = f.label.includes("Transient");
          const color = isTransient
            ? "var(--ink-faint)"
            : alert
            ? "var(--andon-green)"
            : "var(--andon-red)";
          const barH = rowH * 0.5;
          const textY = y + rowH * 0.42;
          return (
            <g key={`${f.station}-${f.start_s}`}>
              <text x={4} y={textY} fontSize={10} fill="var(--ink-dim)" fontFamily="IBM Plex Mono">
                {f.station}
              </text>
              <rect x={x1} y={y} width={Math.max(2, x2 - x1)} height={barH} rx={3} fill={color} opacity={0.35} />
              {alert && (
                <line
                  x1={(alert.t / twin.meta.horizon_s) * plotW + 130}
                  y1={y}
                  x2={(alert.t / twin.meta.horizon_s) * plotW + 130}
                  y2={y + barH}
                  stroke="var(--andon-amber)"
                  strokeWidth={2}
                />
              )}
            </g>
          );
        })}
      </SvgChart>
      <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
        amber tick = twin's first alert on that condition. Grey bar = deliberate
        transient the twin correctly ignored.
      </div>
    </>
  );
}

/* ---------- Zone mix ---------- */
function ZoneMix({ twin }: { twin: TwinData }) {
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
