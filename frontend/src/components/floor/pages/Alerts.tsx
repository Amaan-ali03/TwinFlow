import { useState } from "react";
import { useFloorPlayback } from "../FloorContext";
import { AlertCard } from "../../common/AlertCard";
import { PageHeading } from "../../common/PageHeading";

type Filter = "all" | "ACT NOW" | "ADVISE" | "MONITOR";

export function FloorAlerts() {
  const { twin, frame } = useFloorPlayback();
  const [filter, setFilter] = useState<Filter>("all");

  const all = twin.alerts
    .filter((a) => a.t <= frame.t)
    .sort((a, b) => b.last_update_t - a.last_update_t || b.t - a.t);

  const counts = {
    "ACT NOW": all.filter((a) => a.tier === "ACT NOW").length,
    ADVISE: all.filter((a) => a.tier === "ADVISE").length,
    MONITOR: all.filter((a) => a.tier === "MONITOR").length,
  };

  const shown = filter === "all" ? all : all.filter((a) => a.tier === filter);

  return (
    <>
      <PageHeading
        title="Alert ledger"
        lede={`Every alert raised so far this shift, graded against outcomes. ${all.length} shown.`}
      />

      <div className="filter-bar">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          All {all.length}
        </FilterChip>
        <FilterChip
          active={filter === "ACT NOW"}
          onClick={() => setFilter("ACT NOW")}
          tone="act"
        >
          Act now {counts["ACT NOW"]}
        </FilterChip>
        <FilterChip
          active={filter === "ADVISE"}
          onClick={() => setFilter("ADVISE")}
          tone="advise"
        >
          Advise {counts.ADVISE}
        </FilterChip>
        <FilterChip
          active={filter === "MONITOR"}
          onClick={() => setFilter("MONITOR")}
          tone="monitor"
        >
          Monitor {counts.MONITOR}
        </FilterChip>
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <p className="faint">
            {all.length === 0
              ? "No conditions yet. The line is inside a normal warm-up window."
              : "No alerts match this filter."}
          </p>
        </div>
      ) : (
        <div className="alert-list">
          {shown.map((a) => (
            <AlertCard key={a.aid} alert={a} nowT={frame.t} />
          ))}
        </div>
      )}
    </>
  );
}

function FilterChip({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: "act" | "advise" | "monitor";
  children: React.ReactNode;
}) {
  return (
    <button
      className={`filterchip${active ? " is-active" : ""}${tone ? ` fc-${tone}` : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
