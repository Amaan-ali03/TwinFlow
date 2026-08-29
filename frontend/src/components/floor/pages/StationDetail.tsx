import { useFloorPlayback } from "../FloorContext";
import { LineMap } from "../parts/LineMap";
import { StationReadout } from "../parts/StationReadout";
import { Scrubber } from "../parts/Scrubber";
import { PageHeading } from "../../common/PageHeading";
import { fmtClock, TIER_LABEL } from "../../../utils";

export function FloorStationDetail() {
  const { twin, frame, selectedSid, setSelectedSid } = useFloorPlayback();
  const station = twin.line.find((s) => s.sid === selectedSid) ?? null;

  return (
    <>
      <PageHeading
        title="Station Detail"
        lede={
          station ? (
            <>
              <span className="mono">{station.sid}</span> — {station.name} at{" "}
              <span className="mono">{fmtClock(frame.t)}</span>
            </>
          ) : (
            "Pick a station on the map to inspect its telemetry."
          )
        }
        actions={
          station && (
            <button className="jumpbtn" onClick={() => setSelectedSid(null)}>
              Clear selection
            </button>
          )
        }
      />

      {station && (
        <>
          <Scrubber />
          <section className="card" style={{ marginTop: 16 }}>
            <h2>Telemetry</h2>
            <StationReadout twin={twin} frame={frame} sid={station.sid} />
          </section>

          <section className="card" style={{ marginTop: 16 }}>
            <h2>Declared process parameters</h2>
            {station.params.length === 0 ? (
              <p className="faint">
                No process sensors here — {TIER_LABEL[station.tier].toLowerCase()}.
              </p>
            ) : (
              <div className="chip-row">
                {station.params.map((p) => (
                  <span key={p} className="param-chip mono">
                    {p}
                  </span>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <h2>{station ? "Change selection" : "Select a station"}</h2>
        <LineMap
          twin={twin}
          frame={frame}
          selectedSid={selectedSid}
          onSelect={setSelectedSid}
        />
      </section>
    </>
  );
}
