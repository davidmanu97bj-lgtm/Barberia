'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const expensePolicy=require('../expense-policy');const {isAdminDriverDebt}=require('../telegram-driver-debt');
const source=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');const a=source.indexOf('exports.notifyAdminDriverDebtTelegramV1 ='),b=source.indexOf('\n});',a)+4;
const debt={type:'driver_debt_100',debtRuleVersion:'driver_debt_100_v1',registrationOrigin:'driver_expense_debt_menu',debtResponsibility:'driver',driverUid:'driver',acknowledgedByDriver:true,amount:50000,detail:'Multa',telegramPhotoUrl:'https://photo',telegramSettlementAfterBalance:999999};
const snap=data=>data?{exists:true,data:()=>data,id:'id'}:{exists:false};
const event=(before,after)=>({data:{before:snap(before),after:snap(after)},params:{docId:'id'},id:'event'});
function harness(){const calls=[];const ctx={exports:{},onDocumentWritten:(_opts,handler)=>handler,TELEGRAM_FUNCTION_REGION:'us-central1',deploymentOptions:{telegramEnabled:true},TELEGRAM_BOT_TOKEN:{},TELEGRAM_CHAT_ID:{},expensePolicy,isAdminDriverDebt,telegramAmount:d=>d.amount,telegramDriverUid:d=>d.driverUid,teamRealtimeBalanceForDriver:async()=>({balance:34850}),telegramSafeText:String,telegramProcessNotification:async job=>{calls.push(job);return job;},telegramSimpleFinancialText:obj=>JSON.stringify(obj),telegramDirectPhotoUrl:d=>d.telegramPhotoUrl};vm.runInNewContext(source.slice(a,b),ctx);return {handler:ctx.exports.notifyAdminDriverDebtTelegramV1,calls};}
test('deuda del chofer: creación aceptada envía imagen y saldo calculado, no el snapshot del cliente',async()=>{
 const h=harness();await h.handler(event(null,debt));assert.equal(h.calls.length,1);assert.equal(h.calls[0].requirePhoto,true);assert.equal(h.calls[0].strictPhoto,true);assert.equal(h.calls[0].notificationKey,'id_registered');assert.equal(h.calls[0].sourceCollection,'deudas_choferes');assert.equal(h.calls[0].data.telegramSettlementAfterBalance,34850);assert.match(h.calls[0].caption,/DEUDA CHOFER 100%/);assert.match(h.calls[0].caption,/No es gasto compartido/);
});
test('no reenvía deuda al convertir PDF, pagar, corregir metadatos o eliminar',async()=>{
 const h=harness();for(const after of [{...debt,receiptPdfPath:'new'},{...debt,remainingAmount:100},{...debt,updatedAtMs:123},null])await h.handler(event(debt,after));assert.equal(h.calls.length,0);
});
test('deudas administrativas siguen esperando aceptación; reintentos conservan la clave',async()=>{
 const h=harness(),pending={amount:50000,driverUid:'driver',createdByRole:'admin',acknowledgedByDriver:false};
 await h.handler(event(null,pending));assert.equal(h.calls.length,0);
 await h.handler(event(pending,{...pending,acknowledgedByDriver:true}));assert.equal(h.calls.length,1);assert.equal(h.calls[0].notificationKey,'id_accepted');
 await h.handler(event(pending,{...pending,acknowledgedByDriver:true}));assert.equal(h.calls[1].notificationKey,h.calls[0].notificationKey);
});
test('una deuda del nuevo circuito queda excluida del interés automático histórico',async()=>{
 const start=source.indexOf('exports.applyDailyDebtPenalties ='),end=source.indexOf('\n});',start)+4;
 let writes=0;const row={...debt,amount:50000,createdAtMs:Date.UTC(2020,0,1)};
 const context={exports:{},onSchedule:(_opts,fn)=>fn,Date,expensePolicy,debtPenaltyDayKey:()=> '2026-09-15',db:{collection:()=>({limit:()=>({get:async()=>({docs:[{data:()=>row}]})})}),batch:()=>({commit:async()=>{},set:()=>writes++})},debtPenaltyStatusIsActive:()=>{throw Error('No debe aplicar intereses a deuda 100%.');}};
 vm.runInNewContext(source.slice(start,end),context);await context.exports.applyDailyDebtPenalties();assert.equal(writes,0);
});
test('foto de deuda fallida queda para reintento, nunca se declara enviada como texto',async()=>{
 const start=source.indexOf('async function telegramProcessNotification('),end=source.indexOf('\n}\n',start)+2;const statuses=[];
 const context={deploymentOptions:{telegramEnabled:true},telegramClaimNotification:async()=>({claimed:true,ref:{set:async p=>statuses.push(p.status)}}),telegramResolvePhotoUrl:async()=>{throw Error('Foto no descargada');},telegramSafeText:String,telegramSendText:async()=>{throw Error('No debe enviar texto solo');},FieldValue:{serverTimestamp:()=>0},console:{warn(){}},Date};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 await assert.rejects(()=>context.telegramProcessNotification({kind:'admin_driver_debt_accepted',data:debt,requirePhoto:true,strictPhoto:true}),/Foto no descargada/);assert.deepEqual(statuses,['error']);
});
