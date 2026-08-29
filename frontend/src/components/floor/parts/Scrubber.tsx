import { useFloorPlayback } from "../FloorContext";
import { fmtT, fmtClock } from "../../../utils";

export function Scrubber() {
  const { twin, idx, setIdx, frame, playing, togglePlay, jumpToFirstAlert } =
    useFloorPlayback();

  return (
    <div className="scrubber card">
      <div className="scrubber-row">
        <button
          className="playbtn"
          onClick={togglePlay}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <input
          type="range"
          min={0}
          max={twin.frames.length - 1}
          value={idx}
          onChange={(e) => setIdx(+e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <div className="mono clock">
          {fmtClock(frame.t)} · t+{fmtT(frame.t)}
        </div>
        <button className="jumpbtn" onClick={jumpToFirstAlert}>
          Jump to first alert
        </button>
      </div>
    </div>
  );
}
