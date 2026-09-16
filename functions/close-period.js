'use strict';

const crypto = require('node:crypto');
const period = require('./period-settlement');
const {ownedRows} = require('./operational-save');

const STATE_COLLECTION = '_operational_closure_state';
const MAX_SNAPSHOT_BYTES = 780000;
const MAX_SNAPSHOT_ROWS = 900;

class CloseError extends Error {
  constructor(code,message,details={}) { super(message); this.code=code; this.details=details; }
}
function fail(code,message,details) { throw new CloseError(code,message,details); }
const clean = value => String(value ?? '').trim();
const round = value => Math.round((Number(value)||0)*100)/100;
function safeTime(row={}) { return period.rowTime(row) || Number(row.createdAtMs||0) || 0; }
function amount(row={}) { return round(row.statementAmount ?? period.amount(row) ?? row.amount ?? row.monto ?? 0); }
function label(row={},fallback='Movimiento') {
  return clean(row.statementLabel || row.expenseLabel || row.debtLabel || row.service || row.detail || row.notes || row.reason || fallback).slice(0,240) || fallback;
}
function receiptRef(row={}) {
  return {
    receiptPdfPath: clean(row.receiptPdfPath).slice(0,700),
    receiptPath: clean(row.receiptPath || row.proofPath).slice(0,700),
    receiptUrl: clean(row.receiptUrl || row.proofUrl).slice(0,2600),
    receiptFileName: clean(row.receiptPdfFileName || row.receiptFileName || row.proofFileName).slice(0,200)
  };
}
function normalizeClosureProof(raw={},uid,requestId){
  const proof=raw?.liquidationProof && typeof raw.liquidationProof==='object' ? raw.liquidationProof : raw;
  const expectedPath=`cierres_semanales/${requestId}/${uid}/imagen.jpg`;
  const path=clean(proof.proofPath || proof.receiptPath || proof.telegramPhotoPath);
  const url=clean(proof.proofUrl || proof.receiptUrl || proof.telegramPhotoUrl || proof.notificationPhotoUrl);
  const mime=clean(proof.proofMimeType || proof.receiptMimeType || proof.telegramPhotoMimeType || 'image/jpeg').toLowerCase();
  const fileName=clean(proof.proofFileName || proof.receiptFileName || 'imagen.jpg').slice(0,120);
  if(path!==expectedPath) fail('failed-precondition','Adjuntá el comprobante obligatorio del cierre antes de confirmar.');
  if(!/^https:\/\//i.test(url)) fail('failed-precondition','El comprobante del cierre no tiene una URL válida.');
  try{
    const parsed=new URL(url), decoded=decodeURIComponent(parsed.pathname);
    if(!['firebasestorage.googleapis.com','storage.googleapis.com'].includes(parsed.hostname)||!decoded.includes(path)){
      fail('failed-precondition','La URL del comprobante no coincide con el archivo subido para este cierre.');
    }
  }catch(error){
    if(error instanceof CloseError) throw error;
    fail('failed-precondition','La URL del comprobante no es válida.');
  }
  if(mime!=='image/jpeg') fail('failed-precondition','El comprobante del cierre debe ser una imagen JPG.');
  return {proofPath:path,receiptPath:path,telegramPhotoPath:path,proofUrl:url,receiptUrl:url,telegramPhotoUrl:url,notificationPhotoUrl:url,proofMimeType:'image/jpeg',receiptMimeType:'image/jpeg',telegramPhotoMimeType:'image/jpeg',proofFileName:fileName,receiptFileName:fileName};
}
async function verifyClosureProof(bucket,proof){
  if(!bucket?.file) fail('failed-precondition','No se pudo verificar el comprobante del cierre.');
  try{
    const [metadata]=await bucket.file(proof.proofPath).getMetadata();
    const size=Number(metadata?.size||0), type=clean(metadata?.contentType).toLowerCase();
    if(!(size>0&&size<=8*1024*1024)) fail('failed-precondition','El comprobante del cierre está vacío o es demasiado grande.');
    if(type!=='image/jpeg') fail('failed-precondition','El comprobante del cierre no es una imagen JPG válida.');
    return {size,contentType:type,generation:clean(metadata?.generation).slice(0,80)};
  }catch(error){
    if(error instanceof CloseError) throw error;
    fail('failed-precondition','No se encontró el comprobante obligatorio del cierre. Volvé a adjuntarlo.');
  }
}
function ownerName(profile,request) {
  const data=profile?.data?.()||{};
  return clean(data.displayName||data.nombreCompleto||data.nombre||data.username||request.auth?.token?.name||'Chofer').slice(0,160)||'Chofer';
}
function fiscalInfo(row={}) {
  const authorized = clean(row.arcaStatus || row.invoiceStatus || row.fiscalStatus).toLowerCase() === 'authorized' || row.cae;
  if (authorized) return {status:'authorized',label:'Factura ARCA autorizada',number:clean(row.invoiceNumber || row.comprobanteNumero || row.cae)};
  if (row.fiscalEmissionEnabled === false) return {status:'disabled',label:'ARCA desactivada',number:''};
  return {status:'pending',label:'ARCA pendiente / sin autorización asociada',number:''};
}
function incomeEntry(row,method) {
  return {id:clean(row.id),label:label(row,'Viaje'),amount:amount(row),method,atMs:safeTime(row),invoice:fiscalInfo(row),...receiptRef(row)};
}
function expenseEntry(row) {
  const value=amount(row), payer=clean(row.payerRole||row.paidByRole).toLowerCase();
  const paidByExplora=['explora','admin','administrador'].includes(payer);
  return {id:clean(row.id),label:label(row,'Gasto'),amount:value,atMs:safeTime(row),payer:paidByExplora?'Explora':'Chofer',exploraShare:round(value/2),driverShare:round(value/2),...receiptRef(row)};
}
function debtEntry(row) {
  const value=round(row.statementAmount ?? row.remainingAmount ?? row.saldoPendiente ?? amount(row));
  return {id:clean(row.id),label:label(row,'Deuda interna del chofer'),amount:value,atMs:safeTime(row),...receiptRef(row)};
}
function adjustmentEntry(row) {
  const direction=period.direction(row);
  return {id:clean(row.id),label:label(row,direction==='driver_to_explora'?'Pago del chofer a Explora':'Pago de Explora al chofer'),amount:amount(row),atMs:safeTime(row),direction:direction==='driver_to_explora'?'Chofer → Explora':direction==='explora_to_driver'?'Explora → Chofer':'Ajuste interno',...receiptRef(row)};
}
function cents(value){ return Math.round(round(value)*100); }
function stableDigest(value){ return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function documentNumber(uid,atMs,digest) {
  const d=new Date(atMs), y=String(d.getUTCFullYear()), m=String(d.getUTCMonth()+1).padStart(2,'0'), day=String(d.getUTCDate()).padStart(2,'0');
  const u=clean(uid).replace(/[^A-Za-z0-9]/g,'').slice(-6)||'CHOFER';
  return `CIERRE-${y}${m}${day}-${u}-${digest.slice(0,8).toUpperCase()}`;
}
function buildSnapshot({uid,name,model,createdAtMs,closureId,requestId,proof}) {
  const cash=(model.rows?.cash||[]).map(row=>incomeEntry(row,'cash'));
  const digital=(model.rows?.digital||[]).map(row=>incomeEntry(row,'digital'));
  const expenses=(model.rows?.expenses||[]).map(expenseEntry);
  const debts=(model.rows?.debts||[]).map(debtEntry);
  const internal=[];
  if(Math.abs(Number(model.cashBox||0))>.005) internal.push({kind:'cashbox',label:'Caja Explora 10% del neto del período',amount:round(model.cashBox),direction:'Asignación interna',note:'Distribución interna del período; no es un servicio adicional.'});
  for(const row of model.rows?.adjustments||[]) internal.push({...adjustmentEntry(row),kind:'settlement',note:'Liquidación/compensación interna; no se suma nuevamente a ingresos por servicios.'});
  if(Math.abs(Number(model.advanceRepayments||0))>.005) internal.push({kind:'advance',label:'Aplicado a adelantos operativos',amount:round(model.advanceRepayments),direction:'Aplicación interna',note:'Compensación de saldo interno; no es un viaje nuevo.'});
  const balanceBefore=round(model.balance), settlementAmount=round(Math.abs(balanceBefore));
  const settlementDirection=balanceBefore>0?'driver_to_explora':balanceBefore<0?'explora_to_driver':'balanced';
  if(settlementAmount>.005) internal.push({kind:'closure_liquidation',label:'Liquidación del cierre',amount:settlementAmount,direction:settlementDirection==='driver_to_explora'?'Chofer → Explora':'Explora → Chofer',note:'Movimiento interno que cancela el saldo documentado de este cierre. No es un nuevo ingreso por servicio.'});
  const core={uid,baseline:Number(model.effectiveCutoffMs||0),createdAtMs,balanceBefore,settlementAmount,cash:round(model.cash),digital:round(model.digital),expense:round(model.expense),debt:round(model.driverDebtTotal??model.adminDebt),ids:[...cash,...digital,...expenses,...debts].map(r=>r.id).sort()};
  const digest=stableDigest(core);
  const snapshot={
    version:'closure_settle_zero_v319',closureId,requestId,documentNumber:documentNumber(uid,createdAtMs,digest),createdAtMs,periodStartMs:Number(model.effectiveCutoffMs||0),driverUid:uid,driverName:name,
    notice:'DOCUMENTO NO VÁLIDO COMO FACTURA',
    subtitle:'Cierre operativo, rendición y conciliación interna. No reemplaza facturas ni comprobantes fiscales y no determina por sí solo IVA, Ganancias, Monotributo u otro tratamiento tributario.',
    liquidationProof:{required:true,path:proof.proofPath,url:proof.proofUrl,fileName:proof.proofFileName,mimeType:'image/jpeg',uploadedAtMs:createdAtMs},
    incomes:{cash,digital,cashTotal:round(model.cash),digitalTotal:round(model.digital),total:round(model.grand)},
    expenses:{rows:expenses,total:round(model.expense),paidByDriver:round(model.expenseCash),paidByExplora:round(model.expenseDigital),exploraShare:round(Number(model.expense||0)/2),driverShare:round(Number(model.expense||0)/2)},
    internal:{rows:internal,total:round(internal.reduce((sum,row)=>sum+Math.abs(Number(row.amount||0)),0))},
    debts:{rows:debts,total:round(model.driverDebtTotal??model.adminDebt),settledByClosure:true},
    reconciliation:{openingBalance:round(model.openingBalance),periodDifference:round(model.periodBalance),debts:round(model.adminDebt),advanceRepayments:round(model.advanceRepayments),driverPaid:round(model.driverPaid),exploraPaid:round(model.exploraPaid),balanceBefore,settlementDirection,settlementAmount,balanceAfter:0,cashRemaining:round(model.cashRemaining),available:round(model.available),driverShare:round(model.driverShare),exploraShare:round(model.exploraShare),cashBox:round(model.cashBox)},
    references:{incomeCount:cash.length+digital.length,expenseCount:expenses.length,debtCount:debts.length,internalCount:internal.length},
    digest
  };
  const rowCount=cash.length+digital.length+expenses.length+debts.length+internal.length;
  if(rowCount>MAX_SNAPSHOT_ROWS) fail('resource-exhausted','El período tiene demasiados movimientos para un solo cierre.');
  if(Buffer.byteLength(JSON.stringify(snapshot))>MAX_SNAPSHOT_BYTES) fail('resource-exhausted','El cierre supera el tamaño seguro del documento.');
  return snapshot;
}
function activePeriodHasRows(model={}) {
  return Boolean((model.rows?.cash?.length||0)+(model.rows?.digital?.length||0)+(model.rows?.expenses?.length||0)+(model.rows?.adjustments?.length||0)+(model.rows?.debts?.length||0));
}
function createClosePeriodHandler({db,bucket,businessId,options,assertViewer,getProfile,serverTimestamp,now=Date.now}) {
  return async request => {
    if(!request.auth?.uid) fail('unauthenticated','Iniciá sesión para cerrar la cuenta.');
    if(options.arcaEnabled!==false) fail('failed-precondition','Este cierre está preparado para la versión con ARCA desactivada.');
    const uid=await assertViewer(request), profile=await getProfile(uid,request), name=ownerName(profile,request);
    const raw=request.data||{}, requestId=clean(raw.requestId);
    if(!/^closure_[a-f0-9]{32}$/.test(requestId)) fail('invalid-argument','Identificador de cierre inválido.');
    const proof=normalizeClosureProof(raw,uid,requestId);
    const proofMetadata=await verifyClosureProof(bucket,proof);
    const closureId=`period_${requestId}`;
    const paymentId=`settlement_${requestId}`;
    const debtPaymentId=`debtnet_${requestId}`;
    const stateRef=db.collection(STATE_COLLECTION).doc(uid);
    const closureRef=db.collection('cierres_semanales').doc(closureId);
    const paymentRef=db.collection('billing_records').doc(paymentId);
    const debtPaymentRef=db.collection('deuda_pagos').doc(debtPaymentId);
    const createdAtMs=now();

    const result=await db.runTransaction(async tx=>{
      const [stateSnap,existingClosure]=await Promise.all([tx.get(stateRef),tx.get(closureRef)]);
      if(existingClosure.exists){
        const data=existingClosure.data()||{};
        if(data.driverUid!==uid||data.requestId!==requestId) fail('already-exists','Ese cierre pertenece a otra operación.');
        if(clean(data.proofPath||data.receiptPath)!==proof.proofPath) fail('already-exists','Ese cierre ya fue confirmado con otro comprobante.');
        return {ok:true,committed:true,alreadyRegistered:true,closureId,snapshot:data.snapshot||null};
      }
      const [records,expenses,uberWeeks,debts,closures]=await Promise.all([
        ownedRows(db,'billing_records',uid,tx),ownedRows(db,'gastos',uid,tx),ownedRows(db,'uber_weekly_closures',uid,tx),ownedRows(db,'deudas_choferes',uid,tx),ownedRows(db,'cierres_semanales',uid,tx)
      ]);
      const model=period.calculate({records,expenses,uberWeeks,debts,closures});
      const state=stateSnap.exists?stateSnap.data()||{}:{};
      if(!activePeriodHasRows(model) && Math.abs(Number(model.balance||0))<=.005 && state.lastClosureId){
        const lastRef=db.collection('cierres_semanales').doc(clean(state.lastClosureId));
        const last=await tx.get(lastRef);
        if(last.exists) return {ok:true,committed:true,alreadyRegistered:true,noNewMovements:true,closureId:last.id,snapshot:last.data()?.snapshot||null};
      }
      const snapshot=buildSnapshot({uid,name,model,createdAtMs,closureId,requestId,proof});
      const balance=round(model.balance), settlementAmount=round(Math.abs(balance));
      const direction=balance>0?'driver_to_explora':balance<0?'explora_to_driver':'balanced';
      const cutoffAtMs=createdAtMs;

      const debtAllocations=[];
      for(const row of model.rows?.debts||[]){
        const value=round(row.statementAmount ?? row.remainingAmount ?? row.saldoPendiente ?? amount(row));
        if(!(value>.005)||!row.id) continue;
        debtAllocations.push({debtId:row.id,amount:value});
        tx.set(db.collection('deudas_choferes').doc(row.id),{
          remainingAmount:0,saldoPendiente:0,paidAmount:round(Number(row.paidAmount??row.amountPaid??0)+value),amountPaid:round(Number(row.paidAmount??row.amountPaid??0)+value),
          status:'paid',debtStatus:'paid',closedByClosureId:closureId,closureNettingAmount:value,closedAtMs:createdAtMs,closedAt:serverTimestamp(),updatedAtMs:createdAtMs,updatedAt:serverTimestamp()
        },{merge:true});
      }

      const paymentRow=settlementAmount>.005?{
        type:'settlement_adjustment',operationType:'settlement_adjustment',internalManagement:true,internalSettlementAdjustment:true,affectsBillingSettlement:true,
        adjustmentDirection:direction,method:'internal',paymentMethod:'closure_liquidation',amount:settlementAmount,monto:settlementAmount,service:'Liquidación de cierre',detail:`Liquidación vinculada a ${snapshot.documentNumber}.`,notes:`Liquidación vinculada a ${snapshot.documentNumber}.`,
        sourceModule:'cierre',status:'completed',driverUid:uid,choferUid:uid,uid,ownerUid:uid,driverId:uid,operatorUid:uid,operatorName:name,driverName:name,businessId,
        dayKey:new Date(createdAtMs).toISOString().slice(0,10),closureId,closureDocumentNumber:snapshot.documentNumber,nonFiscalMovement:true,excludeFromServiceIncome:true,closureSettlementChild:true,
        settlementBefore:balance,settlementAfter:0,createdAtMs,createdAt:serverTimestamp()
      }:null;

      const closureRow={
        type:'account_closure_settlement',closureKind:'facturacion',closureType:'facturacion',closureMode:'on_demand',periodType:'on_demand',cutoffActive:true,cutoffAtMs,
        requestId,documentNumber:snapshot.documentNumber,documentTitle:'Cierre y rendición de cuenta',documentNotice:snapshot.notice,reportVersion:snapshot.version,nonFiscalDocument:true,fiscalDocument:false,
        snapshot,settlementDirection:direction,direction,paymentDirection:direction,settlementAmount,amount:settlementAmount,totalAmount:settlementAmount,requestedPaymentAmount:settlementAmount,balanceBefore:balance,balanceAfter:0,
        amountDueFromDriver:direction==='driver_to_explora'?settlementAmount:0,amountDueToDriver:direction==='explora_to_driver'?settlementAmount:0,remainingAmount:0,
        liquidationPaymentId:settlementAmount>.005?paymentId:'',debtNettingId:debtAllocations.length?debtPaymentId:'',
        proofPath:proof.proofPath,receiptPath:proof.receiptPath,telegramPhotoPath:proof.telegramPhotoPath,proofUrl:proof.proofUrl,receiptUrl:proof.receiptUrl,telegramPhotoUrl:proof.telegramPhotoUrl,notificationPhotoUrl:proof.notificationPhotoUrl,
        proofMimeType:'image/jpeg',receiptMimeType:'image/jpeg',telegramPhotoMimeType:'image/jpeg',proofFileName:proof.proofFileName,receiptFileName:proof.receiptFileName,
        liquidationProofGeneration:proofMetadata.generation,liquidationProofSize:proofMetadata.size,liquidationProofRequired:true,
        method:'transfer',paymentMethod:'transfer',telegramDeliveryStatus:options.telegramEnabled?'pending':'disabled',telegramDeliveryError:'',telegramDeliveryUpdatedAtMs:createdAtMs,
        driverUid:uid,choferUid:uid,uid,ownerUid:uid,operatorUid:uid,driverName:name,operatorName:name,businessId,status:'completed',settlementStatus:'completed',createdAtMs,generatedAtMs:createdAtMs,closedAtMs:createdAtMs,createdAt:serverTimestamp(),closedAt:serverTimestamp()
      };
      tx.create(closureRef,closureRow);
      if(paymentRow) tx.create(paymentRef,paymentRow);
      if(debtAllocations.length){
        tx.create(debtPaymentRef,{type:'closure_debt_netting',operationType:'closure_debt_netting',internalSettlementAdjustment:true,excludeFromBillingSettlement:true,nonFiscalMovement:true,amount:round(debtAllocations.reduce((s,x)=>s+x.amount,0)),monto:round(debtAllocations.reduce((s,x)=>s+x.amount,0)),allocations:debtAllocations,closureId,closureDocumentNumber:snapshot.documentNumber,driverUid:uid,choferUid:uid,uid,ownerUid:uid,driverId:uid,operatorUid:uid,driverName:name,operatorName:name,businessId,status:'completed',createdAtMs,createdAt:serverTimestamp()});
      }
      tx.set(stateRef,{lastClosureId:closureId,lastClosureRequestId:requestId,lastCutoffAtMs:cutoffAtMs,lastClosedAtMs:createdAtMs,lastBalanceBefore:balance,lastBalanceAfter:0,updatedAt:serverTimestamp()},{merge:true});

      const updatedDebts=debts.map(row=>debtAllocations.some(x=>x.debtId===row.id)?{...row,remainingAmount:0,saldoPendiente:0,status:'paid',debtStatus:'paid'}:row);
      const afterRecords=paymentRow?[...records,{...paymentRow,id:paymentId}]:records;
      const after=period.calculate({records:afterRecords,expenses,uberWeeks,debts:updatedDebts,closures:[...closures,{...closureRow,id:closureId}]});
      if(Math.abs(Number(after.balance||0))>.005) fail('failed-precondition','El cierre no logró dejar la cuenta en cero; no se guardó ningún movimiento.',{after:after.balance});
      return {ok:true,committed:true,alreadyRegistered:false,closureId,paymentId:paymentRow?paymentId:'',snapshot};
    });
    return result;
  };
}
function createClosePeriodFunction(deps){
  const {onCall,HttpsError}=require('firebase-functions/v2/https');
  const {FieldValue}=require('firebase-admin/firestore');
  const handler=createClosePeriodHandler({...deps,serverTimestamp:()=>FieldValue.serverTimestamp()});
  return onCall({region:'southamerica-east1',timeoutSeconds:120,memory:'512MiB',maxInstances:4,invoker:'public'},async request=>{
    try{return await handler(request);}catch(error){
      if(error instanceof HttpsError)throw error;
      if(error instanceof CloseError)throw new HttpsError(error.code,error.message,error.details);
      console.error('closeOperationalPeriodV319:',String(error.code||error.name||'unknown'));
      throw new HttpsError('unavailable','No se pudo confirmar el cierre. Reintentá el mismo cierre; no se duplicará.');
    }
  });
}
module.exports={createClosePeriodFunction,createClosePeriodHandler,buildSnapshot,CloseError};
