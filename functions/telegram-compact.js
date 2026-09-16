"use strict";
const clean = (value, max = 180) => String(value ?? '').replace(/[\r\n\t]+/g,' ').trim().slice(0,max);
const money = value => new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(value) || 0);
function balanceLine(value) {
  if (!Number.isFinite(Number(value))) return 'Saldo no disponible';
  const amount = Number(value);
  return amount > 0.005 ? `Chofer debe: ${money(amount)}` : amount < -0.005 ? `Explora debe: ${money(-amount)}` : 'Cuenta al día';
}
function billingSummary({data,driverName,amount,cash,balance}) {
  const route = data.invoiceRequest?.origin && data.invoiceRequest?.destination
    ? `${clean(data.invoiceRequest.origin,90)} → ${clean(data.invoiceRequest.destination,90)}`
    : clean(data.detail || data.notes || data.serviceDescription);
  return [cash ? '💵 Cobro en efectivo' : '💳 Cobro digital',`👤 ${clean(driverName)}`,
    ...(route ? [`📍 ${route}`] : []),'',`Monto cobrado: ${money(amount)}`,
    cash ? 'Dinero en poder del chofer.' : 'Dinero recibido por Explora · verificar con la imagen.',
    'Caja: 10% del neto del período; resto 50% / 50%.','',`Saldo actual · ${balanceLine(balance)}`].join('\n');
}
function expenseSummary({driverName,amount,recognized,balance,detail,refundRate,periodRule=false}) {
  return [`⛽ Gasto${clean(detail) ? ` · ${clean(detail)}` : ''}`,`👤 ${clean(driverName)}`,'',
    `Monto del comprobante: ${money(amount)}`,
    ...(periodRule ? ['Pagado por el chofer. Se descuenta antes de la caja y el reparto.','Verificar el monto con la imagen.'] :
      refundRate === 0 ? ['100% chofer · Sin reintegro'] : [`Reintegro: ${money(recognized)}`]),
    '',`Saldo actual · ${balanceLine(balance)}`].join('\n');
}
function managementSummary({driverName,amount,paying,balance,note}) {
  return [paying ? '📤 Pago a Explora' : '📥 Cobro a Explora',`👤 ${clean(driverName)}`,
    `Importe: ${money(amount)}`,...(clean(note) ? [`Nota: ${clean(note)}`] : []),'',balanceLine(balance)].join('\n');
}
function uberSummary({data,driverName,balance}) {
  const amount = Number(data.grossAmount || data.totalAmount || data.amount || 0);
  const cash = Number(data.cashAmount ?? data.uberCashAmount ?? amount), digital = Number(data.transferAmount ?? data.uberTransferAmount ?? 0);
  return ['🚘 Liquidación Uber',`👤 ${clean(driverName)}`,`📅 ${clean(data.weekLabel || data.weekStartDate)}`,'',
    `Ganancia semanal: ${money(amount)}`,`Chofer: ${money(cash)} · Digital Explora: ${money(digital)}`,
    'Integrado al período: caja 10% del neto y resto por mitades.','',balanceLine(balance)].join('\n');
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
module.exports = {balanceLine,billingSummary,expenseSummary,managementSummary,uberSummary,richMessage,invoiceFilename,calendarSummary,calendarCoincidenceMessages};
