/* ============================= FLOOR SUPERVISOR ============================= */

function fmtT(t){
  const h = Math.floor(t/3600), m = Math.floor((t%3600)/60);
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}
function fmtClock(t){
  // shift starts 06:00
  const base = 6*3600 + t;
  const h = Math.floor(base/3600)%24, m = Math.floor((base%3600)/60);
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}

const STATE_NAME = {0:'WORK',1:'STARVED',2:'BLOCKED'};
const DRIFT_NAME = {0:'STABLE',1:'WATCH',2:'DRIFTING',3:'EXCURSION'};
const TIER_LABEL = {A:'Full sensors', B:'Cycle only', C:'Dark / manual'};

let floorState = { idx: 0, playing:false, timer:null, selectedSid:null };

function buildFloorView(){
  const el = document.getElementById('view-floor');
  el.innerHTML = `
    <div class="scrubber card" style="margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
        <button id="playBtn" class="playbtn">▶</button>
        <input type="range" id="scrub" min="0" max="${TWIN.frames.length-1}" value="0" style="flex:1;min-width:220px;">
        <div class="mono clock" id="clockReadout">06:00</div>
        <button id="jumpAlertBtn" class="jumpbtn">Jump to first alert</button>
      </div>
    </div>

    <div class="grid g4" style="margin-bottom:16px;">
      <div class="card kpi">
        <h2>Constraint station</h2>
        <div class="kpi-val mono" id="kConstraint">—</div>
        <div class="kpi-sub" id="kConstraintSub">—</div>
      </div>
      <div class="card kpi">
        <h2>Sustained rate loss</h2>
        <div class="kpi-val mono" id="kRateLoss">—</div>
        <div class="kpi-sub">bodies / hour, vs takt</div>
      </div>
      <div class="card kpi">
        <h2>Runway before it's visible</h2>
        <div class="kpi-val mono" id="kRunway">—</div>
        <div class="kpi-sub">until end-of-line counter falls</div>
      </div>
      <div class="card kpi">
        <h2>Bodies out this shift</h2>
        <div class="kpi-val mono" id="kUnitsOut">—</div>
        <div class="kpi-sub" id="kUnitsOutSub">—</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <h2>Line — 42 stations, body → paint → final assembly
        <span class="legend">
          <span class="dot" style="background:var(--panel-2);border:1px solid var(--line)"></span> work
          <span class="dot" style="background:var(--andon-amber)"></span> starved
          <span class="dot" style="background:var(--andon-red)"></span> blocked
          <span class="dot ring" style="border-color:var(--andon-amber)"></span> drifting
        </span>
      </h2>
      <div id="lineMap"></div>
      <div id="stationDetail" class="station-detail"></div>
    </div>

    <div class="card">
      <h2>Live alert feed
        <span class="dim mono" id="alertCount" style="font-weight:400;"></span>
      </h2>
      <div id="alertFeed"></div>
    </div>
  `;
  renderLineMapSkeleton();
  wireFloorControls();
  renderFloorFrame(0);
}

function renderLineMapSkeleton(){
  const host = document.getElementById('lineMap');
  const zones = ['BODY','PAINT','FINAL'];
  let html = '<div class="linemap">';
  zones.forEach(z=>{
    const stations = TWIN.line.filter(s=>s.zone===z);
    html += `<div class="zone-block">
      <div class="zone-label">${z}</div>
      <div class="zone-row">`;
    stations.forEach(s=>{
      html += `<div class="stbox tier-${s.tier}" data-sid="${s.sid}" id="st-${s.sid}" title="${s.sid} ${s.name}">
        <div class="stbox-id">${s.sid}</div>
        ${s.tier==='C' ? '<div class="stbox-tag">DARK</div>' : ''}
        <div class="stbox-cyc mono" id="cyc-${s.sid}"></div>
      </div>`;
    });
    html += `</div></div>`;
  });
  html += '</div>';
  host.innerHTML = html;
  document.querySelectorAll('.stbox').forEach(b=>{
    b.addEventListener('click', ()=>{ floorState.selectedSid = b.dataset.sid; renderFloorFrame(floorState.idx); });
  });
}

function wireFloorControls(){
  const scrub = document.getElementById('scrub');
  scrub.addEventListener('input', e=>{ floorState.idx = +e.target.value; renderFloorFrame(floorState.idx); });
  document.getElementById('playBtn').addEventListener('click', togglePlay);
  document.getElementById('jumpAlertBtn').addEventListener('click', ()=>{
    if(!TWIN.alerts.length) return;
    const t0 = TWIN.alerts[0].t;
    const idx = TWIN.frames.findIndex(f=>f.t>=t0);
    floorState.idx = Math.max(0, idx);
    scrub.value = floorState.idx;
    renderFloorFrame(floorState.idx);
  });
}

function togglePlay(){
  floorState.playing = !floorState.playing;
  document.getElementById('playBtn').textContent = floorState.playing ? '⏸' : '▶';
  if(floorState.playing){
    floorState.timer = setInterval(()=>{
      floorState.idx = (floorState.idx+1) % TWIN.frames.length;
      document.getElementById('scrub').value = floorState.idx;
      renderFloorFrame(floorState.idx);
      if(floorState.idx === TWIN.frames.length-1){ togglePlay(); }
    }, 140);
  } else {
    clearInterval(floorState.timer);
  }
}

function renderFloorFrame(idx){
  const f = TWIN.frames[idx];
  document.getElementById('clockReadout').textContent = fmtClock(f.t) + '  ·  t+' + fmtT(f.t);

  TWIN.line.forEach((s,i)=>{
    const box = document.getElementById('st-'+s.sid);
    const cycEl = document.getElementById('cyc-'+s.sid);
    box.classList.remove('st-work','st-starved','st-blocked','drift-watch','drift-drifting','drift-excursion','selected');
    box.classList.add('st-' + STATE_NAME[f.st[i]].toLowerCase());
    if(f.dr[i]===1) box.classList.add('drift-watch');
    if(f.dr[i]===2) box.classList.add('drift-drifting');
    if(f.dr[i]===3) box.classList.add('drift-excursion');
    if(s.sid===floorState.selectedSid) box.classList.add('selected');
    cycEl.textContent = f.cyc[i].toFixed(0)+'s';
  });

  const cSid = f.constraint;
  const cStation = TWIN.line.find(s=>s.sid===cSid);
  document.getElementById('kConstraint').textContent = cSid ? `${cSid} · ${f.constraint_cycle.toFixed(0)}s` : '—';
  document.getElementById('kConstraintSub').textContent = cStation ? cStation.name+' (standard '+cStation.nominal_cycle_s.toFixed(0)+'s)' : '';
  const rl = f.rate_loss||0;
  document.getElementById('kRateLoss').textContent = (rl>0?'+':'') + rl.toFixed(1);
  document.getElementById('kRateLoss').style.color = rl>3 ? 'var(--andon-red)' : rl>0.5 ? 'var(--andon-amber)' : 'var(--andon-green)';
  document.getElementById('kRunway').textContent = f.runway_min ? f.runway_min.toFixed(0)+' min' : '—';
  document.getElementById('kUnitsOut').textContent = f.units_out;
  const plan = (f.t/TWIN.meta.horizon_s * TWIN.meta.n_completed).toFixed(0);
  document.getElementById('kUnitsOutSub').textContent = 'plan pace ≈ ' + plan;

  renderStationDetail(idx);
  renderAlertFeed(f.t);
}

function renderStationDetail(idx){
  const host = document.getElementById('stationDetail');
  if(!floorState.selectedSid){ host.innerHTML = '<div class="faint" style="padding:10px 2px;">Click a station to inspect its current reading.</div>'; return; }
  const f = TWIN.frames[idx];
  const i = TWIN.line.findIndex(s=>s.sid===floorState.selectedSid);
  const s = TWIN.line[i];
  const cf = f.cf[i], st = f.st[i], dr = f.dr[i], buf = f.buf[i], cyc = f.cyc[i];
  const fc = f.fc[i];
  host.innerHTML = `
    <div class="detail-grid">
      <div><div class="faint dlabel">Station</div><div class="mono">${s.sid} — ${s.name}</div></div>
      <div><div class="faint dlabel">Sensor tier</div><div>${s.tier} · ${TIER_LABEL[s.tier]}</div></div>
      <div><div class="faint dlabel">Work content</div><div class="mono">${cyc.toFixed(1)} s <span class="faint">(standard ${s.nominal_cycle_s.toFixed(0)}s)</span></div></div>
      <div><div class="faint dlabel">Estimate confidence</div><div class="mono">${(cf*100).toFixed(0)}%</div></div>
      <div><div class="faint dlabel">State</div><div>${STATE_NAME[st]}</div></div>
      <div><div class="faint dlabel">Out buffer</div><div class="mono">${buf} / ${s.out_buffer_cap}</div></div>
      <div><div class="faint dlabel">Drift status</div><div>${DRIFT_NAME[dr]}</div></div>
      <div><div class="faint dlabel">Forecast</div><div>${fc ? (fc[0]===1?'runs dry':'backs up')+' in '+fc[1].toFixed(0)+' min' : 'no event in 30 min horizon'}</div></div>
    </div>`;
}

function tierBadge(tier){
  const map = {'ACT NOW':'act', 'ADVISE':'advise', 'MONITOR':'monitor'};
  return `<span class="tierbadge tb-${map[tier]||'monitor'}">${tier}</span>`;
}
function outcomeBadge(a){
  if(a.outcome==='OPEN') return `<span class="outbadge ob-open">OPEN</span>`;
  if(a.outcome==='PENDING') return `<span class="outbadge ob-pending">PENDING</span>`;
  if(a.outcome==='TRUE') return `<span class="outbadge ob-true">CONFIRMED · lead ${a.lead_time_s? (a.lead_time_s/60).toFixed(0)+'m':'—'}</span>`;
  return `<span class="outbadge ob-false">FALSE ALARM</span>`;
}

function renderAlertFeed(nowT){
  const host = document.getElementById('alertFeed');
  const visible = TWIN.alerts.filter(a=>a.t<=nowT).sort((a,b)=>b.last_update_t-a.last_update_t || b.t-a.t);
  document.getElementById('alertCount').textContent = visible.length ? `${visible.length} shown` : '';
  if(!visible.length){ host.innerHTML = '<div class="faint" style="padding:16px 2px;">No conditions yet. The line is inside a normal warm-up window.</div>'; return; }
  host.innerHTML = visible.map(a=>`
    <div class="alertcard tier-border-${(a.tier==='ACT NOW'?'act':a.tier==='ADVISE'?'advise':'monitor')}">
      <div class="alertcard-top">
        ${tierBadge(a.tier)}
        <span class="mono faint">${fmtT(a.t)}</span>
        <span class="mono faint">risk ${a.risk}</span>
        ${a.updates>0?`<span class="faint">· updated ${a.updates}×, last ${fmtT(a.last_update_t)}</span>`:''}
        <span style="flex:1"></span>
        ${nowT>=a.verify_by ? outcomeBadge(a) : `<span class="outbadge ob-open">verifies ${fmtT(a.verify_by)}</span>`}
      </div>
      <div class="alertcard-head">${a.headline}</div>
      <div class="alertcard-action"><b>Action —</b> ${a.action}</div>
      <div class="alertcard-meta faint">${a.owner} · ${a.expected_impact}</div>
      <details class="alertcard-ev"><summary>Evidence (${a.evidence.length})</summary>
        <ul>${a.evidence.map(e=>`<li>${e}</li>`).join('')}</ul>
        <div class="faint" style="margin-top:6px;"><b>Falsifier —</b> ${a.falsifier}</div>
      </details>
    </div>`).join('');
}
