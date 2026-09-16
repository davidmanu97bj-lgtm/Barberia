
(()=>{
  "use strict";
  if(window.ExploraFastCache)return;
  const VERSION=225;
  const PREFIX="explora_fast_cache_v225";
  const TTL=Object.freeze({
    dashboard_weekly_billing:300000,
    dashboard_weekly_expenses:300000,
    billing_ranking:600000,
    derivation_ranking:600000,
    goal_bubbles:300000,
    dashboard_notice:120000,
    admin_summary:300000,
    driver_profiles:1800000
  });
  const memory=new Map();
  const locks=new Map();
  const requestIds=new Map();
  const refreshers=new Map();
  const stats={hits:0,misses:0,writes:0,staleHits:0,refreshes:0,discarded:0};
  let scheduler=0;
  const norm=value=>String(value??"").trim().toLowerCase();
  function derivePeriods(){
    const operational=window.ExploraOperationalClock?.getActiveWeeklyPeriod?.()||{};
    const external=window.ExploraPeriods?.getActivePeriods?.()||{};
    const weeklyExternal=window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.()||{};
    const registry=window.ExploraWeeklyPeriods?.active?.()||{};
    return{weeklyPeriodId:String(operational.id||external.weeklyPeriodId||weeklyExternal.id||registry.id||"")};
  }
  function context(overrides={}){
    const periods=derivePeriods();
    const session=window.ExploraSession||window.ExploraAuthSession||{};
    const authUser=session.authUser||session.authenticatedUser||null;
    return{
      uid:String(overrides.uid||authUser?.uid||session.uid||"").trim(),
      role:norm(overrides.role||session.role||(document.body.classList.contains("explora-shared-admin")?"admin":"chofer"))||"guest",
      weeklyPeriodId:String(overrides.weeklyPeriodId||periods.weeklyPeriodId||"").trim()
    };
  }
  function storageKey(moduleName,ctx={}){
    const c=context(ctx);return[PREFIX,VERSION,moduleName||"unknown",c.uid||"anonymous",c.role,c.weeklyPeriodId||"no-week"].join("::");
  }
  function clone(value){try{return JSON.parse(JSON.stringify(value));}catch(_){return value;}}
  function readEntry(moduleName,ctx={}){
    const key=storageKey(moduleName,ctx);
    if(memory.has(key))return memory.get(key);
    try{const raw=localStorage.getItem(key);if(!raw)return null;const entry=JSON.parse(raw);if(!entry||entry.version!==VERSION)return null;memory.set(key,entry);return entry;}catch(_){return null;}
  }
  function get(moduleName,ctx={},options={}){
    const entry=readEntry(moduleName,ctx);if(!entry){stats.misses++;return null;}
    const ttl=Number(options.ttl??entry.ttl??TTL[moduleName]??300000),age=Math.max(0,Date.now()-Number(entry.savedAt||0)),expired=age>ttl;
    if(expired&&!options.allowStale){stats.misses++;return null;}
    stats.hits++;if(expired)stats.staleHits++;
    return{data:clone(entry.data),savedAt:entry.savedAt,ttl,age,expired,source:memory.has(storageKey(moduleName,ctx))?"memory":"localStorage",context:entry.context||context(ctx)};
  }
  function set(moduleName,data,ctx={},options={}){
    if(!moduleName||data==null)return null;
    const key=storageKey(moduleName,ctx),entry={version:VERSION,moduleName,data:clone(data),savedAt:Date.now(),ttl:Number(options.ttl??TTL[moduleName]??300000),context:context(ctx)};
    memory.set(key,entry);stats.writes++;
    try{localStorage.setItem(key,JSON.stringify(entry));}catch(error){try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k?.startsWith(PREFIX)&&k!==key){localStorage.removeItem(k);break;}}localStorage.setItem(key,JSON.stringify(entry));}catch(_){}}
    return entry;
  }
  function invalidate(moduleName,ctx={}){const key=storageKey(moduleName,ctx);memory.delete(key);try{localStorage.removeItem(key);}catch(_){};}
  function clearOperational(){
    memory.clear();locks.clear();requestIds.clear();let removed=0;
    const removeMatching=(storageObject,predicate)=>{try{const keys=[];for(let i=0;i<storageObject.length;i++){const key=storageObject.key(i);if(key&&predicate(key))keys.push(key);}keys.forEach(key=>{storageObject.removeItem(key);removed+=1;});}catch(_){}};
    removeMatching(localStorage,key=>key.startsWith(PREFIX)||key.startsWith("explora_performance_history_")||key.startsWith("explora.dashboard.notice."));
    removeMatching(sessionStorage,key=>key.startsWith("explora_fast_cache_slow")||key.startsWith("explora_weekly_v")||key.startsWith("explora_closure_v")||key.startsWith("explora_diag_")||key.startsWith("explora_sim_diag_"));
    return removed;
  }
  function isFresh(moduleName,ctx={}){const entry=get(moduleName,ctx,{allowStale:true});return Boolean(entry&&!entry.expired);}
  function reportSlow(moduleName,details={}){
    const elapsed=Math.max(0,Math.round(details.elapsed||0));
    const background=details.background!==false;
    const cacheHit=details.cacheHit===true;
    const code=`FAST_CACHE_${String(moduleName).toUpperCase()}_SLOW`;
    const payload={
      moduleName,
      code,
      functionName:details.functionName||"ExploraFastCache.run",
      executionMs:elapsed,
      cacheHit,
      cacheMiss:!cacheHit,
      ttl:details.ttl??TTL[moduleName]??"—",
      refreshBackground:background,
      query:details.query||"—",
      firestorePath:details.firestorePath||"—",
      documentsRead:details.documentsRead??"—",
      listenersActive:details.listenersActive??"—",
      weeklyPeriodId:details.context?.weeklyPeriodId,
      timestamp:new Date().toISOString()
    };

    /* Un refresco lento en segundo plano no es un error funcional.
       Se conserva como telemetría técnica sin bloquear ni cubrir el dashboard. */
    try{
      const key=["explora_fast_cache_slow",moduleName,details.context?.uid||"anonymous",details.context?.weeklyPeriodId||""].join("::");
      sessionStorage.setItem(key,JSON.stringify(payload));
    }catch(_){}
    try{window.dispatchEvent(new CustomEvent("explora:fast-cache-slow",{detail:payload}));}catch(_){}
    console.warn("[EXPLORA FastCache] refresco lento no crítico",payload);

    if(background||cacheHit||details.visibleDiagnostic!==true)return payload;

    const error=Object.assign(new Error(`El módulo ${moduleName} superó ${elapsed||3000} ms durante una carga bloqueante.`),{code:"FAST_CACHE_FOREGROUND_SLOW"});
    if(window.ExploraPerformanceEngine?.showDiagnostic){
      window.ExploraPerformanceEngine.showDiagnostic("INIT",code,error,payload);
    }else{
      window.__exploraPendingGoalDiagnostic={stage:"INIT",code,error,context:payload};
    }
    return payload;
  }
  function run(moduleName,task,ctx={},options={}){
    const c=context(ctx),key=options.lockKey||storageKey(moduleName,c);
    if(locks.has(key))return locks.get(key);
    const requestId=(requestIds.get(key)||0)+1;requestIds.set(key,requestId);stats.refreshes++;
    const started=performance.now();let done=false;
    const cached=get(moduleName,c,{allowStale:true});
    const background=options.background!==false;
    const slowThresholdMs=Math.max(3000,Number(options.slowThresholdMs??(background?8000:3000))||3000);
    const timer=setTimeout(()=>{if(!done)reportSlow(moduleName,{...options,background,elapsed:performance.now()-started,cacheHit:Boolean(cached),ttl:options.ttl??TTL[moduleName],context:c});},slowThresholdMs);
    const promise=Promise.resolve().then(()=>task({requestId,context:c,isCurrent:()=>requestIds.get(key)===requestId,cached})).then(result=>{
      if(requestIds.get(key)!==requestId){stats.discarded++;return options.staleValue;}
      return result;
    }).finally(()=>{done=true;clearTimeout(timer);locks.delete(key);});
    locks.set(key,promise);return promise;
  }
  function registerRefresher(moduleName,fn,options={}){if(typeof fn!=="function")return()=>{};refreshers.set(moduleName,{fn,ttl:Number(options.ttl??TTL[moduleName]??300000),context:options.context||{},lockKey:options.lockKey||""});ensureScheduler();return()=>refreshers.delete(moduleName);}
  async function refreshExpired({force=false,modules=null}={}){
    if(document.visibilityState==="hidden")return[];
    const selected=modules?new Set(modules):null,tasks=[];
    for(const [moduleName,item] of refreshers){if(selected&&!selected.has(moduleName))continue;const ctx=typeof item.context==="function"?item.context():item.context;const entry=get(moduleName,ctx,{allowStale:true});if(!force&&entry&&!entry.expired)continue;tasks.push(run(moduleName,()=>item.fn({moduleName,cacheEntry:entry,force}),ctx,{ttl:item.ttl,lockKey:item.lockKey||undefined,background:true,functionName:"scheduledRefresh"}).catch(()=>null));}
    return Promise.all(tasks);
  }
  function ensureScheduler(){if(scheduler)return;scheduler=setInterval(()=>{if(document.visibilityState==="visible")refreshExpired().catch(()=>{});},60000);}
  function money(value){try{return new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(Math.round(Number(value||0)));}catch(_){return`$${Math.round(Number(value||0))}`;}}
  function text(id,value){const el=document.getElementById(id);if(el&&el.textContent!==String(value))el.textContent=String(value);}
  function renderWeeklySnapshot(snapshot={}){
    if(document.body.classList.contains("explora-shared-admin"))return false;
    requestAnimationFrame(()=>{
      text("dashboardWeeklyRevenue",money(snapshot.grossBilling||0));
      text("dashboardWeeklyRevenueMeta","Esta semana");
      text("dashboardWeeklyExpenses",money(snapshot.totalExpenses||0));
      text("dashboardWeeklyExpensesMeta","Esta semana");
      text("dashboardTripsCount",Number(snapshot.serviceCount||snapshot.billingCount||0));
      text("dashboardExpenseCount",Number(snapshot.expenseCount||0));
      const card=document.getElementById("dashboardWeeklyBillingCard");if(card)card.dataset.billingState="ready";
    });return true;
  }
  function renderAdminOverview(overview={}){
    if(!document.body.classList.contains("explora-shared-admin"))return false;
    requestAnimationFrame(()=>{
      text("dashboardWeeklyRevenue",money(overview.totalAdminWeeklyIncome??overview.totalBilling??0));
      text("dashboardWeeklyRevenueMeta",`Servicios ${money(overview.totalBilling||0)} + colaboración ${money(overview.totalCollaborations||0)}`);
      text("dashboardWeeklyExpenses",money(overview.totalExpenses||0));
      text("dashboardWeeklyExpensesMeta",`${Number(overview.driversWithExpenses||0)} choferes con gastos`);
      text("dashboardTripsCount",Number(overview.drivers?.length||overview.driverCount||0));
      text("dashboardReceiptsCount",Number(overview.pendingDriverReceipts||0)+Number(overview.pendingAdminReceipts||0));
      text("dashboardExpenseCount",Number(overview.totalExpenseCount||0));
      text("dashboardWeeklyGoal",Number(overview.balancedClosures||0));
    });return true;
  }
  function hydrateDashboard(overrides={}){
    const c=context(overrides),admin=c.role.includes("admin");
    if(admin){const entry=get("admin_summary",c,{allowStale:false});if(entry?.data)return renderAdminOverview(entry.data);return false;}
    const billing=get("dashboard_weekly_billing",c,{allowStale:false}),expenses=get("dashboard_weekly_expenses",c,{allowStale:false}),data=billing?.data||expenses?.data;
    if(data)return renderWeeklySnapshot(data);return false;
  }
  function prefetchForSession(detail={}){
    // La primera pintura ya fue sincronizada por el módulo de sesión. No se
    // hidrata automáticamente desde localStorage para evitar datos anteriores.
    if(window.ExploraDashboardRealtimeCoordinator){window.ExploraDashboardRealtimeCoordinator.ensure?.("fast-cache-session");return;}
    queueMicrotask(()=>refreshExpired({force:false}).catch(()=>{}));
  }
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState!=="visible")return;if(window.ExploraDashboardRealtimeCoordinator){window.ExploraDashboardRealtimeCoordinator.ensure?.("fast-cache-foreground");return;}refreshExpired().catch(()=>{});});
  window.addEventListener("explora:session-opened",event=>prefetchForSession(event.detail||{}));
  window.addEventListener("explora:weekly-summary",event=>{const snapshot=event.detail||{};const activeWeeklyId=window.ExploraOperationalClock?.getActiveWeeklyPeriod?.()?.id||window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.()?.id||"";if(snapshot.loading||!snapshot.uid||!snapshot.weeklyPeriodId||(activeWeeklyId&&snapshot.weeklyPeriodId!==activeWeeklyId))return;const c={uid:snapshot.uid,role:"chofer",weeklyPeriodId:snapshot.weeklyPeriodId};set("dashboard_weekly_billing",snapshot,c);set("dashboard_weekly_expenses",snapshot,c);if(window.ExploraDashboardRealtimeCoordinator?.isCoordinating?.())return;renderWeeklySnapshot(snapshot);});
  window.addEventListener("explora:auth-cleared",()=>{locks.clear();requestIds.clear();});
  document.addEventListener("DOMContentLoaded",()=>{ensureScheduler();});
  window.ExploraFastCache=Object.freeze({VERSION,TTL,context,key:storageKey,get,set,invalidate,clearOperational,isFresh,run,registerRefresher,refreshExpired,hydrateDashboard,renderWeeklySnapshot,renderAdminOverview,prefetchForSession,getStats:()=>({...stats,locks:locks.size,refreshers:refreshers.size})});
})();
