(()=>{
  "use strict";
  if(window.__exploraVehicleManagementDashboardV227)return;
  window.__exploraVehicleManagementDashboardV227=true;
  const section=()=>document.querySelector('.quick-summary-real.vehicle-management-real');
  const markup=()=>`<button type="button" class="summary-card-real vehicle-management-card vehicle-management-card--car" data-action="mi-auto" data-mi-auto-state="pending" aria-label="Abrir información de mi auto asignado. Estado pendiente de completar"><span class="vehicle-management-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 17h14"/><path d="M6 17v2M18 17v2"/><path d="m4 13 2-5h12l2 5v4H4z"/><circle cx="7.5" cy="14.5" r="1"/><circle cx="16.5" cy="14.5" r="1"/></svg></span><span class="vehicle-management-title">MI AUTO</span><small class="vehicle-management-status" id="myVehicleDashboardStatus">Estado pendiente de completar</small></button><button type="button" class="summary-card-real vehicle-management-card vehicle-management-card--alerts" data-action="multas-choques" aria-label="Consultar mis multas, choques y deudas pendientes"><span class="vehicle-management-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 3 20h18Z"/><path d="M12 9v5"/><path d="M12 17h.01"/></svg></span><span class="vehicle-management-title">MULTAS Y CHOQUES</span><small class="vehicle-management-debt-status" id="driverIncidentsDashboardStatus">🟢 Sin deudas</small></button>`;
  function ensure(){
    const host=section();if(!host)return;
    let grid=host.querySelector('.vehicle-management-grid');
    if(!grid){grid=document.createElement('div');grid.className='summary-grid-real vehicle-management-grid';host.appendChild(grid)}
    const cards=grid.querySelectorAll(':scope > .vehicle-management-card');
    if(cards.length!==2||!grid.querySelector('[data-action="mi-auto"]')||!grid.querySelector('[data-action="multas-choques"]'))grid.innerHTML=markup();
    [...grid.children].forEach((node,index)=>{if(index>1)node.remove()});
    const car=grid.querySelector('[data-action="mi-auto"]');
    if(car&&!car.querySelector('.vehicle-management-status')){
      const status=document.createElement('small');status.id='myVehicleDashboardStatus';status.className='vehicle-management-status';status.textContent='Estado pendiente de completar';car.appendChild(status);
    }
    window.ExploraVehicleDashboard?.applyDashboardState?.();window.ExploraDriverIncidents?.applyDashboardState?.();
  }
  let queued=false;
  function queue(){if(queued)return;queued=true;queueMicrotask(()=>{queued=false;ensure()})}
  document.addEventListener('DOMContentLoaded',ensure,{once:true});
  window.addEventListener('explora:session-opened',queue);
  window.addEventListener('explora:auth-ready',queue);
  window.addEventListener('explora:app-reset',()=>{queue();window.ExploraDerivationRankingDefinitiveRepair?.stop?.();window.ExploraDerivationRankingDefinitiveRepair?.start?.();});
  if(document.readyState!=='loading')queue();
})();
