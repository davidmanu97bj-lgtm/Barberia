import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {statementHtml} from '../period-statement.js';
const require=createRequire(import.meta.url), E=require('../functions/period-settlement.js'), P=require('../functions/expense-policy.js');
const balances=require('../functions/telegram-billing-balance.js');
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const rules=fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
function declaration(name) {const a=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.ok(a>=0,name);return source.slice(a,source.indexOf('\n}',a)+2);}
function load(ctx,...names){vm.runInContext(names.map(declaration).join('\n'),ctx);}
const uid='test-driver',now=Date.UTC(2026,8,15,12);
const debt=(value=50000,extra={})=>({id:'debt1',driverUid:uid,type:'driver_debt_100',debtRuleVersion:P.debtVersion,debtResponsibility:'driver',registrationOrigin:'driver_expense_debt_menu',createdByRole:'driver',driverConfirmationRequired:false,acknowledgedByDriver:true,amount:value,remainingAmount:value,debtCategory:'multa',debtLabel:'Multa',createdAtMs:now,status:'active',...extra});
const sample={records:[{id:'cash',driverUid:uid,amount:301000,method:'cash',createdAtMs:now},{id:'digital',driverUid:uid,amount:175000,method:'digital',createdAtMs:now}],expenses:[{amount:124000,driverUid:uid,createdAtMs:now}],uberWeeks:[{transferAmount:75000,cashAmount:0,driverUid:uid,createdAtMs:now}]};
const invariantKeys=['cash','digital','gross','expense','available','cashRemaining','digitalRemaining','cashBox','driverShare','exploraShare','totalToSplit'];
for(const concept of ['choque','prestamo','multa','ruptura']) test(`${concept}: deuda 100% se suma completa al saldo con Uber histórico tratado como efectivo, sin tocar caja/reparto`,()=>{
 const input={...sample,debts:[debt(50000,{debtCategory:concept})]}, before=E.calculate(sample), after=E.calculate(input);
 assert.equal(before.balance,59850);assert.equal(after.balance,109850);assert.equal(after.driverDebtTotal,50000);
 for(const key of invariantKeys)assert.equal(after[key],before[key],key);
 for(const method of ['calculateOpenBillingBalance','calculateTeamRealtimeSettlementBalance'])assert.equal(balances[method](input).balance,109850);
});
test('catálogo: exactamente dos caminos; no ofrece multa ni préstamos como gasto compartido',()=>{
 assert.deepEqual(P.entryGroups.map(g=>g.id),['shared','debt']);
 const ids=P.entryGroups.flatMap(g=>g.types.map(t=>t.id));assert.equal(new Set(ids).size,ids.length);
 assert.equal(ids.length,P.types.length);
 for(const t of P.entryGroups[0].types)assert.equal(P.entryKind(t.id),'shared');
 for(const t of P.entryGroups[1].types)assert.equal(P.entryKind(t.id),'debt');
 assert.equal(P.entryKind('inventado'),'');
});
test('no transforma automáticamente multas históricas guardadas como gastos ni duplica adelantos',()=>{
 const old={amount:40000,expenseType:'multa',receiptFlowVersion:E.VERSION};
 assert.equal(E.calculate({expenses:[old]}).expense,40000);assert.equal(E.calculate({expenses:[old]}).driverDebtTotal,0);
 assert.equal(E.calculate({debts:[{amount:100000,type:'cash_advance'}]}).driverDebtTotal,0);
 assert.equal(E.calculate({debts:[{amount:100000,type:'uber_weekly'}]}).driverDebtTotal,0);
});
test('aceptación, saldo pendiente, pago total, baja y anulación recalculan sin importes negativos',()=>{
 for(const extra of [{acknowledgedByDriver:false},{deleted:true},{status:'paid'},{status:'anulado'},{remainingAmount:0},{remainingAmount:-1},{isSimulated:true}])assert.equal(E.calculate({debts:[debt(50000,extra)]}).driverDebtTotal,0,JSON.stringify(extra));
 const partial=E.calculate({debts:[debt(50000,{remainingAmount:20000})]});assert.equal(partial.balance,20000);assert.equal(partial.rows.debts[0].statementAmount,20000);
 const a={type:'admin_debt',amount:3000,driverConfirmationRequired:true};
 assert.equal(E.calculate({debts:[a]}).driverDebtTotal,0);
 assert.equal(E.calculate({debts:[{...a,acknowledgedByDriver:true}]}).driverDebtTotal,3000);
});
test('un cierre no perdona deudas anteriores; pagos en cuenta se descuentan solo una vez',()=>{
 const older=debt(50000,{createdAtMs:now-20000});
 const input={debts:[older],closures:[{closureMode:'on_demand',closureKind:'facturacion',cutoffAtMs:now-10000,status:'closed'}],records:[{amount:10000,method:'digital',createdAtMs:now,type:'admin_billing_settlement_payment'}]};
 const m=E.calculate(input);assert.equal(m.balance,40000);assert.equal(m.driverDebtTotal,50000);assert.equal(m.gross,0);assert.equal(m.driverPaid,10000);
});
test('2.000 escenarios: cada deuda se suma exacta y no entra al 10% ni al 50/50',()=>{
 let seed=19;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return (seed%1000000)/100;};
 for(let i=0;i<2000;i++){
  const data={records:[{amount:random(),method:'cash'},{amount:random(),method:'digital'}],expenses:[{amount:random()}]},amount=random();
  const a=E.calculate(data),b=E.calculate({...data,debts:[debt(amount)]});
  assert.equal(Math.round((b.balance-a.balance)*100),Math.round(amount*100));
  assert.equal(E.incremental(a,'debt',amount),amount);
  for(const key of invariantKeys)assert.equal(a[key],b[key],key);
 }
});
test('extracto muestra deudas ordenadas, PDFs cortos y total antes del resultado sin reordenar los demás grupos',()=>{
 globalThis.ExploraPeriodSettlement=E;globalThis.ExploraExpensePolicy=P;
 const records=[debt(50000,{id:'uno',proofPath:'deudas/test-driver/debt/D-uno.pdf'}),debt(20000,{id:'dos',debtLabel:'Choque',createdAtMs:now-20000})];
 const input={...sample,debts:records},copy=JSON.stringify(input),model=E.calculate(input);
 const out=statementHtml({model,driverName:'Prueba <script>'});
 const names=['cash','expense','digital','debt','result','distribution','adjustments'];
 const positions=names.map(name=>out.indexOf(`data-statement-section="${name}"`));assert.ok(positions.every((n,i)=>n>=0 && (!i || n>positions[i-1])));
 assert.match(out,/Total deudas chofer 100%/);assert.match(out,/70\.000/);assert.match(out,/data-document-collection="deudas_choferes"/);assert.match(out,/D-uno.pdf/);
 assert.ok(out.indexOf('Multa')<out.indexOf('Choque'));assert.doesNotMatch(out,/<script>/);assert.equal(JSON.stringify(input),copy);
 assert.equal(model.balance,129850);
});
test('efectivo, digital y gastos no contienen tarjetas de saldo ni un paso vacío',()=>{
 const charges=html.slice(html.indexOf('<div id="chargeModal"'),html.indexOf('<div id="debtModal"'));
 const expenses=html.slice(html.indexOf('<div id="expenseModal"'),html.indexOf('<div id="operationPreviewModal"'));
 for(const markup of [charges,expenses])assert.doesNotMatch(markup,/Movimientos? (?:en|de) tu cuenta|chargeAccountPreview|expenseGrossPreview|expenseFinalBalance|expenseRefund/);
 assert.doesNotMatch(charges,/data-charge-step="4"/);assert.doesNotMatch(expenses,/data-expense-step="3"/);
 let mode='digital';const c=vm.createContext({$:()=>({value:mode})});load(c,'chargeSteps');assert.deepEqual([...c.chargeSteps()],[0,1,2,3]);mode='cash';assert.deepEqual([...c.chargeSteps()],[0,1,3]);
});
// The three save regression cases now execute the authenticated server handler;
// previous versions only tested a successful setDoc mock in the browser.
const {fixture}=require('../functions/tests/operational-fixture.js');
test('guardar deuda: una sola colección, PDF + JPEG, 100% reconocido por el chofer sin crear gastos/cobros',async()=>{
 const f=fixture(),r=f.request('debt'),out=await f.handler(r),data=out.row;
 assert.equal(f.state.records.size,1);assert.equal(out.collection,'deudas_choferes');
 assert.equal(data.acknowledgedByDriver,true);assert.equal(data.registeredByAdmin,false);
 assert.equal(data.penaltyEnabled,false);assert.equal(data.penaltyDailyRate,0);assert.equal(data.amount,50000);assert.equal(data.remainingAmount,50000);
 assert.equal(E.calculate({...sample,debts:[data]}).balance,109850);
 assert.equal(data.proofMimeType,'application/pdf');assert.match(data.proofPath,/\.pdf$/);assert.match(data.telegramPhotoPath,/\.jpg$/);
});
test('doble toque, respuesta perdida y reintento conservan un ID sin crear movimientos extra',async()=>{
 const f=fixture(),r=f.request('debt');await Promise.all([f.handler(r),f.handler(r)]);assert.equal(f.state.writes,1);assert.equal(f.state.records.size,1);
 const g=fixture(),request=g.request('debt');g.state.afterCommitFailure=true;await assert.rejects(g.handler(request));
 const out=await g.handler({...request,data:{...request.data,action:'check'}});assert.equal(out.committed,true);assert.equal(g.state.writes,1);
});
test('la creación no acepta importe negativo, infinito o tipo de gasto compartido',async()=>{
 for(const invalid of [{amount:-1},{amount:Infinity},{amount:100000001},{expenseType:'combustible'}]){
  const f=fixture();await assert.rejects(f.handler(f.request('debt',invalid)));assert.equal(f.state.writes,0);
 }
});
test('reglas: nueva deuda es del usuario activo, importe fijo y reintentos no permiten perdonar ni duplicar deuda',()=>{
 const section=rules.slice(rules.indexOf('match /deudas_choferes/'),rules.indexOf('match /uber_weekly_closures/'));
 assert.match(section,/isSelfDebtCreate\(\)/);assert.match(section,/d\.driverUid == uid\(\)/);assert.match(section,/d\.remainingAmount == d\.amount/);assert.match(section,/d\.registeredByAdmin == false/);assert.match(section,/d\.acknowledgedByDriver == true/);assert.match(section,/selfDebtIdempotentRetry\(\)/);
 assert.match(section,/affectedKeys\(\)\.hasOnly\(\['createdAt'\]\)/);
 assert.match(section,/debtRuleVersion.*!= 'driver_debt_100_v1' && driverDebtPaymentUpdate\(\)/);
 assert.match(section,/allow delete: if isAdmin\(\)/);
});
test('el lector normaliza cambios, pagos y anulaciones y el extracto usa el saldo recibido',()=>{
 const c=vm.createContext({recordProofUrl:()=>'',recordProofPath:()=>'',recordDayKey:()=>'',ExploraPeriodSettlement:E});load(c,'normalizeDebtRecord');
 for(const [raw,expected]of [[debt(),50000],[debt(50000,{remainingAmount:15000}),15000],[debt(50000,{status:'anulado'}),0],[debt(50000,{remainingAmount:0,status:'paid'}),0]]) {
  const item=c.normalizeDebtRecord(raw.id,raw);assert.equal(E.calculate({debts:[item]}).balance,expected);
 }
 assert.match(source,/collectionName:ROOT_COLLECTIONS\.debts,[\s\S]{0,100}normalizer:normalizeDebtRecord/);
 assert.match(source,/assign:rows => \{ debts = rows\.filter/);
});
