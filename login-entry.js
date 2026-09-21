import {auth,authReady} from './auth-session.js?v=20260914-web-only-1';

// Paint the signed-out screen without waiting for the dashboard's SDKs/modules.
// Authentication and profile checks still belong to the existing login handler.
export function mountEarlyLogin({document,auth,authReady,MutationObserver}) {
  if(document.documentElement.dataset.exploraAppReady==='true')return;
  let form=null,queued=false,ready=false,observer=null;
  function pendingSubmit(event){
    if(ready)return;
    event.preventDefault();event.stopImmediatePropagation();queued=true;
    const button=document.getElementById('loginBtn');button.disabled=true;button.textContent='Ingresando…';
  }
  function handoff(){
    ready=true;observer?.disconnect();
    form?.removeEventListener('submit',pendingSubmit,true);
    if(queued){
      const button=document.getElementById('loginBtn');button.disabled=false;button.textContent='Ingresar';
      form.requestSubmit();
    }
  }
  document.addEventListener('explora:app-ready',handoff,{once:true});
  function attach(){
    if(ready)return true;
    form=document.getElementById('loginForm');
    if(!form||!document.getElementById('loginBtn')||!document.getElementById('app'))return false;
    form.addEventListener('submit',pendingSubmit,true);
    Promise.resolve(authReady).then(()=>{
      if(ready||auth.currentUser)return;
      document.getElementById('loginScreen').classList.remove('hidden');
      document.getElementById('splashScreen').classList.add('hidden');
      document.getElementById('app').classList.add('hidden');
      document.documentElement.dataset.exploraLoginVisible='true';
    }).catch(()=>{});
    return true;
  }
  if(!attach()){
    observer=new MutationObserver(()=>{if(attach())observer.disconnect();});
    observer.observe(document.documentElement,{childList:true,subtree:true});
  }
}
mountEarlyLogin({document,auth,authReady,MutationObserver});
