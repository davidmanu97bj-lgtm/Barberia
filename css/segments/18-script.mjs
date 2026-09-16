
import { getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, collection, getDocs, query, where, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { WEEK_MS, weeklyPeriodFromDate, weeklyPeriodFromId, previousWeeklyPeriod, weeklyScopeFromPeriod } from "../core/weekly-core.mjs";

const app=getApps().length?getApp():null;
const auth=app?getAuth(app):null;
const db=app?getFirestore(app):null;
const $=id=>document.getElementById(id);
const TZ="America/Argentina/Cordoba";
const GOALS=Object.freeze([]);
const DERIVATION_PERCENT=10;
const INVALID_STATES=["cancel","rechaz","elimin","borrador","test","prueba"];
const COMPLETE_STATES=["completed","complet","finaliz","factur","cerrad","realiz"];
const RANKING_CACHE_SCHEMA=261;
const PERFORMANCE_CALCULATION_VERSION="v2.4.0-fixed-fifty-participation";
const EXPLORA_ADMIN_UID="2LziyTTdFcZzSOhK3hLbAKs2U4s2";

const state={
  loading:false,loaded:false,open:false,tab:"ranking",highlightGoal:0,uid:"",role:"",weekScope:null,
  rows:[],current:null,derivations:[],currentDerivationLeader:null,derivationLeader:null,derivationPeriodId:"",history:[],
  incentiveByPeriod:new Map(),weeklyAwards:new Map(),refreshPromise:null,lastRefresh:0,error:null,
  liveDerivationOverlay:new Map(),goalView:null,goalScrollTimer:0,goalScrollReturning:false,
  goalCarouselBound:false,goalResizeObserver:null,goalWindowStartLeft:0,dashboardAnimationPending:false,profileAnimationPending:false,lastActiveGoalId:0,
  operationalResetAtMs:0,diagnosticKeys:new Set(),refreshRequestId:0,cacheRestored:false,renderHashes:new Map(),
  forceOperationalRead:true,pendingForcedRefresh:false,pendingRefreshReason:"",lastRankingContextKey:"",
  activeDriverCount:0,rankingDocumentsRead:0,billingDocumentsRead:0,rankingSource:"",rankingRefreshMs:0,rankingCacheAge:0,rankingSummaryComplete:false,rankingSnapshot:null,lastAppliedUnifiedSnapshotId:0,
  performanceGeneration:1,lastConfirmedSnapshot:null,lastConfirmedViewModel:null,lastAcceptedSourcePriority:0,lastAcceptedUpdatedAtMs:0,profilesValidated:false,explicitDecreaseGeneration:0
};

const money=value=>new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(Math.round(Number(value||0)));
const escapeHtml=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const shortUid=value=>String(value||"").trim().slice(0,8)||"—";
const normalize=value=>String(value||"").trim().toLowerCase();
const amountOf=data=>Math.max(0,Number(data?.amount??data?.monto??data?.valor??data?.grossAmount??data?.billingAmount??data?.finalPrice??data?.total??data?.facturacion??0)||0);
const recordUid=data=>String(data?.driverUid||data?.simulationDriverUid||data?.choferUid||data?.uid||data?.userId||data?.choferId||data?.driverId||data?.usuario||"").trim();
const operationId=(data,fallback="")=>String(data?.operationId||data?.billingId||data?.simulationId||data?.operacionId||data?.serviceId||data?.derivationId||data?.id||fallback||"").trim();
const normalizeStatus=value=>normalize(value).normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g,"_");
const statusOf=data=>normalizeStatus(data?.status||data?.estado||data?.paymentStatus||data?.estadoServicio);
const isSimulatedOperationalRecord=data=>data?.isSimulated===true||data?.createdBySimulation===true||normalize(data?.simulationSource)==="admin_driver_simulation";
const simulatedWeeklyPeriodId=data=>String(data?.weeklyPeriodId||data?.periodoSemanalId||data?.periodoId||"").trim();
const validBilling=data=>{
  const amount=amountOf(data),status=statusOf(data);
  if(!(amount>0)||INVALID_STATES.some(token=>status.includes(token)))return false;
  if(!isSimulatedOperationalRecord(data))return true;
  const uid=recordUid(data),periodId=simulatedWeeklyPeriodId(data);
  return Boolean(uid&&periodId&&(data?.isSimulated===true||data?.createdBySimulation===true));
};
const completedDerivation=data=>{
  const status=statusOf(data),amount=derivationAmount(data);
  if(!(amount>0))return false;
  if(["pendiente","sent_pending_response","aceptada","accepted","pendiente_facturacion","accepted_pending_completion","rechazada","rejected","cerrada_rechazada","closed_rejected","canceled","cancelada","cancelado"].some(token=>status===token||status.includes(token)))return false;
  const completedByStatus=COMPLETE_STATES.some(token=>status.includes(token));
  const completedByEvidence=data?.performanceQualified===true&&Boolean(data?.invoicedAt||data?.completedAt||data?.billingRecordId||data?.weeklyPeriodIdCompleted);
  return completedByStatus||completedByEvidence;
};
const senderUid=data=>String(data?.senderUid||data?.originUid||data?.fromUid||data?.emisorUid||data?.derivadorUid||data?.originalSenderUid||"").trim();
const receiverUid=data=>String(data?.receiverUid||data?.receptorUid||data?.toUid||data?.destinoUid||"").trim();
const derivationAmount=data=>Math.max(0,Number(data?.derivedAmountForEmitter??data?.finalAmount??data?.amount??data?.monto??0)||0);
const collaborationOf=data=>Math.max(0,Number(data?.collaborationAmount)||Math.round(derivationAmount(data)*Math.max(0,Number(data?.collaborationRate||.10))));

function adaptWeeklyPeriod(period){
  if(!period?.id)return null;
  const [year,month,day]=period.id.split("-").map(Number);
  return {...period,startKeyMs:Date.UTC(year,month-1,day)};
}
function activeWeeklyPeriod(date=null){
  if(!date){const central=window.ExploraOperationalClock?.getActiveWeeklyPeriod?.();if(central)return adaptWeeklyPeriod(central);}
  return adaptWeeklyPeriod(weeklyPeriodFromDate(date||window.ExploraOperationalClock?.getNow?.()||new Date(),TZ));
}
function periodFromId(id){try{return adaptWeeklyPeriod(weeklyPeriodFromId(id,TZ));}catch(_){return null;}}
function normalizeWeeklyPeriod(period){
  if(period?.weeklyPeriodId||period?.id){const resolved=periodFromId(period.weeklyPeriodId||period.id);if(resolved)return {...period,...resolved,id:resolved.id};}
  if(Number.isFinite(Number(period?.startMs)))return adaptWeeklyPeriod(weeklyPeriodFromDate(new Date(Number(period.startMs)),TZ));
  return activeWeeklyPeriod();
}
function previousPeriod(period=activeWeeklyPeriod()){return adaptWeeklyPeriod(previousWeeklyPeriod(normalizeWeeklyPeriod(period),TZ));}
function weekScopeForPeriod(period){
  const safePeriod=normalizeWeeklyPeriod(period),scope=weeklyScopeFromPeriod(safePeriod,TZ);
  return {...scope,periods:scope.periods.map(adaptWeeklyPeriod),closed:(window.ExploraOperationalClock?.getNow?.().getTime?.()||Date.now())>safePeriod.endMs};
}
function aliasesForProfile(profile,id){return [id,profile?.uid,profile?.authUid,profile?.firebaseUid,profile?.userId,profile?.usuario,profile?.username,profile?.email].map(value=>normalize(value)).filter(Boolean);}
function profileName(profile,id){return String(profile?.nombreCompleto||profile?.nombre||profile?.displayName||profile?.name||profile?.usuario||id||"Chofer").trim();}
function profileAvatar(profile){return String(profile?.avatarUrl||profile?.fotoPerfil||profile?.photoURL||profile?.avatar||profile?.foto||"").trim();}
function role(){const raw=window.ExploraSession?.role||window.ExploraAuthSession?.role||"";return normalize(raw||(document.body.classList.contains("explora-shared-admin")?"admin":"chofer"));}

const GOAL_DIAGNOSTIC_STAGES=new Set(["INIT","OPEN_DERIVATION_MENU","VALIDATE_DERIVATION_FORM","CREATE_DERIVATION","SEND_DERIVATION_NOTICE","READ_INCOMING_DERIVATIONS","ACCEPT_DERIVATION","REJECT_DERIVATION","OPEN_RECEIVER_PENDING_CARD","VALIDATE_RECEIVER_INVOICE","CONFIRM_DERIVATION_INVOICE","CALCULATE_COLLABORATION","UPDATE_DERIVATION_RANKING","UPDATE_ADMIN_WEEKLY_BILLING","INTEGRATE_WEEKLY_CLOSURE","READ_RANKING","RENDER_RANKING","RENDER_DASHBOARD_CARD","WEEK_CLOSE","ROLLBACK","READ_BILLING","CALCULATE_GOALS","ORDER_GOAL_WINDOW","RENDER_GOAL_BUBBLES","ANIMATION_TRIGGER","WEEKLY_BENEFIT","APP_RESET","CALCULATE_GOAL_WINDOW","RENDER_GOAL_CAROUSEL","APPLY_LOCK_LAYER","APPLY_ACTIVE_GLOW","UPDATE_RANKING_LABELS","SCROLL_DIRECTION_INIT","SCROLL_RENDER","BUILD_GOAL_WINDOW","REMOVE_FAKE_GOALS","SCROLL_HORIZONTAL","SCROLL_TO_PRESENT","VERTICAL_SCROLL_RESET","CLICK_RESET","TOUCH_HANDLER","CSS_OVERFLOW_CHECK"]);
const RANKING_REPAIR_STAGES=new Set(["READ_BILLING_RANKING","READ_DERIVATION_RANKING","CALCULATE_GROSS_BILLING","CALCULATE_DERIVED_MONEY","VALIDATE_DERIVATION_STATUS","READ_PUBLIC_SUMMARY","CACHE_VALIDATE","CACHE_INVALIDATE","RENDER_BILLING_RANKING","RENDER_DERIVATION_RANKING","REFRESH_AFTER_PAYMENT","REFRESH_AFTER_DERIVATION"]);
const SIMULATION_RANKING_STAGES=new Set(["READ_SIMULATED_PAYMENTS","READ_SIMULATED_EXPENSES","NORMALIZE_SIMULATED_PAYMENT","NORMALIZE_SIMULATED_EXPENSE","CALCULATE_BILLING_RANKING","CALCULATE_GOALS","CALCULATE_WEEKLY_EXPENSES","RENDER_RANKING","CACHE_INVALIDATE_SIMULATION"]);
const BILLING_GOAL_PERCENT_STAGES=new Set(["READ_BILLING_DATA","NORMALIZE_BILLING_DATA","CALCULATE_GOAL_PERCENT","CALCULATE_GOAL_BENEFIT","RENDER_BILLING_RANKING","RENDER_GOALS_RANKING_TAB","OPEN_GOAL_BENEFIT_DETAIL","CACHE_VALIDATE_GOAL_PERCENT","CACHE_INVALIDATE_GOAL_PERCENT","SIMULATION_BILLING_INTEGRATION"]);
const UI_REPAIR_STAGES=new Set(["LAYOUT_FINANCE_CARDS","LAYOUT_GOAL_BUBBLES","LAYOUT_GOALS_SCREEN","LAYOUT_RANKING_RULES","LAYOUT_DERIVATION_RULES","RENDER_DERIVATION_RANKING","DERIVATION_BUTTON_PULSE","REMOVE_DOUBLE_SCROLL","ORDER_DERIVATION_FIELDS","TEXT_SIMPLIFICATION"]);
const BILLING_RANKING_RESTORE_STAGES=new Set(["LOAD_RANKING_CACHE","VALIDATE_RANKING_CACHE","READ_ACTIVE_DRIVERS","READ_BILLING_SUMMARY","READ_BILLING_FALLBACK","MERGE_DRIVERS_WITH_BILLING","SORT_RANKING","RENDER_DASHBOARD_PODIUM","RENDER_GOALS_RANKING","CACHE_INVALIDATE","CACHE_WRITE","PERFORMANCE_TIMEOUT"]);
const FINANCE_GOALS_TEXT_REPAIR_STAGES=new Set(["RENDER_ACTIVE_GOAL","RENDER_FINANCE_CARDS","TEXT_LAYOUT"]);
function prefersReducedMotion(){return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);}
function goalTier(goalOrId){const id=Number(goalOrId?.id??goalOrId??0);return id<=5?"bronze":id<=8?"silver":"gold";}
function goalTierLabel(goalOrId){return({bronze:"BRONCE",silver:"PLATA",gold:"ORO"})[goalTier(goalOrId)]||"BRONCE";}
function timestampMs(value){if(!value)return 0;if(typeof value.toMillis==="function")return value.toMillis();if(Number.isFinite(Number(value.seconds)))return Number(value.seconds)*1000+Math.floor(Number(value.nanoseconds||0)/1e6);const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:0;}
function recordCreatedMs(row={}){
  if(isSimulatedOperationalRecord(row))return timestampMs(row.simulationRecordedAt||row.createdAt||row.updatedAt||row.invoicedAt||row.completedAt||row.simulatedAt||row.paymentDate||row.expenseDate)||0;
  return timestampMs(row.invoicedAt||row.completedAt||row.createdAt||row.updatedAt||row.fecha||row.date)||0;
}
function afterOperationalReset(row={}){return !(state.operationalResetAtMs>0)||recordCreatedMs(row)>=state.operationalResetAtMs;}
async function loadOperationalResetMarker(){
  try{
    const previous=Math.max(0,Number(state.operationalResetAtMs||0));
    const snap=await getDoc(doc(db,"app_operational_state","current")),data=snap.exists()?snap.data()||{}:{};
    const marker=Math.max(0,Number(data.resetAtMs||timestampMs(data.resetAt)||0));
    state.operationalResetAtMs=marker;
    if(marker>previous)handleOperationalResetMarker(marker);
    return marker;
  }catch(error){diagnostic("APP_RESET","APP_RESET_MARKER_READ_FAILED",error,{functionName:"loadOperationalResetMarker",firestorePath:"app_operational_state/current",query:"getDoc",silent:true});return state.operationalResetAtMs;}
}
function isWeeklyClosurePeriod(period){if(!period?.id)return false;const weekScope=weekScopeForPeriod(period);return period.id===weekScope.endPeriodId&&Date.now()>Number(period.endMs||0);}
function diagnosticSignature(stage,code,path){return ["WEEKLY_PERFORMANCE",String(stage||""),String(code||""),String(path||"")].join("|");}
function firstDiagnosticThisSession(signature){try{const key=`explora_diag_${signature}`;if(state.diagnosticKeys.has(signature)||sessionStorage.getItem(key)==="1")return false;state.diagnosticKeys.add(signature);sessionStorage.setItem(key,"1");return true;}catch(_){if(state.diagnosticKeys.has(signature))return false;state.diagnosticKeys.add(signature);return true;}}

const APP_RESET_DIAGNOSTIC_STAGES=new Set(["APP_RESET","DELETE_COLLECTION","DELETE_BATCH","DELETE_DRIVER_DATA","DELETE_VEHICLE_DATA","DELETE_DEBTS","DELETE_LOANS","DELETE_RANKINGS","DELETE_DERIVATIONS","DELETE_CLOSURES","CLEAR_CACHE","FINALIZE_RESET"]);
function normalizeGoalDiagnosticStage(stage=""){
  const raw=String(stage||"").trim().toUpperCase();
  if(APP_RESET_DIAGNOSTIC_STAGES.has(raw))return raw;
  if(BILLING_GOAL_PERCENT_STAGES.has(raw))return raw;
  if(BILLING_RANKING_RESTORE_STAGES.has(raw))return raw;
  if(FINANCE_GOALS_TEXT_REPAIR_STAGES.has(raw))return raw;
  if(UI_REPAIR_STAGES.has(raw))return raw;
  if(SIMULATION_RANKING_STAGES.has(raw))return raw;
  if(RANKING_REPAIR_STAGES.has(raw))return raw;
  if(GOAL_DIAGNOSTIC_STAGES.has(raw))return raw;
  if(raw.includes("APP_RESET")||raw.includes("RESET"))return "APP_RESET";
  if(raw.includes("NOTICE")&&raw.includes("SEEN"))return "MARK_NOTICE_AS_SEEN";
  if(raw.includes("NOTICE")&&raw.includes("RENDER"))return "RENDER_DASHBOARD_NOTICE";
  if(raw.includes("NOTICE"))return "READ_DASHBOARD_NOTICE";
  if(raw.includes("DERIVATION")&&raw.includes("RENDER"))return "RENDER_DERIVATION_CARD";
  if(raw.includes("DERIVATION"))return "READ_DERIVATION_RANKING";
  if(raw.includes("SCROLL")||raw.includes("DIRECTION"))return "SCROLL_DIRECTION_INIT";
  if(raw.includes("LOCK"))return "APPLY_LOCK_LAYER";
  if(raw.includes("GLOW"))return "APPLY_ACTIVE_GLOW";
  if(raw.includes("LABEL"))return "UPDATE_RANKING_LABELS";
  if(raw.includes("CAROUSEL")&&raw.includes("RENDER"))return "RENDER_GOAL_CAROUSEL";
  if(raw.includes("GOAL")&&raw.includes("WINDOW"))return "CALCULATE_GOAL_WINDOW";
  if(raw.includes("ANIMATION")||raw.includes("CELEBR"))return "ANIMATION_TRIGGER";
  if(raw.includes("ORDER")||raw.includes("WINDOW"))return "ORDER_GOAL_WINDOW";
  if(raw.includes("RENDER")||raw.includes("PROFILE"))return "RENDER_GOAL_BUBBLES";
  if(raw.includes("CALCULATE")||raw.includes("CYCLE")||raw.includes("WRITE")||raw.includes("SUMMARY"))return "CALCULATE_GOALS";
  if(raw.includes("BILLING")||raw.includes("HISTORY")||raw.includes("READ"))return "READ_BILLING";
  return "INIT";
}
function getGoalCarouselWindow(driverBillingAmount){const billing=Math.max(0,Number(driverBillingAmount||0)||0);return{decorativeBefore:null,zeroGoal:null,activeGoal:null,previousGoal:null,highestAchievedGoal:null,nextGoal:null,nextGoals:[],visibleGoals:[],renderGoals:[],allGoals:[],lockedGoals:[],unlockedGoals:[],activeIndex:0,activePercent:0,activeGoalPercent:0,activeAmount:0,activeGoalAmount:0,nextGoalAmount:0,remainingAmount:0,driverBillingAmount:billing,windowStartIndex:0,visibleCount:0,direction:"none",fakeCardsDetected:0};}
function getGoalBubbleWindow(driverBillingAmount){return getGoalCarouselWindow(driverBillingAmount);}
function getVisibleGoalBubbles(driverBillingAmount){return getGoalCarouselWindow(driverBillingAmount);}
function safeGoalView(billing){return getGoalCarouselWindow(billing);}
function goalDisplayName(){return "Ranking diario";}
function goalLabel(){return "—";}
function derivatorDiagnosticLabel(){const leader=state.currentDerivationLeader;if(!leader)return `Sin líder · ${money(0)} derivados · bono ${money(0)}`;const projected=Math.round(Number(leader.derivedAmount||0)*DERIVATION_PERCENT/100);return `${leader.name||"Sin nombre"} · ${money(leader.derivedAmount||0)} derivados · bono ${money(projected)}`;}
function inferFunctionName(error,context,stage){
  if(context?.functionName)return String(context.functionName);
  const first=String(error?.stack||"").split("\n").find(line=>line.includes(" at "))||"";
  const match=first.match(/at\s+([^\s(]+)/);
  return match?.[1]||String(stage||"unknown");
}
function diagnostic(stage,code,error,context={}){
  const normalizedStage=normalizeGoalDiagnosticStage(stage);
  const weekScope=state.weekScope||{};
  const current=state.current||{};
  const view=context.goalView||state.goalView||safeGoalView(context.billing??current.grossBilling??0);
  const notice=window.ExploraDashboardNoticeState||{};
  const leader=state.currentDerivationLeader;
  const periodId=context.weeklyPeriodId||activeWeeklyPeriod().id||"—";
  const incentive=context.incentive||getSettlementIncentive(auth?.currentUser?.uid||state.uid||"",periodId);
  const jsMessage=String(error?.message||context.message||code||"Error sin mensaje");
  const firebaseCode=String(context.firebaseCode||error?.firebaseCode||error?.cause?.code||error?.code||"—");
  const firebaseMessage=String(context.firebaseMessage||error?.firebaseMessage||error?.cause?.message||((error?.code||context.firestorePath||context.firestore)?jsMessage:"—"));
  const stack=String(error?.stack||"—");
  const goalWindow=(view.visibleGoals||[]).map(goal=>goalDisplayName(goal)).join(", ")||"—";
  const lockedGoalLabels="—";
  const unlockedGoalLabels="—";
  const carouselStages=new Set(["CALCULATE_GOAL_WINDOW","RENDER_GOAL_CAROUSEL","APPLY_LOCK_LAYER","APPLY_ACTIVE_GLOW","UPDATE_RANKING_LABELS","SCROLL_DIRECTION_INIT","BUILD_GOAL_WINDOW","REMOVE_FAKE_GOALS","RENDER_GOAL_BUBBLES","SCROLL_HORIZONTAL","SCROLL_TO_PRESENT","VERTICAL_SCROLL_RESET","CLICK_RESET","TOUCH_HANDLER","CSS_OVERFLOW_CHECK"]);
  const isReset=APP_RESET_DIAGNOSTIC_STAGES.has(normalizedStage)||String(code||"").startsWith("APP_RESET_");
  const diagnosticModule=String(context.moduleName||"").trim()||(isReset?"APP_RESET":BILLING_RANKING_RESTORE_STAGES.has(normalizedStage)?"BILLING_RANKING_RESTORE":FINANCE_GOALS_TEXT_REPAIR_STAGES.has(normalizedStage)?"FINANCE_GOALS_TEXT_REPAIR":UI_REPAIR_STAGES.has(normalizedStage)?"UI_RANKING_GOALS_DERIVATIONS_REPAIR":BILLING_GOAL_PERCENT_STAGES.has(normalizedStage)?"BILLING_RANKING_GOAL_PERCENT_REPAIR":SIMULATION_RANKING_STAGES.has(normalizedStage)?"SIMULATION_RANKING_REPAIR":RANKING_REPAIR_STAGES.has(normalizedStage)?"RANKING_AND_DERIVATIONS_REPAIR":normalizedStage==="SCROLL_RENDER"?"BOTTOM_NAV":carouselStages.has(normalizedStage)?"GOAL_BUBBLES_SCROLL":"WEEKLY_PERFORMANCE");
  const normalizedCode=String(code||"").toUpperCase();
  const eventType=String(context.eventType||(normalizedCode==="APP_RESET_COMPLETED"?"SUCCESS":normalizedCode==="APP_RESET_PARTIAL"?"WARNING":"ERROR")).toUpperCase();
  const safeEventType=["SUCCESS","WARNING","ERROR"].includes(eventType)?eventType:"ERROR";
  const ranking=(state.rows||[]).slice(0,3).map(row=>`${row.position||"—"}. ${row.name||row.uid}: ${money(row.grossBilling||0)}`).join(" | ")||"—";
  const derivationState=context.derivationState||context.estadoDerivacion||"—";
  const weeklyBilling=Math.max(0,Number(context.weeklyBilling??context.billingWeekly??0));
  const calculatedBenefit=Math.max(0,Number(context.benefit??(weeklyBilling*Number(incentive.percent||0)/100)??0));
  const payload=[
    `EXPLORA - ${safeEventType} ${diagnosticModule}`,
    `MÓDULO: ${diagnosticModule}`,
    `ETAPA: ${normalizedStage}`,
    `TIPO_EVENTO: ${safeEventType}`,
    `CÓDIGO INTERNO: ${code||"WEEKLY_PERFORMANCE_ERROR"}`,
    `MENSAJE REAL FIREBASE: ${firebaseCode}${firebaseMessage!=="—"?` · ${firebaseMessage}`:""}`,
    `MENSAJE REAL JAVASCRIPT: ${jsMessage}`,
    `STACK: ${stack}`,
    `FUNCIÓN: ${inferFunctionName(error,context,stage)}`,
    `UID AUTH: ${auth?.currentUser?.uid||state.uid||window.ExploraSession?.authUser?.uid||window.ExploraSession?.uid||"—"}`,
    `ROL: ${state.role||role()||"—"}`,
    `DRIVER UID: ${context.driverUid||context.uid||"—"}`,
    `DRIVER NAME: ${context.driverName||context.name||"—"}`,
    `SIMULATION DRIVER UID: ${context.simulationDriverUid||context.driverUid||"—"}`,
    `SEMANA ACTIVA: ${periodId}`,
    `SEMANA ACTIVA: ${context.weeklyPeriodId||weekScope.id||"—"}`,
    `DASHBOARD FACTURACIÓN: ${money(context.dashboardBilling??context.billing??current.grossBilling??0)}`,
    `CIERRE FACTURACIÓN: ${money(context.closureBilling??0)}`,
    `RANKING FACTURACIÓN: ${money(context.rankingBilling??current.grossBilling??0)}`,
    `BURBUJA FACTURACIÓN: ${money(context.bubbleBilling??current.grossBilling??0)}`,
    `TOTAL FACTURADO SNAPSHOT: ${money(context.totalFacturadoSnapshot??context.snapshot?.totalFacturado??context.billing??current.grossBilling??0)}`,
    `EFECTIVO: ${money(context.cash??context.efectivo??0)}`,
    `TRANSFERENCIAS: ${money(context.transfers??context.transferencias??0)}`,
    `TARJETAS: ${money(context.cards??context.tarjetas??0)}`,
    `QR: ${money(context.qr??0)}`,
    `GASTOS: ${money(context.expenses??context.calculatedExpenses??0)}`,
    `FACTURASTE: ${money(context.billing??current.grossBilling??0)}`,
    `PORCENTAJE DERIVACIÓN: ${context.derivationPercent??incentive.derivationPercent??0}%`,
    `GANASTE: ${money(calculatedBenefit)}`,
    `ACTIVE INDEX: ${context.activeIndex??view.activeIndex??"—"}`,
    `VISIBLE GOALS: ${context.goalWindow||goalWindow}`,
    `LOCKED GOALS: ${context.lockedGoals||lockedGoalLabels}`,
    `UNLOCKED GOALS: ${context.unlockedGoals||unlockedGoalLabels}`,
    `RANKING: ${context.ranking||ranking}`,
    `DERIVADOR ACTUAL: ${context.derivator||derivatorDiagnosticLabel()}`,
    `DERIVACIONES: ${context.derivations??leader?.count??0}`,
    `ESTADO DERIVACIÓN: ${derivationState}`,
    `NOTICE ID: ${context.noticeId||notice.lastDashboardNoticeId||"—"}`,
    `NOTICE TYPE: ${context.noticeType||notice.dashboardNoticeType||"—"}`,
    `NOTICE SEEN: ${context.noticeSeen??Boolean(notice.lastDashboardNoticeSeenAt)}`,
    `QUERY: ${context.query||context.queryUsed||"—"}`,
    `RUTA FIRESTORE: ${context.firestorePath||context.firestore||"—"}`,
    `COLECCIÓN: ${context.collection||context.collectionName||error?.resetDetail?.collectionName||"—"}`,
    `TIEMPO MS: ${context.executionMs??context.timeMs??"—"}`,
    `CACHE HIT: ${context.cacheHit===true?"SÍ":context.cacheHit===false?"NO":"—"}`,
    `CACHE MISS: ${context.cacheMiss===true?"SÍ":context.cacheMiss===false?"NO":"—"}`,
    `TTL: ${context.ttl!=null?`${context.ttl} ms`:"—"}`,
    `REQUEST ID: ${context.requestId??context.currentRequestId??state.refreshRequestId??"—"}`,
    `REFRESH BACKGROUND: ${context.refreshBackground===true?"SÍ":context.refreshBackground===false?"NO":"—"}`,
    `DOCUMENTOS LEÍDOS: ${context.documentsRead??"—"}`,
    `DOCUMENTOS VÁLIDOS: ${context.documentsValid??"—"}`,
    `CHOFERES ACTIVOS LEÍDOS: ${context.activeDriversRead??state.activeDriverCount??"—"}`,
    `DOCUMENTOS RANKING LEÍDOS: ${context.rankingDocumentsRead??state.rankingDocumentsRead??"—"}`,
    `DOCUMENTOS COBROS LEÍDOS: ${context.billingDocumentsRead??state.billingDocumentsRead??"—"}`,
    `RANKING LENGTH: ${context.rankingLength??state.rows?.length??0}`,
    `TOP 3: ${context.top3||(state.rows||[]).slice(0,3).map(row=>`${row.position||"—"}. ${row.name||row.uid} · ${money(row.grossBilling||0)}`).join(" | ")||"—"}`,
    `CACHE AGE: ${context.cacheAge!=null?`${context.cacheAge} ms`:state.rankingCacheAge?`${state.rankingCacheAge} ms`:"—"}`,
    `COBROS REALES LEÍDOS: ${context.realPaymentsRead??"—"}`,
    `COBROS SIMULADOS LEÍDOS: ${context.simulatedPaymentsRead??"—"}`,
    `GASTOS SIMULADOS LEÍDOS: ${context.simulatedExpensesRead??"—"}`,
    `FACTURASTE CALCULADA: ${money(context.calculatedBilling??context.billing??current.grossBilling??0)}`,
    `GASTOS CALCULADOS: ${money(context.calculatedExpenses??0)}`,
    `DINERO DERIVADO: ${money(context.derivedMoney??leader?.derivedAmount??0)}`,
    `BONO DERIVADOR: ${money(context.derivationBonus??Math.round(Number(leader?.derivedAmount||0)*DERIVATION_PERCENT/100))}`,
    `LISTENERS ACTIVOS: ${context.listenersActive??"—"}`,
    `COLECCIONES REINICIADAS: ${context.collectionsReset||context.resetCollections||"—"}`,
    `DOCUMENTOS AFECTADOS: ${context.documentsAffected??"—"}`,
    `TIEMPO DE EJECUCIÓN: ${context.executionMs!=null?`${context.executionMs} ms`:"—"}`,
    `FALLOS / ADVERTENCIAS: ${context.failures||"—"}`,
    `RESULTADO: ${context.result||code||"—"}`,
    `SCROLL POSITION: ${context.scrollPosition??context.scrollY??"—"}`,
    `SAFE AREA: ${context.safeArea||"—"}`,
    `DEVICE: ${context.device||navigator.userAgent||"—"}`,
    `PANTALLA: ${context.screen||context.pantalla||"—"}`,
    `ELEMENTO: ${context.element||context.elemento||"—"}`,
    `ANCHO CONTENEDOR: ${context.containerWidth??"—"}`,
    `ANCHO TEXTO: ${context.textWidth??"—"}`,
    `SCROLL HEIGHT: ${context.scrollHeight??"—"}`,
    `CLIENT HEIGHT: ${context.clientHeight??"—"}`,
    `TIMESTAMP: ${new Date().toISOString()}`
  ].join("\n");
  const signature=[diagnosticModule,normalizedStage,String(code||""),String(periodId||"—"),String(context.driverUid||context.uid||"—")].join("|");
  state.lastDiagnostic={stage:normalizedStage,code,message:jsMessage,payload,eventType:safeEventType};
  if(safeEventType==="ERROR")state.error=state.lastDiagnostic;
  const nonCriticalPaymentTimeout=normalizedCode==="PAYMENT_STATUS_TIMEOUT"||String(jsMessage||"").toUpperCase().includes("PAYMENT_STATUS_TIMEOUT");
  if(nonCriticalPaymentTimeout||context.silent===true||!firstDiagnosticThisSession(signature)){
    console.warn(`[EXPLORA ${safeEventType.toLowerCase()} interno]`,normalizedStage,code,jsMessage);
    return state.lastDiagnostic;
  }
  const backdrop=$("performanceDiagnosticBackdrop"),text=$("performanceDiagnosticText"),title=$("performanceDiagnosticTitle"),card=backdrop?.querySelector?.(".performance-diagnostic-card"),copyBtn=$("performanceDiagnosticCopyBtn"),closeBtn=$("performanceDiagnosticCloseActionBtn");
  if(card)card.dataset.eventType=safeEventType;
  if(title)title.textContent=safeEventType==="SUCCESS"?"EXPLORA · REINICIO COMPLETADO":safeEventType==="WARNING"?"EXPLORA · ADVERTENCIA":"EXPLORA · DIAGNÓSTICO";
  if(text)text.textContent=payload;
  if(copyBtn){copyBtn.textContent=safeEventType==="ERROR"?"COPIAR ERROR":"COPIAR DIAGNÓSTICO";copyBtn.dataset.defaultText=copyBtn.textContent;}
  if(closeBtn)closeBtn.textContent=safeEventType==="SUCCESS"?"OK":"CERRAR";
  backdrop?.classList.add("is-open");backdrop?.setAttribute("aria-hidden","false");
  window.lockPageScroll?.("performance-diagnostic");
  return state.lastDiagnostic;
}
function closeDiagnostic(){const backdrop=$("performanceDiagnosticBackdrop");backdrop?.classList.remove("is-open");backdrop?.setAttribute("aria-hidden","true");window.unlockPageScroll?.("performance-diagnostic");}
async function copyDiagnostic(){
  const content=$("performanceDiagnosticText")?.textContent||"";
  try{
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(content);
    else{
      const area=document.createElement("textarea");area.value=content;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";document.body.appendChild(area);area.select();
      if(!document.execCommand?.("copy"))throw new Error("CLIPBOARD_API_UNAVAILABLE");area.remove();
    }
    const btn=$("performanceDiagnosticCopyBtn");if(btn){const fallback=btn.dataset.defaultText||"COPIAR ERROR";btn.textContent="COPIADO";setTimeout(()=>btn.textContent=fallback,1400);}
  }catch(error){diagnostic("INIT_GOALS","CLIPBOARD_WRITE_FAILED",error,{functionName:"copyDiagnostic"});}
}
function runGoalStage(stage,code,functionName,callback,context={}){
  try{return callback();}catch(error){diagnostic(stage,code,error,{...context,functionName});return null;}
}
function cancelGoalReturn(){if(state.goalScrollTimer){clearTimeout(state.goalScrollTimer);state.goalScrollTimer=0;}}
function goalWindowStartLeft(view=state.goalView){
  const viewport=$("performanceGoalViewport"),track=$("performanceGoalTrack");
  if(!viewport||!track||!view)return 0;
  const firstVisibleId=Math.max(0,Math.min(10,Number(view.visibleGoals?.[0]?.id??view.windowStartIndex??0)));
  const firstVisibleElement=track.querySelector(`[data-performance-goal="${firstVisibleId}"]`);
  if(!firstVisibleElement)return 0;
  return Math.max(0,Math.min(Number(firstVisibleElement.offsetLeft||0),Math.max(0,viewport.scrollWidth-viewport.clientWidth)));
}
function measureGoalCarousel(){
  return runGoalStage("CSS_OVERFLOW_CHECK","DRIVER_GOAL_SCROLL_FAILED","measureGoalCarousel",()=>{
    const viewport=$("performanceGoalViewport"),track=$("performanceGoalTrack");if(!viewport||!track)return;
    const width=viewport.clientWidth;if(!(width>0))return;
    const computed=getComputedStyle(track);
    const gap=Math.max(0,parseFloat(computed.columnGap||computed.gap||"0")||0);
    const paddingLeft=Math.max(0,parseFloat(computed.paddingLeft||"0")||0);
    const paddingRight=Math.max(0,parseFloat(computed.paddingRight||"0")||0);
    const bubbleWidth=Math.max(0,(width-paddingLeft-paddingRight-(gap*4))/5);
    track.style.setProperty("--goal-bubble-width",`${bubbleWidth.toFixed(3)}px`);
    state.goalWindowStartLeft=goalWindowStartLeft(state.goalView);
  });
}
function returnGoalCarouselToStart({immediate=false}={}){
  return runGoalStage("SCROLL_TO_PRESENT","DRIVER_GOAL_RETURN_FAILED","returnGoalCarouselToStart",()=>{
    const viewport=$("performanceGoalViewport");if(!viewport)return;
    const target=Math.max(0,state.goalWindowStartLeft||goalWindowStartLeft(state.goalView));
    if(Math.abs(viewport.scrollLeft-target)<1)return;
    state.goalScrollReturning=true;
    viewport.scrollTo({left:target,top:0,behavior:immediate||prefersReducedMotion()?"auto":"smooth"});
    setTimeout(()=>{state.goalScrollReturning=false;},immediate||prefersReducedMotion()?30:520);
  });
}
function scheduleGoalReturn(){
  cancelGoalReturn();
  if(state.goalScrollReturning)return;
  state.goalScrollTimer=setTimeout(()=>{state.goalScrollTimer=0;returnGoalCarouselToStart();},1200);
}
function bindGoalCarousel(){
  return runGoalStage("TOUCH_HANDLER","DRIVER_GOAL_SCROLL_FAILED","bindGoalCarousel",()=>{
    const viewport=$("performanceGoalViewport");if(!viewport)return;
    measureGoalCarousel();
    if(viewport.dataset.goalCarouselBound==="true")return;
    viewport.dataset.goalCarouselBound="true";state.goalCarouselBound=true;
    ["touchstart","pointerdown","mousedown"].forEach(name=>viewport.addEventListener(name,cancelGoalReturn,{passive:true}));
    ["touchend","touchcancel","pointerup","pointercancel","mouseup","mouseleave"].forEach(name=>viewport.addEventListener(name,scheduleGoalReturn,{passive:true}));
    viewport.addEventListener("scroll",()=>{if(!state.goalScrollReturning)scheduleGoalReturn();},{passive:true});
    if(document.documentElement.dataset.goalGlobalReturnBound!=="true"){
      document.documentElement.dataset.goalGlobalReturnBound="true";
      let lastVerticalY=window.scrollY||0;
      window.addEventListener("scroll",()=>{const currentY=window.scrollY||0;if(Math.abs(currentY-lastVerticalY)>2&&!document.body.classList.contains("explora-shared-admin"))runGoalStage("VERTICAL_SCROLL_RESET","DRIVER_GOAL_RETURN_FAILED","verticalScrollReset",()=>returnGoalCarouselToStart());lastVerticalY=currentY;},{passive:true});
      document.addEventListener("click",event=>{if(document.body.classList.contains("explora-shared-admin"))return;const actionable=event.target?.closest?.('button,[data-action],a[href],[role="button"]');if(actionable&&!viewport.contains(actionable))runGoalStage("CLICK_RESET","DRIVER_GOAL_RETURN_FAILED","clickReset",()=>returnGoalCarouselToStart());},true);
      document.addEventListener("explora:menu-change",()=>{if(!document.body.classList.contains("explora-shared-admin"))returnGoalCarouselToStart();});
    }
    if("ResizeObserver" in window){state.goalResizeObserver=new ResizeObserver(()=>{measureGoalCarousel();returnGoalCarouselToStart({immediate:true});});state.goalResizeObserver.observe(viewport);}else window.addEventListener("resize",()=>{measureGoalCarousel();returnGoalCarouselToStart({immediate:true});},{passive:true});
  });
}
function celebrateElement(element,reason=""){
  if(!element||prefersReducedMotion())return;
  runGoalStage("ANIMATION_TRIGGER","GOAL_ANIMATION_FAILED","celebrateElement",()=>{
    element.classList.remove("is-celebrating");void element.offsetWidth;element.classList.add("is-celebrating");
    setTimeout(()=>element.classList.remove("is-celebrating"),1200);
  },{message:reason});
}
function animateDashboardGoal(){return;}
function renderProfileGoal(){const card=$("profileGoalCard");if(card){card.hidden=true;card.setAttribute("aria-hidden","true");}state.profileAnimationPending=false;}

function fastContext(weekScope=state.weekScope,period=activeWeeklyPeriod()){return{uid:auth?.currentUser?.uid||state.uid||"",role:role(),weeklyPeriodId:period?.id||weekScope?.id||""};}
function rankingContextKey(ctx={}){return`${ctx.uid||""}|${ctx.role||""}|${ctx.weeklyPeriodId||""}`;}
function performanceRankingCacheKey(weekScope=state.weekScope,period=activeWeeklyPeriod()){return `performanceRankingCache_${String(period?.id||period?.weeklyPeriodId||weekScope?.id||"")}`;}
function readPersistentRankingCache(weekScope=state.weekScope,period=activeWeeklyPeriod()){
  const key=performanceRankingCacheKey(weekScope,period);
  try{
    const raw=localStorage.getItem(key);if(!raw)return null;
    const payload=JSON.parse(raw),age=Math.max(0,Date.now()-Number(payload.createdAt||0));
    if(Number(payload.schemaVersion)!==RANKING_CACHE_SCHEMA||String(payload.weeklyPeriodId||"")!==String(period?.id||period?.weeklyPeriodId||weekScope?.id||"")||!Array.isArray(payload.rows)){
      localStorage.removeItem(key);
      diagnostic("VALIDATE_RANKING_CACHE","RANKING_CACHE_SCHEMA_INVALID",new Error("El cache persistente del ranking no coincide con el esquema o período actual."),{moduleName:"BILLING_RANKING_RESTORE",eventType:"WARNING",functionName:"readPersistentRankingCache",weeklyPeriodId:period?.id,cacheHit:true,cacheMiss:false,cacheAge:age,ttl:600000,rankingLength:Array.isArray(payload.rows)?payload.rows.length:0,firestorePath:`localStorage/${key}`,query:"JSON.parse + schema/weekly-period validation"});
      return null;
    }
    const expected=Math.max(0,Number(payload.activeDriverCount||payload.expectedDriverCount||0));
    if((expected>0&&payload.rows.length===0)||(expected>payload.rows.length))return null;
    return{data:payload,age,expired:age>600000,key};
  }catch(error){try{localStorage.removeItem(key);}catch(_){}diagnostic("VALIDATE_RANKING_CACHE","RANKING_CACHE_SCHEMA_INVALID",error,{moduleName:"BILLING_RANKING_RESTORE",eventType:"WARNING",functionName:"readPersistentRankingCache",weeklyPeriodId:period?.id,cacheHit:true,cacheMiss:false,firestorePath:`localStorage/${key}`,query:"JSON.parse ranking cache"});return null;}
}
function writePersistentRankingCache(rows,current,weekScope=state.weekScope,period=activeWeeklyPeriod()){const key=performanceRankingCacheKey(weekScope,period),normalized=(rows||[]).map(normalizeBillingRankingRow).map(row=>({driverUid:row.uid,uid:row.uid,driverName:row.name,name:row.name,totalFacturado:row.grossBilling,grossBilling:row.grossBilling,serviceCount:row.serviceCount,position:row.position,avatar:row.avatar||"",aliases:Array.from(row.aliases||[])})),payload={schemaVersion:RANKING_CACHE_SCHEMA,weeklyPeriodId:String(period?.id||period?.weeklyPeriodId||weekScope?.id||""),createdAt:Date.now(),activeDriverCount:Math.max(Number(state.activeDriverCount||0),normalized.length),rows:normalized,current:current?serializableRow(normalizeBillingRankingRow(current)):null};try{localStorage.setItem(key,JSON.stringify(payload));}catch(error){console.warn("[EXPLORA ranking cache]",error?.message||error);}return payload;}
function serializableRow(row={}){return{...row,aliases:Array.from(row.aliases||[])};}
function hydrateRow(row={}){const normalized=normalizeBillingRankingRow(row);return{...normalized,aliases:new Set(Array.isArray(row.aliases)?row.aliases:[])};}
function isPermissionDenied(error){const value=String(error?.code||error?.message||error?.cause?.code||"").toLowerCase();return value.includes("permission-denied")||value.includes("insufficient permission")||value.includes("missing or insufficient");}
function billingRowsHaveData(rows){return Array.isArray(rows)&&rows.some(row=>Number(row?.grossBilling||0)>0);}
function derivationRowsHaveData(rows){return Array.isArray(rows)&&rows.some(row=>Number(row?.derivedAmount||0)>0);}
function totalGrossBilling(rows){return(Array.isArray(rows)?rows:[]).reduce((sum,row)=>sum+Math.max(0,Number(row?.grossBilling||0)),0);}
function totalDerivedMoney(rows){return(Array.isArray(rows)?rows:[]).reduce((sum,row)=>sum+Math.max(0,Number(row?.derivedAmount||0)),0);}
function canonicalGoalMetrics(grossBillingValue){return{grossBilling:Math.max(0,Number(grossBillingValue||0)||0)};}
function normalizeBillingRankingRow(row={}){const grossBilling=Math.max(0,Number(row.grossBilling??row.facturacion??row.totalBilling??row.totalFacturado??0)||0),uid=String(row.uid||row.driverUid||row.choferUid||row.simulationDriverUid||row.userId||row.choferId||row.profileId||"").trim(),reachedAtMs=timestampMs(row.reachedAt||row.achievedAt||row.firstReachedAt||row.updatedAt||row.calculatedAt||row.createdAt)||Number(row.reachedAtMs||row.updatedAtMs||0),clean={...row,uid,name:String(row.name||row.driverName||row.nombre||"Chofer").trim()||"Chofer",grossBilling,serviceCount:Math.max(0,Number(row.serviceCount||row.billingCount||row.services||row.cantidadServicios||0)),reachedAtMs,updatedAtMs:Math.max(0,Number(row.updatedAtMs||reachedAtMs||0))};["metaName","metaPercent","rewardPercent","activeGoalPercent","goalPercent","reachedGoal","nextGoal","missing","equivalent","benefitAmount","goalBenefit","accruedGoalBenefit","progress"].forEach(key=>delete clean[key]);return clean;}
function normalizedRankingName(value){return String(value||"").trim().normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("es-AR");}
function compareBillingRanking(aSource={},bSource={}){const a=normalizeBillingRankingRow(aSource),b=normalizeBillingRankingRow(bSource);return Number(b.grossBilling||0)-Number(a.grossBilling||0)||Number(b.serviceCount||0)-Number(a.serviceCount||0)||((Number(a.reachedAtMs||0)||Number.MAX_SAFE_INTEGER)-(Number(b.reachedAtMs||0)||Number.MAX_SAFE_INTEGER))||normalizedRankingName(a.name).localeCompare(normalizedRankingName(b.name),"es",{sensitivity:"base"})||String(a.uid||"").localeCompare(String(b.uid||""));}
function compareDerivationRanking(a={},b={}){
  return Number(b.derivedAmount||0)-Number(a.derivedAmount||0)
    || Number(b.count||0)-Number(a.count||0)
    || ((Number(a.reachedAtMs||a.updatedAtMs||0)||Number.MAX_SAFE_INTEGER)-(Number(b.reachedAtMs||b.updatedAtMs||0)||Number.MAX_SAFE_INTEGER))
    || normalizedRankingName(a.name).localeCompare(normalizedRankingName(b.name),"es",{sensitivity:"base"})
    || String(a.uid||"").localeCompare(String(b.uid||""));
}
function canonicalizeBillingRanking(rows=[]){
  const merged=mergePublicRows((Array.isArray(rows)?rows:[]).filter(isEligibleRankingParticipant).map(normalizeBillingRankingRow),"uid","grossBilling");
  merged.sort(compareBillingRanking);merged.forEach((row,index)=>row.position=index+1);return merged;
}
function canonicalizeDerivationRanking(rows=[]){
  const merged=mergePublicRows((Array.isArray(rows)?rows:[]).filter(row=>row&&String(row.uid||"").trim()),"uid","derivedAmount");
  merged.sort(compareDerivationRanking);merged.forEach((row,index)=>row.position=index+1);return merged;
}
function canonicalProfileUid(profile={}){
  return String(profile.uid||profile.authUid||profile.firebaseUid||profile.userId||profile.driverUid||profile.choferUid||profile.id||"").trim();
}
function normalizedProfileRole(profile={}){
  const raw=profile.role??profile.rol??profile.userRole??profile.tipo??profile.profileType??profile.tipoUsuario??"";
  return normalize(raw).normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[\s_-]+/g,"");
}
function isEligibleDriverProfile(profile={}){
  const uid=canonicalProfileUid(profile),normalizedRole=normalizedProfileRole(profile),status=normalize(profile.status||profile.estado||profile.accountStatus||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  if(!uid||uid===EXPLORA_ADMIN_UID)return false;
  if(profile.isAdmin===true||profile.admin===true||profile.superadmin===true||profile.owner===true)return false;
  if(profile.isDeleted===true||profile.deleted===true||profile.disabled===true||profile.isDisabled===true)return false;
  if(profile.activo===false||profile.active===false||profile.isActive===false||profile.enabled===false)return false;
  if(["deleted","eliminado","disabled","deshabilitado","inactive","inactivo","blocked","bloqueado"].some(token=>status.includes(token)))return false;
  if(["admin","administrador","owner","superadmin","system","sistema"].some(token=>normalizedRole===token||normalizedRole.includes(token)))return false;
  if(profile.isSimulated===true)return true;
  return normalizedRole==="chofer"||normalizedRole==="driver";
}
const isActiveDriverProfile=isEligibleDriverProfile;
function isEligibleRankingParticipant(row={}){
  const uid=String(row.uid||row.driverUid||row.choferUid||row.simulationDriverUid||row.profileId||"").trim();
  if(!uid||uid===EXPLORA_ADMIN_UID)return false;
  const roleValue=normalizedProfileRole(row);
  if(roleValue&&roleValue!=="chofer"&&roleValue!=="driver")return false;
  if(row.isAdmin===true||row.admin===true||row.owner===true||row.superadmin===true||row.deleted===true||row.disabled===true||row.active===false||row.activo===false)return false;
  return row.eligibilityConfirmed===true||roleValue==="chofer"||roleValue==="driver";
}
function sourcePriority(source=""){
  const value=normalize(source);
  if(value.includes("realtime")||value.includes("live"))return 500;
  if(value.includes("operational")||value.includes("billing_records"))return 400;
  if(value.includes("firestore")||value.includes("public"))return 300;
  if(value.includes("cache"))return 200;
  if(value.includes("fallback")||value.includes("zero"))return 100;
  return 250;
}
function calculateGoalFromBilling(grossBilling){return{grossBilling:Math.max(0,Number(grossBilling||0)||0),calculationVersion:PERFORMANCE_CALCULATION_VERSION};}
function performanceSnapshotFromRow(row={},meta={}){const grossBilling=Math.max(0,Number(row.grossBilling??row.facturacion??row.totalBilling??0)||0);return{uid:String(row.uid||row.driverUid||auth?.currentUser?.uid||""),role:String(meta.role||state.role||role()||""),weeklyPeriodId:String(meta.weeklyPeriodId||activeWeeklyPeriod().id||state.weekScope?.id||weekScopeForPeriod(activeWeeklyPeriod()).id||""),grossBilling,serviceCount:Number(row.serviceCount||0),updatedAtMs:Number(meta.updatedAtMs||row.updatedAtMs||Date.now()),generationId:Number(meta.generationId||state.performanceGeneration||1),requestId:Number(meta.requestId||state.refreshRequestId||0),source:String(meta.source||state.rankingSource||"unknown"),sourcePriority:Number(meta.sourcePriority||sourcePriority(meta.source||state.rankingSource||"unknown")),completeness:meta.completeness!==false,isConfirmed:meta.isConfirmed!==false,explicitDecrease:meta.explicitDecrease===true,calculationVersion:PERFORMANCE_CALCULATION_VERSION};}
function acceptWeeklyPerformanceSnapshot(previous,incoming,context={}){
  if(!incoming||incoming.completeness===false||incoming.isConfirmed===false)return{accepted:false,reason:"INCOMPLETE"};
  if(!incoming.uid||incoming.uid!==String(auth?.currentUser?.uid||incoming.uid))return{accepted:false,reason:"UID_MISMATCH"};
  if(incoming.uid===EXPLORA_ADMIN_UID||normalize(incoming.role).includes("admin"))return{accepted:false,reason:"ADMIN_NOT_ELIGIBLE"};
  const active=activeWeeklyPeriod(),weekScope=weekScopeForPeriod(active);
  if(incoming.weeklyPeriodId!==active.id||weekScope.id!==active.id)return{accepted:false,reason:"CONTEXT_MISMATCH"};
  if(Number(incoming.generationId||0)<Number(state.performanceGeneration||0))return{accepted:false,reason:"OLD_GENERATION"};
  if(!previous)return{accepted:true,reason:"FIRST_CONFIRMED"};
  if(previous.uid!==incoming.uid||previous.weeklyPeriodId!==incoming.weeklyPeriodId)return{accepted:true,reason:"NEW_CONTEXT"};
  if(Number(incoming.requestId||0)<Number(previous.requestId||0))return{accepted:false,reason:"OLD_REQUEST"};
  if(Number(incoming.sourcePriority||0)<Number(previous.sourcePriority||0)&&Number(incoming.updatedAtMs||0)<=Number(previous.updatedAtMs||0))return{accepted:false,reason:"LOWER_PRIORITY_STALE"};
  if(Number(incoming.updatedAtMs||0)<Number(previous.updatedAtMs||0)&&Number(incoming.grossBilling||0)<=Number(previous.grossBilling||0))return{accepted:false,reason:"OLDER_TIMESTAMP"};
  const lowerBilling=Number(incoming.grossBilling||0)<Number(previous.grossBilling||0);
  if(lowerBilling&&incoming.explicitDecrease!==true)return{accepted:false,reason:"BILLING_REGRESSION"};
  return{accepted:true,reason:"NEWER_CONFIRMED"};
}
function reportPerformanceRegression(previous,incoming,reason,context={}){
  diagnostic("RENDER_GOALS_RANKING_TAB","PERFORMANCE_SNAPSHOT_REGRESSION",new Error(`Snapshot rechazado: ${reason}`),{moduleName:"PERFORMANCE_SNAPSHOT_REGRESSION",eventType:"ERROR",functionName:context.functionName||"acceptWeeklyPerformanceSnapshot",driverUid:incoming?.uid||"—",weeklyPeriodId:incoming?.weeklyPeriodId||"—",generationId:incoming?.generationId||0,requestId:incoming?.requestId||0,previousBilling:previous?.grossBilling||0,incomingBilling:incoming?.grossBilling||0,previousUpdatedAtMs:previous?.updatedAtMs||0,incomingUpdatedAtMs:incoming?.updatedAtMs||0,previousSource:previous?.source||"—",incomingSource:incoming?.source||"—",trigger:context.trigger||"unknown",cacheKey:context.cacheKey||"—"});
}
function commitConfirmedPerformanceSnapshot(incoming,context={}){
  const verdict=acceptWeeklyPerformanceSnapshot(state.lastConfirmedSnapshot,incoming,context);
  if(!verdict.accepted){reportPerformanceRegression(state.lastConfirmedSnapshot,incoming,verdict.reason,context);return false;}
  state.lastConfirmedSnapshot=Object.freeze({...incoming});state.lastAcceptedSourcePriority=Number(incoming.sourcePriority||0);state.lastAcceptedUpdatedAtMs=Number(incoming.updatedAtMs||0);return true;
}
function buildEligibleRankingParticipants(rows=[],profilesData={},meta={}){
  const eligibleProfiles=(profilesData?.profiles||[]).filter(isEligibleDriverProfile);
  const profilesComplete=profilesData?.complete===true;
  const profileByUid=new Map();
  eligibleProfiles.forEach(profile=>{const uid=canonicalProfileUid(profile);if(uid&&!profileByUid.has(uid))profileByUid.set(uid,profile);});
  const merged=new Map();
  (Array.isArray(rows)?rows:[]).filter(Boolean).forEach(source=>{
    const uid=String(source.uid||source.driverUid||source.choferUid||source.simulationDriverUid||"").trim();
    if(!uid||!profileByUid.has(uid))return;
    const normalized=normalizeBillingRankingRow({...source,uid,role:"chofer",eligibilityConfirmed:true});
    const previous=merged.get(uid);
    if(!previous||Number(normalized.grossBilling||0)>Number(previous.grossBilling||0)||(Number(normalized.grossBilling||0)===Number(previous.grossBilling||0)&&Number(normalized.updatedAtMs||0)>Number(previous.updatedAtMs||0)))merged.set(uid,normalized);
  });
  profileByUid.forEach((profile,uid)=>{
    const existing=merged.get(uid);
    if(!existing){if(profilesComplete&&meta.billingComplete!==false){const zero=zeroBillingRowFromProfile(profile);if(zero)merged.set(uid,zero);}return;}
    existing.name=profileName(profile,uid);existing.avatar=profileAvatar(profile)||existing.avatar||"";existing.profileId=profile.id||uid;existing.isSimulated=existing.isSimulated===true||profile.isSimulated===true;existing.aliases=new Set(aliasesForProfile(profile,profile.id||uid));
  });
  const result=[...merged.values()].map(normalizeBillingRankingRow);
  const canonical=canonicalizeBillingRanking(result);
  return attachRankingMeta(canonical,{...meta,activeDriverCount:eligibleProfiles.length,expectedDriverCount:eligibleProfiles.length,publicSummaryComplete:result.length===eligibleProfiles.length,source:String(meta.source||"eligible-uid")});
}
function zeroBillingRowFromProfile(profile={}){
  const uid=String(profile.uid||profile.authUid||profile.firebaseUid||profile.userId||profile.id||"").trim();
  if(!uid)return null;
  if(!isEligibleDriverProfile(profile))return null;
  return normalizeBillingRankingRow({uid,profileId:profile.id||uid,name:profileName(profile,uid),avatar:profileAvatar(profile),role:"chofer",eligibilityConfirmed:true,grossBilling:0,serviceCount:0,aliases:new Set(aliasesForProfile(profile,profile.id||uid)),periodBilling:{},isSimulated:profile.isSimulated===true,realServiceCount:0,simulatedServiceCount:0});
}
function attachRankingMeta(rows=[],meta={}){
  rows.activeDriverCount=Math.max(Number(meta.activeDriverCount||0),rows.length);
  rows.expectedDriverCount=Math.max(Number(meta.expectedDriverCount||0),rows.activeDriverCount);
  rows.documentsRead=Math.max(0,Number(meta.documentsRead||rows.documentsRead||0));
  rows.documentsValid=Math.max(0,Number(meta.documentsValid||rows.documentsValid||0));
  rows.billingDocumentsRead=Math.max(0,Number(meta.billingDocumentsRead||rows.billingDocumentsRead||0));
  rows.publicSummaryComplete=meta.publicSummaryComplete===true||(rows.expectedDriverCount>0&&rows.length>=rows.expectedDriverCount);
  rows.source=String(meta.source||rows.source||"");
  return rows;
}
function mergeDriversWithBilling(rows=[],profilesData={},meta={}){
  return buildEligibleRankingParticipants(rows,profilesData,meta);
}
function cachePayloadValidation(moduleName,payload,ctx){
  if(!payload||typeof payload!=="object")return{valid:false,reason:"PAYLOAD_MISSING"};
  if(Number(payload.schemaVersion)!==RANKING_CACHE_SCHEMA)return{valid:false,reason:"SCHEMA_VERSION_MISMATCH"};
    if(String(payload.weeklyPeriodId||"")!==String(ctx.weeklyPeriodId||""))return{valid:false,reason:"WEEKLY_PERIOD_ID_MISMATCH"};
  if(state.operationalResetAtMs>0&&Number(payload.resetAtMs||0)<state.operationalResetAtMs)return{valid:false,reason:"STALE_AFTER_RESET"};
  if(moduleName==="billing_ranking"){
    if(!Array.isArray(payload.rows))return{valid:false,reason:"BILLING_ROWS_MISSING"};
    if(payload.rows.some(row=>!isEligibleRankingParticipant(row)||!String(row?.uid||"").trim()||!String(row?.name||row?.driverName||"").trim()||!Number.isFinite(Number(row?.grossBilling))))return{valid:false,reason:"BILLING_ROW_SCHEMA_INVALID"};
    const expectedCount=Math.max(0,Number(payload.activeDriverCount||payload.expectedDriverCount||0));
    /*
     * Original logic rejected the cache when the number of billing rows was less than the
     * expected number of drivers or fewer than 3 entries. In production this caused
     * the daily bubble ranking to disappear entirely on days where only a couple of
     * drivers had facturación, even though there was still useful data to display.
     *
     * To make the ranking more resilient, we now accept caches with at least one row,
     * regardless of how many drivers were expected. If there are no rows then the
     * cache is considered invalid; otherwise it is considered valid and the UI can
     * render partial data instead of showing "sin datos".
     */
    if(payload.rows.length===0){
      return{valid:false,reason:"RANKING_CACHE_NO_DATA"};
    }
    // We do not enforce a minimum threshold for rows length anymore. Caches with
    // one or more rows are treated as valid even if they contain fewer entries
    // than expected.
  }
  if(moduleName==="derivation_ranking"){
    if(!Array.isArray(payload.rows))return{valid:false,reason:"DERIVATION_ROWS_MISSING"};
    if(payload.rows.some(row=>!String(row?.uid||"").trim()||!Number.isFinite(Number(row?.derivedAmount))))return{valid:false,reason:"DERIVATION_ROW_SCHEMA_INVALID"};
  }
    return{valid:true,reason:"OK"};
}
function readValidatedPerformanceCache(moduleName,ctx,{allowStale=true,report=true}={}){
  const entry=window.ExploraFastCache?.get?.(moduleName,ctx,{allowStale});
  if(!entry)return null;
  const validation=cachePayloadValidation(moduleName,entry.data,ctx);
  if(validation.valid)return entry;
  window.ExploraFastCache?.invalidate?.(moduleName,ctx);
  if(report){const stage=validation.reason==="CACHE_STALE_GOAL_PERCENT"?"CACHE_VALIDATE_GOAL_PERCENT":"VALIDATE_RANKING_CACHE",diagnosticCode=validation.reason==="STALE_AFTER_RESET"?"CACHE_STALE_AFTER_RESET":validation.reason==="CACHE_STALE_GOAL_PERCENT"?"CACHE_STALE_GOAL_PERCENT":validation.reason==="RANKING_CACHE_ONLY_ONE_DRIVER"?"RANKING_CACHE_ONLY_ONE_DRIVER":validation.reason==="RANKING_PUBLIC_SUMMARY_INCOMPLETE"?"RANKING_PUBLIC_SUMMARY_INCOMPLETE":"RANKING_CACHE_SCHEMA_INVALID";diagnostic(stage,diagnosticCode,Object.assign(new Error(`Cache ${moduleName} inválido: ${validation.reason}`),{code:validation.reason}),{moduleName:"BILLING_RANKING_RESTORE",functionName:"readValidatedPerformanceCache",weeklyPeriodId:ctx.weeklyPeriodId,firestorePath:`localStorage/${moduleName}`,query:"ExploraFastCache.get + schema validation",cacheHit:true,cacheMiss:false,cacheAge:entry.age,rankingLength:Array.isArray(entry.data?.rows)?entry.data.rows.length:0,activeDriversRead:Number(entry.data?.activeDriverCount||0),result:validation.reason});}
  return null;
}
function invalidatePerformanceCaches(ctx=fastContext(),reason="manual"){
  ["billing_ranking","derivation_ranking","performance_bundle","rankingSnapshot"].forEach(name=>window.ExploraFastCache?.invalidate?.(name,ctx));
  try{localStorage.removeItem(`performanceRankingCache_${String(ctx.weeklyPeriodId||"")}`);}catch(_){}
  state.cacheRestored=false;state.rankingSnapshot=null;state.lastAppliedUnifiedSnapshotId=0;state.performanceGeneration+=1;
  if(["context-changed","operational-reset","reset-marker"].includes(reason)){state.lastConfirmedSnapshot=null;state.lastConfirmedViewModel=null;state.lastAcceptedSourcePriority=0;state.lastAcceptedUpdatedAtMs=0;}
  return reason;
}
function freshCurrentUserRow(user=auth?.currentUser){return{uid:user?.uid||state.uid||"",profileId:user?.uid||state.uid||"",name:user?.displayName||"Usuario",avatar:user?.photoURL||"",grossBilling:0,serviceCount:0,aliases:new Set([normalize(user?.uid||state.uid||"")]),periodBilling:{},position:0};}
function handleOperationalResetMarker(marker){
  const period=activeWeeklyPeriod(),weekScope=weekScopeForPeriod(period),ctx=fastContext(weekScope,period);
  const stale=["billing_ranking","derivation_ranking","goal_bubbles"].some(name=>{const entry=window.ExploraFastCache?.get?.(name,ctx,{allowStale:true});return entry&&Number(entry.data?.resetAtMs||0)<Number(marker||0);});
  if(!stale)return;
  invalidatePerformanceCaches(ctx,"reset-marker");
  state.rows=[];state.derivations=[];state.currentDerivationLeader=null;state.current=freshCurrentUserRow();state.goalView=safeGoalView(0);state.loaded=false;state.forceOperationalRead=true;
  diagnostic("CACHE_INVALIDATE","CACHE_STALE_AFTER_RESET",Object.assign(new Error("Se invalidó cache anterior al último reinicio operativo."),{code:"CACHE_STALE_AFTER_RESET"}),{functionName:"handleOperationalResetMarker",weeklyPeriodId:period.id,firestorePath:"app_operational_state/current",query:"resetAtMs > cache.resetAtMs",cacheHit:true,cacheMiss:false,result:"CACHE_INVALIDATED"});
}
function restorePerformanceFastCache(weekScope=weekScopeForPeriod(activeWeeklyPeriod()),period=activeWeeklyPeriod()){
  if(!auth?.currentUser?.uid||role().includes("admin"))return false;
  const ctx=fastContext(weekScope,period),billing=readValidatedPerformanceCache("billing_ranking",ctx),direct=!billing?.data?readPersistentRankingCache(weekScope,period):null,derivations=readValidatedPerformanceCache("derivation_ranking",ctx),goals=readValidatedPerformanceCache("goal_bubbles",ctx);
  const billingData=billing?.data||direct?.data||null;
  if(!billingData&&!derivations?.data&&!goals?.data){
    if(!state.loaded)diagnostic("RESTORE_FAST_CACHE","RANKING_CACHE_MISS_FIRST_LOAD",new Error("No existe cache inicial útil; se mostrará skeleton mientras Firestore actualiza en segundo plano."),{moduleName:"BILLING_RANKING_RESTORE",eventType:"WARNING",silent:true,functionName:"restorePerformanceFastCache",weeklyPeriodId:period.id,cacheHit:false,cacheMiss:true,ttl:600000,rankingLength:0,firestorePath:`localStorage/${performanceRankingCacheKey(weekScope,period)}`,query:"ExploraFastCache + performanceRankingCache"});
    return false;
  }
  if(billingData?.rows)state.rows=billingData.rows.map(hydrateRow).filter(isEligibleRankingParticipant);
  state.activeDriverCount=Math.max(Number(billingData?.activeDriverCount||billingData?.expectedDriverCount||0),state.rows.length);state.rankingCacheAge=Number(billing?.age??direct?.age??0);state.rankingSummaryComplete=billingData?.publicSummaryComplete===true||state.rows.length>=state.activeDriverCount;
  if(billingData?.current&&isEligibleRankingParticipant(billingData.current))state.current=hydrateRow(billingData.current);
  if(derivations?.data?.rows)state.derivations=derivations.data.rows.map(row=>({...row}));
  state.currentDerivationLeader=state.derivations[0]||derivations?.data?.leader||null;
  if(goals?.data?.current&&isEligibleRankingParticipant(goals.data.current))state.current=hydrateRow(goals.data.current);
  if(!state.current&&state.rows.length){const key=normalize(auth.currentUser.uid);state.current=state.rows.find(row=>normalize(row.uid)===key||row.aliases?.has?.(key))||null;}
  state.weekScope=weekScope;state.uid=auth.currentUser.uid;state.role=role();
  if(state.current){const cachedSnapshot=performanceSnapshotFromRow(state.current,{weeklyPeriodId:weekScope.id,updatedAtMs:Number(billing?.savedAt||direct?.savedAt||goals?.savedAt||0),generationId:state.performanceGeneration,requestId:state.refreshRequestId,source:"cache",sourcePriority:200,completeness:true,isConfirmed:true});if(!commitConfirmedPerformanceSnapshot(cachedSnapshot,{functionName:"restorePerformanceFastCache",trigger:"cache-restore",cacheKey:performanceRankingCacheKey(weekScope,period)})){state.current=state.lastConfirmedSnapshot?normalizeBillingRankingRow({...state.current,grossBilling:state.lastConfirmedSnapshot.grossBilling}):state.current;}}
  state.goalView=safeGoalView(state.current?.grossBilling||0);state.loaded=Boolean(state.current||state.rows.length||state.derivations.length);state.loading=false;state.lastRefresh=Math.max(Number(billing?.savedAt||billingData?.createdAt||0),Number(derivations?.savedAt||0),Number(goals?.savedAt||0));state.cacheRestored=state.loaded;state.lastRankingContextKey=rankingContextKey(ctx);
  if(state.loaded)renderAll();return state.loaded;
}
function persistPerformanceFastCache(period=activeWeeklyPeriod(),weekScope=state.weekScope||weekScopeForPeriod(period)){
  if(!auth?.currentUser?.uid||role().includes("admin"))return;
  const ctx=fastContext(weekScope,period),rows=state.rows.filter(isEligibleRankingParticipant).map(row=>serializableRow(normalizeBillingRankingRow({...row,role:"chofer",eligibilityConfirmed:true}))),eligibleDriverUids=rows.map(row=>String(row.uid||"")),current=state.current&&state.current.uid!==EXPLORA_ADMIN_UID?serializableRow(normalizeBillingRankingRow({...state.current,role:"chofer",eligibilityConfirmed:true})):null,view=state.goalView||safeGoalView(current?.grossBilling||0),base={schemaVersion:RANKING_CACHE_SCHEMA,weeklyPeriodId:period.id,goalConfigVersion:PERFORMANCE_CALCULATION_VERSION,generationId:state.performanceGeneration,sourcePriority:state.lastAcceptedSourcePriority,completeness:true,resetAtMs:Number(state.operationalResetAtMs||0),updatedAt:Date.now()};
  window.ExploraFastCache?.set?.("billing_ranking",{...base,rows,eligibleDriverUids,current,totalGrossBilling:totalGrossBilling(rows),activeDriverCount:Math.max(Number(state.activeDriverCount||0),rows.length),expectedDriverCount:Math.max(Number(state.activeDriverCount||0),rows.length),publicSummaryComplete:Boolean(state.rankingSummaryComplete||rows.length>=Math.max(Number(state.activeDriverCount||0),rows.length)),rankingSource:state.rankingSource||"merged"},ctx,{ttl:600000});
  window.ExploraFastCache?.set?.("derivation_ranking",{...base,rows:state.derivations,leader:state.currentDerivationLeader,totalDerivedMoney:totalDerivedMoney(state.derivations),derivationPercent:DERIVATION_PERCENT},ctx,{ttl:600000});
  window.ExploraFastCache?.set?.("goal_bubbles",{...base,current,goalView:view,activeGoalIndex:view.activeIndex,visibleGoalWindow:view.visibleGoals,grossBilling:Number(current?.grossBilling||0),activePercent:Number(view.activePercent||0)},ctx,{ttl:300000});
  writePersistentRankingCache(rows,current,weekScope,period);
  state.lastRankingContextKey=rankingContextKey(ctx);
}
function publicPerformanceRow(data={},id=""){
  const uid=String(data.driverUid||data.uid||data.choferUid||data.simulationDriverUid||id||"").trim();
  if(!uid)return null;
  return normalizeBillingRankingRow({uid,profileId:uid,name:String(data.driverName||data.choferName||data.nombreChofer||data.name||data.nombre||uid||"Chofer"),avatar:String(data.avatar||data.driverAvatar||data.photoURL||data.avatarUrl||""),grossBilling:Math.max(0,Number(data.grossBilling??data.totalFacturado??data.facturacionBruta??data.facturacion??data.totalBilling??data.totalIngresos??0)||0),serviceCount:Number(data.serviceCount||data.cantidadCobros||data.billingCount||data.services||data.cantidadServicios||0),aliases:new Set([normalize(uid),normalize(data.email)]),periodBilling:{},isSimulated:data.isSimulated===true,realServiceCount:Number(data.realServiceCount||data.realPaymentsCount||0),simulatedServiceCount:Number(data.simulatedServiceCount||data.simulatedPaymentsCount||0),updatedAtMs:timestampMs(data.updatedAt||data.calculatedAt||data.createdAt||data.lastChangeAt)});
}
function publicDerivationRow(data={},id=""){
  const uid=String(data.driverUid||data.uid||data.senderUid||data.sentByUid||data.derivadorUid||data.driverSenderUid||data.createdByUid||data.originDriverUid||data.fromUid||data.emisorUid||id||"").trim(),derivedAmount=Math.max(0,Number(data.derivedMoney??data.derivedAmountForEmitter??data.derivedAmount??data.totalDerivedMoney??0));
  if(!uid||!Number.isFinite(derivedAmount))return null;
  return{uid,name:String(data.driverName||data.name||data.nombre||data.emisorName||"Chofer"),avatar:String(data.avatar||data.driverAvatar||data.photoURL||""),count:Math.max(0,Number(data.derivationCount||data.count||data.validDerivations||0)),derivedAmount,collaborationGenerated:Math.max(0,Number(data.collaborationGenerated??data.collaborationAmount??Math.round(derivedAmount*.10))),position:Number(data.derivationPosition||data.position||0),reachedAtMs:timestampMs(data.firstValidDerivationAt||data.firstCompletedAt||data.acceptedAt||data.reachedAt||data.firstReachedAt||data.completedAt||data.billedAt||data.updatedAt||data.calculatedAt||data.createdAt),updatedAtMs:timestampMs(data.updatedAt||data.calculatedAt||data.createdAt)};
}
function summaryRowsFromDocument(data={}){
  const direct=[data.rows,data.drivers,data.ranking,data.items,data.entries].find(Array.isArray);
  if(direct)return direct;
  if(data.drivers&&typeof data.drivers==="object")return Object.entries(data.drivers).map(([id,row])=>({id,...(row||{})}));
  return[];
}
function mergePublicRows(rows,keyField,amountField){
  const merged=new Map();
  (rows||[]).filter(Boolean).forEach(row=>{const key=normalize(row?.[keyField]);if(!key)return;const previous=merged.get(key),amount=Number(row?.[amountField]||0),previousAmount=Number(previous?.[amountField]||0);if(!previous||amount>previousAmount||(amount===previousAmount&&Number(row.updatedAtMs||0)>Number(previous.updatedAtMs||0)))merged.set(key,row);});
  return[...merged.values()];
}
async function readPublicPerformance(weekScope){const rows=[];let documentsRead=0,documentsValid=0,expectedDriverCount=0;const primary=await getDocs(collection(db,"performance_public",weekScope.id,"drivers"));documentsRead+=primary.size;expectedDriverCount=Math.max(expectedDriverCount,primary.size);primary.forEach(item=>{const parsed=publicPerformanceRow(item.data()||{},item.id);if(parsed){rows.push(parsed);documentsValid+=1;}});if(primary.empty){const summary=await getDoc(doc(db,"performance_public",weekScope.id));if(summary.exists()){documentsRead+=1;const data=summary.data()||{},summaryRows=summaryRowsFromDocument(data);expectedDriverCount=Math.max(expectedDriverCount,Number(data.activeDriverCount||data.driverCount||data.totalDrivers||data.driversCount||0),summaryRows.length);summaryRows.forEach((raw,index)=>{const parsed=publicPerformanceRow(raw,raw?.id||raw?.driverUid||String(index));if(parsed){rows.push(parsed);documentsValid+=1;}});}}const result=canonicalizeBillingRanking(mergePublicRows(rows,"uid","grossBilling").map(normalizeBillingRankingRow));attachRankingMeta(result,{documentsRead,documentsValid,activeDriverCount:Math.max(expectedDriverCount,result.length),expectedDriverCount:Math.max(expectedDriverCount,result.length),publicSummaryComplete:expectedDriverCount===0||result.length>=expectedDriverCount,source:"performance_public"});return result;}
const derivationRankingInit={promise:null,key:"",requestId:0};
async function waitForDerivationRankingSession(weekScope,timeoutMs=8000){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    const user=auth?.currentUser,session=window.ExploraSession||{};
    const period=activeWeeklyPeriod?.();
    const expectedCycle=period?.id?weekScopeForPeriod(period):null;
    const ready=Boolean(user?.uid&&session.authReady&&session.initialized&&!session.closing&&session.profile&&session.role&&session.authUser?.uid===user.uid&&session.generation>0&&weekScope?.id&&expectedCycle?.id===weekScope.id);
    if(ready)return{uid:user.uid,role:normalize(session.role),weeklyPeriodId:weekScope.id,generation:Number(session.generation),key:`${user.uid}|${normalize(session.role)}|${weekScope.id}`};
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  throw Object.assign(new Error("La sesión no quedó lista para leer el ranking de derivaciones."),{code:"DERIVATION_SESSION_NOT_READY"});
}
async function readPublicDerivations(weekScope){
  const gate=await waitForDerivationRankingSession(weekScope);
  if(derivationRankingInit.promise&&derivationRankingInit.key===gate.key)return derivationRankingInit.promise;
  const requestId=++derivationRankingInit.requestId;
  derivationRankingInit.key=gate.key;
  derivationRankingInit.promise=(async()=>{
    const rows=[],errors=[];let documentsRead=0,documentsValid=0,authorizedReads=0,source="";
    const assertCurrent=()=>{const session=window.ExploraSession||{};if(requestId!==derivationRankingInit.requestId||auth?.currentUser?.uid!==gate.uid||session.authUser?.uid!==gate.uid||Number(session.generation)!==gate.generation||session.closing)throw Object.assign(new Error("Solicitud de ranking reemplazada por otra sesión."),{code:"DERIVATION_REQUEST_STALE"});};
    const parents=["performance_public","ranking_derivaciones_public","derivation_ranking_public"];
    for(const parent of parents){
      assertCurrent();
      let routeAuthorized=false;
      try{
        const snapshot=await getDocs(collection(db,parent,weekScope.id,"drivers"));
        routeAuthorized=true;authorizedReads+=1;documentsRead+=snapshot.size;
        snapshot.forEach(item=>{const parsed=publicDerivationRow(item.data()||{},item.id);if(parsed&&parsed.derivedAmount>0){rows.push(parsed);documentsValid+=1;}});
      }catch(error){errors.push({error,parent,path:`${parent}/${weekScope.id}/drivers`,kind:"drivers"});}
      assertCurrent();
      try{
        const snap=await getDoc(doc(db,parent,weekScope.id));
        routeAuthorized=true;authorizedReads+=1;
        if(snap.exists()){documentsRead+=1;summaryRowsFromDocument(snap.data()||{}).forEach((raw,index)=>{const parsed=publicDerivationRow(raw,raw?.id||raw?.driverUid||String(index));if(parsed&&parsed.derivedAmount>0){rows.push(parsed);documentsValid+=1;}});}
      }catch(error){errors.push({error,parent,path:`${parent}/${weekScope.id}`,kind:"summary"});}
      if(routeAuthorized&&rows.length){source=parent;break;}
    }
    assertCurrent();
    const result=mergePublicRows(rows,"uid","derivedAmount");
    result.sort((a,b)=>Number(b.derivedAmount||0)-Number(a.derivedAmount||0)||Number(b.count||0)-Number(a.count||0)||normalize(a.name).localeCompare(normalize(b.name),"es")||String(a.uid||"").localeCompare(String(b.uid||"")));
    result.forEach((row,index)=>row.position=index+1);
    result.documentsRead=documentsRead;result.documentsValid=documentsValid;result.authorizedReads=authorizedReads;result.source=source||"authorized-empty";result.requestId=requestId;
    if(!result.length&&!authorizedReads&&errors.length){const denied=errors.find(item=>isPermissionDenied(item.error))||errors[0];denied.error.failedPath=denied.path;denied.error.requestId=requestId;throw denied.error;}
    return result;
  })().finally(()=>{if(derivationRankingInit.requestId===requestId){derivationRankingInit.promise=null;derivationRankingInit.key="";}});
  return derivationRankingInit.promise;
}

async function queryByPeriod(collectionName,periodId,fields){
  const rows=new Map(),errors=[];
  for(const field of fields){
    try{const snapshot=await getDocs(query(collection(db,collectionName),where(field,"==",periodId)));snapshot.forEach(item=>rows.set(item.id,{id:item.id,...(item.data()||{})}));}
    catch(error){errors.push(error);}
  }
  if(!rows.size&&errors.length===fields.length)throw errors[0];
  return [...rows.values()];
}
function currentAuthProfileFallback(){
  const user=auth?.currentUser;
  if(!user)return{profiles:[],aliasMap:new Map()};
  const sessionProfile=window.ExploraSession?.profile||window.ExploraAuthSession?.profile||{};
  const profile={id:user.uid,uid:user.uid,authUid:user.uid,email:user.email||sessionProfile.email||"",nombreCompleto:sessionProfile.nombreCompleto||sessionProfile.nombre||sessionProfile.displayName||user.displayName||"Chofer",displayName:sessionProfile.displayName||user.displayName||"Chofer",photoURL:sessionProfile.photoURL||sessionProfile.avatarUrl||user.photoURL||"",role:role()||"chofer"};
  const aliasMap=new Map();aliasesForProfile(profile,profile.id).forEach(alias=>aliasMap.set(alias,profile));
  return{profiles:[profile],aliasMap};
}
async function loadProfiles(){
  const ctx=fastContext(),cached=window.ExploraFastCache?.get?.("driver_profiles",ctx,{allowStale:true});
  if(cached&&!cached.expired){const profiles=(cached.data||[]).filter(isActiveDriverProfile),aliasMap=new Map();profiles.forEach(profile=>aliasesForProfile(profile,profile.id).forEach(alias=>aliasMap.set(alias,profile)));return{profiles,aliasMap,complete:true,source:"cache"};}
  try{
    const loaded=await (window.ExploraFastCache?.run?.("driver_profiles",async()=>{
      const byId=new Map(),errors=[];let source="";
      // Una sola lectura completa es más rápida y evita esperar cinco consultas redundantes.
      try{
        const snapshot=await getDocs(collection(db,"choferes"));
        snapshot.forEach(item=>byId.set(item.id,{id:item.id,...(item.data()||{})}));
        source="all";
      }catch(error){errors.push(error);}
      if(!byId.size){
        const specs=[["active",query(collection(db,"choferes"),where("activo","==",true))],["role",query(collection(db,"choferes"),where("role","==","chofer"))],["rol",query(collection(db,"choferes"),where("rol","==","chofer"))],["status",query(collection(db,"choferes"),where("status","==","active"))]];
        const settled=await Promise.allSettled(specs.map(([,ref])=>getDocs(ref)));
        settled.forEach((result,index)=>{if(result.status!=="fulfilled"){errors.push(result.reason);return;}result.value.forEach(item=>byId.set(item.id,{id:item.id,...(item.data()||{})}));});
        source=specs.filter((_,index)=>settled[index]?.status==="fulfilled").map(([name])=>name).join("+");
      }
      const profiles=[...byId.values()].filter(isActiveDriverProfile),aliasMap=new Map();profiles.forEach(profile=>aliasesForProfile(profile,profile.id).forEach(alias=>aliasMap.set(alias,profile)));
      if(!profiles.length&&errors.length)throw errors[0];
      window.ExploraFastCache?.set?.("driver_profiles",profiles,ctx,{ttl:1800000});
      return{profiles,aliasMap,complete:profiles.length>1||isAdmin(),source:source||"none"};
    },ctx,{ttl:1800000,query:"choferes: lectura completa + fallback activo/role/rol/status",firestorePath:"choferes",listenersActive:0})||Promise.resolve({profiles:[],aliasMap:new Map(),complete:false,source:"none"}));
    return loaded||{profiles:[],aliasMap:new Map(),complete:false,source:"none"};
  }catch(error){
    if(!isAdmin()&&isPermissionDenied(error)){const own=currentAuthProfileFallback();return{...own,complete:false,source:"auth-profile"};}
    throw error;
  }
}
async function loadOwnBillingSafe(weekScope,profilesData,throughPeriodId=""){
  const currentUid=String(auth?.currentUser?.uid||state.uid||"").trim();
  if(!currentUid)return[];
  const through=periodFromId(throughPeriodId)||activeWeeklyPeriod();
  const periods=[through];
  const allowedPeriods=new Set(periods.map(item=>String(item?.id||"").trim()).filter(Boolean));
  const found=new Map(),errors=[];let successfulQueries=0;
  for(const field of ["driverUid","simulationDriverUid","uid","choferUid"]){
    try{
      const snapshot=await getDocs(query(collection(db,"billing_records"),where(field,"==",currentUid)));
      successfulQueries+=1;snapshot.forEach(item=>found.set(item.id,{id:item.id,...(item.data()||{})}));
    }catch(error){errors.push(error);}
  }
  if(!successfulQueries){
    const nonPermission=errors.find(error=>!isPermissionDenied(error));
    if(nonPermission)throw nonPermission;
    return[];
  }
  const profile=profilesData?.aliasMap?.get?.(normalize(currentUid))||profilesData?.profiles?.find?.(item=>normalize(item?.uid||item?.authUid||item?.id)===normalize(currentUid))||currentAuthProfileFallback().profiles[0]||null;
  const row={uid:currentUid,profileId:profile?.id||currentUid,name:profileName(profile,auth?.currentUser?.displayName||"Chofer"),avatar:profileAvatar(profile)||String(auth?.currentUser?.photoURL||""),grossBilling:0,serviceCount:0,aliases:new Set([normalize(currentUid),normalize(auth?.currentUser?.email)]),periodBilling:{},isSimulated:false,realServiceCount:0,simulatedServiceCount:0};
  const dedup=new Set();let documentsValid=0;
  found.forEach(record=>{
    if(!afterOperationalReset(record)||!validBilling(record))return;
    const itemPeriod=String(record.weeklyPeriodId||record.periodoSemanalId||record.periodoId||"").trim(),createdMs=recordCreatedMs(record);
    const matchesPeriod=itemPeriod?allowedPeriods.has(itemPeriod):false;
    const matchesDate=!itemPeriod&&createdMs>0&&createdMs>=Number(through?.startMs||0)&&createdMs<=Number(through?.endMs||Infinity);
    if(!matchesPeriod&&!matchesDate)return;
    const op=operationId(record,record.id);if(!op||dedup.has(op))return;dedup.add(op);
    const amount=amountOf(record);row.grossBilling+=amount;row.serviceCount+=1;
    if(isSimulatedOperationalRecord(record)){row.isSimulated=true;row.simulatedServiceCount+=1;}else row.realServiceCount+=1;
    if(itemPeriod)row.periodBilling[itemPeriod]=(row.periodBilling[itemPeriod]||0)+amount;
    documentsValid+=1;
  });
  const result=(row.grossBilling>0||row.serviceCount>0)?[normalizeBillingRankingRow(row)]:[];
  result.forEach((item,index)=>item.position=index+1);result.documentsRead=found.size;result.documentsValid=documentsValid;result.queryUsed="where driverUid/simulationDriverUid/uid/choferUid == auth.uid";
  return result;
}
function mergeBillingRankingSources(...sources){
  const validSources=sources.filter(Array.isArray),rows=mergePublicRows(validSources.flat().filter(Boolean),"uid","grossBilling").map(normalizeBillingRankingRow);
  rows.sort((a,b)=>Number(b.grossBilling||0)-Number(a.grossBilling||0)||Number(b.serviceCount||0)-Number(a.serviceCount||0)||String(a.name||"").localeCompare(String(b.name||""),"es"));
  rows.forEach((row,index)=>row.position=index+1);
  return attachRankingMeta(rows,{documentsRead:validSources.reduce((sum,source)=>sum+Number(source?.documentsRead||0),0),documentsValid:validSources.reduce((sum,source)=>sum+Number(source?.documentsValid||0),0),billingDocumentsRead:validSources.reduce((sum,source)=>sum+Number(source?.billingDocumentsRead||0),0),activeDriverCount:validSources.reduce((max,source)=>Math.max(max,Number(source?.activeDriverCount||0)),0),expectedDriverCount:validSources.reduce((max,source)=>Math.max(max,Number(source?.expectedDriverCount||0)),0),publicSummaryComplete:validSources.some(source=>source?.publicSummaryComplete===true),source:validSources.map(source=>source?.source).filter(Boolean).join("+")});
}
async function loadWeeklyRankingRows(weekScope,profilesData,throughPeriodId="",options={}){
  const period=periodFromId(throughPeriodId)||activeWeeklyPeriod(),ctx=fastContext(weekScope,period),cachedEntry=readValidatedPerformanceCache("billing_ranking",ctx,{allowStale:true}),cachedRows=cachedEntry?.data?.rows?.map(hydrateRow)||null,preferOperational=options.preferOperational===true;
  if(cachedRows)attachRankingMeta(cachedRows,{activeDriverCount:Number(cachedEntry?.data?.activeDriverCount||0),expectedDriverCount:Number(cachedEntry?.data?.expectedDriverCount||0),publicSummaryComplete:cachedEntry?.data?.publicSummaryComplete===true,source:"cache"});
  let publicRows=null,publicError=null,operationalRows=null,operationalError=null,ownRows=null;
  try{publicRows=await window.ExploraFastCache?.run?.("billing_ranking",()=>readPublicPerformance(weekScope),ctx,{ttl:600000,lockKey:`billing-ranking-public-${weekScope.id}-${period.id}`,query:`performance_public (${weekScope.id})`,firestorePath:`performance_public/${weekScope.id}/drivers`,listenersActive:0});}
  catch(error){publicError=error;diagnostic("READ_PUBLIC_SUMMARY",error?.code==="PUBLIC_SUMMARY_SCHEMA_INVALID"?"PUBLIC_SUMMARY_SCHEMA_INVALID":isPermissionDenied(error)?"RANKING_PERMISSION_DENIED":"BILLING_RANKING_READ_FAILED",error,{weeklyPeriodId:period.id,functionName:"readPublicPerformance",firestorePath:`performance_public/${weekScope.id}/drivers`,query:"getDocs/getDoc public summaries",cacheHit:Boolean(cachedEntry),cacheMiss:!cachedEntry,documentsRead:error?.documentsRead??"—"});}
  const canReadGlobalOperational=true;
  /* v292: el ranking semanal siempre se reconstruye desde billing_records de la semana solicitada. */
  const shouldReadOperational=true;
  if(shouldReadOperational){try{operationalRows=await loadWeeklyRows(weekScope,profilesData,throughPeriodId);}catch(error){operationalError=error;diagnostic("READ_BILLING_RANKING",isPermissionDenied(error)?"RANKING_PERMISSION_DENIED":"BILLING_RANKING_READ_FAILED",error,{weeklyPeriodId:period.id,functionName:"loadWeeklyRows",firestorePath:"billing_records",query:"where weeklyPeriodId/periodoSemanalId/periodoId",cacheHit:Boolean(cachedEntry),cacheMiss:!cachedEntry,documentsRead:error?.documentsRead??"—",documentsValid:error?.documentsValid??"—",billing:totalGrossBilling(publicRows||cachedRows||[])});try{ownRows=await loadOwnBillingSafe(weekScope,profilesData,period.id);}catch(_){ownRows=[];}}}
  if(!canReadGlobalOperational){
    const currentUid=normalize(auth?.currentUser?.uid),publicHasOwn=(publicRows||[]).some(row=>normalize(row?.uid)===currentUid&&Number(row?.grossBilling||0)>0),cacheHasOwn=(cachedRows||[]).some(row=>normalize(row?.uid)===currentUid&&Number(row?.grossBilling||0)>0);
    if(!publicHasOwn&&!cacheHasOwn){
      try{ownRows=await loadOwnBillingSafe(weekScope,profilesData,throughPeriodId);}catch(error){if(!isPermissionDenied(error))diagnostic("READ_BILLING_DATA","BILLING_DATA_READ_FAILED",error,{weeklyPeriodId:period.id,functionName:"loadOwnBillingSafe",firestorePath:"billing_records",query:"where driverUid == auth.uid",cacheHit:Boolean(cachedEntry),cacheMiss:!cachedEntry});}
    }
  }
  /* v292: un resultado semanal vacío es válido; nunca se rellena con el semana anterior. */
  const sourceRows=Array.isArray(operationalRows)?mergeBillingRankingSources(operationalRows):mergeBillingRankingSources(ownRows||[]);
  const completed=mergeDriversWithBilling(sourceRows,profilesData,{documentsRead:Number(sourceRows.documentsRead||0),documentsValid:Number(sourceRows.documentsValid||0),billingDocumentsRead:Number(operationalRows?.documentsRead||ownRows?.documentsRead||0),activeDriverCount:Math.max(Number(sourceRows.activeDriverCount||0),(profilesData?.profiles||[]).filter(isActiveDriverProfile).length),expectedDriverCount:Math.max(Number(sourceRows.expectedDriverCount||0),(profilesData?.profiles||[]).filter(isActiveDriverProfile).length),publicSummaryComplete:Boolean(sourceRows.publicSummaryComplete),source:sourceRows.source||"merged"});
  if(completed.length)return completed;
  if(canReadGlobalOperational&&publicError&&operationalError)throw operationalError;
  return completed;
}
async function loadWeeklyRows(weekScope,profilesData,throughPeriodId=""){
  const through=periodFromId(throughPeriodId)||activeWeeklyPeriod(),periods=[through];
  const results=await Promise.all(periods.map(async period=>{try{return{period,rows:await queryByPeriod("billing_records",period.id,["weeklyPeriodId","periodoSemanalId","periodoId"]),ok:true};}catch(error){return{period,rows:[],ok:false,error};}}));
  const failures=results.filter(result=>!result.ok),documentsRead=results.reduce((sum,result)=>sum+result.rows.length,0);
  if(periods.length&&failures.length===periods.length){const failure=failures[0].error||new Error("No se pudo leer billing_records.");failure.documentsRead=documentsRead;failure.documentsValid=0;throw failure;}
  const aggs=new Map(),dedup=new Set();
  profilesData.profiles.forEach(profile=>{const uid=String(profile.uid||profile.authUid||profile.id);aggs.set(uid,{uid,profileId:profile.id,name:profileName(profile,profile.id),avatar:profileAvatar(profile),grossBilling:0,serviceCount:0,aliases:new Set(aliasesForProfile(profile,profile.id)),periodBilling:{},isSimulated:profile.isSimulated===true,realServiceCount:0,simulatedServiceCount:0});});
  let documentsValid=0;
  results.forEach(({period,rows})=>rows.forEach(record=>{
    if(!afterOperationalReset(record)||!validBilling(record))return;
    const raw=normalize(recordUid(record)),profile=profilesData.aliasMap.get(raw),uid=String(profile?.uid||profile?.authUid||profile?.id||recordUid(record)).trim();if(!uid)return;
    const op=operationId(record,record.id),key=`${uid}|${op}`;if(!op||dedup.has(key))return;dedup.add(key);
    if(!aggs.has(uid))aggs.set(uid,{uid,profileId:profile?.id||uid,name:profileName(profile,String(record.driverName||record.choferName||uid)),avatar:profileAvatar(profile),grossBilling:0,serviceCount:0,aliases:new Set([raw,normalize(uid)]),periodBilling:{},isSimulated:record.isSimulated===true,realServiceCount:0,simulatedServiceCount:0});
    const row=aggs.get(uid),amount=amountOf(record);row.grossBilling+=amount;row.serviceCount+=1;if(isSimulatedOperationalRecord(record))row.simulatedServiceCount=(row.simulatedServiceCount||0)+1;else row.realServiceCount=(row.realServiceCount||0)+1;row.periodBilling[period.id]=(row.periodBilling[period.id]||0)+amount;documentsValid+=1;
  }));
  const rows=[...aggs.values()].map(row=>normalizeBillingRankingRow(row));
  rows.sort((a,b)=>b.grossBilling-a.grossBilling||b.serviceCount-a.serviceCount||a.name.localeCompare(b.name,"es"));rows.forEach((row,index)=>row.position=index+1);return attachRankingMeta(rows,{documentsRead,documentsValid,billingDocumentsRead:documentsRead,activeDriverCount:rows.length,expectedDriverCount:rows.length,publicSummaryComplete:true,source:"billing_records"});
}
async function loadOwnDerivationsSafe(cycleOrPeriod,profilesData,throughPeriodId=""){
  const currentUid=String(auth?.currentUser?.uid||state.uid||"").trim();
  if(!currentUid)return[];
  const weekScope=Array.isArray(cycleOrPeriod?.periods)?cycleOrPeriod:weekScopeForPeriod(cycleOrPeriod);
  const targetPeriod=periodFromId(throughPeriodId)||activeWeeklyPeriod();
  const periods=[targetPeriod];
  const allowedPeriods=new Set(periods.map(item=>String(item?.id||"").trim()).filter(Boolean));
  const rows=new Map(),readErrors=[];
  let successfulQuery="";
  for(const field of ["emisorUid","senderUid"]){
    try{
      const snapshot=await getDocs(query(collection(db,"derivaciones"),where(field,"==",currentUid)));
      snapshot.forEach(item=>rows.set(item.id,{id:item.id,...(item.data()||{})}));
      successfulQuery=`where ${field} == auth.uid`;
      break;
    }catch(error){readErrors.push(error);}
  }
  if(!successfulQuery){
    const failure=readErrors[0];
    if(failure&&!isPermissionDenied(failure))throw failure;
    return[];
  }
  const profile=profilesData?.aliasMap?.get?.(normalize(currentUid))||profilesData?.profiles?.find?.(item=>normalize(item?.uid||item?.authUid||item?.id)===normalize(currentUid))||null;
  const target={uid:currentUid,name:profile?profileName(profile,currentUid):String(auth?.currentUser?.displayName||"Chofer"),avatar:profileAvatar(profile)||String(auth?.currentUser?.photoURL||""),count:0,derivedAmount:0,collaborationGenerated:0};
  let documentsValid=0;
  const dedup=new Set();
  rows.forEach(item=>{
    if(!afterOperationalReset(item)||!completedDerivation(item))return;
    const itemPeriod=String(item.weeklyPeriodIdCompleted||item.weeklyPeriodId||item.periodoSemanalId||item.periodoId||"").trim();
    if(itemPeriod&&weekScope?.id&&itemPeriod!==weekScope.id)return;
    if(allowedPeriods.size&&itemPeriod&&!allowedPeriods.has(itemPeriod))return;
    const emitter=normalize(senderUid(item));
    if(emitter&&emitter!==normalize(currentUid))return;
    const id=String(item.derivationId||operationId(item,item.id));
    if(!id||dedup.has(id))return;
    dedup.add(id);
    target.count+=1;
    target.derivedAmount+=derivationAmount(item);
    target.collaborationGenerated+=collaborationOf(item);
    documentsValid+=1;
  });
  const result=target.derivedAmount>0?[target]:[];
  result.forEach((row,index)=>row.position=index+1);
  result.documentsRead=rows.size;
  result.documentsValid=documentsValid;
  result.queryUsed=successfulQuery;
  return result;
}
function mergeDerivationRankingSources(...sources){
  const rows=mergePublicRows(sources.flat().filter(Boolean),"uid","derivedAmount");
  rows.sort((a,b)=>Number(b.derivedAmount||0)-Number(a.derivedAmount||0)||Number(b.count||0)-Number(a.count||0)||String(a.name||"").localeCompare(String(b.name||""),"es"));
  rows.forEach((row,index)=>row.position=index+1);
  rows.documentsRead=sources.reduce((sum,source)=>sum+Number(source?.documentsRead||0),0);
  rows.documentsValid=sources.reduce((sum,source)=>sum+Number(source?.documentsValid||0),0);
  return rows;
}
async function loadWeeklyDerivationRanking(cycleOrPeriod,profilesData,throughPeriodId="",options={}){
  const weekScope=Array.isArray(cycleOrPeriod?.periods)?cycleOrPeriod:weekScopeForPeriod(cycleOrPeriod),period=periodFromId(throughPeriodId)||activeWeeklyPeriod(),ctx=fastContext(weekScope,period),cachedEntry=readValidatedPerformanceCache("derivation_ranking",ctx,{allowStale:true}),cachedRows=cachedEntry?.data?.rows?.map(row=>({...row}))||null,preferOperational=options.preferOperational===true;
  let publicRows=null,publicError=null,operationalRows=null,operationalError=null,ownRows=null;
  try{publicRows=await window.ExploraFastCache?.run?.("derivation_ranking",()=>readPublicDerivations(weekScope),ctx,{ttl:600000,lockKey:`derivation-ranking-public-${auth?.currentUser?.uid||"no-user"}-${role()}-${weekScope.id}-${period.id}`,query:`performance_public + ranking_derivaciones_public + derivation_ranking_public (${weekScope.id})`,firestorePath:`performance_public/${weekScope.id}/drivers`,listenersActive:0});}
  catch(error){publicError=error;}
  if(isAdmin()){
    try{operationalRows=await loadWeeklyDerivations(cycleOrPeriod,profilesData,throughPeriodId);}catch(error){operationalError=error;diagnostic("READ_DERIVATION_RANKING",isPermissionDenied(error)?"RANKING_PERMISSION_DENIED":"DERIVATION_RANKING_READ_FAILED",error,{weeklyPeriodId:period.id,functionName:"loadWeeklyDerivations",firestorePath:"derivaciones",query:"where weeklyPeriodIdCompleted/weeklyPeriodId/periodoSemanalId/periodoId",cacheHit:Boolean(cachedEntry),cacheMiss:!cachedEntry,documentsRead:error?.documentsRead??"—",documentsValid:error?.documentsValid??"—",derivedMoney:totalDerivedMoney(publicRows||cachedRows||[]),derivationBonus:Math.round(totalDerivedMoney(publicRows||cachedRows||[])*DERIVATION_PERCENT/100)});}
  }else{
    try{ownRows=await loadOwnDerivationsSafe(cycleOrPeriod,profilesData,period.id);}catch(error){
      if(!isPermissionDenied(error))diagnostic("READ_DERIVATION_RANKING","DERIVATION_RANKING_READ_FAILED",error,{weeklyPeriodId:period.id,functionName:"loadOwnDerivationsSafe",firestorePath:"derivaciones",query:"where emisorUid/senderUid == auth.uid",cacheHit:Boolean(cachedEntry),cacheMiss:!cachedEntry});
      ownRows=[];
    }
  }
  /* v292: derivaciones semanales se calculan solo con la semana solicitada. */
  if(Array.isArray(operationalRows))return operationalRows;
  if(Array.isArray(ownRows))return ownRows;
  const exactPublic=(Array.isArray(publicRows)?publicRows:[]).filter(row=>String(row?.weeklyPeriodId||row?.periodoSemanalId||"").trim()===period.id);
  if(exactPublic.length)return mergeDerivationRankingSources(exactPublic);
  return [];
}
async function loadWeeklyDerivations(cycleOrPeriod,profilesData,throughPeriodId=""){
  if(!isAdmin())return loadOwnDerivationsSafe(cycleOrPeriod,profilesData,throughPeriodId);
  const targetPeriod=periodFromId(throughPeriodId)||activeWeeklyPeriod();
  const periods=[targetPeriod],readErrors=[];
  const resultSets=await Promise.all(periods.map(async period=>{try{return{rows:await queryByPeriod("derivaciones",period.id,["weeklyPeriodIdCompleted","weeklyPeriodId","periodoSemanalId","periodoId"]),ok:true,period};}catch(error){readErrors.push({periodId:period.id,error});return{rows:[],ok:false,period};}}));
  const rows=resultSets.flatMap(item=>item.rows),documentsRead=rows.length;
  if(periods.length&&readErrors.length===periods.length&&!rows.length){const failure=readErrors[0]?.error||Object.assign(new Error("No se pudo leer la colección derivaciones."),{code:"DERIVATION_RANKING_READ_FAILED"});failure.failedPeriodIds=readErrors.map(item=>item.periodId);failure.documentsRead=documentsRead;failure.documentsValid=0;throw failure;}
  const totals=new Map(),dedup=new Set();let documentsValid=0;
  rows.forEach(item=>{if(!afterOperationalReset(item)||!completedDerivation(item))return;const raw=normalize(senderUid(item));if(!raw)return;const profile=profilesData.aliasMap.get(raw),uid=String(profile?.uid||profile?.authUid||profile?.id||senderUid(item)).trim();if(!uid)return;const id=String(item.derivationId||operationId(item,item.id));if(!id||dedup.has(id))return;dedup.add(id);if(!totals.has(uid))totals.set(uid,{uid,name:profile?profileName(profile,uid):String(item.emisorName||item.senderName||item.originalSenderName||uid),avatar:profileAvatar(profile)||String(item.emisorPhotoUrl||item.senderPhotoUrl||""),count:0,derivedAmount:0,collaborationGenerated:0});const target=totals.get(uid);target.count+=1;target.derivedAmount+=derivationAmount(item);target.collaborationGenerated+=collaborationOf(item);documentsValid+=1;});
  const result=[...totals.values()].sort((a,b)=>b.derivedAmount-a.derivedAmount||b.count-a.count||a.name.localeCompare(b.name,"es"));result.forEach((row,index)=>row.position=index+1);result.documentsRead=documentsRead;result.documentsValid=documentsValid;return result;
}

function cachePeriodIncentive(period,rows,derivations){if(!period?.id)return null;const leader=derivations[0]||null,payable=isWeeklyClosurePeriod(period),estimatedBonus=leader?Math.round(Number(leader.derivedAmount||0)*DERIVATION_PERCENT/100):0,snapshot={weeklyPeriodId:period.id,derivationWinnerUid:leader?.uid||"",derivationWinnerName:leader?.name||"",derivationPercent:leader?DERIVATION_PERCENT:0,derivationCount:leader?.count||0,derivedAmount:leader?.derivedAmount||0,estimatedDerivationBonus:estimatedBonus,derivationBonusAmount:payable?estimatedBonus:0,createdAt:Date.now()};state.incentiveByPeriod.set(period.id,snapshot);return snapshot;}
const PERFORMANCE_HISTORY_CACHE_PREFIX="explora_performance_history_v3_";
function performanceHistoryCacheKey(uid){return `${PERFORMANCE_HISTORY_CACHE_PREFIX}${String(uid||"").trim()}`;}
function normalizeHistoryRows(rows){
  const unique=new Map();
  (Array.isArray(rows)?rows:[]).forEach(row=>{
    const weeklyPeriodId=String(row?.weeklyPeriodId||row?.id||"").trim();
    if(!weeklyPeriodId)return;
    unique.set(weeklyPeriodId,{...row,id:String(row.id||`${weeklyPeriodId}_${row.driverUid||"driver"}`),weeklyPeriodId});
  });
  return [...unique.values()].sort((a,b)=>String(b.weeklyPeriodId||"").localeCompare(String(a.weeklyPeriodId||""))).slice(0,12);
}
function readPerformanceHistoryCache(uid){
  try{
    const raw=localStorage.getItem(performanceHistoryCacheKey(uid));
    return normalizeHistoryRows(raw?JSON.parse(raw):[]);
  }catch(_){return[];}
}
function writePerformanceHistoryCache(uid,rows){
  const normalized=normalizeHistoryRows(rows);
  try{localStorage.setItem(performanceHistoryCacheKey(uid),JSON.stringify(normalized));}catch(_){}
  return normalized;
}
function cacheClosedWeeklyHistoryForCurrentUser(weekScope,rows,derivations){
  const uid=String(auth?.currentUser?.uid||state.uid||"").trim();
  if(!uid||!weekScope?.id)return;
  const own=currentRowForUid(rows||[],uid);if(!own)return;
  const winner=(derivations||[])[0]||null;
  const isWinner=Boolean(winner&&normalize(winner.uid)===normalize(uid));
  const derivationBonus=isWinner?Math.round(Number(winner.derivedAmount||0)*DERIVATION_PERCENT/100):0;
  const historyRow={
    id:`${weekScope.id}_${uid}`,
    weeklyPeriodId:weekScope.id,
    startPeriodId:weekScope.startPeriodId||"",
    endPeriodId:weekScope.endPeriodId||"",
    driverUid:uid,
    driverName:own.name||auth?.currentUser?.displayName||"Chofer",
    grossBilling:Number(own.grossBilling||0),
    goalId:Number(own.reachedGoal?.id||0),
    equivalentAmount:Number(own.equivalent||0),
    derivationPercent:isWinner?DERIVATION_PERCENT:0,
    derivationEquivalentAmount:derivationBonus,
    totalEquivalentAmount:Number(own.equivalent||0)+derivationBonus,
    derivationCount:Number(isWinner?winner.count||0:0),
    derivedAmountForEmitter:Number(isWinner?winner.derivedAmount||0:0),
    status:"closed",
    cachedAt:new Date().toISOString()
  };
  writePerformanceHistoryCache(uid,[historyRow,...readPerformanceHistoryCache(uid)]);
}
async function loadHistory(uid){
  const safeUid=String(uid||auth?.currentUser?.uid||state.uid||"").trim();
  if(!safeUid)return[];
  const memory=Array.isArray(state.history)?state.history:[];
  const cached=normalizeHistoryRows([...memory,...readPerformanceHistoryCache(safeUid)]);
  if(!isAdmin()){
    return cached;
  }
  try{
    const snapshot=await getDocs(query(collection(db,"performance_awards"),where("driverUid","==",safeUid)));
    const firestoreRows=snapshot.docs.map(item=>({id:item.id,...(item.data()||{})}));
    return writePerformanceHistoryCache(safeUid,[...firestoreRows,...cached]);
  }catch(error){
    diagnostic("READ_BILLING","FIRESTORE_HISTORY_READ_FAILED",error,{functionName:"loadHistory",uid:safeUid,query:"where(driverUid == selected uid)",firestorePath:"performance_awards",fallbackUsed:cached.length>0});
    return cached;
  }
}
function isAdmin(){return ["admin","administrador","owner","superadmin"].includes(role());}
async function persistClosedPerformance(previous,profilesData){
  if(!previous)return null;
  if(!isAdmin())return state.derivationLeader||null;const previousWeekScope=weekScopeForPeriod(previous);const [rows,derivations]=await Promise.all([loadWeeklyRankingRows(previousWeekScope,profilesData,previous.id),loadWeeklyDerivationRanking(previousWeekScope,profilesData,previous.id)]);cachePeriodIncentive(previous,rows,derivations);let winner=derivations[0]||null;if(winner)winner={...winner,weeklyPeriodId:previous.id,rewardAmount:isWeeklyClosurePeriod(previous)?Math.round(Number(winner.derivedAmount||0)*DERIVATION_PERCENT/100):0,estimatedRewardAmount:Math.round(Number(winner.derivedAmount||0)*DERIVATION_PERCENT/100)};
  if(isAdmin()){try{await setDoc(doc(db,"performance_derivation_winners",previous.id),{weeklyPeriodId:previousWeekScope.id,rankingScope:"weekly",winnerUid:winner?.uid||"",winnerName:winner?.name||"",winnerAvatar:winner?.avatar||"",derivationCount:winner?.count||0,derivedAmount:winner?.derivedAmount||0,percent:winner?DERIVATION_PERCENT:0,rewardAmount:winner?.rewardAmount||0,estimatedRewardAmount:winner?.estimatedRewardAmount||0,closedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});}catch(error){diagnostic("WEEK_CLOSE","FIRESTORE_DERIVATION_WINNER_WRITE_FAILED",error,{weeklyPeriodId:previousWeekScope.id,derivations:winner?.count||0,leaderBonus:winner?.rewardAmount||0,firestorePath:`performance_derivation_winners/${previous.id}`});}}
  if(!isWeeklyClosurePeriod(previous)||!previousWeekScope.closed)return winner;
  
  cacheClosedWeeklyHistoryForCurrentUser(previousWeekScope,rows,derivations);
  const weeklyWinner=derivations[0]||null,billingRanking=rows.slice(0,10).map(row=>({position:row.position,driverUid:row.uid,driverName:row.name,grossBilling:row.grossBilling,serviceCount:row.serviceCount})),derivationRanking=derivations.slice(0,10).map(row=>({position:row.position,driverUid:row.uid,driverName:row.name,derivationCount:row.count,derivedAmount:row.derivedAmount,collaborationGenerated:row.collaborationGenerated}));
  if(isAdmin()){try{await setDoc(doc(db,"performance_weeks",previousWeekScope.id),{weeklyPeriodId:previousWeekScope.id,startPeriodId:previousWeekScope.startPeriodId,endPeriodId:previousWeekScope.endPeriodId,status:"closed",derivationPercent:DERIVATION_PERCENT,driverCount:rows.length,billingRanking,derivationRanking,derivationWinnerUid:weeklyWinner?.uid||"",derivationWinnerName:weeklyWinner?.name||"",derivationWinnerAvatar:weeklyWinner?.avatar||"",derivationWinnerCount:weeklyWinner?.count||0,derivationWinnerAmount:weeklyWinner?.derivedAmount||0,derivationWinnerBonus:weeklyWinner?Math.round(weeklyWinner.derivedAmount*DERIVATION_PERCENT/100):0,closedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});await Promise.all(rows.map(row=>{const derivationRow=derivations.find(item=>normalize(item.uid)===normalize(row.uid)),isWinner=Boolean(weeklyWinner&&normalize(weeklyWinner.uid)===normalize(row.uid)),derivationBonus=isWinner?Math.round(Number(weeklyWinner.derivedAmount||0)*DERIVATION_PERCENT/100):0;return setDoc(doc(db,"performance_awards",`${previousWeekScope.id}_${row.uid}`),{weeklyPeriodId:previousWeekScope.id,startPeriodId:previousWeekScope.startPeriodId,endPeriodId:previousWeekScope.endPeriodId,driverUid:row.uid,driverName:row.name,grossBilling:row.grossBilling,derivationPercent:isWinner?DERIVATION_PERCENT:0,derivationEquivalentAmount:derivationBonus,totalEquivalentAmount:derivationBonus,derivationCount:derivationRow?.count||0,derivedAmountForEmitter:derivationRow?.derivedAmount||0,status:"closed",createdAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});}));}catch(error){diagnostic("WEEK_CLOSE","FIRESTORE_WEEK_WRITE_FAILED",error,{weeklyPeriodId:previousWeekScope.id,leaderBonus:weeklyWinner?Math.round(weeklyWinner.derivedAmount*DERIVATION_PERCENT/100):0,firestorePath:`performance_weeks/${previousWeekScope.id}`});}}
  return weeklyWinner?{...weeklyWinner,weeklyPeriodId:previous.id,rewardAmount:Math.round(Number(weeklyWinner.derivedAmount||0)*DERIVATION_PERCENT/100)}:null;
}
function currentRowForUid(rows,uid){const key=String(uid||"").trim();return rows.find(row=>String(row.uid||"").trim()===key)||null;}

function renderBubbles(){return state.current;}
function renderPodium(){
  const renderer=window.ExploraDailyRanking;
  if(renderer?.renderDashboard){renderer.renderDashboard();return;}
  const podium=$("performancePodium");if(!podium)return;
  const markup='<article class="daily-leader-card is-empty is-compact" data-daily-state="empty"><span class="daily-leader-kicker">LÍDER DEL DÍA</span><p class="daily-leader-empty-copy">Calculando ranking actual...</p></article>';
  if(!podium.querySelector(".daily-leader-card"))podium.innerHTML=markup;
}
function derivationRankingSingleAuthorityActive(){
  return Boolean(window.ExploraDerivationRankingDefinitiveRepair?.version);
}
function renderDerivator(){
  // v2.4.39: la tarjeta de derivaciones tiene una sola autoridad visual.
  // El motor definitivo (28-script.mjs) inicia la sesión y pinta usando
  // source=weekly-derivation-ranking. Este motor de performance conserva
  // datos para cierres/incentivos, pero no puede iniciar ni repintar la tarjeta.
  if(derivationRankingSingleAuthorityActive())return;
  const container=$("performanceDerivatorCard");if(!container)return;
  return runGoalStage("RENDER_DASHBOARD_CARD","DERIVATION_DASHBOARD_RENDER_SKIPPED","renderDerivator",()=>{});
}

function renderSummary(){const cycle=$("performanceCycleLabel");if(cycle)cycle.textContent=`Semana ${activeWeeklyPeriod().id}`;}
function renderGoals(){const list=$("performanceGoalsList");if(list){list.innerHTML="";list.hidden=true;}}
function buildRankingSnapshot(){
  const period=activeWeeklyPeriod(),weekScope=state.weekScope||weekScopeForPeriod(period),rows=canonicalizeBillingRanking(state.rows);
  state.rankingSnapshot={schemaVersion:RANKING_CACHE_SCHEMA,weeklyPeriodId:period.id,createdAt:Date.now(),requestId:state.refreshRequestId,rows};
  return state.rankingSnapshot;
}
function renderRanking(){
  const renderer=window.ExploraDailyRanking;
  if(renderer?.renderDetail){renderer.renderDetail();return;}
  const list=$("performanceRankingList");if(!list)return;
  if(!list.querySelector(".daily-leader-card"))list.innerHTML='<article class="daily-leader-card is-empty" data-daily-state="empty"><span class="daily-leader-kicker">LÍDER DEL DÍA</span><p class="daily-leader-empty-copy">Calculando ranking actual...</p></article>';
}
function findRankingRow(uid){const key=String(uid||"").trim();return state.rows.find(row=>String(row.uid||"").trim()===key)||null;}
function openGoalBenefitDetail(){return false;}
function closeGoalBenefitDetail(){return;}
function renderDerivationsList(){
  // v2.4.39: no escribir #performanceDerivationsList desde el motor viejo.
  // 28-script.mjs es la única autoridad para evitar parpadeos y renders cruzados.
  return;
}

function renderHistory(){const list=$("performanceHistoryList");if(!list)return;list.innerHTML=state.history.length?state.history.map(row=>`<article class="performance-history-card"><div><span>Semana</span><strong>${escapeHtml(row.weeklyPeriodId||row.id)}</strong></div><div><span>Facturación semanal</span><strong>${money(row.grossBilling)}</strong></div><div><span>Bono por derivaciones</span><strong>${money(row.derivationEquivalentAmount||0)}</strong></div></article>`).join(""):`<div class="performance-history-empty">El historial aparecerá al finalizar la primera semana.</div>`;}
function updateRankingLabels(){
  document.querySelectorAll(".performance-card-kicker,.performance-screen-title h2,.ranking-derived-heading span").forEach(node=>{
    const original=String(node.textContent||"").trim().toUpperCase();
    if(node.closest("#performanceDerivationsPanel")||node.closest(".ranking-derived-screen")){if(original.includes("RANKING SEMANAL")||original.includes("DERIVADOR"))node.textContent="RANKING DE DERIVACIONES";return;}
    if(original==="RANKING DE METAS"||original==="RANKING FACTURACIÓN MENSUAL"||original==="RANKING SEMANAL"||original==="SEMANA ACTUAL")node.textContent="RANKING DIARIO";
  });
  const derivator=$("performanceDerivatorCard");if(derivator)derivator.setAttribute("aria-label","Abrir ranking de derivaciones");
}
function validateRenderedRankings(){
  requestAnimationFrame(()=>{
    const dashboardCard=Boolean($("performancePodium")?.querySelector(".daily-leader-card"));
    const detailCard=Boolean($("performanceRankingList")?.querySelector(".daily-leader-card"));
    const derivationHasData=derivationRowsHaveData(state.derivations),derivationRendered=Boolean($("performanceDerivationsList")?.querySelector(".performance-ranking-row"));
    if(!dashboardCard||!detailCard)diagnostic("RENDER_BILLING_RANKING","DAILY_RANKING_RENDER_EMPTY",new Error("La tarjeta del líder diario no se renderizó de forma atómica."),{functionName:"validateRenderedRankings",weeklyPeriodId:activeWeeklyPeriod().id,firestorePath:"DOM#performancePodium + DOM#performanceRankingList",query:"querySelector(.daily-leader-card)"});
    if(derivationHasData&&!derivationRendered&&!derivationRankingSingleAuthorityActive())diagnostic("RENDER_DERIVATION_RANKING","RANKING_RENDER_EMPTY_WITH_DATA",new Error("El ranking de derivaciones tiene dinero derivado pero no generó filas visibles."),{functionName:"validateRenderedRankings",weeklyPeriodId:activeWeeklyPeriod().id,documentsValid:state.derivations.length,derivedMoney:totalDerivedMoney(state.derivations),derivationBonus:Math.round(Number(state.currentDerivationLeader?.derivedAmount||0)*DERIVATION_PERCENT/100),firestorePath:"DOM#performanceDerivationsList",query:"state.derivations -> renderDerivationsList"});
  });
}
function auditFinanceGoalsTextLayout(){
  requestAnimationFrame(()=>{
    const targets=[document.querySelector("#dashboardWeeklyBillingCard .finance-label-real"),document.querySelector("#dashboardWeeklyExpensesCard .finance-label-real"),document.querySelector("#dashboardReceiptsCard .finance-receipts-title"),$("dashboardWeeklyRevenue"),$("dashboardWeeklyExpenses")].filter(Boolean);
    const overflow=targets.find(node=>node.scrollWidth>node.clientWidth+2||node.scrollHeight>node.clientHeight+2);
    if(overflow)diagnostic("TEXT_LAYOUT","FINANCE_TEXT_OVERFLOW",new Error("Un texto de Finanzas excede su contenedor."),{moduleName:"FINANCE_TEXT_LAYOUT",functionName:"auditFinanceGoalsTextLayout",screen:"DASHBOARD_CHOFER",element:overflow.id||overflow.className||overflow.tagName,containerWidth:overflow.clientWidth,textWidth:overflow.scrollWidth,scrollHeight:overflow.scrollHeight,clientHeight:overflow.clientHeight});
  });
}
function renderAll(){
  state.rows=canonicalizeBillingRanking(state.rows);
  state.derivations=canonicalizeDerivationRanking(state.derivations);
  state.currentDerivationLeader=state.derivations[0]||null;
  if(state.current?.uid===EXPLORA_ADMIN_UID)state.current=null;
  const animateDashboard=Boolean(state.dashboardAnimationPending);
  renderBubbles({animate:animateDashboard,reason:state.lastActiveGoalId?"ACTIVE_GOAL_CHANGED":"DASHBOARD_ENTER"});
  state.dashboardAnimationPending=false;
  runGoalStage("RENDER_GOAL_BUBBLES","GOAL_PODIUM_RENDER_FAILED","renderPodium",renderPodium);
  renderDerivator();
  runGoalStage("UPDATE_RANKING_LABELS","RANKING_LABEL_UPDATE_FAILED","updateRankingLabels",updateRankingLabels);
  runGoalStage("CALCULATE_GOALS","GOAL_SUMMARY_RENDER_FAILED","renderSummary",renderSummary,{billing:state.current?.grossBilling||0});
  runGoalStage("RENDER_GOAL_BUBBLES","GOAL_LIST_RENDER_FAILED","renderGoals",renderGoals);
  runGoalStage("RENDER_GOAL_BUBBLES","GOAL_RANKING_RENDER_FAILED","renderRanking",renderRanking);
  runGoalStage("RENDER_DERIVATION_CARD","GOAL_DERIVATIONS_RENDER_FAILED","renderDerivationsList",renderDerivationsList);
  runGoalStage("RENDER_GOAL_BUBBLES","GOAL_HISTORY_RENDER_FAILED","renderHistory",renderHistory);
  const profileOpen=$("profileScreen")?.classList.contains("is-open");
  renderProfileGoal({animate:Boolean(state.profileAnimationPending&&profileOpen),reason:"ACTIVE_GOAL_CHANGED"});
  if(profileOpen)state.profileAnimationPending=false;
  validateRenderedRankings();
  const status=$("performanceScreenStatus");if(status){status.textContent=state.loaded?`Actualizado ${new Date(state.lastRefresh).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})}`:"";status.classList.toggle("is-error",Boolean(state.error));}
  auditFinanceGoalsTextLayout();
}

async function refresh({force=false,reason="manual"}={}){
  if(state.refreshPromise){if(force){state.pendingForcedRefresh=true;state.pendingRefreshReason=reason;if(isAdmin())state.forceOperationalRead=true;}return state.refreshPromise;}
  if(!db||!auth)return Promise.reject(new Error("FIREBASE_NOT_INITIALIZED"));
  const user=auth.currentUser;if(!user)return Promise.reject(new Error("AUTH_USER_MISSING"));
  const currentPeriod=activeWeeklyPeriod(),weekScope=weekScopeForPeriod(currentPeriod),ctx=fastContext(weekScope,currentPeriod),contextKey=rankingContextKey(ctx),contextChanged=Boolean(state.lastRankingContextKey&&state.lastRankingContextKey!==contextKey);
  if(contextChanged){
    invalidatePerformanceCaches(ctx,"context-changed");
    // No vaciar el último ranking válido de inmediato. Durante el arranque el período
    // puede resolverse en dos pasos y una lectura pública temporalmente vacía no debe
    // borrar el podio visible. Las filas se reemplazan únicamente cuando llega un
    // conjunto confirmado para el nuevo contexto.
    state.derivations=[];
    state.current=state.current||freshCurrentUserRow(user);
    state.currentDerivationLeader=null;
    state.forceOperationalRead=isAdmin();
  }
  const billingCache=readValidatedPerformanceCache("billing_ranking",ctx,{allowStale:true}),derivationCache=readValidatedPerformanceCache("derivation_ranking",ctx,{allowStale:true}),goalCache=readValidatedPerformanceCache("goal_bubbles",ctx,{allowStale:true});
  if(!state.loaded)restorePerformanceFastCache(weekScope,currentPeriod);
  if(!force&&!state.forceOperationalRead&&state.loaded&&billingCache&&!billingCache.expired&&derivationCache&&!derivationCache.expired&&goalCache&&!goalCache.expired){setTimeout(()=>refresh({force:true,reason:"fresh-cache-background"}).catch(()=>{}),0);return Promise.resolve(getState());}
  const requestId=++state.refreshRequestId,preferOperational=Boolean(isAdmin()&&(force||state.forceOperationalRead||!state.loaded));
  state.refreshPromise=window.ExploraFastCache?.run?.("performance_bundle",async()=>{
    const wasLoaded=state.loaded,previousGoalId=state.current?.reachedGoal?.id||0;
    state.loading=!state.loaded;state.uid=user.uid;state.role=role();state.weekScope=weekScope;
    const status=$("performanceScreenStatus");if(status&&!state.loaded)status.textContent="Sincronizando rankings…";
    const rankingStarted=performance.now();
    // Perfiles, marcador de reset y resumen público se solicitan en paralelo.
    const resetPromise=loadOperationalResetMarker(),profilesPromise=loadProfiles();
    let profilesData=await profilesPromise;
    let rows=await loadWeeklyRankingRows(weekScope,profilesData,currentPeriod.id,{preferOperational});
    await resetPromise;
    if(requestId!==state.refreshRequestId){diagnostic("RENDER_GOALS_RANKING_TAB","RANKING_OLD_REQUEST_DISCARDED",new Error("Se descartó una respuesta anterior del ranking para no sobrescribir datos nuevos."),{moduleName:"BILLING_RANKING_RESTORE",eventType:"WARNING",silent:true,functionName:"refresh",weeklyPeriodId:currentPeriod.id,requestId,currentRequestId:state.refreshRequestId,cacheHit:Boolean(billingCache),cacheMiss:!billingCache,firestorePath:`performance_public/${weekScope.id}/drivers`,query:"requestId guard"});return getState();}
    const candidateRows=(rows||[]).map(row=>normalizeBillingRankingRow({...row,role:"chofer",eligibilityConfirmed:true})).filter(isEligibleRankingParticipant);
    candidateRows.forEach((row,index)=>row.position=index+1);
    const previousRows=canonicalizeBillingRanking((state.rows||[]).filter(isEligibleRankingParticipant));
    const previousByUid=new Map(previousRows.map(row=>[normalize(row.uid),row]));
    const candidateByUid=new Map(candidateRows.map(row=>[normalize(row.uid),row]));
    let effectiveRows=candidateRows;
    const expectedDrivers=Math.max(Number(rows?.activeDriverCount||rows?.expectedDriverCount||0),Number(state.activeDriverCount||0),previousRows.length);
    const responseLooksPartial=candidateRows.length>0&&previousRows.length>candidateRows.length&&candidateRows.length<Math.min(3,Math.max(1,expectedDrivers));
    if(candidateRows.length===0&&previousRows.length){
      effectiveRows=previousRows;
    }else if(responseLooksPartial){
      effectiveRows=canonicalizeBillingRanking(previousRows.map(oldRow=>candidateByUid.get(normalize(oldRow.uid))||oldRow).concat(candidateRows.filter(row=>!previousByUid.has(normalize(row.uid)))));
    }
    effectiveRows.forEach((row,index)=>row.position=index+1);
    const candidateCurrent=currentRowForUid(effectiveRows,user.uid)||currentRowForUid(previousRows,user.uid)||state.current||freshCurrentUserRow(user);
    const candidateSnapshot=performanceSnapshotFromRow(candidateCurrent,{weeklyPeriodId:weekScope.id,updatedAtMs:Date.now(),generationId:state.performanceGeneration,requestId,source:rows?.source||"firestore",sourcePriority:sourcePriority(rows?.source||"firestore"),completeness:profilesData?.complete===true,isConfirmed:true});
    if(!commitConfirmedPerformanceSnapshot(candidateSnapshot,{functionName:"refresh",trigger:reason,cacheKey:performanceRankingCacheKey(weekScope,currentPeriod)}))return getState();
    state.rows=effectiveRows;state.current=candidateCurrent;
    state.activeDriverCount=Math.max(Number(rows?.activeDriverCount||rows?.expectedDriverCount||0),state.rows.length,(profilesData?.profiles||[]).filter(isActiveDriverProfile).length);state.rankingDocumentsRead=Number(rows?.documentsRead||0);state.billingDocumentsRead=Number(rows?.billingDocumentsRead||0);state.rankingSource=String(rows?.source||"merged");state.rankingSummaryComplete=rows?.publicSummaryComplete===true||state.rows.length>=state.activeDriverCount;state.rankingRefreshMs=Math.round(performance.now()-rankingStarted);state.rankingCacheAge=0;
    const newGoalId=state.current?.reachedGoal?.id||0;if(newGoalId>0&&(!wasLoaded||newGoalId!==previousGoalId)){state.dashboardAnimationPending=true;if($("profileScreen")?.classList.contains("is-open"))state.profileAnimationPending=true;}state.lastActiveGoalId=newGoalId;
    state.loaded=true;state.loading=false;state.lastRefresh=Date.now();state.error=null;state.goalView=safeGoalView(state.current?.grossBilling||0);state.forceOperationalRead=false;state.lastRankingContextKey=contextKey;persistPerformanceFastCache(currentPeriod,weekScope);renderAll();
    if(!window.ExploraDashboardRealtimeCoordinator?.isCoordinating?.())window.dispatchEvent(new CustomEvent("explora:performance-updated",{detail:{...getState(),phase:"billing-ready"}}));
    if(state.rankingRefreshMs>800&&!wasLoaded){
      const latencyContext={moduleName:"BILLING_RANKING_RESTORE",functionName:"refresh",weeklyPeriodId:currentPeriod.id,executionMs:state.rankingRefreshMs,activeDriversRead:state.activeDriverCount,rankingDocumentsRead:state.rankingDocumentsRead,billingDocumentsRead:state.billingDocumentsRead,rankingLength:state.rows.length,top3:state.rows.slice(0,3).map(row=>`${row.position}. ${row.name}`).join(" | "),cacheHit:Boolean(billingCache),cacheMiss:!billingCache,cacheAge:billingCache?.age,firestorePath:`performance_public/${weekScope.id}/drivers`,query:"cache -> resumen público rápido -> perfiles activos",refreshBackground:true,result:"RANKING_RENDERED"};
      if(state.rankingRefreshMs>800)diagnostic("PERFORMANCE_TIMEOUT","RANKING_TOO_SLOW_WARNING",new Error(`El refresco de red del ranking tardó ${state.rankingRefreshMs} ms, pero el dashboard permaneció disponible.`),{...latencyContext,eventType:"WARNING"});
      else console.warn("[EXPLORA ranking] refresco de red lento no bloqueante",latencyContext);
    }
    const [derivationResult,historyResult]=await Promise.allSettled([loadWeeklyDerivationRanking(weekScope,profilesData,currentPeriod.id,{preferOperational}),loadHistory(user.uid)]);
    if(requestId!==state.refreshRequestId){diagnostic("RENDER_GOALS_RANKING_TAB","RANKING_OLD_REQUEST_DISCARDED",new Error("Se descartó una respuesta anterior del ranking para no sobrescribir datos nuevos."),{moduleName:"BILLING_RANKING_RESTORE",eventType:"WARNING",silent:true,functionName:"refresh",weeklyPeriodId:currentPeriod.id,requestId,currentRequestId:state.refreshRequestId,cacheHit:Boolean(billingCache),cacheMiss:!billingCache,firestorePath:`performance_public/${weekScope.id}/drivers`,query:"requestId guard"});return getState();}
    const derivations=derivationResult.status==="fulfilled"?derivationResult.value:state.derivations||[];state.derivations=derivations;state.currentDerivationLeader=derivations[0]||null;state.liveDerivationOverlay.clear();
    if(historyResult.status==="fulfilled")state.history=historyResult.value;
    cachePeriodIncentive(currentPeriod,state.rows,derivations);
    const prev=previousPeriod(currentPeriod),closedWinner=await persistClosedPerformance(prev,profilesData);state.derivationLeader=closedWinner||state.derivationLeader||null;state.derivationPeriodId=prev?.id||"";
    persistPerformanceFastCache(currentPeriod,weekScope);renderAll();if(!window.ExploraDashboardRealtimeCoordinator?.isCoordinating?.())window.dispatchEvent(new CustomEvent("explora:performance-updated",{detail:getState()}));return getState();
  },ctx,{ttl:300000,lockKey:`performance-bundle-${user.uid}-${weekScope.id}-${preferOperational?"operational":"public"}`,background:true,visibleDiagnostic:false,slowThresholdMs:800,query:isAdmin()?"resúmenes públicos + fallback operativo Admin":"resúmenes públicos + fallback propio por auth.uid",firestorePath:isAdmin()?`performance_public/${weekScope.id}/drivers + billing_records + derivaciones`:`performance_public/${weekScope.id}/drivers + derivation_ranking_public/${weekScope.id}/drivers`,listenersActive:0,staleValue:getState()})||Promise.resolve(getState());
  state.refreshPromise=Promise.resolve(state.refreshPromise).catch(error=>{state.loading=false;const denied=isPermissionDenied(error);diagnostic("CACHE_VALIDATE",denied?"RANKING_PERMISSION_DENIED":"BILLING_RANKING_READ_FAILED",error,{weeklyPeriodId:currentPeriod.id,functionName:"refresh",cacheHit:Boolean(billingCache||derivationCache||goalCache),cacheMiss:!billingCache&&!derivationCache&&!goalCache,billing:state.current?.grossBilling||0,derivedMoney:totalDerivedMoney(state.derivations),firestorePath:isAdmin()?"performance_public + billing_records + derivaciones":"performance_public + derivation_ranking_public",query:isAdmin()?"refresh ranking bundle Admin":"refresh ranking bundle chofer (sin consultas globales operativas)"});const status=$("performanceScreenStatus");if(status){status.textContent=state.loaded?"Mostrando último dato válido":denied&&!isAdmin()?"Sin resumen público disponible":"Sin datos cargados todavía";status.classList.toggle("is-error",!state.loaded);}if(state.loaded){renderAll();return getState();}if(denied&&!isAdmin()){state.current=state.current||freshCurrentUserRow(user);state.rows=Array.isArray(state.rows)?state.rows:[];state.derivations=Array.isArray(state.derivations)?state.derivations:[];state.goalView=safeGoalView(state.current?.grossBilling||0);state.loaded=true;state.forceOperationalRead=false;renderAll();return getState();}throw error;}).finally(()=>{state.refreshPromise=null;if(state.pendingForcedRefresh){const queuedReason=state.pendingRefreshReason||"queued-update";state.pendingForcedRefresh=false;state.pendingRefreshReason="";queueMicrotask(()=>refresh({force:true,reason:queuedReason}).catch(()=>{}));}});
  return state.refreshPromise;
}
function setTab(tab){const available=new Set(["ranking","derivations"]),target=available.has(String(tab||""))?String(tab):"ranking";state.tab=target;document.querySelectorAll(".performance-tab").forEach(button=>button.classList.toggle("is-active",button.dataset.performanceTab===target));document.querySelectorAll("[data-performance-panel]").forEach(panel=>panel.classList.toggle("is-active",panel.dataset.performancePanel===target));}
function open(tab="ranking",goalId=0){const screen=$("performanceScreen");if(!screen)return;state.open=true;state.highlightGoal=goalId;screen.classList.add("is-open");screen.setAttribute("aria-hidden","false");window.lockPageScroll?.("performance-screen");setTab(tab);setTimeout(()=>runUiRankingGoalsDerivationsAudit(`ranking-${tab}`),120);const period=activeWeeklyPeriod(),weekScope=weekScopeForPeriod(period);state.forceOperationalRead=isAdmin();restorePerformanceFastCache(weekScope,period);if(window.ExploraDashboardRealtimeCoordinator)window.ExploraDashboardRealtimeCoordinator.ensure?.("ranking-open");else refresh({force:true,reason:"ranking-open-background"}).catch(()=>{});if(goalId)requestAnimationFrame(()=>setTimeout(()=>document.querySelector(`[data-goal-row="${goalId}"]`)?.scrollIntoView?.({behavior:prefersReducedMotion()?"auto":"smooth",block:"center"}),80));}
function close(){const screen=$("performanceScreen");screen?.classList.remove("is-open");screen?.setAttribute("aria-hidden","true");state.open=false;window.unlockPageScroll?.("performance-screen");}
function getSettlementIncentive(uid,weeklyPeriodId){const periodData=state.incentiveByPeriod.get(String(weeklyPeriodId||"")),key=normalize(uid);let derivationBonusAmount=periodData&&normalize(periodData.derivationWinnerUid)===key?Number(periodData.derivationBonusAmount||0):0,derivation=derivationBonusAmount>0?DERIVATION_PERCENT:0;if(!periodData){const period=periodFromId(weeklyPeriodId)||activeWeeklyPeriod();if(isWeeklyClosurePeriod(period)&&normalize(state.currentDerivationLeader?.uid)===key){derivationBonusAmount=Math.round(Number(state.currentDerivationLeader?.derivedAmount||0)*DERIVATION_PERCENT/100);derivation=DERIVATION_PERCENT;}}return{derivationPercent:derivation,derivationBonusAmount,estimatedDerivationBonus:Number(periodData?.estimatedDerivationBonus||0),weeklyPeriodId:periodData?.weeklyPeriodId||weeklyPeriodId||"",derivationWinnerUid:periodData?.derivationWinnerUid||""};}
async function prepareSettlementIncentive(uid,weeklyPeriodId){
  const period=periodFromId(weeklyPeriodId);if(!period)return{derivationPercent:0,derivationBonusAmount:0};
  if(state.incentiveByPeriod.has(period.id))return getSettlementIncentive(uid,period.id);
  try{
    const profilesData=await loadProfiles(),weekScope=weekScopeForPeriod(period);
    const [rows,derivations]=await Promise.all([loadWeeklyRankingRows(weekScope,profilesData,period.id),loadWeeklyDerivationRanking(weekScope,profilesData,period.id)]);
    cachePeriodIncentive(period,rows,derivations);
    return getSettlementIncentive(uid,period.id);
  }catch(error){diagnostic("WEEKLY_BENEFIT","SETTLEMENT_INCENTIVE_PREPARE_FAILED",error,{weeklyPeriodId:weekScopeForPeriod(period).id,functionName:"prepareSettlementIncentive"});throw error;}
}
function resetOperationalState({resetAtMs=Date.now()}={}){cancelGoalReturn();state.refreshRequestId+=1;state.refreshPromise=null;state.operationalResetAtMs=Math.max(0,Number(resetAtMs||Date.now()));invalidatePerformanceCaches(fastContext(weekScopeForPeriod(activeWeeklyPeriod()),activeWeeklyPeriod()),"operational-reset");state.rows=[];state.derivations=[];state.history=[];state.currentDerivationLeader=null;state.derivationLeader=null;state.derivationPeriodId="";state.incentiveByPeriod.clear();state.weeklyAwards.clear();state.liveDerivationOverlay.clear();state.lastActiveGoalId=0;state.dashboardAnimationPending=false;state.profileAnimationPending=false;state.error=null;state.lastDiagnostic=null;state.cacheRestored=false;state.forceOperationalRead=isAdmin();state.current=freshCurrentUserRow();state.goalView=safeGoalView(0);state.loaded=true;state.loading=false;state.lastRefresh=Date.now();renderAll();const profileCard=$("profileGoalCard");if(profileCard)profileCard.hidden=true;return getState();}
function recordCompletedDerivation(uid,row){state.forceOperationalRead=true;invalidatePerformanceCaches(fastContext(weekScopeForPeriod(activeWeeklyPeriod()),activeWeeklyPeriod()),"derivation-completed");refresh({force:true,reason:"derivation-completed"}).catch(error=>diagnostic("REFRESH_AFTER_DERIVATION","DERIVATION_RANKING_READ_FAILED",error,{emisorUid:uid,derivationId:row?.derivationId||row?.id,derivedMoney:derivationAmount(row),derivationBonus:Math.round(derivationAmount(row)*DERIVATION_PERCENT/100),functionName:"recordCompletedDerivation"}));}
function performanceWeeklySnapshotCacheKey(uid="",periodId=""){return `weeklySnapshot:${String(uid||"").trim()}:${String(periodId||"").trim()}`;}
function applyUnifiedWeeklySnapshot(snapshot={}){
  const uid=String(snapshot.driverUid||snapshot.uid||auth?.currentUser?.uid||"").trim(),periodId=String(snapshot.weeklyPeriodId||"").trim(),active=activeWeeklyPeriod(),weekScope=weekScopeForPeriod(active);
  if(!uid||uid===EXPLORA_ADMIN_UID||!periodId||periodId!==active.id)return getState();
  const total=Math.max(0,Number(snapshot.totalFacturado??snapshot.grossBilling??0)||0),requestId=Math.max(0,Number(snapshot.requestId||snapshot.snapshotRequestId||0))||Number(state.lastAppliedUnifiedSnapshotId||0)+1;
  const incoming=performanceSnapshotFromRow({uid,grossBilling:total,serviceCount:Number(snapshot.cantidadCobros??snapshot.serviceCount??0)},{weeklyPeriodId:weekScope.id,updatedAtMs:Number(snapshot.operationalUpdatedAt||snapshot.updatedAtMs||Date.now()),generationId:Number(snapshot.generationId||state.performanceGeneration),requestId,source:String(snapshot.realtimeCommitted?"live-realtime":"weekly-firestore"),sourcePriority:snapshot.realtimeCommitted?500:300,completeness:snapshot.loading!==true,isConfirmed:snapshot.realtimeCommitted===true||snapshot.isConfirmed===true||snapshot.loading!==true,explicitDecrease:snapshot.explicitDecrease===true});
  if(!commitConfirmedPerformanceSnapshot(incoming,{functionName:"applyUnifiedWeeklySnapshot",trigger:snapshot.realtimeReason||"unified-weekly-snapshot",cacheKey:performanceWeeklySnapshotCacheKey(uid,periodId)}))return getState();
  state.lastAppliedUnifiedSnapshotId=Math.max(Number(state.lastAppliedUnifiedSnapshotId||0),requestId);
  const globalRow=currentRowForUid(state.rows,uid);
  state.rows=canonicalizeBillingRanking(state.rows);
  state.authenticatedUserState=normalizeBillingRankingRow({...(globalRow||{}),uid,role:"chofer",eligibilityConfirmed:true,grossBilling:total,serviceCount:Number(snapshot.cantidadCobros??snapshot.serviceCount??globalRow?.serviceCount??0),updatedAtMs:incoming.updatedAtMs});
  state.current=state.authenticatedUserState;state.uid=uid;state.weekScope=weekScope;state.goalView=safeGoalView(incoming.grossBilling);state.loaded=true;state.loading=false;state.lastRefresh=Date.now();state.error=null;
  persistPerformanceFastCache(active,state.weekScope);renderAll();return getState();
}

function applyRealtimeOperationalRows(payload={}){
  const periodId=String(payload.weeklyPeriodId||"").trim(),active=activeWeeklyPeriod(),revision=Math.max(0,Number(payload.snapshotRevision||payload.requestId||0));
  if(!periodId||periodId!==active.id||revision<Number(state.lastAppliedUnifiedSnapshotId||0))return getState();
  const rawRows=Array.isArray(payload.rows)?payload.rows:[];
  if(!rawRows.length){
    state.loading=false;
    renderAll();
    window.ExploraDailyRanking?.refresh?.({force:true}).catch?.(()=>{});
    return getState();
  }
  const previousByUid=new Map((state.rows||[]).filter(isEligibleRankingParticipant).map(row=>[normalize(row.uid),row]));
  const operational=rawRows.map((raw,index)=>{
    const row=publicPerformanceRow(raw,raw?.id||raw?.driverUid||String(index));if(!row)return null;const previous=previousByUid.get(normalize(row.uid));
    if(previous?.avatar)row.avatar=previous.avatar;if(previous?.name&&previous.name!=="Chofer")row.name=previous.name;
    return row;
  }).filter(row=>row&&row.uid!==EXPLORA_ADMIN_UID);
  const operationalUids=new Set(operational.map(row=>normalize(row.uid)));
  const inactive=(state.rows||[]).filter(isEligibleRankingParticipant).filter(row=>!operationalUids.has(normalize(row.uid)));
  state.rows=canonicalizeBillingRanking([...inactive,...operational]);
  const billingByUid=new Map(state.rows.map(row=>[normalize(row.uid),row]));
  state.derivations=rawRows.map((raw,index)=>{
    const row=publicDerivationRow(raw,raw?.id||raw?.driverUid||String(index));if(!row||!(row.derivedAmount>0))return null;const billing=billingByUid.get(normalize(row.uid));if(billing?.avatar)row.avatar=billing.avatar;if(billing?.name)row.name=billing.name;return row;
  }).filter(Boolean);
  state.derivations=canonicalizeDerivationRanking(state.derivations);state.currentDerivationLeader=state.derivations[0]||null;
  const uid=String(payload.uid||payload.driverUid||auth?.currentUser?.uid||"").trim(),candidateCurrent=currentRowForUid(state.rows,uid)||null;
  if(candidateCurrent){
    const incoming=performanceSnapshotFromRow(candidateCurrent,{weeklyPeriodId:weekScopeForPeriod(active).id,updatedAtMs:Number(payload.operationalUpdatedAt||payload.updatedAtMs||Date.now()),generationId:Number(payload.generationId||state.performanceGeneration),requestId:revision,source:"acumulados_semanales-realtime",sourcePriority:500,completeness:true,isConfirmed:true,explicitDecrease:payload.explicitDecrease===true});
    if(!commitConfirmedPerformanceSnapshot(incoming,{functionName:"applyRealtimeOperationalRows",trigger:payload.reason||"realtime-operational-rows",cacheKey:"acumulados_semanales"}))return getState();
  }
  state.current=candidateCurrent||state.authenticatedUserState||currentRowForUid(state.rows,uid)||freshCurrentUserRow({uid});
  state.authenticatedUserState=state.current;
  state.uid=uid;state.weekScope=weekScopeForPeriod(active);state.goalView=safeGoalView(state.current?.grossBilling||0);state.activeDriverCount=Math.max(state.rows.length,Number(payload.activeDriverCount||0));state.rankingSummaryComplete=true;state.rankingSource="acumulados_semanales-realtime";state.loaded=true;state.loading=false;state.lastRefresh=Date.now();state.error=null;state.lastAppliedUnifiedSnapshotId=Math.max(Number(state.lastAppliedUnifiedSnapshotId||0),revision);
  persistPerformanceFastCache(active,state.weekScope);renderAll();return getState();
}

function getState(){return{loaded:state.loaded,loading:state.loading,uid:state.uid,role:state.role,weekScope:state.weekScope,rows:state.rows,current:state.current,goalView:state.goalView,rankingSnapshot:state.rankingSnapshot,derivations:state.derivations,currentDerivationLeader:state.currentDerivationLeader,derivationLeader:state.derivationLeader,derivationPeriodId:state.derivationPeriodId,history:state.history};}
async function calculateForPeriod(period){
  const target=normalizeWeeklyPeriod(period);
  if(!target?.id||!Number.isFinite(Number(target.startKeyMs)))throw Object.assign(new Error("ADMIN_WEEKLY_PERIOD_INVALID"),{code:"ADMIN_WEEKLY_PERIOD_INVALID"});
  const profiles=await loadProfiles(),weekScope=weekScopeForPeriod(target);
  const [rows,derivations]=await Promise.all([loadWeeklyRankingRows(weekScope,profiles,target.id,{preferOperational:true}),loadWeeklyDerivationRanking(weekScope,profiles,target.id,{preferOperational:true})]);
  cachePeriodIncentive(target,rows,derivations);
  return{weekScope:weekScope,rows,derivations};
}

window.getGoalBubbleWindow=getGoalBubbleWindow;
window.getVisibleGoalBubbles=getVisibleGoalBubbles;
function runUiRankingGoalsDerivationsAudit(screenName="dashboard"){
  requestAnimationFrame(()=>{
    const visibleRoots=[...document.querySelectorAll("#dashboardReal,#performanceScreen.is-open,#derivationScreen.is-open")].filter(node=>node&&getComputedStyle(node).display!=="none");
    const textTargets=visibleRoots.flatMap(root=>[...root.querySelectorAll(".finance-label-real,.finance-receipts-title,.finance-card-real>strong,.performance-ranking-copy,.performance-goal-value")]);
    const overflow=textTargets.find(node=>node.scrollWidth>node.clientWidth+3);
    if(overflow){
      diagnostic("LAYOUT_FINANCE_CARDS","TEXT_OVERFLOW_DETECTED",new Error("Se detectó un texto o monto fuera de su contenedor."),{moduleName:"UI_RANKING_GOALS_DERIVATIONS_REPAIR",functionName:"runUiRankingGoalsDerivationsAudit",screen:screenName,element:overflow.id||overflow.className||overflow.tagName,containerWidth:overflow.clientWidth,textWidth:overflow.scrollWidth});
      return;
    }
    const nested=visibleRoots.flatMap(root=>[...root.querySelectorAll(".derivation-section-card,.performance-explanation-card,.performance-ranking-list,.performance-goals-list")]).find(node=>{const css=getComputedStyle(node),scrollable=/auto|scroll/.test(css.overflowY);return scrollable&&node.scrollHeight>node.clientHeight+4;});
    if(nested)diagnostic("REMOVE_DOUBLE_SCROLL","DOUBLE_SCROLL_DETECTED",new Error("Se detectó scroll vertical dentro de una tarjeta."),{moduleName:"UI_RANKING_GOALS_DERIVATIONS_REPAIR",functionName:"runUiRankingGoalsDerivationsAudit",screen:screenName,element:nested.id||nested.className||nested.tagName,scrollHeight:nested.scrollHeight,clientHeight:nested.clientHeight});
  });
}
window.ExploraUIRankingGoalsDerivationsRepair={audit:runUiRankingGoalsDerivationsAudit};
window.ExploraPerformanceEngine={GOALS,refresh,open,close,getState,calculateGoalFromBilling,acceptWeeklyPerformanceSnapshot,isEligibleRankingParticipant,getGoalBubbleWindow,getVisibleGoalBubbles,renderProfileGoal,animateDashboardGoal,getSettlementIncentive,prepareSettlementIncentive,recordCompletedDerivation,calculateForPeriod,resetOperationalState,applyUnifiedWeeklySnapshot,applyRealtimeOperationalRows,openGoalBenefitDetail,closeGoalBenefitDetail,invalidateRankingCache:(reason="external")=>{state.forceOperationalRead=isAdmin();return invalidatePerformanceCaches(fastContext(weekScopeForPeriod(activeWeeklyPeriod()),activeWeeklyPeriod()),reason);},showDiagnostic:diagnostic,closeDiagnostic};
window.addEventListener("explora:unified-weekly-snapshot",event=>applyUnifiedWeeklySnapshot(event.detail||{}));
window.ExploraDerivationMoneyRankingEngine={refresh,getState,calculateForPeriod,getSettlementIncentive,DERIVATION_PERCENT};
$("performanceDashboardOpenBtn")?.addEventListener("click",()=>open("ranking"));
$("performanceRankingCard")?.addEventListener("click",()=>open("ranking"));
$("performanceDerivatorCard")?.addEventListener("click",()=>open("derivations"));
$("performanceBackBtn")?.addEventListener("click",close);
$("performanceRefreshBtn")?.addEventListener("click",()=>{state.forceOperationalRead=isAdmin();invalidatePerformanceCaches(fastContext(weekScopeForPeriod(activeWeeklyPeriod()),activeWeeklyPeriod()),"manual-refresh");refresh({force:true,reason:"manual-refresh"}).catch(()=>{});});
$("performanceDiagnosticCloseBtn")?.addEventListener("click",closeDiagnostic);
$("performanceDiagnosticCloseActionBtn")?.addEventListener("click",closeDiagnostic);
$("performanceDiagnosticCopyBtn")?.addEventListener("click",copyDiagnostic);
document.querySelectorAll(".performance-tab").forEach(button=>button.addEventListener("click",()=>setTab(button.dataset.performanceTab)));
window.addEventListener("explora:main-nav-active",event=>{
  if(event.detail?.section!=="inicio")return;
  if(state.loaded)requestAnimationFrame(()=>animateDashboardGoal("DASHBOARD_ENTER"));
  else state.dashboardAnimationPending=true;
  if(auth?.currentUser&&!role().includes("admin")){
    if(window.ExploraDashboardRealtimeCoordinator){window.ExploraDashboardRealtimeCoordinator.ensure?.("performance-dashboard-open");return;}
    const period=activeWeeklyPeriod(),weekScope=weekScopeForPeriod(period);state.forceOperationalRead=isAdmin();restorePerformanceFastCache(weekScope,period);refresh({force:true,reason:"dashboard-open-background"}).catch(()=>{});
  }
});
window.addEventListener("explora:session-opened",event=>{if(normalize(event.detail?.role).includes("admin"))return;state.dashboardAnimationPending=true;if(!state.lastConfirmedSnapshot)restorePerformanceFastCache();if(window.ExploraDashboardRealtimeCoordinator){window.ExploraDashboardRealtimeCoordinator.ensure?.("performance-session");return;}refresh({force:false,reason:"session-opened"}).catch(()=>{});});
window.addEventListener("explora:auth-cleared",()=>{
  cancelGoalReturn();try{state.goalResizeObserver?.disconnect?.();}catch(_){}state.goalResizeObserver=null;
  derivationRankingInit.requestId+=1;derivationRankingInit.promise=null;derivationRankingInit.key="";
  state.loaded=false;state.rows=[];state.current=null;state.goalView=null;state.derivations=[];state.operationalResetAtMs=0;state.activeDriverCount=0;state.rankingDocumentsRead=0;state.billingDocumentsRead=0;state.rankingSource="";state.rankingRefreshMs=0;state.rankingCacheAge=0;state.rankingSummaryComplete=false;state.diagnosticKeys.clear();state.cacheRestored=false;state.refreshRequestId+=1;state.currentDerivationLeader=null;state.derivationLeader=null;state.derivationPeriodId="";state.lastActiveGoalId=0;state.goalWindowStartLeft=0;state.dashboardAnimationPending=false;state.profileAnimationPending=false;state.forceOperationalRead=true;state.pendingForcedRefresh=false;state.pendingRefreshReason="";state.lastRankingContextKey="";
  const profileCard=$("profileGoalCard");if(profileCard)profileCard.hidden=true;
  closeGoalBenefitDetail();renderAll();close();
});
function handleRankingMutation(event){
  const isDerivation=event.type==="explora:derivacion-completada",stage=isDerivation?"REFRESH_AFTER_DERIVATION":"REFRESH_AFTER_PAYMENT",reason=isDerivation?"derivation-completed":"billing-created",period=activeWeeklyPeriod(),weekScope=weekScopeForPeriod(period),ctx=fastContext(weekScope,period);
  state.forceOperationalRead=isAdmin();invalidatePerformanceCaches(ctx,reason);
  refresh({force:true,reason}).catch(error=>diagnostic(stage,isDerivation?"DERIVATION_RANKING_READ_FAILED":"BILLING_RANKING_READ_FAILED",error,{functionName:"handleRankingMutation",weeklyPeriodId:period.id,firestorePath:isDerivation?"derivaciones":"billing_records",query:"invalidate cache + forced operational refresh",derivedMoney:isDerivation?derivationAmount(event.detail||{}):totalDerivedMoney(state.derivations),billing:isDerivation?state.current?.grossBilling:amountOf(event.detail||{})}));
}
["explora:cobro-registrado","explora:derivacion-completada"].forEach(name=>window.addEventListener(name,handleRankingMutation));
window.addEventListener("explora:simulation-updated",event=>{
  const period=activeWeeklyPeriod(),weekScope=weekScopeForPeriod(period),ctx=fastContext(weekScope,period);state.forceOperationalRead=isAdmin();invalidatePerformanceCaches(ctx,"simulation-updated");
  refresh({force:true,reason:event.detail?.reason||"simulation-updated"}).catch(error=>diagnostic("CACHE_INVALIDATE_SIMULATION","CACHE_STALE_AFTER_SIMULATION",error,{functionName:"simulationUpdatedRefresh",weeklyPeriodId:period.id,documentsAffected:event.detail?.documentsChanged??"—",firestorePath:"billing_records + gastos",query:"simulation event -> operational refresh"}));
});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState!=="visible"||!auth?.currentUser||role().includes("admin"))return;if(window.ExploraDashboardRealtimeCoordinator){window.ExploraDashboardRealtimeCoordinator.ensure?.("performance-foreground");return;}const period=activeWeeklyPeriod(),weekScope=weekScopeForPeriod(period);state.forceOperationalRead=false;if(!state.lastConfirmedSnapshot)restorePerformanceFastCache(weekScope,period);refresh({force:true,reason:"foreground-background"}).catch(()=>{});});
bindGoalCarousel();
if(!window.__exploraPerformanceFastRefreshRegistered){
  window.__exploraPerformanceFastRefreshRegistered=true;
  const scheduledPerformanceRefresh=()=>refresh({force:true});
  const performanceContext=()=>fastContext(state.weekScope||weekScopeForPeriod(activeWeeklyPeriod()),activeWeeklyPeriod());
  window.ExploraFastCache?.registerRefresher?.("billing_ranking",scheduledPerformanceRefresh,{ttl:600000,lockKey:"performance-scheduled-refresh",context:performanceContext});
  window.ExploraFastCache?.registerRefresher?.("derivation_ranking",scheduledPerformanceRefresh,{ttl:600000,lockKey:"performance-scheduled-refresh",context:performanceContext});
}
if(auth?.currentUser&&!role().includes("admin")){state.dashboardAnimationPending=true;if(!state.lastConfirmedSnapshot)restorePerformanceFastCache();if(window.ExploraDashboardRealtimeCoordinator)window.ExploraDashboardRealtimeCoordinator.ensure?.("performance-initial");else refresh({force:false,reason:"initial-load"}).catch(()=>{});}
else setTimeout(()=>{if(auth?.currentUser&&!role().includes("admin")){state.dashboardAnimationPending=true;if(!state.lastConfirmedSnapshot)restorePerformanceFastCache();if(window.ExploraDashboardRealtimeCoordinator)window.ExploraDashboardRealtimeCoordinator.ensure?.("performance-delayed-initial");else refresh({force:false,reason:"delayed-initial-load"}).catch(()=>{});}},1200);
renderAll();
