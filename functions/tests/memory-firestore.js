'use strict';
// Serial transactions with commit/rollback, enough for financial concurrency tests.
module.exports = function memoryFirestore() {
  const data = new Map(); let pending = Promise.resolve(), serial = 0;
  const snapshot = ref => ({id:ref.id,exists:data.has(ref.path),data:()=>data.get(ref.path),ref});
  const collection = name => ({
    doc:(id=String(++serial))=>{const ref={id,path:`${name}/${id}`}; ref.get=async()=>snapshot(ref); return ref;},
    where:(field,op,value)=>({collection:name,field,value})
  });
  return {data,collection,runTransaction:fn=>{
    const result=pending.then(async()=>{
      const writes=[];
      const value=await fn({
        get:async ref=>ref.collection ? {docs:[...data.entries()].filter(([key,row])=>key.startsWith(ref.collection+'/') && row[ref.field]===ref.value).map(([key])=>snapshot(collection(ref.collection).doc(key.split('/')[1])))} : snapshot(ref),
        set:(ref,row,options)=>writes.push(()=>data.set(ref.path,options?.merge ? {...data.get(ref.path),...row} : row)),
        create:(ref,row)=>{if(data.has(ref.path))throw Error('already exists');writes.push(()=>data.set(ref.path,row));},
        update:(ref,row)=>{if(!data.has(ref.path))throw Error('not found');writes.push(()=>data.set(ref.path,{...data.get(ref.path),...row}));},
        delete:ref=>writes.push(()=>data.delete(ref.path))
      });
      writes.forEach(write=>write()); return value;
    });
    pending=result.catch(()=>{}); return result;
  }};
};
