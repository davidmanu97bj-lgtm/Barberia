"use strict";
const {createHash} = require('node:crypto');
function validCuit(value) {
  const s=String(value||'').replace(/\D/g,'');
  if(!/^\d{11}$/.test(s))return false;
  const sum=[5,4,3,2,7,6,5,4,3,2].reduce((n,w,i)=>n+w*Number(s[i]),0);
  const digit=11-sum%11;return digit!==10 && (digit===11?0:digit)===Number(s[10]);
}
function localDate(now=new Date()) { return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(now); }
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s; }
const digits = s => String(s||'').replace(/[ .-]/g,'');
function internationalCEnabled(config,now=new Date()) {
  const cutoff=Date.parse(config.internationalActiveFrom||'');
  return config.regime==='monotributo' && config.internationalInvoiceType===11 && Number.isFinite(cutoff) && cutoff<=Number(now);
}
function buildInvoice(payment,config,now=new Date()) {
  const req=payment.invoiceRequest;
  if(req?.version!=='arca_c_v1' || !['cash','digital'].includes(payment.method) || !['billing','payment'].includes(payment.type)) return null;
  const issues=[];
  if(config.regime!=='monotributo')issues.push('regime_requires_review');
  if(!['national','international'].includes(req.scope))issues.push('invalid_service_scope');
  if(req.scope==='international') {
    if(!internationalCEnabled(config,now))issues.push('international_requires_review');
    else {
      const created=payment.createdAt?.toMillis?.();
      if(!Number.isFinite(created)||created<Date.parse(config.internationalActiveFrom))issues.push('international_before_activation');
    }
  }
  if(payment.deleted||payment.isDeleted||payment.eliminado||payment.status!=='completed')issues.push('payment_not_completed');
  const amount=Number(payment.amount),cents=Math.round(amount*100);
  if(!Number.isSafeInteger(cents)||cents<=0||Math.abs(amount*100-cents)>0.0001)issues.push('invalid_amount');
  const serviceDate=String(req.serviceDate||'');
  const today=localDate(now);
  if(!validDate(serviceDate)||serviceDate>today||Date.parse(today)-Date.parse(serviceDate)>10*86400000)issues.push('service_date_requires_review');
  if(!String(req.origin||'').trim()||!String(req.destination||'').trim()||!(Number(req.distanceKm)>0))issues.push('incomplete_service');
  const issuer={cuit:digits(config.cuit),legalName:config.legalName||'',pointOfSale:Number(config.pointOfSale),address:config.address||'',grossIncomeId:config.grossIncomeId||'',activityStart:config.activityStart||''};
  if(!validCuit(issuer.cuit)||!issuer.legalName||!Number.isInteger(issuer.pointOfSale)||issuer.pointOfSale<1||issuer.pointOfSale>99998)issues.push('issuer_incomplete');
  if(!issuer.address||!issuer.grossIncomeId||!validDate(issuer.activityStart))issues.push('issuer_print_data_missing');
  const customer=req.customer||{},vat={consumer:5,registered:1,monotributo:6,exempt:4}[customer.requested?customer.vatCondition:'consumer'];
  let docType=99,docNumber='0';
  if(customer.requested){
    docType={DNI:96,CUIT:80,passport:94}[customer.documentType];docNumber=digits(customer.documentNumber);
    if(!customer.name||!docType||!/^\d{1,11}$/.test(docNumber)||/^0+$/.test(docNumber))issues.push('customer_document_requires_review');
    if(docType===80&&!validCuit(docNumber))issues.push('invalid_customer_cuit');
    if(docType===96&&!/^\d{7,8}$/.test(docNumber))issues.push('invalid_customer_dni');
  }
  if(!vat || ([1,4,6].includes(vat)&&docType!==80))issues.push('customer_vat_requires_review');
  // ARCA consumer-final identification threshold, verified 2026-09-12; config can lower it.
  const limit=Math.min(Number(config.consumerIdentificationLimit)||10000000,10000000);
  if(amount>=limit&&docType===99)issues.push('customer_identification_required');
  const invoiceDate=today.replaceAll('-',''), service=serviceDate.replaceAll('-','');
  const detail={Concepto:2,DocTipo:docType||99,DocNro:docNumber,CbteDesde:0,CbteHasta:0,CbteFch:invoiceDate,ImpTotal:cents/100,ImpTotConc:0,ImpNeto:cents/100,ImpOpEx:0,ImpTrib:0,ImpIVA:0,FchServDesde:service,FchServHasta:service,FchVtoPago:invoiceDate,MonId:'PES',MonCotiz:1,CondicionIVAReceptorId:vat||5};
  const snapshot={issuer,detail,scope:String(req.scope||''),customer:{name:customer.requested?String(customer.name||'').slice(0,160):'A CONSUMIDOR FINAL'},description:`Traslado de pasajeros con chofer. ${String(req.origin).slice(0,160)} → ${String(req.destination).slice(0,160)}. ${Number(req.distanceKm)} km. Servicio: ${serviceDate}.`,paymentMethod:payment.method,environment:config.environment||'disabled'};
  return {...snapshot,issues,sourceHash:createHash('sha256').update(JSON.stringify({amount,paymentMethod:payment.method,req})).digest('hex')};
}
function matchesAuthorized(record,detail,point) {
  return record?.Resultado==='A' && record.EmisionTipo==='CAE' && Number(record.PtoVta)===Number(point) && Number(record.CbteTipo)===11 &&
    ['Concepto','DocTipo','DocNro','CbteDesde','CbteHasta','ImpTotal','ImpNeto','ImpTotConc','ImpOpEx','ImpTrib','ImpIVA','MonCotiz'].every(k=>record[k]!==undefined&&Number(record[k])===Number(detail[k])) &&
    ['CbteFch','FchServDesde','FchServHasta','FchVtoPago','MonId'].every(k=>String(record[k])===String(detail[k])) &&
    /^\d{14}$/.test(String(record.CodAutorizacion)) && /^\d{8}$/.test(String(record.FchVto));
}
function authorizationFromResponse(response,detail,point) {
  const h=response.header,d=response.detail;
  if(Number(h?.PtoVta)!==Number(point)||Number(h?.CbteTipo)!==11||Number(h?.CantReg)!==1||Number(d?.CbteDesde)!==detail.CbteDesde||Number(d?.CbteHasta)!==detail.CbteHasta)throw new Error('ARCA_RESPONSE_MISMATCH');
  if(h.Resultado==='R'&&d.Resultado==='R'&&!d.CAE)return {status:'rejected',messages:d.Observaciones||response.errors||[]};
  if(h.Resultado!=='A'||d.Resultado!=='A'||!/^\d{14}$/.test(String(d.CAE))||!/^\d{8}$/.test(String(d.CAEFchVto)))throw new Error('ARCA_UNCERTAIN');
  return {status:'authorized',cae:String(d.CAE),caeExpires:String(d.CAEFchVto)};
}
module.exports={validCuit,validDate,localDate,internationalCEnabled,buildInvoice,matchesAuthorized,authorizationFromResponse};
