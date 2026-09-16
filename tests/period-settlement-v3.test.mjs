import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const E=require('../functions/period-settlement.js');
const server=require('../functions/telegram-billing-balance.js');
const policy=require('../functions/expense-policy.js');
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const declarations=[...source.matchAll(/^(?:async )?function \w+\([^\n]*/gm)].map(m=>source.slice(m.index,source.indexOf('\n}',m.index)+2)).join('\n');
const p=(method,amount,id='p',extra={})=>({id,driverUid:'test-driver',method,paymentMethod:method,amount,createdAtMs:1000,settlementRuleVersion:E.VERSION,...extra});
function frontend(input) {
  return vm.runInNewContext(`${declarations}\n({model:settlementModel(),admin:adminBillingBalanceForDriver({uid:'test-driver'}),box:openCashboxAmount(),receipts:buildUnifiedReceipts()})`,{
    ExploraPeriodSettlement:E,ExploraExpensePolicy:policy,submissionPreviewModels:new Map(),
    payments:input.records||[],expenses:input.expenses||[],closures:input.closures||[],debts:input.debts||[],advances:[],debtPayments:[],uberClosures:input.uberWeeks||[],
    adminPayments:input.records||[],adminExpenses:input.expenses||[],adminAllClosures:input.closures||[],adminDebts:input.debts||[],adminUberClosures:input.uberWeeks||[],money:String
  },{timeout:2000});
}
function same(input,expected) {
  const front=frontend(input),back=server.calculateTeamRealtimeSettlementBalance(input),telegram=server.calculateOpenBillingBalance(input);
  for(const value of [front.model.balance,front.admin,back.balance,telegram.balance])assert.equal(value,expected);
  assert.equal(front.box,back.cashBox);assert.equal(telegram.amountToDriver,Math.max(0,-expected));
  return front;
}
const sample={records:[...[[50000,'637'],[50000,'638'],[100000,'639'],[40000,'640'],[55000,'641'],[6000,'642']].map(([n,id])=>p('cash',n,id)),...[[80000,'643'],[35000,'644'],[60000,'645']].map(([n,id])=>p('digital',n,id))],
  expenses:[4000,40000,40000,40000].map((amount,i)=>({id:'g'+i,driverUid:'test-driver',amount,createdAtMs:2000,receiptFlowVersion:E.VERSION})),
  uberWeeks:[{id:'u',driverUid:'test-driver',grossAmount:75000,cashAmount:0,transferAmount:75000,createdAtMs:2000,verifiedAutomatically:true,settlementWorkflowVersion:'v85_verified_direct',reviewStatus:'completed'}]};
test('Uber histórico se integra al efectivo: un único total digital y saldo coherente',()=>{
 const {model:m}=same(sample,59850);
 for(const [key,value]of Object.entries({cash:376000,expense:124000,cashRemaining:252000,totalDigital:175000,available:427000,cashBox:42700,totalToSplit:384300,driverShare:192150,exploraShare:192150,exploraWithCashbox:234850}))assert.equal(m[key],value,key);
 assert.equal(m.uberCash,75000);assert.equal(m.uberTransfer,0);
});
for(const [cash,digital,expenses,result]of [[10000,0,0,5500],[0,10000,0,-4500],[10000,10000,0,1000],[10000,0,10000,0],[10000,0,30000,-10000],[0,0,10000,-5000],[100000,100000,50000,-17500]])
 test(`saldo compartido cash=${cash}, digital=${digital}, gastos=${expenses}`,()=>same({records:[p('cash',cash),p('digital',digital,'d')],expenses:expenses?[{amount:expenses,driverUid:'test-driver'}]:[]},result));
test('solo operaciones reales, no aprobadas no cuentan; el arreglo original no se ordena ni muta',()=>{
 const rows=[p('cash',200,'z',{createdAtMs:6000}),p('digital',100,'a',{createdAtMs:1000}),p('cash',999,'x',{deleted:true}),p('cash',999,'s',{isSimulated:true})];const copy=JSON.stringify(rows);
 const m=E.calculate({records:rows,uberWeeks:[{amount:999,reviewStatus:'pending_admin_review',settlementWorkflowVersion:'v84_driver_submission_admin_review'}]});
 assert.equal(m.balance,65);assert.equal(JSON.stringify(rows),copy);assert.deepEqual(m.rows.cash.map(r=>r.id),['z']);
});
test('Uber histórico no conserva canal digital: todo el bruto se trata como efectivo normal',()=>{
 const m=E.calculate({uberWeeks:[{grossAmount:100000,cashAmount:25000,transferAmount:75000}]});
 assert.equal(m.gross,100000);assert.equal(m.cash,100000);assert.equal(m.totalDigital,0);assert.equal(m.balance,55000);assert.equal(m.cashBox,10000);
});
test('los gastos pagados por Explora salen de su dinero, no del efectivo del chofer',()=>{
 const m=E.calculate({records:[p('cash',100000)],expenses:[{amount:20000,payerRole:'explora'}]});
 assert.equal(m.available,80000);assert.equal(m.cashRemaining,100000);assert.equal(m.digitalRemaining,-20000);assert.equal(m.balance,64000);
});
test('pagos ya realizados equilibran, sin ingresos ni una segunda caja',()=>{
 const input={records:[...sample.records,p('digital',59850,'payout',{type:'settlement_adjustment',adjustmentDirection:'driver_to_explora',createdAtMs:3000})],expenses:sample.expenses,uberWeeks:sample.uberWeeks};
 const {model:m}=same(input,0);assert.equal(m.gross,551000);assert.equal(m.cashBox,42700);
 same({records:[p('cash',100000),p('digital',55000,'pay',{type:'settlement_adjustment',adjustmentDirection:'driver_to_explora'})]},0);
});
test('préstamo aparte: el digital aplicado al préstamo no se devuelve dos veces',()=>{
 const m=E.calculate({records:[p('digital',100000,'d',{advanceRepaymentAmount:10000})]});assert.equal(m.balance,-35000);assert.equal(m.gross,100000);assert.equal(m.cashBox,10000);
});
test('deuda aceptada incrementa saldo, pendiente no; no genera caja',()=>{
 same({debts:[{type:'admin_debt',driverUid:'test-driver',remainingAmount:2000,driverConfirmationRequired:true,acknowledgedByDriver:true}]},2000);
 same({debts:[{type:'admin_debt',driverUid:'test-driver',remainingAmount:2000,driverConfirmationRequired:true,acknowledgedByDriver:false}]},0);
});
test('cierre histórico on_demand corta; settlement_only no borra movimientos',()=>{
 const records=[p('digital',10000,'old'),p('cash',10000,'new',{createdAtMs:3000})];
 same({records,closures:[{driverUid:'test-driver',closureMode:'on_demand',closureKind:'facturacion',status:'closed',cutoffAtMs:2000}]},5500);
 same({records,closures:[{driverUid:'test-driver',closureMode:'settlement_only',closureKind:'facturacion',status:'completed',cutoffAtMs:2000}]},1000);
});
test('compensación histórica se conserva como apertura; el PDF nuevo no mueve la fecha',()=>{
 const records=[p('digital',10000,'old'),p('cash',100,'anchor',{type:'reimbursement_compensation',settlementAfter:2000,createdAtMs:2000}),p('digital',10000,'new',{createdAtMs:3000,updatedAt:{seconds:4000},receiptPdfPath:'x'})];
 const m=E.calculate({records});assert.equal(m.balance,-2500);assert.equal(m.openingBalance,2000);assert.equal(m.gross,10000);assert.equal(E.rowTime(records[2]),3000);
});
test('centavos exactos: no se pierde un centavo entre Caja y participantes',()=>{
 for(let cents=1;cents<1000;cents++) {
  const m=E.calculate({records:[p('cash',cents/100)]});
  assert.equal(Math.round((m.driverShare+m.exploraShare+m.cashBox)*100),cents);
  assert.equal(Math.round((m.cashRemaining-m.driverShare)*100),Math.round(m.balance*100));
 }
});
test('2.000 escenarios de conservación de fondos y anticipos incrementales',()=>{
 let seed=777;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed%1000000;};
 for(let i=0;i<2000;i++){
  const cash=random()/100,digital=random()/100,expense=random()/100;
  const input={records:[p('cash',cash),p('digital',digital)],expenses:[{amount:expense}]};const m=E.calculate(input);
  assert.equal(Math.round((m.driverShare+m.exploraWithCashbox)*100),Math.round(m.available*100));
  const value=random()/100;for(const kind of ['cash','digital','expense']){
   const after=E.calculate(kind==='expense'?{...input,expenses:[...input.expenses,{amount:value}]}:{...input,records:[...input.records,p(kind,value)]});
   assert.equal(Math.round(E.incremental(m,kind,value)*100),Math.round((after.balance-m.balance)*100),kind);
  }
 }
});
test('nuevo comprobante no inventa movimientos extra de 5% ni reintegros duplicados',()=>{
 const front=frontend({records:[p('cash',10000),p('digital',10000,'d')],expenses:[{id:'g',amount:1000,driverUid:'test-driver',receiptFlowVersion:E.VERSION,createdAtMs:2000}]});
 assert.equal(front.receipts.filter(r=>r.type==='cashbox_receipt').length,0);
 assert.equal(front.receipts.filter(r=>r.type==='expense_reimbursement_receipt').length,0);
});
