'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildInvoice,validCuit,matchesAuthorized,authorizationFromResponse}=require('../arca-invoice');
const {createArcaClient,parseXml}=require('../arca-client');
const {enqueueInvoice,processInvoice,seriesKey}=require('../arca-worker');
const {invoicePdf,qrUrl}=require('../arca-pdf');
const NOW=Date.parse('2026-09-12T18:00:00Z');
const config={enabled:true,environment:'homologation',regime:'monotributo',exclusivePointOfSale:true,cuit:'20123456786',legalName:'EMISOR DE PRUEBA',pointOfSale:2,address:'Domicilio de prueba',grossIncomeId:'Dato de prueba',activityStart:'2024-01-01',activeFrom:'2026-09-12T00:00:00Z'};
const payment=(method='cash')=>({driverUid:'driver-a',type:method==='cash'?'billing':'payment',method,status:'completed',amount:100000,createdAt:{toMillis:()=>NOW},invoiceRequest:{version:'arca_c_v1',origin:'Origen de prueba',destination:'Destino de prueba',distanceKm:20,serviceDate:'2026-09-12',scope:'national',customer:{}}});
function memoryDb() {
  const data=new Map();let pending=Promise.resolve();
  const ref=(collection,id)=>({id,path:collection+'/'+id});
  return {data,collection:name=>({doc:id=>ref(name,id)}),runTransaction:fn=>{
    const result=pending.then(async()=>{const writes=[];const result=await fn({get:async r=>({exists:data.has(r.path),data:()=>data.get(r.path)}),create:(r,d)=>{if(data.has(r.path))throw Error('exists');writes.push([r.path,d]);},set:(r,d,opt)=>writes.push([r.path,opt?.merge?{...data.get(r.path),...d}:d]),update:(r,d)=>writes.push([r.path,{...data.get(r.path),...d}])});for(const [k,v] of writes)data.set(k,v);return result;});pending=result.catch(()=>{});return result;
  }};
}
const authorized=(detail,point=2)=>({Resultado:'A',EmisionTipo:'CAE',PtoVta:point,CbteTipo:11,...detail,CodAutorizacion:'12345678901234',FchVto:'20260922'});
const response=detail=>({header:{Resultado:'A',PtoVta:2,CbteTipo:11,CantReg:1},detail:{Resultado:'A',CbteDesde:detail.CbteDesde,CbteHasta:detail.CbteHasta,CAE:'12345678901234',CAEFchVto:'20260922'}});
function api(){let calls=0,last=0;const issued=new Map();return {issued,get calls(){return calls;},points:async()=>[{Nro:2,Bloqueado:'N',FchBaja:'NULL',EmisionTipo:'CAE - Monotributo'}],last:async()=>last,consult:async(p,n)=>issued.get(n)||null,authorize:async(p,d)=>{calls++;last=d.CbteDesde;issued.set(last,authorized(d));return response(d);}};}
test('C por bruto, sin IVA discriminado ni caja chica; internacional, datos y régimen fallan cerrados',()=>{
 assert.ok(validCuit(config.cuit));assert.equal(validCuit('20123456780'),false);
 for(const method of ['cash','digital']){const i=buildInvoice(payment(method),config,new Date(NOW));assert.deepEqual(i.issues,[]);assert.equal(i.detail.ImpTotal,100000);assert.equal(i.detail.ImpNeto,100000);assert.equal(i.detail.ImpIVA,0);assert.equal(i.detail.CondicionIVAReceptorId,5);assert.equal(i.detail.DocTipo,99);}
 const p=payment();p.invoiceRequest.scope='international';assert.ok(buildInvoice(p,config,new Date(NOW)).issues.includes('international_requires_review'));
 p.invoiceRequest.scope='national';p.amount=10000000;assert.ok(buildInvoice(p,config,new Date(NOW)).issues.includes('customer_identification_required'));
 p.amount=12.345;assert.ok(buildInvoice(p,config,new Date(NOW)).issues.includes('invalid_amount'));
 assert.ok(buildInvoice(payment(),{...config,regime:'general'},new Date(NOW)).issues.includes('regime_requires_review'));
 assert.equal(buildInvoice({...payment(),type:'settlement_adjustment'},config),null);
 const old=payment();old.invoiceRequest.version='arca_preparation_v1';assert.equal(buildInvoice(old,config),null);
});
test('eventos duplicados, concurrencia y series: cada cobro se envía una sola vez',async()=>{
 const db=memoryDb(),client=api();for(const id of ['a','b'])db.data.set('billing_records/'+id,payment());
 await Promise.all([enqueueInvoice(db,'a',config,NOW),enqueueInvoice(db,'a',config,NOW),enqueueInvoice(db,'b',config,NOW)]);
 const run=id=>processInvoice({db,id,config,client,now:()=>NOW});
 await Promise.all([run('a'),run('a'),run('b')]);await run('b');await run('a');
 assert.equal(client.calls,2);assert.equal(db.data.get('arca_invoices/a').status,'authorized');assert.equal(db.data.get('arca_invoices/b').number,2);
});
test('internacionales C nuevos: efectivo y digital autorizan bruto, conservan recorrido y generan PDF una sola vez',async()=>{
 const c={...config,internationalInvoiceType:11,internationalActiveFrom:new Date(NOW).toISOString()},db=memoryDb(),client=api();
 for(const method of ['cash','digital']) {
   const p=payment(method);p.invoiceRequest={...p.invoiceRequest,scope:'international',origin:'Puerto Iguazú · Argentina',destination:method==='cash'?'Foz do Iguaçu · Brasil':'Ciudad del Este · Paraguay',distanceKm:45};
   db.data.set('billing_records/'+method,p);
   await Promise.all([enqueueInvoice(db,method,c,NOW),enqueueInvoice(db,method,c,NOW)]);
   const run=()=>processInvoice({db,id:method,config:c,client,now:()=>NOW});
   await run();await run();
   const job=db.data.get('arca_invoices/'+method);
   assert.equal(job.status,'authorized');assert.equal(job.scope,'international');assert.deepEqual(job.issues,[]);
   assert.equal(job.detail.ImpTotal,100000);assert.equal(job.detail.ImpIVA,0);assert.ok(job.description.includes(p.invoiceRequest.destination));
   const pdf=await invoicePdf(job);assert.equal(pdf.subarray(0,4).toString(),'%PDF');
   const qr=JSON.parse(Buffer.from(new URL(qrUrl(job)).searchParams.get('p'),'base64'));assert.equal(qr.tipoCmp,11);assert.equal(qr.importe,100000);
 }
 assert.equal(client.calls,2);
});
test('activación internacional no factura cobros viejos, sin fecha, sin definición o de otro régimen',async()=>{
 const c={...config,internationalInvoiceType:11,internationalActiveFrom:new Date(NOW).toISOString()},db=memoryDb(),client=api();
 for(const [id,createdAt] of [['old',{toMillis:()=>NOW-1}],['missing',undefined]]) {
   const p=payment();p.invoiceRequest.scope='international';p.createdAt=createdAt;
   db.data.set('billing_records/'+id,p);await enqueueInvoice(db,id,c,NOW);
   assert.ok(db.data.get('arca_invoices/'+id).issues.includes('international_before_activation'));
   await processInvoice({db,id,config:c,client,now:()=>NOW});
 }
 const p=payment();p.invoiceRequest.scope='international';
 for(const override of [{internationalInvoiceType:undefined},{internationalInvoiceType:19},{internationalActiveFrom:'invalid'},{internationalActiveFrom:new Date(NOW+1).toISOString()},{regime:'general'}]) {
   assert.ok(buildInvoice(p,{...c,...override},new Date(NOW)).issues.includes('international_requires_review'));
 }
 db.data.set('billing_records/review',p);await enqueueInvoice(db,'review',config,NOW);
 await enqueueInvoice(db,'review',c,NOW);await processInvoice({db,id:'review',config:c,client,now:()=>NOW});
 assert.equal(db.data.get('arca_invoices/review').status,'review');assert.equal(client.calls,0);
 for(const scope of ['',undefined,'export'])assert.ok(buildInvoice({...p,invoiceRequest:{...p.invoiceRequest,scope}},c,new Date(NOW)).issues.includes('invalid_service_scope'));
});
test('timeout después de autorizar recupera CAE consultando; no repite emisión',async()=>{
 const db=memoryDb(),client=api(),original=client.authorize;db.data.set('billing_records/a',payment());await enqueueInvoice(db,'a',config,NOW);
 client.authorize=async(...args)=>{await original(...args);throw Error('timeout');};
 const run=()=>processInvoice({db,id:'a',config,client,now:()=>NOW});await run();assert.equal(db.data.get('arca_invoices/a').status,'uncertain');
 await run();assert.equal(client.calls,1);assert.equal(db.data.get('arca_invoices/a').cae,'12345678901234');
});
test('crash antes del envío y consulta sin resultado bloquean serie sin reenviar ni saltar número',async()=>{
 const db=memoryDb(),client=api();for(const id of ['a','b']){db.data.set('billing_records/'+id,payment());await enqueueInvoice(db,id,config,NOW);}
 const j=db.data.get('arca_invoices/a');db.data.set('arca_invoices/a',{...j,status:'sent',number:1,detail:{...j.detail,CbteDesde:1,CbteHasta:1}});db.data.set('arca_series/'+seriesKey(config),{activeId:'a'});
 await processInvoice({db,id:'a',config,client,now:()=>NOW});await processInvoice({db,id:'b',config,client,now:()=>NOW});
 assert.equal(client.calls,0);assert.equal(db.data.get('arca_invoices/a').status,'uncertain');assert.equal(db.data.get('arca_invoices/b').status,'queued');
});
test('no adopta un comprobante de otro importe; no emite sin activación ni retroactivamente',async()=>{
 const d={...buildInvoice(payment(),config,new Date(NOW)).detail,CbteDesde:1,CbteHasta:1};assert.ok(matchesAuthorized(authorized(d),d,2));assert.equal(matchesAuthorized(authorized({...d,ImpTotal:1}),d,2),false);
 const db=memoryDb();db.data.set('billing_records/a',payment());await enqueueInvoice(db,'a',{...config,activeFrom:'2026-09-13T00:00:00Z'},NOW);assert.equal(db.data.get('arca_invoices/a').status,'disabled');
 const client=api();await processInvoice({db,id:'a',config:{...config,enabled:false},client});assert.equal(client.calls,0);
 assert.throws(()=>authorizationFromResponse({...response(d),header:{PtoVta:3}},d,2));
});
test('XML seguro y contrato SOAP; importes, token y CUIT no van a URLs',async()=>{
 assert.throws(()=>parseXml('<!DOCTYPE x [<!ENTITY e "x">]><x>&e;</x>'));assert.throws(()=>parseXml('<broken>'));
 const requests=[];const client=createArcaClient({environment:'homologation',cuit:config.cuit,ticketStore:{load:async()=>({token:'a&b',sign:'test',expiresAt:'2099-01-01'})},fetchImpl:async(url,opts)=>{requests.push({url,...opts});return {ok:true,text:async()=>'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><CbteNro>0</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse></soap:Body></soap:Envelope>'};}});
 assert.equal(await client.last(2),0);assert.equal(requests[0].url,'https://wswhomo.afip.gov.ar/wsfev1/service.asmx');assert.ok(requests[0].body.includes('a&amp;b'));assert.equal(requests[0].redirect,'error');
});
test('PDF solo autorizado, prueba diferenciada y QR con importe fiscal bruto',async()=>{
 const i={...buildInvoice(payment(),config,new Date(NOW)),status:'authorized',number:1,cae:'12345678901234',caeExpires:'20260922'};
 const pdf=await invoicePdf(i);assert.equal(pdf.subarray(0,4).toString(),'%PDF');
 const data=JSON.parse(Buffer.from(new URL(qrUrl(i)).searchParams.get('p'),'base64'));assert.equal(data.importe,100000);assert.equal(data.tipoCmp,11);assert.equal(data.codAut,12345678901234);
 await assert.rejects(invoicePdf({...i,status:'uncertain'}));
});

test('un rechazo completo libera la serie, sin saltar el número no autorizado',async()=>{
 const db=memoryDb(),client=api(),original=client.authorize;
 for(const id of ['reject','next']){db.data.set('billing_records/'+id,payment());await enqueueInvoice(db,id,config,NOW);}
 client.authorize=async(p,d)=>({header:{Resultado:'R',PtoVta:p,CbteTipo:11,CantReg:1},detail:{Resultado:'R',CbteDesde:d.CbteDesde,CbteHasta:d.CbteHasta,CAE:''},errors:[]});
 await processInvoice({db,id:'reject',config,client,now:()=>NOW});
 assert.equal(db.data.get('arca_invoices/reject').status,'rejected');assert.equal(db.data.get('arca_series/'+seriesKey(config)).activeId,null);
 client.authorize=original;await processInvoice({db,id:'next',config,client,now:()=>NOW});assert.equal(db.data.get('arca_invoices/next').number,1);
});

test('una concesión vencida se recupera consultando y un conflicto no libera la serie',async()=>{
 const db=memoryDb(),client=api();db.data.set('billing_records/a',payment());await enqueueInvoice(db,'a',config,NOW);
 const j=db.data.get('arca_invoices/a'),detail={...j.detail,CbteDesde:1,CbteHasta:1};
 db.data.set('arca_invoices/a',{...j,status:'sent',number:1,detail,owner:'crashed',leaseUntil:NOW+180000});
 db.data.set('arca_series/'+seriesKey(config),{activeId:'a'});
 client.issued.set(1,authorized({...detail,ImpTotal:200000}));
 await processInvoice({db,id:'a',config,client,now:()=>NOW+180001});
 assert.equal(db.data.get('arca_invoices/a').issue,'number_conflict');assert.equal(client.calls,0);assert.equal(db.data.get('arca_series/'+seriesKey(config)).activeId,'a');
});

test('la cola anterior a la activación y los datos incompletos nunca se envían',async()=>{
 const db=memoryDb(),client=api();db.data.set('billing_records/a',payment());
 await enqueueInvoice(db,'a',{...config,grossIncomeId:''},NOW);assert.equal(db.data.get('arca_invoices/a').status,'review');
 await processInvoice({db,id:'a',config,client,now:()=>NOW});assert.equal(client.calls,0);
});

test('lista de puntos ausente: excepción 602 solo para homologación, nunca producción',async()=>{
 for(const environment of ['homologation','production']){
   const c={...config,environment,homologationPassed:true,registrationVerified:true},db=memoryDb(),client=api();
   db.data.set('billing_records/a',payment());await enqueueInvoice(db,'a',c,NOW);
   client.points=async()=>{const error=Error('ARCA_REJECTED_REQUEST');error.code='ARCA_REJECTED_REQUEST';error.details=[{code:'602'}];throw error;};
   await processInvoice({db,id:'a',config:c,client,now:()=>NOW});
   assert.equal(client.calls,environment==='homologation'?1:0);
   assert.equal(db.data.get('arca_invoices/a').status,environment==='homologation'?'authorized':'queued');
 }
});
