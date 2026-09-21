'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const compact=require('../telegram-compact');
const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
function handler(name,extra={}) {
  const sent=[];
  const match=source.match(new RegExp(`exports\\.${name} = onDocument(?:Created|Written)\\([\\s\\S]*?}, (async event => \\{[\\s\\S]*?\\n\\})\\);`));
  assert.ok(match, name);
  const context={telegramCompact:compact,telegramNamedData:async data=>({...data,driverName:data.driverName||'Javier'}),
    telegramSafeText:value=>String(value||''),telegramDriverName:data=>data.driverName,
    telegramAmount:data=>Number(data.amount||data.totalAmount||0),telegramOperationNotificationKey:(_,id)=>id,
    telegramDirectPhotoUrl:data=>data.proofUrl,telegramDateTimeLines:()=>['Fecha: 17/09/2026','Hora: 10:15'],
    expensePolicy:require('../expense-policy'),telegramExpenseType:data=>data.expenseType,
    isAdminDriverDebt:require('../telegram-driver-debt').isAdminDriverDebt,
    closureTelegramAllowed:()=>true,closureTelegramUpdateChanged:()=>false,
    telegramProcessNotification:async data=>{sent.push(data);return {sent:true};},...extra};
  return {sent,run:vm.runInNewContext(`(${match[1]})`,context)};
}
const snapshot=data=>({exists:Boolean(data),data:()=>data,id:'operation'});
const event=(after,before)=>({id:'event',params:{docId:'operation'},data:{...snapshot(after),after:snapshot(after),before:snapshot(before)}});
test('deuda grupal: un aviso con foto, importe por chofer, total y destinatarios; sin avisos individuales',async()=>{
  const data={action:'admin_group_debt_completed',createdByName:'David',amountPerDriver:150000,detail:'Canon',drivers:[{name:'Javier'},{name:'Marcelo'}],proofUrl:'https://example.test/grupo.jpg'};
  const h=handler('notifyGroupDebtTelegram');await h.run(event(data));
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].requirePhoto,true);
  assert.match(h.sent[0].caption,/David Deuda 100% grupal:/);assert.match(h.sent[0].caption,/Monto por chofer:.*150\.000/);assert.match(h.sent[0].caption,/Total del grupo:.*300\.000/);assert.match(h.sent[0].caption,/Javier\n• Marcelo/);
  const individual=handler('notifyAdminDriverDebtTelegramV1');await individual.run(event({createdByRole:'admin',amount:150000,suppressTelegram:true}));assert.equal(individual.sent.length,0);
});
test('gasto del chofer y gasto digital de David conservan comprobante, monto y fecha',async()=>{
  const h=handler('notifyExpenseV2');
  await h.run(event({driverName:'Javier',amount:100000,expenseType:'combustible',expensePaymentMethod:'cash',proofUrl:'https://example.test/gasto.jpg'}));
  await h.run(event({driverName:'Javier',createdByName:'David',amount:40000,detail:'canon',expensePaymentMethod:'digital',proofUrl:'https://example.test/canon.pdf'}));
  assert.equal(h.sent.length,2);
  assert.match(h.sent[0].caption,/Javier Gasto:/);assert.match(h.sent[0].caption,/Total cargado del gasto:.*100\.000/);
  assert.match(h.sent[0].caption,/Fecha: 17\/09\/2026\nHora: 10:15/);
  assert.equal(h.sent[0].data.proofUrl,'https://example.test/gasto.jpg');
  assert.match(h.sent[1].caption,/David Gasto digital:\nDetalle: canon\nMonto:.*40\.000\nAl chofer: Javier/);
  assert.equal(h.sent[1].data.proofUrl,'https://example.test/canon.pdf');
});
test('la deuda avisa al cargarla y no vuelve a avisar al aceptar o pagar',async()=>{
  const h=handler('notifyAdminDriverDebtTelegramV1');
  const debt={driverName:'Javier',createdByName:'David',createdByRole:'admin',amount:50000,proofUrl:'https://example.test/multa.jpg',driverConfirmationRequired:true};
  await h.run(event(debt));
  await h.run(event({...debt,acknowledgedByDriver:true},debt));
  await h.run(event({...debt,status:'paid'},debt));
  assert.equal(h.sent.length,1);assert.match(h.sent[0].caption,/David Deuda 100%: Javier\nDetalle: Deuda del chofer\nMonto:.*50\.000/);
  assert.match(h.sent[0].caption,/pendiente de aceptación/);assert.equal(h.sent[0].requirePhoto,true);
});
test('un cierre indica quién pagó y resuelve el nombre del chofer',async()=>{
  const h=handler('notifyClosureTelegramGroupV1');
  for(const paymentDirection of ['explora_to_driver','driver_to_explora']) {
    await h.run(event({driverUid:'javier',status:'completed',paymentDirection,settlementAmount:18800,proofUrl:'https://example.test/cierre.jpg'}));
  }
  assert.match(h.sent[0].caption,/Javier pidió un cierre\nQuién pagó: Explora pagó\nMonto:.*18\.800/);
  assert.match(h.sent[1].caption,/Quién pagó: Javier pagó/);
  assert.ok(h.sent.every(row=>row.requirePhoto));
});
test('el ajuste asociado al cierre no genera un segundo aviso',async()=>{
  const h=handler('notifyBillingRecordV2',{telegramInternalBillingMovement:()=>true});
  await h.run(event({notificationHandledByClosure:true,closureId:'period_1',internalSettlementAdjustment:true}));
  assert.equal(h.sent.length,0);
});
test('digital y efectivo muestran ubicación e importe completos',()=>{
  for(const cash of [true,false]) {
    const text=compact.billingSummary({data:{invoiceRequest:{origin:'Aeropuerto',destination:'Centro'}},driverName:'Javier',amount:70000,cash});
    assert.match(text,new RegExp(`^Javier cobro ${cash?'efectivo':'digital'}`));
    assert.match(text,/Detalle: Aeropuerto → Centro\nTotal cargado del cobro:.*70\.000/);
  }
});
