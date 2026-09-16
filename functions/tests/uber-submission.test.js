'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Timestamp}=require('firebase-admin/firestore');
const memoryDb=require('./memory-firestore');
const {registerUberSubmission,deleteUberSubmission,WORKFLOW}=require('../uber-submission');
const {calculateTeamRealtimeSettlementBalance:balance}=require('../telegram-billing-balance');
const NOW=Date.parse('2026-09-15T12:00:00Z'),uid='driver-a';
function setup() {
  const db=memoryDb();
  const proof={uid,valid:true,amount:100000,weekStartDate:'2026-09-07',weekCloseDate:'2026-09-14',
    expiresAt:Timestamp.fromMillis(NOW+3600000),proofPath:`uber_verified/${uid}/a.jpg`,proofUrl:'https://example.test/a.jpg'};
  db.data.set('uber_proof_checks/a',proof);
  const input={verifiedProofId:'a',amount:100000,weekStartDate:proof.weekStartDate,weekCloseDate:proof.weekCloseDate};
  const register=(changes={})=>registerUberSubmission({db,uid,input,driverName:'Chofer de prueba',balance:20000,businessId:'demo',now:NOW,...changes});
  return {db,proof,input,register};
}
test('Uber válido se aplica sin aprobación; dos envíos concurrentes registran una sola semana y 55% del cobro como saldo (10% neto + reparto)',async()=>{
  const {db,register}=setup();
  const [first,second]=await Promise.all([register(),register()]);
  assert.equal(first.id,second.id);assert.equal(second.alreadyRegistered,true);
  const row=first.record;
  assert.equal(row.settlementWorkflowVersion,WORKFLOW);assert.equal(row.reviewStatus,'completed');
  assert.equal(row.adminConfirmed,false);assert.equal(row.settlementImpact,55000);
  assert.equal(row.telegramSettlementAfterBalance,75000);
  assert.equal(balance({uberWeeks:[row]}).balance,55000);
  assert.equal(balance({uberWeeks:[{...row,verifiedAutomatically:false}]}).balance,0);
  assert.equal(balance({uberWeeks:[{...row,reviewStatus:'pending_admin_review',settlementWorkflowVersion:'v84_driver_submission_admin_review'}]}).balance,0);
  assert.equal([...db.data.keys()].filter(key=>key.startsWith('uber_weekly_closures/')).length,1);
  assert.equal([...db.data.keys()].some(key=>key.startsWith('arca_')),false);
  // A lost response may be safely retried even after the proof expires.
  assert.equal((await register({now:NOW+7200000})).alreadyRegistered,true);
});
test('captura ajena, vencida, usada, monto cambiado o semana incorrecta no crean movimientos',async()=>{
  for(const changes of [{uid:'other'},{valid:false},{expiresAt:Timestamp.fromMillis(NOW-1)},{usedAt:Timestamp.fromMillis(NOW-1)},
    {weekStartDate:'2026-08-31'},{proofPath:'other/a.jpg'},{proofUrl:''}]) {
    const {db,proof,register}=setup();Object.assign(proof,changes);
    await assert.rejects(register());
    assert.equal([...db.data.keys()].some(key=>key.startsWith('uber_weekly_closures/')),false);
  }
  for(const changes of [{amount:99000},{weekCloseDate:'2026-09-21'},{verifiedProofId:'missing'}]) {
    const {input,register}=setup();await assert.rejects(register({input:{...input,...changes}}));
  }
  const {register}=setup();await assert.rejects(register({now:Date.parse('2026-09-14T12:00:00Z')}));
});
test('una semana histórica pendiente también bloquea duplicados sin aprobarla automáticamente',async()=>{
  const {db,proof,register}=setup();
  db.data.set('uber_weekly_closures/old',{driverUid:uid,weekStartDate:proof.weekStartDate,reviewStatus:'pending_admin_review'});
  await assert.rejects(register(),error=>error.code==='already-exists');
  assert.equal(db.data.get('uber_weekly_closures/old').reviewStatus,'pending_admin_review');
  assert.equal(db.data.get('uber_proof_checks/a').usedAt,undefined);
});
test('eliminar revierte el saldo, guarda auditoría y permite recargar con una captura verificada nueva',async()=>{
  const {db,proof,input,register}=setup();const first=await register();
  const before=balance({uberWeeks:[first.record]}).balance;assert.equal(before,55000);
  await deleteUberSubmission({db,documentId:first.id,adminUid:'admin',reason:'Captura incorrecta',now:NOW+1000});
  const rows=[...db.data.entries()].filter(([key])=>key.startsWith('uber_weekly_closures/')).map(([,row])=>row);
  assert.equal(balance({uberWeeks:rows}).balance,0);
  assert.equal((await deleteUberSubmission({db,documentId:first.id,adminUid:'admin',reason:'retry'})).alreadyDeleted,true);
  const audit=[...db.data.entries()].find(([key])=>key.startsWith('admin_audit/'))[1];
  assert.equal(audit.sourceRecord.proofUrl,proof.proofUrl);assert.equal(audit.amount,100000);
  await assert.rejects(register()); // consumed proof cannot resurrect a deleted record
  db.data.set('uber_proof_checks/b',{...proof,usedAt:undefined});
  const replacement=await register({input:{...input,verifiedProofId:'b'},now:NOW+2000});
  assert.equal(replacement.record.verifiedProofId,'b');assert.equal(balance({uberWeeks:[replacement.record]}).balance,55000);
});
test('un Uber ya incluido en un cierre no se borra dejando un saldo congelado incorrecto',async()=>{
  const {db,register}=setup();const first=await register();
  await assert.rejects(deleteUberSubmission({db,documentId:first.id,adminUid:'admin',reason:'Corrección',
    getBalance:async()=>({effectiveCutoffMs:NOW+1})}),error=>error.code==='failed-precondition');
  assert.equal(db.data.has('uber_weekly_closures/'+first.id),true);
});
