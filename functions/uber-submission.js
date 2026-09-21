"use strict";
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {Timestamp} = require('firebase-admin/firestore');
const {eligibleUberWeek} = require('./uber-proof');
const WORKFLOW = 'v85_verified_direct';
const periodPolicy = require('./period-policy');
const RULE = 'uber_gross_cash_cashbox_5_v1';
const inactive = row => row.deleted === true || row.isDeleted === true || /reject|rechaz|cancel|anulad|deleted/.test(String(row.reviewStatus || row.status || ''));

async function registerUberSubmission({db, uid, input, driverName, balance, businessId, now = Date.now()}) {
  const proofId = String(input.verifiedProofId || '');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(proofId)) throw new HttpsError('invalid-argument','VolvÃ© a verificar la captura.');
  const proofRef = db.collection('uber_proof_checks').doc(proofId);
  // The server owns the week and amount; the browser cannot set applied totals.
  return db.runTransaction(async tx => {
    const proofSnap = await tx.get(proofRef);
    const proof = proofSnap.data() || {};
    if (!proofSnap.exists || proof.uid !== uid || proof.valid !== true) throw new HttpsError('permission-denied','La captura no corresponde a tu cuenta.');
    const id = `uber_${uid}_${proof.weekStartDate}_direct`;
    const ref = db.collection('uber_weekly_closures').doc(id);
    const existing = await tx.get(ref);
    if (existing.exists && !inactive(existing.data())) {
      if (existing.data().verifiedProofId !== proofId) throw new HttpsError('already-exists','Esta semana ya estÃ¡ registrada.');
      return {id, record:existing.data(), alreadyRegistered:true};
    }
    const week = eligibleUberWeek(new Date(now));
    if (!week || proof.weekStartDate !== week.start || proof.weekCloseDate !== week.close ||
        input.weekStartDate !== week.start || input.weekCloseDate !== week.close) throw new HttpsError('failed-precondition','Esta semana no estÃ¡ disponible. VolvÃ© al inicio.');
    const amount = Number(proof.amount);
    if (!(amount > 0) || !Number.isFinite(amount) || amount > 100000000 || Number(input.amount) !== amount ||
        proof.expiresAt?.toMillis() <= now || !proof.expiresAt || proof.usedAt) throw new HttpsError('failed-precondition','VolvÃ© a verificar la captura y el monto.');
    if (!String(proof.proofPath || '').startsWith(`uber_verified/${uid}/`) || !proof.proofUrl) throw new HttpsError('failed-precondition','Comprobante invÃ¡lido.');
    // Also block a second submission when the same week exists in an older workflow.
    const previous = await tx.get(db.collection('uber_weekly_closures').where('driverUid','==',uid));
    if (previous.docs.some(s => s.id !== id && !inactive(s.data()) &&
        (s.data().weekStartDate === week.start || s.data().weekCloseDate === week.close))) throw new HttpsError('already-exists','Esta semana ya estÃ¡ registrada.');
    const newPolicy = input.settlementRuleVersion === periodPolicy.VERSION;
    const cashboxRate = newPolicy ? .10 : .05;
    const cashboxAmount = Math.round((amount * cashboxRate + Number.EPSILON) * 100) / 100;
    const settlementImpact = Math.round((amount * (newPolicy ? .5 : 1) + cashboxAmount) * 100) / 100;
    const label = date => new Intl.DateTimeFormat('es-AR',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z')).replace(/\./g,'');
    const record = {
      closureId:id, driverUid:uid, choferUid:uid, uid, driverId:uid, operatorUid:uid, createdByUid:uid,
      createdByRole:'driver', driverName, operatorName:driverName, businessId,
      weekId:week.start, weekKey:week.start, weekStartDate:week.start, weekCloseDate:week.close,
      weekLabel:`${label(week.start)} â€“ ${label(week.close)}`,
      grossAmount:amount, totalAmount:amount, amount, cashAmount:amount, uberCashAmount:amount,
      transferAmount:0, uberTransferAmount:0, digitalAmount:0, driverShare:amount * (newPolicy ? .5 : 1), driverNetAmount:amount * (newPolicy ? .5 : 1),
      exploraShare:newPolicy ? amount * .5 : 0, cashboxRate, cashboxAmount, uberCashboxAmount:cashboxAmount,
      settlementImpact, debtAmount:settlementImpact, settlementRuleVersion:newPolicy ? periodPolicy.VERSION : RULE,
      settlementWorkflowVersion:WORKFLOW, verifiedAutomatically:true, verifiedProofId:proofId,
      driverSubmitted:true, adminConfirmed:false, reviewStatus:'completed', status:'completed', locked:true,
      proofPath:proof.proofPath, proofUrl:proof.proofUrl, receiptPath:proof.proofPath, receiptUrl:proof.proofUrl,
      telegramPhotoUrl:proof.proofUrl, notificationPhotoUrl:proof.proofUrl,
      telegramSettlementBeforeBalance:balance, telegramSettlementAfterBalance:balance+settlementImpact,
      createdAt:Timestamp.fromMillis(now), updatedAt:Timestamp.fromMillis(now), createdAtMs:now, updatedAtMs:now
    };
    tx.set(ref, record);
    tx.update(proofRef,{usedAt:Timestamp.fromMillis(now),closureId:id});
    return {id,record,alreadyRegistered:false};
  });
}
async function deleteUberSubmission({db,documentId,adminUid,reason,getBalance,now=Date.now()}) {
  const ref = db.collection('uber_weekly_closures').doc(documentId);
  const audit = db.collection('admin_audit').doc();
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return {ok:true,type:'uber',documentId,alreadyDeleted:true};
    const data = snap.data();
    const driverUid = data.driverUid || data.operatorUid || data.choferUid || data.uid;
    if (!driverUid) throw new HttpsError('failed-precondition','No se pudo identificar al chofer.');
    if (getBalance) {
      const settlement = await getBalance(driverUid);
      const createdAt = data.createdAtMs || data.createdAt?.toMillis() || 0;
      if (createdAt <= Number(settlement.effectiveCutoffMs || settlement.baseline || 0)) {
        throw new HttpsError('failed-precondition','Esta liquidaciÃ³n ya estÃ¡ incluida en un cierre o ajuste. CorregÃ­ ese cierre antes de eliminarla.');
      }
    }
    // Keep the proof and the audit snapshot; deleting the operation recalculates
    // the live balance and a NEW verified proof is needed to register again.
    tx.create(audit,{action:'admin_delete_financial_movement',type:'uber',collectionName:'uber_weekly_closures',
      documentId,driverUid,adminUid,reason,amount:Number(data.grossAmount || data.totalAmount || data.amount || 0),
      targetName:data.driverName || data.operatorName || 'Chofer',sourceRecord:data,
      createdAt:Timestamp.fromMillis(now),createdAtMs:now,version:WORKFLOW});
    tx.delete(ref);
    return {ok:true,type:'uber',collectionName:'uber_weekly_closures',documentId,driverUid};
  });
}
function createUberSubmissionFunction({db,businessId,assertViewer,getProfile,getBalance}) {
  return onCall({region:'southamerica-east1',timeoutSeconds:90,memory:'256MiB'},async request => {
    const uid = await assertViewer(request);
    if(request.data?.settlementRuleVersion!==periodPolicy.VERSION)throw new HttpsError('failed-precondition','Actualizá la página para usar las billeteras nuevas antes de liquidar Uber.');
    const [profile, settlement] = await Promise.all([getProfile(uid),getBalance(uid)]);
    const data = profile?.data() || {};
    return registerUberSubmission({db,uid,businessId,input:request.data || {},
      driverName:String(data.displayName || data.nombreCompleto || data.nombre || data.name || data.username || data.usuario || 'Chofer'),
      balance:Number(settlement.balance || 0)});
  });
}
module.exports = {registerUberSubmission,deleteUberSubmission,createUberSubmissionFunction,WORKFLOW,RULE};
