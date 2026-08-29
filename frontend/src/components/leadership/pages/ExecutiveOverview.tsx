import { AppLink } from "../../common/AppLink";
import { useValidationData } from "../../../router";
import { PageHeading } from "../../common/PageHeading";
import { KpiTile } from "../../common/KpiTile";

export function LeadershipExecutiveOverview() {
  const V = useValidationData().validation!;
  const bottleneckPrecision = V.by_kind.BOTTLENECK?.precision ?? 0;
  const leadGain = V.versus_spec_alarm.median_lead_gain_min;

  return (
    <>
      <PageHeading
        title="Executive Overview"
        lede="Does it work, can we trust it, is it worth deploying — the one-screen answer."
      />

      <section className="card hero">
        <div className="hero-eyebrow">THE CASE IN ONE LINE</div>
        <div className="hero-line">
          A dashboard reports the level of a buffer. TwinFlow knows it's a tank
          with a measured inflow and outflow, so it can say <em>when</em> it runs
          dry and <em>which</em> upstream station is responsible —{" "}
          <span className="mono">{leadGain?.toFixed(0) ?? "—"} min</span> before a
          specification alarm would have fired, on average, across {V.shifts}{" "}
          independently seeded shifts it had never seen.
        </div>
      </section>

      <div className="kpi-strip" style={{ marginTop: 16 }}>
        <KpiTile
          label="Fault recall"
          value={`${(V.detection.recall * 100).toFixed(0)}%`}
          sub={`every injected fault type caught, ${V.shifts} random shifts`}
        />
        <KpiTile
          label="Bottleneck alert precision"
          value={`${(bottleneckPrecision * 100).toFixed(0)}%`}
          sub="confirmed against the plant's own downtime log"
        />
        <KpiTile
          label="Lead over a spec alarm"
          value={`${leadGain?.toFixed(0) ?? "—"}m`}
          sub={`median — and in ${V.versus_spec_alarm.spec_alarm_never_fired_pct.toFixed(0)}% of cases the spec alarm never fired at all`}
        />
        <KpiTile
          label="Bodies protected"
          value={String(V.versus_spec_alarm.median_bodies_protected ?? "—")}
          sub="median per contained drift — a numbered list, not an open recall"
        />
      </div>

      <div className="grid12" style={{ marginTop: 16 }}>
        <div className="col-6">
          <section className="card">
            <h2>Key takeaway</h2>
            <p className="drawer-p">
              The claim is not that the twin counts bodies better than multiplying
              takt by thirty minutes — on a healthy line it doesn't. The claim is{" "}
              <strong>advance warning with a named cause</strong>: which station
              will starve, when, and what to do, roughly{" "}
              {leadGain?.toFixed(0) ?? "—"} minutes before the line shows it. Every
              number on these pages is graded after the fact against the plant's
              own downtime and quality records, never against the twin's own
              belief. See{" "}
              <AppLink to="/leadership/model-performance" className="inline-link">
                Model Performance
              </AppLink>{" "}
              for the honest limits.
            </p>
          </section>
        </div>
        <div className="col-6">
          <section className="card">
            <h2>Business value</h2>
            <p className="drawer-p">
              Read-only against existing MES and barcode data — no PLC write path,
              no blanket camera retrofit. The{" "}
              <AppLink to="/leadership/business-case" className="inline-link">
                Business Case
              </AppLink>{" "}
              works avoided rework and avoided downtime against a rollout of 2–3
              targeted cameras plus integration, and recomputes on your plant's own
              financials. Simulator figures are a stand-in; Phase 1 replaces them
              with yours before any alert reaches a supervisor.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
