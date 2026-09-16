
(()=>{"use strict";
  if(window.__exploraGlobalClockAppWideV291)return;
  window.__exploraGlobalClockAppWideV291=true;
  const TZ="America/Argentina/Cordoba";
  const $=id=>document.getElementById(id);
  const clock=()=>window.ExploraOperationalClock;
  const now=()=>clock()?.getNow?.()||new Date();
  const isTest=()=>clock()?.isTestMode?.()===true;
  const isAdmin=()=>document.body.classList.contains("explora-shared-admin")||String(window.ExploraSession?.role||"").toLowerCase().includes("admin");
  const longDate=d=>new Intl.DateTimeFormat("es-AR",{timeZone:TZ,weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(d).replace(/^\w/,c=>c.toUpperCase());
  const greeting=d=>{const h=Number(new Intl.DateTimeFormat("es-AR",{timeZone:TZ,hour:"2-digit",hour12:false}).format(d));return h<12?"Buenos días":h<20?"Buenas tardes":"Buenas noches"};
  const firstName=()=>String(window.ExploraSession?.profile?.nombre||window.ExploraSession?.profile?.name||window.ExploraSession?.authUser?.displayName||"Chofer").trim().split(/\s+/)[0]||"Chofer";
  function sync(){
    const c=clock();if(!c)return;
    const d=now(),test=isTest();
    document.body.classList.toggle("explora-global-test-active",test);
    document.documentElement.dataset.operationalClock=test?"global-test":"firestore";
    const banner=$("adminDateModeBanner");
    if(banner){banner.classList.toggle("is-visible",test);banner.dataset.role=isAdmin()?"admin":"driver";}
    const restore=$("adminDateBannerRestore");if(restore)restore.hidden=!isAdmin();
    const bannerText=$("adminDateModeText");if(bannerText)bannerText.textContent=new Intl.DateTimeFormat("es-AR",{timeZone:TZ,dateStyle:"full",timeStyle:"short"}).format(d);
    const dateEl=$("driverGreetingDate");if(dateEl)dateEl.textContent=longDate(d);
    const greetEl=$("driverGreetingName");if(greetEl)greetEl.textContent=`¡${greeting(d)}, ${firstName()}!`;
    document.querySelectorAll('[data-operational-date]').forEach(el=>{el.textContent=longDate(d)});
    window.ExploraAppNow=()=>new Date(d.getTime());
    window.dispatchEvent(new CustomEvent("explora:app-date-refresh",{detail:{date:d.toISOString(),testMode:test,source:test?"global-test-clock":"firestore-clock"}}));
  }
  ["explora:operational-date-changed","explora:operational-period-changed","explora:session-opened","explora:auth-ready"].forEach(name=>window.addEventListener(name,sync));
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)sync()});
  document.addEventListener("DOMContentLoaded",sync,{once:true});
  if(document.readyState!=="loading")sync();
  setInterval(sync,15000);
  window.ExploraGlobalClockAppWide=Object.freeze({sync,now,isTest});
})();
