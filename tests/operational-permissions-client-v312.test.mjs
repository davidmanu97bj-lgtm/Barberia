import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url),source=fs.readFileSync(new URL('app.js',root),'utf8');
function declaration(name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
function context(){let tokens=0,calls=0;const user={uid:'driver',getIdToken:async()=>{tokens++;}};const ctx=vm.createContext({auth:{currentUser:user},operationalSaveCallable:async()=>{calls++;return {data:{ok:true}};}});vm.runInContext(['firebaseErrorCode','operationalErrorMessage','callOperationalServer'].map(declaration).join('\n'),ctx);return {ctx,user,count:()=>({tokens,calls})};}
test('permiso con claims antiguos refresca una vez la sesión, sin cambiar el identificador',async()=>{
 const f=context(),req={action:'check',operationId:'id-estable'};const calls=[];f.ctx.operationalSaveCallable=async data=>{calls.push(data);if(calls.length===1)throw {code:'functions/permission-denied'};return {data:{ok:true}};};
 await f.ctx.callOperationalServer(req,f.user);assert.equal(f.count().tokens,1);assert.equal(calls.length,2);assert.equal(calls[0],calls[1]);
});
test('denegación permanente no entra en bucle ni refresca el token en vano',async()=>{
 const f=context();let calls=0;f.ctx.operationalSaveCallable=async()=>{calls++;throw {code:'functions/permission-denied',details:{reason:'explora_account_inactive'}};};
 await assert.rejects(f.ctx.callOperationalServer({},f.user));assert.equal(calls,1);assert.equal(f.count().tokens,0);
});
test('denegación sin motivo persiste: solo un refresco, sin reintento infinito',async()=>{
 const f=context();let calls=0;f.ctx.operationalSaveCallable=async()=>{calls++;throw {code:'functions/permission-denied'};};
 await assert.rejects(f.ctx.callOperationalServer({},f.user));assert.equal(calls,2);assert.equal(f.count().tokens,1);
});
test('cambio de cuenta durante refresco detiene la operación antes de una segunda llamada',async()=>{
 const f=context();let calls=0;f.ctx.operationalSaveCallable=async()=>{calls++;throw {code:'functions/permission-denied'};};f.user.getIdToken=async()=>{f.ctx.auth.currentUser={uid:'other'};};
 await assert.rejects(f.ctx.callOperationalServer({},f.user),e=>e.code==='operational-session-changed');assert.equal(calls,1);
});
test('mensajes distinguen infraestructura, perfil ausente y cuenta deshabilitada',()=>{
 const f=context();
 for(const [reason,pattern]of [['explora_auth_lookup_failed',/servidor.*no una baja/],['explora_profile_missing',/no necesitás permiso de administrador/],['explora_account_inactive',/deshabilitada/]]){
 const text=f.ctx.operationalErrorMessage({code:'functions/permission-denied',details:{reason}},'verificar');assert.match(text,pattern);assert.match(text,new RegExp(reason));}
});
test('guardado y PDF comparten permiso operativo, sin reutilizar autorización de Tiempo real',()=>{
 const s=fs.readFileSync(new URL('functions/index.js',root),'utf8');
 assert.match(s,/assertViewer:operationalAccess\.assertViewer,getProfile:operationalAccess\.getProfile/);
 assert.match(s,/createReceiptPdfFunction\(\{db,bucket,assertViewer:operationalAccess\.assertViewer,assertAdmin:operationalAccess\.assertAdmin\}\)/);
});
test('un usuario no puede darse de alta ni autoelevar rol o estado en reglas de perfiles',()=>{
 const rules=fs.readFileSync(new URL('firestore.rules',root),'utf8');
 for(const section of ['usuarios','choferes']){
  const part=rules.slice(rules.indexOf('match /'+section+'/'),rules.indexOf('match /'+section+'/')+1250);
  assert.match(part,/adminFieldsUnchanged\(\)/);for(const field of ['active','activo','status','estado','disabled','enabled','blocked','bloqueado'])assert.ok(part.includes("'"+field+"'"));
 }
 assert.match(rules,/allow create: if isAdmin\(\)/);assert.doesNotMatch(rules,/allow (?:read, write|write): if true/);
});
