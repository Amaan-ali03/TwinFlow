import { AppLink } from "../../common/AppLink";
import { useFloorPlayback } from "../FloorContext";
import { LineMap, LineMapLegend } from "../parts/LineMap";
import { AlertCard, firstSentence } from "../../common/AlertCard";
import { PageHeading } from "../../common/PageHeading";
import { fmtClock } from "../../../utils";

export function FloorOverview() {
  const { twin, frame, selectedSid, setSelectedSid } = useFloorPlayback();

  const constraint = twin.line.find((s) => s.sid === frame.constraint);
  const rl = frame.rate_loss || 0;
  const elapsedH = frame.t / 3600 || 1 / 3600;
  const ratePerHr = frame.units_out / elapsedH;
  const planRatePerHr =
    (twin.meta.n_completed / (twin.meta.horizon_s / 3600)) || 0;

  const raisedAlerts = twin.alerts.filter((a) => a.t <= frame.t);
  const activeAlerts = raisedAlerts
    .filter(
      (a) =>
        frame.t < a.verify_by ||
        a.outcome === "OPEN" ||
        a.outcome === "PENDING"
    )
    .sort(
      (a, b) =>
        rank(b.tier) - rank(a.tier) ||
        b.last_update_t - a.last_update_t ||
        b.t - a.t
    );
  const topAlerts = activeAlerts.slice(0, 4);
  const criticalCount = activeAlerts.filter((a) => a.tier === "ACT NOW").length;

  return (
    <>
      <PageHeading
        title="Overview"
        lede={
          <>
            Line state at <span className="mono">{fmtClock(frame.t)}</span> — what
            is happening now and what to act on.
          </>
        }
      />

      <div className="kpi-strip">
        <Kpi
          label="Critical alerts"
          value={String(criticalCount)}
          sub={`${activeAlerts.length} active · ${raisedAlerts.length} raised`}
          tone={criticalCount > 0 ? "red" : "green"}
        />
        <Kpi
          label="Constraint station"
          value={frame.constraint ? `${frame.constraint}` : "—"}
          sub={
            constraint
              ? `${constraint.name} · ${frame.constraint_cycle.toFixed(0)}s vs ${(
                  constraint.mix_cycle_s ?? constraint.nominal_cycle_s
                ).toFixed(0)}s`
              : "line balanced"
          }
        />
        <Kpi
          label="Current throughput"
          value={ratePerHr.toFixed(1)}
          sub={`bodies/hr · plan ${planRatePerHr.toFixed(1)}`}
          tone={ratePerHr < planRatePerHr - 1 ? "amber" : "green"}
        />
        <Kpi
          label="Sustained rate loss"
          value={`${rl > 0 ? "+" : ""}${rl.toFixed(1)}`}
          sub="bodies/hr vs takt"
          tone={rl > 3 ? "red" : rl > 0.5 ? "amber" : "green"}
        />
        <Kpi
          label="Runway to visible"
          value={frame.runway_min ? `${frame.runway_min.toFixed(0)}m` : "—"}
          sub="until the end-of-line counter falls"
          tone={frame.runway_min && frame.runway_min < 20 ? "amber" : undefined}
        />
        <Kpi
          label="Bodies out"
          value={String(frame.units_out)}
          sub={`plan pace ≈ ${((frame.t / twin.meta.horizon_s) * twin.meta.n_completed).toFixed(0)}`}
        />
      </div>

      <div className="grid12" style={{ marginTop: 16 }}>
        <div className="col-8">
          <section className="card">
            <h2>
              Needs attention
              <AppLink to="/floor/alerts" className="card-link">
                View all alerts ({raisedAlerts.length})
              </AppLink>
            </h2>
            {topAlerts.length === 0 ? (
              <p className="faint" style={{ padding: "6px 0" }}>
                {raisedAlerts.length === 0
                  ? "No conditions yet. The line is inside a normal warm-up window."
                  : "Nothing open right now — every alert raised this shift has been verified."}
              </p>
            ) : (
              <div className="alert-list">
                {topAlerts.map((a) => (
                  <AlertCard key={a.aid} alert={a} nowT={frame.t} />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="col-4">
          <section className="card">
            <h2>Recommended actions</h2>
            {topAlerts.length === 0 ? (
              <p className="faint">Nothing recommended — hold current plan.</p>
            ) : (
              <ol className="action-list">
                {topAlerts.map((a) => (
                  <li key={a.aid}>
                    <span className={`tierbadge tb-${tone(a.tier)}`}>{a.tier}</span>
                    <div>
                      <div className="action-what">{firstSentence(a.action)}</div>
                      <div className="faint mono action-where">
                        {a.sid} · {a.owner}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="col-12">
          <section className="card">
            <h2>
              Line state
              <LineMapLegend />
            </h2>
            <LineMap
              twin={twin}
              frame={frame}
              selectedSid={selectedSid}
              onSelect={setSelectedSid}
            />
            <p className="faint" style={{ marginTop: 10, fontSize: 12 }}>
              Select a station to pin it, then open{" "}
              <AppLink to="/floor/station" className="inline-link">
                Station Detail
              </AppLink>{" "}
              for its full readout.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

function rank(tier: string) {
  return tier === "ACT NOW" ? 3 : tier === "ADVISE" ? 2 : 1;
}
function tone(tier: string) {
  return tier === "ACT NOW" ? "act" : tier === "ADVISE" ? "advise" : "monitor";
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
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
  return (
    <div className="kpi-tile">
      <div className="kpi-tile-label">{label}</div>
      <div className="kpi-tile-value mono" style={{ color }}>
        {value}
      </div>
      <div className="kpi-tile-sub">{sub}</div>
    </div>
  );
}
