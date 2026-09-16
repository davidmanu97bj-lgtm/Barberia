'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createOperationalAccess,isInactive}=require('../operational-access');
const {createOperationalHandler}=require('../operational-save');
const {fixture}=require('./operational-fixture');
class HttpsError extends Error {constructor(code,message,details){super(message);this.code=code;this.details=details;}}
function setup() {
 const f=fixture(),users=new Map(),calls=[];
 const auth={getUser:async uid=>{calls.push(uid);if(f.authError)throw f.authError;if(!users.has(uid))throw Object.assign(Error('missing'),{code:'auth/user-not-found'});return structuredClone(users.get(uid));}};
 const access=createOperationalAccess({db:f.db,auth,HttpsError});
 const handler=createOperationalHandler({db:f.db,bucket:f.bucket,businessId:'barberia-c25a1',options:{arcaEnabled:false},
  assertViewer:access.assertViewer,getProfile:access.getProfile,serverTimestamp:()=>({seconds:f.state.now/1000}),now:()=>f.state.now});
 function user(uid='test-driver',claims={}){users.set(uid,{uid,displayName:'Nombre Auth',disabled:false,customClaims:claims});return uid;}
 function profile(collection='choferes',uid='test-driver',id=uid,data={}){f.state.records.set(`${collection}/${id}`,{uid,nombre:'Nombre del perfil',active:true,role:'driver',...data});}
 return {...f,access,handler,users,calls,user,profile,raw:f};
}
for(const [label,collection,id,data,claims]of [
 ['chofer canónico','choferes','test-driver',{},{}],
 ['usuario canónico sin copia en choferes','usuarios','test-driver',{},{}],
 ['usuario existente sin rol explícito','usuarios','test-driver',{role:''},{}],
 ['driver histórico','drivers','test-driver',{},{}],
 ['chofer por alias con authUid','choferes','marcelo',{authUid:'test-driver',uid:'legacy-alias'},{}],
 ['usuario por uid almacenado','usuarios','legacy-record',{},{}],
 ['administrador sin claim en el token','administradores','test-driver',{role:'admin'},{}],
 ['administrador en admins','admins','test-driver',{role:'admin'},{}],
 ['rol admin de usuarios sin claim','usuarios','test-driver',{role:'administrador'},{}],
 ['claim de chofer provisionado',null,null,null,{role:'driver'}],
 ['claim admin provisionado',null,null,null,{admin:true}]
])test(`todos los movimientos propios: ${label}`,async()=>{
 const f=setup();f.user('test-driver',claims);if(collection)f.profile(collection,'test-driver',id,data);
 for(const kind of ['cash','digital','expense','debt']){
  const req=f.request(kind);req.auth.token={}; // not an admin token
  const key={action:'check',kind,operationId:req.data.operationId,fingerprint:req.data.fingerprint};
  const before=await f.handler({...req,data:key});assert.equal(before.committed,false);
  const saved=await f.handler(req);assert.equal(saved.committed,true);assert.equal(saved.row.driverUid,'test-driver');
  const repeated=await f.handler({...req,data:key});assert.equal(repeated.committed,true);assert.equal(repeated.id,saved.id);
 }
 const synced=await f.handler({auth:{uid:'test-driver',token:{}},data:{action:'sync'}});
 assert.equal(synced.ledger.billing_records.length,2);assert.equal(synced.ledger.gastos.length,1);assert.equal(synced.ledger.deudas_choferes.length,1);
 assert.equal(f.state.writes,4);
});
test('seis choferes autorizados guardan aislados, sin recibir rol administrador',async()=>{
 const f=setup();
 for(let i=0;i<6;i++){const uid=`driver-${i}`;f.user(uid);f.profile(i%2?'usuarios':'choferes',uid);
  for(const kind of ['cash','digital','expense','debt'])await f.handler(f.request(kind,{},uid));}
 assert.equal(f.state.writes,24);
 for(let i=0;i<6;i++){
  const uid=`driver-${i}`,request={auth:{uid,token:{}},data:{action:'sync'}},r=await f.handler(request);
  assert.equal(r.ledger.billing_records.length,2);assert.equal(r.ledger.gastos.length,1);assert.equal(r.ledger.deudas_choferes.length,1);
  for(const rows of Object.values(r.ledger))for(const row of rows)assert.equal(row.driverUid,uid);
  await assert.rejects(f.access.assertAdmin({...request}),e=>e.code==='permission-denied');
  assert.deepEqual(f.users.get(uid).customClaims,{});
 }
});
test('misma autorización para guardar y abrir los propios PDF; admin documental puede gestionarlos',async()=>{
 const f=setup();f.user();f.profile('usuarios');const req=f.request('expense');await f.handler(req);
 assert.equal(await f.access.assertViewer(req),'test-driver');await assert.rejects(f.access.assertAdmin({...req}),e=>e.code==='permission-denied');
 f.user('admin-uid');f.profile('administradores','admin-uid','admin-uid',{role:'admin'});
 assert.equal(await f.access.assertAdmin({auth:{uid:'admin-uid',token:{}}}),'admin-uid');
});
for(const [name,profile]of [
 ['active false',{active:false}],['activo false',{activo:false}],['disabled true',{disabled:true}],
 ['active cero',{active:0}],['activo texto false',{activo:'false'}],['bloqueado',{bloqueado:true}],
 ['inactivo',{estado:'INACTIVO'}],['suspendido',{status:'suspendido'}],['eliminado',{deleted:true}],['habilitado false',{habilitado:false}]
])test(`no reactiva una cuenta marcada ${name}`,async()=>{
 const f=setup();f.user('test-driver',{role:'driver'});f.profile('usuarios','test-driver','test-driver',profile);
 for(const action of ['check','save','sync']){const req=f.request('cash',{action});await assert.rejects(f.handler(req),e=>e.code==='permission-denied'&&e.details.reason==='explora_account_inactive');}
 assert.equal(f.state.writes,0);
});
test('una copia canónica activa no elude una deshabilitación en el perfil histórico',async()=>{
 const f=setup();f.user('test-driver',{admin:true});f.profile('usuarios');f.profile('choferes','test-driver','legacy',{authUid:'test-driver',active:false});
 await assert.rejects(f.handler(f.request()),e=>e.details.reason==='explora_account_inactive');assert.equal(f.state.writes,0);
});
test('cuenta Auth deshabilitada bloquea incluso con rol admin firmado anteriormente',async()=>{
 const f=setup();f.user('test-driver',{admin:true});f.users.get('test-driver').disabled=true;f.profile();
 await assert.rejects(f.handler(f.request()),e=>e.details.reason==='explora_account_inactive');assert.equal(f.state.reads,0);
});
test('anónimo, cuenta inexistente y ausencia de sesión no acceden',async()=>{
 const f=setup();f.user();f.profile();
 for(const req of [{data:{}},{auth:{uid:'unknown'},data:{}},{auth:{uid:'test-driver',token:{firebase:{sign_in_provider:'anonymous'}}},data:{}}]){
  await assert.rejects(f.handler(req),e=>['unauthenticated','permission-denied'].includes(e.code));
 }assert.equal(f.state.writes,0);
});
test('cuenta creada solo en Auth no equivale a chofer habilitado, aunque mienta el payload',async()=>{
 const f=setup();f.user();const r=f.request('cash',{role:'admin',admin:true});r.auth.token={admin:true,role:'driver'};
 await assert.rejects(f.handler(r),e=>e.details.reason==='explora_profile_missing');assert.equal(f.state.writes,0);
});
test('una cuenta con perfil de cliente no hereda operaciones de chofer',async()=>{
 const f=setup();f.user();f.profile('usuarios','test-driver','test-driver',{role:'customer'});
 await assert.rejects(f.handler(f.request()),e=>e.details.reason==='explora_profile_missing');
});
test('nombre/email coincidentes o driverId en el payload no permiten asumir otro perfil',async()=>{
 const f=setup();f.user();f.users.get('test-driver').email='same@example.com';f.profile('choferes','other-driver','other-driver',{email:'same@example.com'});
 await assert.rejects(f.handler(f.request('cash',{driverUid:'other-driver',driverId:'other-driver'})),e=>e.details.reason==='explora_profile_missing');
});
test('documento canónico asociado a otro UID bloquea sin adoptar al dueño ajeno',async()=>{
 const f=setup();f.user();f.profile('usuarios','test-driver','test-driver',{authUid:'other-driver'});
 await assert.rejects(f.handler(f.request()),e=>e.details.reason==='explora_profile_conflict');
});
test('revocación de sesión se respeta; no se confunde con chofer inactivo',async()=>{
 const f=setup();f.user();f.profile();f.users.get('test-driver').tokensValidAfterTime=new Date(f.state.now).toUTCString();
 const req=f.request();req.auth.token={auth_time:f.state.now/1000-30};
 await assert.rejects(f.handler(req),e=>e.code==='unauthenticated'&&e.details.reason==='explora_session_revoked');
});
test('error de infraestructura en Auth no se disfraza como falta de permisos del chofer',async()=>{
 const f=setup();f.user();f.profile();f.raw.authError=Object.assign(Error('insufficient IAM'),{code:'auth/insufficient-permission'});
 await assert.rejects(f.handler(f.request()),e=>e.code==='unavailable'&&e.details.reason==='explora_auth_lookup_failed');assert.equal(f.state.writes,0);
});
test('error de lectura de perfiles impide escribir y se muestra como recuperable',async()=>{
 const f=setup();f.user();f.profile();f.state.failRead=true;
 await assert.rejects(f.handler(f.request()),e=>e.code==='unavailable'&&e.details.reason==='explora_profile_lookup_failed');assert.equal(f.state.writes,0);
});
test('un chofer no puede confirmar ID ni usar evidencia de otro autorizado',async()=>{
 const f=setup();for(const uid of ['test-driver','other-driver']){f.user(uid);f.profile('usuarios',uid);}
 const r=f.request('digital');await f.handler(r);
 await assert.rejects(f.handler({...r,auth:{uid:'other-driver'}}),e=>e.code==='already-exists');
 const x=f.request('expense');x.data.proofPath=x.data.proofPath.replace('test-driver','other-driver');
 await assert.rejects(f.handler(x),e=>e.code==='permission-denied');assert.equal(f.state.writes,1);
});
test('se conserva un único cobro frente a dos solicitudes simultáneas del mismo usuario',async()=>{
 const f=setup();f.user();f.profile('usuarios');const r=f.request('cash');
 const out=await Promise.all([f.handler(r),f.handler({...r})]);assert.equal(out[0].id,out[1].id);assert.equal(f.state.writes,1);
});
test('permiso y nombre del guardado utilizan la misma comprobación por solicitud',async()=>{
 const f=setup();f.user();f.profile('usuarios');const r=f.request();const out=await f.handler(r);
 assert.equal(f.calls.length,1);assert.equal(out.row.driverName,'Nombre del perfil');
});
test('modificar el estado entre check y save vuelve a validar; no hay cache entre solicitudes',async()=>{
 const f=setup();f.user();f.profile('usuarios');const r=f.request();
 await f.handler({...r,data:{...r.data,action:'check'}});f.state.records.get('usuarios/test-driver').active=false;
 await assert.rejects(f.handler({...r}),e=>e.details.reason==='explora_account_inactive');assert.equal(f.state.writes,0);
});
test('una bandera activa sin estado explícito no se considera deshabilitada',()=>{
 for(const data of [{},{active:true},{estado:'disponible'},{status:'active'},{estado:'trabajando'},{status:'working'},{active:'true'}, {active:1}])assert.equal(isInactive(data),false);
});
