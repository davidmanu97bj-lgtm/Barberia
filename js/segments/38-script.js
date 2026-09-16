
(()=>{
  "use strict";
  if(window.__exploraCycleHardReloadButtonV1)return;
  window.__exploraCycleHardReloadButtonV1=true;
  function hardReload(){
    try{window.ExploraIdleDashboardRestart?.save?.();}catch(_){}
    try{if(window.ExploraIdleDashboardRestart?.restart?.())return;}catch(_){}
    window.setTimeout(()=>window.location.reload(),80);
  }
  function init(){
    const button=document.getElementById("cycleHardReloadBtn");
    if(!button)return;
    button.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();hardReload();});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();
