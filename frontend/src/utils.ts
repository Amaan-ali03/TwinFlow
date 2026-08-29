export function fmtT(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

export function fmtClock(t: number): string {
  const base = 6 * 3600 + t;
  const h = Math.floor(base / 3600) % 24;
  const m = Math.floor((base % 3600) / 60);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

export const STATE_NAME: Record<number, string> = {
  0: "WORK",
  1: "STARVED",
  2: "BLOCKED",
};

export const DRIFT_NAME: Record<number, string> = {
  0: "STABLE",
  1: "WATCH",
  2: "DRIFTING",
  3: "EXCURSION",
};

export const TIER_LABEL: Record<string, string> = {
  A: "Full sensors",
  B: "Cycle only",
  C: "Dark / manual",
};

export const STATE_CLASS: Record<number, string> = {
  0: "st-work",
  1: "st-starved",
  2: "st-blocked",
};

export const DRIFT_CLASS: Record<number, string> = {
  1: "drift-watch",
  2: "drift-drifting",
  3: "drift-excursion",
};
