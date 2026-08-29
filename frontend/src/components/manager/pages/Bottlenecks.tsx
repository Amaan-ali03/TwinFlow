import { useDashboardData } from "../../../router";
import { useManagerData } from "../ManagerContext";
import { PageHeading } from "../../common/PageHeading";
import { KpiTile } from "../../common/KpiTile";
import { FaultTimeline } from "../parts/charts";
import { ConstraintLedger, RecurringBars } from "../parts/history";

export function ManagerBottlenecks() {
  const { twin } = useDashboardData();
  const { history, historyError } = useManagerData();
  const last = twin.frames[twin.frames.length - 1];
  const station = twin.line.find((s) => s.sid === last?.constraint);
  const top = history?.recurring_constraints[0];

  return (
    <>
      <PageHeading
        title="Bottlenecks"
        lede="Where the line is losing rate this shift, and which stations do it every shift."
      />

      <div className="kpi-strip">
        <KpiTile
          label="Constraint at shift end"
          value={last?.constraint ?? "—"}
          sub={station?.name ?? "line balanced"}
          tone={last?.rate_loss > 1 ? "amber" : undefined}
        />
        <KpiTile
          label="Sustained rate loss"
          value={last ? `${last.rate_loss > 0 ? "+" : ""}${last.rate_loss.toFixed(1)}` : "0.0"}
          sub="bodies / hour vs takt"
          tone={last?.rate_loss > 3 ? "red" : last?.rate_loss > 0.5 ? "amber" : "green"}
        />
        <KpiTile
          label="Recurring #1"
          value={top?.sid ?? "—"}
          sub={
            top
              ? `${top.name} — constraint in ${top.shifts} of ${history!.shifts} shifts`
              : "loading…"
          }
        />
      </div>

      <div className="grid12" style={{ marginTop: 16 }}>
        <div className="col-6">
          <section className="card">
            <h2>Constraint station, shift by shift</h2>
            {historyError ? (
              <p className="faint">{historyError}</p>
            ) : history ? (
              <ConstraintLedger hist={history} />
            ) : (
              <p className="faint">Running consecutive shifts…</p>
            )}
          </section>
        </div>
        <div className="col-6">
          <section className="card">
            <h2>Recurring constraints</h2>
            {historyError ? (
              <p className="faint">{historyError}</p>
            ) : history ? (
              <RecurringBars hist={history} />
            ) : (
              <p className="faint">Running consecutive shifts…</p>
            )}
          </section>
        </div>
        <div className="col-12">
          <section className="card">
            <h2>
              Shift fault timeline
              <span className="h2-note">what happened vs when the twin flagged it</span>
            </h2>
            <FaultTimeline twin={twin} />
          </section>
        </div>
      </div>
    </>
  );
}
