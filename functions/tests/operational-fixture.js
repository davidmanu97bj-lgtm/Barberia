'use strict';
const {createOperationalHandler,SaveError}=require('../operational-save');
function fixture() {
  const state={records:new Map(),files:new Map(),writes:0,reads:0,downloads:0,disabled:false,failWrite:false,failRead:false,now:Date.UTC(2026,8,15,12,0,0),afterCommitFailure:false};
  let serial=Promise.resolve(),nextId=1;
  const copy=row=>row?structuredClone(row):row;
  function doc(collection,id) {return {id,path:collection+'/'+id,get:async()=>snapshot({id,path:collection+'/'+id},state.records)};}
  function snapshot(ref,data) { if(state.failRead)throw Error('forced read failure'); state.reads++;return {id:ref.id,exists:data.has(ref.path),data:()=>copy(data.get(ref.path)),ref}; }
  function query(collection,filters=[],cap=Infinity) {return {collection,filters,cap,
    doc:(id=String(nextId++))=>doc(collection,id),
    where:(field,op,value)=>{if(op!=='==')throw Error('unsupported');return query(collection,[...filters,{field,value}],cap);},
    limit:value=>query(collection,filters,value),
    get:async()=>querySnapshot({collection,filters,cap},state.records)};}
  function querySnapshot(q,data) {
    if(state.failRead)throw Error('forced read failure');state.reads++;
    const found=[...data].filter(([p,row])=>p.startsWith(q.collection+'/')&&!p.slice(q.collection.length+1).includes('/')&&q.filters.every(f=>row[f.field]===f.value)).slice(0,q.cap);
    return {empty:!found.length,docs:found.map(([path])=>snapshot({path,id:path.split('/')[1]},data))};
  }
  const db={collection:name=>query(name),runTransaction:fn=>{
    const result=serial.then(async()=>{
      const writes=[],current=new Map([...state.records].map(([k,v])=>[k,copy(v)]));let hasWrite=false;
      const tx={get:async ref=>{if(hasWrite)throw Error('read after write');return ref.collection?querySnapshot(ref,current):snapshot(ref,current);},
        create:(ref,row)=>{hasWrite=true;if(current.has(ref.path))throw Error('already exists');writes.push(()=>current.set(ref.path,copy(row)));},
        update:(ref,row)=>{hasWrite=true;if(!current.has(ref.path))throw Error('missing');writes.push(()=>current.set(ref.path,{...current.get(ref.path),...copy(row)}));}};
      const value=await fn(tx);if(writes.length&&state.failWrite)throw Object.assign(Error('forced transaction abort'),{code:'aborted'});
      writes.forEach(write=>write());if(writes.length){state.records=current;state.writes+=writes.length;}
      if(writes.length&&state.afterCommitFailure){state.afterCommitFailure=false;throw Object.assign(Error('ack lost'),{code:'unavailable'});}
      return value;
    });serial=result.catch(()=>{});return result;
  }};
  const bucket={name:'barberia-c25a1.firebasestorage.app',file:path=>({getMetadata:async()=>{
    const file=state.files.get(path);if(!file)throw Object.assign(Error('missing file'),{code:404});return [{contentType:file.mime,size:file.bytes.length,metadata:{firebaseStorageDownloadTokens:'local-test-token'}}];
  },download:async()=>{state.downloads++;return [state.files.get(path).bytes.subarray(0,5)];}})};
  const handler=createOperationalHandler({db,bucket,businessId:'barberia-c25a1',options:state.options={arcaEnabled:false},
    assertViewer:async req=>{if(state.disabled||!['test-driver','other-driver'].includes(req.auth.uid))throw new SaveError('permission-denied','inactive');return req.auth.uid;},
    getProfile:async uid=>({data:()=>({nombre:uid})}),serverTimestamp:()=>({seconds:state.now/1000,nanoseconds:0}),now:()=>state.now});
  function request(kind='cash',overrides={},uid='test-driver') {
    const prefix=kind==='expense'?'expense':kind==='debt'?'driver_debt':'payment',id=prefix+'_'+(nextId++).toString(16).padStart(32,'0');
    const data={action:'save',kind,operationId:id,fingerprint:'sha256_'+'c'.repeat(64),amount:50000,detail:'Prueba local',createdAtMs:state.now,...overrides};
    if(kind==='cash'||kind==='digital')data.invoiceRequest=overrides.invoiceRequest||{version:'arca_c_v1',serviceDate:'2026-09-15',origin:'Aeropuerto',destination:'Terminal',distanceKm:20,scope:'national',paymentChannel:kind==='cash'?'cash':'transfer',customer:{}};
    else data.expenseType=overrides.expenseType|| (kind==='debt'?'multa':'combustible');
    if(kind!=='cash'){
      const base=(kind==='digital'?'billing_receipts':kind==='debt'?'deudas':'gastos')+'/'+uid+'/'+data.operationId+'/';
      data.proofPath=overrides.proofPath||base+'P-test.pdf';data.telegramPhotoPath=overrides.telegramPhotoPath||base+'imagen.jpg';
      const url=path=>`https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=local-test-token`;
      data.proofUrl=overrides.proofUrl||url(data.proofPath);data.telegramPhotoUrl=overrides.telegramPhotoUrl||url(data.telegramPhotoPath);
      state.files.set(data.proofPath,{mime:'application/pdf',bytes:Buffer.from('%PDF-1.4 local test')});
      state.files.set(data.telegramPhotoPath,{mime:'image/jpeg',bytes:Buffer.from([255,216,255,224,0,1])});
    }
    return {auth:{uid,token:{}},data};
  }
  return {state,db,bucket,handler,request};
}
module.exports={fixture};
