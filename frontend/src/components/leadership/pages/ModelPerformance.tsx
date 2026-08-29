import { useValidationData } from "../../../router";
import { PageHeading } from "../../common/PageHeading";
import { ForecastPanel } from "../parts/panels";

export function LeadershipModelPerformance() {
  const V = useValidationData().validation!;
  return (
    <>
      <PageHeading
        title="Model Performance"
        lede="The 30-minute output forecast, scored on a healthy/degraded split against a constant-takt baseline."
      />
      <section className="card">
        <h2>30-minute output forecast</h2>
        <ForecastPanel V={V} />
      </section>
    </>
  );
}
