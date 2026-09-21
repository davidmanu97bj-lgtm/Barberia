import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryStore} from '../tools/preview/memory-store.mjs';
import {periodBreakdown} from '../period-ui.js';
const require=createRequire(import.meta.url);
const {migrateOpeningBalance}=require('../functions/balance-migration');
const {periodQuote,confirmPeriodClosure}=require('../functions/period-closure');
const {VERSION}=require('../functions/period-policy');
const {calculateOpenBillingBalance}=require('../functions/telegram-billing-balance');
const uid='migration-test';
test('migración conserva ambas direcciones, deudas previas y nuevos cobros; cierre deja saldo cero',async()=>{
 for(const method of ['cash','digital']) {
  const original={driverUid:uid,type:'billing',method,amount:100000,createdAtMs:1000,status:'completed'};
  const debt={driverUid:uid,type:'admin_debt',amount:10000,remainingAmount:10000,status:'active'};
  const db=new MemoryStore({'billing_records/old':original,'deudas_choferes/old':debt});
  const before=await periodQuote({db,uid});
  const options={db,uid,actorUid:'admin',expectedBalance:before.balance,now:()=>2000};
  const migrated=await migrateOpeningBalance(options);
  assert.equal(migrated.balanceAfter,before.balance);
  assert.deepEqual(db.data.get('billing_records/old'),original);
  assert.deepEqual(db.data.get('deudas_choferes/old'),debt);
  assert.equal((await migrateOpeningBalance(options)).alreadyMigrated,true);
  const after=await periodQuote({db,uid});
  const ledger=()=>({records:[...db.data].filter(([p])=>p.startsWith('billing_records/')).map(([p,d])=>({...d,id:p.split('/')[1]})),debts:[...db.data].filter(([p])=>p.startsWith('deudas_choferes/')).map(([,d])=>d)});
  assert.equal(calculateOpenBillingBalance(ledger()).netToDriver,-before.balance);
  assert.equal(periodBreakdown(after).debtTotal,before.balance);
  assert.equal(after.summary.gross,0);assert.equal(after.summary.cashbox,0);
  db.data.set('billing_records/new',{...original,id:'new',amount:2000,method:'cash',settlementRuleVersion:VERSION,createdAtMs:3000});
  const current=await periodQuote({db,uid});
  assert.equal(current.balance,before.balance+1200);
  assert.equal(current.summary.gross,2000);
  await confirmPeriodClosure({db,uid,input:{quoteId:current.quoteId,proofPath:`cierres_semanales/period/${uid}/${current.quoteId}/proof.png`},proofMetadata:async()=>({size:100,contentType:'image/png',url:'https://example.test/proof.png'}),now:4000});
  assert.equal((await periodQuote({db,uid})).balance,0);
  assert.equal(calculateOpenBillingBalance(ledger()).netToDriver,0);
 }
});
test('saldo cambiado o fecha futura cancela la migración sin escrituras',async()=>{
 const db=new MemoryStore({'billing_records/old':{driverUid:uid,method:'cash',amount:100,createdAtMs:1000}});
 for(const options of [{expectedBalance:999,now:()=>2000},{expectedBalance:55,now:()=>999}]) {
  await assert.rejects(migrateOpeningBalance({db,uid,actorUid:'admin',...options}));
  assert.equal(db.data.size,1);
 }
});
