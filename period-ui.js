import {exploraIcon,escapeUi} from './explora-ui.js?v=20260919-login-period-1';
const money=value=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(value)||0);
const row=(label,value,total=false,subtitle='')=>`<div class="period-row${total?' period-total':''}"><span>${escapeUi(label)}${subtitle?`<small class="period-row-subtitle">${escapeUi(subtitle)}</small>`:''}</span><strong>${escapeUi(money(value))}</strong></div>`;
function section(tone,icon,title,description,body){return `<section class="period-section ${tone}"><div class="period-section-label"><span class="period-section-icons">${exploraIcon(icon)}${tone==='cash'?'<img class="period-uber-logo" src="./assets/uber-logo.svg" alt="" width="34" height="12">':''}</span><h2>${title}</h2><p>${description}</p></div><div class="period-section-data">${body}</div></section>`;}
const round=value=>Math.round((Number(value)||0)*100)/100;
const paymentMessage=(balance,reason)=>Math.abs(balance)<=.005
  ? `<div class="period-instruction"><strong>Sin importe pendiente</strong><small>${escapeUi(reason)}</small></div>`
  : `<div class="period-instruction"><strong>${balance>0?'Pasale':'Explora te pasa'} <span>${escapeUi(money(Math.abs(balance)))}</span>${balance>0?' a Explora':''}</strong><small>${escapeUi(reason)}</small></div>`;

// Present the wallet equalization and every debt separately. An expense already
// deducted from a wallet is compensated explicitly, so it cannot be charged twice.
export function periodBreakdown(quote) {
  const s=quote.summary;
  const debts=[...(s.debtRows||[]),...(s.externalDebtRows||[])];
  const detailedExternal=round((s.externalDebtRows||[]).reduce((sum,debt)=>sum+debt.amount,0));
  const otherExternal=round((s.externalDebt||0)-detailedExternal);
  if(otherExternal>0)debts.push({label:'tu deuda',amount:otherExternal});
  const expenseDebt=round((s.debtRows||[]).reduce((sum,debt)=>sum+debt.amount,0));
  const compensation=round((s.responsibilityAdjustment||0)-expenseDebt);
  const lines=[{label:'Debés de caja chica',balance:s.cashbox},
    ...debts.map(debt=>({label:`Debés de ${debt.label.toLocaleLowerCase('es-AR')}`,balance:debt.amount})),
    {label:s.walletDifference<0?'Explora te debe de billetera':'Debés de billetera',balance:s.walletDifference}];
  if(Math.abs(compensation)>.005)lines.push({label:compensation<0?'Compensación a tu favor por gastos de billetera':'Compensación a Explora por gastos de billetera',balance:compensation});
  if(Math.abs(s.previousBalance)>.005)lines.push({label:s.previousBalance>0?'Debés de saldo anterior':'Explora te debe de saldo anterior',balance:s.previousBalance});
  if(Math.abs(s.previousBalance)>.005)debts.push({label:s.previousBalance>0?'Deuda del saldo anterior':'Saldo anterior a tu favor',amount:s.previousBalance});
  return {debts,debtTotal:round(debts.reduce((sum,debt)=>sum+debt.amount,0)),lines,
    walletTarget:round((s.netCash+s.netDigital)/2),compensation};
}
export function periodMarkup(quote) {
  const s=quote.summary,driverPays=quote.balance>0.5,balanced=quote.amount<=.5;
  const breakdown=periodBreakdown(quote);
  const walletMessage=paymentMessage(s.walletDifference,`Para que ambos tengan ${money(breakdown.walletTarget)} en sus billeteras.`);
  return section('cash','cash','Efectivo y Uber','Ingresos y gastos<br>en mano',row('Total cobrado',s.cash)+row('Total gastado',-s.cashExpense)+row('NETO EFECTIVO',s.netCash,true)+(s.walletDifference>.005?walletMessage:''))+
    section('digital','digital','Digital','Tarjeta,<br>transferencia o QR',row('Total cobrado',s.digital)+row('Total gastado',-s.digitalExpense)+row('NETO DIGITAL',s.netDigital,true)+(s.walletDifference<-.005?walletMessage:''))+
    section('cashbox','expense','Caja chica','10% sobre el<br>total bruto',row('Total cobrado (efectivo + digital)',s.gross)+row('Total caja chica',s.cashbox,true,'10% facturación total')+paymentMessage(s.cashbox,'De caja chica.'))+
    section('debts','debt','Deudas','Gastos a cargo<br>del chofer (100%)',
      (breakdown.debts.length?breakdown.debts.map(debt=>row(debt.label,debt.amount)).join(''):row('Deudas pendientes',0))+
      row('TOTAL DEUDA',breakdown.debtTotal,true)+
      paymentMessage(breakdown.debtTotal,breakdown.debtTotal<0?'Por la deuda de Explora con vos.':'Por tu deuda.'))+
    section('period-summary','management','Resumen','Un único<br>cierre',
      breakdown.lines.filter(line=>Math.abs(line.balance)>.005).map(line=>row(line.label,Math.abs(line.balance))).join('')+
      row(balanced?'CUENTAS EQUILIBRADAS':driverPays?'PÁSALE A EXPLORA':'EXPLORA TE PASA',quote.amount,true)+
      `<div class="period-closed-note"><span aria-hidden="true">✓</span><small>${balanced?'Todo está cerrado.':'Y queda todo cerrado.'}</small></div>`);
}
export function mountPeriodClose({getQuote,uploadProof,confirmClose,showScreen,onCompleted}) {
  const $=id=>document.getElementById(id),modal=$('periodReceiptModal');
  let quote=null,busy=false,openGeneration=0,uploadedProofPath='';
  const status=text=>{$('periodReceiptStatus').textContent=text;};
  function setBusy(value){busy=value;modal.setAttribute('aria-busy',String(value));for(const id of ['periodReceiptFile','dismissPeriodReceipt','cancelPeriodReceipt'])$(id).disabled=value;$('acceptPeriodReceipt').disabled=value||!uploadedProofPath;modal.querySelector('.receipt-file-label').setAttribute('aria-disabled',String(value));}
  function dismiss(){if(busy)return;modal.classList.add('hidden');$('periodReceiptFile').value='';uploadedProofPath='';setBusy(false);status('');$('confirmPeriodClose').focus();}
  async function open(){
    const generation=++openGeneration;quote=null;uploadedProofPath='';setBusy(false);showScreen('period');
    $('periodDate').textContent=new Date().toLocaleDateString('es-AR',{day:'numeric',month:'short',year:'numeric'});
    $('periodSections').innerHTML='';$('periodSections').setAttribute('aria-busy','true');
    $('periodStatus').innerHTML=`<span class="period-loading"><span class="period-loading-symbol" aria-hidden="true">${exploraIcon('wallet')}</span><span>Cargando tu período…</span></span>`;
    $('confirmPeriodClose').disabled=true;
    try{const result=await getQuote();if(generation!==openGeneration)return;quote=result;$('periodSections').innerHTML=periodMarkup(quote);$('periodStatus').textContent='';$('confirmPeriodClose').disabled=quote.amount<=.5;}
    catch(error){if(generation===openGeneration)$('periodStatus').textContent=error.message||'No se pudo consultar el cierre. Volvé a intentarlo.';}
    finally{if(generation===openGeneration)$('periodSections').setAttribute('aria-busy','false');}
  }
  $('openPeriodClose').addEventListener('click',open);
  $('confirmPeriodClose').addEventListener('click',()=>{if(!quote||busy||quote.amount<=.5)return;status('');modal.classList.remove('hidden');modal.querySelector('.receipt-file-label').focus();});
  $('dismissPeriodReceipt').addEventListener('click',dismiss);$('cancelPeriodReceipt').addEventListener('click',dismiss);
  modal.addEventListener('click',event=>{if(event.target===modal)dismiss();});
  const label=modal.querySelector('.receipt-file-label');
  label.addEventListener('click',event=>{if(busy)event.preventDefault();});
  label.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();if(!busy)$('periodReceiptFile').click();}});
  modal.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();dismiss();}
    if(event.key==='Tab'){const controls=[...modal.querySelectorAll('button,[tabindex="0"]')].filter(el=>!el.disabled);if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}}
  });
  $('periodReceiptFile').addEventListener('change',async event=>{
    const file=event.target.files?.[0];event.target.value='';
    if(!file||busy||!quote)return;
    uploadedProofPath='';setBusy(false);
    if(!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(file.type)||!file.size||file.size>15*1024*1024){status('Elegí una imagen o PDF de hasta 15 MB.');return;}
    setBusy(true);status('Cargando comprobante…');
    try {
      uploadedProofPath=await uploadProof(file,quote.quoteId);
      status(`Comprobante cargado: ${file.name}. Tocá “Aceptar y cerrar” para finalizar.`);
    } catch(error){status(error.message||'No se pudo cargar el comprobante. Volvé a intentarlo.');}
    finally{setBusy(false);}
  });
  $('acceptPeriodReceipt').addEventListener('click',async()=>{
    if(busy||!quote||!uploadedProofPath)return;
    setBusy(true);status('Confirmando cierre…');
    try {
      await confirmClose({quoteId:quote.quoteId,proofPath:uploadedProofPath});
      setBusy(false);dismiss();await open();$('periodStatus').textContent='Cierre confirmado. El comprobante quedó asociado al cierre.';onCompleted?.();
    } catch(error){status(error.message||'No se pudo confirmar. Volvé a tocar “Aceptar y cerrar” para reintentar.');}
    finally{setBusy(false);}
  });
  return {open};
}
