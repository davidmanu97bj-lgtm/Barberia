import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MemoryStore} from '../tools/preview/memory-store.mjs';
const require=createRequire(import.meta.url);
const {periodQuote,confirmPeriodClosure}=require('../functions/period-closure.js');
const {VERSION}=require('../functions/period-policy.js');
const {calculateTeamRealtimeSettlementBalance,calculateOpenBillingBalance}=require('../functions/telegram-billing-balance.js');
const uid='driver-test';
const payment=(method,amount)=>({driverUid:uid,uid,method,paymentMethod:method,amount,createdAtMs:1000,settlementRuleVersion:VERSION});
async function setup(method='cash') {
  const db=new MemoryStore({'billing_records/source':payment(method,10000)});
  const quote=await periodQuote({db,uid});
  const input={quoteId:quote.quoteId,proofPath:`cierres_semanales/period/${uid}/${quote.quoteId}/prueba.png`};
  const proofMetadata=async()=>({size:100,contentType:'image/png',generation:'1',url:'https://example.test/proof.png'});
  return {db,quote,input,proofMetadata};
}
test('cierre y ajuste atómicos, comprobante asociado, doble toque y reintento sin duplicados',async()=>{
  const context=await setup();
  const results=await Promise.all(Array.from({length:8},()=>confirmPeriodClosure({...context,uid})));
  assert.equal(new Set(results.map(r=>r.id)).size,1);assert.equal(results.filter(r=>!r.alreadyClosed).length,1);
  assert.equal([...context.db.data.keys()].filter(p=>p.startsWith('cierres_semanales/')).length,1);
  const close=context.db.data.get('cierres_semanales/'+results[0].id),adjustment=context.db.data.get('billing_records/'+results[0].id);
  assert.equal(close.status,'completed');assert.equal(close.proofPath,context.input.proofPath);assert.equal(adjustment.closureId,results[0].id);assert.equal(close.proofGeneration,'1');
  assert.equal((await periodQuote({...context,uid})).amount,0);
  assert.equal((await confirmPeriodClosure({...context,uid})).alreadyClosed,true);
});
test('Explora paga: comprobante recibido, ajuste inverso y saldo cero',async()=>{
  const context=await setup('digital');assert.equal(context.quote.balance,-4000);
  const result=await confirmPeriodClosure({...context,uid});assert.equal(result.direction,'explora_to_driver');
  assert.equal((await periodQuote({...context,uid})).balance,0);
});
test('cancelar/consultar no escribe; comprobante ausente, vacío, ajeno, grande o inválido no confirma',async()=>{
  const context=await setup(),before=JSON.stringify([...context.db.data]);
  await periodQuote({...context,uid});assert.equal(JSON.stringify([...context.db.data]),before);
  for(const metadata of [null,{size:0,contentType:'image/png',url:'x'},{size:16*1024*1024,contentType:'image/png',url:'x'},{size:30,contentType:'text/html',url:'x'}]) {
    await assert.rejects(confirmPeriodClosure({...context,uid,proofMetadata:async()=>metadata}));assert.equal(context.db.data.size,1);
  }
  await assert.rejects(confirmPeriodClosure({...context,uid:'someone-else'}));
  await assert.rejects(confirmPeriodClosure({...context,uid,proofMetadata:async()=>{throw Error('Carga fallida');}}));
  assert.equal(context.db.data.size,1);
});
test('si cambia un importe, aparece un movimiento nuevo o se cierra en otro dispositivo, exige revisar',async()=>{
  for(const change of ['edit','new']) {
    const context=await setup();
    context.db.data.set('billing_records/'+(change==='edit'?'source':'new'),payment('cash',12000));
    await assert.rejects(confirmPeriodClosure({...context,uid}),/movimientos cambiaron/);
    assert.equal([...context.db.data.keys()].some(p=>p.startsWith('cierres_semanales')),false);
  }
});
test('consulta incluye aliases históricos sin duplicar, preserva saldo anterior y negativos',async()=>{
  const db=new MemoryStore({'billing_records/a':{...payment('cash',10000),settlementRuleVersion:'gross_cash_digital_cashbox_5_v1'},'billing_records/b':{...payment('digital',100),driverUid:undefined,uid,choferUid:uid},'gastos/a':{driverUid:uid,amount:150,createdAtMs:1100,expensePaymentMethod:'digital',expenseType:'combustible',receiptFlowVersion:'gross_expense_policy_v3',settlementRuleVersion:VERSION}});
  const quote=await periodQuote({db,uid});assert.equal(quote.balance,10535);assert.equal(quote.summary.netDigital,-50);assert.equal(quote.summary.previousBalance,10500);assert.equal(quote.summary.cashbox,10);
});

test('las deudas incluidas quedan pagadas, sin recargos futuros ni descuento duplicado, en ambas direcciones',async()=>{
  for(const [method,debtAmount] of [['cash',1000],['digital',1000],['digital',7000]]) {
    const context=await setup(method);
    context.db.data.set('deudas_choferes/debt',{driverUid:uid,type:'admin_debt',amount:debtAmount,remainingAmount:debtAmount,status:'active'});
    context.quote=await periodQuote({...context,uid});
    context.input={quoteId:context.quote.quoteId,proofPath:`cierres_semanales/period/${uid}/${context.quote.quoteId}/prueba.png`};
    const result=await confirmPeriodClosure({...context,uid});
    assert.equal(context.db.data.get('deudas_choferes/debt').status,'paid');
    assert.equal(context.db.data.get('deudas_choferes/debt').remainingAmount,0);
    assert.equal((await periodQuote({...context,uid})).balance,0);
    const rows=prefix=>[...context.db.data].filter(([path])=>path.startsWith(prefix+'/')).map(([path,row])=>({...row,id:path.split('/')[1]}));
    const input={records:rows('billing_records'),debts:rows('deudas_choferes'),closures:rows('cierres_semanales')};
    assert.equal(calculateTeamRealtimeSettlementBalance(input).balance,0);
    assert.equal(calculateOpenBillingBalance(input).netToDriver,0);
    assert.equal(context.db.data.get('billing_records/'+result.id).amount,context.quote.amount);
    assert.equal((await confirmPeriodClosure({...context,uid})).alreadyClosed,true);
  }
});

test('un acuse de Telegram no invalida un cierre sin cambios financieros',async()=>{
  const context=await setup();
  context.db.data.get('billing_records/source').telegramSentAt='later';
  assert.equal((await periodQuote({...context,uid})).quoteId,context.quote.quoteId);
  await confirmPeriodClosure({...context,uid});
});
