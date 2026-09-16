import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{fixture}=require('../functions/tests/operational-fixture');
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
function declaration(name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
function load(ctx,...names){vm.runInContext(names.map(declaration).join('\n'),ctx);}
function clientHarness(){
 const f=fixture(),user={uid:'test-driver',getIdToken:async()=>{counts.tokens++;}},nodes=new Map();
 const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'Confirmar',disabled:false,className:'',reset(){counts.resets++;},classList:{add(){},contains(){return false;}},querySelectorAll(){return [$(id+'-control')];}});return nodes.get(id);};
 const counts={resets:0,uploads:0,finished:0,tokens:0,requests:[],ack:[],notice:[],clears:0};const pending=new Map();let id=1;
 const ctx=vm.createContext({$,auth:{currentUser:user},navigator:{onLine:true},dashboardLoad:{complete:()=>true},ExploraPeriodSettlement:{VERSION:'net_period_cashbox_10_split_50_v1'},ExploraExpensePolicy:{debtVersion:'driver_debt_100_v1'},
  ROOT_COLLECTIONS:{payments:'billing_records',expenses:'gastos',debts:'deudas_choferes'},activeSubmissionLocks:new Set(),submissionPreviewBalances:new Map(),submissionPreviewModels:new Map(),
  captureSubmissionBalance:()=>{throw Error('a failed or not-loaded history must not prevent saving');},scheduleDashboardRender(){},
  console:{warn(){}},clearPhotoPicker(){},syncChargeCustomerFields(){},closeModalAndGoTop(){counts.finished++;},scheduleOperationalRecovery(){},
  operationalNotice:m=>counts.notice.push(m),applyOperationalAck:r=>counts.ack.push(r),
  clearPendingOperation:(_k,_u,fp)=>{counts.clears++;pending.delete(fp);},
  reservePendingOperation:(kind,_uid,fp)=>{if(!pending.has(fp))pending.set(fp,{operationId:kind+'_'+(id++).toString(16).padStart(32,'0'),createdAtMs:f.state.now});return pending.get(fp);},
  buildSubmissionFingerprint:async(kind,fields)=>'sha256_'+crypto.createHash('sha256').update(JSON.stringify({kind,fields})).digest('hex'),
  operationalSaveCallable:async data=>{counts.requests.push(structuredClone(data));return {data:await f.handler({auth:{uid:user.uid,token:{}},data})};},
  uploadOperationalReceipt:async(_file,path,kind,opId)=>{counts.uploads++;const req=f.request(kind==='payment'?'digital':kind==='debt'?'debt':'expense',{operationId:opId});return req.data;}
 });
 load(ctx,'firebaseErrorCode','operationalErrorMessage','callOperationalServer','validateOperationalAck','acquireSubmissionLock','releaseSubmissionLock','submitOperationalMovement');
 return {f,user,ctx,$,counts,pending};
}
const fields={amount:50000,detail:'Multa de prueba',expenseType:'multa'};
for(const kind of ['debt','expense','cash','digital'])test(`cliente ${kind}: confirmación de servidor aunque el historial no pueda calcularse`,async()=>{
 const h=clientHarness(),data=kind==='debt'?fields:kind==='expense'?{...fields,expenseType:'combustible'}:{amount:50000,detail:'Viaje',invoiceRequest:h.f.request(kind).data.invoiceRequest};
 await h.ctx.submitOperationalMovement({kind,user:h.user,file:{name:'proof.jpg'},fields:data});
 assert.equal(h.f.state.records.size,1);assert.equal(h.counts.ack.length,1);assert.equal(h.ctx.activeSubmissionLocks.size,0);assert.equal(h.counts.clears,1);
});
test('dos toques simultáneos producen un solo envío y liberan todos los controles',async()=>{
 const h=clientHarness();await Promise.all([h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields}),h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields})]);
 assert.equal(h.counts.requests.filter(r=>r.action==='save').length,1);assert.equal(h.$('saveExpenseBtn').disabled,false);assert.equal(h.ctx.activeSubmissionLocks.size,0);
});
test('fallo de permisos informa el código, conserva el formulario y no sube ni duplica imágenes',async()=>{
 const h=clientHarness();h.f.state.disabled=true;await h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields});
 assert.equal(h.f.state.writes,0);assert.equal(h.counts.uploads,0);assert.equal(h.counts.resets,0);assert.equal(h.counts.clears,0);assert.match(h.$('expenseStatus').textContent,/permission-denied/);assert.equal(h.$('saveExpenseBtn').disabled,false);
});
test('sin conexión no hay éxito falso ni borrado del formulario',async()=>{
 const h=clientHarness();h.ctx.navigator.onLine=false;await h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields});
 assert.equal(h.counts.requests.length,0);assert.equal(h.counts.resets,0);assert.equal(h.counts.clears,0);assert.equal(h.ctx.activeSubmissionLocks.size,0);assert.match(h.$('expenseStatus').textContent,/conexión/);
});
test('respuesta perdida conserva un solo registro y se confirma con check',async()=>{
 const h=clientHarness();h.f.state.afterCommitFailure=true;await h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields});
 assert.equal(h.f.state.records.size,1);assert.equal(h.counts.requests.filter(r=>r.action==='save').length,1);assert.equal(h.counts.ack.length,1);assert.equal(h.counts.finished,1);
});
test('fallo antes de guardar permite reintentar el mismo ID, sin limpiar importe ni foto',async()=>{
 const h=clientHarness();h.f.state.failWrite=true;await h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields});
 const id=h.counts.requests.find(r=>r.action==='save').operationId;assert.equal(h.counts.resets,0);assert.equal(h.counts.clears,0);
 h.f.state.failWrite=false;await h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields});
 assert.equal(h.f.state.records.size,1);assert.equal(h.counts.requests.filter(r=>r.action==='save').at(-1).operationId,id);assert.equal(h.counts.finished,1);
});
test('confirmado pero falla el render: se informa guardado y no ofrece crear otro registro',async()=>{
 const h=clientHarness();h.ctx.applyOperationalAck=()=>{throw Error('broken old historical record');};h.ctx.closeModalAndGoTop=()=>{throw Error('renderer');};
 await h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields});
 assert.equal(h.f.state.records.size,1);assert.equal(h.counts.clears,1);assert.equal(h.counts.resets,1);assert.match(h.counts.notice.at(-1),/registro ya está guardado/);
});
test('confirmación vacía o de otro usuario jamás limpia el formulario',async()=>{
 for(const reply of [{ok:true,committed:false},{ok:true,committed:true,id:'fake',row:{driverUid:'other-driver'}}]){
  const h=clientHarness();h.ctx.operationalSaveCallable=async data=>({data:data.action==='check'?{ok:true,committed:false}:reply});
  await h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields});assert.equal(h.counts.resets,0);assert.equal(h.counts.ack.length,0);assert.equal(h.counts.clears,0);
 }
});
test('cambiar de sesión descarta el acuse y no muestra datos en la otra cuenta',async()=>{
 const h=clientHarness();h.ctx.operationalSaveCallable=async data=>{h.ctx.auth.currentUser={uid:'other-driver'};return {data:{ok:true,committed:true}};};
 await h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields});assert.equal(h.counts.ack.length,0);assert.equal(h.counts.resets,0);assert.equal(h.counts.clears,0);
});
test('token caducado se renueva una vez y no se repiten renovaciones indefinidamente',async()=>{
 const h=clientHarness();let calls=0;h.ctx.operationalSaveCallable=async()=>{calls++;throw Object.assign(Error('expired'),{code:'functions/unauthenticated'});};
 await h.ctx.submitOperationalMovement({kind:'debt',user:h.user,file:{},fields});assert.equal(calls,2);assert.equal(h.counts.tokens,1);assert.equal(h.counts.clears,0);
});
test('un modelo que lanza error no deja un bloqueo huérfano en los flujos históricos',()=>{
 const h=clientHarness();assert.throws(()=>h.ctx.acquireSubmissionLock('management'));assert.equal(h.ctx.activeSubmissionLocks.size,0);
 assert.equal(h.ctx.acquireSubmissionLock('charge',false),true);assert.equal(h.ctx.acquireSubmissionLock('charge',false),false);
});
test('acuse del servidor + snapshot del mismo ID no duplican el saldo ni el movimiento',()=>{
 const data={driverUid:'a',amount:20000};const ctx=vm.createContext({ROOT_COLLECTIONS:{payments:'p',expenses:'g',debts:'d'},payments:[{id:'x',...data}],expenses:[],debts:[],normalizePaymentRecord:(id,r)=>({id,...r}),normalizeExpenseRecord:(id,r)=>({id,...r}),normalizeDebtRecord:(id,r)=>({id,...r}),recordTimestampMs:()=>1,operationalDataEpoch:0,scheduleDashboardRender(){},flushDashboardRender(){}});
 load(ctx,'applyOperationalAck');ctx.applyOperationalAck({collection:'p',id:'x',row:data});assert.equal(ctx.payments.length,1);assert.equal(ctx.payments[0].amount,20000);
});
test('el endpoint nuevo no aparece en recursos del Hosting ni pide secretos ARCA',()=>{
 const index=fs.readFileSync(new URL('../functions/index.js',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../functions/operational-save.js',import.meta.url),'utf8');
 assert.match(index,/exports\.saveOperationalMovementV311 = require\("\.\/operational-save"\)/);
 assert.doesNotMatch(server,/defineSecret|issueArca|sendPhoto|sendMessage/);
 assert.match(source,/saveOperationalMovementV311/);
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');assert.match(html,/app\.js\?v=20260916-uber-retired-316c/);
});
