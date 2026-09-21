import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
const createLoad = vm.runInNewContext(`(${declaration('createDashboardLoad')})`);

test('el saldo espera todos los datos del servidor, incluyendo colecciones vacías', async () => {
  const load = createLoad(['cobros', 'gastos']);
  load.update('cobros', true);
  load.update('gastos', true);
  assert.equal(load.complete(), false, 'el caché inicial vacío no es un saldo cero');
  load.update('cobros', false);
  assert.equal(load.complete(), false);
  load.update('gastos', false);
  await load.settled;
  assert.equal(load.complete(), true);
  load.update('gastos', true);
  assert.equal(load.complete(), true, 'retiene el saldo conocido al perder conexión');
  assert.equal(load.cached.has('gastos'), true);
  load.update('gastos', false, true);
  assert.equal(load.complete(), false, 'un error no se anuncia como sincronizado');
});

test('las actualizaciones simultáneas dibujan una vez y se cancelan al cambiar de sesión', () => {
  let callback, frames=0, renders=0, cancelled=0;
  const ctx = vm.createContext({dashboardRenderJobs:new Set(),dashboardRenderFrame:null,render:()=>renders++,
    window:{requestAnimationFrame:fn=>{callback=fn;return ++frames;},cancelAnimationFrame:()=>cancelled++}});
  vm.runInContext(declaration('scheduleDashboardRender')+'\n'+declaration('flushDashboardRender')+'\n'+declaration('cancelDashboardRender'),ctx);
  for(let i=0;i<14;i++)ctx.scheduleDashboardRender();
  assert.equal(frames,1);
  callback(); assert.equal(renders,1);
  ctx.scheduleDashboardRender();ctx.cancelDashboardRender();
  assert.equal(cancelled,1);assert.equal(ctx.dashboardRenderJobs.size,0);
});

test('cada colección usa una consulta que conserva aliases autorizados y evita los rechazados', () => {
  const fields = vm.runInNewContext(source.match(/const OWNERSHIP_FIELDS = (\[[\s\S]*?\]);/)[1]);
  const query = vm.runInNewContext(`(${declaration('ownedQuery')})`,{ROOT_COLLECTIONS:{uber:'uber_weekly_closures'},OWNERSHIP_FIELDS:fields,
    db:{},collection:(_,name)=>name,where:(field,op,uid)=>({field,uid}),or:(...filters)=>filters,query:(collection,filters)=>({collection,filters})});
  const normal=query('gastos','driver');
  assert.deepEqual(Array.from(normal.filters,f=>f.field),['driverUid','choferUid','uid','ownerUid','driverId','choferId','userUid','createdByUid']);
  assert.ok(normal.filters.every(f=>f.uid==='driver'));
  assert.deepEqual(Array.from(query('uber_weekly_closures','driver').filters,f=>f.field),['driverUid']);
});

test('el listener procesa modificaciones y bajas; ignora metadatos y respuestas de sesiones anteriores', () => {
  let snapshot, error, assigns=0, normalized=0, rows, stopped=0;
  const user={uid:'a'},load=createLoad(['gastos']);
  const ctx = vm.createContext({auth:{currentUser:user},dashboardLoad:load,
    ownedQuery:()=>({}),onSnapshot:(_q,_options,next,fail)=>{snapshot=next;error=fail;return()=>stopped++;},
    scheduleDashboardRender:()=>{},renderDriverLoadState:()=>{},recordTimestampMs:row=>row.time,console:{error:()=>{}}});
  vm.runInContext(declaration('subscribeOwnedRecords'),ctx);
  const stop=ctx.subscribeOwnedRecords(user,{collectionName:'gastos',normalizer:(id,data)=>{normalized++;return{id,...data};},assign:value=>{assigns++;rows=value;}});
  let previous=new Map();
  const emit=(docs,changes=1,fromCache=false)=>{
    const wrappers=docs.map(data=>({id:data.id,data:()=>data}));
    const next=new Map(wrappers.map(row=>[row.id,row]));
    const delta=changes ? [...wrappers.map(doc=>({type:previous.has(doc.id)?'modified':'added',doc})),
      ...[...previous.values()].filter(doc=>!next.has(doc.id)).map(doc=>({type:'removed',doc}))] : [];
    previous=next;
    snapshot({docs:wrappers,docChanges:()=>delta,metadata:{fromCache}});
  };
  emit([{id:'legacy',time:1,amount:50}]);assert.equal(rows[0].amount,50);
  emit([{id:'legacy',time:1,amount:50}],0);assert.equal(assigns,1);assert.equal(normalized,1);
  emit([{id:'legacy',time:1,amount:25}]);assert.equal(rows[0].amount,25);
  emit([]);assert.equal(rows.length,0,'las bajas no reaparecen desde un caché histórico');
  ctx.auth.currentUser={uid:'b'};emit([{id:'private',time:2}]);assert.equal(assigns,3);
  stop();ctx.auth.currentUser=user;emit([{id:'private',time:2}]);error(Error('late'));
  assert.equal(assigns,3);assert.equal(stopped,1);assert.equal(load.errors.size,0);
});

function authHarness(profile) {
  const counts={driver:0,closures:0,admin:0,signOut:0,shown:[]};
  const noop=()=>{};
  const ctx=vm.createContext({authGeneration:0,auth:{currentUser:{uid:'a',email:'a@demo.local'}},dashboardLoad:null,
    tripCalendar:{reset:noop},
    $:()=>({classList:{add:noop},textContent:'',className:''}),RECENT_RECEIPTS_LIMIT:10,visibleReceiptCount:10,
    ROOT_COLLECTIONS:{payments:'payments'},ADMIN_REQUIRED_SNAPSHOT_KEYS:new Set(['drivers']),
    fallbackProfile:()=>({displayName:'A',role:'chofer'}),loadProfile:()=>profile,
    createDashboardLoad:createLoad,
    subscribeToday:()=>counts.driver++,subscribeClosures:()=>counts.closures++,subscribeAdminDashboard:()=>counts.admin++,
    signOut:async()=>counts.signOut++,finishSplash:async target=>counts.shown.push(target),
    adminSnapshotReady:new Set(),adminDismissedPendingActionIds:new Set(),console,
    onAuthStateChanged:(_auth,callback)=>{ctx.callback=callback;}});
  for(const name of ['cancelDashboardRender','applyRoleUI','subscribeOwnProfileDashboard','subscribeTeamRealtimeDashboard',
    'renderDriverLoadState','unsubscribeTeamRealtimeDashboard','unsubscribeOwnProfileDashboard','unsubscribeAdminDashboard',
    'renderAdminDashboardUpdates','render','refreshArcaBillingStatus'])ctx[name]=noop;
  for(const name of ['Payments','Expenses','Uber','Debts','DebtPayments','Advances','Closures'])ctx['unsubscribe'+name]=noop;
  ctx.isAdminProfile=()=>ctx.currentProfile?.role==='admin';
  const start=source.indexOf('onAuthStateChanged(auth, async user => {');
  vm.runInContext(source.slice(start,source.indexOf('\ndocument.querySelectorAll("[data-mode]")',start)),ctx);
  return {ctx,counts};
}
test('cargar el perfil no reinicia las suscripciones del mismo rol', async () => {
  const {ctx,counts}=authHarness(Promise.resolve({role:'chofer',displayName:'A'}));
  await ctx.callback(ctx.auth.currentUser);
  assert.equal(counts.driver,1);assert.equal(counts.closures,1);assert.equal(counts.admin,0);
  assert.deepEqual(counts.shown,['app']);
});

test('un historial lento no bloquea el ingreso; conserva el saldo sin confirmar y difiere la carga del equipo', async () => {
  const {ctx,counts}=authHarness(Promise.resolve({role:'chofer',displayName:'A'}));
  let team=0;
  ctx.subscribeTeamRealtimeDashboard=()=>{assert.deepEqual(counts.shown,['app']);team++;};
  await ctx.callback(ctx.auth.currentUser);
  assert.deepEqual(counts.shown,['app']);assert.equal(team,1);
  assert.equal(ctx.dashboardLoad.complete(),false,'no convierte una colección que falta en saldo cero');
});
test('un perfil tardío no reabre la app ni cambia al usuario que cerró sesión', async () => {
  const profile=deferred();const {ctx,counts}=authHarness(profile.promise);
  const pending=ctx.callback(ctx.auth.currentUser);
  ctx.auth.currentUser=null;await ctx.callback(null);
  profile.resolve({role:'admin',displayName:'Anterior'});await pending;
  assert.equal(ctx.currentProfile,null);assert.equal(counts.admin,0);
  assert.deepEqual(counts.shown,['loginScreen']);
});
test('un cambio real de rol inicia el panel correcto y conserva la desactivación', async () => {
  const admin=authHarness(Promise.resolve({role:'admin'}));await admin.ctx.callback(admin.ctx.auth.currentUser);
  assert.equal(admin.counts.driver,1);assert.equal(admin.counts.admin,1);
  const inactive=authHarness(Promise.resolve({role:'chofer',active:false}));await inactive.ctx.callback(inactive.ctx.auth.currentUser);
  assert.equal(inactive.counts.signOut,1);assert.deepEqual(inactive.counts.shown,[]);
});
test('ARCA comparte solicitudes en curso, refresca al vencer y separa sesiones', async () => {
  let now=1000,calls=0;const response=deferred();
  const ctx=vm.createContext({arcaStatusCache:null,authGeneration:1,Date:{now:()=>now},functions:{},
    httpsCallable:()=>()=>{calls++;return response.promise;}});
  vm.runInContext(declaration('cachedArcaStatus'),ctx);
  const a=ctx.cachedArcaStatus('a');assert.equal(a,ctx.cachedArcaStatus('a'));assert.equal(calls,1);
  response.resolve({data:{enabled:true}});await a;
  assert.equal(a,ctx.cachedArcaStatus('a'));now+=60001;await ctx.cachedArcaStatus('a');assert.equal(calls,2);
  ctx.authGeneration++;await ctx.cachedArcaStatus('a');assert.equal(calls,3);
  await ctx.cachedArcaStatus('b');assert.equal(calls,4);
});

test('Facturas abre con los datos anteriores y reemplaza un listado eliminado al sincronizar', () => {
  const nodes=new Map(),listeners=[];let renders=0,resetSession;
  const element=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',classList:{add(){},remove(){}},replaceChildren(){},focus(){}});return nodes.get(id);};
  const ctx=vm.createContext({auth:{currentUser:{uid:'a'}},invoiceViewGeneration:0,
    invoiceViewCache:new Map([['a',[{id:'old'}]]]),invoiceRows:[],invoiceFilter:'all',stopInvoiceSubscription:null,
    $:element,document:{querySelector:()=>element('close')},clearInvoiceFiles(){},isAdminProfile:()=>false,
    query:(...args)=>args,collection:()=>({}),where:()=>({}),orderBy:()=>({}),limit:()=>({}),db:{},
    renderInvoices:()=>renders++,onSnapshot:(_q,_opts,next)=>{listeners.push(next);return()=>{};},
    onAuthStateChanged:(_auth,callback)=>{resetSession=callback;},arcaStatusCache:null});
  vm.runInContext(declaration('showInvoices'),ctx);
  ctx.showInvoices();assert.equal(ctx.invoiceRows[0].id,'old');assert.equal(renders,1);
  const empty=fromCache=>({empty:true,metadata:{fromCache},docChanges:()=>[],docs:[]});
  listeners[0](empty(true));assert.equal(ctx.invoiceRows.length,1);
  listeners[0](empty(false));assert.equal(ctx.invoiceRows.length,0,'el servidor vacío reemplaza el caché');
  assert.equal(renders,2);
  ctx.showInvoices();listeners[0]({docs:[{id:'stale',data:()=>({})}],docChanges:()=>[{}],metadata:{fromCache:false}});
  assert.equal(ctx.invoiceRows.length,0,'descarta una respuesta de la vista anterior');
  const reset=source.match(/^onAuthStateChanged\(auth,\(\)=>\{invoiceViewGeneration\+\+;.*$/m)[0];
  vm.runInContext(reset,ctx);ctx.auth.currentUser={uid:'b'};resetSession();
  assert.equal(ctx.invoiceViewCache.size,0);
  listeners[1]({docs:[{id:'private',data:()=>({})}],docChanges:()=>[{}],metadata:{fromCache:false}});
  assert.equal(ctx.invoiceRows.length,0,'no conserva facturas de otra sesión');
});
