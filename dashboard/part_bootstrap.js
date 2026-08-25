/* ============================= BOOTSTRAP ============================= */
document.addEventListener('DOMContentLoaded', ()=>{
  const badge = document.getElementById('runBadge');
  badge.innerHTML = `run seed <b>${TWIN.meta.seed}</b> · ${TWIN.meta.n_stations} stations
    · shift horizon ${(TWIN.meta.horizon_s/3600).toFixed(0)}h
    · ${TWIN.alerts.length} alerts fired`;

  buildFloorView();
  buildManagerView();
  buildLeadershipView();

  document.querySelectorAll('#tabs button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#tabs button').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('view-'+btn.dataset.view).classList.add('active');
    });
  });
});
