import {escapeUi as esc} from './explora-ui.js?v=20260919-admin-1';
const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:2}).format(Number(n)||0);
const date=ms=>ms?new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',year:'2-digit'}).format(new Date(ms)):'Sin fecha';
const monthOf=ms=>ms?new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit'}).format(new Date(ms)):'';
const safeUrl=value=>/^https?:\/\//i.test(value||'')?esc(value):'';
const proof=url=>safeUrl(url)?`<a href="${safeUrl(url)}" target="_blank" rel="noopener">Ver comprobante ↗</a>`:'<span class="admin-muted">Sin adjunto</span>';
const empty=message=>`<div class="admin-empty-state">${esc(message)}</div>`;
export function filterAdminRows(rows,{month,type='all',search=''}){
  const query=search.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return rows.filter(r=>(!month||monthOf(r.time)===month)&&(type==='all'||r.kind===type)&&`${r.driver} ${r.detail}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(query)).sort((a,b)=>b.time-a.time);
}
export function mountAdminWorkspace({getState,loadDocuments,openDebt,openDigital}){
  const $=id=>document.getElementById(id);let view='overview',count=50,documentSequence=0,loadedMonth='',documents=null,refreshTimer=null;
  const titles={overview:['Resumen del equipo','Saldos actualizados de todos tus choferes.'],movements:['Movimientos','Toda la actividad, con fecha, chofer y comprobante.'],closures:['Cierres y pagos','Controlá las rendiciones y los pagos de todo el equipo.'],accountant:['Contadora','Resúmenes y facturas de todos los choferes, mes a mes.']};
  const now=new Date();
  const months=Array.from({length:36},(_,i)=>{const d=new Date(now.getFullYear(),now.getMonth()-i,15);return {value:monthOf(d.getTime()),label:new Intl.DateTimeFormat('es-AR',{month:'long',year:'numeric'}).format(d)};});
  for(const id of ['adminActivityMonth','adminDocumentsMonth'])$(id).innerHTML=months.map(m=>`<option value="${m.value}">${esc(m.label)}</option>`).join('');
  document.querySelectorAll('[data-admin-view]').forEach(button=>button.addEventListener('click',()=>{
    if(!getState().authorized)return;view=button.dataset.adminView;
    document.querySelectorAll('[data-admin-view]').forEach(b=>{if(b.dataset.adminView===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    document.querySelectorAll('[data-admin-panel]').forEach(p=>p.hidden=p.dataset.adminPanel!==view);
    $('adminWorkspaceTitle').textContent=titles[view][0];$('adminWorkspaceSubtitle').textContent=titles[view][1];
    refresh();if(view==='accountant'&&loadedMonth!==$('adminDocumentsMonth').value)refreshDocuments();
  }));
  $('adminGroupDebtBtn').addEventListener('click',()=>openDebt(true));
  $('adminDigitalExpenseBtn').addEventListener('click',openDigital);
  for(const id of ['adminActivityMonth','adminActivityType','adminActivitySearch'])$(id).addEventListener(id==='adminActivitySearch'?'input':'change',()=>{count=50;refresh();});
  $('adminMoreActivity').onclick=()=>{count+=50;refresh();};
  function renderActivity(state){
    if(!state.ready){$('adminActivityTable').innerHTML=empty('Sincronizando movimientos…');$('adminMoreActivity').hidden=true;return;}
    const rows=filterAdminRows(state.movements,{month:$('adminActivityMonth').value,type:$('adminActivityType').value,search:$('adminActivitySearch').value});
    $('adminActivityTable').innerHTML=rows.length?`<table class="admin-table"><thead><tr><th>Fecha</th><th>Chofer</th><th>Detalle</th><th>Método</th><th class="number">Monto</th><th>Comprobante</th></tr></thead><tbody>${rows.slice(0,count).map(r=>`<tr><td>${date(r.time)}</td><td><strong>${esc(r.driver)}</strong></td><td>${esc(r.detail)}<small>${esc(r.label)}</small></td><td>${esc(r.method)}</td><td class="number ${['cash','digital'].includes(r.kind)?'income':'outgoing'}">${money(r.amount)}</td><td>${proof(r.proof)}</td></tr>`).join('')}</tbody></table>`:empty('No hay movimientos para estos filtros.');
    $('adminMoreActivity').hidden=rows.length<=count;
  }
  function renderClosures(state){
    if(!state.ready){$('adminClosuresTable').innerHTML=empty('Sincronizando cierres…');return;}
    $('adminClosuresTable').innerHTML=state.closures.length?`<table class="admin-table"><thead><tr><th>Fecha</th><th>Chofer</th><th>Estado</th><th>Quién paga</th><th class="number">Monto</th><th>Comprobante</th></tr></thead><tbody>${state.closures.map(r=>`<tr><td>${date(r.time)}</td><td><strong>${esc(r.driver)}</strong></td><td><span class="admin-badge ${r.completed?'done':'pending'}">${esc(r.status)}</span></td><td>${esc(r.direction)}</td><td class="number">${money(r.amount)}</td><td>${proof(r.proof)}</td></tr>`).join('')}</tbody></table>`:empty('Todavía no hay cierres registrados.');
  }
  function refresh(){
    const state=getState();if(!state.authorized)return;
    for(const id of ['adminDigitalExpenseBtn','adminAddDebtBtn','adminGroupDebtBtn'])$(id).disabled=!state.ready;
    $('adminQuickStatus').textContent=state.ready?'':state.error?'No pudimos sincronizar el equipo. Recargá para volver a intentar.':'Sincronizando el equipo…';
    const owed=state.accounts.reduce((n,d)=>n+Math.max(0,d.balance),0),pay=state.accounts.reduce((n,d)=>n+Math.max(0,-d.balance),0);
    $('adminOverviewMetrics').innerHTML=[['Choferes activos',state.accounts.length,'Equipo operativo'],['Por cobrar a choferes',money(owed),'Saldos a favor de Explora'],['Por pagar a choferes',money(pay),'Saldos a favor del equipo']].map(([label,value,detail])=>`<article><span>${label}</span><strong>${state.ready?value:'—'}</strong><small>${state.ready?detail:'Consultando saldos…'}</small></article>`).join('');
    if(view==='movements')renderActivity(state);if(view==='closures')renderClosures(state);
  }
  function renderDocuments(){
    if(!documents)return;
    $('adminDocumentsTable').innerHTML=documents.rows.length?`<table class="admin-table"><thead><tr><th>Chofer</th><th class="number">Facturación bruta</th><th class="number">Debe facturar · 40%</th><th>Factura del chofer</th><th>Resumen</th></tr></thead><tbody>${documents.rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong>${r.issues.length?`<small class="outgoing">${r.issues.length} observaciones en el resumen</small>`:''}</td><td class="number">${money(r.totals.gross)}</td><td class="number">${money(r.totals.participation)}${!r.closedMonth?'<small>Provisional</small>':''}</td><td>${r.invoices.length?r.invoices.map((i,index)=>`<a href="${safeUrl(i.url)}" target="_blank" rel="noopener">Factura recibida${index?' · versión anterior':''} ↗</a>`).join('<br>'):`<span class="admin-badge ${r.closedMonth&&r.totals.gross>0?'pending':''}">${r.closedMonth?(r.totals.gross>0?'Pendiente de recibir':'Sin facturación'):'Mes en curso'}</span>`}</td><td><button type="button" class="admin-table-button" data-admin-report="${esc(r.uid)}">Descargar PDF</button></td></tr>`).join('')}</tbody></table>`:empty('No hay choferes para este mes.');
  }
  async function refreshDocuments(){
    if(!getState().authorized)return;const sequence=++documentSequence,month=$('adminDocumentsMonth').value;
    loadedMonth='';documents=null;$('adminDocumentsTable').innerHTML='';$('adminDocumentsStatus').textContent='Preparando la documentación de todo el equipo…';$('adminRefreshDocuments').disabled=true;
    try{const result=await loadDocuments({month});if(sequence!==documentSequence||!getState().authorized)return;documents=result;loadedMonth=month;renderDocuments();$('adminDocumentsStatus').textContent='';}
    catch(error){if(sequence===documentSequence)$('adminDocumentsStatus').textContent=error.message||'No se pudo cargar. Volvé a intentar.';}
    finally{if(sequence===documentSequence)$('adminRefreshDocuments').disabled=false;}
  }
  $('adminRefreshDocuments').onclick=refreshDocuments;$('adminDocumentsMonth').onchange=refreshDocuments;
  $('adminDocumentsTable').addEventListener('click',async event=>{
    const button=event.target.closest('[data-admin-report]');if(!button||button.disabled||!getState().authorized)return;
    const sequence=documentSequence;button.disabled=true;$('adminDocumentsStatus').textContent='Preparando el PDF detallado…';
    try{const result=await loadDocuments({month:documents.month,driverUid:button.dataset.adminReport});if(sequence!==documentSequence||!getState().authorized)return;
      const bytes=Uint8Array.from(atob(result.pdf.base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      const a=document.createElement('a');a.href=url;a.download=result.pdf.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);$('adminDocumentsStatus').textContent='Resumen descargado.';
    }catch(error){if(sequence===documentSequence)$('adminDocumentsStatus').textContent=error.message;}
    finally{button.disabled=false;}
  });
  return {refresh,invalidateDocuments(){loadedMonth='';clearTimeout(refreshTimer);if(view==='accountant'&&getState().authorized)refreshTimer=setTimeout(refreshDocuments,700);},reset(){clearTimeout(refreshTimer);documentSequence++;documents=null;loadedMonth='';for(const id of ['adminDocumentsTable','adminDocumentsStatus','adminActivityTable','adminClosuresTable','adminOverviewMetrics','adminDriverList'])$(id).innerHTML='';$('adminRefreshDocuments').disabled=false;}};
}
