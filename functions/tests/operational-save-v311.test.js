'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./operational-fixture');
const {normalizeInput,requestKey,repayment,own}=require('../operational-save');
const engine=require('../period-settlement');
for(const kind of ['cash','digital','expense','debt'])test(`guardado real del manejador ${kind}: confirma documento, propietario y formato`,async()=>{
  const f=fixture(),r=f.request(kind),out=await f.handler(r);
  assert.equal(out.committed,true);assert.equal(out.id,r.data.operationId);assert.equal(out.row.driverUid,r.auth.uid);assert.equal(f.state.records.size,1);
  if(kind!=='cash'){assert.equal(out.row.proofMimeType,'application/pdf');assert.equal(out.row.telegramPhotoMimeType,'image/jpeg');assert.equal(f.state.downloads,2);}
  assert.ok(!('telegramSettlementAfterBalance' in out.row),'No inventa un saldo basado en datos del navegador');
});
test('doble envío concurrente registra un cobro y un solo reintegro de adelanto',async()=>{
 const f=fixture();f.state.records.set('prestamos_operativos/a',{driverUid:'test-driver',type:'cash_advance',remainingAmount:30000,totalDebt:30000,status:'active'});
 const r=f.request('digital',{amount:50000});const [a,b]=await Promise.all([f.handler(r),f.handler(r)]);
 assert.equal(a.id,b.id);assert.equal(f.state.records.size,2);assert.equal(f.state.records.get('prestamos_operativos/a').remainingAmount,7500);
 assert.equal(a.row.advanceRepaymentAmount,22500);assert.equal(f.state.writes,2);
});
test('dos cobros digitales simultáneos no consumen dos veces un mismo saldo de adelanto',async()=>{
 const f=fixture();f.state.records.set('prestamos_operativos/a',{driverUid:'test-driver',type:'cash_advance',remainingAmount:30000,totalDebt:30000,status:'active'});
 const result=await Promise.all([f.handler(f.request('digital',{amount:50000})),f.handler(f.request('digital',{amount:50000}))]);
 assert.equal(result.reduce((n,r)=>n+r.row.advanceRepaymentAmount,0),30000);assert.equal(f.state.records.get('prestamos_operativos/a').remainingAmount,0);
});
test('las deudas 100% nunca se consumen como adelantos del cobro digital',async()=>{
 const f=fixture();const debt=await f.handler(f.request('debt'));const payment=await f.handler(f.request('digital'));
 assert.equal(payment.row.advanceRepaymentAmount,0);assert.equal(f.state.records.get('deudas_choferes/'+debt.id).remainingAmount,50000);
});
test('no toca adelantos de otro chofer ni solicitudes pendientes',async()=>{
 const f=fixture();f.state.records.set('prestamos_operativos/a',{driverUid:'other-driver',createdByUid:'test-driver',type:'cash_advance',remainingAmount:500,status:'active'});
 f.state.records.set('prestamos_operativos/b',{driverUid:'test-driver',type:'cash_advance',remainingAmount:500,status:'pending_admin'});
 const out=await f.handler(f.request('digital'));assert.equal(out.row.advanceRepaymentAmount,0);assert.equal(f.state.writes,1);
});
test('respuesta perdida después de commit se confirma mediante check sin nuevo cobro',async()=>{
 const f=fixture(),r=f.request();f.state.afterCommitFailure=true;await assert.rejects(f.handler(r),/ack lost/);
 const out=await f.handler({...r,data:{action:'check',kind:r.data.kind,operationId:r.data.operationId,fingerprint:r.data.fingerprint}});
 assert.equal(out.committed,true);assert.equal(f.state.records.size,1);assert.equal(f.state.writes,1);
});
test('transacción fallida no descuenta el adelanto ni crea cobro',async()=>{
 const f=fixture(),r=f.request('digital');f.state.records.set('prestamos_operativos/a',{driverUid:'test-driver',type:'cash_advance',remainingAmount:1000,totalDebt:1000,status:'active'});
 f.state.failWrite=true;await assert.rejects(f.handler(r));assert.equal(f.state.records.size,1);assert.equal(f.state.records.get('prestamos_operativos/a').remainingAmount,1000);
 f.state.failWrite=false;await f.handler(r);assert.equal(f.state.records.size,2);assert.equal(f.state.records.get('prestamos_operativos/a').remainingAmount,0);
});
test('reintento no necesita volver a subir evidencia y no sobrescribe campos agregados por Telegram',async()=>{
 const f=fixture(),r=f.request('expense'),first=await f.handler(r);f.state.files.clear();const saved=f.state.records.get(first.collection+'/'+first.id);saved.telegramMessageId=123;
 const again=await f.handler(r);assert.equal(again.row.telegramMessageId,123);assert.equal(f.state.writes,1);assert.equal(f.state.downloads,2);
});
test('repetir ID con importe distinto o huella distinta no cambia el registro',async()=>{
 const f=fixture(),r=f.request();await f.handler(r);
 for(const changes of [{amount:60000},{fingerprint:'sha256_'+'a'.repeat(64)}])await assert.rejects(f.handler({...r,data:{...r.data,...changes}}),e=>e.code==='already-exists');
 assert.equal(f.state.writes,1);
});
test('sin sesión y chofer inactivo no guardan ni recuperan datos',async()=>{
 const f=fixture();await assert.rejects(f.handler({data:{action:'sync'}}),e=>e.code==='unauthenticated');f.state.disabled=true;
 for(const action of ['save','check','sync']){const r=f.request();r.data.action=action;await assert.rejects(f.handler(r),e=>e.code==='permission-denied');}
 assert.equal(f.state.writes,0);
});
test('no confirma un identificador ajeno aunque se conozca la huella',async()=>{
 const f=fixture(),r=f.request();await f.handler(r);await assert.rejects(f.handler({...r,auth:{uid:'other-driver',token:{}}}),e=>e.code==='already-exists');
});
for(const amount of [-1,0,Infinity,NaN,100000001,12.345,'500'])test(`importe inválido ${String(amount)} rechazado sin escrituras`,async()=>{
 const f=fixture();await assert.rejects(f.handler(f.request('cash',{amount})),e=>e.code==='invalid-argument');assert.equal(f.state.writes,0);
});
test('no clasifica combustible como deuda ni multa como gasto compartido',async()=>{
 const f=fixture();for(const [kind,type]of [['debt','combustible'],['expense','multa']])await assert.rejects(f.handler(f.request(kind,{expenseType:type})),e=>e.code==='invalid-argument');
});
test('payload externo no puede cambiar propietario, caja, saldo, régimen o permisos',async()=>{
 const f=fixture(),r=f.request('expense',{driverUid:'other-driver',cashboxRate:0,telegramSettlementAfterBalance:-999999999,admin:true,penaltyEnabled:true});const out=await f.handler(r);
 assert.equal(out.row.driverUid,'test-driver');assert.equal(out.row.expenseResponsibility,'shared');assert.equal(out.row.telegramSettlementAfterBalance,undefined);assert.equal(out.row.admin,undefined);
});
for(const wrong of ['path','url','mime','header','token','missing'])test(`comprobante ${wrong} inválido rechaza sin movimiento`,async()=>{
 const f=fixture(),r=f.request('expense');
 if(wrong==='path')r.data.proofPath='gastos/other-driver/xx.pdf';
 if(wrong==='url')r.data.telegramPhotoUrl='https://example.com/photo.jpg';
 if(wrong==='mime')f.state.files.get(r.data.proofPath).mime='text/html';
 if(wrong==='header')f.state.files.get(r.data.proofPath).bytes=Buffer.from('not a pdf');
 if(wrong==='token')r.data.proofUrl=r.data.proofUrl.replace('local-test-token','another-token');
 if(wrong==='missing')f.state.files.clear();
 await assert.rejects(f.handler(r));assert.equal(f.state.writes,0);
});
test('sin ARCA no consulta ni emite facturas, ARCA activada bloquea este endpoint',async()=>{
 const f=fixture();f.state.options.arcaEnabled=true;await assert.rejects(f.handler(f.request()),e=>e.code==='failed-precondition');assert.equal(f.state.writes,0);
});
test('sincronización fallback devuelve todas las colecciones completas y solo datos propios',async()=>{
 const f=fixture();f.state.records.set('gastos/a',{ownerUid:'test-driver',amount:10});f.state.records.set('gastos/b',{driverUid:'test-driver',uid:'test-driver',amount:20});
 f.state.records.set('gastos/foreign',{driverUid:'other-driver',createdByUid:'test-driver',amount:5000});
 const out=await f.handler({auth:{uid:'test-driver'},data:{action:'sync'}});assert.equal(Object.keys(out.ledger).length,7);assert.deepEqual(out.ledger.gastos.map(r=>r.id).sort(),['a','b']);assert.equal(f.state.writes,0);
});
test('sincronización abortada nunca devuelve un saldo parcial',async()=>{
 const f=fixture();f.state.failRead=true;await assert.rejects(f.handler({auth:{uid:'test-driver'},data:{action:'sync'}}));assert.equal(f.state.writes,0);
});
test('deuda real guardada suma 100% y conserva caja/reparto del ejemplo',async()=>{
 const f=fixture(),out=await f.handler(f.request('debt'));
 const input={records:[{method:'cash',amount:301000},{method:'digital',amount:250000}],expenses:[{amount:124000}]};
 const before=engine.calculate(input),after=engine.calculate({...input,debts:[out.row]});assert.equal(before.balance,-15150);assert.equal(after.balance,34850);
 for(const key of ['cashRemaining','cashBox','driverShare','available','expense','totalDigital'])assert.equal(before[key],after[key]);
 assert.equal(out.row.penaltyEnabled,false);assert.equal(out.row.penaltyDailyRate,0);
});
test('efectivo y digital de 10000 más gasto 2000 conservan la cuenta neta original',async()=>{
 const f=fixture();const a=await f.handler(f.request('cash',{amount:10000})),b=await f.handler(f.request('digital',{amount:10000})),c=await f.handler(f.request('expense',{amount:2000}));
 const model=engine.calculate({records:[a.row,b.row],expenses:[c.row]});assert.equal(model.cashRemaining,8000);assert.equal(model.cashBox,1800);assert.equal(model.driverShare,8100);assert.equal(model.balance,-100);
});

test('la sincronización conserva el ID real aunque un documento antiguo incluya otro id',async()=>{
 const f=fixture();f.state.records.set('gastos/real-id',{id:'wrong-id',driverUid:'test-driver',amount:100});
 const out=await f.handler({auth:{uid:'test-driver'},data:{action:'sync'}});assert.equal(out.ledger.gastos[0].id,'real-id');
});
