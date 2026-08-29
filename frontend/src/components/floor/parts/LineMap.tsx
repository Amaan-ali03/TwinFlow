import type { Frame, TwinData } from "../../../types";
import { STATE_NAME, STATE_CLASS, DRIFT_CLASS } from "../../../utils";

const ZONES = ["BODY", "PAINT", "FINAL"] as const;

export function LineMapLegend() {
  return (
    <span className="legend">
      <span className="dot" style={{ background: "var(--panel-2)", border: "1px solid var(--line)" }} /> work
      <span className="dot" style={{ background: "var(--andon-amber)" }} /> starved
      <span className="dot" style={{ background: "var(--andon-red)" }} /> blocked
      <span className="dot ring" style={{ borderColor: "var(--andon-amber)" }} /> drifting
    </span>
  );
}

export function LineMap({
  twin,
  frame,
  selectedSid,
  onSelect,
}: {
  twin: TwinData;
  frame: Frame;
  selectedSid: string | null;
  onSelect: (sid: string | null) => void;
}) {
  return (
    <div className="linemap">
      {ZONES.map((z) => {
        const stations = twin.line.filter((s) => s.zone === z);
        return (
          <div key={z}>
            <div className="zone-label">{z}</div>
            <div className="zone-row">
              {stations.map((s) => {
                const i = s.index;
                const stateCls = STATE_CLASS[frame.st[i]] || "";
                const driftCls = DRIFT_CLASS[frame.dr[i]] || "";
                const selCls = s.sid === selectedSid ? "selected" : "";
                return (
                  <div
                    key={s.sid}
                    className={`stbox tier-${s.tier} ${stateCls} ${driftCls} ${selCls}`}
                    title={`${s.sid} ${s.name} — ${STATE_NAME[frame.st[i]]}`}
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
                    <div className="stbox-cyc mono">{frame.cyc[i].toFixed(0)}s</div>
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
