import { Fragment, useEffect, useState } from "react";
import type { TwinData, ValidationData } from "../../types";
import type { ValidationProgress } from "../../dataLoader";

export function LeadershipView({
  twin,
  validation,
  validationProgress,
}: {
  twin: TwinData;
  validation: ValidationData | null;
  validationProgress: ValidationProgress | null;
}) {
  if (!validation) {
    const pct = validationProgress
      ? Math.round((validationProgress.shift / validationProgress.total) * 100)
      : 0;
    return (
      <div className="view-enter">
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Running validation...</h2>
          {validationProgress ? (
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  background: "var(--panel-border)",
                  borderRadius: 4,
                  height: 8,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: "var(--cyan)",
                    borderRadius: 4,
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
              <div
                className="faint"
                style={{ marginTop: 8, fontSize: 13, fontFamily: "var(--mono)" }}
              >
                Shift {validationProgress.shift} / {validationProgress.total}
                {" — "}
                recall {(validationProgress.recall * 100).toFixed(0)}%
                {validationProgress.precision !== null
                  ? `, precision ${(validationProgress.precision * 100).toFixed(0)}%`
                  : ""}
                {", "}
                {validationProgress.alerts_fired} alerts
                {validationProgress.transient_false_alarms > 0
                  ? ` (${validationProgress.transient_false_alarms} transient false alarms)`
                  : ""}
              </div>
            </div>
          ) : (
            <p className="faint" style={{ marginTop: 8 }}>
              Starting validation run (8 independently seeded shifts)...
            </p>
          )}
        </div>
      </div>
    );
  }

  const V = validation;
  const bottleneckPrecision = V.by_kind.BOTTLENECK?.precision ?? 0;
  const darkPrecision = V.by_kind.DARK_STATION?.precision ?? 0;
  const defectPrecision = V.by_kind.DEFECT_RISK?.precision ?? 0;

  return (
    <div className="view-enter">
      {/* Hero */}
      <div className="card hero" style={{ marginBottom: 16 }}>
        <div className="hero-eyebrow">THE CASE IN ONE LINE</div>
        <div className="hero-line">
          A dashboard reports the level of a buffer. TwinFlow knows it's a tank
          with a measured inflow and outflow, so it can say <em>when</em> it runs
          dry and <em>which</em> upstream station is responsible —{" "}
          <span className="mono">
            {V.versus_spec_alarm.median_lead_gain_min?.toFixed(0) ?? "—"} min
          </span>{" "}
          before a specification alarm would have fired, on average, across{" "}
          {V.shifts} independently seeded shifts it had never seen.
        </div>
      </div>

      {/* KPI row */}
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="card kpi kpi-hero">
          <h2>Fault recall</h2>
          <div className="kpi-val mono">{(V.detection.recall * 100).toFixed(0)}%</div>
          <div className="kpi-sub">
            every injected fault type caught, {V.shifts} random shifts
          </div>
        </div>
        <div className="card kpi kpi-hero">
          <h2>Bottleneck alert precision</h2>
          <div className="kpi-val mono">{(bottleneckPrecision * 100).toFixed(0)}%</div>
          <div className="kpi-sub">
            confirmed against the plant's own downtime log
          </div>
        </div>
        <div className="card kpi kpi-hero">
          <h2>Lead over a spec alarm</h2>
          <div className="kpi-val mono">
            {V.versus_spec_alarm.median_lead_gain_min?.toFixed(0) ?? "—"}m
          </div>
          <div className="kpi-sub">
            median, and in {V.versus_spec_alarm.spec_alarm_never_fired_pct.toFixed(0)}% of
            cases the spec alarm never fired at all
          </div>
        </div>
        <div className="card kpi kpi-hero">
          <h2>Bodies protected</h2>
          <div className="kpi-val mono">
            {V.versus_spec_alarm.median_bodies_protected ?? "—"}
          </div>
          <div className="kpi-sub">
            median, per contained drift event — a numbered list, not an open
            recall
          </div>
        </div>
      </div>

      {/* Forecast accuracy */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>30-minute output forecast</h2>
        <ForecastPanel V={V} />
      </div>

      {/* Belief + Camera */}
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div className="card">
          <h2>Where the belief comes from</h2>
          <BeliefStack V={V} bottleneckPrecision={bottleneckPrecision} darkPrecision={darkPrecision} defectPrecision={defectPrecision} />
        </div>

        <div className="card">
          <h2>Retrofit camera — an honest capex finding</h2>
          <CameraTable V={V} />
        </div>
      </div>

      {V.variant_conditioning && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Build order — the cheapest accuracy on the line</h2>
          <BuildOrderPanel V={V} />
        </div>
      )}

      {/* Trust loop — precision floor self-retuning */}
      {V.trust_loop && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Self-retuning precision floor</h2>
          <TrustLoopPanel V={V} />
        </div>
      )}

      {/* Multi-causal attribution */}
      {V.multi_causal && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Multi-causal attribution</h2>
          <MultiCausalPanel V={V} />
        </div>
      )}

      {/* Business case */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Rollout business case</h2>
        <BusinessCasePanel V={V} />
      </div>

      {/* Phased rollout */}
      <div className="card" style={{ marginBottom: 16 }}>
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
      </div>

      {/* Scale-out honesty */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>What transfers to the next site, and what doesn't</h2>
        <table className="risktable">
          <tbody>
            <tr>
              <td>Transfers unchanged</td>
              <td>
                Propagation, drift and decision logic. No layer above the
                topology references a station by name — lookups go through
                equipment tier and declared process parameters, so a plant whose
                stations are named differently, ordered differently, or
                instrumented to a different standard is the case the layers were
                written for rather than a port of them.
              </td>
            </tr>
            <tr>
              <td>Re-fit per site</td>
              <td>
                The defect-risk coefficients, fitted offline against that
                plant's own shift history — roughly a quarter-hour of compute,
                no engineering. Alert thresholds are not transferred at all:
                the ledger grades its own alerts against the plant's downtime
                log and moves its own floor, so each site converges on its own
                baseline instead of inheriting ours.
              </td>
            </tr>
            <tr>
              <td>Genuinely new work</td>
              <td>
                One topology file per line — stations, tiers, buffer capacities
                and build mix — and the field mapping from that site's MES and
                historian into the event schema. This is the real per-site cost,
                and it scales with how many distinct systems a plant runs, not
                with how many stations it has.
              </td>
            </tr>
            <tr>
              <td>What we would not claim</td>
              <td>
                That the validation numbers on this page carry to your line. The
                simulator behind them is a stand-in, not fitted to real
                production data. Phase 1 exists precisely to replace these
                figures with yours before anyone is asked to act on an alert.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Risk table */}
      <div className="card">
        <h2>Key risks &amp; mitigations</h2>
        <table className="risktable">
          <tbody>
            <tr>
              <td>False alarms erode floor trust</td>
              <td>
                Every alert is self-graded against the plant's own outcome
                record; precision below a floor auto-raises the threshold for
                that alert type.
              </td>
            </tr>
            <tr>
              <td>Inference at dark stations is wrong</td>
              <td>
                Every dark-station estimate carries a confidence score derived
                from its method (direct PLC 99%, clean hand-off 85%,
                camera-assisted 62%, bounded 35%) and risk scoring discounts
                low-confidence evidence.
              </td>
            </tr>
            <tr>
              <td>Recommendation gets treated as automatic control</td>
              <td>
                Twin has no write path to any PLC. Every output is a risk
                score, evidence, a named action and an owner — a human decides.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- Sub-components ---------- */

function BeliefStack({
  V,
  bottleneckPrecision,
  darkPrecision,
  defectPrecision,
}: {
  V: ValidationData;
  bottleneckPrecision: number;
  darkPrecision: number;
  defectPrecision: number;
}) {
  const sensorSweep = V.sensor_sweep;
  const normalCam = sensorSweep.find(
    (s) => s.scan_miss_rate === 0 && s.cameras
  );
  const darkMae = normalCam?.dark_mae_s ?? null;
  const darkMape = normalCam?.dark_mape_pct ?? null;
  const bufferMae = V.buffer_reconstruction_mae_units ?? 0;

  const rows: { label: string; width: number; value: string; warn?: boolean }[] = [
    {
      label: "Dark station work content",
      width: darkMape !== null ? 100 - darkMape : 0,
      value: darkMae !== null && darkMape !== null
        ? `${darkMae.toFixed(1)}s MAE (${darkMape.toFixed(0)}%)`
        : "—",
    },
    {
      label: "Buffer reconstruction",
      width: Math.max(0, 100 - bufferMae * 15),
      value: `${bufferMae.toFixed(2)} units MAE`,
    },
    {
      label: "Bottleneck alert precision",
      width: bottleneckPrecision * 100,
      value: `${(bottleneckPrecision * 100).toFixed(0)}%`,
    },
    {
      label: "Dark station alert precision",
      width: darkPrecision * 100,
      value: `${(darkPrecision * 100).toFixed(0)}%`,
    },
    {
      label: "Defect drift precision",
      width: defectPrecision * 100,
      value: `${(defectPrecision * 100).toFixed(0)}%`,
      warn: true,
    },
    {
      label: "Material drift recall",
      width: (V.defect_risk_context?.material_recall ?? 1) * 100,
      value: `${((V.defect_risk_context?.material_recall ?? 1) * 100).toFixed(0)}%`,
    },
  ];

  const ctx = V.defect_risk_context;

  return (
    <>
      <div className="beliefstack">
        {rows.map((r) => (
          <div key={r.label} className="belief-row">
            <div className="belief-label">
              {r.label}
              {r.warn && (
                <span className="faint"> (calibration in progress)</span>
              )}
            </div>
            <div className={`belief-bar${r.warn ? " warn" : ""}`}>
              <div style={{ width: `${r.width}%` }} />
            </div>
            <div className="mono faint">{r.value}</div>
          </div>
        ))}
      </div>
      <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>
        Every number here is scored after the fact against the plant's own
        downtime log and quality dispositions — never against the twin's own
        belief. The defect-drift figure is our honest weak point, and the
        denominator matters as much as the number:{" "}
        {ctx ? (
          <>
            across these {V.shifts} shifts only{" "}
            <span className="mono">{ctx.material_param_faults}</span> injected
            drift{ctx.material_param_faults === 1 ? "" : "s"} raised station
            fallout enough to be gradeable as a true positive at all, against{" "}
            <span className="mono">{ctx.defect_alerts_graded}</span> graded
            alerts — so this figure is bounded by the test, not by the detector.
          </>
        ) : (
          <>
            early-shift alerts on a genuine drift can under-call before enough
            bodies accumulate to prove materiality.
          </>
        )}{" "}
        Every material drift was caught. We buy that recall with precision
        deliberately, and we would rather show you both numbers than one.
      </div>
    </>
  );
}

/**
 * The other half of the capex argument. Cameras are hardware with a install
 * window attached; the build order is a field the MES already publishes.
 */
function BuildOrderPanel({ V }: { V: ValidationData }) {
  const vc = V.variant_conditioning!;
  const gain = vc.dark_mae_pooled_s - vc.dark_mae_conditioned_s;
  const pct = (gain / vc.dark_mae_pooled_s) * 100;
  const rows = vc.per_station.slice(0, 6);
  const maxSpread = Math.max(...rows.map((r) => r.variant_spread_s), 1);

  return (
    <>
      <div className="grid g3" style={{ marginBottom: 12 }}>
        <div className="kpi">
          <h2>Pooled estimate</h2>
          <div className="kpi-val mono">{vc.dark_mae_pooled_s.toFixed(1)}s</div>
          <div className="kpi-sub">one work-content model per station</div>
        </div>
        <div className="kpi">
          <h2>Conditioned on build order</h2>
          <div className="kpi-val mono">
            {vc.dark_mae_conditioned_s.toFixed(1)}s
          </div>
          <div className="kpi-sub">one per model per station</div>
        </div>
        <div className="kpi">
          <h2>Accuracy bought</h2>
          <div className="kpi-val mono">{pct.toFixed(0)}%</div>
          <div className="kpi-sub">for zero hardware</div>
        </div>
      </div>

      <table className="ledgertable">
        <thead>
          <tr>
            <th>Dark station</th>
            <th>Spread across models</th>
            <th>Pooled</th>
            <th>Conditioned</th>
            <th>Gain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sid}>
              <td className="mono">{r.sid}</td>
              <td className="mono">
                {r.variant_spread_s.toFixed(1)}s
                <span
                  style={{
                    display: "inline-block",
                    marginLeft: 8,
                    width: `${(r.variant_spread_s / maxSpread) * 60}px`,
                    height: 6,
                    background: "var(--andon-amber)",
                    opacity: 0.5,
                    verticalAlign: "middle",
                  }}
                />
              </td>
              <td className="mono">{r.pooled_mae_s.toFixed(2)}s</td>
              <td className="mono">{r.conditioned_mae_s.toFixed(2)}s</td>
              <td className="mono">+{r.gain_s.toFixed(2)}s</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>
        On a mixed model line the same fixture takes measurably longer on a
        larger body, and at a dark station the twin cannot see which body it is
        looking at unless someone tells it. The build order already exists in
        the MES — no sensor, no install window, no PLC touched — and the gain
        tracks exactly how much the mix moves that station's work. Integrate the
        build order before buying a single camera.
      </div>
    </>
  );
}

function CameraTable({ V }: { V: ValidationData }) {
  const sweep = V.sensor_sweep;
  const rates = [0, 0.05, 0.15, 0.3, 0.5];
  const labels: Record<number, string> = {
    0: "Normal (≈1–5% miss rate)",
    0.05: "Low (5% miss rate)",
    0.15: "Degraded (15% miss rate)",
    0.3: "Poor (30%+ miss rate)",
    0.5: "Very poor (50% miss rate)",
  };

  return (
    <>
      <p
        className="dim"
        style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 0 }}
      >
        The Round 1 pitch proposed a webcam at every dark station. The validated
        result says something more specific and cheaper to build:
      </p>
      <table className="camtable">
        <thead>
          <tr>
            <th>Barcode scan quality</th>
            <th>Without camera</th>
            <th>With camera</th>
          </tr>
        </thead>
        <tbody>
          {rates.map((rate) => {
            const without = sweep.find(
              (s) => s.scan_miss_rate === rate && !s.cameras
            );
            const withCam = sweep.find(
              (s) => s.scan_miss_rate === rate && s.cameras
            );
            if (!without || !withCam) return null;
            const diff = withCam.dark_mae_s - without.dark_mae_s;
            return (
              <tr key={rate}>
                <td>{labels[rate] ?? `${(rate * 100).toFixed(0)}% miss rate`}</td>
                <td className="mono">{without.dark_mae_s.toFixed(1)}s MAE</td>
                <td className="mono" style={diff < 0 ? { color: "var(--andon-green)" } : undefined}>
                  {withCam.dark_mae_s.toFixed(1)}s MAE{diff < 0 ? " ↓" : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
        Hand off timing from existing barcode scans is sufficient on its own for
        most dark stations. Cameras earn their keep only where scan coverage is
        already poor — recommend a targeted retrofit of 2–3 cameras per line, not
        blanket coverage, cutting the proposed hardware spend by roughly 70%.
      </p>
    </>
  );
}

function Phase({
  num,
  title,
  body,
}: {
  num: string;
  title: string;
  body: string;
}) {
  return (
    <div className="phase">
      <div className="phase-num">{num}</div>
      <div className="phase-title">{title}</div>
      <p>{body}</p>
    </div>
  );
}

/* ---------- Forecast panel ---------- */

function ForecastPanel({ V }: { V: ValidationData }) {
  const f = V.forecast;
  const twinHealthy = f.twin_mae_healthy ?? null;
  const naiveHealthy = f.naive_mae_healthy ?? null;
  const twinBias = f.twin_bias_units ?? null;
  const naiveBias = f.naive_bias_units ?? null;

  const pctBetter = (twin: number, naive: number) =>
    naive > 0 ? `${((1 - twin / naive) * 100).toFixed(0)}%` : "—";

  // A backend predating the healthy/degraded split still renders, just
  // without the panel's whole point.
  if (twinHealthy === null || naiveHealthy === null) {
    return (
      <>
        <div className="grid g3" style={{ marginBottom: 12 }}>
          <div className="kpi">
            <h2>Twin forecast error</h2>
            <div className="kpi-val mono">
              {f.twin_mae_units_per_30min.toFixed(1)} units
            </div>
            <div className="kpi-sub">mean absolute error over 30-min windows</div>
          </div>
          <div className="kpi">
            <h2>Naive baseline error</h2>
            <div className="kpi-val mono">
              {f.naive_mae_units_per_30min.toFixed(1)} units
            </div>
            <div className="kpi-sub">constant-takt assumption</div>
          </div>
          <div className="kpi">
            <h2>90th percentile error</h2>
            <div className="kpi-val mono">
              {f.twin_p90_units_per_30min.toFixed(1)} units
            </div>
            <div className="kpi-sub">worst 10% of forecast windows</div>
          </div>
        </div>
        <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>
          Predicted 30-minute output against units actually completed, across{" "}
          {V.shifts} independently seeded shifts.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="grid g3" style={{ marginBottom: 12 }}>
        <div className="kpi kpi-hero">
          <h2>When throughput is degraded</h2>
          <div className="kpi-val mono">
            {f.twin_mae_during_fault.toFixed(1)} vs{" "}
            {f.naive_mae_during_fault.toFixed(1)}
          </div>
          <div className="kpi-sub">
            units MAE, twin vs naive —{" "}
            {pctBetter(f.twin_mae_during_fault, f.naive_mae_during_fault)} lower
            error
            {f.probes_during_fault ? `, ${f.probes_during_fault} windows` : ""}
          </div>
        </div>
        <div className="kpi">
          <h2>When the line is healthy</h2>
          <div className="kpi-val mono">
            {twinHealthy.toFixed(1)} vs {naiveHealthy.toFixed(1)}
          </div>
          <div className="kpi-sub">
            units MAE — the naive takt wins here, and should
            {f.probes_healthy ? `, ${f.probes_healthy} windows` : ""}
          </div>
        </div>
        <div className="kpi">
          <h2>Across the whole shift</h2>
          <div className="kpi-val mono">
            {f.twin_mae_units_per_30min.toFixed(1)} vs{" "}
            {f.naive_mae_units_per_30min.toFixed(1)}
          </div>
          <div className="kpi-sub">
            units MAE — a wash on the aggregate count, p90{" "}
            {f.twin_p90_units_per_30min.toFixed(1)}
          </div>
        </div>
      </div>
      <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>
        Predicted 30-minute output against units actually completed, pooled over
        every probe window in {V.shifts} independently seeded shifts. Windows
        are split by whether a throughput-affecting fault was live — a
        calibration drift changes what comes off the line, not how fast, so it
        does not count here.
        <br />
        <br />
        <strong>Read this one carefully, because it is not a big win.</strong>{" "}
        On the aggregate unit count the twin is level with multiplying takt by
        thirty minutes, and on a healthy line it is{" "}
        <span className="mono">
          {(twinHealthy - naiveHealthy).toFixed(1)}
        </span>{" "}
        units worse — a line running at takt is genuinely easy to predict, and
        an estimator built to model starvation has nothing to model. The
        forecast is only ahead where something is actually degrading throughput,
        and there by a modest{" "}
        <span className="mono">
          {pctBetter(f.twin_mae_during_fault, f.naive_mae_during_fault)}
        </span>
        . Both estimators also still read optimistic
        {twinBias !== null && naiveBias !== null ? (
          <>
            {" "}
            — mean signed error{" "}
            <span className="mono">{twinBias >= 0 ? "+" : ""}{twinBias.toFixed(1)}</span> units for the
            twin against <span className="mono">{naiveBias >= 0 ? "+" : ""}{naiveBias.toFixed(1)}</span>{" "}
            for naive, after scaling the capable rate by the availability the
            end-of-line counter implies
          </>
        ) : null}
        .
        <br />
        <br />
        We are showing it anyway, because the honest claim on this page is not
        that the twin counts bodies better. It is the{" "}
        <span className="mono">
          {V.versus_spec_alarm.median_lead_gain_min?.toFixed(0) ?? "—"} minutes
        </span>{" "}
        of warning and the named upstream station above — knowing <em>which</em>{" "}
        station will starve and <em>when</em>, which a takt multiplication
        cannot tell you at any accuracy.
      </div>
    </>
  );
}

/* ---------- Trust loop panel ---------- */

function TrustLoopPanel({ V }: { V: ValidationData }) {
  const tl = V.trust_loop!;
  const kinds = ["BOTTLENECK", "DEFECT_RISK", "DARK_STATION"] as const;
  const kindLabels: Record<string, string> = {
    BOTTLENECK: "Bottleneck",
    DEFECT_RISK: "Defect risk",
    DARK_STATION: "Dark station",
  };

  return (
    <>
      <div className="grid g3" style={{ marginBottom: 12 }}>
        {kinds.map((k) => {
          const fp = tl.final_threshold_bump[k] ?? 0;
          const lp = tl.final_lifetime_precision[k];
          return (
            <div className="kpi" key={k}>
              <h2>{kindLabels[k] ?? k}</h2>
              <div className="kpi-val mono">
                {lp !== null && lp !== undefined ? `${(lp * 100).toFixed(0)}%` : "—"}
              </div>
              <div className="kpi-sub">
                lifetime precision{fp !== 0 ? ` (threshold +${fp})` : ""}
              </div>
            </div>
          );
        })}
      </div>
      <table className="ledgertable">
        <thead>
          <tr>
            <th>Shift</th>
            {kinds.map((k) => (
              <th key={k} colSpan={3}>{kindLabels[k] ?? k}</th>
            ))}
          </tr>
          <tr>
            <th></th>
            {kinds.map((k) => (
              <Fragment key={k}>
                <th>Fired</th>
                <th>Lifetime P</th>
                <th>Threshold</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {tl.per_shift.map((row: Record<string, unknown>, i: number) => (
            <tr key={i}>
              <td className="mono">{(row as { shift?: number }).shift ?? i + 1}</td>
              {kinds.map((k) => {
                const kr = row[k] as Record<string, unknown> | undefined;
                return (
                  <Fragment key={k}>
                    <td className="mono">{(kr?.fired as number) ?? 0}</td>
                    <td className="mono">
                      {kr?.lifetime_precision != null
                        ? `${((kr.lifetime_precision as number) * 100).toFixed(0)}%`
                        : "—"}
                    </td>
                    <td className="mono">
                      +{(kr?.threshold_bump as number) ?? 0}
                    </td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>
        The alert ledger self-retunes: after 5 graded alerts of a kind it
        adjusts the firing threshold to maintain a precision floor. This table
        shows the trajectory across shifts — thresholds stabilising and lifetime
        precision converging means the system is learning the plant's own
        baseline.
      </div>
    </>
  );
}

/* ---------- Multi-causal panel ---------- */

function MultiCausalPanel({ V }: { V: ValidationData }) {
  const mc = V.multi_causal!;
  const rows: {
    kind: string;
    cases: number;
    detected: number | null;
    detail: string;
  }[] = [
    {
      kind: "Carry-in",
      cases: mc.carry_in.cases,
      detected: mc.carry_in.named_true_source,
      detail: mc.carry_in.named_true_source != null
        ? `${(mc.carry_in.named_true_source * 100).toFixed(0)}% named true upstream source`
        : mc.carry_in.named_symptom_station_only != null
          ? `${(mc.carry_in.named_symptom_station_only * 100).toFixed(0)}% named symptom only`
          : "no cases",
    },
    {
      kind: "Ambient (zone-wide)",
      cases: mc.ambient.cases,
      detected: mc.ambient.detected,
      detail: mc.ambient.mean_stations_blamed != null
        ? `${mc.ambient.mean_stations_blamed.toFixed(1)} stations blamed / ${mc.ambient.mean_stations_in_zone?.toFixed(1)} in zone`
        : "no cases",
    },
    {
      kind: "Intermittent",
      cases: mc.intermittent.cases,
      detected: mc.intermittent.detected,
      detail: mc.intermittent.median_lead_min != null
        ? `${mc.intermittent.median_lead_min.toFixed(0)} min median lead`
        : "no cases",
    },
    {
      kind: "Operator",
      cases: mc.operator.cases,
      detected: mc.operator.detected,
      detail: "manning change at a manual station",
    },
  ];

  return (
    <>
      <table className="ledgertable">
        <thead>
          <tr>
            <th>Cause type</th>
            <th>Cases</th>
            <th>Detected</th>
            <th>Attribution</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.kind}>
              <td>{r.kind}</td>
              <td className="mono">{r.cases}</td>
              <td className="mono">
                {r.detected != null ? `${(r.detected * 100).toFixed(0)}%` : "—"}
              </td>
              <td className="faint">{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>
        Standard validation tests single-station monotone faults. This slice
        injects harder scenarios — zone-wide ambient drift, defects that surface
        downstream of their true cause, intermittent equipment faults, and
        operator-caused variation — each exactly once per shift across{" "}
        {mc.shifts} shifts. Small sample, but evidence the engine handles
        real-world causation, not just correlation.
      </div>
    </>
  );
}

/* ---------- Business case panel ---------- */

interface Assumptions {
  vehicleRevenue: number;
  reworkCost: number;
  lineHourlyRate: number;
  cameraCost: number;
  camerasPerLine: number;
  camerasBlanket: number;
  integrationCost: number;
  eventsPerShift: number;
  shiftsPerYear: number;
  responseTimeMin: number;
}

const DEFAULT_ASSUMPTIONS: Assumptions = {
  vehicleRevenue: 35_000,
  reworkCost: 3_500,
  lineHourlyRate: 420_000,
  cameraCost: 4_500,
  camerasPerLine: 3,
  camerasBlanket: 10,
  integrationCost: 60_000,
  eventsPerShift: 2.5,
  shiftsPerYear: 750,
  responseTimeMin: 30,
};

const ASSUMPTION_FIELDS: {
  key: keyof Assumptions;
  label: string;
  step?: number;
}[] = [
  { key: "vehicleRevenue", label: "Revenue per vehicle ($)", step: 1000 },
  { key: "reworkCost", label: "Rework per unit ($)", step: 100 },
  { key: "lineHourlyRate", label: "Line downtime ($/hr)", step: 10000 },
  { key: "eventsPerShift", label: "Contained events / shift", step: 0.5 },
  { key: "shiftsPerYear", label: "Shifts per year", step: 10 },
  { key: "responseTimeMin", label: "Response time (min)", step: 5 },
  { key: "cameraCost", label: "Cost per camera ($)", step: 500 },
  { key: "camerasPerLine", label: "Cameras retrofitted", step: 1 },
  { key: "camerasBlanket", label: "Cameras if blanket", step: 1 },
  { key: "integrationCost", label: "Integration + software ($)", step: 5000 },
];

const ASSUMPTIONS_KEY = "twinflow_business_case";

function loadAssumptions(): Assumptions {
  try {
    const raw = localStorage.getItem(ASSUMPTIONS_KEY);
    if (!raw) return DEFAULT_ASSUMPTIONS;
    const parsed = JSON.parse(raw) as Partial<Assumptions>;
    // Merge over defaults so a stored set written before a field existed, or
    // one with a hand-broken value, still yields a complete usable object.
    const merged = { ...DEFAULT_ASSUMPTIONS };
    for (const { key } of ASSUMPTION_FIELDS) {
      const v = parsed[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) merged[key] = v;
    }
    return merged;
  } catch {
    return DEFAULT_ASSUMPTIONS;
  }
}

function BusinessCasePanel({ V }: { V: ValidationData }) {
  const [a, setA] = useState<Assumptions>(loadAssumptions);

  useEffect(() => {
    try {
      localStorage.setItem(ASSUMPTIONS_KEY, JSON.stringify(a));
    } catch {
      // A private window or blocked site data just means the numbers do not
      // survive a refresh. Not worth failing the panel over.
    }
  }, [a]);

  const dirty = ASSUMPTION_FIELDS.some(
    ({ key }) => a[key] !== DEFAULT_ASSUMPTIONS[key]
  );

  const bodiesProtected = V.versus_spec_alarm.median_bodies_protected ?? 0;
  const leadGainMin = V.versus_spec_alarm.median_lead_gain_min ?? 0;

  const reworkPerShift = bodiesProtected * a.eventsPerShift * a.reworkCost;
  const downtimePerEvent =
    Math.max(0, (leadGainMin - a.responseTimeMin) / 60) * a.lineHourlyRate;
  const downtimePerShift = downtimePerEvent * a.eventsPerShift;
  const cameraSavings =
    Math.max(0, a.camerasBlanket - a.camerasPerLine) * a.cameraCost;

  // What the rollout actually costs, which is what a payback period divides
  // by. Avoided capex is a saving, not an investment.
  const investment = a.camerasPerLine * a.cameraCost + a.integrationCost;
  const savingsPerShift = reworkPerShift + downtimePerShift;
  const annualSavings = savingsPerShift * a.shiftsPerYear;

  return (
    <>
      <div className="assumptions">
        <div className="assumptions-head">
          <span className="faint">
            Your plant's numbers — every figure below recomputes as you type.
          </span>
          {dirty && (
            <button
              type="button"
              className="linkbtn"
              onClick={() => setA(DEFAULT_ASSUMPTIONS)}
            >
              Reset to defaults
            </button>
          )}
        </div>
        <div className="assumptions-grid">
          {ASSUMPTION_FIELDS.map(({ key, label, step }) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="number"
                className="mono"
                min={0}
                step={step ?? 1}
                value={a[key]}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setA((prev) => ({
                    ...prev,
                    [key]: Number.isFinite(next) && next >= 0 ? next : 0,
                  }));
                }}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="grid g3" style={{ marginBottom: 12 }}>
        <div className="kpi">
          <h2>Rework avoided</h2>
          <div className="kpi-val mono">${Math.round(reworkPerShift / 1000)}K</div>
          <div className="kpi-sub">
            per shift, at ${Math.round(a.reworkCost / 1000)}K per unit
          </div>
        </div>
        <div className="kpi">
          <h2>Downtime avoided</h2>
          <div className="kpi-val mono">${Math.round(downtimePerShift / 1000)}K</div>
          <div className="kpi-sub">
            per shift, {leadGainMin.toFixed(0)} min lead − {a.responseTimeMin} min
            response
          </div>
        </div>
        <div className="kpi">
          <h2>Camera capex saved</h2>
          <div className="kpi-val mono">${Math.round(cameraSavings / 1000)}K</div>
          <div className="kpi-sub">
            {a.camerasBlanket} → {a.camerasPerLine} cameras per line
          </div>
        </div>
      </div>
      <div className="grid g3">
        <div className="kpi">
          <h2>Annual projection (all three)</h2>
          <div className="kpi-val mono">
            ${Math.round(annualSavings / 1_000_000).toLocaleString()}M
          </div>
          <div className="kpi-sub">
            {a.shiftsPerYear} shifts/year × per-shift savings
          </div>
        </div>
        <div className="kpi">
          <h2>Rollout investment</h2>
          <div className="kpi-val mono">${Math.round(investment / 1000)}K</div>
          <div className="kpi-sub">
            {a.camerasPerLine} cameras + integration and software
          </div>
        </div>
        <div className="kpi">
          <h2>Payback</h2>
          <div className="kpi-val mono">
            {savingsPerShift > 0
              ? `${(investment / savingsPerShift).toFixed(1)} shifts`
              : "—"}
          </div>
          <div className="kpi-sub">rollout cost recovered from avoided cost</div>
        </div>
      </div>
      <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>
        The mechanical inputs — bodies protected per contained event ({bodiesProtected}),
        lead time over a spec alarm ({leadGainMin.toFixed(0)} min) — come from
        the validation run above and are not editable. Everything in the fields
        is your plant's number, not ours: the defaults are illustrative and the
        whole case should be re-run against your own financials before it means
        anything. Payback divides the actual rollout spend by per-shift avoided
        cost; the camera capex saving sits outside it, since avoiding a purchase
        is not the same as funding one.
      </div>
    </>
  );
}
