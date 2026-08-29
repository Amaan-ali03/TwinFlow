import { useDashboardData } from "../../../router";
import { PageHeading } from "../../common/PageHeading";
import { WhatIfPanel } from "../parts/WhatIf";
import { FaultTimeline, LedgerTable } from "../parts/charts";

export function ManagerDiagnostics() {
  const { twin } = useDashboardData();

  return (
    <>
      <PageHeading
        title="Diagnostics"
        lede="Perturb the line and compare the 30-minute forecast; check what the twin caught and when."
      />

      <section className="card">
        <h2>
          What if — planning simulator
          <span className="h2-note">perturb one station's cycle, compare the 30 min forecast</span>
        </h2>
        <WhatIfPanel twin={twin} />
      </section>

      <div className="grid12" style={{ marginTop: 16 }}>
        <div className="col-6">
          <section className="card">
            <h2>Alert ledger by type</h2>
            <LedgerTable twin={twin} />
          </section>
        </div>
        <div className="col-6">
          <section className="card">
            <h2>
              Shift fault timeline
              <span className="h2-note">condition bars, first-alert ticks</span>
            </h2>
            <FaultTimeline twin={twin} />
          </section>
        </div>
      </div>
    </>
  );
}
