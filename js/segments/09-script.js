(()=>{
  "use strict";
  const screen=document.getElementById("receiptsScreen");
  if(!screen)return;
  const $=id=>document.getElementById(id);
  const AR_TZ="America/Argentina/Cordoba";
  const state={category:"explora",rows:[],filter:"todos",search:"",driver:"",month:"",week:"",vehicle:"",loading:false,previousScrollY:0,cache:new Map(),editingRow:null,savingAmount:false,deletingRowKey:"",adminMode:false};
  const titles={
    explora:["EXPLORA","Transferencias, QR, tarjetas y pagos digitales"],
    chofer:["CHOFER","Comprobantes de efectivo y Caja Chica"],
    caja_chica:["CAJA CHICA","Comprobantes exclusivos de Caja Chica"],
    gastos:["GASTOS","Comprobantes asociados a gastos"],
    deudas:["DEUDAS","Comprobantes de deudas"]
  };
  const emptyMessages={explora:"No hay comprobantes digitales de Explora.",chofer:"No hay comprobantes de efectivo ni Caja Chica.",caja_chica:"No hay comprobantes de Caja Chica.",gastos:"No hay comprobantes de gastos.",deudas:"No hay comprobantes de deudas."};
  const money=v=>new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(Number(v)||0).replace(/\s/g,"");
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const role=()=>String(window.ExploraSession?.role||window.ExploraSession?.rol||window.ExploraSession?.profile?.role||window.ExploraSession?.profile?.rol||window.ExploraSession?.profile?.tipoUsuario||window.ExploraAuthSession?.role||window.ExploraAuthSession?.rol||"").trim().toLowerCase();
  const isAdmin=()=>document.body.classList.contains("explora-shared-admin")||document.body.classList.contains("explora-admin-authenticated")||window.ExploraAccessState?.isAdmin===true||["admin","administrador","owner","superadmin","propietario"].includes(role());
  const isAdminView=()=>state.adminMode||isAdmin();
  const isClosureAdmin=()=>isAdminView()&&state.category==="cierres";
  function setStatus(text="",error=false){const el=$("receiptsStatus");if(!el)return;el.textContent=text;el.className=`receipts-status${error?" err":""}`;}
  function open(options={}){if(options&&Object.prototype.hasOwnProperty.call(options,"adminMode"))state.adminMode=options.adminMode===true;state.previousScrollY=window.scrollY||0;screen.classList.add("is-open");screen.setAttribute("aria-hidden","false");screen.dataset.view="main";screen.dataset.adminMode=state.adminMode?"true":"false";window.lockPageScroll?.("receipts");window.ExploraMainNav?.setActive?.("comprobantes");syncAdminFilters();}
  function openAdminPayments(){state.adminMode=true;open({adminMode:true});return load("explora",{force:true});}
  function close(){screen.classList.remove("is-open");screen.setAttribute("aria-hidden","true");screen.dataset.view="main";screen.dataset.adminMode="false";state.adminMode=false;window.unlockPageScroll?.("receipts");window.ExploraMainNav?.setActive?.("inicio");requestAnimationFrame(()=>window.scrollTo(0,state.previousScrollY||0));}
  function normalizedState(row){return String(row.state||row.status||row.estado||"registrado").toLowerCase();}
  function rowRaw(row={}){return row.raw&&typeof row.raw==="object"?row.raw:row;}
  function closureStatusKey(row={}){
    const raw=rowRaw(row);
    const joined=[row.state,row.status,raw.receiptStatus,raw.estadoComprobante,raw.paymentStatus,raw.status,raw.estado,raw.closureStatus,raw.resultLabel].map(value=>String(value||"").toLowerCase()).join(" ");
    const balanced=raw.balanced===true||raw.sentido==="sin_diferencia"||joined.includes("equilibr")||joined.includes("no requerido")||joined.includes("not_required");
    if(balanced)return"balanced";
    if(joined.includes("rechaz")||joined.includes("reject"))return"rejected";
    if(["aprob","accept","confirm","pagado","paid","completado","completed","cerrado","closed"].some(token=>joined.includes(token)))return"confirmed";
    if(["revision","revisión","review","uploaded","subido","recibido","pendiente_aprobacion"].some(token=>joined.includes(token))||Boolean(row.url))return"received";
    return"missing";
  }
  function closureStatusLabel(key){return({missing:"FALTA COMPROBANTE",received:"COMPROBANTE RECIBIDO",confirmed:"PAGO CONFIRMADO",rejected:"COMPROBANTE RECHAZADO",balanced:"CUENTA EQUILIBRADA"})[key]||"FALTA COMPROBANTE";}
  function vehicleInfo(row={}){
    const raw=rowRaw(row);
    const plate=String(raw.vehiclePlate||raw.patente||raw.plate||raw.dominio||raw.autoPatente||"").trim().toUpperCase();
    const name=String(raw.vehicleDisplayName||raw.vehicleName||raw.vehiculoNombre||raw.autoNombre||raw.modelo||raw.vehicleModel||raw.autoModelo||"").trim();
    const id=String(raw.vehicleId||raw.vehiculoId||raw.autoId||raw.carId||"").trim();
    const label=[name,plate].filter(Boolean).join(" — ")||"VEHÍCULO SIN IDENTIFICAR";
    return{key:id||plate||name||"sin-vehiculo",label,plate,name};
  }
  function rowTimeMs(row={}){
    const raw=rowRaw(row);
    for(const value of [raw.receiptUploadedAt,raw.createdAt,raw.completedAt,raw.closedAt,raw.cerradoEn,raw.creadoEn,raw.updatedAt]){
      if(value?.toDate){const ms=value.toDate().getTime();if(Number.isFinite(ms))return ms;}
      if(value?.seconds){const ms=Number(value.seconds)*1000;if(Number.isFinite(ms))return ms;}
      const ms=Date.parse(value);if(Number.isFinite(ms))return ms;
    }
    const parsed=Date.parse(row.date);return Number.isFinite(parsed)?parsed:0;
  }
  function formatWeekLabel(value){
    const raw=String(value||"").trim();if(!raw)return"SIN SEMANA";
    const dates=raw.match(/\d{4}-\d{2}-\d{2}/g)||[];
    if(dates.length){
      const fmt=iso=>{const [y,m,d]=iso.split("-").map(Number);return new Intl.DateTimeFormat("es-AR",{timeZone:AR_TZ,day:"2-digit",month:"short"}).format(new Date(Date.UTC(y,m-1,d,12)));};
      return dates.length>1?`${fmt(dates[0])} AL ${fmt(dates[1])}`:`DESDE ${fmt(dates[0])}`;
    }
    return raw.toUpperCase();
  }
  function settlementText(row={}){
    const raw=rowRaw(row);const key=closureStatusKey(row);
    if(key==="balanced")return"Cuenta equilibrada";
    const explicit=String(raw.resultLabel||raw.resultadoFinal||raw.actionText||"").trim();if(explicit)return explicit;
    const payer=String(raw.payerRole||raw.payer||"").toLowerCase();
    if(["driver","chofer"].includes(payer))return"Chofer paga a David";
    if(["admin","david"].includes(payer))return"David paga al chofer";
    const driverDebt=Number(raw.choferDebe||raw.driverOwes||0),adminDebt=Number(raw.davidDebe||raw.adminOwes||0);
    if(driverDebt>0)return"Chofer paga a David";if(adminDebt>0)return"David paga al chofer";
    return"Resultado semanal";
  }
  function selectedWeekRows(rows=state.rows){return rows.filter(row=>!state.week||String(row.weeklyPeriodId||"")===String(state.week));}
  function filterRows(rows=state.rows,{ignoreStatus=false}={}){
    const q=state.search.toLowerCase().trim();
    return rows.filter(row=>{
      const status=normalizedState(row);
      if(!ignoreStatus){
        if(isClosureAdmin()&&["pendiente","recibido","aprobado","rechazado"].includes(state.filter)){
          const expected={pendiente:"missing",recibido:"received",aprobado:"confirmed",rechazado:"rejected"}[state.filter];
          if(closureStatusKey(row)!==expected)return false;
        }else if(state.filter==="semana"){
          const active=window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"";if(String(row.weeklyPeriodId||"")!==String(active))return false;
        }else if(state.filter==="mes"){
          const current=new Intl.DateTimeFormat("en-CA",{timeZone:AR_TZ,year:"numeric",month:"2-digit"}).format(new Date()).slice(0,7);if(String(row.monthKey||"")!==current)return false;
        }else if(state.filter!=="todos"&&!status.includes(state.filter))return false;
      }
      if(state.driver&&String(row.driverUid||row.driverName)!==state.driver)return false;
      if(state.month&&String(row.monthKey||"")!==state.month)return false;
      if(state.week&&String(row.weeklyPeriodId||"")!==state.week)return false;
      if(state.vehicle&&vehicleInfo(row).key!==state.vehicle)return false;
      const vehicle=vehicleInfo(row).label;
      if(q&&!`${row.title||""} ${row.subtitle||""} ${row.driverName||""} ${row.operationId||""} ${vehicle} ${settlementText(row)}`.toLowerCase().includes(q))return false;
      return true;
    });
  }
  function serviceOperationId(row={}){
    const raw=rowRaw(row);
    const direct=String(raw.relatedDocumentId||raw.recordId||raw.billingRecordId||raw.billingId||raw.operationId||row.billingRecordId||row.billingId||row.operationId||row.recordId||"").trim();
    const sourceCollection=String(raw.sourceCollection||"").toLowerCase();
    const sourceId=String(raw.id||"").trim();
    if(sourceCollection==="billing_records"&&sourceId)return sourceId;
    if(sourceCollection==="receipt_index"&&sourceId&&direct===sourceId&&/^payment_/i.test(sourceId))return sourceId.replace(/^payment_/i,"");
    if(direct)return direct;
    if(sourceCollection==="receipt_index"&&/^payment_/i.test(sourceId))return sourceId.replace(/^payment_/i,"");
    return sourceId;
  }
  function financialRowKind(row={}){
    const engineKind=window.ExploraReceiptEngine?.financialReceiptKind?.(row);if(engineKind)return engineKind;
    const raw=rowRaw(row),source=String(raw.sourceCollection||"").toLowerCase(),related=String(raw.relatedCollection||"").toLowerCase();
    const tokens=[row.category,raw.category,raw.type,raw.receiptCategory,raw.module,raw.expenseType,raw.tipo].map(value=>String(value||"").toLowerCase()).join(" ");
    if(source==="gastos"||related==="gastos"||/(^|\s)(expense|gasto|gastos)(\s|$)/.test(tokens))return"gasto";
    if(source==="billing_records"||related==="billing_records"||/(^|\s)(payment|billing|cobro|facturacion|facturación)(\s|$)/.test(tokens))return"cobro";
    return"";
  }
  function financialRowOperationId(row={}){
    const engineId=window.ExploraReceiptEngine?.financialReceiptDocumentId?.(row);if(engineId)return String(engineId);
    const raw=rowRaw(row);return String(raw.relatedDocumentId||raw.recordId||raw.expenseId||raw.gastoId||serviceOperationId(row)||"").trim();
  }
  function canManageFinancialRow(row={}){return isAdminView()&&Boolean(financialRowKind(row))&&Boolean(financialRowOperationId(row));}
  function financialRowKey(row={}){return `${financialRowKind(row)}:${financialRowOperationId(row)}`;}
  function rowCard(row,index){
    const stateClass=normalizedState(row).replace(/[^a-z]/g,"");const hasFile=Boolean(row.url),canManage=canManageFinancialRow(row),busy=state.deletingRowKey===financialRowKey(row);
    const manageButtons=canManage?`<span class="receipt-row-manage"><button type="button" class="receipt-edit-amount" data-receipt-edit-index="${index}" ${busy?"disabled":""}>EDITAR</button><button type="button" class="receipt-delete-financial" data-receipt-delete-index="${index}" ${busy?"disabled":""}>${busy?"ELIMINANDO…":"ELIMINAR"}</button></span>`:"";
    return `<article class="receipt-row-card${busy?" is-busy":""}"><span class="receipt-row-icon">▣</span><span class="receipt-row-info"><b>${esc(row.title||"Comprobante")}</b><small>Fecha: ${esc(row.date||"—")}</small><small>Usuario: ${esc(row.driverName||"—")}</small><small>Detalle: ${esc(row.detail||row.subtitle||"—")}</small></span><span class="receipt-row-side"><span class="receipt-row-amount">${money(row.amount)}</span><span class="receipt-state ${stateClass}">${esc(row.state||"Registrado")}</span><span class="receipt-row-actions">${hasFile?`<button type="button" class="receipt-view-photo" data-receipt-index="${index}">VER FOTO</button>`:`<small>SIN FOTO</small>`}${manageButtons}</span></span><span class="receipt-row-chevron">›</span></article>`;
  }
  function closureRowCard(row,index){
    const status=closureStatusKey(row),vehicle=vehicleInfo(row),hasFile=Boolean(row.url),amount=Number(row.amount)||0;
    return `<article class="receipt-closure-card is-${status}">
      <div class="receipt-closure-card-head"><div><span>${esc(row.driverName||"Chofer")}</span><small>${esc(vehicle.label)}</small></div><strong>${money(amount)}</strong></div>
      <div class="receipt-closure-result"><span>${esc(settlementText(row))}</span><small>${esc(row.date||"Fecha no disponible")}</small></div>
      <div class="receipt-closure-card-foot"><span class="receipt-closure-badge is-${status}">${closureStatusLabel(status)}</span><div class="receipt-closure-actions">${row.driverUid?`<button type="button" class="receipt-open-closure" data-admin-open-closure="${esc(row.driverUid)}" data-admin-closure-week="${esc(row.weeklyPeriodId||"")}">VER CIERRE</button>`:""}${hasFile?`<button type="button" class="receipt-view-photo" data-receipt-index="${index}">VER COMPROBANTE</button>`:`<small class="receipt-closure-no-file">Sin archivo cargado</small>`}</div></div>
    </article>`;
  }
  function groupedAdminHtml(rows){
    const drivers=new Map();
    rows.forEach(row=>{const key=String(row.driverUid||row.driverName||"sin-chofer");if(!drivers.has(key))drivers.set(key,{name:row.driverName||"Chofer",rows:[]});drivers.get(key).rows.push(row);});
    return [...drivers.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name,"es")).map(([,driver])=>{
      const months=new Map();driver.rows.forEach(row=>{const key=row.monthKey||"Sin mes";if(!months.has(key))months.set(key,[]);months.get(key).push(row);});
      const expand=state.category==="explora"?" open":"";
      const monthHtml=[...months.entries()].sort((a,b)=>String(b[0]).localeCompare(String(a[0]))).map(([month,monthRows])=>{
        const weeks=new Map();monthRows.forEach(row=>{const key=row.weeklyPeriodId||"Sin semana";if(!weeks.has(key))weeks.set(key,[]);weeks.get(key).push(row);});
        const weekHtml=[...weeks.entries()].map(([week,weekRows])=>`<details class="receipt-group-level receipt-group-week"${expand}><summary>SEMANA ${esc(week)} <span>${weekRows.length}</span></summary><div class="receipt-group-items">${weekRows.map(row=>rowCard(row,rows.indexOf(row))).join("")}</div></details>`).join("");
        return `<details class="receipt-group-level receipt-group-month"${expand}><summary>${esc(month)} <span>${monthRows.length}</span></summary>${weekHtml}</details>`;
      }).join("");
      return `<details class="receipt-group-level receipt-group-driver"${expand}><summary>${esc(driver.name)} <span>${driver.rows.length}</span></summary>${monthHtml}</details>`;
    }).join("");
  }
  function groupedClosureAdminHtml(rows){
    const statusOrder=["missing","received","rejected","confirmed","balanced"];
    const sorted=[...rows].sort((a,b)=>statusOrder.indexOf(closureStatusKey(a))-statusOrder.indexOf(closureStatusKey(b))||rowTimeMs(a)-rowTimeMs(b)||vehicleInfo(a).label.localeCompare(vehicleInfo(b).label,"es")||String(a.driverName||"").localeCompare(String(b.driverName||""),"es"));
    const weeks=new Map();sorted.forEach(row=>{const key=row.weeklyPeriodId||"sin-semana";if(!weeks.has(key))weeks.set(key,[]);weeks.get(key).push(row);});
    return [...weeks.entries()].sort((a,b)=>String(b[0]).localeCompare(String(a[0]))).map(([week,weekRows])=>{
      const statusSections=statusOrder.map(status=>{
        const statusRows=weekRows.filter(row=>closureStatusKey(row)===status);if(!statusRows.length)return"";
        const vehicles=new Map();statusRows.forEach(row=>{const info=vehicleInfo(row);if(!vehicles.has(info.key))vehicles.set(info.key,{info,rows:[]});vehicles.get(info.key).rows.push(row);});
        const vehicleHtml=[...vehicles.values()].sort((a,b)=>a.info.label.localeCompare(b.info.label,"es")).map((group,vehicleIndex)=>{
          const total=group.rows.reduce((sum,row)=>sum+(Number(row.amount)||0),0);const shouldOpen=["missing","received","rejected"].includes(status)&&vehicleIndex===0;
          return `<details class="receipt-vehicle-group is-${status}" ${shouldOpen?"open":""}><summary><span><b>${esc(group.info.label)}</b><small>${group.rows.length} ${group.rows.length===1?"cierre":"cierres"}</small></span><strong>${money(total)}</strong></summary><div class="receipt-vehicle-items">${group.rows.map(row=>closureRowCard(row,rows.indexOf(row))).join("")}</div></details>`;
        }).join("");
        return `<section class="receipt-closure-status-group is-${status}"><header><span>${closureStatusLabel(status)}</span><b>${statusRows.length}</b></header>${vehicleHtml}</section>`;
      }).join("");
      return `<section class="receipt-week-group"><header><span>SEMANA</span><strong>${esc(formatWeekLabel(week))}</strong></header>${statusSections}</section>`;
    }).join("");
  }
  function uniqueWeekIds(){return [...new Set(state.rows.map(row=>String(row.weeklyPeriodId||"").trim()).filter(Boolean))].sort((a,b)=>b.localeCompare(a));}
  function renderClosureOverview(){
    const box=$("receiptsClosureOverview");if(!box)return;const visible=isClosureAdmin();box.hidden=!visible;if(!visible)return;
    const base=filterRows(state.rows,{ignoreStatus:true});const counts={missing:0,received:0,confirmed:0,rejected:0};
    base.forEach(row=>{const key=closureStatusKey(row);if(key in counts)counts[key]++;});
    $("receiptsClosureWeekLabel")&&($("receiptsClosureWeekLabel").textContent=formatWeekLabel(state.week||window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||""));
    [["receiptsClosureMissing",counts.missing],["receiptsClosureReceived",counts.received],["receiptsClosureConfirmed",counts.confirmed],["receiptsClosureRejected",counts.rejected]].forEach(([id,value])=>{const el=$(id);if(el)el.textContent=String(value);});
    const weeks=uniqueWeekIds(),active=String(window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"");let currentIndex=weeks.indexOf(state.week||active);if(currentIndex<0)currentIndex=-1;const previous=currentIndex<0?weeks[0]:weeks[currentIndex+1];
    const previousButton=$("receiptsPreviousWeekBtn");if(previousButton){previousButton.disabled=!previous;previousButton.dataset.week=previous||"";previousButton.textContent=previous?"VER SEMANA ANTERIOR":"SIN SEMANA ANTERIOR";}
    const currentButton=$("receiptsCurrentWeekBtn");if(currentButton)currentButton.classList.toggle("is-active",!state.week||state.week===active);
  }
  function syncFilterLabels(){
    const map=Object.fromEntries([...document.querySelectorAll("[data-receipt-filter]")].map(button=>[button.dataset.receiptFilter,button]));
    const closure=isClosureAdmin();
    if(map.todos)map.todos.textContent="Todos";
    if(map.pendiente)map.pendiente.textContent=closure?"Por liquidar":"Pendientes";
    if(map.recibido){map.recibido.hidden=!closure;map.recibido.textContent="Comprobante recibido";}
    if(map.aprobado)map.aprobado.textContent=closure?"Pago confirmado":"Aprobados";
    if(map.rechazado)map.rechazado.textContent=closure?"Rechazado":"Rechazados";
    if(map.semana){map.semana.hidden=closure;map.semana.textContent="Esta semana";}
    if(map.mes){map.mes.hidden=closure;map.mes.textContent="Este mes";}
    if(!closure&&state.filter==="recibido")state.filter="todos";
    Object.values(map).forEach(button=>button?.classList.toggle("is-active",button.dataset.receiptFilter===state.filter));
  }
  function setAmountEditMessage(text="",kind=""){const el=$("receiptAmountEditMessage");if(!el)return;el.textContent=text;el.className=`receipt-amount-edit-message${kind?` is-${kind}`:""}`;}
  function formatAmountInput(value){const digits=String(value??"").replace(/\D/g,"").replace(/^0+/,"");return digits?Number(digits).toLocaleString("es-AR"):"";}
  function parseAmountInput(value){const digits=String(value??"").replace(/\D/g,"");const amount=Number(digits);return Number.isFinite(amount)?Math.round(amount):0;}
  function openAmountEditor(row){if(!canManageFinancialRow(row))return;state.editingRow=row;const backdrop=$("receiptAmountEditBackdrop"),input=$("receiptAmountEditInput"),kind=financialRowKind(row),isExpense=kind==="gasto";if(!backdrop||!input)return;const kicker=backdrop.querySelector(".receipt-amount-edit-kicker"),title=$("receiptAmountEditTitle"),description=backdrop.querySelector(".receipt-amount-edit-description"),save=$("receiptAmountEditSave");if(kicker)kicker.textContent=`ADMINISTRADOR · ${isExpense?"GASTO":"COBRO"}`;if(title)title.textContent=isExpense?"EDITAR GASTO":"EDITAR COBRO";if(description)description.textContent=isExpense?"Corregí el importe del gasto. El cierre de Gastos y el saldo a liquidar se recalcularán automáticamente.":"Corregí el importe cobrado. Facturación, Caja Chica y quién paga a quién se recalcularán automáticamente.";if(save)save.textContent="GUARDAR CAMBIO";$("receiptAmountEditDriver").textContent=row.driverName||"Chofer";$("receiptAmountEditCurrent").textContent=money(row.amount);input.value=formatAmountInput(row.amount);setAmountEditMessage("Verificá el nuevo importe antes de guardar.");backdrop.classList.add("is-open");backdrop.setAttribute("aria-hidden","false");window.lockPageScroll?.("receipt-amount-edit");setTimeout(()=>{input.focus();input.select?.();},80);}
  function closeAmountEditor(force=false){if(state.savingAmount&&!force)return;const backdrop=$("receiptAmountEditBackdrop");backdrop?.classList.remove("is-open");backdrop?.setAttribute("aria-hidden","true");state.editingRow=null;setAmountEditMessage("");window.unlockPageScroll?.("receipt-amount-edit");}
  async function saveEditedAmount(){if(state.savingAmount||!state.editingRow)return;const row=state.editingRow,input=$("receiptAmountEditInput"),save=$("receiptAmountEditSave"),cancel=$("receiptAmountEditCancel"),kind=financialRowKind(row);const amount=parseAmountInput(input?.value);const current=Math.round(Number(row.amount)||0);if(!(amount>0)){setAmountEditMessage("Ingresá un valor mayor a $0.","error");input?.focus();return;}if(amount===current){setAmountEditMessage("El nuevo valor es igual al actual.","error");input?.focus();return;}if(!window.ExploraReceiptEngine?.modifyFinancialAmount){setAmountEditMessage("El módulo de corrección todavía no está disponible. Cerrá y volvé a abrir la app.","error");return;}state.savingAmount=true;if(save)save.disabled=true;if(cancel)cancel.disabled=true;if(input)input.disabled=true;setAmountEditMessage("Guardando y recalculando cierres…");try{await window.ExploraReceiptEngine.modifyFinancialAmount(row,amount);row.amount=amount;if(row.raw&&typeof row.raw==="object"){row.raw.amount=amount;row.raw.monto=amount;row.raw.valor=amount;row.raw.finalPrice=amount;}setAmountEditMessage(`${kind==="gasto"?"Gasto":"Cobro"} corregido correctamente.`,"success");["explora","chofer","gastos","caja_chica"].forEach(invalidate);await load(state.category,{force:true});setStatus(`Importe corregido a ${money(amount)}. Cierres recalculados.`);setTimeout(()=>closeAmountEditor(true),450);}catch(error){console.error("RECEIPT_AMOUNT_EDIT",error);const code=String(error?.code||error?.message||"");const message=code.includes("NOT_FOUND")?`No se encontró ${kind==="gasto"?"el gasto":"el cobro"} original en Firestore.`:code.includes("CLOSURE_LOOKUP")?"No se pudo verificar el cierre relacionado. No se aplicó ningún cambio.":code.includes("AUTH")||code.includes("ADMIN")||code.includes("permission")?"La sesión de administrador no tiene permiso para modificar este comprobante.":code.includes("INVALID")?"Ingresá un valor válido.":"No se pudo modificar el comprobante. Revisá la conexión e intentá nuevamente.";setAmountEditMessage(message,"error");}finally{state.savingAmount=false;if(save)save.disabled=false;if(cancel)cancel.disabled=false;if(input)input.disabled=false;}}
  async function deleteFinancialRow(row){if(state.deletingRowKey||!canManageFinancialRow(row))return;const kind=financialRowKind(row),label=kind==="gasto"?"gasto":"cobro",operationId=financialRowOperationId(row);if(!operationId)return;const confirmed=window.confirm(`¿Eliminar este ${label} de ${money(row.amount)}?\n\nSe eliminará el comprobante y se recalcularán los cierres relacionados. Esta acción no se puede deshacer.`);if(!confirmed)return;if(!window.ExploraReceiptEngine?.deleteFinancialMovement){setStatus("El módulo para eliminar comprobantes todavía no está disponible. Cerrá y volvé a abrir la app.",true);return;}state.deletingRowKey=financialRowKey(row);setStatus(`Eliminando ${label} y recalculando cierres…`);render();try{await window.ExploraReceiptEngine.deleteFinancialMovement(row);["explora","chofer","gastos","caja_chica"].forEach(invalidate);await load(state.category,{force:true});setStatus(`${kind==="gasto"?"Gasto":"Cobro"} eliminado correctamente. Cierres recalculados.`);}catch(error){console.error("RECEIPT_DELETE",error);const code=String(error?.code||error?.message||"").toLowerCase();const message=code.includes("not-found")||code.includes("no existe")?"El movimiento ya no existe. Actualizá la lista.":code.includes("permission")||code.includes("admin")?"La sesión no tiene permiso para eliminar este comprobante.":"No se pudo eliminar el comprobante. No se modificaron los demás movimientos.";setStatus(message,true);}finally{state.deletingRowKey="";render();}}
  function render(){
    const list=$("receiptsList"),rows=filterRows();if(!list)return;
    list.innerHTML=isClosureAdmin()?groupedClosureAdminHtml(rows):isAdminView()?groupedAdminHtml(rows):rows.map((row,index)=>rowCard(row,index)).join("");
    $("receiptsEmpty").classList.toggle("is-visible",!rows.length);$("receiptsEmpty").textContent=emptyMessages[state.category]||"No se encontraron comprobantes.";
    list.querySelectorAll("[data-receipt-index]").forEach(button=>button.addEventListener("click",()=>window.ExploraReceiptEngine?.openReceiptViewer?.(rows[Number(button.dataset.receiptIndex)])));
    list.querySelectorAll("[data-receipt-edit-index]").forEach(button=>button.addEventListener("click",()=>openAmountEditor(rows[Number(button.dataset.receiptEditIndex)])));
    list.querySelectorAll("[data-receipt-delete-index]").forEach(button=>button.addEventListener("click",()=>deleteFinancialRow(rows[Number(button.dataset.receiptDeleteIndex)])));
    list.querySelectorAll("[data-admin-open-closure]").forEach(button=>button.addEventListener("click",()=>window.ExploraAdminShared?.openClosure?.(button.dataset.adminOpenClosure||"",button.dataset.adminClosureWeek||"")));
    renderClosureOverview();
  }
  function syncAdminFilters(){
    const wrap=$("receiptsAdminFilters");if(!wrap)return;wrap.hidden=!isAdminView();if(!isAdminView())return;
    const driver=$("receiptsDriverFilter"),month=$("receiptsMonthFilter"),week=$("receiptsWeekFilter"),vehicle=$("receiptsVehicleFilter");
    const unique=(key,label)=>[...new Map(state.rows.filter(row=>row[key]).map(row=>[String(row[key]),String(label(row))])).entries()];
    driver.innerHTML='<option value="">Todos los choferes</option>'+unique("driverUid",row=>row.driverName||row.driverUid).sort((a,b)=>a[1].localeCompare(b[1],"es")).map(([value,text])=>`<option value="${esc(value)}">${esc(text)}</option>`).join("");
    month.innerHTML='<option value="">Todos los meses</option>'+unique("monthKey",row=>row.monthKey).sort((a,b)=>b[0].localeCompare(a[0])).map(([value,text])=>`<option value="${esc(value)}">${esc(text)}</option>`).join("");
    week.innerHTML='<option value="">Todas las semanas</option>'+uniqueWeekIds().map(value=>`<option value="${esc(value)}">${esc(formatWeekLabel(value))}</option>`).join("");
    if(vehicle){const vehicles=[...new Map(state.rows.map(row=>{const info=vehicleInfo(row);return[info.key,info.label];})).entries()].sort((a,b)=>a[1].localeCompare(b[1],"es"));vehicle.innerHTML='<option value="">Todos los vehículos</option>'+vehicles.map(([value,text])=>`<option value="${esc(value)}">${esc(text)}</option>`).join("");vehicle.value=state.vehicle;}
    driver.value=state.driver;month.value=state.month;week.value=state.week;
    wrap.classList.toggle("is-closure-mode",isClosureAdmin());
    const monthLabel=month.closest("label"),vehicleLabel=vehicle?.closest("label");if(monthLabel)monthLabel.hidden=isClosureAdmin();if(vehicleLabel)vehicleLabel.hidden=!isClosureAdmin();
    const search=$("receiptsSearchInput");if(search)search.placeholder=isClosureAdmin()?"Buscar chofer, vehículo o patente…":"Buscar pago o chofer…";
    syncFilterLabels();renderClosureOverview();
  }
  async function load(category=state.category,{force=false}={}){
    const categoryChanged=state.category!==category;state.category=category;
    if(categoryChanged){state.filter="todos";state.search="";state.driver="";state.month="";state.week="";state.vehicle="";const search=$("receiptsSearchInput");if(search)search.value="";}
    const [title,subtitle]=titles[category]||titles.deudas;$("receiptsListTitle").textContent=title;$("receiptsListSubtitle").textContent=subtitle;screen.dataset.view="list";syncFilterLabels();
    if(!force&&state.cache.has(category)){state.rows=state.cache.get(category);if(isClosureAdmin()&&!state.week){const active=String(window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"");const weeks=uniqueWeekIds();state.week=weeks.includes(active)?active:(weeks[0]||"");}syncAdminFilters();render();return;}
    state.loading=true;setStatus("Cargando comprobantes…");
    try{
      state.rows=await window.ExploraReceiptsData?.load?.(category)||[];state.cache.set(category,state.rows);
      if(isClosureAdmin()){
        const active=String(window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"");const weeks=uniqueWeekIds();state.week=weeks.includes(active)?active:(weeks[0]||"");
      }else if(isAdminView()&&!state.month&&category!=="alias"){const now=new Date();state.month=new Intl.DateTimeFormat("en-CA",{timeZone:AR_TZ,year:"numeric",month:"2-digit"}).format(now).slice(0,7);}
      if(isAdminView()&&!isClosureAdmin()&&!state.week&&category!=="alias")state.week=window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"";
      setStatus("");syncAdminFilters();render();
    }catch(error){console.warn("RECEIPTS_LOAD",error);setStatus("No se pudieron cargar los comprobantes. Toca para reintentar.",true);state.rows=[];syncAdminFilters();render();}
    finally{state.loading=false;}
  }
  function invalidate(category){if(category)state.cache.delete(category);else state.cache.clear();}
  window.invalidateReceiptCache=invalidate;
  window.ExploraReceipts={open,close,openAdminPayments,openCategory:(category)=>{state.adminMode=isAdmin();open({adminMode:state.adminMode});return load(category);},refresh:(category=state.category)=>{invalidate(category);return load(category,{force:true});},invalidate};
  window.ExploraActions=window.ExploraActions||{};window.ExploraActions.comprobantes=()=>{state.adminMode=false;open({adminMode:false});};window.ExploraActions["resumen-comprobantes"]=window.ExploraActions.comprobantes;window.ExploraActions["admin-comprobantes"]=openAdminPayments;
  document.addEventListener("DOMContentLoaded",()=>{
    $("receiptsBackBtn")?.addEventListener("click",()=>{if(screen.dataset.view==="list"){screen.dataset.view="main";return;}close();});
    $("receiptsScreen")?.addEventListener("click",event=>{const button=event.target.closest("[data-receipt-category]");if(button){state.adminMode=isAdmin();screen.dataset.adminMode=state.adminMode?"true":"false";load(button.dataset.receiptCategory);}});
    $("receiptsSearchInput")?.addEventListener("input",event=>{state.search=event.target.value;render();});
    $("receiptsFilterRow")?.addEventListener("click",event=>{const button=event.target.closest("[data-receipt-filter]");if(!button||button.hidden)return;state.filter=button.dataset.receiptFilter;document.querySelectorAll("[data-receipt-filter]").forEach(item=>item.classList.toggle("is-active",item===button));render();});
    [["receiptsDriverFilter","driver"],["receiptsMonthFilter","month"],["receiptsWeekFilter","week"],["receiptsVehicleFilter","vehicle"]].forEach(([id,key])=>$(id)?.addEventListener("change",event=>{state[key]=event.target.value;render();syncAdminFilters();}));
    $("receiptsCurrentWeekBtn")?.addEventListener("click",()=>{const active=String(window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id||"");state.week=active;const select=$("receiptsWeekFilter");if(select)select.value=state.week;render();syncAdminFilters();});
    $("receiptsPreviousWeekBtn")?.addEventListener("click",event=>{const week=event.currentTarget.dataset.week||"";if(!week)return;state.week=week;const select=$("receiptsWeekFilter");if(select)select.value=week;render();syncAdminFilters();});
    $("receiptsStatus")?.addEventListener("click",()=>{if($("receiptsStatus").classList.contains("err"))load(state.category,{force:true});});
    $("receiptAmountEditInput")?.addEventListener("input",event=>{event.target.value=formatAmountInput(event.target.value);setAmountEditMessage("");});
    $("receiptAmountEditInput")?.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();saveEditedAmount();}else if(event.key==="Escape"){event.preventDefault();closeAmountEditor();}});
    $("receiptAmountEditCancel")?.addEventListener("click",()=>closeAmountEditor());
    $("receiptAmountEditSave")?.addEventListener("click",saveEditedAmount);
    $("receiptAmountEditBackdrop")?.addEventListener("click",event=>{if(event.target?.id==="receiptAmountEditBackdrop")closeAmountEditor();});
  });
})();
