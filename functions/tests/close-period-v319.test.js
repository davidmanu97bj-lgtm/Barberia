'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createClosePeriodHandler}=require('../close-period');
class Snap{constructor(ref,data){this.ref=ref;this.id=ref.id;this._data=data;this.exists=data!==undefined;}data(){return this._data;}}
class Ref{constructor(db,col,id){this.db=db;this.col=col;this.id=id;}async get(){return new Snap(this,this.db._get(this.col,this.id));}}
class Query{constructor(db,col,field,val,lim=9999){this.db=db;this.col=col;this.field=field;this.val=val;this.lim=lim;}limit(n){return new Query(this.db,this.col,this.field,this.val,n);}}
class Col{constructor(db,name){this.db=db;this.name=name;}doc(id){return new Ref(this.db,this.name,id);}where(field,_op,val){return new Query(this.db,this.name,field,val);}}
class DB{
  constructor(seed){this.store=new Map();for(const [col,rows] of Object.entries(seed))this.store.set(col,new Map(Object.entries(rows)));}
  collection(name){if(!this.store.has(name))this.store.set(name,new Map());return new Col(this,name);}
  _get(col,id){return this.store.get(col)?.get(id);}
  _query(q){const docs=[];for(const [id,data] of this.store.get(q.col)||[]){if(data?.[q.field]===q.val)docs.push(new Snap(new Ref(this,q.col,id),data));if(docs.length>=q.lim)break;}return {docs,empty:docs.length===0};}
  async runTransaction(fn){const writes=[];const tx={get:async target=>target instanceof Ref?new Snap(target,this._get(target.col,target.id)):this._query(target),create:(ref,data)=>writes.push(['create',ref,data]),set:(ref,data,opt)=>writes.push(['set',ref,data,opt]),update:(ref,data)=>writes.push(['update',ref,data])};const result=await fn(tx);for(const [op,ref,data,opt] of writes){const col=this.store.get(ref.col)||new Map();this.store.set(ref.col,col);const cur=col.get(ref.id)||{};if(op==='create'&&col.has(ref.id))throw Object.assign(new Error('exists'),{code:6});col.set(ref.id,op==='update'||opt?.merge?{...cur,...data}:{...data});}return result;}
}
const ts=()=>({toMillis:()=>9999999999999});
const bucket={file:path=>({getMetadata:async()=>[{size:'12345',contentType:'image/jpeg',generation:'gen-1'}]})};
const proof=(uid,requestId)=>{const path=`cierres_semanales/${requestId}/${uid}/imagen.jpg`;return {liquidationProof:{
  proofPath:path,
  proofUrl:`https://firebasestorage.googleapis.com/v0/b/barberia-c25a1.firebasestorage.app/o/${encodeURIComponent(path)}?alt=media&token=test`,
  proofMimeType:'image/jpeg',proofFileName:'imagen.jpg'
}};};
function seed(uid='u1'){return {billing_records:{c1:{driverUid:uid,method:'cash',amount:100,createdAtMs:1000,status:'completed'},d1:{driverUid:uid,method:'digital',amount:100,createdAtMs:2000,status:'completed'}},gastos:{e1:{driverUid:uid,amount:40,createdAtMs:3000,payerRole:'driver',status:'active',expenseLabel:'Combustible'}},uber_weekly_closures:{},deudas_choferes:{de1:{driverUid:uid,type:'driver_debt_100',debtRuleVersion:'driver_debt_100_v1',registrationOrigin:'driver_expense_debt_menu',debtResponsibility:'driver',acknowledgedByDriver:true,remainingAmount:30,amount:30,createdAtMs:4000,status:'active',debtLabel:'Multa'}},cierres_semanales:{},deuda_pagos:{},_operational_closure_state:{}};}
test('cierre documenta, liquida saldo y deja la cuenta posterior en cero sin duplicar',async()=>{const uid='u1',db=new DB(seed(uid));let now=10000;const handler=createClosePeriodHandler({db,bucket,businessId:'barberia-c25a1',options:{arcaEnabled:false},assertViewer:async()=>uid,getProfile:async()=>({data:()=>({displayName:'Agustin'})}),serverTimestamp:ts,now:()=>now});const req={auth:{uid,token:{}},data:{requestId:'closure_0123456789abcdef0123456789abcdef',...proof(uid,'closure_0123456789abcdef0123456789abcdef')}};const first=await handler(req);assert.equal(first.snapshot.reconciliation.balanceBefore,18);assert.equal(first.snapshot.reconciliation.settlementAmount,18);assert.equal(first.snapshot.reconciliation.balanceAfter,0);assert.equal(db._get('deudas_choferes','de1').remainingAmount,0);assert.equal(db._get('billing_records','settlement_closure_0123456789abcdef0123456789abcdef').amount,18);const closure=db._get('cierres_semanales','period_closure_0123456789abcdef0123456789abcdef');assert.equal(closure.closureMode,'on_demand');assert.equal(closure.balanceAfter,0);assert.equal(closure.liquidationProofRequired,true);assert.equal(closure.telegramDeliveryStatus,'disabled');assert.match(closure.proofPath,/cierres_semanales\/closure_/);assert.equal(first.snapshot.liquidationProof.required,true);const second=await handler(req);assert.equal(second.alreadyRegistered,true);assert.equal(db.store.get('cierres_semanales').size,1);now=12000;const third=await handler({auth:{uid,token:{}},data:{requestId:'closure_fedcba9876543210fedcba9876543210',...proof(uid,'closure_fedcba9876543210fedcba9876543210')}});assert.equal(third.noNewMovements,true);assert.equal(db.store.get('cierres_semanales').size,1);});

test('cierre exige comprobante y no toca la cuenta si falta',async()=>{
  const uid='u1',db=new DB(seed(uid));
  const handler=createClosePeriodHandler({
    db,bucket,businessId:'barberia-c25a1',options:{arcaEnabled:false,telegramEnabled:true},
    assertViewer:async()=>uid,getProfile:async()=>({data:()=>({displayName:'Agustin'})}),
    serverTimestamp:ts,now:()=>10000
  });
  await assert.rejects(
    ()=>handler({auth:{uid,token:{}},data:{requestId:'closure_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}}),
    error=>error?.code==='failed-precondition'
  );
  assert.equal(db.store.get('cierres_semanales').size,0);
  assert.equal(db._get('deudas_choferes','de1').remainingAmount,30);
});
