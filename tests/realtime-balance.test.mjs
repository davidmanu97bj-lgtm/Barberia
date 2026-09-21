import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const periodPolicy=createRequire(import.meta.url)('../functions/period-policy.js');

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function load(ctx, ...names) {
  vm.runInContext(names.map(declaration).join('\n'), ctx);
}
const createLoad = vm.runInNewContext(`(${declaration('createDashboardLoad')})`);
const row = data => ({id:data.id, data:() => data});

test('el importe visible y accesible cambia al valor exacto, sin cifras intermedias ni layout forzado', () => {
  let formatters = 0;
  const element = {dataset:{moneyCurrent:'0'}, setAttribute(name,value) { this[name]=value; },
    get offsetWidth() { throw Error('No debe forzar layout'); }};
  const ctx = vm.createContext({$:()=>element, Intl:{NumberFormat:function(...args) {
    formatters++;return new Intl.NumberFormat(...args);
  }}});
  const start = source.indexOf('const moneyFormatter =');
  vm.runInContext(source.slice(start,source.indexOf('const moneyInputFormatter',start)), ctx);
  load(ctx,'moneyForElement','setMoney');
  for (const amount of [105000,10000,35000,0,193000]) {
    ctx.setMoney('balance',amount);
    assert.equal(element.textContent,new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(amount));
    assert.equal(element['aria-label'],element.textContent);
    assert.equal(Number(element.dataset.moneyCurrent),amount);
  }
  element.dataset.moneyFormat='signed';ctx.setMoney(element,-5000);
  assert.match(element.textContent,/−.*5\.000/);
  assert.equal(formatters,1,'reutiliza el formateador para todos los importes');
});

test('un cambio entre mil movimientos normaliza uno; corrección, baja y reconexión conservan el saldo', () => {
  const user={uid:'driver'}, dashboardLoad=createLoad(['gastos']);
  let next, normalized=0, rows;
  const ctx=vm.createContext({auth:{currentUser:user},dashboardLoad,ownedQuery:()=>({}),
    onSnapshot:(_q,_opts,callback)=>{next=callback;return()=>{};},console,
    recordTimestampMs:item=>item.time,scheduleDashboardRender(){},renderDriverLoadState(){}});
  load(ctx,'subscribeOwnedRecords');
  ctx.subscribeOwnedRecords(user,{collectionName:'gastos',normalizer:(id,data)=>{normalized++;return{id,...data};},assign:value=>rows=value});
  next({docs:[],docChanges:()=>[],metadata:{fromCache:true}});
  assert.equal(dashboardLoad.complete(),false);
  const docs=Array.from({length:1000},(_,i)=>row({id:String(i),time:i,amount:100}));
  next({docs,docChanges:()=>docs.map(doc=>({type:'added',doc})),metadata:{fromCache:false}});
  assert.equal(normalized,1000);assert.equal(rows.length,1000);
  const corrected=row({id:'10',time:1001,amount:200});
  const emit=(changes,metadata={fromCache:false})=>next({
    get docs(){throw Error('Un cambio no debe recorrer todos los documentos');},docChanges:()=>changes,metadata
  });
  emit([{type:'modified',doc:corrected}]);
  assert.equal(normalized,1001);assert.equal(rows[0].amount,200);
  assert.equal(rows.reduce((sum,item)=>sum+item.amount,0),100100);
  emit([],{fromCache:true});assert.equal(rows.length,1000);assert.equal(normalized,1001);
  emit([{type:'removed',doc:corrected}]);assert.equal(rows.length,999);assert.equal(normalized,1001);
  emit([{type:'added',doc:corrected}]);assert.equal(rows.length,1000);assert.equal(normalized,1002);
  emit([]);assert.equal(rows.length,1000,'el acuse de recibo no duplica movimientos');
});

test('saldo e historial se dibujan juntos al sincronizar listeners sin esperar al frame', () => {
  let frame, rendered=0, balance=0, receipts=0;
  const ctx=vm.createContext({dashboardRenderFrame:null,dashboardRenderJobs:new Set(),
    window:{requestAnimationFrame:callback=>{frame=callback;return 1;},cancelAnimationFrame(){}},
    render:()=>{rendered++;assert.equal(balance,105000);assert.equal(receipts,2);}});
  load(ctx,'scheduleDashboardRender','flushDashboardRender','cancelDashboardRender');
  balance=105000;ctx.scheduleDashboardRender();receipts=2;ctx.scheduleDashboardRender();
  assert.equal(rendered,0);ctx.flushDashboardRender();assert.equal(rendered,1);
  frame();assert.equal(rendered,1,'el frame cancelado no repite el trabajo');
  ctx.scheduleDashboardRender();ctx.cancelDashboardRender();frame();assert.equal(rendered,1);
});

test('volver a la app o recuperar conexión dibuja el estado recibido sin abrir nuevos listeners', () => {
  let user={uid:'a'},admin=false;
  const calls=[],document={hidden:true};
  const ctx=vm.createContext({document,auth:{get currentUser(){return user;}},isAdminProfile:()=>admin,
    render:()=>calls.push('driver'),renderTeamRealtimeList:()=>calls.push('team'),
    renderAdminDashboardUpdates:()=>calls.push('admin'),dashboardRenderFrame:null,dashboardRenderJobs:new Set(),
    window:{requestAnimationFrame:()=>1,cancelAnimationFrame(){}}});
  load(ctx,'scheduleDashboardRender','flushDashboardRender','resumeDashboard');
  ctx.resumeDashboard();assert.deepEqual(calls,[]);
  document.hidden=false;ctx.resumeDashboard();assert.deepEqual(calls,['driver','team']);
  admin=true;ctx.resumeDashboard();assert.deepEqual(calls,['driver','team','admin','team']);
  user=null;ctx.resumeDashboard();assert.equal(calls.length,4);
});

test('un alta pendiente muestra Guardando y una pérdida de conexión conserva el saldo con aviso', () => {
  const state=createLoad(['payments']);state.update('payments',false);
  const nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{},classList:{add(){}},setAttribute(){}});return nodes.get(id);};
  const navigator={onLine:true};
  const ctx=vm.createContext({dashboardLoad:state,navigator,$,document:{querySelectorAll:()=>[]}});
  load(ctx,'renderDriverLoadState');
  assert.equal(ctx.renderDriverLoadState(),true);assert.equal($('syncStatus').textContent,'En tiempo real');
  state.update('payments',false,false,true);ctx.renderDriverLoadState();assert.equal($('syncStatus').textContent,'Guardando…');
  navigator.onLine=false;assert.equal(ctx.renderDriverLoadState(),true);assert.equal($('syncStatus').textContent,'Sin conexión');
  navigator.onLine=true;state.update('payments',false,false,false);ctx.renderDriverLoadState();assert.equal($('syncStatus').textContent,'En tiempo real');
});

for (const [kind,preview,ids,delta] of [
  ['expense','renderExpensePreview',['expenseGrossPreview','expenseRefundPreview'],50000],
  ['uber','renderUberAccountPreview',['uberPrincipalPreview','uberCashboxPreview'],105000]
]) test(`${kind}: el impacto no se vuelve a sumar al recibir el alta, pero sí refresca otros cambios antes de guardar`, () => {
  let balance=0;
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{value:'100000',dataset:{},classList:{toggle(){},add(){}},textContent:'',innerHTML:''});return nodes.get(id);};
  $('chargeMode').value='cash';
  const ctx=vm.createContext({$,activeSubmissionLocks:new Set(),submissionPreviewBalances:new Map(),
    settlementModel:()=>({balance}),scheduleDashboardRender(){},parseMoneyInput:Number,parseUberAmount:Number,
    normalizedSettlementBalance:value=>value,money:String,signedMoney:String,escapeHtml:String,
    settlementPreviewCopy:value=>({label:String(value)}),receiptBalanceLabel:String,managementDirection:'driver_to_explora',
    ExploraExpensePolicy:{find:()=>({refundRate:0.5})},ExploraPeriodPolicy:periodPolicy,document:{querySelectorAll:()=>[]}});
  load(ctx,'acquireSubmissionLock','releaseSubmissionLock','captureSubmissionBalance','previewSettlementBalance',preview);
  ctx[preview]();const first=ids.map(id=>$(id).innerHTML);
  balance=200;ctx[preview]();assert.notDeepEqual(ids.map(id=>$(id).innerHTML),first);
  assert.equal(ctx.acquireSubmissionLock(kind),true);assert.equal(ctx.acquireSubmissionLock(kind),false);
  balance=300;ctx.captureSubmissionBalance(kind);ctx[preview]();const submitted=ids.map(id=>$(id).innerHTML);
  balance+=delta;ctx[preview]();assert.deepEqual(ids.map(id=>$(id).innerHTML),submitted,'la operación que llega no se añade otra vez en el modal');
  ctx.releaseSubmissionLock(kind);ctx[preview]();assert.notDeepEqual(ids.map(id=>$(id).innerHTML),submitted,'si falla, el siguiente intento parte del saldo más reciente');
});

test('después del guardado cierra y muestra el saldo recibido sin un temporizador adicional', () => {
  let hidden=false,rendered=0,scrolled=false;
  const ctx=vm.createContext({$:()=>({classList:{add:()=>hidden=true}}),
    scheduleDashboardRender(){},flushDashboardRender(){assert.equal(hidden,true);rendered++;},
    window:{scrollTo:()=>scrolled=true,setTimeout(){throw Error('Espera artificial');}}});
  load(ctx,'closeModalAndGoTop');ctx.closeModalAndGoTop('chargeModal');
  assert.equal(hidden,true);assert.equal(rendered,1);assert.equal(scrolled,true);
});

test('un comprobante local sin acuse del servidor nunca se anuncia como confirmado', async () => {
  const snapshot=(metadata)=>({exists:()=>true,data:()=>({idempotencyKey:'id',submissionFingerprint:'fp'}),metadata});
  let serverReads=0,confirmed=false;
  const ctx=vm.createContext({getDoc:async()=>snapshot({fromCache:true,hasPendingWrites:true}),
    getDocFromServer:async()=>{serverReads++;if(!confirmed)throw Error('Sin conexión');return snapshot({fromCache:false,hasPendingWrites:false});},delay:async()=>{}});
  load(ctx,'confirmCommittedOperation');
  assert.equal(await ctx.confirmCommittedOperation({},'id','fp'),false);assert.ok(serverReads>0);
  confirmed=true;assert.equal(await ctx.confirmCommittedOperation({},'id','fp'),true);
  assert.equal(await ctx.confirmCommittedOperation({},'other-id','fp'),false);
});

test('el cobro conserva el bloqueo y la base al guardar, aunque ya no muestre la vista de movimientos',()=>{
 let balance=100;
 const ctx=vm.createContext({activeSubmissionLocks:new Set(),submissionPreviewBalances:new Map(),settlementModel:()=>({balance}),scheduleDashboardRender(){}});
 load(ctx,'acquireSubmissionLock','releaseSubmissionLock','captureSubmissionBalance','previewSettlementBalance');
 assert.equal(ctx.acquireSubmissionLock('charge'),true);
 assert.equal(ctx.acquireSubmissionLock('charge'),false);
 ctx.captureSubmissionBalance('charge');balance=200;
 assert.equal(ctx.previewSettlementBalance('charge'),100);
 ctx.releaseSubmissionLock('charge');assert.equal(ctx.previewSettlementBalance('charge'),200);
});
