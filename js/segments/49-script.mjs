const noop = () => {};
const asyncTrue = async () => true;
function killLegacyMileageDom(){
  try{
    document.querySelectorAll('#mileageOverlay,.mileage-overlay,#mileageDashboardCard,#mileageClosureCard,#mileageAdminAlertsCard').forEach(node => node.remove());
    document.documentElement.classList.add('explora-legacy-mileage-off');
    document.body?.classList?.add('explora-legacy-mileage-off');
    if (document.body?.style?.overflow === 'hidden') document.body.style.overflow = '';
  }catch(_){/* noop */}
}
window.EXPLORA_DISABLE_LEGACY_MILEAGE = true;
window.__EXPLORA_KILL_LEGACY_MILEAGE__ = killLegacyMileageDom;
window.ExploraMileageControl = Object.freeze({
  disabled:true,
  refresh:async()=>null,
  open:()=>false,
  ensureBeforeBilling:asyncTrue,
  startReminder:noop,
  stopReminder:noop,
  scheduleReminder:noop,
  getStartGraceState:()=>({disabled:true}),
  getState:()=>({disabled:true,firebaseReady:false,storageReady:false}),
  parseNumber:value=>Number(value)||0,
  classify:()=>({disabled:true}),
  ensureFirebase:async()=>null,
  stableHash:value=>String(value||''),
  idempotentAlertId:()=>'',
  vehicleIsOperational:()=>true,
  canonicalAssignmentMatches:()=>true
});
killLegacyMileageDom();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', killLegacyMileageDom, { once:true });
try{ new MutationObserver(killLegacyMileageDom).observe(document.documentElement,{childList:true,subtree:true}); }catch(_){/* noop */}
setTimeout(killLegacyMileageDom,50);setTimeout(killLegacyMileageDom,300);setTimeout(killLegacyMileageDom,1200);
console.info('EXPLORA_LEGACY_WEEKLY_MILEAGE_CONTROL_HARD_DISABLED_v4013');
export {};
