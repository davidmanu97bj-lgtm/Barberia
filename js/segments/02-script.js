(()=>{
  "use strict";
  if(window.ExploraClockBootstrap)return;
  const weekly=()=>window.ExploraWeeklyPeriods?.active?.()||null;
  window.ExploraClockBootstrap=Object.freeze({
    getNow:()=>window.ExploraFirestoreClock?.getNow?.()||new Date(),
    getActiveWeeklyPeriod:()=>window.ExploraFirestoreClock?.getWeeklyPeriod?.()||weekly(),
    timezone:"America/Argentina/Cordoba"
  });
  window.getExploraOperationalNow=()=>window.ExploraFirestoreClock?.getNow?.()||new Date();
  window.getExploraActiveWeeklyPeriod=()=>window.ExploraFirestoreClock?.getWeeklyPeriod?.()||weekly();
  window.ExploraPeriods=Object.assign(window.ExploraPeriods||{},{getActivePeriods(){const p=window.getExploraActiveWeeklyPeriod();return{weeklyPeriodId:p?.id||"",weekStartMs:p?.startMs||0,weekEndMs:p?.endMs||0,timezone:p?.timezone||"America/Argentina/Cordoba"};}});
})();
