import { useDashboardData } from "../../../router";
import { PageHeading } from "../../common/PageHeading";
import { KpiTile } from "../../common/KpiTile";
import { OriginChart } from "../parts/charts";
import { fmtClock } from "../../../utils";

export function ManagerQuality() {
  const { twin } = useDashboardData();
  const m = twin.meta;
  const fails = twin.quality_events.filter((q) => q.result === "FAIL");
  const falloutPct = m.n_quality_checks > 0 ? (100 * m.n_fails) / m.n_quality_checks : 0;
  const originCounts = twin.quality_origin_counts;
  const distinctOrigins = Object.keys(originCounts).length;
  const topOrigin = Object.entries(originCounts).sort((a, b) => b[1] - a[1])[0];
  const topShare = topOrigin && m.n_fails > 0 ? (100 * topOrigin[1]) / m.n_fails : 0;

  const byType = new Map<string, number>();
  for (const f of fails) {
    const k = f.defect_type ?? "unclassified";
    byType.set(k, (byType.get(k) ?? 0) + 1);
  }

  return (
    <>
      <PageHeading
        title="Quality"
        lede="Fallout for the shift, traced to the station that caused it."
      />

      <div className="kpi-strip">
        <KpiTile
          label="Fallout"
          value={m.n_fails}
          sub={`of ${m.n_quality_checks} inspections`}
        />
        <KpiTile
          label="Fallout rate"
          value={`${falloutPct.toFixed(2)}%`}
          tone={falloutPct > 4 ? "amber" : undefined}
        />
        <KpiTile label="Distinct origins" value={distinctOrigins} sub="stations implicated" />
        <KpiTile
          label="Top origin share"
          value={`${topShare.toFixed(0)}%`}
          sub={topOrigin ? `${topOrigin[0]} — ${topOrigin[1]} units` : "—"}
          tone={topShare > 50 ? "amber" : undefined}
        />
      </div>

      <div className="grid12" style={{ marginTop: 16 }}>
        <div className="col-6">
          <section className="card">
            <h2>
              Fallout by origin station
              <span className="h2-note">genealogy backtrace, not where caught</span>
            </h2>
            <OriginChart twin={twin} />
          </section>
        </div>

        <div className="col-6">
          <section className="card">
            <h2>
              Fallout by defect type
              <span className="h2-note">most recent {fails.length} events</span>
            </h2>
            <table className="datatable">
              <thead>
                <tr>
                  <th>Defect type</th>
                  <th className="num">Units</th>
                </tr>
              </thead>
              <tbody>
                {[...byType.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="num mono">{n}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        </div>

        <div className="col-12">
          <section className="card">
            <h2>Recent fallout events</h2>
            <div className="table-scroll">
              <table className="datatable">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Body</th>
                    <th>Inspection</th>
                    <th>Defect</th>
                    <th>Origin</th>
                  </tr>
                </thead>
                <tbody>
                  {fails
                    .slice(-30)
                    .reverse()
                    .map((f, i) => (
                      <tr key={`${f.uid}-${i}`}>
                        <td className="mono">{fmtClock(f.t)}</td>
                        <td className="mono">#{f.uid}</td>
                        <td>{f.inspection}</td>
                        <td>{f.defect_type ?? "—"}</td>
                        <td className="mono">{f.origin ?? "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
