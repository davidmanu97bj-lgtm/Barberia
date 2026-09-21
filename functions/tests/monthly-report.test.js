'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildMonthlyReport,monthlyPdf,loadMonthlyReport}=require('../monthly-report');
const memory=require('./memory-firestore');
const now=Date.parse('2026-10-02T12:00:00Z'),date=Date.parse('2026-09-20T12:00:00Z');
const charge=(id,method,value)=>({id,driverUid:'javier',type:method==='cash'?'billing':'payment',method,amount:value,status:'completed',createdAtMs:date,invoiceRequest:{serviceDate:'2026-09-20',origin:'Aeropuerto',destination:'Hotel'}});
test('40% bruto: gastos, deudas, caja y cierres no cambian la base; contrapartidas no duplican el pago',()=>{
  const report=buildMonthlyReport({uid:'javier',month:'2026-09',now,input:{cobros:[charge('cash','cash',600000),charge('digital','digital',400000),{id:'adjustment',amount:100000,type:'settlement_adjustment',createdAtMs:date,closureId:'closure'}],gastos:[{id:'expense',amount:200000,createdAtMs:date}],deudas:[{id:'debt',amount:50000,createdAtMs:date}],cierres:[{id:'closure',status:'completed',settlementAmount:100000,paymentDirection:'explora_to_driver',createdAtMs:date}]}});
  assert.equal(report.totals.gross,1000000);assert.equal(report.totals.participation,400000);assert.equal(report.closedMonth,true);
  assert.equal(report.rows.find(r=>r.id==='adjustment').includedInClosure,true);assert.equal(report.rows.length,6);
  assert.equal(report.recipient.cuit,'20-40411688-7');assert.match(report.invoiceDetail,/40% sobre la facturación bruta/i);
});
test('imputa por servicio, excluye anulados/pendientes y no oculta registros sin fecha',()=>{
  const report=buildMonthlyReport({uid:'javier',month:'2026-09',now,input:{cobros:[{...charge('late','digital',100000),createdAtMs:now},{...charge('old','cash',70000),invoiceRequest:{serviceDate:'2026-08-31'}},{...charge('void','cash',90000),deleted:true},{...charge('pending','cash',1000),status:'pending'},{id:'missing',amount:20}]}});
  assert.equal(report.totals.gross,100000);assert.equal(report.totals.participation,40000);assert.equal(report.issues.length,2);assert.ok(report.rows.find(r=>r.id==='late'));
});
test('deduplica alias del chofer y nunca incorpora los cobros de otro',async()=>{
  const db=memory();db.data.set('billing_records/a',{...charge('a','cash',100),uid:'javier'});db.data.set('billing_records/b',{...charge('b','cash',900),driverUid:'otro'});
  const r=await loadMonthlyReport(db,'javier','2026-09',now);assert.equal(r.totals.gross,100);assert.equal(r.rows.length,1);
});
test('revisión estable por contenido, cambia al corregir importe; PDF multipágina válido',async()=>{
  const input={cobros:Array.from({length:40},(_,i)=>charge('viaje-'+i,'cash',1000))};
  const r=buildMonthlyReport({uid:'javier',month:'2026-09',now,input});
  assert.equal(r.revision,buildMonthlyReport({uid:'javier',month:'2026-09',now:now+1000,input}).revision);
  const pdf=await monthlyPdf(r);assert.equal(pdf.subarray(0,4).toString(),'%PDF');assert.ok(pdf.length>4000);
  input.cobros[0].amount=2000;assert.notEqual(r.revision,buildMonthlyReport({uid:'javier',month:'2026-09',now,input}).revision);
});
