import { useDashboardData } from "../../../router";
import { PageHeading } from "../../common/PageHeading";
import { KpiTile } from "../../common/KpiTile";
import { ThroughputChart, ZoneMix } from "../parts/charts";

export function ManagerLivePerformance() {
  const { twin } = useDashboardData();
  const m = twin.meta;
  const counts = m.variant_counts ?? {};
  const built = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const totalBuilt = built.reduce((s, [, n]) => s + n, 0) || 1;

  return (
    <>
      <PageHeading
        title="Live Performance"
        lede="Output and instrumentation for the shift in progress."
      />

      <div className="kpi-strip">
        <KpiTile label="Bodies completed" value={m.n_completed} sub={`${m.n_events} line events`} />
        <KpiTile
          label="Throughput"
          value={(m.n_completed / (m.horizon_s / 3600)).toFixed(1)}
          sub="bodies / hour"
        />
        <KpiTile
          label="Sensor coverage"
          value={`${m.tiers.A}/${m.tiers.B}/${m.tiers.C}`}
          sub="full / cycle-only / dark"
        />
        <KpiTile
          label="Build mix"
          value={built.map(([v]) => v[0]).join(" ")}
          sub={built
            .map(([v, n]) => `${v} ${((n / totalBuilt) * 100).toFixed(0)}%`)
            .join(" · ")}
        />
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Throughput — bodies rolled out, 10 min buckets</h2>
        <ThroughputChart twin={twin} />
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Sensor tier mix by zone</h2>
        <ZoneMix twin={twin} />
      </section>
    </>
  );
}
