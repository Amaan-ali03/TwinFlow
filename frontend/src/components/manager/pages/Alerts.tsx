import { useState } from "react";
import { useDashboardData } from "../../../router";
import { PageHeading } from "../../common/PageHeading";
import { AlertCard } from "../../common/AlertCard";
import { LedgerTable } from "../parts/charts";

export function ManagerAlerts() {
  const { twin } = useDashboardData();
  const [kind, setKind] = useState<string>("all");

  const kinds = Array.from(new Set(twin.alerts.map((a) => a.kind)));
  const shown = (kind === "all"
    ? twin.alerts
    : twin.alerts.filter((a) => a.kind === kind)
  )
    .slice()
    .sort((a, b) => b.t - a.t);

  return (
    <>
      <PageHeading
        title="Alerts"
        lede="Precision by alert type, then every alert this shift graded against the plant's own outcome record."
      />

      <section className="card">
        <h2>Alert ledger by type</h2>
        <LedgerTable twin={twin} />
      </section>

      <div className="filter-bar" style={{ marginTop: 16 }}>
        <button
          className={`filterchip${kind === "all" ? " is-active" : ""}`}
          onClick={() => setKind("all")}
        >
          All {twin.alerts.length}
        </button>
        {kinds.map((k) => (
          <button
            key={k}
            className={`filterchip${kind === k ? " is-active" : ""}`}
            onClick={() => setKind(k)}
          >
            {k} {twin.alerts.filter((a) => a.kind === k).length}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <p className="faint">No alerts of this type this shift.</p>
        </div>
      ) : (
        <div className="alert-list">
          {shown.map((a) => (
            <AlertCard key={a.aid} alert={a} />
          ))}
        </div>
      )}
    </>
  );
}
