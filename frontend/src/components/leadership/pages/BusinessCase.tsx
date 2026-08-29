import { useValidationData } from "../../../router";
import { PageHeading } from "../../common/PageHeading";
import { BusinessCasePanel, CameraTable, Phase } from "../parts/panels";

export function LeadershipBusinessCase() {
  const V = useValidationData().validation!;
  return (
    <>
      <PageHeading
        title="Business Case"
        lede="Avoided rework and downtime against a targeted rollout — editable on your plant's numbers."
      />

      <section className="card">
        <h2>Rollout business case</h2>
        <BusinessCasePanel V={V} />
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Retrofit camera — an honest capex finding</h2>
        <CameraTable V={V} />
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Phased rollout</h2>
        <div className="grid g3">
          <Phase
            num="Phase 1 · 0–3 months"
            title="One line, read-only"
            body="Deploy against MES/SCADA and existing barcode scans on a single line. No PLC or control logic touched. Validate propagation and drift alerts against the line's own historical downtime log before any alert reaches a supervisor."
          />
          <Phase
            num="Phase 2 · 3–6 months"
            title="Supervisor rollout + targeted retrofit"
            body="Alerts go live on the floor. Retrofit cameras only at stations the sensor sweep flags as scan-quality poor. Tune alert thresholds against the plant's own precision floor using the self-retuning ledger."
          />
          <Phase
            num="Phase 3 · 6–18 months"
            title="Second line, second plant"
            body="A line is a topology file, not a branch of code — a new line is described rather than ported. The defect-risk models re-fit against the new plant's own history offline, and the alert ledger re-converges on that plant's precision floor by itself. Sites with thinner instrumentation start with wider confidence bands, not with fewer features."
          />
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>What transfers to the next site, and what doesn't</h2>
        <table className="risktable">
          <tbody>
            <tr>
              <td>Transfers unchanged</td>
              <td>
                Propagation, drift and decision logic. No layer above the topology
                references a station by name — lookups go through equipment tier
                and declared process parameters, so a plant whose stations are
                named, ordered, or instrumented differently is the case the layers
                were written for rather than a port of them.
              </td>
            </tr>
            <tr>
              <td>Re-fit per site</td>
              <td>
                The defect-risk coefficients, fitted offline against that plant's
                own shift history — roughly a quarter-hour of compute, no
                engineering. Alert thresholds are not transferred at all: the
                ledger grades its own alerts against the plant's downtime log and
                moves its own floor.
              </td>
            </tr>
            <tr>
              <td>Genuinely new work</td>
              <td>
                One topology file per line — stations, tiers, buffer capacities and
                build mix — and the field mapping from that site's MES and
                historian into the event schema. This is the real per-site cost,
                and it scales with how many distinct systems a plant runs, not with
                how many stations it has.
              </td>
            </tr>
            <tr>
              <td>What we would not claim</td>
              <td>
                That the validation numbers on this page carry to your line. The
                simulator behind them is a stand-in, not fitted to real production
                data. Phase 1 exists precisely to replace these figures with yours
                before anyone is asked to act on an alert.
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
