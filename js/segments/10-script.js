
  (()=>{
    "use strict";
    const ADMIN_ROLES=new Set(["admin","administrador","owner","superadmin"]);
    const DRIVER_ROLES=new Set(["chofer","driver"]);
    const friendly=Object.freeze({
      foto:"No pudimos actualizar tu foto. Intenta nuevamente.",
      comprobante:"No pudimos subir el comprobante. Revisa tu conexión e intenta nuevamente.",
      gasto:"No pudimos registrar el gasto. Revisa los datos e intenta nuevamente.",
      cobro:"No pudimos registrar el cobro. Intenta nuevamente.",
      cierre:"No pudimos completar el cierre semanal. Intenta nuevamente.",
      ranking:"No pudimos actualizar el ranking. Se mostrará la última información disponible.",
      prestamo:"No pudimos completar la operación. Intenta nuevamente.",
      derivacion:"No pudimos actualizar las derivaciones. Se mostrará la última información disponible.",
      navegacion:"No pudimos actualizar esta pantalla. Intenta nuevamente."
    });
    window.EXPLORA_PRODUCTION_MODE=true;
    let lastNotice={key:"",at:0};
    const detachedDiagnostics=new Map();
    function normalizedRole(){
      const candidates=[
        window.ExploraSession?.role,window.ExploraSession?.profile?.role,window.ExploraSession?.profile?.rol,
        window.ExploraAuthSession?.role,window.ExploraAuthSession?.profile?.role,window.ExploraAuthSession?.profile?.rol,
        window.exploraSession?.role,window.exploraSession?.profile?.role,window.exploraSession?.profile?.rol
      ];
      return String(candidates.find(Boolean)||"").trim().toLowerCase();
    }
    function isAdmin(){return ADMIN_ROLES.has(normalizedRole());}
    function isDriver(){const role=normalizedRole();return DRIVER_ROLES.has(role)||(!isAdmin()&&document.body.classList.contains("explora-authenticated"));}
    function canShowTechnicalDiagnostics(){return window.EXPLORA_PRODUCTION_MODE!==true||isAdmin();}
    function notify(action,message=""){
      const text=String(message||friendly[action]||friendly.navegacion);
      const key=`${action}|${text}`,now=Date.now();
      if(lastNotice.key===key&&now-lastNotice.at<1800)return text;
      lastNotice={key,at:now};
      const toast=document.getElementById("toast");
      if(toast){toast.textContent=text;toast.classList.add("show");clearTimeout(toast.__exploraTimer);toast.__exploraTimer=setTimeout(()=>toast.classList.remove("show"),3600);}
      return text;
    }
    function handle(action,error,options={}){
      const eventType=String(options.eventType||"ERROR").toUpperCase();
      try{(eventType==="WARNING"?console.warn:console.error)(`[EXPLORA ${action}]`,error,options.context||options);}catch(_){}
      if(canShowTechnicalDiagnostics())return true;
      if(options.silent!==true&&eventType!=="WARNING")notify(action,options.message);
      sanitizeDriverDiagnostics();
      return false;
    }
    function restoreAdminDiagnostics(){
      if(!isAdmin())return false;
      detachedDiagnostics.forEach((entry,id)=>{
        const {node,parent,next}=entry||{};
        if(node&&parent&&!node.isConnected){try{parent.insertBefore(node,next&&next.parentNode===parent?next:null);node.hidden=true;node.setAttribute("aria-hidden","true");}catch(error){console.warn(`[EXPLORA restore diagnostic ${id}]`,error);}}
      });
      detachedDiagnostics.clear();
      return true;
    }
    function sanitizeDriverDiagnostics(){
      if(!window.EXPLORA_PRODUCTION_MODE||!isDriver()||isAdmin())return false;
      ["expenseDiagnosticPanel","weeklyClosureDiagnostic","weeklySummaryDiagnosticBackdrop","performanceDiagnosticBackdrop","exploreLoanDiagnostic"].forEach(id=>{
        const node=document.getElementById(id);
        if(node){node.classList.remove("is-open","show");node.hidden=true;node.setAttribute("aria-hidden","true");detachedDiagnostics.set(id,{node,parent:node.parentNode,next:node.nextSibling});node.remove();}
      });
      ["performance-diagnostic","weekly-summary-diagnostic"].forEach(reason=>{try{window.unlockPageScroll?.(reason);}catch(_){}});
      return true;
    }
    function migrateUiCache(){
      const marker="explora.ui.migration.v251";
      try{if(localStorage.getItem(marker)==="1")return;[
        "billing_ranking","derivation_ranking","goal_bubbles","performance_bundle","rankingSnapshot"
      ].forEach(name=>window.ExploraFastCache?.invalidate?.(name));
      const stale=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key&&/^performanceRankingCache_/i.test(key))stale.push(key);}stale.forEach(key=>localStorage.removeItem(key));
      localStorage.setItem(marker,"1");}catch(error){console.warn("[EXPLORA cache migration v251]",error);}
    }
    window.ExploraProductionPolicy=Object.freeze({friendly,normalizedRole,isAdmin,isDriver,canShowTechnicalDiagnostics,notify,handle,sanitizeDriverDiagnostics,restoreAdminDiagnostics,migrateUiCache});
    const sync=()=>{migrateUiCache();if(isAdmin())restoreAdminDiagnostics();else sanitizeDriverDiagnostics();};
    document.addEventListener("DOMContentLoaded",sync,{once:true});
    window.addEventListener("explora:auth-ready",sync);
    window.addEventListener("explora:session-opened",sync);
    setTimeout(sync,0);setTimeout(sync,900);
  })();
  