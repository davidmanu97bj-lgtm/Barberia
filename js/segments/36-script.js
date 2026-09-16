
(()=>{
  "use strict";
  if(window.__exploraChromiumAuditRepairRuntimeV284)return;
  window.__exploraChromiumAuditRepairRuntimeV284=true;

  const ignoredIds=new Set(["exploraLoginScreen","exploraSplash","exploraRoleBlocked"]);
  const candidates=()=>document.querySelectorAll('[id$="Screen"],[id$="Overlay"],[id$="Backdrop"],.weekly-closure-overlay');
  function visibleSurface(el){
    if(!el||ignoredIds.has(el.id)||el.hidden)return false;
    if(el.id==="weeklyClosureOverlay")return el.getAttribute("aria-hidden")!=="true";
    return el.classList.contains("is-open")||el.classList.contains("open")||el.getAttribute("aria-hidden")==="false";
  }
  function reconcile(){
    const internal=[...candidates()].some(visibleSurface);
    document.body.classList.toggle("explora-internal-screen-open",internal);
    if(!internal&&document.body.classList.contains("is-scroll-locked"))window.ExploraScroll?.reconcile?.();
    return {internal,scrollLocked:document.body.classList.contains("is-scroll-locked"),lockReasons:window.ExploraScroll?.reasons||[]};
  }
  let queued=false;
  const queue=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;reconcile();});};
  const observer=new MutationObserver(queue);
  observer.observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:["class","hidden","aria-hidden"]});
  window.addEventListener("explora:session-opened",()=>{window.unlockAllPageScroll?.();queue();});
  window.addEventListener("pageshow",queue);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")queue();});
  window.ExploraAuditRuntime=Object.freeze({reconcile,getState:reconcile});
  queue();
})();
