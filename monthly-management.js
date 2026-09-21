const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:2}).format(n||0);
const directions={driver_to_explora:'Chofer pagó a Explora',explora_to_driver:'Explora pagó al chofer',driver_pays_explora:'Chofer pagó a Explora',explora_pays_driver:'Explora pagó al chofer'};
export function mountMonthlyManagement({loadReport,uploadInvoice}) {
  const root=document.getElementById('monthlyManagement');let current=null,view='Mi factura del mes',expanded='facturacion',sequence=0;
  const now=new Date();
  const month=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit'}).format(now);
  const months=Array.from({length:36},(_,index)=>{const date=new Date(now.getFullYear(),now.getMonth()-35+index,1);return {value:new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit'}).format(date),label:new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',month:'long',year:'numeric'}).format(date)}});
  const sections=[
    ['actividad','Tu actividad','Viajes, cobros y gastos del mes.','Mi trabajo'],
    ['explora','Gastos de Explora','Gastos, deudas, pagos y cierres registrados por Explora.','Gastos de Explora'],
    ['facturacion','Tu facturación','Tu 40% y el resumen para emitir la factura.','Mi factura del mes']
  ];
  root.innerHTML=`<div class="monthly-heading"><h2>Mi trabajo y mi participación</h2><div class="monthly-month-picker"><label for="managementMonth">Mes del informe</label><div><button type="button" id="previousManagementMonth" aria-label="Ver mes anterior">‹</button><select id="managementMonth">${months.map(item=>`<option value="${item.value}"${item.value===month?' selected':''}>${esc(item.label)}</option>`).join('')}</select><button type="button" id="nextManagementMonth" aria-label="Ver mes siguiente">›</button></div></div></div><div class="monthly-menu">${sections.map(([id,label,detail,item])=>`<section class="monthly-group" data-monthly-group="${id}"><button type="button" class="monthly-group-toggle" aria-expanded="${id===expanded}" data-monthly-group-toggle="${id}" data-monthly-view="${item}"><span><strong>${label}</strong><small>${detail}</small><i class="monthly-toggle-action">Ver detalle</i></span><b aria-hidden="true">⌄</b></button><div class="monthly-inline-content"></div></section>`).join('')}</div><p id="monthlyStatus" role="status"></p>`;
  let content=root.querySelector(`[data-monthly-group="${expanded}"] .monthly-inline-content`);
  const status=root.querySelector('#monthlyStatus'),selector=root.querySelector('#managementMonth');
  const previousMonth=root.querySelector('#previousManagementMonth'),nextMonth=root.querySelector('#nextManagementMonth');
  function updateMonthNavigation(){previousMonth.disabled=selector.selectedIndex===0;nextMonth.disabled=selector.selectedIndex===selector.options.length-1;}
  function renderMenu(){root.querySelectorAll('[data-monthly-group]').forEach(group=>{const open=group.dataset.monthlyGroup===expanded;group.classList.toggle('is-open',open);group.querySelector('.monthly-group-toggle').setAttribute('aria-expanded',String(open));group.querySelector('.monthly-toggle-action').textContent=open?'Cerrar detalle':'Ver detalle';});root.querySelectorAll('[data-monthly-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.monthlyView===view)));}
  function render(){
    if(!current)return;
    root.querySelectorAll('.monthly-inline-content').forEach(node=>node.innerHTML='');
    content=root.querySelector(`[data-monthly-group="${expanded}"] .monthly-inline-content`);
    renderMenu();
    const t=current.totals;
    const groups=view==='Mi trabajo'?['Cobros de viajes','Liquidaciones Uber','Gastos']:view==='Gastos de Explora'?['Gastos','Deudas','Adelantos y préstamos','Cierres','Pagos y compensaciones']:[];
    content.innerHTML=`<h3>${view}</h3><p>${current.closedMonth?'Mes finalizado':'Acumulado provisional'} · ${esc(current.driverName)}</p>`;
    if(!groups.length)content.innerHTML+=`<div class="monthly-total"><span>Tu participación del mes · 40% bruto</span><strong>${money(t.participation)}</strong></div><dl class="monthly-breakdown"><dt>Cobros en efectivo, incluido Uber aceptado</dt><dd>${money(t.cash)}</dd><dt>Cobros digitales</dt><dd>${money(t.digital)}</dd><dt>Facturación bruta del mes</dt><dd>${money(t.gross)}</dd><dt>Participación acordada</dt><dd>40%</dd><dt>Importe a facturar a Explora</dt><dd>${money(t.participation)}</dd></dl><section class="monthly-invoice-steps"><strong>Cómo completar tu factura</strong><ol><li><b>Paso 1.</b> Descargá este resumen y envialo a tu contadora.</li><li><b>Paso 2.</b> Ella genera tu factura por el 40% de tu participación en Explora.</li><li><b>Paso 3.</b> Cuando recibas la factura, subila abajo donde dice “Adjuntar mi factura emitida”.</li></ol></section>`;
    if(current.issues.length)content.innerHTML+=`<aside class="monthly-review"><strong>Movimientos para revisar</strong>${current.issues.map(x=>`<p>${esc(x)}</p>`).join('')}</aside>`;
    const rows=current.rows.filter(r=>groups.includes(r.group));
    if(groups.length)content.innerHTML+=rows.length?rows.map(r=>{const method=r.method||directions[r.direction]||'Sin método indicado';return `<article class="monthly-movement"><div class="monthly-movement-head"><span>${esc(r.date)} · ${esc(r.detail)} · ${esc(method)}</span><strong>${money(r.amount)}</strong></div></article>`;}).join(''):'<p>Sin movimientos en este mes.</p>';
    const accountantView=view==='Mi factura del mes';
    const downloadLabel=accountantView?'Descargar resumen para contadora':`Descargar detalle de ${view.toLowerCase()}`;
    content.innerHTML+=`<button type="button" id="downloadMonthlyReport" class="period-primary">${downloadLabel}</button>`;
    if(view==='Mi factura del mes')content.innerHTML+=`<label class="monthly-upload">Adjuntar mi factura emitida (PDF)<input id="monthlyInvoiceFile" type="file" accept="application/pdf,.pdf"></label>${(current.invoices||[]).map(row=>`<p>Factura cargada · <a href="${esc(row.url)}" target="_blank" rel="noopener">Ver PDF</a></p>`).join('')}`;
    content.querySelector('#downloadMonthlyReport').onclick=async e=>{e.target.disabled=true;status.textContent='Preparando el informe completo…';try{const result=await loadReport(selector.value,true);const blob=new Blob([Uint8Array.from(atob(result.pdf.base64),c=>c.charCodeAt(0))],{type:'application/pdf'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=result.pdf.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);status.textContent='Informe guardado y descargado.';}catch(error){status.textContent=error.message;}finally{e.target.disabled=false;}};
    const file=content.querySelector('#monthlyInvoiceFile');if(file)file.onchange=async()=>{if(!file.files[0])return;file.disabled=true;try{await uploadInvoice(selector.value,file.files[0]);await refresh();status.textContent='Factura adjuntada. Queda guardada para revisión.';}catch(error){status.textContent=error.message;}finally{file.disabled=false;}};
  }
  async function refresh(){const request=++sequence;status.textContent='Consultando los movimientos del mes…';content.innerHTML='';current=null;try{const report=await loadReport(selector.value,false);if(request!==sequence)return;current=report;status.textContent='';render();}catch(error){if(request===sequence)status.textContent=error.message;}}
  selector.onchange=()=>{updateMonthNavigation();refresh();};
  previousMonth.onclick=()=>{if(selector.selectedIndex>0){selector.selectedIndex--;selector.dispatchEvent(new Event('change'));}};
  nextMonth.onclick=()=>{if(selector.selectedIndex<selector.options.length-1){selector.selectedIndex++;selector.dispatchEvent(new Event('change'));}};
  root.querySelectorAll('[data-monthly-group-toggle]').forEach(b=>b.onclick=()=>{const closing=expanded===b.dataset.monthlyGroupToggle;expanded=closing?'':b.dataset.monthlyGroupToggle;if(closing){content.innerHTML='';status.textContent='';renderMenu();b.scrollIntoView({behavior:'smooth',block:'start'});return;}view=b.dataset.monthlyView;render();});
  updateMonthNavigation();renderMenu();return {refresh};
}
