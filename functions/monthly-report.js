'use strict';
const {createHash}=require('node:crypto');
const PDFDocument=require('pdfkit');
const periodPolicy=require('./period-policy');
const collections={cobros:'billing_records',gastos:'gastos',cierres:'cierres_semanales',deudas:'deudas_choferes',pagosDeuda:'deuda_pagos',adelantos:'prestamos_operativos',uber:'uber_weekly_closures'};
const owners=['driverUid','choferUid','uid','ownerUid','driverId','choferId','userUid','operatorUid'];
const clean=value=>String(value??'').replace(/[\r\n\t]+/g,' ').slice(0,1000);
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const amount=r=>Number(r.amount??r.monto??r.grossAmount??r.totalAmount??r.principalAmount??0)||0;
const stamp=r=>Number(r.createdAtMs)||r.createdAt?.toMillis?.()||Date.parse(r.createdAt)||0;
const localDate=ms=>ms ? new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms)) : '';
const method=r=>/cash|efectivo/.test(String(r.method||r.paymentMethod||''))?'Efectivo':'Digital';
const inactive=r=>r.deleted||r.isDeleted||r.eliminado||/cancel|anulad|reject|rechaz|deleted/.test(r.status||r.reviewStatus||'');
const serviceDate=r=>/^\d{4}-\d{2}-\d{2}$/.test(r.invoiceRequest?.serviceDate||r.serviceDate||'') ? (r.invoiceRequest?.serviceDate||r.serviceDate) : localDate(stamp(r));
const proof=r=>{const url=r.proofUrl||r.receiptUrl||r.comprobanteUrl||'';return /^https?:\/\//.test(url)?url:'';};
const formatCuit=value=>{const digits=String(value||'').replace(/\D/g,'');return digits.length===11?`${digits.slice(0,2)}-${digits.slice(2,10)}-${digits.slice(10)}`:'';};
function buildMonthlyReport({uid,profile={},month,input,now=Date.now(),explora={}}) {
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))throw new Error('Elegí un mes válido.');
  const current=localDate(now).slice(0,7);if(month>current)throw new Error('El mes todavía no comenzó.');
  const rows=[],issues=[];let cash=0,digital=0,cashbox=0;
  const add=(group,r,date,extra={})=>rows.push({group,id:r.id,date,dateRegistered:localDate(stamp(r)),amount:round(amount(r)),detail:clean(r.detail||r.notes||r.reason||r.description||r.service||r.expenseLabel||r.expenseType||group),status:clean(r.status||r.reviewStatus||'sin estado'),proof:proof(r),...extra});
  const acceptedClosures=new Set((input.cierres||[]).filter(r=>!inactive(r)&&['completed','paid','approved'].includes(r.status)).map(r=>r.id));
  for(const [source,records] of Object.entries(input))for(const r of records) {
    const charge=source==='cobros'&&['billing','payment'].includes(r.type)&&!r.internalSettlementAdjustment&&!r.excludeFromBillingGross;
    const date=charge?serviceDate(r):source==='uber'?(r.weekEndDate||r.weekEnd||localDate(stamp(r))):localDate(stamp(r));
    if(!date){issues.push(`${source}/${r.id}: sin fecha; revisar antes de facturar.`);continue;}
    if(String(date).slice(0,7)!==month)continue;
    if(charge) {
      const included=!inactive(r)&&['completed','paid','approved'].includes(r.status)&&amount(r)>0;
      const box=included&&!r.excludeFromCashbox&&!r.cashboxExcluded&&!r.cajaChicaEliminada&&!r.noCashbox&&(method(r)==='Efectivo'||periodPolicy.isNew(r)||r.settlementRuleVersion==='gross_cash_digital_cashbox_5_v1')?round(amount(r)*periodPolicy.cashboxRate(r)):0;
      if(included){if(method(r)==='Efectivo')cash+=amount(r);else digital+=amount(r);cashbox+=box;}
      else if(!inactive(r))issues.push(`Cobro ${r.id}: pendiente o importe inválido; no incluido en el bruto.`);
      const route=r.invoiceRequest?.origin&&r.invoiceRequest?.destination?`${r.invoiceRequest.origin} - ${r.invoiceRequest.destination}`:r.service||r.detail;
      add('Cobros de viajes',r,date,{included,cashbox:box,method:method(r),detail:clean(route),fiscalReference:clean(r.invoiceId||r.arcaInvoiceId||''),dateBasis:r.invoiceRequest?.serviceDate||r.serviceDate?'Fecha del servicio':'Fecha de registro (sin fecha de servicio)'});
    } else if(source==='uber') {
      const included=!inactive(r)&&((r.verifiedAutomatically&&r.reviewStatus==='completed')||(r.adminConfirmed&&['approved','completed'].includes(r.reviewStatus||r.status)));
      if(included){cash+=Number(r.grossAmount??r.amount??0);cashbox+=round(Number(r.grossAmount??r.amount??0)*periodPolicy.cashboxRate(r));}
      else if(!inactive(r))issues.push(`Uber ${r.id}: pendiente; no incluido en el bruto.`);
      add('Liquidaciones Uber',r,date,{amount:Number(r.grossAmount??r.amount??0),included,method:'Efectivo',dateBasis:'Semana imputada al mes de finalización; revisar semanas que cruzan meses'});
    } else if(source==='gastos')add('Gastos',r,date,{method:r.expensePaymentMethod==='digital'?'Digital - pagado por Explora':'Efectivo - pagado por el chofer',responsibility:clean(r.expenseResponsibility||'Ver categoría')});
    else if(source==='cierres')add('Cierres',r,date,{amount:Number(r.settlementAmount??r.paidAmountTotal??r.requestedPaymentAmount??r.amount??0),direction:clean(r.paymentDirection||r.direction),summary:r.settlementSummary||null});
    else if(source==='cobros'||source==='pagosDeuda')add('Pagos y compensaciones',r,date,{direction:clean(r.adjustmentDirection||r.paymentDirection||r.settlementDirection),linkedClosure:clean(r.closureId),includedInClosure:acceptedClosures.has(r.closureId),method:method(r)});
    else if(source==='deudas')add('Deudas',r,date,{remaining:Number(r.remainingAmount??r.saldoPendiente??amount(r)),acknowledged:r.acknowledgedByDriver===true});
    else if(source==='adelantos')add('Adelantos y préstamos',r,date,{remaining:Number(r.remainingAmount??r.totalDebt??0)});
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  const gross=round(cash+digital),participation=round(gross*.4);
  const recipient={legalName:clean(explora.legalName||'Explora Iguazú Viajes y Servicios'),cuit:formatCuit(explora.cuit||'20-40411688-7'),address:clean(explora.address||'')};
  const invoiceDetail=`Servicios de conducción y participación comercial - ${month}. Participación del 40% sobre la facturación bruta generada para Explora.`;
  const report={version:'monthly_gross_40_v1',uid,driverName:clean(profile.displayName||profile.nombre||profile.username||'Chofer'),driverCuit:clean(profile.cuit||''),month,closedMonth:month<current,generatedAtMs:now,totals:{cash:round(cash),digital:round(digital),gross,cashbox:round(cashbox),rate:40,participation},recipient,invoiceDetail,issues,rows,
    explanation:'Según la participación comercial indicada por Explora, el chofer factura el 40% de la facturación bruta de sus viajes del mes. Gastos, caja chica, multas, deudas, préstamos y transferencias se informan para conciliar movimientos, pero no reducen esta base ni se suman como nuevos cobros. El resumen no es una factura fiscal ni acredita su emisión.',
    criteria:'Viajes por fecha de servicio; cuando falta, por fecha de registro, identificado en el detalle. Cierres, pagos y gastos por fecha de registro. Cada cierre se informa completo aunque incluya operaciones de otro mes; no se usa como base del 40%. Los ajustes vinculados a un cierre son su contrapartida, no otro pago. Saldos de deuda mostrados al generar el informe, no reconstruidos al último día del mes.'};
  report.revision=createHash('sha256').update(JSON.stringify({...report,generatedAtMs:0})).digest('hex');return report;
}
async function loadMonthlyReport(db,uid,month,now=Date.now()) {
  return db.runTransaction(async tx=>{
  const input={};
  for(const [key,collection] of Object.entries(collections)) {
    const rows=new Map();for(const field of owners){const snap=await tx.get(db.collection(collection).where(field,'==',uid));for(const row of snap.docs){const data=row.data();if(data.driverUid&&data.driverUid!==uid)continue;rows.set(row.id,{...data,id:row.id});}}input[key]=[...rows.values()];
  }
  const profile=(await tx.get(db.collection('usuarios').doc(uid))).data()||(await tx.get(db.collection('choferes').doc(uid))).data()||{};
  const fiscal=(await tx.get(db.collection('arca_settings').doc('current'))).data()||{};
  return buildMonthlyReport({uid,profile,month,input,now,explora:{legalName:fiscal.legalName||process.env.ARCA_ISSUER_LEGAL_NAME,address:fiscal.address||process.env.ARCA_ISSUER_ADDRESS,cuit:fiscal.cuit||process.env.ARCA_ISSUER_CUIT}});
  });
}
async function monthlyPdf(report) {
  const doc=new PDFDocument({size:'A4',margin:45,bufferPages:true,info:{Title:`Resumen para contadora - ${report.driverName} - ${report.month}`}}),chunks=[];
  const done=new Promise((resolve,reject)=>{doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:2}).format(n);
  function heading(text){if(doc.y>680)doc.addPage();doc.moveDown(.7).font('Helvetica-Bold').fontSize(15).fillColor('#143c50').text(text);doc.moveDown(.4);}
  function text(value){doc.font('Helvetica').fontSize(10).fillColor('#263d49').text(clean(value).replace(/[→➜]/g,'a').replace(/[–—]/g,'-'),{lineGap:3});}
  doc.font('Helvetica-Bold').fontSize(23).fillColor('#143c50').text('EXPLORA');heading('Informe mensual para la contadora');
  text(`Chofer: ${report.driverName}${report.driverCuit?' - CUIT: '+report.driverCuit:''}`);text(`Mes: ${report.month} | ${report.closedMonth?'Mes finalizado':'Acumulado provisional'}`);
  text(`Emitido: ${new Date(report.generatedAtMs).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'})} | Revisión: ${report.revision.slice(0,12)}`);
  heading('Datos para emitir la factura del chofer');
  text(`Cliente / receptor: ${report.recipient.legalName}`);text(`CUIT del receptor: ${report.recipient.cuit||'Confirmar con Explora antes de emitir.'}`);if(report.recipient.address)text(`Domicilio fiscal informado: ${report.recipient.address}`);
  text('Comprobante a emitir: Factura C, si corresponde a la condición fiscal del chofer. La contadora debe confirmar el tipo de comprobante y los datos fiscales antes de emitir.');
  text(`Detalle sugerido: ${report.invoiceDetail}`);
  heading('1. Base de la participación');
  text(`Cobros en efectivo (incluye Uber aceptado): ${money(report.totals.cash)}`);text(`Cobros digitales: ${money(report.totals.digital)}`);text(`Facturación bruta: ${money(report.totals.gross)}`);text(`Participación acordada: 40% = ${money(report.totals.participation)}`);
  text(`Caja chica generada por estos cobros: ${money(report.totals.cashbox)}. Se informa aparte; no se descuenta del 40%.`);
  heading('2. Criterios y observaciones');text(report.criteria);for(const issue of report.issues)text('REVISAR: '+issue);
  const groups=['Cobros de viajes','Liquidaciones Uber','Gastos','Deudas','Adelantos y préstamos','Cierres','Pagos y compensaciones'];
  groups.forEach((group,index)=>{
    heading(`${index+3}. ${group}`);const rows=report.rows.filter(r=>r.group===group);if(!rows.length)text('Sin movimientos en el mes.');
    for(const r of rows){if(doc.y>610)doc.addPage();
      if(group==='Cobros de viajes'){doc.font('Helvetica-Bold').fontSize(11).fillColor('#143c50').text(`${r.date} | ${money(r.amount)} | ${r.method||'Sin método indicado'}`,{lineGap:3});doc.font('Helvetica').fontSize(9).fillColor('#637784').text(`Ubicación: ${r.detail}`,{lineGap:2});doc.moveDown(.6);continue;}
      const title=r.includedInClosure?'Ajuste técnico incluido en el cierre':group==='Cierres'?'Cierre del período':group==='Pagos y compensaciones'?'Pago o compensación':group.slice(0,-1);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#143c50').text(`${r.date} | ${money(r.amount)} | ${title}`,{lineGap:3});
      text(r.detail);text(`Estado: ${{completed:'Completado',paid:'Pagado',active:'Activo',pending:'Pendiente',approved:'Aprobado',rejected:'Rechazado'}[r.status]||r.status}${r.method?' | '+r.method:''}${r.direction?' | '+({'driver_to_explora':'Chofer paga a Explora','explora_to_driver':'Explora paga al chofer','driver_pays_explora':'Chofer paga a Explora','explora_pays_driver':'Explora paga al chofer'}[r.direction]||r.direction):''}`);
      if(r.cashbox!==undefined)text(`Caja chica de este cobro: ${money(r.cashbox)} (no reduce la base del 40%).`);
      if(r.responsibility)text(`Responsabilidad del gasto: ${{driver:'Chofer 100%',explora:'Explora 100%',shared:'Compartido'}[r.responsibility]||r.responsibility}`);
      if(r.included!==undefined)text(r.included?'Incluido en la base del 40%.':'Excluido de la base del 40%.');if(r.dateBasis)text(r.dateBasis);
      if(r.remaining!==undefined)text(`Saldo pendiente al emitir este informe: ${money(r.remaining)}`);
      if(r.includedInClosure)text('Este registro es la contrapartida técnica del cierre ya informado. No representa un pago adicional, no modifica la base del 40% y no requiere un comprobante propio.');
      if(r.summary)for(const [key,label] of Object.entries({gross:'Bruto del período cerrado',cashExpense:'Gastos efectivo',digitalExpense:'Gastos digital',netCash:'Neto efectivo',netDigital:'Neto digital',cashbox:'Caja chica',externalDebt:'Deudas incluidas',previousBalance:'Saldo anterior'}))if(r.summary[key]!=null)text(`${label}: ${money(r.summary[key])}`);
      if(r.proof)doc.fontSize(10).fillColor('#166380').text('Abrir comprobante',{link:r.proof,underline:true});else if(!r.includedInClosure)text('Sin comprobante enlazado.');doc.moveDown(.6);
    }
  });
  heading('10. Por qué corresponde facturar este importe');text(report.explanation);
  doc.moveDown().font('Helvetica-Bold').fontSize(15).text(`${money(report.totals.gross)} x 40% = ${money(report.totals.participation)}`);
  text(report.issues.length?'Importe sujeto a revisar las observaciones indicadas.':report.closedMonth?'Importe de participación calculado para el mes finalizado.':'Importe provisional: el mes todavía está en curso.');
  text(`La contadora recibe este respaldo para emitir o revisar la factura del chofer a ${report.recipient.legalName}. El importe facturable surge únicamente de ${money(report.totals.gross)} de facturación bruta x 40%. Adjuntar la factura emitida por separado.`);
  const pages=doc.bufferedPageRange();for(let p=0;p<pages.count;p++){doc.switchToPage(p);doc.fontSize(8).fillColor('#637784').text(`Explora | ${report.month} | Resumen no fiscal | ${p+1} / ${pages.count}`,45,800,{lineBreak:false});}doc.end();return done;
}
module.exports={buildMonthlyReport,loadMonthlyReport,monthlyPdf};
