import { useFloorPlayback } from "../FloorContext";
import { PageHeading } from "../../common/PageHeading";
import { fmtClock, STATE_NAME } from "../../../utils";

export function FloorBottlenecks() {
  const { twin, frame } = useFloorPlayback();

  const constraint = twin.line.find((s) => s.sid === frame.constraint);
  const standard = constraint
    ? constraint.mix_cycle_s ?? constraint.nominal_cycle_s
    : 0;
  const overStandard = Math.max(0, Math.round(frame.constraint_cycle - standard));
  const deficit = Math.max(0, Math.round(frame.deficit));

  const disrupted = twin.line
    .map((s) => ({ s, state: frame.st[s.index] }))
    .filter((x) => x.state === 1 || x.state === 2);

  const forecasts = twin.line
    .map((s) => ({ s, fc: frame.fc[s.index] }))
    .filter((x): x is { s: typeof x.s; fc: [1 | 2, number] } => x.fc !== null)
    .sort((a, b) => a.fc[1] - b.fc[1]);

  return (
    <>
      <PageHeading
        title="Bottlenecks"
        lede={
          <>
            Constraint and flow disruption at{" "}
            <span className="mono">{fmtClock(frame.t)}</span>.
          </>
        }
      />

      <div className="grid12">
        <div className="col-6">
          <section className="card constraint-hero">
            <h2>Current constraint</h2>
            {constraint ? (
              <>
                <div className="constraint-sid mono">{constraint.sid}</div>
                <div className="constraint-name">{constraint.name}</div>
                <div className="constraint-figures">
                  <Figure
                    label="Cycle now"
                    value={`${frame.constraint_cycle.toFixed(0)}s`}
                    tone="amber"
                  />
                  <Figure label="Standard" value={`${standard.toFixed(0)}s`} />
                  <Figure
                    label="Over standard"
                    value={overStandard > 0 ? `+${overStandard}s` : "on standard"}
                    tone={overStandard > 0 ? "amber" : "green"}
                  />
                </div>
              </>
            ) : (
              <p className="faint">
                No binding constraint — the line is balanced against takt.
              </p>
            )}
          </section>
        </div>

        <div className="col-6">
          <section className="card">
            <h2>Impact right now</h2>
            <div className="constraint-figures">
              <Figure
                label="Sustained rate loss"
                value={`${frame.rate_loss > 0 ? "+" : ""}${frame.rate_loss.toFixed(1)}`}
                sub="bodies/hr vs takt"
                tone={frame.rate_loss > 3 ? "red" : frame.rate_loss > 0.5 ? "amber" : "green"}
              />
              <Figure
                label="Deficit"
                value={`${deficit}`}
                sub="bodies behind plan"
                tone={deficit > 0 ? "amber" : "green"}
              />
              <Figure
                label="Runway"
                value={frame.runway_min ? `${frame.runway_min.toFixed(0)}m` : "—"}
                sub="until visible at end of line"
              />
            </div>
          </section>
        </div>

        <div className="col-6">
          <section className="card">
            <h2>Stations disrupted now ({disrupted.length})</h2>
            {disrupted.length === 0 ? (
              <p className="faint">Every station is working — no starve or block.</p>
            ) : (
              <table className="datatable">
                <thead>
                  <tr>
                    <th>Station</th>
                    <th>Zone</th>
                    <th>State</th>
                    <th className="num">Out buffer</th>
                  </tr>
                </thead>
                <tbody>
                  {disrupted.map(({ s, state }) => (
                    <tr key={s.sid}>
                      <td className="mono">{s.sid}</td>
                      <td className="faint">{s.zone}</td>
                      <td>
                        <span
                          className={`state-pill ${state === 1 ? "sp-starved" : "sp-blocked"}`}
                        >
                          {STATE_NAME[state]}
                        </span>
                      </td>
                      <td className="num mono">
                        {frame.buf[s.index]} / {s.out_buffer_cap}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <div className="col-6">
          <section className="card">
            <h2>Forecast flow events — next 30 min</h2>
            {forecasts.length === 0 ? (
              <p className="faint">
                No starvation or blocking predicted inside the forecast horizon.
              </p>
            ) : (
              <table className="datatable">
                <thead>
                  <tr>
                    <th>Station</th>
                    <th>Event</th>
                    <th className="num">In</th>
                  </tr>
                </thead>
                <tbody>
                  {forecasts.slice(0, 12).map(({ s, fc }) => (
                    <tr key={s.sid}>
                      <td className="mono">{s.sid}</td>
                      <td>
                        <span
                          className={`state-pill ${fc[0] === 1 ? "sp-starved" : "sp-blocked"}`}
                        >
                          {fc[0] === 1 ? "runs dry" : "backs up"}
                        </span>
                      </td>
                      <td className="num mono">{fc[1].toFixed(0)} min</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Figure({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
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
    <div className="figure">
      <div className="figure-label">{label}</div>
      <div className="figure-value mono" style={{ color }}>
        {value}
      </div>
      {sub && <div className="figure-sub">{sub}</div>}
    </div>
  );
}
