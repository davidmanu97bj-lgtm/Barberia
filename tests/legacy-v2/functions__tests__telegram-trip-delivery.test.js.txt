'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const memoryDb=require('./memory-firestore');
const {deliverTripNotification}=require('../telegram-trip-delivery');
const compact=require('../telegram-compact');
const fs=require('node:fs'),vm=require('node:vm');
const invoice={status:'authorized',environment:'production',number:123,issuer:{pointOfSale:2}};
test('Telegram informa el porcentaje de reintegro y omite el reintegro para gastos del chofer',()=>{
  for (const refundRate of [0,0.5,1]) {
    const message=compact.expenseSummary({driverName:'Ana',amount:50000,recognized:50000*refundRate,refundRate,balance:50000*(1-refundRate),detail:'Gasto de prueba'});
    assert.match(message,/🔴 Gasto:.*50\.000/);
    if (refundRate) assert.match(message,new RegExp('🟢 Reintegro '+refundRate*100+'%:'));
    else { assert.doesNotMatch(message,/🟢/); assert.match(message,/100% chofer · Sin reintegro/); }
    assert.doesNotMatch(message,/Total con caja/);
  }
});
function setup() {
  const db=memoryDb(),calls=[],ref=db.collection('notifications').doc('billing_a');
  const api=async(method,payload,options)=>{calls.push({method,payload,options});return {message_id:42};};
  let pdfCalls=0;
  const options={db,ref,paymentId:'a',caption:'💵 Cobro en efectivo\n👤 Chofer\n\nChofer debe: $ 105.000',
    photo:'https://example.test/proof.jpg',chatId:'-100',api,now:()=>1000,
    invoicePdf:async()=>{pdfCalls++;return Buffer.from('%PDF-test');}};
  return {db,ref,calls,options,run:changes=>deliverTripNotification({...options,...changes}),get pdfCalls(){return pdfCalls;}};
}
function content(call) {return call.options?.multipart ? JSON.parse(call.payload.get('rich_message')) : call.payload.rich_message;}
test('resúmenes: bruto y caja, gestión sin caja, gasto y reintegro, saldo con las dos etiquetas',()=>{
  const data={settlementRuleVersion:'gross_cash_digital_cashbox_5_v1',invoiceRequest:{origin:'Iguazú',destination:'Cataratas'}};
  const cash=compact.billingSummary({data,driverName:'Ana',amount:100000,cash:true,balance:105000});
  const digital=compact.billingSummary({data,driverName:'Ana',amount:100000,cash:false,balance:10000});
  assert.match(cash,/Iguazú → Cataratas/);assert.match(cash,/Caja chica 5%:.*5\.000/);
  assert.match(digital,/Caja chica 5%:.*5\.000/);assert.match(digital,/Chofer debe:.*10\.000/);
  for (const message of [cash,digital,compact.uberSummary({data:{amount:100000},driverName:'Ana',balance:105000})]) assert.doesNotMatch(message,/Total con caja/);
  const expense=compact.expenseSummary({driverName:'Ana',amount:50000,recognized:25000,balance:-25000,detail:'Combustible'});
  assert.match(expense,/🔴 Gasto:.*50\.000/);assert.match(expense,/🟢 Reintegro:.*25\.000/);assert.match(expense,/Explora debe:.*25\.000/);
  for(const paying of [true,false]) {
    const msg=compact.managementSummary({driverName:'Ana',amount:20000,paying,balance:paying ? -10000 : 10000});
    assert.match(msg,paying ? /Pago a Explora/ : /Cobro a Explora/);
    assert.doesNotMatch(msg,/Caja|ARCA|AFIP|Impacto/);
  }
  assert.doesNotMatch(compact.uberSummary({data:{amount:100000,weekLabel:'7–14 sept'},driverName:'Ana',balance:105000}),/aprob|pendiente|proyectad/i);
  assert.equal(compact.balanceLine(NaN),'Saldo no disponible');
});
test('el PDF está al final del mismo mensaje, con nombre corto; los nombres del chofer son texto literal',()=>{
  const rich=compact.richMessage('💵 Cobro\n👤 <b>Juan & Ana</b>\n\nChofer debe: $ 105.000',{photo:'photo',document:'file'});
  assert.equal(rich.blocks.at(-1).type,'document');assert.equal(rich.blocks.at(-2).type,'photo');
  assert.ok(rich.blocks[0].text.includes('👤 <b>Juan & Ana</b>'));
  assert.equal(compact.invoiceFilename(invoice),'FC-2-123.pdf');
  assert.equal(compact.invoiceFilename({...invoice,environment:'homologation'}),'PRUEBA-FC-2-123.pdf');
});
test('el cobro avisa pendiente y al autorizar ARCA se adjunta el PDF editando el mismo mensaje una sola vez',async()=>{
  const ctx=setup();await ctx.run();
  assert.equal(ctx.calls[0].method,'sendRichMessage');assert.match(JSON.stringify(content(ctx.calls[0])),/Factura ARCA pendiente/);
  // A pending invoice may still have a caption saved by the previous release.
  ctx.db.data.get(ctx.ref.path).caption += '\nTotal con caja: $ 105.000';
  ctx.db.data.set('arca_invoices/a',invoice);
  await ctx.run({caption:'otro saldo'});await ctx.run();
  assert.equal(ctx.calls.length,2);assert.equal(ctx.pdfCalls,1);
  const call=ctx.calls[1];assert.equal(call.method,'editMessageText');assert.equal(call.payload.get('message_id'),'42');
  assert.equal(call.payload.get('invoice').name,'FC-2-123.pdf');
  assert.equal(content(call).blocks.at(-1).type,'document');
  assert.match(JSON.stringify(content(call)),/105\.000/);assert.doesNotMatch(JSON.stringify(content(call)),/otro saldo|pendiente|Total con caja/);
});
test('ARCA autorizada antes del aviso: un solo envío con PDF; no emite ni reemite facturas',async()=>{
  const ctx=setup();ctx.db.data.set('arca_invoices/a',invoice);
  await ctx.run();await ctx.run();assert.equal(ctx.calls.length,1);assert.equal(ctx.calls[0].method,'sendRichMessage');
  assert.equal(content(ctx.calls[0]).blocks.at(-1).type,'document');assert.deepEqual(ctx.db.data.get('arca_invoices/a'),invoice);
});
test('eventos concurrentes conservan un aviso y la autorización reintenta al liberarse el envío',async()=>{
  const ctx=setup();let release,started;
  const startedPromise=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  const first=ctx.run({api:async(...args)=>{started();await gate;return ctx.options.api(...args);}});
  await startedPromise;ctx.db.data.set('arca_invoices/a',invoice);
  await assert.rejects(ctx.run(),/TELEGRAM_NOTIFICATION_BUSY/);
  release();await first;await ctx.run();
  assert.equal(ctx.calls.length,2);assert.equal(ctx.calls[1].method,'editMessageText');
});
test('fallo al generar PDF conserva el aviso y el reintento añade el adjunto sin otro mensaje',async()=>{
  const ctx=setup();ctx.db.data.set('arca_invoices/a',invoice);
  await assert.rejects(ctx.run({invoicePdf:async()=>{throw Error('PDF failed');}}),/PDF failed/);
  assert.equal(ctx.db.data.get(ctx.ref.path).telegramMessageId,42);
  await ctx.run();assert.equal(ctx.calls.length,2);assert.equal(ctx.calls[1].method,'editMessageText');
  assert.equal(ctx.db.data.get(ctx.ref.path).invoiceAttached,true);
});
test('rechazo de foto permite entregar PDF; fallos de red no generan un segundo envío inmediato',async()=>{
  const ctx=setup();ctx.db.data.set('arca_invoices/a',invoice);let attempts=0;
  await ctx.run({api:async(...args)=>{if(!attempts++)throw Object.assign(Error('Wrong photo URL'),{telegramStatus:400});return ctx.options.api(...args);}});
  assert.equal(attempts,2);assert.equal(content(ctx.calls[0]).blocks.some(block=>block.type==='photo'),false);
  const other=setup();let failures=0;
  await assert.rejects(other.run({api:async()=>{failures++;throw Error('network');}}),/network/);
  assert.equal(failures,1);assert.equal(other.db.data.get(other.ref.path).status,'error');
});
test('comprobantes sin autorización y homologación no se presentan como facturas de producción',async()=>{
  for(const row of [{...invoice,status:'review'},{...invoice,status:'rejected'},{...invoice,environment:'homologation'}]) {
    const ctx=setup();ctx.db.data.set('arca_invoices/a',row);await ctx.run();
    assert.equal(ctx.pdfCalls,0);assert.equal(content(ctx.calls[0]).blocks.some(block=>block.type==='document'),false);
  }
  const ctx=setup();ctx.db.data.set(ctx.ref.path,{status:'sent',telegramMessageId:7});
  ctx.db.data.set('arca_invoices/a',invoice);await ctx.run();assert.equal(ctx.calls.length,0);
  ctx.db.data.set(ctx.ref.path,{status:'processing',updatedAtMs:900});
  await assert.rejects(ctx.run(),/TELEGRAM_NOTIFICATION_BUSY/);assert.equal(ctx.calls.length,0);
});
test('los eventos reales de Gestión, aunque afectan facturación, llegan al resumen interno con foto',async()=>{
  const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
  const declaration=name=>{
    const start=source.indexOf(`function ${name}(`);
    return source.slice(start,source.indexOf('\n}',start)+2);
  };
  const handler=source.match(/exports\.notifyBillingRecordV2 = onDocumentCreated\([\s\S]*?}, (async event => \{[\s\S]*?\n\})\);/)[1];
  const sent=[];
  const callback=vm.runInNewContext(`${declaration('telegramInternalBillingMovement')}\n${declaration('telegramInternalBillingText')}\n(${handler})`,{
    normalized:value=>String(value || '').toLowerCase(),telegramCompact:compact,
    telegramSafeText:value=>String(value || ''),telegramDriverName:data=>data.driverName,
    telegramAmount:data=>data.amount,telegramDriverUid:data=>data.driverUid,
    telegramOperationNotificationKey:(_,id)=>id,telegramDirectPhotoUrl:data=>data.proofUrl,
    isDriverBillingSettlementPayment:require('../telegram-billing-balance').isDriverBillingSettlementPayment,
    telegramProcessNotification:async payload=>sent.push(payload)
  });
  for(const direction of ['driver_to_explora','explora_to_driver']) {
    const data={type:'settlement_adjustment',affectsBillingSettlement:true,internalSettlementAdjustment:true,
      sourceModule:'gestion',adjustmentDirection:direction,method:direction==='driver_to_explora' ? 'digital' : 'cash',
      amount:20000,driverName:'Ana',driverUid:'a',proofUrl:'https://example.test/proof.jpg',telegramSettlementAfterBalance:10000};
    await callback({params:{docId:direction},data:{data:()=>data}});
  }
  assert.equal(sent.length,2);assert.match(sent[0].caption,/Pago a Explora/);assert.match(sent[1].caption,/Cobro a Explora/);
  for(const payload of sent) {assert.equal(payload.requirePhoto,true);assert.doesNotMatch(payload.caption,/Caja|ARCA|CIERRE/);}
});
