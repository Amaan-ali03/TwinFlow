import { useValidationData } from "../../../router";
import { PageHeading } from "../../common/PageHeading";
import { BeliefStack, TrustLoopPanel } from "../parts/panels";

export function LeadershipReliability() {
  const V = useValidationData().validation!;
  const bottleneckPrecision = V.by_kind.BOTTLENECK?.precision ?? 0;
  const darkPrecision = V.by_kind.DARK_STATION?.precision ?? 0;
  const defectPrecision = V.by_kind.DEFECT_RISK?.precision ?? 0;

  return (
    <>
      <PageHeading
        title="Reliability"
        lede="Where belief comes from, and how the alert ledger retunes its own precision floor."
      />

      <section className="card">
        <h2>Where the belief comes from</h2>
        <BeliefStack
          V={V}
          bottleneckPrecision={bottleneckPrecision}
          darkPrecision={darkPrecision}
          defectPrecision={defectPrecision}
        />
      </section>

      {V.trust_loop && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Self-retuning precision floor</h2>
          <TrustLoopPanel V={V} />
        </section>
      )}
    </>
  );
}
