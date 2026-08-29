import { useManagerData } from "../ManagerContext";
import { PageHeading } from "../../common/PageHeading";
import { KpiTile } from "../../common/KpiTile";
import { ConstraintLedger, RecurringBars, TrustTrend } from "../parts/history";

export function ManagerShiftHistory() {
  const { history, historyError } = useManagerData();

  if (historyError) {
    return (
      <>
        <PageHeading title="Shift History" />
        <div className="card">
          <p className="faint">{historyError}</p>
        </div>
      </>
    );
  }
  if (!history) {
    return (
      <>
        <PageHeading title="Shift History" lede="Running consecutive shifts…" />
        <div className="card">
          <p className="faint">
            Running ten consecutive shifts with a carried-forward ledger. This
            takes about 20 seconds when it isn't already cached.
          </p>
        </div>
      </>
    );
  }

  const t = history.totals;
  return (
    <>
      <PageHeading
        title="Shift History"
        lede={`The planning horizon a single shift can't show — ${history.shifts} consecutive shifts, ledger carried forward.`}
      />

      <div className="kpi-strip">
        <KpiTile label="Bodies out" value={t.bodies_out} sub={`across ${history.shifts} shifts`} />
        <KpiTile label="Quality fails" value={t.quality_fails} sub={`mean fallout ${t.mean_fallout_pct?.toFixed(2) ?? "—"}%`} />
        <KpiTile label="Alerts fired" value={t.alerts_fired} />
        <KpiTile
          label="Recurring constraint"
          value={history.recurring_constraints[0]?.sid ?? "—"}
          sub={history.recurring_constraints[0]?.name ?? ""}
        />
      </div>

      <div className="grid12" style={{ marginTop: 16 }}>
        <div className="col-6">
          <section className="card">
            <h2>Constraint station, last {history.shifts} shifts</h2>
            <ConstraintLedger hist={history} />
          </section>
        </div>
        <div className="col-6">
          <section className="card">
            <h2>Recurring constraints — where a maintenance window pays back</h2>
            <RecurringBars hist={history} />
          </section>
        </div>
        <div className="col-12">
          <section className="card">
            <h2>
              Alert trust over the week
              <span className="h2-note">measured precision per type, and the threshold the ledger moved</span>
            </h2>
            <TrustTrend hist={history} />
          </section>
        </div>
      </div>
    </>
  );
}
