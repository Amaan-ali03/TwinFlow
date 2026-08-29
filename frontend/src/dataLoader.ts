import type {
  TwinData,
  ValidationData,
  UnitRisk,
  WhatIfResult,
  HistoryData,
} from "./types";

export interface ValidationProgress {
  shift: number;
  total: number;
  recall: number;
  precision: number | null;
  alerts_fired: number;
  transient_false_alarms: number;
}

export async function loadTwinData(): Promise<TwinData> {
  const res = await fetch("/api/run-demo");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to fetch twin data from /api/run-demo (HTTP ${res.status}). ` +
        `Is the backend running on :8000? ` +
        body.slice(0, 200)
    );
  }
  return res.json();
}

export async function loadHistory(shifts = 10): Promise<HistoryData> {
  const res = await fetch(`/api/history?shifts=${shifts}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to fetch shift history from /api/history (HTTP ${res.status}). ` +
        body.slice(0, 200)
    );
  }
  return res.json();
}

export async function loadUnitRisk(uid: number): Promise<UnitRisk> {
  const res = await fetch(`/api/unit-risk/${uid}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to fetch unit risk for ${uid} (HTTP ${res.status}). ${body.slice(0, 200)}`
    );
  }
  return res.json();
}

export async function runWhatIf(
  t: number,
  overrides: Record<string, number>
): Promise<WhatIfResult> {
  const res = await fetch("/api/what-if", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ t, overrides }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`what-if request failed (HTTP ${res.status}). ${body.slice(0, 200)}`);
  }
  return res.json();
}

export function loadValidationData(
  onProgress: (p: ValidationProgress) => void
): Promise<ValidationData> {
  return new Promise((resolve, reject) => {
    const es = new EventSource("/api/validate");

    es.addEventListener("progress", (e: MessageEvent) => {
      onProgress(JSON.parse(e.data));
    });

    es.addEventListener("result", (e: MessageEvent) => {
      es.close();
      resolve(JSON.parse(e.data));
    });

    es.onerror = () => {
      es.close();
      reject(
        new Error(
          "Failed to connect to validation SSE stream at /api/validate. " +
            "Is the backend running on :8000?"
        )
      );
    };
  });
}
