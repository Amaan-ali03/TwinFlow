import type { ReactNode } from "react";
import { useValidationData } from "../../router";
import type { ValidationProgress } from "../../dataLoader";

/** Blocks every Leadership sub-view until the validation SSE run completes. */
export function ValidationGate({ children }: { children: ReactNode }) {
  const { validation, validationProgress, validationError } = useValidationData();
  if (validationError) return <div className="error">{validationError}</div>;
  if (!validation) return <ValidationLoading progress={validationProgress} />;
  return <>{children}</>;
}

function ValidationLoading({ progress }: { progress: ValidationProgress | null }) {
  const pct = progress ? Math.round((progress.shift / progress.total) * 100) : 0;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1 className="page-title">Running validation…</h1>
          <p className="page-lede">
            8 independently seeded shifts the twin has never seen. This takes about
            a minute.
          </p>
        </div>
      </div>
      <section className="card">
        <div className="valbar">
          <div className="valbar-fill" style={{ width: `${pct}%` }} />
        </div>
        {progress ? (
          <p className="faint mono" style={{ marginTop: 10, fontSize: 12.5 }}>
            Shift {progress.shift} / {progress.total} — recall{" "}
            {(progress.recall * 100).toFixed(0)}%
            {progress.precision !== null
              ? `, precision ${(progress.precision * 100).toFixed(0)}%`
              : ""}
            , {progress.alerts_fired} alerts
            {progress.transient_false_alarms > 0
              ? ` (${progress.transient_false_alarms} transient false alarms)`
              : ""}
          </p>
        ) : (
          <p className="faint" style={{ marginTop: 10 }}>
            Starting validation run…
          </p>
        )}
      </section>
    </>
  );
}
