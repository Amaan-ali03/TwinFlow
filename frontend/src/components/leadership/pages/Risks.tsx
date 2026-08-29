import { PageHeading } from "../../common/PageHeading";

export function LeadershipRisks() {
  return (
    <>
      <PageHeading
        title="Risks & Mitigations"
        lede="What could go wrong, and the safeguard that holds each one."
      />

      <section className="card">
        <h2>Key risks &amp; mitigations</h2>
        <table className="risktable">
          <tbody>
            <tr>
              <td>False alarms erode floor trust</td>
              <td>
                Every alert is self-graded against the plant's own outcome record;
                precision below a floor auto-raises the threshold for that alert
                type. The retune loop is shown on the Reliability page.
              </td>
            </tr>
            <tr>
              <td>Inference at dark stations is wrong</td>
              <td>
                Every dark-station estimate carries a confidence score derived from
                its method (direct PLC 99%, clean hand-off 85%, camera-assisted
                62%, bounded 35%) and risk scoring discounts low-confidence
                evidence.
              </td>
            </tr>
            <tr>
              <td>Recommendation gets treated as automatic control</td>
              <td>
                The twin has no write path to any PLC. Every output is a risk
                score, evidence, a named action and an owner — a human decides.
              </td>
            </tr>
            <tr>
              <td>Model confidence is overstated</td>
              <td>
                Defect-drift alert precision is ~24% by design (recall is 100%);
                the page says so rather than leading with a flattering number, and
                the offline-fitted model is attached as an evidence line, not a
                firing gate.
              </td>
            </tr>
            <tr>
              <td>Numbers here don't transfer to your line</td>
              <td>
                The simulator is a stand-in, not fitted to production data. Phase 1
                is read-only and exists to replace every figure on these pages with
                the plant's own before an alert reaches a supervisor.
              </td>
            </tr>
            <tr>
              <td>Auditability</td>
              <td>
                Every alert keeps its evidence, falsifier, owner and verify-by
                time, and is later graded TRUE/FALSE against the downtime and
                quality log — the full ledger is inspectable per shift and across
                the week.
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
