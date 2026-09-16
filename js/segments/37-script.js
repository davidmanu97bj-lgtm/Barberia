
(()=>{
  "use strict";
  if(window.__exploraIdleDashboardRestartV2)return;
  window.__exploraIdleDashboardRestartV2=true;

  const IDLE_MS=120000;
  const CHECK_MS=5000;
  const STORAGE_KEY="explora:dashboard:last-valid:v2";
  const SHELL_KEY="explora:dashboard:stable-shell:v1";
  const RELOAD_GUARD_KEY="explora:dashboard:auto-reload-guard:v1";
  const MAX_SNAPSHOT_AGE_MS=24*60*60*1000;
  const MAX_SHELL_HTML_LENGTH=1500000;
  const TARGETS={
    performancePodium:"html",
    performanceDerivatorBody:"html",
    performanceGoalTrack:"html",
    dashboardWeeklyRevenue:"text",
    dashboardWeeklyRevenueMeta:"text",
    dashboardWeeklyExpenses:"text",
    dashboardWeeklyExpensesMeta:"text",
    dashboardReceiptsMeta:"text",
    dashboardExploreLoanMeta:"text",
    driverStatusCard:"html"
  };
  const TRANSIENT_RE=/calculando|cargando|sincronizando|actualizando|comprobando|espera un momento|todav[ií]a no hay choferes disponibles/i;
  const activityEvents=["pointerdown","touchstart","keydown","input","change","scroll","wheel"];
  let lastActivity=Date.now();
  let intervalId=0;
  let reloadScheduled=false;
  let observer=null;
  let saveTimer=0;
  let resumeRefreshInFlight=false;

  function node(id){return document.getElementById(id)}
  function isDashboardVisible(){
    const main=node("driverDashboardReal");
    if(main&&main.hidden)return false;
    if(document.body.classList.contains("explora-internal-screen-open"))return false;
    const blockers=[
      ".is-open:not(#dialogBackdrop)",
      "[aria-hidden='false'].vehicle-detail-screen",
      ".billing-form-backdrop.is-open",
      ".weekly-closure-overlay:not([hidden])",
      ".dialog-backdrop.open",
      ".admin-shared-screen[aria-hidden='false']"
    ];
    return !blockers.some(sel=>{try{return Boolean(document.querySelector(sel))}catch(_){return false}});
  }
  function hasUnsavedInteraction(){
    const active=document.activeElement;
    if(active&&/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))return true;
    return Boolean(document.querySelector("form input:not([type='hidden']):not(:disabled), form textarea:not(:disabled), .billing-form-backdrop.is-open, .expense-screen.is-open, .new-service-screen.is-open"));
  }
  function isValidValue(value){
    const clean=String(value||"").replace(/\s+/g," ").trim();
    return clean.length>0&&!TRANSIENT_RE.test(clean);
  }
  function collectSnapshot(){
    const data={savedAt:Date.now(),path:location.pathname,values:{}};
    let validPrimary=0;
    for(const [id,mode] of Object.entries(TARGETS)){
      const el=node(id);if(!el)continue;
      const value=mode==="text"?el.textContent:el.innerHTML;
      if(!isValidValue(value))continue;
      data.values[id]={mode,value};
      if(["performancePodium","performanceDerivatorBody","performanceGoalTrack"].includes(id))validPrimary++;
    }
    return validPrimary>=2?data:null;
  }
  function currentCachedUid(){
    try{return String(JSON.parse(localStorage.getItem("explora_sesion_nueva_last")||"{}").uid||"")}catch(_){return ""}
  }
  function collectStableShell(){
    const root=node("driverDashboardReal");
    if(!root||root.hidden)return null;
    const uid=String(window.ExploraSession?.authUser?.uid||window.ExploraFirebase?.auth?.currentUser?.uid||currentCachedUid());
    if(!uid)return null;
    const html=String(root.innerHTML||"");
    if(!html||html.length>MAX_SHELL_HTML_LENGTH)return null;
    return {uid,savedAt:Date.now(),html,scrollY:Math.max(0,Math.round(window.scrollY||0))};
  }
  function saveSnapshot(){
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{
      try{
        const data=collectSnapshot();
        if(data)localStorage.setItem(STORAGE_KEY,JSON.stringify({...data,uid:currentCachedUid()}));
        const shell=collectStableShell();
        if(shell)localStorage.setItem(SHELL_KEY,JSON.stringify(shell));
      }catch(_){}
    },180);
  }
  function discardStoredSnapshot(){
    try{localStorage.removeItem(STORAGE_KEY);localStorage.removeItem(SHELL_KEY)}catch(_){}
  }
  function restoreSnapshot(){
    try{
      const parsed=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");
      const uid=currentCachedUid();
      if(!parsed||!uid||String(parsed.uid||"")!==uid||Date.now()-Number(parsed.savedAt||0)>MAX_SNAPSHOT_AGE_MS)return false;
      for(const [id,item] of Object.entries(parsed.values||{})){
        const el=node(id);if(!el||!item)continue;
        if(item.mode==="text")el.textContent=item.value;else el.innerHTML=item.value;
      }
      return true;
    }catch(_){return false}
  }
  function mountStableShell(){
    try{
      const parsed=JSON.parse(localStorage.getItem(SHELL_KEY)||"null");
      const uid=currentCachedUid();
      if(!parsed||!uid||String(parsed.uid||"")!==uid||Date.now()-Number(parsed.savedAt||0)>MAX_SNAPSHOT_AGE_MS||!parsed.html)return false;
      const overlay=document.createElement("div");
      overlay.id="exploraStableStartupShell";
      overlay.setAttribute("aria-hidden","true");
      overlay.style.cssText="position:fixed;inset:0;z-index:2147483000;overflow:auto;background:#050505;pointer-events:none;opacity:1;transition:opacity .16s ease";
      const inner=document.createElement("div");
      inner.id="driverDashboardReal";
      inner.innerHTML=parsed.html;
      overlay.appendChild(inner);
      document.body.appendChild(overlay);
      requestAnimationFrame(()=>{overlay.scrollTop=Math.max(0,Number(parsed.scrollY||0))});
      document.body.classList.add("explora-splash-hidden");
      const splash=node("exploraSplash");if(splash)splash.style.display="none";
      window.__exploraStableStartupShellMounted=true;
      return true;
    }catch(_){return false}
  }
  function removeStableShell(){
    const overlay=node("exploraStableStartupShell");
    if(!overlay)return;
    overlay.style.opacity="0";
    setTimeout(()=>overlay.remove(),180);
    window.__exploraStableStartupShellMounted=false;
  }
  function noteActivity(){lastActivity=Date.now()}
  function canAutoReload(){
    if(reloadScheduled||!isDashboardVisible()||hasUnsavedInteraction())return false;
    if(document.body.classList.contains("is-scroll-locked"))return false;
    const session=window.ExploraSession||{};
    if(session.closing)return false;
    return true;
  }
  function autoReload(reason){
    if(!canAutoReload())return false;
    try{
      const last=Number(sessionStorage.getItem(RELOAD_GUARD_KEY)||0);
      if(Date.now()-last<45000)return false;
      saveSnapshot();
      const data=collectSnapshot();
      if(data)sessionStorage.setItem(STORAGE_KEY,JSON.stringify(data));
      sessionStorage.setItem(RELOAD_GUARD_KEY,String(Date.now()));
      sessionStorage.setItem("explora:dashboard:auto-reload-reason",String(reason||"idle"));
    }catch(_){}
    reloadScheduled=true;
    setTimeout(()=>location.reload(),120);
    return true;
  }
  async function refreshSessionWithoutReload(reason="resume"){
    if(resumeRefreshInFlight)return;
    const session=window.ExploraSession||{};
    if(!session.authUser?.uid&&!window.ExploraFirebase?.auth?.currentUser?.uid)return;
    resumeRefreshInFlight=true;
    // Al volver desde segundo plano mantenemos visible la última información y
    // refrescamos silenciosamente. No bloqueamos toda la app con el splash.
    const syncGate=null;
    const gateOpened=false;
    try{
      window.dispatchEvent(new CustomEvent("explora:app-resumed",{detail:{reason,reload:false,coveredUntilFresh:false,backgroundSync:true}}));
      const tasks=[];
      const globalRefresh=window.ExploraFirestoreGlobalSync?.refresh?.({reason:`${reason}-no-reload`});
      if(globalRefresh&&typeof globalRefresh.then==="function")tasks.push(globalRefresh);
      const isAdmin=String(session.role||"").toLowerCase().includes("admin")||document.body.classList.contains("explora-shared-admin");
      if(isAdmin){
        const adminRefresh=window.ExploraAdminShared?.refresh?.();
        if(adminRefresh&&typeof adminRefresh.then==="function")tasks.push(adminRefresh);
      }else{
        const weeklyRefresh=window.ExploraWeeklyEngine?.loadOnce?.({force:true,reason:`${reason}-no-reload`});
        if(weeklyRefresh&&typeof weeklyRefresh.then==="function")tasks.push(weeklyRefresh);
        const sessionRefresh=window.ExploraLoadWeeklySession?.({force:true,reason:`${reason}-no-reload`});
        if(sessionRefresh&&typeof sessionRefresh.then==="function")tasks.push(sessionRefresh);
      }
      syncGate?.update?.(58,"Consultando la información actual…");
      if(tasks.length)await Promise.allSettled(tasks);
      syncGate?.update?.(94,"Información actual lista…");
    }catch(error){
      console.warn("[EXPLORA_RESUME_REFRESH_WARN]",error?.code||error?.message||error);
    }finally{
      if(gateOpened||syncGate?.isActive?.())await Promise.resolve(syncGate?.finish?.()).catch(()=>{});
      resumeRefreshInFlight=false;
    }
  }
  function checkIdle(){
    if(Date.now()-lastActivity<IDLE_MS)return;
    // La app ya no se recarga por inactividad. Sólo conserva una copia visual.
    saveSnapshot();
    lastActivity=Date.now();
  }
  function coverAuthenticatedDashboardForResume(){
    // La aplicación conserva la última pantalla al pasar a segundo plano.
    // La actualización se realiza al regresar sin cubrir ni bloquear el menú.
    return false;
  }
  function onVisibilityChange(){
    if(document.visibilityState==="hidden"){
      coverAuthenticatedDashboardForResume();
      saveSnapshot();
      return;
    }
    const hiddenAt=Number(sessionStorage.getItem("explora:dashboard:hidden-at")||0);
    const elapsed=hiddenAt?Date.now()-hiddenAt:0;
    if(hiddenAt&&elapsed>=15000)refreshSessionWithoutReload("resume-after-background");
    else if(window.ExploraDataSyncGate?.isActive?.())Promise.resolve(window.ExploraDataSyncGate.finish()).catch(()=>{});
    noteActivity();
  }
  function onPageHide(){
    coverAuthenticatedDashboardForResume();
    saveSnapshot();
    try{sessionStorage.setItem("explora:dashboard:hidden-at",String(Date.now()))}catch(_){}
  }
  function startObserver(){
    const roots=[node("weeklyRankingLive"),node("performanceGoalViewport"),node("driverStatusCard")].filter(Boolean);
    if(!roots.length)return;
    observer=new MutationObserver(()=>saveSnapshot());
    roots.forEach(root=>observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["hidden","class","data-status"]}));
  }
  function init(){
    mountStableShell();
    activityEvents.forEach(name=>window.addEventListener(name,noteActivity,{passive:true,capture:true}));
    document.addEventListener("visibilitychange",()=>{
      if(document.visibilityState==="hidden"){
        try{sessionStorage.setItem("explora:dashboard:hidden-at",String(Date.now()))}catch(_){}
      }
      onVisibilityChange();
    },true);
    window.addEventListener("pagehide",onPageHide,{capture:true});
    window.addEventListener("beforeunload",saveSnapshot,{capture:true});
    window.addEventListener("pageshow",event=>{
      if(event.persisted)refreshSessionWithoutReload("pageshow-bfcache");
    });
    window.addEventListener("explora:auth-ready",()=>{
      saveSnapshot();
      setTimeout(removeStableShell,120);
    });
    window.addEventListener("explora:session-opened",()=>setTimeout(removeStableShell,120));
    setTimeout(removeStableShell,15000);
    startObserver();
    intervalId=window.setInterval(checkIdle,CHECK_MS);
    window.ExploraIdleDashboardRestart={
      version:"2.0.0",
      idleMs:IDLE_MS,
      save:saveSnapshot,
      restore:restoreSnapshot,
      restart:()=>autoReload("manual-api"),
      refresh:refreshSessionWithoutReload,
      resetActivity:noteActivity,
      stop:()=>{clearInterval(intervalId);observer?.disconnect?.();}
    };
    saveSnapshot();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})();
