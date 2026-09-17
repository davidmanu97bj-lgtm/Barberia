import {shortReceiptName,shortInvoiceName} from './receipt-files.js';
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const currency=new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:0,maximumFractionDigits:2});
const format=value=>currency.format(Number(value)||0);
const icons={
  cash:'<rect x="2" y="5" width="20" height="14" rx="2"/><ellipse cx="12" cy="12" rx="3" ry="4"/><path d="M5 8h.01M19 16h.01"/>',
  digital:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/>',
  expense:'<path d="M3 21V3h11v18M2 21h14M3 10h11M14 8h2l3 3v6a2 2 0 0 0 4 0V8l-4-4"/>',
  wallet:'<path d="m4 7 13-5 3 7M4 8h16v13H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z"/><path d="M15 13h6v5h-6Z"/>',
  result:'<path d="M4 21V12h3v9Zm7 0V7h3v14Zm7 0V2h3v19Z"/>',
  debt:'<path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2Z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  distribution:'<path d="M12 2v10h10A10 10 0 0 0 12 2Z"/><path d="M8 3a10 10 0 1 0 13 13H8Z"/>'
};
const icon=name=>name==='uber'?'<span class="statement-uber-icon" aria-hidden="true">U</span>':`<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]||icons.result}</svg>`;
const rowTimeForStatement=row=>globalThis.ExploraPeriodSettlement.rowTime(row);
const dateOf=row=>{
  const ms=globalThis.ExploraPeriodSettlement.rowTime(row);
  return ms ? new Intl.DateTimeFormat('es-AR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(ms)) : '';
};
export function documentButton(row,kind,invoices=new Map()) {
  const id=String(row.id || row.closureId || '');
  if (!id) return '<span class="statement-pdf-missing">Sin comprobante</span>';
  if (kind==='invoice') {
    const invoice=invoices.get(id), name=shortInvoiceName(invoice);
    const status=invoice?.status;
    const pending=status==='disabled'?'ARCA desactivada':status==='rejected'?'ARCA rechazada':status==='review'?'ARCA en revisión':'ARCA pendiente';
    return `<button type="button" class="statement-pdf${name?'':' is-pending'}" data-document-kind="invoice" data-document-id="${escape(id)}" title="${escape(name || pending)}">${escape(name || pending)}</button>`;
  }
  const hasProof=row.receiptPdfPath || row.proofPath || row.receiptPath || row.proofUrl || row.receiptUrl;
  if (!hasProof) return '<span class="statement-pdf-missing">Sin comprobante</span>';
  const kinds={expense:'gastos',uber:'uber_weekly_closures',debt:'deudas_choferes',advance:'prestamos_operativos',closure:'cierres_semanales',management:'billing_records',debtPayment:'deuda_pagos'};
  return `<button type="button" class="statement-pdf" data-document-kind="receipt" data-document-collection="${kinds[kind]||'billing_records'}" data-document-id="${escape(id)}" title="Abrir comprobante PDF">${escape(row.receiptPdfFileName || shortReceiptName(kind,id))}</button>`;
}
export function statementHtml({model,driverName,invoices=new Map(),orderedRows}) {
  const m=model, rows=orderedRows||m.rows;
  const line=(label,value,className='')=>`<div class="statement-total ${className}"><span>${escape(label)}</span><strong>${format(value)}</strong></div>`;
  const entries=(items,kind,defaultLabel)=>items.length?items.map(row=>{
    const effectiveKind=row.statementKind||kind;
    const label=row.statementLabel||(effectiveKind==='debt'?(row.debtLabel||row.reasonLabel||row.detail||row.reason||row.notes||'Deuda del chofer'):effectiveKind==='expense'?(row.expenseLabel||globalThis.ExploraExpensePolicy?.find(row.expenseType)?.label||row.detail||row.expenseType||'Gasto'):defaultLabel);
    const amount=row.statementAmount ?? globalThis.ExploraPeriodSettlement.amount(row);
    const debtDetail=kind==='debt' ? ' · Saldo pendiente'+(rowTimeForStatement(row) <= m.effectiveCutoffMs && m.effectiveCutoffMs ? ' anterior al período' : '')+(row.debtLabel && row.detail && row.detail !== row.debtLabel ? ' · '+row.detail : '') : '';
    return `<div class="statement-line"><span class="statement-concept">${escape(label)}<small>${escape(dateOf(row)+debtDetail)}</small></span>${documentButton(row,effectiveKind,invoices)}<strong>${format(amount)}</strong></div>`;
  }).join(''):'<p class="statement-empty">Sin movimientos en este período.</p>';
  const section=(name,title,items,kind,total,totalLabel)=>`<section class="statement-section tone-${name}" data-statement-section="${name}"><h2>${icon(name)}<span>${escape(title)}</span></h2>${entries(items,kind,kind==='invoice'?'Viaje':'Uber semanal')}${line(totalLabel,total,'is-subtotal')}</section>`;
  const times=[...rows.cash,...rows.digital,...rows.expenses].map(globalThis.ExploraPeriodSettlement.rowTime).filter(Boolean);
  const since=m.effectiveCutoffMs || (times.length?Math.min(...times):0);
  const period=since ? new Intl.DateTimeFormat('es-AR',{day:'numeric',month:'short',year:'numeric'}).format(new Date(since))+' — '+new Intl.DateTimeFormat('es-AR',{day:'numeric',month:'short',year:'numeric'}).format(new Date()) : 'Período abierto';
  const balanceText=m.balance>0?'Debes a Explora':m.balance<0?'Explora te debe':'Cuenta al día';
  const adjustmentNeeded=m.openingBalance||m.adminDebt||m.advanceRepayments||m.driverPaid||m.exploraPaid;
  return `<header class="statement-heading"><div><h1>Movimientos del período</h1><p>${escape(period)}</p></div><div class="statement-driver"><span>Chofer</span><strong>${escape(driverName)}</strong></div></header>
    ${section('cash','Cobros efectivo',rows.cash,'invoice',m.cash,'Total cobrado en efectivo')}
    ${section('expense','Gastos pagados en efectivo',rows.expenses.filter(row=>!['explora','admin','administrador'].includes(String(row.payerRole||row.paidByRole||'').toLowerCase())),'expense',m.expenseCash,'Total gastos pagados en efectivo')}
    <div class="statement-cash-held">${icon('wallet')}<span>Efectivo restante en poder del chofer</span><strong>${format(m.cashRemaining)}</strong></div>
    ${section('digital','Cobros digital',rows.digital,'invoice',m.digital,'Total cobrado digital')}
    ${m.expenseDigital?section('expense','Gastos pagados por Explora',rows.expenses.filter(row=>['explora','admin','administrador'].includes(String(row.payerRole||row.paidByRole||'').toLowerCase())),'expense',m.expenseDigital,'Total gastos pagados por Explora'):''}
    ${section('debt','Deudas chofer 100%',rows.debts||[],'debt',m.driverDebtTotal ?? m.adminDebt,'Total deudas chofer 100%')}
    <p class="statement-debt-note">Saldos pendientes de deudas aceptadas, incluso anteriores al período. Se suman a la liquidación; no reducen el efectivo ni generan Caja Explora. Los pagos de la cuenta se muestran por separado.</p>
    <section class="statement-section tone-result" data-statement-section="result"><h2>${icon('result')}<span>Resultado del período</span></h2>
      ${line('Efectivo restante en mano del chofer',m.cashRemaining)}
      ${line('Digital cuenta de Explora',m.digitalRemaining)}
      <div class="tone-distribution">${line('Total a dividir',m.totalToSplit,'is-subtotal')}</div>
    </section>
    <section class="statement-section tone-distribution" data-statement-section="distribution"><h2>${icon('distribution')}<span>Distribución</span></h2>
      ${line('40% Chofer',m.driverShare)}${line('60% Explora',m.exploraShare)}
      <p class="statement-distribution-note">(Incluye Caja chica efectivo + caja chica digital + dinero en digital)</p>
    </section>
    ${adjustmentNeeded?`<section class="statement-section tone-result" data-statement-section="adjustments"><h2>Liquidación y ajustes</h2>${line('Diferencia del período',m.periodBalance)}${m.openingBalance?line('Saldo anterior conservado',m.openingBalance):''}${m.adminDebt?line('Deudas chofer 100% · incorporadas una vez',m.adminDebt):''}${m.advanceRepayments?line('Aplicado a adelantos',m.advanceRepayments):''}${m.driverPaid?line('Pagos del chofer a Explora',-m.driverPaid):''}${m.exploraPaid?line('Pagos de Explora al chofer',m.exploraPaid):''}</section>`:''}
    <div class="statement-settlement ${m.balance>0?'is-owing':m.balance<0?'is-receiving':'is-balanced'}" role="status">${icon('wallet')}<div><span>${balanceText}</span><strong>${format(Math.abs(m.balance))}</strong></div><small>${m.balance===0?'No hay diferencia pendiente.':'Importe pendiente de liquidar; no es un cobro nuevo.'}</small></div>
    ${m.available<0?'<p class="statement-warning">Los gastos superan los cobros. La pérdida se comparte por mitades y no genera Caja Explora.</p>':''}
    <footer class="statement-footer"><p>Juntos hacemos<br>que cada viaje cuente</p><img src="./assets/explora-logo.png" alt="Explora · Iguazú Viajes y Servicios" width="1942" height="809"></footer>`;
}
