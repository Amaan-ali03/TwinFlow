/* ============================= LEADERSHIP ============================= */

const VALIDATION = {
  shifts: 6,
  recall: 1.00,
  precision: 0.757,
  bottleneck_precision: 0.969,
  dark_precision: 1.00,
  defect_precision: 0.267,
  median_lead_gain_min: 181.8,
  spec_never_fired_pct: 50.0,
  median_bodies_protected: 130,
  dark_mae_s: 4.6,
  dark_mape_pct: 7.1,
  buffer_mae_units: 0.63,
};

function buildLeadershipView(){
  const el = document.getElementById('view-leadership');
  const L = TWIN.ledger;
  el.innerHTML = `
    <div class="card hero" style="margin-bottom:16px;">
      <div class="hero-eyebrow">THE CASE IN ONE LINE</div>
      <div class="hero-line">A dashboard reports the level of a buffer. TwinFlow knows it's a tank with a
        measured inflow and outflow, so it can say <em>when</em> it runs dry and <em>which</em> upstream
        station is responsible — <span class="mono">${VALIDATION.median_lead_gain_min.toFixed(0)} min</span>
        before a specification alarm would have fired, on average, across ${VALIDATION.shifts} independently
        seeded shifts it had never seen.</div>
    </div>

    <div class="grid g4" style="margin-bottom:16px;">
      <div class="card kpi kpi-hero"><h2>Fault recall</h2><div class="kpi-val mono">${(VALIDATION.recall*100).toFixed(0)}%</div><div class="kpi-sub">every injected fault type caught, ${VALIDATION.shifts} random shifts</div></div>
      <div class="card kpi kpi-hero"><h2>Bottleneck alert precision</h2><div class="kpi-val mono">${(VALIDATION.bottleneck_precision*100).toFixed(0)}%</div><div class="kpi-sub">confirmed against the plant's own downtime log</div></div>
      <div class="card kpi kpi-hero"><h2>Lead over a spec alarm</h2><div class="kpi-val mono">${VALIDATION.median_lead_gain_min.toFixed(0)}m</div><div class="kpi-sub">median, and in ${VALIDATION.spec_never_fired_pct.toFixed(0)}% of cases the spec alarm never fired at all</div></div>
      <div class="card kpi kpi-hero"><h2>Bodies protected</h2><div class="kpi-val mono">${VALIDATION.median_bodies_protected}</div><div class="kpi-sub">median, per contained drift event — a numbered list, not an open recall</div></div>
    </div>

    <div class="grid g2" style="margin-bottom:16px;">
      <div class="card">
        <h2>Where the belief comes from</h2>
        <div class="beliefstack">
          <div class="belief-row"><div class="belief-label">Dark station work content</div><div class="belief-bar"><div style="width:93%"></div></div><div class="mono faint">${VALIDATION.dark_mae_s.toFixed(1)}s MAE (${VALIDATION.dark_mape_pct.toFixed(0)}%)</div></div>
          <div class="belief-row"><div class="belief-label">Buffer reconstruction</div><div class="belief-bar"><div style="width:96%"></div></div><div class="mono faint">${VALIDATION.buffer_mae_units.toFixed(2)} units MAE</div></div>
          <div class="belief-row"><div class="belief-label">Bottleneck alert precision</div><div class="belief-bar"><div style="width:${(VALIDATION.bottleneck_precision*100).toFixed(0)}%"></div></div><div class="mono faint">${(VALIDATION.bottleneck_precision*100).toFixed(0)}%</div></div>
          <div class="belief-row"><div class="belief-label">Dark station alert precision</div><div class="belief-bar"><div style="width:${(VALIDATION.dark_precision*100).toFixed(0)}%"></div></div><div class="mono faint">${(VALIDATION.dark_precision*100).toFixed(0)}%</div></div>
          <div class="belief-row"><div class="belief-label">Defect drift precision <span class="faint">(calibration in progress)</span></div><div class="belief-bar warn"><div style="width:${(VALIDATION.defect_precision*100).toFixed(0)}%"></div></div><div class="mono faint">${(VALIDATION.defect_precision*100).toFixed(0)}%</div></div>
        </div>
        <div class="faint" style="margin-top:10px;font-size:12px;">Every number here is scored after the fact against the plant's own downtime log and quality
        dispositions — never against the twin's own belief. The defect-drift figure is our honest weak
        point and the next validated iteration, not a number we're hiding: early-shift alerts on a
        genuine drift can under-call before enough bodies accumulate to prove materiality. The fix in
        motion is a calibrated fallout model instead of a sigma threshold.</div>
      </div>

      <div class="card">
        <h2>Retrofit camera — an honest capex finding</h2>
        <p class="dim" style="font-size:13.5px;line-height:1.55;margin-top:0;">The Round 1 pitch proposed a webcam at every dark station. The validated result says something more
        specific and cheaper to build:</p>
        <table class="camtable">
          <thead><tr><th>Barcode scan quality</th><th>Without camera</th><th>With camera</th></tr></thead>
          <tbody>
            <tr><td>Normal (≈1–5% miss rate)</td><td class="mono">4.5s MAE</td><td class="mono">4.6s MAE</td></tr>
            <tr><td>Degraded (15% miss rate)</td><td class="mono">4.6s MAE</td><td class="mono">4.7s MAE</td></tr>
            <tr><td>Poor (30%+ miss rate)</td><td class="mono">4.8s MAE</td><td class="mono" style="color:var(--andon-green)">4.7s MAE ↓</td></tr>
            <tr><td>Very poor (50% miss rate)</td><td class="mono">5.0s MAE</td><td class="mono" style="color:var(--andon-green)">4.9s MAE ↓</td></tr>
          </tbody>
        </table>
        <p class="faint" style="font-size:12px;margin-bottom:0;">Hand off timing from existing barcode scans is sufficient on its own for most dark stations.
        Cameras earn their keep only where scan coverage is already poor — recommend a targeted retrofit
        of 2–3 cameras per line, not blanket coverage, cutting the proposed hardware spend by roughly 70%.</p>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <h2>Phased rollout</h2>
      <div class="grid g3">
        <div class="phase">
          <div class="phase-num">Phase 1 · 0–3 months</div>
          <div class="phase-title">One line, read-only</div>
          <p>Deploy against MES/SCADA and existing barcode scans on a single line. No PLC or control logic
          touched. Validate propagation and drift alerts against the line's own historical downtime log
          before any alert reaches a supervisor.</p>
        </div>
        <div class="phase">
          <div class="phase-num">Phase 2 · 3–6 months</div>
          <div class="phase-title">Supervisor rollout + targeted retrofit</div>
          <p>Alerts go live on the floor. Retrofit cameras only at stations the sensor sweep flags as
          scan-quality poor. Tune alert thresholds against the plant's own precision floor using the
          self-retuning ledger.</p>
        </div>
        <div class="phase">
          <div class="phase-num">Phase 3 · 6–12 months</div>
          <div class="phase-title">Multi-line, multi-site</div>
          <p>Re-fit station tiers and baselines per site during scheduled maintenance windows only. The
          five-layer architecture is topology-agnostic — a new line means a new station list, not new
          code.</p>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Key risks &amp; mitigations</h2>
      <table class="risktable">
        <tbody>
          <tr><td>False alarms erode floor trust</td><td>Every alert is self-graded against the plant's own outcome record; precision below a floor auto-raises the threshold for that alert type.</td></tr>
          <tr><td>Inference at dark stations is wrong</td><td>Every dark-station estimate carries a confidence score derived from its method (direct PLC 99%, clean hand-off 85%, camera-assisted 62%, bounded 35%) and risk scoring discounts low-confidence evidence.</td></tr>
          <tr><td>Recommendation gets treated as automatic control</td><td>Twin has no write path to any PLC. Every output is a risk score, evidence, a named action and an owner — a human decides.</td></tr>
          <tr><td>Site-to-site variation in layout and sensor maturity</td><td>Station list, tiers and buffer capacities are the only per-site inputs; the propagation, drift, genealogy and decision layers carry over unchanged.</td></tr>
        </tbody>
      </table>
    </div>
  `;
}
