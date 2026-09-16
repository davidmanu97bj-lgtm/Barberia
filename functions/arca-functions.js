"use strict";
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {onDocumentCreated}=require('firebase-functions/v2/firestore');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const {defineSecret}=require('firebase-functions/params');
const {enqueueInvoice,processInvoice,enabled}=require('./arca-worker');
const {internationalCEnabled}=require('./arca-invoice');
const certificate=defineSecret('ARCA_CERTIFICATE'),privateKey=defineSecret('ARCA_PRIVATE_KEY');
const region='southamerica-east1';
const deploymentOptions=require('./deployment-options.json');
module.exports=function registerArca({db,assertAdmin}) {
  const config=async()=> { const c=(await db.collection('arca_settings').doc('current').get()).data()||{}; return {...c,enabled:deploymentOptions.arcaEnabled && c.enabled===true}; };
  function client(c) {
    const {createArcaClient}=require('./arca-client');
    const ticketRef=db.collection('arca_tickets').doc(`${c.environment}_${c.cuit}`);
    return createArcaClient({...c,certificate:certificate.value(),privateKey:privateKey.value(),ticketStore:{load:async()=>(await ticketRef.get()).data(),save:ticket=>ticketRef.set(ticket)}});
  }
  const workOptions={region,secrets:deploymentOptions.arcaEnabled ? [certificate,privateKey] : [],timeoutSeconds:120,maxInstances:1,concurrency:1};
  async function processId(id) { const c=await config();if(enabled(c))await processInvoice({db,id,config:c,client:client(c)}); }
  return {
    queueArcaInvoice:onDocumentCreated({document:'billing_records/{id}',region,retry:true},async event=>{
      if(event.data)await enqueueInvoice(db,event.params.id,await config());
    }),
    issueArcaInvoice:onDocumentCreated({...workOptions,document:'arca_invoices/{id}',retry:true},async event=>processId(event.params.id)),
    retryArcaInvoices:onSchedule({...workOptions,timeoutSeconds:540,schedule:'every 5 minutes'},async()=>{
      const c=await config();if(!enabled(c))return;
      const api=client(c);
      // Resume the occupied series first; queued records must not starve reconciliation.
      const {seriesKey}=require('./arca-worker');
      const active=(await db.collection('arca_series').doc(seriesKey(c)).get()).data()?.activeId;
      if(active)await processInvoice({db,id:active,config:c,client:api});
      const rows=await db.collection('arca_invoices').where('seriesKey','==',seriesKey(c)).where('status','in',['queued','reserved','sent','uncertain']).orderBy('createdAtMs').limit(3).get();
      for(const row of rows.docs)await processInvoice({db,id:row.id,config:c,client:api});
    }),
    arcaBillingStatus:onCall({region},async request=>{
      if(!request.auth)throw new HttpsError('unauthenticated','Iniciá sesión.');
      const c=await config();return {enabled:enabled(c),environment:c.environment||'disabled',regime:c.regime||'monotributo',internationalEnabled:enabled(c)&&internationalCEnabled(c)};
    }),
    arcaInvoicePdf:onCall({region,timeoutSeconds:45,memory:'256MiB'},async request=>{
      if(!request.auth)throw new HttpsError('unauthenticated','Iniciá sesión.');
      const id=String(request.data?.id||'');if(!/^[a-zA-Z0-9_-]{1,180}$/.test(id))throw new HttpsError('invalid-argument','Comprobante inválido.');
      const row=await db.collection('arca_invoices').doc(id).get();
      if(!row.exists)throw new HttpsError('not-found','Factura no disponible.');
      const invoice=row.data();if(invoice.driverUid!==request.auth.uid)await assertAdmin(request);
      if(invoice.status!=='authorized')throw new HttpsError('failed-precondition','La factura todavía no está autorizada.');
      const {invoicePdf}=require('./arca-pdf');
      const pdf=await invoicePdf(invoice);return {base64:pdf.toString('base64'),filename:require('./telegram-compact').invoiceFilename(invoice)};
    })
  };
};
