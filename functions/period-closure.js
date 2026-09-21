'use strict';
const {createHash}=require('node:crypto');
const {HttpsError,onCall}=require('firebase-functions/v2/https');
const {getDownloadURL}=require('firebase-admin/storage');
const {calculateTeamRealtimeSettlementBalance}=require('./telegram-billing-balance');
const policy=require('./period-policy');
const expensesPolicy=require('./expense-policy');
const OWNERS=['driverUid','choferUid','uid','ownerUid','driverId','choferId','userUid','createdByUid'];
const COLLECTIONS={records:'billing_records',expenses:'gastos',uberWeeks:'uber_weekly_closures',closures:'cierres_semanales',debts:'deudas_choferes'};
const WORKFLOW='period_proof_automatic_v1';
const active=r=>!r.deleted&&!r.isDeleted&&!r.eliminado&&!/deleted|eliminado|borrado|anulado|reject|rechaz|cancel/.test(String(r.status||r.estado||''));
const ms=r=>Number(r.createdAtMs||0)||r.createdAt?.toMillis?.()||Date.parse(r.createdAt)||0;
const value=r=>Number(r.amount??r.monto??r.grossAmount??r.totalAmount??0);
function stable(value){if(value==null||typeof value!=='object')return value;if(value.toMillis)return value.toMillis();if(value instanceof Date)return value.toISOString();if(Array.isArray(value))return value.map(stable);return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));}
async function readInputs(db,tx,uid) {
  const input={};
  // Same ownership aliases as the existing app; Maps prevent counting one document twice.
  for(const [name,collection] of Object.entries(COLLECTIONS)) {
    const rows=new Map();
    for(const field of OWNERS) {
      const snapshot=await tx.get(db.collection(collection).where(field,'==',uid));
      for(const doc of snapshot.docs)rows.set(doc.id,{...doc.data(),id:doc.id});
    }
    input[name]=[...rows.values()].sort((a,b)=>a.id.localeCompare(b.id));
  }
  return input;
}
function quoteFromInput(uid,input) {
  const model=calculateTeamRealtimeSettlementBalance(input);
  const previous=input.closures.filter(r=>r.closureWorkflowVersion===WORKFLOW&&r.status==='completed').sort((a,b)=>ms(b)-ms(a))[0];
  const cutoff=Math.max(Number(previous?.createdAtMs||0),model.effectiveCutoffMs||0);
  const current=r=>active(r)&&policy.isNew(r)&&ms(r)>cutoff;
  const records=input.records.filter(current).filter(r=>r.type!=='settlement_adjustment'&&r.type!=='reimbursement_compensation');
  const uber=input.uberWeeks.filter(current).filter(r=>r.settlementWorkflowVersion==='v85_verified_direct'?r.verifiedAutomatically&&r.reviewStatus==='completed':r.adminConfirmed&&/approved|completed/.test(r.reviewStatus||r.status||''));
  const expenseRows=input.expenses.filter(current);
  const sum=(rows,fn=value)=>policy.round(rows.reduce((total,row)=>total+fn(row),0));
  const cash=sum(records.filter(r=>policy.method(r)==='cash'))+sum(uber,r=>Number(r.grossAmount??r.amount??0));
  const digital=sum(records.filter(r=>policy.method(r)==='digital'));
  const cashExpense=sum(expenseRows.filter(r=>policy.expenseMethod(r)==='cash'));
  const digitalExpense=sum(expenseRows.filter(r=>policy.expenseMethod(r)==='digital'));
  const driverExpenses=expenseRows.filter(r=>expensesPolicy.find(r.expenseType)?.group==='driver');
  const exploraExpenses=expenseRows.filter(r=>expensesPolicy.find(r.expenseType)?.group==='explora');
  const cashbox=sum(records.filter(r=>!(r.excludeFromCashbox||r.cashboxExcluded||r.cajaChicaEliminada||r.ignoreCashbox||r.noCashbox)),r=>value(r)*.1)+sum(uber,r=>Number(r.grossAmount??r.amount??0)*.1);
  const netCash=policy.round(cash-cashExpense),netDigital=policy.round(digital-digitalExpense);
  const walletDifference=policy.round((netCash-netDigital)/2);
  const responsibilityAdjustment=policy.round((sum(driverExpenses)-sum(exploraExpenses))/2);
  const debtRows=driverExpenses.filter(r=>policy.expenseMethod(r)==='digital').map(r=>({id:r.id,label:r.expenseLabel||expensesPolicy.find(r.expenseType)?.label||r.detail||'Gasto del chofer',amount:value(r)}));
  const policyDelta=walletDifference+responsibilityAdjustment+cashbox;
  const externalDebt=policy.round(model.balance-calculateTeamRealtimeSettlementBalance({...input,debts:[]}).balance);
  const externalDebtRows=input.debts.map(debt=>({id:debt.id,label:debt.debtLabel||debt.reason||debt.detail||debt.description||'Tu deuda',
    amount:policy.round(model.balance-calculateTeamRealtimeSettlementBalance({...input,debts:input.debts.filter(row=>row.id!==debt.id)}).balance)})).filter(debt=>debt.amount>0);
  const previousBalance=policy.round(model.balance-policyDelta-externalDebt);
  const summary={cash,digital,cashExpense,digitalExpense,netCash,netDigital,gross:policy.round(cash+digital),cashbox:policy.round(cashbox),walletDifference,responsibilityAdjustment,previousBalance,externalDebt,externalDebtRows,debtRows,driverExpenseTotal:sum(driverExpenses),exploraExpenseTotal:sum(exploraExpenses)};
  // Notification delivery metadata must not invalidate an unchanged financial quote.
  const ids=Object.fromEntries(Object.entries(input).map(([name,rows])=>[name,rows.map(row=>row.id).sort()]));
  const quoteId=createHash('sha256').update(JSON.stringify(stable({uid,balance:model.balance,summary,cutoff,ids}))).digest('hex');
  return {quoteId,version:policy.VERSION,workflow:WORKFLOW,balance:model.balance,amount:model.amount,direction:model.direction,
    summary,
    cutoffAtMs:cutoff};
}
async function periodQuote({db,uid}) {
  if(!uid)throw new HttpsError('unauthenticated','Iniciá sesión.');
  return db.runTransaction(async tx=>quoteFromInput(uid,await readInputs(db,tx,uid)));
}
async function confirmPeriodClosure({db,uid,input={},proofMetadata,now=Date.now()}) {
  if(!uid)throw new HttpsError('unauthenticated','Iniciá sesión.');
  const quoteId=String(input.quoteId||'');
  if(!/^[a-f0-9]{64}$/.test(quoteId))throw new HttpsError('invalid-argument','Volvé a abrir el cierre.');
  const proofPath=String(input.proofPath||'');
  if(!proofPath.startsWith(`cierres_semanales/period/${uid}/${quoteId}/`)||proofPath.includes('..'))throw new HttpsError('invalid-argument','Cargá el comprobante de este cierre.');
  const proof=await proofMetadata(proofPath);
  if(!proof||!(Number(proof.size)>0)||Number(proof.size)>15*1024*1024||!(/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(proof.contentType||''))||!proof.url)throw new HttpsError('invalid-argument','El comprobante debe ser una imagen o PDF de hasta 15 MB.');
  const id=`period_${uid}_${quoteId}`;
  const closureRef=db.collection('cierres_semanales').doc(id),paymentRef=db.collection('billing_records').doc(id);
  return db.runTransaction(async tx=>{
    const existing=await tx.get(closureRef);
    if(existing.exists) {
      const data=existing.data();
      if(data.driverUid!==uid||data.quoteId!==quoteId)throw new HttpsError('permission-denied','Este cierre no pertenece a tu cuenta.');
      return {id,alreadyClosed:true,amount:data.settlementAmount,direction:data.paymentDirection};
    }
    const rows=await readInputs(db,tx,uid),quote=quoteFromInput(uid,rows);
    if(quote.quoteId!==quoteId)throw new HttpsError('failed-precondition','Los movimientos cambiaron. Volvé a revisar el cierre antes de cargar el comprobante.');
    if(quote.amount<=.5)throw new HttpsError('failed-precondition','Las cuentas ya están equilibradas.');
    const driverPays=quote.direction==='driver_to_explora';
    const owner={driverUid:uid,choferUid:uid,uid,ownerUid:uid,driverId:uid,operatorUid:uid,createdByUid:uid,requestedByUid:uid,createdByRole:'driver',businessId:'explora-control-operativo'};
    const attachment={proofPath,proofUrl:proof.url,receiptPath:proofPath,receiptUrl:proof.url,proofGeneration:String(proof.generation||''),proofMimeType:proof.contentType,receiptRequired:true,receiptStatus:'uploaded'};
    const times={createdAt:new Date(now),createdAtMs:now,completedAt:new Date(now),completedAtMs:now};
    // Pay the included administrative debts in the same transaction. Their amount is
    // allocated within the transfer, not charged for a second time by the ledger.
    const debtAllocations=[];
    for (const debt of rows.debts) {
      const included=policy.round(quote.balance-calculateTeamRealtimeSettlementBalance({...rows,debts:rows.debts.filter(row=>row.id!==debt.id)}).balance);
      if (included<=0) continue;
      debtAllocations.push({debtId:debt.id,amount:included});
      tx.update(db.collection('deudas_choferes').doc(debt.id),{remainingAmount:0,saldoPendiente:0,
        paidAmount:Number(debt.paidAmount||debt.amountPaid||0)+included,amountPaid:Number(debt.paidAmount||debt.amountPaid||0)+included,
        status:'paid',debtStatus:'paid',lastPaymentAt:new Date(now),lastPaymentAtMs:now,lastPaymentMethod:'period_settlement',
        settledByClosureId:id,updatedAt:new Date(now),updatedAtMs:now});
    }
    tx.create(closureRef,{...owner,...attachment,...times,quoteId,closureWorkflowVersion:WORKFLOW,
      closureKind:'facturacion',closureType:'facturacion',payTab:'facturacion',billingClosure:true,closureMode:'settlement_only',autoClosesCashbox:false,
      direction:driverPays?'driver_pays_explora':'explora_pays_driver',paymentDirection:quote.direction,paymentMethod:'transfer',
      status:'completed',reviewStatus:'completed',requestedAmount:quote.amount,settlementAmount:quote.amount,requestedPaymentAmount:quote.amount,paidAmountTotal:quote.amount,remainingAmount:0,
      settlementBefore:quote.balance,settlementAfter:0,settlementSummary:quote.summary,debtAllocations,paymentRecordId:id,proofUploadedByUid:uid,proofUploadedByRole:'driver',cutoffAtMs:now,
      notes:'Cierre automático con comprobante de pago realizado; no reinicia históricos.'});
    // The receipt and settlement are committed together. This adjustment has no cashbox or fiscal invoice.
    tx.create(paymentRef,{...owner,...attachment,...times,type:'settlement_adjustment',operationType:'settlement_adjustment',internalManagement:true,internalSettlementAdjustment:true,affectsBillingSettlement:true,
      adjustmentDirection:quote.direction,paymentDirection:quote.direction,method:driverPays?'digital':'cash',paymentMethod:driverPays?'digital':'cash',
      amount:quote.amount,monto:quote.amount,advanceRepaymentAmount:0,periodDebtSettlementAmount:quote.summary.externalDebt,debtAllocations,service:'Cierre del período',detail:driverPays?'Pago a Explora con comprobante':'Pago recibido de Explora con comprobante',
      closureId:id,notificationHandledByClosure:true,idempotencyKey:id,status:'completed',telegramSettlementBeforeBalance:quote.balance,telegramSettlementAfterBalance:0});
    return {id,alreadyClosed:false,amount:quote.amount,direction:quote.direction};
  });
}
function createPeriodFunctions({db,bucket,assertViewer}) {
  const options={region:'southamerica-east1',timeoutSeconds:120,memory:'256MiB'};
  return {
    getPeriodQuote:onCall(options,async request=>periodQuote({db,uid:await assertViewer(request)})),
    confirmPeriodClosure:onCall(options,async request=>confirmPeriodClosure({db,uid:await assertViewer(request),input:request.data,proofMetadata:async path=>{
      const file=bucket.file(path),[metadata]=await file.getMetadata();return {...metadata,url:await getDownloadURL(file)};
    }}))
  };
}
module.exports={periodQuote,confirmPeriodClosure,quoteFromInput,readInputs,createPeriodFunctions,WORKFLOW};
