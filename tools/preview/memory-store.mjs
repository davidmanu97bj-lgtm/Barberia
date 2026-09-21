// Small transactional store for offline preview and service tests; never connects Firebase.
export class MemoryStore {
  constructor(seed={}) { this.data=new Map(Object.entries(seed)); this.queue=Promise.resolve(); }
  snapshot(path) { const data=this.data.get(path);return {id:path.split('/').at(-1),exists:data!==undefined,data:()=>data===undefined?undefined:structuredClone(data),ref:this.reference(path)}; }
  reference(path,conditions=[]) {
    const store=this;
    return {path,id:path.split('/').at(-1),conditions,
      doc(id=crypto.randomUUID()){return store.reference(path+'/'+id);},
      where(field,op,value){return store.reference(path,[...conditions,{field,op,value}]);},
      limit(count){return store.reference(path,[...conditions,{count}]);},
      async get(){return store.read(this);}};
  }
  collection(path){return this.reference(path);}
  read(target) {
    if(target.path.split('/').length%2===0) return this.snapshot(target.path);
    let docs=[...this.data.keys()].filter(path=>path.startsWith(target.path+'/')&&path.split('/').length===target.path.split('/').length+1).map(path=>this.snapshot(path));
    for(const condition of target.conditions||[]) {
      if(condition.count) docs=docs.slice(0,condition.count);
      else docs=docs.filter(snap=>snap.data()[condition.field]===condition.value);
    }
    return {docs,empty:!docs.length,size:docs.length};
  }
  runTransaction(callback) {
    const run=async()=>{const writes=[];const tx={get:async target=>this.read(target),set:(ref,data,options)=>writes.push({ref,data,options}),create:(ref,data)=>{if(this.data.has(ref.path))throw new Error('exists');writes.push({ref,data});},update:(ref,data)=>writes.push({ref,data,options:{merge:true}})};
      const result=await callback(tx);for(const {ref,data,options} of writes)this.data.set(ref.path,options?.merge?{...this.data.get(ref.path),...data}:data);return result;};
    const promise=this.queue.then(run,run);this.queue=promise.catch(()=>{});return promise;
  }
}
