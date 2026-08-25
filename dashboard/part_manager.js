/* ============================= PLANT MANAGER ============================= */

function svg(w,h,inner){ return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${inner}</svg>`; }

function buildManagerView(){
  const el = document.getElementById('view-manager');
  const L = TWIN.ledger;
  el.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px;">
      <div class="card kpi"><h2>Bodies completed</h2><div class="kpi-val mono">${TWIN.meta.n_completed}</div><div class="kpi-sub">of an 8 hour shift</div></div>
      <div class="card kpi"><h2>Quality fallout</h2><div class="kpi-val mono">${TWIN.meta.n_fails}</div><div class="kpi-sub">of ${TWIN.meta.n_quality_checks} inspections (${(100*TWIN.meta.n_fails/TWIN.meta.n_quality_checks).toFixed(1)}%)</div></div>
      <div class="card kpi"><h2>Alert precision</h2><div class="kpi-val mono">${L.precision_all!=null? (L.precision_all*100).toFixed(0)+'%':'—'}</div><div class="kpi-sub">${L.total} alerts fired, graded against outcomes</div></div>
      <div class="card kpi"><h2>Sensor coverage</h2><div class="kpi-val mono">${TWIN.meta.tiers.A}/${TWIN.meta.tiers.B}/${TWIN.meta.tiers.C}</div><div class="kpi-sub">full / cycle-only / dark stations</div></div>
    </div>

    <div class="grid g2" style="margin-bottom:16px;">
      <div class="card">
        <h2>Throughput — bodies rolled out, 10 min buckets</h2>
        <div id="throughputChart"></div>
      </div>
      <div class="card">
        <h2>Quality fallout by origin station <span class="faint" style="text-transform:none;font-weight:400;">— traced by genealogy backtrace, not by where it was caught</span></h2>
        <div id="originChart"></div>
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:16px;">
      <div class="card">
        <h2>Alert ledger by type</h2>
        <div id="ledgerTable"></div>
      </div>
      <div class="card">
        <h2>Shift fault timeline <span class="faint" style="text-transform:none;font-weight:400;">— what actually happened vs. when the twin flagged it</span></h2>
        <div id="faultTimeline"></div>
      </div>
    </div>

    <div class="card">
      <h2>Sensor tier mix by zone</h2>
      <div id="zoneMix"></div>
    </div>
  `;
  renderThroughputChart();
  renderOriginChart();
  renderLedgerTable();
  renderFaultTimeline();
  renderZoneMix();
}

function renderThroughputChart(){
  const data = TWIN.throughput_series;
  const w=760,h=190,pad=34;
  const maxY = Math.max(...data.map(d=>d[1]), 1) * 1.15;
  const xw = (w-pad*1.2-14) / (data.length-1);
  const pts = data.map((d,i)=>{
    const x = pad + i*xw;
    const y = h-pad - (d[1]/maxY)*(h-pad-14);
    return [x,y];
  });
  const line = pts.map((p,i)=> (i===0?'M':'L')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area = line + ` L ${pts[pts.length-1][0].toFixed(1)} ${h-pad} L ${pts[0][0].toFixed(1)} ${h-pad} Z`;

  // fault window shading
  let bands = '';
  TWIN.fault_windows.forEach(f=>{
    if(f.label==='Transient fixture rattle that self corrects') return;
    const x1 = pad + (f.start_s/TWIN.meta.horizon_s)*(w-pad*1.2-14);
    const x2 = pad + (f.end_s/TWIN.meta.horizon_s)*(w-pad*1.2-14);
    bands += `<rect x="${x1.toFixed(1)}" y="14" width="${(x2-x1).toFixed(1)}" height="${h-pad-14}" fill="var(--andon-amber)" opacity="0.06"/>`;
  });

  let gridlines = '';
  for(let i=0;i<=4;i++){
    const gy = 14 + i*(h-pad-14)/4;
    gridlines += `<line x1="${pad}" y1="${gy.toFixed(1)}" x2="${w-14}" y2="${gy.toFixed(1)}" stroke="var(--line-soft)" stroke-width="1"/>`;
  }
  let xlabels = '';
  [0,0.25,0.5,0.75,1].forEach(fr=>{
    const t = fr*TWIN.meta.horizon_s;
    const x = pad + fr*(w-pad*1.2-14);
    xlabels += `<text x="${x.toFixed(1)}" y="${h-8}" font-size="9" fill="var(--ink-faint)" font-family="IBM Plex Mono" text-anchor="middle">${fmtClock(t)}</text>`;
  });

  document.getElementById('throughputChart').innerHTML = svg(w,h,`
    ${bands}${gridlines}
    <path d="${area}" fill="var(--andon-amber)" opacity="0.12"/>
    <path d="${line}" fill="none" stroke="var(--andon-amber)" stroke-width="2"/>
    ${xlabels}
    <text x="${pad}" y="10" font-size="9" fill="var(--ink-faint)" font-family="IBM Plex Mono">bodies / 10min</text>
  `);
}

function renderOriginChart(){
  const entries = Object.entries(TWIN.quality_origin_counts).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const max = Math.max(...entries.map(e=>e[1]),1);
  const rows = entries.map(([sid,n])=>{
    const st = TWIN.line.find(s=>s.sid===sid);
    const pct = (n/max*100).toFixed(0);
    return `<div class="barrow">
      <div class="barrow-label mono">${sid}</div>
      <div class="barrow-track"><div class="barrow-fill" style="width:${pct}%"></div></div>
      <div class="barrow-val mono">${n}</div>
    </div>`;
  }).join('');
  document.getElementById('originChart').innerHTML = rows +
    `<div class="faint" style="margin-top:8px;font-size:12px;">Top origin accounts for ${((entries[0][1]/TWIN.meta.n_fails)*100).toFixed(0)}% of all shift fallout — a single tool, not a random spread.</div>`;
}

function renderLedgerTable(){
  const L = TWIN.ledger;
  const kinds = [
    ['BOTTLENECK','Bottleneck propagation'],
    ['DEFECT_RISK','Defect drift'],
    ['DARK_STATION','Dark station inference'],
  ];
  let html = `<table class="ledgertable"><thead><tr>
    <th>Alert type</th><th>Fired</th><th>Confirmed</th><th>False</th><th>Precision</th><th>Median lead</th>
  </tr></thead><tbody>`;
  kinds.forEach(([k,label])=>{
    const d = L[k];
    if(!d) return;
    const prec = d.precision!=null ? (d.precision*100).toFixed(0)+'%' : '—';
    html += `<tr>
      <td>${label}</td><td class="mono">${d.fired}</td>
      <td class="mono">${d.true}</td><td class="mono">${d.false}</td>
      <td class="mono">${prec}</td>
      <td class="mono">${d.mean_lead_s? (d.mean_lead_s/60).toFixed(0)+' min':'—'}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  document.getElementById('ledgerTable').innerHTML = html;
}

function renderFaultTimeline(){
  const w=560,h=150,pad=8;
  const faults = TWIN.fault_windows;
  const rowH = (h-pad*2)/faults.length;
  let bars='';
  faults.forEach((f,i)=>{
    const y = pad + i*rowH + 6;
    const x1 = (f.start_s/TWIN.meta.horizon_s)*(w-140)+130;
    const x2 = (f.end_s/TWIN.meta.horizon_s)*(w-140)+130;
    const alert = TWIN.alerts.find(a=>a.sid===f.station && a.t>=f.start_s && a.t<=f.end_s+2000);
    const isTransient = f.label.includes('Transient');
    const color = isTransient ? 'var(--ink-faint)' : (alert? 'var(--andon-green)':'var(--andon-red)');
    bars += `<text x="4" y="${(y+rowH*0.42).toFixed(1)}" font-size="10" fill="var(--ink-dim)" font-family="IBM Plex Mono">${f.station}</text>`;
    bars += `<rect x="${x1.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(2,x2-x1).toFixed(1)}" height="${(rowH*0.5).toFixed(1)}" rx="3" fill="${color}" opacity="0.35"/>`;
    if(alert){
      const ax = ((alert.t/TWIN.meta.horizon_s)*(w-140)+130);
      bars += `<line x1="${ax.toFixed(1)}" y1="${y.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${(y+rowH*0.5).toFixed(1)}" stroke="var(--andon-amber)" stroke-width="2"/>`;
    }
  });
  document.getElementById('faultTimeline').innerHTML = svg(w,h,bars) +
    `<div class="faint" style="font-size:11.5px;margin-top:4px;">amber tick = twin's first alert on that condition. Grey bar = deliberate transient the twin correctly ignored.</div>`;
}

function renderZoneMix(){
  const zones = ['BODY','PAINT','FINAL'];
  let html = '<div class="zonemix">';
  zones.forEach(z=>{
    const t = TWIN.zone_totals[z];
    const wa=(t.A/t.count*100), wb=(t.B/t.count*100), wc=(t.C/t.count*100);
    html += `<div class="zonemix-row">
      <div class="zonemix-label">${z} <span class="faint mono">(${t.count})</span></div>
      <div class="zonemix-bar">
        <div style="width:${wa}%;background:var(--tier-a)" title="Tier A: ${t.A}"></div>
        <div style="width:${wb}%;background:var(--tier-b)" title="Tier B: ${t.B}"></div>
        <div style="width:${wc}%;background:var(--tier-c)" title="Tier C: ${t.C}"></div>
      </div>
      <div class="zonemix-counts mono faint">A ${t.A} · B ${t.B} · C ${t.C}</div>
    </div>`;
  });
  html += '</div>';
  document.getElementById('zoneMix').innerHTML = html;
}
