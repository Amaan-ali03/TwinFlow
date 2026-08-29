import type { Frame, TwinData } from "../../../types";
import {
  STATE_NAME,
  DRIFT_NAME,
  TIER_LABEL,
} from "../../../utils";

/** The per-station telemetry grid, shown on Live Line and Station Detail. */
export function StationReadout({
  twin,
  frame,
  sid,
}: {
  twin: TwinData;
  frame: Frame;
  sid: string;
}) {
  const i = twin.line.findIndex((s) => s.sid === sid);
  if (i < 0) return null;
  const s = twin.line[i];
  const fc = frame.fc[i];
  const standard = s.mix_cycle_s ?? s.nominal_cycle_s;

  return (
    <div className="detail-grid">
      <Field label="Station" value={`${s.sid} — ${s.name}`} mono />
      <Field label="Sensor tier" value={`${s.tier} · ${TIER_LABEL[s.tier]}`} />
      <Field
        label="Work content"
        value={
          <>
            <span className="mono">{frame.cyc[i].toFixed(1)} s</span>{" "}
            <span className="faint">(standard {standard.toFixed(0)}s)</span>
          </>
        }
      />
      <Field label="Estimate confidence" value={`${(frame.cf[i] * 100).toFixed(0)}%`} mono />
      <Field label="State" value={STATE_NAME[frame.st[i]]} />
      <Field label="Out buffer" value={`${frame.buf[i]} / ${s.out_buffer_cap}`} mono />
      <Field label="Drift status" value={DRIFT_NAME[frame.dr[i]]} />
      <Field
        label="Forecast"
        value={
          fc
            ? `${fc[0] === 1 ? "runs dry" : "backs up"} in ${fc[1].toFixed(0)} min`
            : "no event in 30 min horizon"
        }
      />
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="faint dlabel">{label}</div>
      <div className={mono ? "mono" : undefined}>{value}</div>
    </div>
  );
}
