import { useDashboardData } from "../../../router";
import { useManagerData } from "../ManagerContext";
import { PageHeading } from "../../common/PageHeading";
import { KpiTile } from "../../common/KpiTile";
import {
  ThroughputChart,
  OriginChart,
  FaultTimeline,
} from "../parts/charts";
import { ConstraintLedger, RecurringBars } from "../parts/history";

export function ManagerOverview() {
  const { twin } = useDashboardData();
  const { history, historyError } = useManagerData();
  const m = twin.meta;

  const throughputPerHr = m.n_completed / (m.horizon_s / 3600);
  const falloutPct =
    m.n_quality_checks > 0 ? (100 * m.n_fails) / m.n_quality_checks : 0;
  const weekFallout = history?.totals.mean_fallout_pct ?? null;
  const falloutDelta =
    weekFallout != null
      ? `${falloutPct - weekFallout >= 0 ? "+" : ""}${(falloutPct - weekFallout).toFixed(2)}pp vs week`
      : undefined;

  const lastFrame = twin.frames[twin.frames.length - 1];
  const constraintStation = twin.line.find((s) => s.sid === lastFrame?.constraint);

  const openAlerts = twin.alerts.filter(
    (a) => a.outcome === "OPEN" || a.outcome === "PENDING"
  );
  const byTier = {
    "ACT NOW": openAlerts.filter((a) => a.tier === "ACT NOW").length,
    ADVISE: openAlerts.filter((a) => a.tier === "ADVISE").length,
    MONITOR: openAlerts.filter((a) => a.tier === "MONITOR").length,
  };

  return (
    <>
      <PageHeading
        title="Overview"
        lede="Plant health for the current shift — read it in ten seconds, then drill in."
      />

      <div className="kpi-strip">
        <KpiTile
          label="Bodies completed"
          value={m.n_completed}
          sub={`over an ${(m.horizon_s / 3600).toFixed(0)} hour shift`}
        />
        <KpiTile
          label="Throughput"
          value={throughputPerHr.toFixed(1)}
          sub="bodies / hour, shift average"
        />
        <KpiTile
          label="Quality fallout"
          value={`${falloutPct.toFixed(1)}%`}
          delta={falloutDelta}
          deltaGood="down"
          sub={`${m.n_fails} of ${m.n_quality_checks} inspections`}
          tone={falloutPct > 4 ? "amber" : undefined}
        />
        <KpiTile
          label="Alert precision"
          value={
            twin.ledger.precision_all != null
              ? `${(twin.ledger.precision_all * 100).toFixed(0)}%`
              : "—"
          }
          sub={`${twin.ledger.total} alerts graded against outcomes`}
        />
        <KpiTile
          label="Current bottleneck"
          value={lastFrame?.constraint ?? "—"}
          sub={
            constraintStation
              ? `${constraintStation.name} · ${lastFrame.constraint_cycle.toFixed(0)}s`
              : "line balanced"
          }
          tone={lastFrame?.rate_loss > 1 ? "amber" : undefined}
        />
      </div>

      <div className="grid12" style={{ marginTop: 16 }}>
        <div className="col-8">
          <section className="card">
            <h2>Throughput — bodies rolled out, 10 min buckets</h2>
            <ThroughputChart twin={twin} />
          </section>
        </div>

        <div className="col-4">
          <section className="card">
            <h2>Open alerts & constraint</h2>
            <div className="minor-stats">
              <div className="minor-stat">
                <span className="state-pill sp-blocked">Act now</span>
                <b className="mono">{byTier["ACT NOW"]}</b>
              </div>
              <div className="minor-stat">
                <span className="state-pill sp-starved">Advise</span>
                <b className="mono">{byTier.ADVISE}</b>
              </div>
              <div className="minor-stat">
                <span className="state-pill sp-work">Monitor</span>
                <b className="mono">{byTier.MONITOR}</b>
              </div>
            </div>
            <p className="faint chart-note">
              Constraint at shift end:{" "}
              <span className="mono">{lastFrame?.constraint ?? "none"}</span>
              {constraintStation ? ` — ${constraintStation.name}` : ""}. Sustained
              rate loss {lastFrame ? lastFrame.rate_loss.toFixed(1) : "0.0"}{" "}
              bodies/hr.
            </p>
          </section>
        </div>

        <div className="col-6">
          <section className="card">
            <h2>
              Quality fallout by origin station
              <span className="h2-note">traced by genealogy, not where caught</span>
            </h2>
            <OriginChart twin={twin} />
          </section>
        </div>

        <div className="col-6">
          <section className="card">
            <h2>
              Shift fault timeline
              <span className="h2-note">what happened vs when the twin flagged it</span>
            </h2>
            <FaultTimeline twin={twin} />
          </section>
        </div>

        <div className="col-6">
          <section className="card">
            <h2>Constraint station ledger — last 10 shifts</h2>
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
            <h2>Recurring bottlenecks — where a maintenance window pays back</h2>
            {historyError ? (
              <p className="faint">{historyError}</p>
            ) : history ? (
              <RecurringBars hist={history} />
            ) : (
              <p className="faint">Running consecutive shifts…</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
