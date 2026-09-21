'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {previousDay,messagesForDay}=require('../telegram-daily-summary');
test('medianoche argentina y reintento pertenecen al día anterior, incluso al cambiar de año',()=>{
  assert.deepEqual(previousDay('2027-01-01T03:00:00Z'),{day:'2026-12-31',start:Date.parse('2026-12-31T03:00:00Z'),end:Date.parse('2027-01-01T03:00:00Z')});
});
test('suma efectivo y digital una sola vez, excluye cierres y anulados e incluye chofer sin cobros',()=>{
  const day=previousDay('2026-09-19T03:00:00Z');
  const drivers=[{id:'j',name:'Javier',aliases:['j','auth-j']},{id:'m',name:'Marcelo',aliases:['m']},{id:'n',name:'Nicolas',aliases:['n']}];
  const row=(id,uid,amount,extra={})=>({id,driverUid:uid,amount,type:'billing',status:'completed',createdAtMs:day.start,...extra});
  const cash=row('cash','auth-j',60000),digital=row('digital','j',40000,{type:'payment'});
  const records=[cash,digital,cash,row('marcelo','m',50000),row('closure','j',18800,{type:'settlement_adjustment'}),row('void','j',500,{deleted:true}),row('pending','j',500,{status:'pending'}),row('tomorrow','j',500,{createdAtMs:day.end})];
  assert.equal(messagesForDay(drivers,records,day)[0],'RESUMEN DEL DÍA · 18/09/2026\n\nJavier hizo: $ 100.000\nMarcelo hizo: $ 50.000\nNicolas: No trabajó');
});
test('divide mensajes largos sin omitir choferes',()=>{
  const drivers=Array.from({length:250},(_,i)=>({id:String(i),name:'Chofer '+i,aliases:[String(i)]}));
  const pages=messagesForDay(drivers,[],previousDay('2026-09-19T03:00:00Z'));
  assert.ok(pages.length>1);assert.ok(pages.every(p=>p.length<4096));assert.equal(pages.join('\n').match(/No trabajó/g).length,250);
});
