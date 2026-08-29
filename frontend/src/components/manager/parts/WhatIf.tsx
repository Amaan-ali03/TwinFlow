import { useCallback, useState } from "react";
import type { TwinData, WhatIfResult } from "../../../types";
import { fmtClock } from "../../../utils";
import { runWhatIf } from "../../../dataLoader";

export function WhatIfPanel({ twin }: { twin: TwinData }) {
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
      setResult(await runWhatIf(t, { [sid]: delta }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sid, delta, frameIdx, twin.frames]);

  const b = result?.baseline;
  const w = result?.what_if;

  return (
    <>
      <div className="whatif-controls">
        <label>
          <span>Station</span>
          <select value={sid} onChange={(e) => setSid(e.target.value)}>
            {twin.line.map((s) => (
              <option key={s.sid} value={s.sid}>
                {s.sid} — {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Δ seconds</span>
          <input
            type="number"
            value={delta}
            step={1}
            onChange={(e) => setDelta(Number(e.target.value))}
          />
        </label>
        <label className="whatif-snap">
          <span>Snapshot — {fmtClock(twin.frames[frameIdx]?.t ?? 0)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, twin.frames.length - 1)}
            value={frameIdx}
            onChange={(e) => setFrameIdx(Number(e.target.value))}
          />
        </label>
        <button className="jumpbtn" onClick={run} disabled={loading}>
          {loading ? "Running…" : "Run what-if"}
        </button>
      </div>

      {error && (
        <p className="faint" style={{ color: "var(--andon-red)" }}>
          {error}
        </p>
      )}

      {b && w ? (
        <div className="kpi-strip" style={{ marginTop: 4 }}>
          <WhatIfTile label="Constraint station" base={b.constraint_sid} next={w.constraint_sid} />
          <WhatIfTile label="Constraint cycle (s)" base={b.constraint_cycle_s} next={w.constraint_cycle_s} />
          <WhatIfTile label="Rate loss (bodies/hr)" base={b.rate_loss_per_hr} next={w.rate_loss_per_hr} />
          <WhatIfTile label="Runway (min)" base={b.runway_min} next={w.runway_min} />
        </div>
      ) : (
        <p className="faint">Pick a station, a Δ, and a snapshot, then run it.</p>
      )}
    </>
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
    <div className="kpi-tile">
      <div className="kpi-tile-label">{label}</div>
      <div
        className="kpi-tile-value mono"
        style={{ color: changed ? "var(--andon-amber)" : undefined, fontSize: 22 }}
      >
        {next}
      </div>
      <div className="kpi-tile-sub">{changed ? `was ${base}` : "unchanged"}</div>
    </div>
  );
}
