import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
function declaration(name) {
  const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);
}
function load(ctx,...names) { vm.runInContext(names.map(declaration).join('\n'),ctx); }
const credentialError=()=>Object.assign(new Error('Credenciales'),{code:'auth/invalid-credential'});
function loginHarness(signIn,aliasEmail) {
  const calls=[],lookups=[];
  const ctx=vm.createContext({auth:{},db:{},LOGIN_ALIASES:{},USER_EMAIL_DOMAIN:'explora.local',console,
    doc:(_,name,id)=>({name,id}),getDoc:async ref=>{lookups.push(ref.id);return{exists:()=>Boolean(aliasEmail),data:()=>({authEmail:aliasEmail})};},
    signInWithEmailAndPassword:async(_,email,password)=>{calls.push(email);return signIn(email,password);}});
  load(ctx,'safeUsername','directLoginEmails','loginEmailCandidates','isCredentialError','signInFromLogin');
  return {ctx,calls,lookups};
}

test('usuario habitual entra directamente sin esperar la consulta de aliases',async()=>{
  const {ctx,calls,lookups}=loginHarness(async(email,password)=>({email,password}));
  const result=await ctx.signInFromLogin(' Daniela ','prueba-local');
  assert.equal(result.email,'daniela@explora.local');assert.equal(result.password,'prueba-local');
  assert.deepEqual(calls,['daniela@explora.local']);assert.deepEqual(lookups,[]);
});

test('un alias anterior sigue funcionando y no repite el primer intento fallido',async()=>{
  const {ctx,calls,lookups}=loginHarness(async email=>{if(email==='anterior@example.test')return{email};throw credentialError();},'anterior@example.test');
  assert.equal((await ctx.signInFromLogin('chofer','prueba-local')).email,'anterior@example.test');
  assert.deepEqual(calls,['chofer@explora.local','anterior@example.test']);assert.deepEqual(lookups,['chofer']);
});

test('email explícito, credenciales incorrectas y errores de red no generan intentos duplicados',async()=>{
  const explicit=loginHarness(async()=>{throw credentialError();});
  await assert.rejects(explicit.ctx.signInFromLogin('A@EXAMPLE.TEST','incorrecta'),error=>error.code==='auth/invalid-credential');
  assert.deepEqual(explicit.calls,['a@example.test']);assert.deepEqual(explicit.lookups,[]);
  const invalid=loginHarness(async()=>{throw credentialError();},'chofer@explora.local');
  await assert.rejects(invalid.ctx.signInFromLogin('chofer','incorrecta'),error=>error.code==='auth/invalid-credential');
  assert.deepEqual(invalid.calls,['chofer@explora.local']);
  const network=loginHarness(async()=>{throw Object.assign(new Error('Sin conexión'),{code:'auth/network-request-failed'});},'anterior@example.test');
  await assert.rejects(network.ctx.signInFromLogin('chofer','prueba-local'),error=>error.code==='auth/network-request-failed');
  assert.deepEqual(network.lookups,[]);assert.equal(network.calls.length,1);
});

function profileHarness(getDoc,getDocs=async()=>{throw Error('No debería consultar históricos');}) {
  const ctx=vm.createContext({db:{},doc:(_,name,id)=>({name,id}),getDoc,getDocs,
    collection:(_,name)=>name,where:(field,op,value)=>({field,op,value}),limit:value=>value,query:(...args)=>args,
    profileRole:data=>data.role || 'chofer',fallbackProfile:()=>({role:'chofer',displayName:'Básico'})});
  load(ctx,'loadProfile');return ctx;
}

test('un perfil encontrado no espera una segunda lectura lenta y conserva su prioridad y desactivación',async()=>{
  const first={role:'admin',nombre:'Perfil principal',active:false};
  const ctx=profileHarness(ref=>ref.name==='usuarios' ? Promise.resolve({exists:()=>true,data:()=>first}) : new Promise(()=>{}));
  let resolved=false;
  const request=ctx.loadProfile({uid:'test',email:'test@example.test'}).then(profile=>{resolved=true;return profile;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(resolved,true,'el perfil secundario pendiente no bloquea el principal');
  const profile=await request;assert.equal(profile.role,'admin');assert.equal(profile.active,false);assert.equal(profile.displayName,'Perfil principal');
});

test('un perfil inexistente o no legible usa el perfil del chofer sin perder compatibilidad',async()=>{
  for(const missing of ['absent','denied']) {
    const ctx=profileHarness(ref=>ref.name==='usuarios'
      ? missing==='denied' ? Promise.reject(Error('No autorizado')) : Promise.resolve({exists:()=>false})
      : Promise.resolve({exists:()=>true,data:()=>({nombreCompleto:'Chofer',role:'chofer',activo:false})}));
    const profile=await ctx.loadProfile({uid:'test',email:'test@example.test'});
    assert.equal(profile.displayName,'Chofer');assert.equal(profile.active,false);
  }
});

test('cerrar la carga muestra inmediatamente la pantalla correcta y no reabre una sesión anterior',()=>{
  const nodes=new Map();
  const $=id=>{if(!nodes.has(id)){const classes=new Set();nodes.set(id,{textContent:'',classes,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)}});}return nodes.get(id);};
  const ctx=vm.createContext({$,window:{setTimeout(){throw Error('No debe esperar');},setInterval(){throw Error('No debe simular porcentajes');}}});
  load(ctx,'startSplash','finishSplash');
  ctx.startSplash();assert.equal($('splashMessage').textContent,'Ingresando…');assert.equal($('app').classes.has('hidden'),true);
  ctx.finishSplash('app');assert.equal($('splashScreen').classes.has('hidden'),true);assert.equal($('app').classes.has('hidden'),false);
  ctx.startSplash('Cerrando sesión…');ctx.finishSplash('loginScreen');assert.equal($('loginScreen').classes.has('hidden'),false);assert.equal($('app').classes.has('hidden'),true);
});

test('la preparación de la sesión limpia su timeout cuando Firebase ya está listo',async()=>{
  let cleared;
  const ctx=vm.createContext({authReady:Promise.resolve(),AUTH_READY_TIMEOUT_MS:2500,setTimeout:()=>7,clearTimeout:id=>cleared=id});
  load(ctx,'waitForAuthReady');await ctx.waitForAuthReady();assert.equal(cleared,7);
});

test('las búsquedas heredadas por uid y email arrancan juntas y conservan prioridad',async()=>{
  const starts=[];let finishUid;
  const ctx=profileHarness(async()=>({exists:()=>false}),async query=>{
    const field=query[1].field;starts.push(field);
    if(field==='uid')return new Promise(resolve=>{finishUid=resolve;});
    return{empty:false,docs:[{data:()=>({nombre:'Email secundario',role:'chofer'})}]};
  });
  const pending=ctx.loadProfile({uid:'prueba',email:'prueba@example.test'});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(starts,['uid','email']);
  finishUid({empty:false,docs:[{data:()=>({nombre:'UID prioritario',role:'chofer',activo:false})}]});
  const profile=await pending;assert.equal(profile.displayName,'UID prioritario');assert.equal(profile.active,false);
});
test('auth empieza en un módulo temprano sin resolver de ventanas ni segunda migración de persistencia',()=>{
  const authSource=fs.readFileSync(new URL('../auth-session.js',import.meta.url),'utf8');
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const ctx=vm.createContext({initializeApp:config=>({config}),firebaseConfig:{projectId:'demo'},
    browserLocalPersistence:'local',indexedDBLocalPersistence:'indexed',browserSessionPersistence:'session',inMemoryPersistence:'memory',
    initializeAuth:(app,options)=>{ctx.options=options;return{authStateReady:()=>Promise.resolve()};}});
  const executable=authSource.replace(/import\s+[\s\S]*?\s+from\s+"[^"]+";/g,'').replace(/export const /g,'const ');
  vm.runInContext(executable,ctx);
  assert.deepEqual(Array.from(ctx.options.persistence),['local','indexed','session','memory']);
  assert.equal('popupRedirectResolver' in ctx.options,false);assert.doesNotMatch(source,/setPersistence\s*\(|getAuth\s*\(/);
  assert.ok(html.indexOf('src="./auth-session.js')<html.indexOf('src="./app.js'));
});
