import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calculateTeamRealtimeSettlementBalance, calculateOpenBillingBalance } = require('../functions/telegram-billing-balance.js');
const ExploraExpensePolicy = require('../functions/expense-policy.js');
const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
// Run the shipped, top-level functions; omit Firebase initialization and UI listeners.
// In app.js top-level function closing braces occupy their own unindented line.
const declarations = [...appSource.matchAll(/^(?:async )?function \w+\([^\n]*/gm)].map(match => {
  const end = appSource.indexOf('\n}', match.index);
  assert.ok(end > match.index, `Unclosed function: ${match[0]}`);
  return appSource.slice(match.index, end + 2);
}).join('\n');
const rule = 'gross_cash_digital_cashbox_5_v1';
const payment = (method, amount, modern = true, extra = {}) => ({
  id:`${method}-${amount}`, method, paymentMethod:method, amount, createdAtMs:1000,
  driverUid:'test-driver', ...(modern ? {settlementRuleVersion:rule} : {}), ...extra
});
function frontend(input) {
  return vm.runInNewContext(`${declarations}\n({balance:settlementModel().balance, admin:adminBillingBalanceForDriver({uid:'test-driver'}), cashbox:openCashboxAmount(), preview:previewDefinition('digital',10000).delta, receipts:buildUnifiedReceipts()})`, {
    ExploraExpensePolicy, payments:input.records || [], closures:input.closures || [], expenses:input.expenses || [], debts:[], advances:[], debtPayments:[], uberClosures:input.uberWeeks || [],
    adminPayments:input.records || [], adminAllClosures:input.closures || [], adminExpenses:input.expenses || [], adminDebts:[], adminUberClosures:input.uberWeeks || [], money:value => `$${value}`
  }, {timeout:1000});
}
function assertBalance(input, expected, {legacyAnchor = false} = {}) {
  const front = frontend(input);
  assert.equal(front.balance, expected, 'conductor');
  assert.equal(front.admin, expected, 'administrador');
  assert.equal(calculateTeamRealtimeSettlementBalance(input).balance, expected, 'saldo del servidor');
  if (!legacyAnchor) assert.equal(calculateOpenBillingBalance(input).netToDriver, expected ? -expected : 0, 'notificación');
  return front;
}

test('Uber nuevo suma el total más caja chica; anteriores y pendientes conservan su tratamiento', () => {
  const record = {id:'uber-test',driverUid:'test-driver',grossAmount:100000,amount:100000,cashAmount:100000,transferAmount:0,createdAtMs:3000,settlementWorkflowVersion:'v84_driver_submission_admin_review',settlementRuleVersion:'uber_gross_cash_cashbox_5_v1',adminConfirmed:true,reviewStatus:'approved',telegramSettlementBeforeBalance:0,telegramSettlementAfterBalance:105000};
  const front = assertBalance({uberWeeks:[record]},105000);
  const direct = {...record,id:'uber-direct',settlementWorkflowVersion:'v85_verified_direct',verifiedAutomatically:true,adminConfirmed:false,reviewStatus:'completed'};
  const directFront = assertBalance({uberWeeks:[direct]},105000);
  assert.equal(directFront.receipts.length,2);
  assert.equal(directFront.receipts[0].type,'cashbox_receipt');
  assertBalance({uberWeeks:[{...direct,verifiedAutomatically:false}]},0);
  assertBalance({uberWeeks:[{...direct,deleted:true}]},0);
  assert.equal(front.cashbox,5000);
  assert.equal(front.receipts.length,2);
  assert.equal(front.receipts[0].type,'cashbox_receipt');
  const snapshots = vm.runInNewContext(`${declarations}\nreceipts.map(receiptBalanceSnapshot)`,{receipts:front.receipts});
  assert.deepEqual(JSON.parse(JSON.stringify(snapshots)),[{before:100000,after:105000,movementImpact:5000},{before:0,after:100000,movementImpact:100000}]);
  assertBalance({uberWeeks:[{...record,adminConfirmed:false,reviewStatus:'pending_admin_review'}]},0);
  assertBalance({uberWeeks:[{...record,deleted:true}]},0);
  const old = {...record,id:'old',settlementRuleVersion:undefined};
  assertBalance({uberWeeks:[old]},55000);
  assertBalance({uberWeeks:[old,record]},160000);
  assertBalance({uberWeeks:[record],records:[payment('cash',100,false,{type:'reimbursement_compensation',settlementAfter:-10000,createdAtMs:2000})]},95000,{legacyAnchor:true});
});

test('los nuevos cobros aplican el bruto completo y el 5% por separado', () => {
  assertBalance({records:[payment('cash',10000)]}, 10500);
  const digital = assertBalance({records:[payment('digital',10000)]}, -9500);
  assert.equal(digital.cashbox, 500);
  assert.equal(digital.preview, -9500);
  assert.equal(digital.receipts.length, 2);
  assert.equal(digital.receipts.find(row => row.type === 'cashbox_receipt').amount, 500);
  assertBalance({records:[payment('cash',10000),payment('digital',10000)]}, 1000);
});

test('los cobros anteriores retienen su regla incluso al mezclarlos con nuevos', () => {
  const old = payment('digital',10000,false);
  assertBalance({records:[old]}, -5000);
  const mixed = assertBalance({records:[old,payment('digital',10000,true,{id:'new'})]}, -14500);
  assert.equal(mixed.cashbox, 500);
  assert.equal(mixed.receipts.length, 3);
  assert.equal(old.settlementRuleVersion, undefined);
});

test('el 50% de los gastos reduce deuda y puede invertir quién paga', () => {
  const records = [payment('cash',10000)];
  assertBalance({records, expenses:[{amount:10000,driverUid:'test-driver',createdAtMs:2000,autoApplyToBilling:true}]}, 5500);
  assertBalance({records, expenses:[{amount:30000,driverUid:'test-driver',createdAtMs:2000,autoApplyToBilling:true}]}, -4500);
});

test('un cierre pagado permanece saldado y el cobro siguiente usa la regla nueva', () => {
  const records = [payment('digital',10000,false), payment('cash',5000,false,{id:'paid',type:'settlement_adjustment',adjustmentDirection:'explora_to_driver',createdAtMs:2000})];
  const closures = [{driverUid:'test-driver',closureKind:'facturacion',closureMode:'settlement_only',status:'completed',paidAmountTotal:5000,createdAtMs:2000}];
  assertBalance({records,closures}, 0);
  assertBalance({records:[...records,payment('digital',10000,true,{id:'new',createdAtMs:3000})],closures}, -9500);
});

test('respeta las bases de migración y las fotografías históricas al aplicar la nueva regla', () => {
  const records = [payment('digital',20000,false), payment('digital',10000,true,{id:'new',createdAtMs:3000})];
  const closures = [{driverUid:'test-driver',closureKind:'facturacion',closureMode:'on_demand',status:'closed',cutoffAtMs:2000}];
  assertBalance({records,closures}, -9500, {legacyAnchor:true});
  assertBalance({records:[...records,payment('cash',100,false,{id:'anchor',type:'reimbursement_compensation',settlementAfter:2000,createdAtMs:2000})]}, -7500, {legacyAnchor:true});
});

test('correcciones y bajas recalculan desde el bruto sin duplicar la caja chica', () => {
  assertBalance({records:[payment('digital',20000,true,{cashboxAmount:500,principalMovementAmount:-10000})]}, -19000);
  assertBalance({records:[payment('digital',20000,true,{deleted:true})]}, 0);
  assertBalance({records:[payment('digital',10000,true,{excludeFromCashbox:true})]}, -10000);
});

test('el ejemplo del usuario produce 0 → 100000 → 105000 → 5000 → 10000', () => {
  const input = {records:[payment('cash',100000,true,{telegramSettlementBeforeBalance:0,telegramSettlementAfterBalance:105000}),payment('digital',100000,true,{createdAtMs:2000,telegramSettlementBeforeBalance:105000,telegramSettlementAfterBalance:10000})]};
  const result = assertBalance(input,10000);
  const ordered = [...result.receipts].sort((a,b)=>a.createdAtMs-b.createdAtMs || b._sortPriority-a._sortPriority);
  const timeline=vm.runInNewContext(`${declarations}\nreceipts.map(receiptBalanceSnapshot)`,{receipts:ordered});
  assert.deepEqual(JSON.parse(JSON.stringify(timeline)),[
    {before:0,after:100000,movementImpact:100000},
    {before:100000,after:105000,movementImpact:5000},
    {before:105000,after:5000,movementImpact:-100000},
    {before:5000,after:10000,movementImpact:5000}
  ]);
});

test('gasto 50000 y reintegro 25000 muestran dos pasos y compensan solo 25000', () => {
  const input = {records:[payment('cash',100000),payment('digital',100000)],expenses:[{id:'expense',amount:50000,driverUid:'test-driver',createdAtMs:2000,autoApplyToBilling:true,receiptFlowVersion:'gross_expense_reimbursement_50_v1',telegramSettlementBeforeBalance:10000,telegramSettlementAfterBalance:-15000}]};
  const result=assertBalance(input,-15000);
  const rows=result.receipts.filter(row=>row.method==='expense');
  const timeline=vm.runInNewContext(`${declarations}\nreceipts.map(receiptBalanceSnapshot)`,{receipts:rows});
  assert.deepEqual(JSON.parse(JSON.stringify(timeline)),[
    {before:-40000,after:-15000,movementImpact:25000},
    {before:10000,after:-40000,movementImpact:-50000}
  ]);
  assert.equal(timeline[0].after,result.balance,'el Después de la primera tarjeta coincide con el resultado actual');
});

test('más recientes muestra primero caja o reintegro y más antiguos muestra primero su operación', () => {
  const result = frontend({records:[payment('cash',100000),payment('digital',100000)],expenses:[{id:'expense',amount:50000,createdAtMs:1000,receiptFlowVersion:'gross_expense_reimbursement_50_v1'}]});
  for (const order of ['newest','oldest']) {
    const rows=vm.runInNewContext(`${declarations}\nsortUnifiedReceipts(receipts,order)`,{receipts:result.receipts,order});
    assert.equal(rows.length,6);
    for (let i=0;i<rows.length;i+=2) {
      assert.equal(rows[i]._sortPriority,order === 'newest' ? 1 : 2);
      assert.equal(rows[i+1]._sortPriority,order === 'newest' ? 2 : 1);
      assert.equal(rows[i]._receiptGroupKey,rows[i+1]._receiptGroupKey);
    }
    const page=vm.runInNewContext(`${declarations}\nvisibleReceiptRows(receipts,3)`,{receipts:rows});
    assert.equal(page.length,4,'la paginación mantiene completa la última pareja');
  }
});

test('Gestión mueve el 100% sin ingresos de viajes, caja chica ni borrador ARCA', () => {
  const {prepareInvoiceDraft} = require('../functions/arca-invoice-draft.js');
  for (const [direction,method,expected] of [['driver_to_explora','digital',-100000],['explora_to_driver','cash',100000]]) {
    const row=payment(method,100000,false,{type:'settlement_adjustment',operationType:'settlement_adjustment',internalManagement:true,internalSettlementAdjustment:true,affectsBillingSettlement:true,adjustmentDirection:direction,telegramSettlementBeforeBalance:0,telegramSettlementAfterBalance:expected});
    const result=assertBalance({records:[row]},expected);
    assert.equal(result.cashbox,0);
    assert.equal(result.receipts.length,1);
    assert.equal(prepareInvoiceDraft(row,'internal'),null);
  }
});

test('gasto nuevo suma 100% y reintegro resta 50%, conservando gastos anteriores', () => {
  const expense={id:'v2',amount:50000,driverUid:'test-driver',createdAtMs:2000,autoApplyToBilling:true,receiptFlowVersion:'gross_expense_driver_debit_50_v2',telegramSettlementBeforeBalance:0,telegramSettlementAfterBalance:25000};
  const result=assertBalance({expenses:[expense]},25000);
  const timeline=vm.runInNewContext(`${declarations}\nreceipts.map(receiptBalanceSnapshot)`,{receipts:result.receipts});
  assert.deepEqual(JSON.parse(JSON.stringify(timeline)),[{before:50000,after:25000,movementImpact:-25000},{before:0,after:50000,movementImpact:50000}]);
  assertBalance({expenses:[expense,{id:'old',amount:20000,driverUid:'test-driver',createdAtMs:1000,autoApplyToBilling:true,receiptFlowVersion:'gross_expense_reimbursement_50_v1'}]},15000);
  assertBalance({expenses:[{...expense,amount:60000}]},30000);
  assertBalance({expenses:[{...expense,deleted:true}]},0);
});

for (const type of ExploraExpensePolicy.types) {
  test(`gasto ${type.label}: bruto completo y reintegro ${type.refundRate * 100}% en todos los saldos`, () => {
    const expected = 50000 * (1 - type.refundRate);
    const expense = {id:'policy-expense',expenseType:type.id,amount:50000,driverUid:'test-driver',createdAtMs:3000,
      receiptFlowVersion:ExploraExpensePolicy.version,telegramSettlementBeforeBalance:0,telegramSettlementAfterBalance:expected};
    const front=assertBalance({expenses:[expense]},expected);
    assert.equal(front.receipts.length,type.refundRate ? 2 : 1);
    const timeline=vm.runInNewContext(`${declarations}\nreceipts.map(receiptBalanceSnapshot)`,{receipts:front.receipts,ExploraExpensePolicy});
    assert.deepEqual(JSON.parse(JSON.stringify(timeline)),[
      ...(type.refundRate ? [{before:50000,after:expected,movementImpact:-50000*type.refundRate}] : []),
      {before:0,after:50000,movementImpact:50000}
    ]);
    assert.equal(timeline[0].after,front.balance);
    assertBalance({expenses:[{...expense,amount:60000}]},60000*(1-type.refundRate));
    assertBalance({expenses:[{...expense,deleted:true}]},0);
    // A stored rate cannot override the category's approved share.
    assertBalance({expenses:[{...expense,reimbursementRate:0.75,sharedRate:0.25}]},expected);
    assertBalance({expenses:[expense],records:[payment('digital',40000)]},expected-38000);
    const compensation=vm.runInNewContext(`${declarations}\nsettlementModel().expenseReimbursement`,{
      ExploraExpensePolicy,payments:[],closures:[],expenses:[expense],debts:[],advances:[],debtPayments:[],uberClosures:[]
    });
    assert.equal(compensation,0,'el reintegro ya aplicado no se puede cobrar otra vez');
  });
}

test('mezclar políticas de gasto conserva los históricos y los cierres saldados', () => {
  const expense=(id,amount,version,expenseType,createdAtMs)=>({id,amount,receiptFlowVersion:version,expenseType,createdAtMs,driverUid:'test-driver',autoApplyToBilling:true});
  const old=expense('old',20000,'gross_expense_reimbursement_50_v1','multa',1000);
  const v2=expense('v2',20000,'gross_expense_driver_debit_50_v2','cubiertas',2000);
  const driver=expense('driver',50000,ExploraExpensePolicy.version,'multa',4000);
  const explora=expense('explora',50000,ExploraExpensePolicy.version,'cubiertas',5000);
  const shared=expense('shared',50000,ExploraExpensePolicy.version,'patente',6000);
  assertBalance({expenses:[old,v2,driver,explora,shared]},75000);
  assertBalance({expenses:[old,v2,driver,explora,shared],records:[payment('cash',100,false,{id:'anchor',type:'reimbursement_compensation',settlementAfter:10000,createdAtMs:3000})]},85000,{legacyAnchor:true});
});
