import { useValidationData } from "../../../router";
import { PageHeading } from "../../common/PageHeading";
import { MultiCausalPanel, BuildOrderPanel } from "../parts/panels";

export function LeadershipRootCause() {
  const V = useValidationData().validation!;
  return (
    <>
      <PageHeading
        title="Root Cause"
        lede="Attribution under causes that are not single-station and monotone — carry-in, ambient, intermittent, operator."
      />

      {V.multi_causal && (
        <section className="card">
          <h2>Multi-causal attribution</h2>
          <MultiCausalPanel V={V} />
        </section>
      )}

      {V.variant_conditioning && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Build order — the cheapest accuracy on the line</h2>
          <BuildOrderPanel V={V} />
        </section>
      )}
    </>
  );
}
