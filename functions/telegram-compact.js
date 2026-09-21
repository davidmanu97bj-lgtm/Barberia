"use strict";
const periodPolicy = require('./period-policy');
const {summarizeAddress}=require('./address-summary');
const clean = (value, max = 180) => String(value ?? '').replace(/[\r\n\t]+/g,' ').trim().slice(0,max);
const money = value => new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(value) || 0);
function balanceLine(value) {
  if (!Number.isFinite(Number(value))) return 'Saldo no disponible';
  const amount = Number(value);
  return amount > 0.5 ? `Chofer debe: ${money(amount)}` : amount < -0.5 ? `Explora debe: ${money(-amount)}` : 'Cuenta al día';
}
function billingSummary({data,driverName,amount,cash}) {
  const route = data.invoiceRequest?.origin && data.invoiceRequest?.destination
    ? `${clean(summarizeAddress(data.invoiceRequest.origin),300)} → ${clean(summarizeAddress(data.invoiceRequest.destination),300)}`
    : clean(data.detail || data.notes || data.serviceDescription);
  return [`${clean(driverName)} cobro ${cash ? 'efectivo' : 'digital'}`,
    `Detalle: ${route || 'Sin ubicación registrada'}`,`Total cargado del cobro: ${money(amount)}`].join('\n');
}
function expenseSummary({driverName,amount,detail,data={},dateLines=[]}) {
  const digital = periodPolicy.expenseMethod(data) === 'digital';
  const actor = clean(data.createdByName || data.registeredByName || 'Administrador');
  return [digital ? `${actor} Gasto digital:` : `${clean(driverName)} Gasto:`,
    ...(digital ? [`Detalle: ${clean(detail) || 'Gasto'}`,`Monto: ${money(amount)}`,`Al chofer: ${clean(driverName)}`]
      : [`Motivo: ${clean(detail) || 'Gasto'}`,`Total cargado del gasto: ${money(amount)}`]),...dateLines].join('\n');
}
function debtSummary({data,driverName,amount,dateLines=[]}) {
  return [`${clean(data.createdByName || data.registeredByName || 'Administrador')} Deuda 100%: ${clean(driverName)}`,
    `Detalle: ${clean(data.detail || data.reason || data.description || data.notes || data.motivo) || 'Deuda del chofer'}`,
    `Monto: ${money(amount)}`,
    ...(data.driverConfirmationRequired && !data.acknowledgedByDriver ? ['Estado: pendiente de aceptación del chofer'] : []),...dateLines].join('\n');
}
function groupDebtSummary({data,dateLines=[]}) {
  const drivers=Array.isArray(data.drivers)?data.drivers:[];
  return [`${clean(data.createdByName || 'Administrador')} Deuda 100% grupal:`,
    `Detalle: ${clean(data.detail) || 'Deuda grupal'}`,
    `Monto por chofer: ${money(data.amountPerDriver)}`,
    `Total del grupo: ${money(Number(data.amountPerDriver)*drivers.length)}`,
    `Al grupo entero (${drivers.length} choferes):`,
    ...drivers.map(d=>`• ${clean(d.name)||'Chofer'}`),...dateLines].join('\n');
}
function closureSummary({data,driverName,dateLines=[]}) {
  const direction = data.paymentDirection || data.direction;
  const driverPays = ['driver_to_explora','driver_pays_explora'].includes(direction) || Number(data.amountDueFromDriver)>0;
  const exploraPays = ['explora_to_driver','explora_pays_driver'].includes(direction) || Number(data.amountDueToDriver)>0;
  const paid = ['completed','paid'].includes(data.status);
  const amount = data.settlementAmount ?? data.paidAmountTotal ?? data.requestedPaymentAmount ?? data.amount ?? Math.max(Number(data.amountDueFromDriver)||0,Number(data.amountDueToDriver)||0);
  return [`${clean(driverName)} pidió un cierre`,
    `${paid ? 'Quién pagó' : 'Quién debe pagar'}: ${exploraPays ? 'Explora' : driverPays ? clean(driverName) : 'Sin transferencia'}${paid && (exploraPays || driverPays) ? ' pagó' : ''}`,
    `Monto: ${money(amount)}`,`Estado: ${paid ? 'cerrado' : clean(data.status || 'pendiente')}`,...dateLines].join('\n');
}
function managementSummary({driverName,amount,paying,balance,note}) {
  return [paying ? '📤 Pago a Explora' : '📥 Cobro a Explora',`👤 ${clean(driverName)}`,
    `Importe: ${money(amount)}`,...(clean(note) ? [`Nota: ${clean(note)}`] : []),'',balanceLine(balance)].join('\n');
}
function uberSummary({data,driverName,balance}) {
  const amount = Number(data.grossAmount || data.totalAmount || data.amount || 0), box = amount * periodPolicy.cashboxRate(data);
  return ['🚘 Liquidación Uber',`👤 ${clean(driverName)}`,`📅 ${clean(data.weekLabel || data.weekStartDate)}`,'',
    `Ganancia semanal: ${money(amount)}`,`Caja chica ${periodPolicy.cashboxRate(data) * 100}%: ${money(box)}`,'',balanceLine(balance)].join('\n');
}
function richMessage(text,{photo,document} = {}) {
  const blocks = String(text).split(/\n\n/).filter(Boolean).map(section => ({type:'paragraph',text:section.split('\n').flatMap((line,index) => [
    ...(index ? ['\n'] : []), /^(?:💵|💳|⛽|📤|📥|🚘|Chofer debe:|Explora debe:|Cuenta al día)/u.test(line) ? {type:'bold',text:line} : line
  ])}));
  if (photo) blocks.push({type:'photo',photo:{type:'photo',media:photo}});
  if (document) blocks.push({type:'document',document:{type:'document',media:document}});
  return {blocks};
}
function invoiceFilename(invoice) {
  const prefix = invoice.environment === 'production' ? 'FC' : 'PRUEBA-FC';
  return `${prefix}-${Number(invoice.issuer.pointOfSale)}-${Number(invoice.number)}.pdf`;
}
const calendarDate = value => /^20\d{2}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : 'Fecha no disponible';
function calendarSummary({driverName,serviceDate,detail}) {
  return ['🗓 Viaje agendado',`Chofer: ${clean(driverName,120)}`,`Día: ${calendarDate(serviceDate)}`,`Detalle: ${clean(detail,500) || 'Sin detalle'}`].join('\n');
}
function calendarCoincidenceMessages({matchingTrips=[]}) {
  const groups=[];let current='',size=0;
  // Keep complete trip details. Large lists are split below Telegram's text limit.
  for(const [index,trip] of matchingTrips.entries()) {
    const entry=[`${index+1}. Chofer: ${clean(trip.driverName,120)}`,`Día: ${calendarDate(trip.serviceDate)}`,`Detalle: ${clean(trip.detail,500) || 'Sin detalle'}`].join('\n');
    if(size+entry.length+2>3800 && current){groups.push(current);current='';size=0;}
    current+=(current?'\n\n':'')+entry;size=current.length;
  }
  if(current)groups.push(current);
  return groups.map((group,index)=>`🗓 Coincidencias en Todos${groups.length>1?` · ${index+1}/${groups.length}`:''}\n\n${group}`);
}
module.exports = {groupDebtSummary,debtSummary,closureSummary,balanceLine,billingSummary,expenseSummary,managementSummary,uberSummary,richMessage,invoiceFilename,calendarSummary,calendarCoincidenceMessages};
