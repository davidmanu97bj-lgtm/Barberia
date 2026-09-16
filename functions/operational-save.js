'use strict';
// Authenticated operational writes. Does not issue invoices or call Telegram directly.
const crypto = require('node:crypto');
const policy = require('./expense-policy');
const period = require('./period-settlement');
const COLLECTIONS = Object.freeze({cash:'billing_records',digital:'billing_records',expense:'gastos',debt:'deudas_choferes'});
const OWNERS = ['driverUid','choferUid','uid','ownerUid','driverId','choferId','userUid','createdByUid'];
const LEDGER = ['billing_records','gastos','uber_weekly_closures','deudas_choferes','deuda_pagos','prestamos_operativos','cierres_semanales'];
const MAX_ROWS = 2500;
class SaveError extends Error { constructor(code,message) { super(message); this.code=code; } }
function fail(code,message) { throw new SaveError(code,message); }
function text(value,max,required=false) {
  if (typeof value !== 'string' || value.length>max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail('invalid-argument','Hay un dato de texto inválido.');
  const result=value.trim(); if(required&&!result)fail('invalid-argument','Completá los datos obligatorios.');return result;
}
function money(value) {
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>100000000||Math.abs(value*100-Math.round(value*100))>0.00001)fail('invalid-argument','Ingresá un importe válido, con hasta dos decimales.');
  return Math.round(value*100)/100;
}
function own(row,uid) {
  const primary=row.driverUid||row.choferUid||row.ownerUid||row.uid||row.userUid||row.driverId||row.choferId;
  return primary ? primary===uid : row.createdByUid===uid;
}
function requestKey(raw) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Object.hasOwn(COLLECTIONS,raw.kind))fail('invalid-argument','Tipo de operación inválido.');
  const prefix=raw.kind==='expense'?'expense':raw.kind==='debt'?'driver_debt':'payment';
  if(typeof raw.operationId!=='string'||!new RegExp('^'+prefix+'_[a-f0-9]{32}$').test(raw.operationId))fail('invalid-argument','Identificador inválido.');
  if(typeof raw.fingerprint!=='string'||!/^sha256_(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(raw.fingerprint))fail('invalid-argument','Huella de operación inválida.');
  return {kind:raw.kind,id:raw.operationId,fingerprint:raw.fingerprint,collection:COLLECTIONS[raw.kind]};
}
function normalizeDraft(raw,kind) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('invalid-argument','Completá el recorrido.');
  const serviceDate=text(raw.serviceDate,10,true),origin=text(raw.origin,240,true),destination=text(raw.destination,240,true);
  if(!/^20\d\d-\d\d-\d\d$/.test(serviceDate)||!Number.isFinite(Date.parse(serviceDate))||new Date(serviceDate).toISOString().slice(0,10)!==serviceDate)fail('invalid-argument','Fecha de servicio inválida.');
  const distanceKm=Number(raw.distanceKm);
  if(!Number.isFinite(distanceKm)||distanceKm<=0||distanceKm>20000||!['national','international'].includes(raw.scope))fail('invalid-argument','Revisá los kilómetros y el tipo de recorrido.');
  if(kind==='digital'&&!['card','transfer','qr','digital','mercadopago'].includes(raw.paymentChannel))fail('invalid-argument','Método digital inválido.');
  let customer={};
  if(raw.customer?.requested===true){
    customer={requested:true,name:text(raw.customer.name,160,true),documentType:text(raw.customer.documentType,30,true),documentNumber:text(raw.customer.documentNumber,30,true),vatCondition:text(raw.customer.vatCondition,60,true)};
  }
  return {version:'arca_c_v1',serviceDate,origin,destination,distanceKm,scope:raw.scope,paymentChannel:kind==='cash'?'cash':raw.paymentChannel,customer};
}
function normalizeInput(raw,key,now) {
  const amount=money(raw.amount),detail=text(raw.detail??'',280);
  if(!Number.isSafeInteger(raw.createdAtMs)||raw.createdAtMs<now-48*60*60*1000||raw.createdAtMs>now+60000)fail('invalid-argument','La operación venció. Revisá si ya se guardó antes de cargar otra.');
  const input={amount,detail,createdAtMs:raw.createdAtMs};
  if(key.kind==='cash'||key.kind==='digital')input.invoiceRequest=normalizeDraft(raw.invoiceRequest,key.kind);
  else {
    const type=policy.find(raw.expenseType);
    if(!type||policy.entryKind(type.id)!==(key.kind==='debt'?'debt':'shared'))fail('invalid-argument','Elegí el concepto de gasto o deuda correcto.');
    input.expenseType=type.id;input.detail=detail||type.label;
  }
  if(key.kind!=='cash') {
    input.proofPath=text(raw.proofPath,600,true);input.telegramPhotoPath=text(raw.telegramPhotoPath,600,true);
    input.proofUrl=text(raw.proofUrl,2500,true);input.telegramPhotoUrl=text(raw.telegramPhotoUrl,2500,true);
  }
  return input;
}
function digest(input) {
  // URLs contain rotating access tokens: document identity uses immutable paths and business data only.
  const {proofUrl,telegramPhotoUrl,...stable}=input;
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
function same(row,key,uid) {
  if(!own(row,uid)||row.idempotencyKey!==key.id||row.submissionFingerprint!==key.fingerprint)fail('already-exists','Ese identificador pertenece a otra operación. No se sobrescribió.');
}
function jsonRow(row) {
  return JSON.parse(JSON.stringify(row,(_key,value)=>{
    if(value&&typeof value.toMillis==='function')return {seconds:Math.floor(value.toMillis()/1000),nanoseconds:(value.toMillis()%1000)*1000000};
    return value;
  }));
}
async function verifiedReceipt(bucket,key,input,uid) {
  if(key.kind==='cash')return {};
  const folder=key.kind==='digital'?'billing_receipts':key.kind==='expense'?'gastos':'deudas';
  const parent=`${folder}/${uid}/${key.id}/`, imagePath=parent+'imagen.jpg';
  const imageOnly=input.proofPath===imagePath&&input.telegramPhotoPath===imagePath&&input.proofUrl===input.telegramPhotoUrl;
  const legacyPdf=input.proofPath.startsWith(parent)&&/^[-A-Za-z0-9_.]+\.pdf$/.test(input.proofPath.slice(parent.length))&&input.telegramPhotoPath===imagePath;
  if(!imageOnly&&!legacyPdf)fail('permission-denied','El comprobante no pertenece a esta operación.');
  const files=imageOnly
    ? [[imagePath,input.proofUrl,'image/jpeg',null]]
    : [[input.proofPath,input.proofUrl,'application/pdf','%PDF-'],[imagePath,input.telegramPhotoUrl,'image/jpeg',null]];
  for(const [path,url,mime,magic] of files) {
    let parsed;try{parsed=new URL(url);}catch{fail('invalid-argument','Enlace de comprobante inválido.');}
    if(parsed.protocol!=='https:'||parsed.hostname!=='firebasestorage.googleapis.com'||parsed.port||parsed.username||parsed.password||parsed.pathname!==`/v0/b/${bucket.name}/o/${encodeURIComponent(path)}`||parsed.searchParams.get('alt')!=='media')fail('permission-denied','El archivo no pertenece al almacenamiento de Explora.');
    const file=bucket.file(path);let metadata,header;
    try { [metadata]=await file.getMetadata();[header]=await file.download({start:0,end:4}); }
    catch(error){ if(error.code===404)fail('failed-precondition','El comprobante todavía no terminó de subir. Reintentá.');throw error; }
    const tokens=String(metadata.metadata?.firebaseStorageDownloadTokens||'').split(',').filter(Boolean);
    if(metadata.contentType!==mime||!Number.isFinite(Number(metadata.size))||Number(metadata.size)<=0||Number(metadata.size)>15*1024*1024||!tokens.includes(parsed.searchParams.get('token')))fail('failed-precondition','El comprobante está incompleto o su enlace ya no es válido.');
    if(magic ? header.subarray(0,5).toString()!==magic : !(header[0]===255&&header[1]===216&&header[2]===255))fail('invalid-argument','El archivo no tiene el formato esperado.');
  }
  if(legacyPdf) {
    const name=input.proofPath.split('/').at(-1);
    return {proofUrl:input.proofUrl,proofPath:input.proofPath,receiptUrl:input.proofUrl,receiptPath:input.proofPath,receiptPdfPath:input.proofPath,
      proofMimeType:'application/pdf',receiptMimeType:'application/pdf',proofFileName:name,receiptFileName:name,receiptPdfFileName:name,
      telegramPhotoUrl:input.telegramPhotoUrl,telegramPhotoPath:imagePath,notificationPhotoUrl:input.telegramPhotoUrl,
      telegramPhotoMimeType:'image/jpeg',receiptFormatVersion:'pdf-app-image-telegram-v1'};
  }
  const prefix=key.kind==='expense'?'G':key.kind==='debt'?'D':'P', suffix=String(key.id).replace(/[^A-Za-z0-9_-]/g,'').slice(-10);
  const pdfName=`${prefix}-${suffix}.pdf`;
  return {proofUrl:input.proofUrl,proofPath:imagePath,receiptUrl:input.proofUrl,receiptPath:imagePath,receiptPdfPath:'',
    proofMimeType:'image/jpeg',receiptMimeType:'image/jpeg',proofFileName:'imagen.jpg',receiptFileName:'imagen.jpg',receiptPdfFileName:pdfName,
    telegramPhotoUrl:input.proofUrl,telegramPhotoPath:imagePath,notificationPhotoUrl:input.proofUrl,
    telegramPhotoMimeType:'image/jpeg',receiptFormatVersion:'image-first-pdf-later-v2'};
}
async function ownedRows(db,collection,uid,tx=null) {
  const result=new Map();
  // Separate equality queries preserve legacy ownership without a composite index.
  for(const field of (collection==='uber_weekly_closures'?['driverUid']:OWNERS)) {
    const query=db.collection(collection).where(field,'==',uid).limit(MAX_ROWS+1);
    const snapshot=tx?await tx.get(query):await query.get();
    if(snapshot.docs.length>MAX_ROWS)fail('resource-exhausted','El historial supera el límite seguro de consulta. No se omitieron movimientos.');
    for(const snap of snapshot.docs){const row=snap.data();if(own(row,uid))result.set(snap.id,{...row,id:snap.id});}
    if(result.size>MAX_ROWS)fail('resource-exhausted','El historial supera el límite seguro de consulta. No se omitieron movimientos.');
  }
  return [...result.values()];
}
function repayment(amount,rows) {
  let budget=Math.floor(amount*0.45),totalApplied=0;const allocations=[];
  const time=row=>row.createdAt?.toMillis?.()||Number(row.createdAtMs||0);
  const eligible=rows.filter(row=>(row.type==='cash_advance'||row.loanType==='cash_advance')&&!/pending|solicit|reject|rechaz|cancel|deleted|eliminad/.test(String(row.status||row.approvalStatus||'active').toLowerCase())&&row.deleted!==true);
  for(const row of eligible.sort((a,b)=>time(a)-time(b)||a.id.localeCompare(b.id))) {
    if(budget<=0.5)break;
    const remaining=Math.max(0,Number(row.remainingAmount??row.totalDebt??0)||0);
    if(remaining<=0.5)continue;
    const applied=Math.round(Math.min(remaining,budget)*100)/100,after=Math.round((remaining-applied)*100)/100;
    allocations.push({id:row.id,applied,remainingAmount:after,repaidAmount:Math.max(0,Number(row.totalDebt||row.totalAmount||row.amount||0)-after),status:after<=0.5?'paid':'active'});
    totalApplied=Math.round((totalApplied+applied)*100)/100;budget=Math.round((budget-applied)*100)/100;
  }
  return {allocations,totalApplied};
}
function buildRow(key,input,uid,name,businessId,receipt,plan,timestamp) {
  const date=new Date(input.createdAtMs);
  const dayKey=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
  const weekly=new Date(dayKey+'T12:00:00Z');weekly.setUTCDate(weekly.getUTCDate()-(weekly.getUTCDay()-6+7)%7);
  const common={amount:input.amount,monto:input.amount,detail:input.detail,notes:input.detail,...receipt,
    driverUid:uid,choferUid:uid,uid,ownerUid:uid,driverId:uid,operatorUid:uid,driverName:name,operatorName:name,
    dayKey,weeklyPeriodId:weekly.toISOString().slice(0,10),businessId,
    idempotencyKey:key.id,clientOperationId:key.id,submissionFingerprint:key.fingerprint,idempotencyVersion:1,
    createdAtMs:input.createdAtMs,createdAt:timestamp,operationalSaveVersion:'confirmed_server_v311',serverPayloadDigest:digest(input)};
  if(key.kind==='cash'||key.kind==='digital')return {...common,
    method:key.kind,paymentMethod:key.kind,metodoPago:key.kind,financialCategory:key.kind,type:key.kind==='cash'?'billing':'payment',
    valor:input.amount,finalPrice:input.amount,service:key.kind==='cash'?'Cobro en efectivo':'Cobro digital',serviceDescription:key.kind==='cash'?'Cobro en efectivo':'Cobro digital',
    invoiceRequest:input.invoiceRequest,fiscalEmissionEnabled:false,
    detail:[input.detail,plan.totalApplied>0.5?`Aplicado al adelanto: $ ${plan.totalApplied}`:''].filter(Boolean).join(' · '),
    advanceRepaymentAmount:plan.totalApplied,advanceAllocations:plan.allocations.map(item=>({advanceId:item.id,amount:item.applied})),
    proofUrl:receipt.proofUrl||'',proofPath:receipt.proofPath||'',receiptUrl:receipt.proofUrl||'',receiptPath:receipt.proofPath||'',receiptRequired:key.kind==='digital',
    settlementRuleVersion:period.VERSION,grossAmount:input.amount,principalMovementAmount:key.kind==='cash'?input.amount:-input.amount,
    cashboxRate:0.10,cashboxBasis:'net_period_after_expenses',cashboxAmount:0,cashboxBeneficiary:'explora',moneyHolder:key.kind==='cash'?'driver':'explora',status:'completed',source:'explora-period-statement'};
  const type=policy.find(input.expenseType);
  if(key.kind==='expense')return {...common,expenseType:type.id,tipo:type.id,category:type.id,expenseLabel:type.label,
    expenseResponsibility:'shared',reimbursementRate:0.5,driverExpenseRate:0.5,choferId:uid,choferNombre:name,payerRole:'driver',sharedRate:0.5,porcentajeCompartido:50,
    autoApplyToBilling:true,billingImpactMode:'net_period_shared_expense',receiptFlowVersion:period.VERSION,
    telegramExpenseLoadedAmount:input.amount,telegramExpenseRecognizedAmount:input.amount*0.5,status:'active'};
  return {...common,type:'driver_debt_100',debtType:'driver_debt_100',debtRuleVersion:policy.debtVersion,debtResponsibility:'driver',
    debtCategory:type.id,debtLabel:type.label,penaltyEnabled:false,penaltyDailyRate:0,
    originalAmount:input.amount,totalAmount:input.amount,remainingAmount:input.amount,saldoPendiente:input.amount,paidAmount:0,amountPaid:0,
    reason:input.detail,createdByUid:uid,createdByName:name,createdByRole:'driver',registeredByAdmin:false,
    sourceModule:'pendientes',registrationOrigin:'driver_expense_debt_menu',status:'active',debtStatus:'active',acknowledgedByDriver:true,driverConfirmationRequired:false};
}
function createOperationalHandler({db,bucket,assertViewer,getProfile,businessId,options,serverTimestamp,now=Date.now}) {
  return async request=>{
    if(!request.auth?.uid)fail('unauthenticated','Iniciá sesión para guardar.');
    const uid=await assertViewer(request);
    const raw=request.data||{};
    if(raw.action==='sync') {
      const ledger=await db.runTransaction(async tx=>{
        const entries=[];
        for(const name of LEDGER)entries.push([name,await ownedRows(db,name,uid,tx)]);
        return Object.fromEntries(entries);
      });
      // Never send a truncated account as a complete balance.
      if(Buffer.byteLength(JSON.stringify(ledger))>6*1024*1024)fail('resource-exhausted','El historial es demasiado grande para la recuperación. No se calculó un saldo parcial.');
      return {ok:true,uid,ledger:jsonRow(ledger)};
    }
    if(!['check','save'].includes(raw.action))fail('invalid-argument','Acción inválida.');
    const key=requestKey(raw),ref=db.collection(key.collection).doc(key.id);
    const existing=await ref.get();
    if(existing.exists){
      const row=existing.data();same(row,key,uid);
      if(raw.action==='save'&&row.serverPayloadDigest) {
        // An old committed request remains confirmable even after its original 48h window.
        const input=normalizeInput(raw,key,Math.max(Number(raw.createdAtMs),Math.min(now(),Number(raw.createdAtMs)+47*60*60*1000)));
        if(row.serverPayloadDigest!==digest(input))fail('already-exists','No se pueden cambiar los datos de una operación confirmada.');
      }
      return {ok:true,committed:true,alreadyRegistered:true,collection:key.collection,id:key.id,row:jsonRow(row)};
    }
    if(raw.action==='check')return {ok:true,committed:false,id:key.id,collection:key.collection};
    if(options.arcaEnabled!==false)fail('failed-precondition','Este guardado está preparado para la versión sin ARCA activa.');
    const input=normalizeInput(raw,key,now());
    const receipt=await verifiedReceipt(bucket,key,input,uid);
    const profile=await getProfile(uid,request);
    const person=profile?.data?.()||{};
    const name=String(person.displayName||person.nombreCompleto||person.nombre||person.username||request.auth.token?.name||'Chofer').trim().slice(0,160);
    await db.runTransaction(async tx=>{
      const closureStateRef=db.collection('_operational_closure_state').doc(uid);
      const [closureState,current]=await Promise.all([tx.get(closureStateRef),tx.get(ref)]);
      const lastCutoffAtMs=Number(closureState.data()?.lastCutoffAtMs||0);
      if(lastCutoffAtMs>0&&input.createdAtMs<=lastCutoffAtMs)fail('failed-precondition','El período de esta operación ya fue cerrado. Iniciá un movimiento nuevo.');
      if(current.exists){same(current.data(),key,uid);if(current.data().serverPayloadDigest&&current.data().serverPayloadDigest!==digest(input))fail('already-exists','La operación ya existe con otros datos.');return;}
      const advances=key.kind==='digital'?await ownedRows(db,'prestamos_operativos',uid,tx):[];
      const plan=key.kind==='digital'?repayment(input.amount,advances):{allocations:[],totalApplied:0};
      if(plan.allocations.length>200)fail('resource-exhausted','Hay demasiados adelantos para liquidar en una sola operación. No se descontó ninguno.');
      tx.create(ref,buildRow(key,input,uid,name,businessId,receipt,plan,serverTimestamp()));
      tx.set(closureStateRef,{lastMovementAtMs:input.createdAtMs,lastMovementId:key.id,updatedAt:serverTimestamp()},{merge:true});
      for(const item of plan.allocations)tx.update(db.collection('prestamos_operativos').doc(item.id),{remainingAmount:item.remainingAmount,repaidAmount:item.repaidAmount,status:item.status,updatedAt:serverTimestamp()});
    });
    const committed=await ref.get();
    if(!committed.exists)fail('unavailable','Todavía no se pudo confirmar el guardado. Reintentá la misma operación.');
    same(committed.data(),key,uid);
    return {ok:true,committed:true,alreadyRegistered:false,collection:key.collection,id:key.id,row:jsonRow(committed.data())};
  };
}
function createOperationalSaveFunction(deps) {
  const {onCall,HttpsError}=require('firebase-functions/v2/https');
  const {FieldValue}=require('firebase-admin/firestore');
  const handler=createOperationalHandler({...deps,serverTimestamp:()=>FieldValue.serverTimestamp()});
  return onCall({region:'southamerica-east1',timeoutSeconds:120,memory:'512MiB',maxInstances:5,invoker:'public'},async request=>{
    try{return await handler(request);}catch(error){
      if(error instanceof HttpsError)throw error;
      if(error instanceof SaveError)throw new HttpsError(error.code,error.message);
      console.error('operationalSaveV311:',String(error.code||error.name||'unknown'));
      throw new HttpsError('unavailable','No se pudo confirmar el guardado en el servidor. Reintentá sin crear otra operación.');
    }
  });
}
module.exports={createOperationalSaveFunction,createOperationalHandler,SaveError,normalizeInput,requestKey,buildRow,verifiedReceipt,repayment,own,ownedRows};
