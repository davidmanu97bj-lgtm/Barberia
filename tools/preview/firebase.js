// Served ONLY by preview.mjs. All traffic stays on the local preview origin.
const listeners = new Set(), authListeners = new Set();
const user = {uid:'preview-driver',email:'prueba@explora.local',displayName:'Chofer de prueba',getIdToken:async()=> 'local-only'};
const auth = {currentUser:sessionStorage.getItem('explora-preview-signed-out') ? null : user,authStateReady:async()=>{}};
export const browserLocalPersistence={},indexedDBLocalPersistence={},browserSessionPersistence={},inMemoryPersistence={};
export const initializeApp = () => ({name:'LOCAL_PREVIEW'});
export const initializeAuth = () => auth;
export const initializeFirestore = () => ({path:''});
export const getStorage = () => ({}), getFunctions = () => ({});
export const onAuthStateChanged = (_,callback) => { authListeners.add(callback); queueMicrotask(()=>callback(auth.currentUser)); return ()=>authListeners.delete(callback); };
export async function signInWithEmailAndPassword(_,email,password) {
  if (email !== 'prueba@explora.local' || password !== 'explora-prueba') throw new Error('UsÃ¡ prueba / explora-prueba en esta vista local.');
  sessionStorage.removeItem('explora-preview-signed-out'); auth.currentUser=user;
  for(const callback of authListeners) await callback(user);
  return {user};
}
export async function signOut() { sessionStorage.setItem('explora-preview-signed-out','1'); auth.currentUser=null; for(const callback of authListeners) await callback(null); }
export const collection = (parent,...parts) => ({path:[parent.path,...parts].filter(Boolean).join('/'),kind:'collection'});
export const doc = (parent,...parts) => ({path:[parent.path,...parts].filter(Boolean).join('/')+(parts.length ? '' : '/'+crypto.randomUUID()),kind:'doc',get id(){return this.path.split('/').at(-1);}});
export const where = (field,op,value) => ({type:'where',field,op,value});
export const or = (...conditions) => ({type:'or',conditions});
export const orderBy = (field,direction) => ({type:'order',field,direction});
export const limit = (count) => ({type:'limit',count});
export const query = (source,...conditions) => ({...source,conditions});
export const serverTimestamp = () => ({seconds:Math.floor(Date.now()/1000),nanoseconds:0});
export const deleteField = () => null;
async function local(action,input={}) {
  const response=await fetch('/__preview__/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...input})});
  const body=await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error),{code:body.code});
  return body;
}
function snapshot(path,data) { return {id:path.split('/').at(-1),ref:{path},exists:()=> data !== null,data:()=>data,metadata:{fromCache:false,hasPendingWrites:false}}; }
export async function getDoc(target) { return snapshot(target.path,(await local('get',{target})).data); }
export const getDocFromServer = getDoc;
export async function getDocs(target) {
  const rows=(await local('list',{target})).rows;
  const docs=rows.map(row=>snapshot(row.path,row.data));
  return {docs,empty:!docs.length,size:docs.length,forEach:fn=>docs.forEach(fn),metadata:{fromCache:false,hasPendingWrites:false},docChanges:()=>docs.map(doc=>({type:'modified',doc}))};
}
export function onSnapshot(target,...args) {
  const callback=args.find(value=>typeof value==='function'), error=args.filter(value=>typeof value==='function')[1];
  let active=true;
  const update=async()=>{try{const snap=await (target.kind==='doc'?getDoc(target):getDocs(target));if(active)callback(snap);}catch(e){error?.(e);}};
  listeners.add(update);update();return()=>{active=false;listeners.delete(update);};
}
export const onSnapshotsInSync = () => () => {};
async function notify(){await Promise.all([...listeners].map(callback=>callback()));}
export async function setDoc(target,data,options) { await local('set',{target,data,options}); await notify(); }
export async function addDoc(target,data) { const reference=doc(target);await setDoc(reference,data);return reference; }
export function writeBatch() { const writes=[];return {set:(target,data,options)=>writes.push({target,data,options}),update:(target,data)=>writes.push({target,data,options:{merge:true}}),delete:target=>writes.push({target,remove:true}),commit:async()=>{await local('writes',{writes});await notify();}}; }
let transactionQueue=Promise.resolve();
export function runTransaction(_,callback) {
  const run=async()=>{const batch=writeBatch();const result=await callback({...batch,get:getDoc});await batch.commit();return result;};
  const promise=transactionQueue.then(run,run);transactionQueue=promise.catch(()=>{});return promise;
}
export const ref = (_,path) => ({path});
const uploaded = new Map();
export async function uploadBytes(reference,file) {
  if (window.__previewFailUpload) throw new Error('Fallo de carga de prueba. ReintentÃ¡.');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
  uploaded.set(reference.path,data);
  await local('upload',{path:reference.path,contentType:file.type,size:file.size,data});
  return {ref:reference};
}
export async function getDownloadURL(reference) { return uploaded.get(reference.path) || '/__preview__/proof.svg'; }
export const httpsCallable = (_,name) => async input => {const data=await local('call',{name,input});if(name==='confirmPeriodClosure')await notify();return {data};};
