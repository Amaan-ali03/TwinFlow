import { AppLink } from "../../common/AppLink";
import { useFloorPlayback } from "../FloorContext";
import { LineMap, LineMapLegend } from "../parts/LineMap";
import { StationReadout } from "../parts/StationReadout";
import { Scrubber } from "../parts/Scrubber";
import { PageHeading } from "../../common/PageHeading";

export function FloorLiveLine() {
  const { twin, frame, selectedSid, setSelectedSid } = useFloorPlayback();

  return (
    <>
      <PageHeading
        title="Live Line"
        lede="All 42 stations, body → paint → final assembly. Scrub the shift or press play."
      />

      <Scrubber />

      <section className="card" style={{ marginTop: 16 }}>
        <h2>
          Station map
          <LineMapLegend />
        </h2>
        <LineMap
          twin={twin}
          frame={frame}
          selectedSid={selectedSid}
          onSelect={setSelectedSid}
        />

        <div className="station-detail">
          {selectedSid ? (
            <>
              <div className="station-detail-head">
                <span className="faint">Selected station</span>
                <AppLink to="/floor/station" className="inline-link">
                  Open full detail →
                </AppLink>
              </div>
              <StationReadout twin={twin} frame={frame} sid={selectedSid} />
            </>
          ) : (
            <p className="faint" style={{ padding: "8px 0" }}>
              Select a station to inspect its current reading.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
