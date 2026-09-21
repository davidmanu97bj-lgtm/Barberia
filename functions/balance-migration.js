'use strict';
const {createHash}=require('node:crypto');
const {calculateTeamRealtimeSettlementBalance}=require('./telegram-billing-balance');
const {readInputs}=require('./period-closure');
const {round}=require('./period-policy');
const VERSION='opening_balance_20260918_v1';

// Uses the existing signed settlement anchor. Historical debts remain separate:
// neither their principal nor their outstanding amount is added a second time.
async function migrateOpeningBalance({db,uid,actorUid,expectedBalance,now=()=>Date.now()}) {
  if(!uid||!actorUid||!Number.isFinite(expectedBalance))throw Error('Missing verified migration input');
  const id=`${VERSION}_${uid}`,auditRef=db.collection('balance_migrations').doc(id);
  const anchorRef=db.collection('billing_records').doc(id);
  return db.runTransaction(async tx=>{
    const audit=await tx.get(auditRef);
    if(audit.exists)return {...audit.data(),alreadyMigrated:true};
    const anchor=await tx.get(anchorRef);
    if(anchor.exists)throw Error('An opening balance exists without its audit record');
    const input=await readInputs(db,tx,uid);
    const before=calculateTeamRealtimeSettlementBalance(input);
    if(round(before.balance)!==round(expectedBalance))throw Error('El saldo cambió: volver a verificar antes de migrar');
    const base=calculateTeamRealtimeSettlementBalance({...input,debts:[]});
    const cutoff=now();
    const timestamp=r=>Math.max(r.createdAt?.toMillis?.()||0,r.updatedAt?.toMillis?.()||0,r.completedAt?.toMillis?.()||0,Number(r.createdAtMs||0),Number(r.updatedAtMs||0),Number(r.completedAtMs||0));
    if([...input.records,...input.expenses,...input.uberWeeks,...input.closures].some(r=>timestamp(r)>=cutoff))throw Error('Hay movimientos con fecha futura o simultánea: revisar el corte');
    const record={id,driverUid:uid,choferUid:uid,uid,ownerUid:uid,driverId:uid,createdByUid:actorUid,createdByRole:'admin',
      type:'reimbursement_compensation',operationType:'reimbursement_compensation',method:'management',
      amount:0,monto:0,settlementAfter:base.balance,openingBalance:before.balance,openingDebtPrincipal:base.balance,
      migrationVersion:VERSION,internalManagement:true,excludeFromBillingGross:true,excludeFromCashbox:true,
      suppressTelegram:true,status:'completed',service:'Saldo anterior conservado',
      detail:'Deuda inicial del sistema anterior. No es un cobro, gasto ni pago nuevo.',
      createdAt:new Date(cutoff),createdAtMs:cutoff};
    const after=calculateTeamRealtimeSettlementBalance({...input,records:[...input.records,record]});
    if(after.balance!==before.balance)throw Error('La migración modificaría el saldo: cancelada');
    const sourceIds=Object.fromEntries(Object.entries(input).map(([key,rows])=>[key,rows.map(r=>r.id).sort()]));
    const result={version:VERSION,driverUid:uid,actorUid,anchorId:id,balanceBefore:before.balance,balanceAfter:after.balance,
      initialDebt:base.balance,existingDebt:round(before.balance-base.balance),direction:before.direction,
      createdAt:new Date(cutoff),cutoffAtMs:cutoff,sourceIds,
      sourceHash:createHash('sha256').update(JSON.stringify(input)).digest('hex')};
    tx.create(anchorRef,record);tx.create(auditRef,result);
    return {...result,alreadyMigrated:false};
  });
}
module.exports={migrateOpeningBalance,VERSION};
