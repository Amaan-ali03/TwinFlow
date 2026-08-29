import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDashboardData } from "../../router";
import type { Frame, TwinData } from "../../types";

interface FloorPlayback {
  twin: TwinData;
  idx: number;
  setIdx: (i: number) => void;
  frame: Frame;
  playing: boolean;
  togglePlay: () => void;
  jumpToFirstAlert: () => void;
  selectedSid: string | null;
  setSelectedSid: (sid: string | null) => void;
}

const FloorPlaybackContext = createContext<FloorPlayback | null>(null);

/**
 * Playback position and the selected station are shared by every Floor view,
 * so scrubbing on Live Line and opening Station Detail stay in lock-step.
 */
export function FloorPlaybackProvider({ children }: { children: ReactNode }) {
  const { twin } = useDashboardData();
  // Default to the last frame — "now" for the supervisor is the current line
  // state, not the start of the shift. Scrub back or press play to review.
  const [idx, setIdx] = useState(twin.frames.length - 1);
  const [playing, setPlaying] = useState(false);
  const [selectedSid, setSelectedSid] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (!p && idx >= twin.frames.length - 1) setIdx(0);
      return !p;
    });
  }, [idx, twin.frames.length]);

  useEffect(() => {
    if (!playing) return;
    timerRef.current = window.setInterval(() => {
      setIdx((prev) => {
        const next = prev + 1;
        if (next >= twin.frames.length - 1) {
          setPlaying(false);
          return twin.frames.length - 1;
        }
        return next;
      });
    }, 140);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, twin.frames.length]);

  const jumpToFirstAlert = useCallback(() => {
    if (!twin.alerts.length) return;
    const t0 = twin.alerts[0].t;
    const found = twin.frames.findIndex((f) => f.t >= t0);
    setIdx(Math.max(0, found));
  }, [twin]);

  const value = useMemo<FloorPlayback>(
    () => ({
      twin,
      idx,
      setIdx,
      frame: twin.frames[Math.min(idx, twin.frames.length - 1)],
      playing,
      togglePlay,
      jumpToFirstAlert,
      selectedSid,
      setSelectedSid,
    }),
    [twin, idx, playing, togglePlay, jumpToFirstAlert, selectedSid]
  );

  return (
    <FloorPlaybackContext.Provider value={value}>
      {children}
    </FloorPlaybackContext.Provider>
  );
}

export function useFloorPlayback() {
  const ctx = useContext(FloorPlaybackContext);
  if (!ctx) throw new Error("useFloorPlayback used outside FloorPlaybackProvider");
  return ctx;
}
