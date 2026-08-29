import type { ReactNode } from "react";

export function KpiTile({
  label,
  value,
  sub,
  delta,
  deltaGood = "up",
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** e.g. "+4.2% vs target" — leading sign drives colour */
  delta?: string;
  /** which direction of change is a good outcome (default: up) */
  deltaGood?: "up" | "down";
  tone?: "red" | "amber" | "green";
}) {
  const color =
    tone === "red"
      ? "var(--andon-red)"
      : tone === "amber"
      ? "var(--andon-amber)"
      : tone === "green"
      ? "var(--andon-green)"
      : undefined;
  const dir = delta?.trim().startsWith("-")
    ? "down"
    : delta?.trim().startsWith("+")
    ? "up"
    : "flat";
  const deltaClass =
    dir === "flat" ? "flat" : dir === deltaGood ? "good" : "bad";

  return (
    <div className="kpi-tile">
      <div className="kpi-tile-label">{label}</div>
      <div className="kpi-tile-value mono" style={{ color }}>
        {value}
      </div>
      {delta && <div className={`kpi-delta ${deltaClass}`}>{delta}</div>}
      {sub && <div className="kpi-tile-sub">{sub}</div>}
    </div>
  );
}
