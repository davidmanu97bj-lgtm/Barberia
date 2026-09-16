'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const dbFactory=require('./memory-firestore');
const {deliverTripNotification}=require('../telegram-trip-delivery');
const compact=require('../telegram-compact');
const invoice={status:'authorized',environment:'production',issuer:{pointOfSale:1},number:637};
function setup(){const db=dbFactory(),calls=[],ref=db.collection('telegram_notifications').doc('a');const options={db,ref,paymentId:'a',caption:'Chofer Ana\nMonto $ 50.000',photo:'https://storage.example/photo.jpg',requirePhoto:true,chatId:'-123',now:()=>1000,api:async(method,payload)=>{calls.push({method,payload});return {message_id:42};}};return {db,calls,ref,options,run:over=>deliverTripNotification({...options,...over})};}
test('digital llega como foto real; ARCA posterior edita el pie, nunca sustituye imagen por documento',async()=>{
 const c=setup();await c.run();assert.equal(c.calls[0].method,'sendPhoto');assert.equal(c.calls[0].payload.photo,c.options.photo);
 c.db.data.set('arca_invoices/a',invoice);await c.run();assert.equal(c.calls[1].method,'editMessageCaption');assert.match(c.calls[1].payload.caption,/FC-1-637.pdf/);
 await c.run();assert.equal(c.calls.length,2);assert.equal(c.db.data.get(c.ref.path).attachmentType,'photo');
});
test('ARCA ya autorizada: solo una fotografía, nombre corto en el texto y PDF en app',async()=>{
 const c=setup();c.db.data.set('arca_invoices/a',invoice);await c.run();assert.equal(c.calls.length,1);assert.equal(c.calls[0].method,'sendPhoto');assert.match(c.calls[0].payload.caption,/PDF disponible en Explora/);
});
test('sin foto o error de red no se marca enviado ni se reemplaza por texto',async()=>{
 for(const extra of [{photo:''},{api:async()=>{throw new Error('network');}}]){
  const c=setup();await assert.rejects(c.run(extra));assert.equal(c.db.data.get(c.ref.path).status,'error');assert.equal(c.db.data.get(c.ref.path).telegramMessageId,undefined);assert.equal(c.calls.length,0);
 }
});
test('fallo confirmado y reintento entregan una foto, sin falsa factura ni nuevo movimiento fiscal',async()=>{
 const c=setup();await assert.rejects(c.run({api:async()=>{throw Object.assign(new Error('bad photo'),{telegramStatus:400});}}));await c.run();assert.equal(c.calls.length,1);assert.equal(c.calls[0].method,'sendPhoto');assert.equal(c.db.data.has('arca_invoices/a'),false);
});
test('efectivo sin evidencia digital usa texto; autorización posterior edita el mismo mensaje',async()=>{
 const c=setup();await c.run({photo:'',requirePhoto:false});c.db.data.set('arca_invoices/a',invoice);await c.run({photo:'',requirePhoto:false});
 assert.deepEqual(c.calls.map(c=>c.method),['sendMessage','editMessageText']);
});
test('eventos concurrentes: lease evita dos envíos simultáneos',async()=>{
 const c=setup();let release,ready;const gate=new Promise(r=>release=r),begun=new Promise(r=>ready=r);
 const first=c.run({api:async(...args)=>{ready();await gate;return c.options.api(...args);}});await begun;
 await assert.rejects(c.run(),/BUSY/);release();await first;await c.run();assert.equal(c.calls.length,1);
});
test('no reenvía notificaciones históricas; homologación se identifica como PRUEBA',async()=>{
 const c=setup();c.db.data.set(c.ref.path,{telegramMessageId:7,status:'sent'});await c.run();assert.equal(c.calls.length,0);
 const d=setup();d.db.data.set('arca_invoices/a',{...invoice,environment:'homologation'});await d.run();assert.match(d.calls[0].payload.caption,/PRUEBA/);
});
test('Telegram presenta monto completo y regla neta, no deduce otro 5%',()=>{
 const text=compact.billingSummary({data:{method:'digital'},driverName:'Ana',amount:100000,cash:false,balance:-45000});
 assert.match(text,/100\.000/);assert.match(text,/10% del neto/);assert.doesNotMatch(text,/Caja chica 5%/);
 const expense=compact.expenseSummary({data:{},driverName:'Ana',amount:50000,loadedAmount:50000,recognizedAmount:25000,expenseName:'Nafta',balance:-15150,periodRule:true});
 assert.match(expense,/50\.000/);assert.match(expense,/imagen|comprobante/i);
});
