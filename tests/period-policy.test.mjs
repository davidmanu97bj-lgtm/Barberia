import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const ExploraPeriodPolicy=require('../functions/period-policy.js');
const ExploraExpensePolicy=require('../functions/expense-policy.js');
const {calculateTeamRealtimeSettlementBalance,calculateOpenBillingBalance}=require('../functions/telegram-billing-balance.js');
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const declarations=[...source.matchAll(/^(?:async )?function \w+\([^\n]*/gm)].map(m=>source.slice(m.index,source.indexOf('\n}',m.index)+2)).join('\n');
const base={driverUid:'test-driver',settlementRuleVersion:ExploraPeriodPolicy.VERSION,createdAtMs:1000};
const payment=(method,amount,extra={})=>({...base,id:method,method,paymentMethod:method,amount,...extra});
const expense=(method,amount,expenseType='combustible',extra={})=>({...base,id:method+expenseType,expensePaymentMethod:method,amount,expenseType,receiptFlowVersion:ExploraExpensePolicy.version,...extra});
function compare(input,expected,legacyAnchor=false) {
  const context={ExploraPeriodPolicy,ExploraExpensePolicy,payments:input.records||[],expenses:input.expenses||[],uberClosures:input.uberWeeks||[],closures:input.closures||[],debts:input.debts||[],advances:[],debtPayments:[],adminPayments:input.records||[],adminExpenses:input.expenses||[],adminUberClosures:input.uberWeeks||[],adminAllClosures:input.closures||[],adminDebts:input.debts||[]};
  const actual=vm.runInNewContext(`${declarations}\n[settlementModel().balance,adminBillingBalanceForDriver({uid:'test-driver'})]`,context);
  assert.deepEqual(Array.from(actual),[expected,expected],'chofer y administrador');
  assert.equal(calculateTeamRealtimeSettlementBalance(input).balance,expected,'servidor');
  if(!legacyAnchor)assert.equal(calculateOpenBillingBalance(input).netToDriver,expected?-expected:0,'notificación');
}
test('ejemplo aprobado: netos 300000 y 400000, caja bruta 100000 y multa digital 80000',()=>{
  // The fine is paid by Explora: Digital includes it, then the 100% allocation corrects the equal split.
  compare({records:[payment('cash',400000),payment('digital',600000)],expenses:[expense('cash',100000),expense('digital',200000),expense('digital',80000,'multa')]},130000);
});
test('billetera digital negativa: 100 cobrados y 150 gastados; no se recorta a cero',()=>{
  compare({records:[payment('digital',100)],expenses:[expense('digital',150)]},35);
  compare({records:[payment('digital',100)],expenses:[expense('digital',150,'cubiertas')]},-40);
});
test('multa pagada por Explora genera deuda completa; ya pagada por chofer no vuelve a cobrarse',()=>{
  compare({expenses:[expense('digital',80000,'multa')]},80000);
  compare({expenses:[expense('cash',80000,'multa')]},0);
});
test('gastos 100% de Explora: reconoce lo adelantado por el chofer; propio pago digital no genera deuda ajena',()=>{
  compare({expenses:[expense('cash',20000,'cubiertas')]},-20000);
  compare({expenses:[expense('digital',20000,'cubiertas')]},0);
});
test('10% siempre del bruto y una sola vez: efectivo, digital y Uber',()=>{
  compare({records:[payment('cash',10000)]},6000);
  compare({records:[payment('digital',10000)]},-4000);
  compare({records:[payment('cash',10000),payment('digital',10000)],expenses:[expense('cash',8000)]},-2000);
  compare({uberWeeks:[{...base,amount:10000,grossAmount:10000,cashAmount:10000,transferAmount:0,settlementWorkflowVersion:'v85_verified_direct',verifiedAutomatically:true,reviewStatus:'completed'}]},6000);
});
test('anteriores 5% y reparto antiguo permanecen intactos al mezclarse con nuevos',()=>{
  compare({records:[payment('cash',10000,{id:'old',settlementRuleVersion:'gross_cash_digital_cashbox_5_v1'}),payment('digital',10000)]},6500);
  compare({records:[payment('cash',10000,{id:'legacy',settlementRuleVersion:undefined}),payment('digital',10000)]},1500);
  compare({records:[payment('cash',10000,{id:'anchor',type:'reimbursement_compensation',settlementAfter:7500,createdAtMs:500,settlementRuleVersion:undefined}),payment('digital',10000)]},3500,true);
});
test('correcciones, anulaciones y ajustes no duplican caja chica',()=>{
  compare({records:[payment('cash',12000,{cashboxAmount:1000})]},7200);
  compare({records:[payment('cash',12000,{deleted:true})]},0);
  compare({records:[payment('cash',10000),payment('digital',6000,{type:'settlement_adjustment',adjustmentDirection:'driver_to_explora',settlementRuleVersion:undefined})]},0);
});
