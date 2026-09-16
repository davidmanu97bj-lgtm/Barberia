import { getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, query, where, getDocs, getDoc, doc, setDoc, runTransaction, serverTimestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  weeklyPeriodFromDate, previousWeeklyPeriod, DEFAULT_TIMEZONE
} from "../core/weekly-core.mjs";
import {
  DAILY_RANKING_VERSION, DAILY_RANKING_BONUS_AMOUNT, operationalDayIdFromDate, normalizeDailyMoney,
  addOperationalDays, buildDailyLeaderResult, dailyRankingBonusDocument, dailyLeaderCurrentMessage,
  normalizeDailyBonusRow, dailyBonusesForDriver, totalDailyBonuses
} from "../core/daily-ranking-bonus.mjs";

(() => {
  "use strict";
  if (window.__exploraDailyRankingBonusV2415) return;
  window.__exploraDailyRankingBonusV2415 = true;

  const app = getApps().length ? getApp() : null;
  const auth = app ? getAuth(app) : null;
  const db = app ? getFirestore(app) : null;
  const TZ = DEFAULT_TIMEZONE || "America/Argentina/Cordoba";
  const HARD_INVALID_STATES = ["cancel", "rechaz", "elimin", "borrador", "anulad", "void", "deleted"];
  const SOFT_INVALID_STATES = ["pending", "pendiente", "expired", "vencid", "error", "failed"];
  const VALID_STATES = ["completed", "completado", "confirmado", "confirmed", "approved", "processed", "paid", "pagado", "facturado", "facturada", "cobrado", "cobrada", "admin_confirmed", "manually_confirmed", "receipt_uploaded", "invoiced"];
  const $ = id => document.getElementById(id);
  const text = value => String(value ?? "").trim();
  const normalize = value => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s-]+/g, "_");
  const positive = value => Math.max(0, normalizeDailyMoney(value));
  const escapeHtml = value => text(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const money = value => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Math.round(Number(value) || 0));
  const WEEK_DAY_LABELS = Object.freeze(["SÁBADO","DOMINGO","LUNES","MARTES","MIÉRCOLES","JUEVES","VIERNES"]);
  const WEEKLY_PLAQUES_VERSION = "v2.4.39-cache-busters-final-sync";
  const WEEKLY_PLAQUES_CACHE_PREFIX = "explora_weekly_plaques_v2415";
  const DAILY_GLOBAL_CACHE_PREFIX = "explora_daily_global_leader_v2439";
  const FIRESTORE_READ_TIMEOUT_MS = 4500;
  const GLOBAL_DAILY_READ_TIMEOUT_MS = 12000;
  const LIVE_RANKING_REFRESH_MS = 30000;
  const WEEKLY_PLAQUES_RETRY_MS = 12000;
  const state = {
    requestId:0, dayId:"", weeklyPeriodId:"", rows:[], result:null, records:[], bonuses:[], loading:false,
    lastError:null, timer:0, authUid:"", finalizedDays:new Set(), refreshPromise:null,
    publicDayId:"", publicUnsubscribe:null, readDiagnostics:null, expectedActivity:null,
    lastDiagnosticSignature:"", lastDiagnosticAt:0,
    weeklyPlaques:[], weeklyPlaquesPeriodId:"", weeklyPlaquesLoading:false, weeklyPlaquesRequestId:0, weeklyPlaquesPromise:null,
    plaqueObserver:null, plaqueObserverTarget:null, plaqueObserverMuted:false, lastPlaqueFinalizeAt:0,
    weeklyPlaquesGeneration:0, weeklyPlaquesRetryTimer:0, weeklyPlaquesContextKey:"", liveRefreshTimer:0,
    dailyLeaderCommitGeneration:0, dailyLeaderLastCommittedAt:0, pendingPublicDaily:null,
    weeklySelectorAudioContext:null, weeklySelectorAudioUnlocked:false, weeklySelectorLastCrackAt:0
  };

  function operationalNow() {
    const value = window.ExploraOperationalClock?.getNow?.();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
  }
  function currentPeriod(date = operationalNow()) {
    const central = window.ExploraOperationalClock?.getActiveWeeklyPeriod?.();
    return central?.id ? central : weeklyPeriodFromDate(date,TZ);
  }
  function previousPeriod(period = currentPeriod()) {
    try { return previousWeeklyPeriod(period,TZ); } catch (_) { return null; }
  }
  function isTestMode() {
    return Boolean(window.ExploraOperationalClock?.isTestMode?.() || window.ExploraOperationalClock?.getDiagnostic?.()?.testMode || localStorage.getItem("explora_admin_test_now_v290"));
  }
  function bonusCollectionName() { return isTestMode() ? "dailyRankingBonus_test" : "dailyRankingBonus"; }
  function publicCollectionName() { return isTestMode() ? "dailyRankingPublic_test" : "dailyRankingPublic"; }
  function role() {
    const session = window.ExploraSession || {};
    const authSession = window.ExploraAuthSession || {};
    const raw = session.role || session.rol || session.profile?.role || session.profile?.rol || session.profile?.tipoUsuario ||
      authSession.role || authSession.rol || authSession.profile?.role || authSession.profile?.rol ||
      (document.body.classList.contains("explora-shared-admin") ? "admin" : "chofer");
    return normalize(raw || "chofer");
  }
  function isAdmin() {
    const currentRole = role();
    return ["admin","administrador","owner","propietario","superadmin"].includes(currentRole) || currentRole.includes("admin") || document.body.classList.contains("explora-shared-admin");
  }
  async function waitForSessionReady(timeoutMs = 6000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const session = window.ExploraSession || {};
      if (!auth?.currentUser?.uid) return false;
      if (session.initialized || session.authReady || session.profile || session.role || session.rol || document.body.classList.contains("explora-shared-admin")) return true;
      await new Promise(resolve => setTimeout(resolve,40));
    }
    diagnostic("WAIT_SESSION","DAILY_RANKING_SESSION_NOT_READY",new Error("La sesión no quedó completamente inicializada antes de leer el ranking diario."),{functionName:"waitForSessionReady",timeoutMs,role:role()});
    return false;
  }

  function withTimeout(promise, timeoutMs = FIRESTORE_READ_TIMEOUT_MS, code = "FIRESTORE_READ_TIMEOUT") {
    let timer = 0;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_,reject) => { timer = window.setTimeout(() => reject(Object.assign(new Error("La lectura de Firestore superó el tiempo máximo permitido."),{code,timeoutMs})),timeoutMs); })
    ]).finally(() => clearTimeout(timer));
  }
  function weeklyPlaquesContext(period = currentPeriod(), todayId = operationalDayIdFromDate(operationalNow(),TZ)) {
    return `${auth?.currentUser?.uid || "anonymous"}|${period?.id || ""}|${todayId}|${publicCollectionName()}`;
  }
  function weeklyPlaquesCacheKey(periodId = "") { return `${WEEKLY_PLAQUES_CACHE_PREFIX}:${publicCollectionName()}:${periodId}`; }
  function dailyGlobalCacheKey(dayId = "") { return `${DAILY_GLOBAL_CACHE_PREFIX}:${publicCollectionName()}:${dayId}`; }
  function saveDailyGlobalCache(dayId = "", weeklyPeriodId = "", rows = [], result = null) {
    if (!dayId || !result) return;
    try {
      localStorage.setItem(dailyGlobalCacheKey(dayId),JSON.stringify({
        version:"v2.4.15", dayId, weeklyPeriodId:text(weeklyPeriodId), updatedAt:Date.now(),
        rows:publicRows(rows),
        result:{
          operationalDayId:dayId, weeklyPeriodId:text(weeklyPeriodId), hasLeader:Boolean(result.hasLeader),
          status:text(result.status), message:text(result.message), winnerDriverId:text(result.winnerDriverId),
          winnerDriverName:text(result.winnerDriverName), winnerDriverAvatar:text(result.winnerDriverAvatar),
          winnerDailyAmount:positive(result.winnerDailyAmount), runnerUpDailyAmount:positive(result.runnerUpDailyAmount),
          winnerServiceCount:Math.max(0,Math.trunc(Number(result.winnerServiceCount)||0)),
          winnerReachedAtMs:Math.max(0,Number(result.winnerReachedAtMs)||0),
          winnerLeadPercentage:result.winnerLeadPercentage ?? null, leaderReason:text(result.leaderReason),
          tieBreakApplied:Boolean(result.tieBreakApplied), tieBreakRule:text(result.tieBreakRule),
          activeDriverCount:Math.max(0,Math.trunc(Number(result.activeDriverCount)||0)), bonusAmount:positive(result.bonusAmount)
        }
      }));
    } catch (_) {}
  }
  function loadDailyGlobalCache(dayId = "", weeklyPeriodId = "") {
    if (!dayId) return null;
    try {
      const parsed = JSON.parse(localStorage.getItem(dailyGlobalCacheKey(dayId)) || "null");
      if (!parsed || parsed.dayId !== dayId || (parsed.weeklyPeriodId && weeklyPeriodId && parsed.weeklyPeriodId !== weeklyPeriodId) || !parsed.result) return null;
      const rows = publicRows(parsed.rows || []);
      const cached = parsed.result || {};
      const computed = buildDailyLeaderResult(rows,dayId,weeklyPeriodId || parsed.weeklyPeriodId);
      const result = computed.hasLeader ? computed : cached.hasLeader ? Object.freeze({
        ...cached, operationalDayId:dayId, weeklyPeriodId:weeklyPeriodId || parsed.weeklyPeriodId, hasLeader:true,
        status:text(cached.status || "lead"), message:dailyLeaderCurrentMessage(cached),
        activeDriverCount:Math.max(1,Math.trunc(Number(cached.activeDriverCount)||1)),
        bonusAmount:DAILY_RANKING_BONUS_AMOUNT, source:"daily-global-cache"
      }) : buildDailyLeaderResult([],dayId,weeklyPeriodId || parsed.weeklyPeriodId);
      return {rows,result};
    } catch (_) { return null; }
  }
  function sourcedDailyResult(result, source = "") {
    return Object.freeze({...result,source:text(source)});
  }
  function neutralDailyResult(dayId = "", weeklyPeriodId = "", source = "neutral") {
    return sourcedDailyResult(buildDailyLeaderResult([],dayId,weeklyPeriodId),source);
  }
  function loadingDailyResult(dayId = "", weeklyPeriodId = "") {
    return Object.freeze({
      operationalDayId:text(dayId), weeklyPeriodId:text(weeklyPeriodId), hasLeader:false, status:"loading",
      message:"Calculando ranking actual...", winner:null, runnerUp:null, winnerDriverId:"", winnerDriverName:"", winnerDriverAvatar:"",
      winnerDailyAmount:0, runnerUpDailyAmount:0, winnerServiceCount:0, winnerReachedAtMs:0, winnerLeadPercentage:null,
      leaderReason:"loading", tieBreakApplied:false, tieBreakRule:"", activeDriverCount:0, bonusAmount:0, source:"loading"
    });
  }

  function dailyResultGeneratedAtMs(result = {}) {
    return Math.max(0,Number(result?.generatedAtMs || result?.updatedAtMs || result?.winnerReachedAtMs || 0) || 0);
  }
  function dailyResultCompletenessScore(candidate = {}) {
    const result = candidate.result || candidate;
    let score = 0;
    if (result?.hasLeader && result?.winnerDriverId) score += 50;
    if (positive(result?.winnerDailyAmount) > 0) score += 20;
    if (Array.isArray(candidate.rows) && candidate.rows.length) score += 10;
    if (text(result?.source || candidate.source) === "global-operational") score += 30;
    if (text(result?.source || candidate.source).startsWith("daily-public")) score += 10;
    if (text(result?.source || candidate.source).includes("cache")) score -= 20;
    return score;
  }
  function commitDailyLeaderState(candidate = {}, { render = true, dispatch = false, generation = 0, source = "" } = {}) {
    const dayId = text(candidate.dayId || candidate.operationalDayId || candidate.result?.operationalDayId);
    const weeklyPeriodId = text(candidate.weeklyPeriodId || candidate.periodId || candidate.result?.weeklyPeriodId);
    const result = candidate.result ? sourcedDailyResult(candidate.result,source || candidate.result.source || "daily-commit") : null;
    if (!dayId || !weeklyPeriodId || !result) return false;
    const currentDay = operationalDayIdFromDate(operationalNow(),TZ);
    if (dayId !== currentDay || result.operationalDayId !== dayId) return false;
    if (state.dayId === dayId && state.weeklyPeriodId === weeklyPeriodId && state.result?.hasLeader) {
      const currentSource = text(state.result.source);
      const nextSource = text(result.source);
      const currentGlobal = currentSource === "global-operational";
      const nextGlobal = nextSource === "global-operational";
      if (currentGlobal && !nextGlobal) return false;
      if (!nextGlobal && dailyResultCompletenessScore(candidate) < dailyResultCompletenessScore({rows:state.rows,result:state.result})) return false;
      const nextGeneratedAt = dailyResultGeneratedAtMs(result);
      const currentGeneratedAt = dailyResultGeneratedAtMs(state.result);
      if (!nextGlobal && nextGeneratedAt && currentGeneratedAt && nextGeneratedAt < currentGeneratedAt) return false;
    }
    if (generation && generation < state.dailyLeaderCommitGeneration) return false;
    if (generation) state.dailyLeaderCommitGeneration = generation;
    state.dayId = dayId; state.weeklyPeriodId = weeklyPeriodId;
    state.records = Array.isArray(candidate.records) ? candidate.records : [];
    state.rows = Array.isArray(candidate.rows) ? candidate.rows : [];
    state.result = result; state.lastError = candidate.lastError || null; state.dailyLeaderLastCommittedAt = Date.now();
    if (render) renderAll();
    if (dispatch) window.dispatchEvent(new CustomEvent("explora:daily-ranking-updated",{detail:getState()}));
    return true;
  }
  function setDailyLoading(dayId = "", weeklyPeriodId = "") {
    state.pendingPublicDaily = null;
    const sameCurrent = state.dayId === dayId && state.weeklyPeriodId === weeklyPeriodId && state.result?.operationalDayId === dayId && state.result?.weeklyPeriodId === weeklyPeriodId;
    if (sameCurrent && state.result?.hasLeader) return;
    state.dayId = dayId; state.weeklyPeriodId = weeklyPeriodId; state.rows = []; state.records = []; state.result = loadingDailyResult(dayId,weeklyPeriodId); renderAll();
  }
  function loadWeeklyPlaquesCache(period, todayId) {
    try {
      const parsed = JSON.parse(localStorage.getItem(weeklyPlaquesCacheKey(period?.id)) || "null");
      if (!parsed || parsed.periodId !== period?.id || !Array.isArray(parsed.rows)) return [];
      return parsed.rows.filter(row => row && row.dayId && row.dayId < todayId && ["winner","no_activity"].includes(row.state));
    } catch (_) { return []; }
  }
  function saveWeeklyPlaquesCache(period, rows = []) {
    try {
      const valid = rows.filter(row => row && ["winner","no_activity"].includes(row.state)).map(row => ({...row}));
      localStorage.setItem(weeklyPlaquesCacheKey(period?.id),JSON.stringify({version:WEEKLY_PLAQUES_VERSION,periodId:period?.id,updatedAt:Date.now(),rows:valid}));
    } catch (_) {}
  }
  function scheduleWeeklyPlaquesRetry() {
    clearTimeout(state.weeklyPlaquesRetryTimer);
    state.weeklyPlaquesRetryTimer = window.setTimeout(() => refreshWeeklyPlaques({force:true,background:true}).catch(() => {}),WEEKLY_PLAQUES_RETRY_MS);
  }
  function invalidateWeeklyPlaques(reason = "context-change") {
    state.weeklyPlaquesGeneration += 1;
    state.weeklyPlaquesRequestId += 1;
    state.weeklyPlaquesPromise = null;
    state.weeklyPlaquesLoading = false;
    clearTimeout(state.weeklyPlaquesRetryTimer);
    state.weeklyPlaquesRetryTimer = 0;
    state.weeklyPlaquesContextKey = "";
    return reason;
  }

  function diagnostic(stage, code, error, context = {}) {
    const issue = error instanceof Error ? error : new Error(text(error || code || "Error desconocido"));
    const now = new Date();
    const dayId = context.operationalDayId || state.dayId || (() => { try { return operationalDayIdFromDate(operationalNow(),TZ); } catch (_) { return "—"; } })();
    const periodId = context.weeklyPeriodId || state.weeklyPeriodId || currentPeriod()?.id || "—";
    const signature = [stage,code,issue.code || "",issue.message,dayId,periodId].join("|");
    if (state.lastDiagnosticSignature === signature && Date.now() - state.lastDiagnosticAt < 5000) return null;
    state.lastDiagnosticSignature = signature; state.lastDiagnosticAt = Date.now(); state.lastError = issue;
    const detail = {
      moduleName:"DAILY_RANKING", functionName:context.functionName || "dailyRanking", weeklyPeriodId:periodId,
      driverUid:context.driverUid || "", driverName:context.driverName || "", firestorePath:context.firestorePath || "billing_records / dailyRankingPublic",
      query:context.query || context.queryUsed || "—", documentsRead:context.documentsRead ?? state.readDiagnostics?.documentsRead ?? "—",
      documentsValid:context.documentsValid ?? state.readDiagnostics?.documentsValid ?? "—", rankingLength:context.rankingLength ?? state.rows.length,
      requestId:context.requestId ?? state.requestId, operationalDayId:dayId, role:role(),
      message:issue.message, ...context
    };
    let engineDiagnostic = null;
    if (typeof window.ExploraPerformanceEngine?.showDiagnostic === "function") {
      try { engineDiagnostic = window.ExploraPerformanceEngine.showDiagnostic(stage,code,issue,detail); } catch (_) {}
    }
    const payload = [
      "EXPLORA - ERROR DAILY_RANKING", `ETAPA: ${stage}`, `CÓDIGO INTERNO: ${code}`,
      `MENSAJE FIREBASE / JAVASCRIPT: ${issue.code || "—"} · ${issue.message}`, `UID: ${auth?.currentUser?.uid || "—"}`,
      `ROL: ${role() || "—"}`, `DÍA OPERATIVO: ${dayId}`, `SEMANA: ${periodId}`, `RUTA: ${detail.firestorePath}`,
      `QUERY: ${detail.query}`, `DOCUMENTOS LEÍDOS: ${detail.documentsRead}`, `DOCUMENTOS VÁLIDOS: ${detail.documentsValid}`,
      `RANKING LENGTH: ${detail.rankingLength}`, `CONTEXTO: ${JSON.stringify(context,null,2)}`, `TIMESTAMP: ${now.toISOString()}`
    ].join("\n");
    ensureDiagnosticCopyButton();
    const backdrop = $("performanceDiagnosticBackdrop"), output = $("performanceDiagnosticText"), title = $("performanceDiagnosticTitle");
    if (title) title.textContent = "EXPLORA · ERROR RANKING DIARIO";
    if (output) output.textContent = payload;
    backdrop?.classList.add("is-open"); backdrop?.setAttribute("aria-hidden","false"); window.lockPageScroll?.("performance-diagnostic");
    return engineDiagnostic || {stage,code,message:issue.message,payload};
  }

  function amountOf(record = {}) {
    return positive(record.amount ?? record.monto ?? record.valor ?? record.grossAmount ?? record.billingAmount ?? record.finalPrice ?? record.finalAmount ?? record.totalAmount ?? record.total ?? record.facturacion ?? record.importe ?? record.precioFinal);
  }
  function driverIdOf(record = {}) {
    return text(record.driverUid || record.simulationDriverUid || record.enteredOnBehalfOf || record.choferUid || record.assignedDriverUid || record.driverId || record.uid || record.userId || record.choferId || record.usuario || record.driver?.uid || record.chofer?.uid);
  }
  function operationIdOf(record = {}, fallback = "") {
    return text(record.operationId || record.billingId || record.simulationId || record.operacionId || record.serviceId || record.derivationId || record.documentId || record.id || fallback);
  }
  function statusOf(record = {}) { return normalize(record.status || record.estado || record.paymentStatus || record.estadoServicio); }
  function isValidRecord(record = {}) {
    if (!(amountOf(record) > 0)) return false;
    const states = [record.status,record.estado,record.paymentStatus,record.billingStatus,record.estadoServicio,record.verificationStatus]
      .map(normalize).filter(Boolean);
    if (states.some(status => HARD_INVALID_STATES.some(value => status.includes(value)))) return false;
    const confirmedByState = states.some(status => VALID_STATES.some(value => status.includes(value)));
    const confirmedByEvidence = record.confirmed === true || record.isConfirmed === true || record.completed === true ||
      record.billed === true || record.facturado === true || record.facturada === true || record.paymentConfirmed === true || record.billingConfirmed === true ||
      Boolean(record.completedAt || record.invoicedAt || record.confirmedAt || record.paidAt || record.billedAt);
    if (confirmedByState || confirmedByEvidence) return true;
    if (states.some(status => SOFT_INVALID_STATES.some(value => status.includes(value)))) return false;
    return states.length === 0;
  }
  function timestampMs(value) {
    const ms = value?.toMillis?.() ?? value?.toDate?.()?.getTime?.() ?? (Number.isFinite(Number(value?.seconds)) ? Number(value.seconds) * 1000 : NaN) ?? NaN;
    if (Number.isFinite(ms) && ms > 0) return ms;
    const parsed = value instanceof Date ? value.getTime() : (value ? new Date(value).getTime() : NaN);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  function recordTimestampMs(record = {}) {
    // La fecha operativa declarada tiene prioridad sobre timestamps de servidor.
    // Esto evita clasificar un servicio simulado o cargado cerca de medianoche en otro día.
    for (const value of [record.operationalDate,record.serviceDate,record.paymentDate,record.date,record.completedAt,record.invoicedAt,record.confirmedAt,record.paidAt,record.billedAt,record.fechaFacturacion,record.sourceCreatedAt,record.createdAt,record.registeredAt,record.updatedAt,record.timestamp]) {
      const ms = timestampMs(value); if (ms) return ms;
    }
    return 0;
  }
  function normalizeExplicitDay(value,{ allowTimestampPrefix = false } = {}) {
    const raw = text(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    if (allowTimestampPrefix) {
      const iso = /^(\d{4}-\d{2}-\d{2})[T\s]/.exec(raw)?.[1];
      if (iso) return iso;
    }
    const local = /^(\d{2})[\/-](\d{2})[\/-](\d{4})$/.exec(raw);
    return local ? `${local[3]}-${local[2]}-${local[1]}` : "";
  }
  function dayIdOf(record = {}) {
    // Solo las claves que representan explícitamente un día pueden copiarse sin conversión horaria.
    for (const value of [record.operationalDayId,record.operationalDateId,record.billingDayId,record.dayId,record.dateKey,record.simulationSlot]) {
      const explicit = normalizeExplicitDay(value,{ allowTimestampPrefix:true }); if (explicit) return explicit;
    }
    // Los campos de fecha simples también son válidos, pero un ISO con hora debe convertirse en Córdoba.
    for (const value of [record.serviceDate,record.paymentDate,record.fecha]) {
      const explicit = normalizeExplicitDay(value); if (explicit) return explicit;
    }
    const ms = recordTimestampMs(record);
    if (!ms) return "";
    try { return operationalDayIdFromDate(new Date(ms),TZ); } catch (_) { return ""; }
  }
  function periodIdOf(record = {}) {
    return text(record.weeklyPeriodIdCompleted || record.weeklyPeriodId || record.periodoSemanalId || record.periodId || record.periodoId);
  }
  function profileIndex() {
    const map = new Map();
    const rankingRows = window.ExploraPerformanceEngine?.getState?.()?.rows || [];
    for (const row of rankingRows) {
      const id = text(row.uid || row.driverUid || row.id);
      if (id) map.set(id,{ name:text(row.name || row.driverName || "Chofer"), avatar:text(row.avatar || row.photoURL || row.avatarUrl) });
    }
    const session = window.ExploraSession || {};
    const uid = text(auth?.currentUser?.uid || session.uid || session.authUser?.uid);
    const profile = session.profile || {};
    if (uid) map.set(uid,{ name:text(profile.nombreCompleto || profile.nombre || profile.displayName || auth?.currentUser?.displayName || "Chofer"), avatar:text(profile.avatarUrl || profile.fotoPerfil || profile.photoURL || auth?.currentUser?.photoURL) });
    return map;
  }
  function driverNameOf(record = {}, profile = {}) {
    return text(record.driverName || record.choferName || record.nombreChofer || record.choferNombre || record.nombre || record.driver?.name || record.chofer?.nombre || profile.name || "Chofer");
  }
  function driverAvatarOf(record = {}, profile = {}) {
    return text(record.driverAvatar || record.avatar || record.photoURL || record.avatarUrl || record.fotoPerfil || record.driver?.avatar || record.chofer?.avatar || profile.avatar);
  }

  function knownDriverIds() {
    const ids = new Set(profileIndex().keys());
    const session = window.ExploraSession || {};
    [auth?.currentUser?.uid,session.uid,session.driverId,session.profileDocumentId,session.authUser?.uid].map(text).filter(Boolean).forEach(id => ids.add(id));
    return [...ids];
  }
  async function readBillingForPeriods(periodIds = [], { dayId = "", driverIds = [], preferDriverQueries = false, allowDriverQueries = true } = {}) {
    if (!db) throw Object.assign(new Error("Firestore no está disponible para reconstruir el ranking diario."),{code:"DAILY_RANKING_FIRESTORE_NOT_READY"});
    const records = new Map(), errors = [], attempts = [];
    let successfulQueries = 0;
    const collect = async (label, q) => {
      try {
        const snapshot = await getDocs(q); successfulQueries += 1; attempts.push({label,ok:true,size:snapshot.size});
        snapshot.forEach(item => records.set(item.id,{ id:item.id,...(item.data() || {}) }));
        return snapshot.size;
      } catch (error) { errors.push({label,error}); attempts.push({label,ok:false,code:error?.code || "QUERY_FAILED",message:error?.message || String(error)}); return -1; }
    };
    const uniquePeriods = [...new Set(periodIds.map(text).filter(Boolean))];
    const uniqueDrivers = [...new Set(driverIds.map(text).filter(Boolean))].slice(0,30);
    if (!preferDriverQueries) {
      for (const periodId of uniquePeriods) for (const field of ["weeklyPeriodId","periodoSemanalId","periodId","periodoId","weeklyPeriodIdCompleted"]) {
        await collect(`${field} == ${periodId}`,query(collection(db,"billing_records"),where(field,"==",periodId)));
      }
    }
    const hasTargetDay = () => !dayId || [...records.values()].some(record => dayIdOf(record) === dayId);
    if (dayId && (!hasTargetDay() || !preferDriverQueries)) {
      const start = new Date(`${dayId}T00:00:00-03:00`), end = new Date(`${addOperationalDays(dayId,1)}T00:00:00-03:00`);
      for (const field of ["createdAt","completedAt","invoicedAt","confirmedAt","paidAt"]) {
        await collect(`${field} within ${dayId}`,query(collection(db,"billing_records"),where(field,">=",start),where(field,"<",end)));
      }
      await collect(`operationalDate within ${dayId}`,query(collection(db,"billing_records"),where("operationalDate",">=",start.toISOString()),where("operationalDate","<",end.toISOString())));
    }
    if (allowDriverQueries && (!hasTargetDay() || preferDriverQueries)) {
      for (const driverId of uniqueDrivers) {
        for (const field of ["driverUid","choferUid","uid","enteredOnBehalfOf","simulationDriverUid"]) {
          const size = await collect(`${field} == ${driverId}`,query(collection(db,"billing_records"),where(field,"==",driverId)));
          if (size > 0) break;
        }
      }
    }
    state.readDiagnostics = {
      documentsRead:records.size, documentsValid:[...records.values()].filter(isValidRecord).length, successfulQueries,
      failedQueries:errors.length, attempts, dayId, periodIds:uniquePeriods, driverIds:uniqueDrivers
    };
    if (!successfulQueries) {
      const first = errors[0]?.error || Object.assign(new Error("Todas las consultas de billing_records fallaron."),{code:"DAILY_RANKING_ALL_QUERIES_FAILED"});
      diagnostic("READ_DAILY_BILLING",first.code || "DAILY_RANKING_ALL_QUERIES_FAILED",first,{functionName:"readBillingForPeriods",operationalDayId:dayId,weeklyPeriodId:uniquePeriods.at(-1),firestorePath:"billing_records",query:attempts.map(item=>item.label).join(" | "),documentsRead:0,documentsValid:0,failedQueries:errors.length});
      throw first;
    }
    return [...records.values()];
  }

  function aggregateDay(records = [], dayId = "", weeklyPeriodId = "") {
    const profiles = profileIndex(), drivers = new Map(), dedup = new Set(), missingIdentity = [];
    const dayRecords = records.filter(record => dayIdOf(record) === dayId);
    const ordered = dayRecords.filter(isValidRecord)
      .sort((a,b) => recordTimestampMs(a)-recordTimestampMs(b) || operationIdOf(a,a.id).localeCompare(operationIdOf(b,b.id),"es",{numeric:true}));
    for (const record of ordered) {
      const driverId = driverIdOf(record), operationId = operationIdOf(record,record.id);
      if (!driverId || !operationId) { missingIdentity.push({id:text(record.id),driverId,operationId,amount:amountOf(record)}); continue; }
      const dedupKey = `${driverId}|${operationId}`;
      if (dedup.has(dedupKey)) continue;
      dedup.add(dedupKey);
      const profile = profiles.get(driverId) || {};
      const current = drivers.get(driverId) || {
        driverId, uid:driverId, driverName:driverNameOf(record,profile), name:driverNameOf(record,profile),
        driverAvatar:driverAvatarOf(record,profile), avatar:driverAvatarOf(record,profile), dailyAmount:0,
        grossBilling:0, serviceCount:0, reachedAtMs:0, operationIds:[]
      };
      const amount = amountOf(record);
      current.dailyAmount += amount; current.grossBilling += amount; current.serviceCount += 1;
      current.reachedAtMs = Math.max(current.reachedAtMs,recordTimestampMs(record)); current.operationIds.push(operationId);
      if (current.driverName === "Chofer") current.driverName = current.name = driverNameOf(record,profile);
      if (!current.driverAvatar) current.driverAvatar = current.avatar = driverAvatarOf(record,profile);
      drivers.set(driverId,current);
    }
    const rows = [...drivers.values()].map(row => ({...row,weeklyPeriodId,operationalDayId:dayId}));
    const isToday = (() => { try { return dayId === operationalDayIdFromDate(operationalNow(),TZ); } catch (_) { return false; } })();
    if (isToday && dayRecords.some(record => amountOf(record) > 0) && !ordered.length) {
      const sample = dayRecords.slice(0,5).map(record => ({id:operationIdOf(record,record.id),amount:amountOf(record),status:statusOf(record),paymentStatus:text(record.paymentStatus),dayId:dayIdOf(record)}));
      diagnostic("VALIDATE_DAILY_BILLING","DAILY_RANKING_RECORDS_REJECTED",new Error("Hay facturación del día, pero todos los registros fueron rechazados por su estado o evidencia de confirmación."),{functionName:"aggregateDay",operationalDayId:dayId,weeklyPeriodId,documentsRead:dayRecords.length,documentsValid:0,firestorePath:"billing_records",query:"filtro de registros válidos del día",sample});
    }
    if (isToday && missingIdentity.length) {
      diagnostic("AGGREGATE_DAILY_RANKING","DAILY_RANKING_RECORD_IDENTITY_MISSING",new Error("Uno o más cobros válidos no identifican correctamente al chofer o a la operación."),{functionName:"aggregateDay",operationalDayId:dayId,weeklyPeriodId,documentsRead:dayRecords.length,documentsValid:ordered.length,firestorePath:"billing_records",query:"driverUid + operationId",missingIdentity:missingIdentity.slice(0,5)});
    }
    if (isToday && ordered.length && !rows.length) {
      diagnostic("AGGREGATE_DAILY_RANKING","DAILY_RANKING_AGGREGATION_EMPTY",new Error("Se encontraron cobros válidos del día, pero no se pudo construir ninguna fila del ranking."),{functionName:"aggregateDay",operationalDayId:dayId,weeklyPeriodId,documentsRead:dayRecords.length,documentsValid:ordered.length,firestorePath:"billing_records",query:"agregación por driverUid"});
    }
    return rows;
  }
  function mergeRankingRows(...groups) {
    const map = new Map();
    for (const row of groups.flat().filter(Boolean)) {
      const driverId = text(row.driverId || row.uid); if (!driverId) continue;
      const normalized = {
        ...row, driverId, uid:driverId, driverName:text(row.driverName || row.name || "Chofer"), name:text(row.name || row.driverName || "Chofer"),
        driverAvatar:text(row.driverAvatar || row.avatar), avatar:text(row.avatar || row.driverAvatar), dailyAmount:positive(row.dailyAmount ?? row.grossBilling),
        grossBilling:positive(row.grossBilling ?? row.dailyAmount), serviceCount:Math.max(0,Math.trunc(Number(row.serviceCount)||0)), reachedAtMs:Math.max(0,Number(row.reachedAtMs)||0)
      };
      const previous = map.get(driverId);
      if (!previous || normalized.dailyAmount > previous.dailyAmount || (normalized.dailyAmount === previous.dailyAmount && normalized.serviceCount > previous.serviceCount) || (normalized.dailyAmount === previous.dailyAmount && normalized.serviceCount === previous.serviceCount && normalized.reachedAtMs > 0 && (!previous.reachedAtMs || normalized.reachedAtMs < previous.reachedAtMs))) map.set(driverId,normalized);
    }
    return [...map.values()];
  }
  function validateResultConsistency(result, rows, dayId, weeklyPeriodId) {
    const expected = state.expectedActivity;
    if (expected?.dayId === dayId) {
      const expectedDriver = text(expected.driverUid);
      const reflected = Boolean(result?.hasLeader && (!expectedDriver || rows.some(row => text(row.driverId || row.uid) === expectedDriver && positive(row.dailyAmount) > 0)));
      if (reflected) state.expectedActivity = null;
      else diagnostic("VERIFY_REGISTERED_SERVICE","DAILY_RANKING_ACTIVITY_NOT_REFLECTED",new Error("Se registró una facturación, pero el ranking diario continúa sin reflejarla."),{functionName:"validateResultConsistency",operationalDayId:dayId,weeklyPeriodId,driverUid:expectedDriver,documentsRead:state.readDiagnostics?.documentsRead,documentsValid:state.readDiagnostics?.documentsValid,rankingLength:rows.length,firestorePath:"billing_records / dailyRankingPublic",query:"evento de cobro -> reconstrucción diaria",expectedActivity:expected});
    }
    const validCurrentRecords = state.records.filter(record => dayIdOf(record) === dayId && isValidRecord(record));
    if (validCurrentRecords.length && !result?.hasLeader) {
      diagnostic("VERIFY_DAILY_LEADER","DAILY_RANKING_LEADER_MISSING",new Error("Existen cobros válidos del día, pero no se determinó un líder."),{functionName:"validateResultConsistency",operationalDayId:dayId,weeklyPeriodId,documentsRead:state.records.length,documentsValid:validCurrentRecords.length,rankingLength:rows.length,firestorePath:"billing_records",query:"buildDailyLeaderResult"});
    }
  }

  function initials(name) {
    return text(name).split(/\s+/).filter(Boolean).slice(0,2).map(part => part[0]?.toUpperCase() || "").join("") || "CH";
  }
  function leaderCardMarkup(result, { compact = false } = {}) {
    if (!result?.hasLeader) {
      const loading = result?.status === "loading" || state.loading;
      const copy = loading ? "Calculando ranking actual..." : "Todavía no hay actividad válida hoy.";
      const stateName = loading ? "loading" : "empty";
      return `<article class="daily-leader-card is-empty${loading?" is-loading":""}${compact?" is-compact":""}" data-daily-state="${stateName}"><span class="daily-leader-kicker">LÍDER DEL DÍA</span><p class="daily-leader-empty-copy">${copy}</p></article>`;
    }
    const avatar = result.winnerDriverAvatar ? `<img alt="Foto de ${escapeHtml(result.winnerDriverName)}" src="${escapeHtml(result.winnerDriverAvatar)}" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="daily-leader-initials" hidden>${escapeHtml(initials(result.winnerDriverName))}</span>` : `<span class="daily-leader-initials">${escapeHtml(initials(result.winnerDriverName))}</span>`;
    const displayMessage = dailyLeaderCurrentMessage(result);
    return `<article class="daily-leader-card${compact?" is-compact":""}" data-daily-state="${escapeHtml(result.status)}" data-operational-day="${escapeHtml(result.operationalDayId)}"><span class="daily-leader-kicker">LÍDER DEL DÍA</span><div class="daily-leader-avatar">${avatar}</div><strong class="daily-leader-name">${escapeHtml(result.winnerDriverName)}</strong><span class="daily-leader-reason">${escapeHtml(displayMessage)}</span><div class="daily-leader-bonus"><small>BONO DEL DÍA</small><b>${money(DAILY_RANKING_BONUS_AMOUNT)}</b></div></article>`;
  }
  function atomicRender(container, markup, signature) {
    if (!container || container.dataset.dailySignature === signature) return;
    const template = document.createElement("template"); template.innerHTML = markup.trim();
    container.replaceChildren(template.content.cloneNode(true));
    container.dataset.dailySignature = signature;
  }
  function dailyLeaderRenderSignature(result = {}, scope = "dashboard") {
    const lead = result?.winnerLeadPercentage !== null && result?.winnerLeadPercentage !== undefined && Number.isFinite(Number(result?.winnerLeadPercentage))
      ? Number(result.winnerLeadPercentage)
      : "";
    const message = dailyLeaderCurrentMessage(result);
    return [
      scope,
      result?.operationalDayId,
      result?.weeklyPeriodId,
      result?.winnerDriverId,
      positive(result?.winnerDailyAmount),
      positive(result?.runnerUpDailyAmount),
      lead,
      Math.max(0,Math.trunc(Number(result?.activeDriverCount)||0)),
      Math.max(0,Math.trunc(Number(result?.winnerServiceCount)||0)),
      Math.max(0,Number(result?.winnerReachedAtMs)||0),
      text(result?.status),
      message
    ].join("|");
  }
  function renderDashboard(result = state.result) {
    atomicRender($("performancePodium"),leaderCardMarkup(result,{compact:true}),dailyLeaderRenderSignature(result,"dashboard"));
  }
  function renderDetail(result = state.result) {
    atomicRender($("performanceRankingList"),leaderCardMarkup(result),dailyLeaderRenderSignature(result,"detail"));
  }

  function ensureDiagnosticCopyButton() {
    const button = $("performanceDiagnosticCopyBtn"), output = $("performanceDiagnosticText");
    if (!button || button.dataset.dailyRankingCopyBound === "true") return;
    button.dataset.dailyRankingCopyBound = "true";
    button.addEventListener("click", async () => {
      const payload = text(output?.textContent || state.lastError?.message || "Sin diagnóstico disponible.");
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(payload);
        else {
          const area = document.createElement("textarea"); area.value = payload; area.style.position = "fixed"; area.style.opacity = "0";
          document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
        }
        const previous = button.textContent; button.textContent = "COPIADO";
        setTimeout(() => { button.textContent = previous || "COPIAR ERROR"; },1200);
      } catch (error) {
        button.textContent = "NO SE PUDO COPIAR";
        setTimeout(() => { button.textContent = "COPIAR ERROR"; },1600);
      }
    });
  }

  function weekDayDefinitions(period = currentPeriod()) {
    const weeklyPeriodId = text(period?.id || period?.weeklyPeriodId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weeklyPeriodId)) {
      throw Object.assign(new Error("No se pudo construir la semana de placas desde el período operativo."),{code:"WEEKLY_PLAQUES_PERIOD_INVALID",weeklyPeriodId});
    }
    return WEEK_DAY_LABELS.map((label,index) => ({ label,index,weeklyPeriodId,dayId:addOperationalDays(weeklyPeriodId,index) }));
  }

  function weeklyPlaqueTodayIndex(period = currentPeriod(), todayId = operationalDayIdFromDate(operationalNow(),TZ)) {
    const definitions = weekDayDefinitions(period);
    const exact = definitions.findIndex(definition => definition.dayId === todayId);
    if (exact >= 0) return exact;
    try {
      const start = new Date(`${text(period?.id || period?.weeklyPeriodId)}T00:00:00`);
      const current = new Date(`${todayId}T00:00:00`);
      const diff = Math.round((current.getTime() - start.getTime()) / 86400000);
      return weeklyCarouselModulo(diff,7);
    } catch (_) {
      return 0;
    }
  }

  function weeklyPlaqueTemporalClass(definition = {}, todayId = operationalDayIdFromDate(operationalNow(),TZ), period = currentPeriod()) {
    const index = Number.isFinite(Number(definition.index)) ? Number(definition.index) : weekDayDefinitions(period).findIndex(row => row.dayId === definition.dayId);
    return weeklyCarouselTemporalClass(index,weeklyPlaqueTodayIndex(period,todayId),7);
  }

  function isWeeklyPlaqueFuture(definition = {}, todayId = operationalDayIdFromDate(operationalNow(),TZ), period = currentPeriod()) {
    return weeklyPlaqueTemporalClass(definition,todayId,period) === "future";
  }

  function isWeeklyPlaqueToday(definition = {}, todayId = operationalDayIdFromDate(operationalNow(),TZ), period = currentPeriod()) {
    return weeklyPlaqueTemporalClass(definition,todayId,period) === "today";
  }

  function isWeeklyPlaquePast(definition = {}, todayId = operationalDayIdFromDate(operationalNow(),TZ), period = currentPeriod()) {
    return weeklyPlaqueTemporalClass(definition,todayId,period) === "past";
  }

  function explicitDerivationBonus(data = {}) {
    return positive(data.derivationBonusAmount ?? data.derivationBonus ?? data.derivationEquivalentAmount ?? data.bonusDerivations ?? data.bonoDerivaciones ?? data.bonoDerivacion ?? data.derivationAwardAmount);
  }

  function resultStatus(data = {}) { return normalize(data.status || data.resultStatus || data.dailyStatus); }
  function isFinalizedResult(data = {}) {
    const status = resultStatus(data);
    return data.finalized === true || data.immutable === true || status === "finalized" || status === "closed" || status === "cerrado";
  }

  function plaqueFromStoredResult(data, definition, todayId, period = currentPeriod()) {
    const base = { ...definition, rankingBonusAmount:0, derivationBonusAmount:0, totalBonusAmount:0, winnerDriverId:"", winnerDriverName:"", winnerLeadPercentage:null, tieBreakApplied:false, leaderReason:"", source:"public" };
    if (isWeeklyPlaqueToday(definition,todayId,period)) return { ...base,state:"current" };
    if (isWeeklyPlaqueFuture(definition,todayId,period)) return { ...base,state:"locked" };
    if (!data) return { ...base,state:"no_data" };

    const receivedDay = text(data.operationalDayId || data.dayId || definition.dayId);
    const receivedPeriod = text(data.weeklyPeriodId || data.periodId || definition.weeklyPeriodId);
    if (receivedDay && receivedDay !== definition.dayId) {
      diagnostic("VALIDATE_WEEKLY_PLAQUE","WEEKLY_PLAQUE_DAY_MISMATCH",new Error("El resultado diario recibido no corresponde al día de la placa."),{functionName:"plaqueFromStoredResult",operationalDayId:definition.dayId,weeklyPeriodId:definition.weeklyPeriodId,receivedDay,firestorePath:`${publicCollectionName()}/${definition.dayId}`,query:"getDoc"});
      return { ...base,state:"error" };
    }
    if (receivedPeriod && receivedPeriod !== definition.weeklyPeriodId) {
      diagnostic("VALIDATE_WEEKLY_PLAQUE","WEEKLY_PLAQUE_PERIOD_MISMATCH_ACCEPTED",new Error("El período guardado no coincide, pero el documento corresponde al día de la placa y se acepta para no ocultar al ganador."),{functionName:"plaqueFromStoredResult",eventType:"RECOVERY",operationalDayId:definition.dayId,weeklyPeriodId:definition.weeklyPeriodId,receivedPeriod,firestorePath:`${publicCollectionName()}/${definition.dayId}`,query:"document id authoritative"});
    }

    const status = resultStatus(data);
    let winnerDriverId = text(data.winnerDriverId || data.winnerUid || data.uidGanador || data.ganadorUid || data.leaderId || data.leaderUid || data.driverId || data.driverUid || data.choferUid || data.uid);
    let winnerDriverName = text(data.winnerDriverName || data.winnerName || data.nombreGanador || data.ganadorNombre || data.leaderName || data.driverName || data.choferName || data.name || "Chofer");
    let recoveredFromRows = null;
    if (!winnerDriverId) {
      const storedRows = publicRows(data.rankingRows || data.rows);
      if (storedRows.length) {
        const recovered = buildDailyLeaderResult(storedRows,definition.dayId,definition.weeklyPeriodId);
        if (recovered?.hasLeader && recovered.winnerDriverId) {
          recoveredFromRows = recovered;
          winnerDriverId = text(recovered.winnerDriverId);
          winnerDriverName = text(recovered.winnerDriverName || "Chofer");
          diagnostic("RECOVER_WEEKLY_PLAQUE_WINNER","WEEKLY_PLAQUE_WINNER_RECOVERED_FROM_ROWS",new Error("El ganador histórico se reconstruyó desde las filas públicas sin esperar la reparación de Firestore."),{functionName:"plaqueFromStoredResult",eventType:"RECOVERY",operationalDayId:definition.dayId,weeklyPeriodId:definition.weeklyPeriodId,driverUid:winnerDriverId,driverName:winnerDriverName,firestorePath:`${publicCollectionName()}/${definition.dayId}`,query:"rankingRows -> buildDailyLeaderResult"});
        }
      }
    }
    const hasWinner = Boolean(winnerDriverId && (data.hasLeader !== false || recoveredFromRows));
    const finalized = isFinalizedResult(data);
    if (hasWinner && !finalized) {
      diagnostic("VALIDATE_WEEKLY_PLAQUE","WEEKLY_PLAQUE_PAST_RESULT_REPAIRING",new Error("Se encontró un líder histórico sin bloqueo definitivo. Se muestra el ganador y se solicita reparación transaccional."),{functionName:"plaqueFromStoredResult",eventType:"REPAIR",operationalDayId:definition.dayId,weeklyPeriodId:definition.weeklyPeriodId,driverUid:winnerDriverId,driverName:winnerDriverName,firestorePath:`${publicCollectionName()}/${definition.dayId}`,query:"resultado histórico pendiente de reparación"});
      const derivationBonusAmount = explicitDerivationBonus(data);
      const leadValue = data.winnerLeadPercentage ?? recoveredFromRows?.winnerLeadPercentage;
      const winnerLeadPercentage = leadValue !== null && leadValue !== undefined && Number.isFinite(Number(leadValue)) ? Number(leadValue) : null;
      return {
        ...base,state:"winner",winnerDriverId,winnerDriverName,winnerLeadPercentage,
        tieBreakApplied:Boolean(data.tieBreakApplied || recoveredFromRows?.tieBreakApplied),leaderReason:text(data.leaderReason || recoveredFromRows?.leaderReason || "recovered_pending_result"),
        rankingBonusAmount:DAILY_RANKING_BONUS_AMOUNT,derivationBonusAmount,
        totalBonusAmount:DAILY_RANKING_BONUS_AMOUNT + derivationBonusAmount,repairPending:true
      };
    }
    if (hasWinner && finalized) {
      const storedBonus = positive(data.bonusAmount ?? data.amount ?? data.monto);
      if (storedBonus && Math.abs(storedBonus - DAILY_RANKING_BONUS_AMOUNT) > 0.01) {
        diagnostic("VALIDATE_WEEKLY_PLAQUE","WEEKLY_PLAQUE_RANKING_BONUS_MISMATCH",new Error("El bono guardado del ranking diario no coincide con $20.000."),{functionName:"plaqueFromStoredResult",eventType:"INCONSISTENCY",operationalDayId:definition.dayId,weeklyPeriodId:definition.weeklyPeriodId,driverUid:winnerDriverId,storedBonus,expectedBonus:DAILY_RANKING_BONUS_AMOUNT,firestorePath:`${publicCollectionName()}/${definition.dayId}`,query:"bonusAmount"});
      }
      const derivationBonusAmount = explicitDerivationBonus(data);
      const leadValue = data.winnerLeadPercentage ?? recoveredFromRows?.winnerLeadPercentage;
      const winnerLeadPercentage = leadValue !== null && leadValue !== undefined && Number.isFinite(Number(leadValue)) ? Number(leadValue) : null;
      return {
        ...base,state:"winner",winnerDriverId,winnerDriverName,
        winnerLeadPercentage,tieBreakApplied:Boolean(data.tieBreakApplied || recoveredFromRows?.tieBreakApplied),leaderReason:text(data.leaderReason || recoveredFromRows?.leaderReason),
        rankingBonusAmount:DAILY_RANKING_BONUS_AMOUNT,derivationBonusAmount,
        totalBonusAmount:DAILY_RANKING_BONUS_AMOUNT + derivationBonusAmount
      };
    }
    if (status === "no_activity" || status === "sin_actividad" || data.hasLeader === false || !winnerDriverId) return { ...base,state:"no_activity" };

    diagnostic("VALIDATE_WEEKLY_PLAQUE","WEEKLY_PLAQUE_RESULT_INCOHERENT",new Error("El resultado histórico no permite identificar ganador ni estado sin actividad."),{functionName:"plaqueFromStoredResult",eventType:"INCONSISTENCY",operationalDayId:definition.dayId,weeklyPeriodId:definition.weeklyPeriodId,status,firestorePath:`${publicCollectionName()}/${definition.dayId}`,query:"normalización de resultado diario"});
    return { ...base,state:"error" };
  }

  function applyExistingDerivationAward(rows = [], weeklyPeriodId = "") {
    const output = rows.map(row => ({...row}));
    try {
      const engine = window.ExploraPerformanceEngine, engineState = engine?.getState?.() || {};
      const leaderId = text(engineState.currentDerivationLeader?.uid || engineState.derivationLeader?.uid);
      if (!leaderId || typeof engine?.getSettlementIncentive !== "function") return output;
      const incentive = engine.getSettlementIncentive(leaderId,weeklyPeriodId) || {};
      const amount = positive(incentive.derivationBonusAmount);
      if (!(amount > 0)) return output;
      let target = -1;
      output.forEach((row,index) => { if (row.state === "winner" && row.winnerDriverId === leaderId) target = index; });
      if (target < 0) return output;
      if (!(output[target].derivationBonusAmount > 0)) {
        output[target].derivationBonusAmount = amount;
        output[target].totalBonusAmount = positive(output[target].rankingBonusAmount) + amount;
      }
    } catch (error) {
      diagnostic("APPLY_DERIVATION_BONUS_TO_PLAQUE","WEEKLY_PLAQUE_DERIVATION_BONUS_FAILED",error,{functionName:"applyExistingDerivationAward",weeklyPeriodId,firestorePath:"performance_awards / performance_derivation_winners",query:"ExploraPerformanceEngine.getSettlementIncentive"});
    }
    return output;
  }

  function weekShell(period = currentPeriod(), todayId = operationalDayIdFromDate(operationalNow(),TZ)) {
    const cachedByDay = new Map(loadWeeklyPlaquesCache(period,todayId).map(row => [row.dayId,row]));
    return weekDayDefinitions(period).map(definition => {
      if (isWeeklyPlaqueToday(definition,todayId,period)) return { ...definition,state:"current",rankingBonusAmount:0,derivationBonusAmount:0,totalBonusAmount:0 };
      if (isWeeklyPlaqueFuture(definition,todayId,period)) return { ...definition,state:"locked",rankingBonusAmount:0,derivationBonusAmount:0,totalBonusAmount:0 };
      const cached = cachedByDay.get(definition.dayId);
      return cached ? { ...definition,...cached,weeklyPeriodId:definition.weeklyPeriodId,dayId:definition.dayId,label:definition.label,index:definition.index,source:"local-cache" }
        // Si no existe entrada en la caché para este día y el período ya pasó, asumimos que
        // no hubo actividad en vez de marcarlo como "sin datos". Esto evita que se
        // muestre un estado ambiguo y en su lugar se indica "sin actividad".
        : { ...definition,state:"locked",rankingBonusAmount:0,derivationBonusAmount:0,totalBonusAmount:0 };
    });
  }

  function plaqueReason(row = {}) {
    if (row.tieBreakApplied || text(row.leaderReason).endsWith("_tiebreak")) return "GANÓ POR DESEMPATE";
    if (row.leaderReason === "single_activity") return "ÚNICO CON ACTIVIDAD";
    if (Number.isFinite(Number(row.winnerLeadPercentage))) return `${new Intl.NumberFormat("es-AR",{minimumFractionDigits:1,maximumFractionDigits:1}).format(Number(row.winnerLeadPercentage))}% SOBRE EL 2.º`;
    return "GANADOR DEFINITIVO";
  }

  function weeklyPlaqueMarkup(row = {}, index = 0, total = 7) {
    const common = `data-weekly-award-day="${escapeHtml(row.dayId)}" aria-posinset="${index+1}" aria-setsize="${total}"`;
    if (row.state === "winner") {
      const derivation = positive(row.derivationBonusAmount), totalBonus = positive(row.totalBonusAmount || row.rankingBonusAmount + derivation);
      const breakdown = derivation > 0
        ? `<small class="weekly-plaque-breakdown">RANKING ${escapeHtml(money(row.rankingBonusAmount))} + DERIVACIONES ${escapeHtml(money(derivation))}</small>`
        : `<small class="weekly-plaque-breakdown">BONO DEL RANKING DIARIO</small>`;
      const aria = `${row.label}, ganador ${row.winnerDriverName}, total ganado ${money(totalBonus)}, ${plaqueReason(row)}`;
      return `<button type="button" class="weekly-winner-plaque is-winner" ${common} aria-label="${escapeHtml(aria)}"><span class="weekly-plaque-day">${escapeHtml(row.label)}</span><span class="weekly-plaque-badge">GANADOR</span><strong class="weekly-plaque-name">${escapeHtml(row.winnerDriverName)}</strong><span class="weekly-plaque-total-label">TOTAL GANADO</span><b class="weekly-plaque-total">${escapeHtml(money(totalBonus))}</b><small class="weekly-plaque-reason">${escapeHtml(plaqueReason(row))}</small>${breakdown}</button>`;
    }
    if (row.state === "current") return `<button type="button" class="weekly-winner-plaque is-current" ${common} aria-label="${escapeHtml(`${row.label}, día actual en juego, premio base ${money(DAILY_RANKING_BONUS_AMOUNT)}`)}"><span class="weekly-plaque-day">${escapeHtml(row.label)}</span><span class="weekly-plaque-badge">HOY</span><strong class="weekly-plaque-primary">EN JUEGO</strong><span class="weekly-plaque-total-label">PREMIO BASE</span><b class="weekly-plaque-total">${escapeHtml(money(DAILY_RANKING_BONUS_AMOUNT))}</b><small class="weekly-plaque-note">Cierra a las 23:59</small><small class="weekly-plaque-breakdown">Puede sumar bono de derivaciones</small></button>`;
    if (row.state === "locked") return `<button type="button" aria-disabled="true" class="weekly-winner-plaque is-locked" ${common} aria-label="${escapeHtml(`${row.label}, bloqueado, premio disponible ${money(DAILY_RANKING_BONUS_AMOUNT)}`)}"><span class="weekly-plaque-lock" aria-hidden="true"></span><span class="weekly-plaque-day">${escapeHtml(row.label)}</span><span class="weekly-plaque-badge">BLOQUEADO</span><strong class="weekly-plaque-primary">PRÓXIMO DÍA</strong><span class="weekly-plaque-total-label">PREMIO DISPONIBLE</span><b class="weekly-plaque-total">${escapeHtml(money(DAILY_RANKING_BONUS_AMOUNT))}</b><small class="weekly-plaque-note">Ranking diario</small></button>`;
    if (row.state === "no_activity") return `<button type="button" class="weekly-winner-plaque is-no-activity" ${common} aria-label="${escapeHtml(`${row.label}, cerrado sin actividad, sin ganador`)}"><span class="weekly-plaque-day">${escapeHtml(row.label)}</span><span class="weekly-plaque-badge">CERRADO</span><strong class="weekly-plaque-primary">SIN ACTIVIDAD</strong><span class="weekly-plaque-total-label">SIN GANADOR</span><b class="weekly-plaque-total">${escapeHtml(money(0))}</b><small class="weekly-plaque-note">No se generó bono</small></button>`;
    if (row.state === "error") return `<button type="button" class="weekly-winner-plaque is-error" ${common} aria-label="${escapeHtml(`${row.label}, error de sincronización`)}"><span class="weekly-plaque-day">${escapeHtml(row.label)}</span><span class="weekly-plaque-badge">ERROR</span><strong class="weekly-plaque-primary">REVISAR DATOS</strong><span class="weekly-plaque-total-label">DIAGNÓSTICO ABIERTO</span><b class="weekly-plaque-total">—</b><small class="weekly-plaque-note">Usá COPIAR ERROR</small></button>`;
    return `<button type="button" class="weekly-winner-plaque is-no-data" ${common} aria-label="${escapeHtml(`${row.label}, cerrado sin datos locales disponibles`)}"><span class="weekly-plaque-day">${escapeHtml(row.label)}</span><span class="weekly-plaque-badge">CERRADO</span><strong class="weekly-plaque-primary">SIN DATOS</strong><span class="weekly-plaque-total-label">SINCRONIZANDO EN SEGUNDO PLANO</span><b class="weekly-plaque-total">—</b><small class="weekly-plaque-note">La placa no queda pendiente</small></button>`;
  }

  function weeklyCarouselModulo(index = 0, total = 7) {
    const count = Math.max(1, Math.trunc(Number(total) || 7));
    return ((Math.trunc(Number(index) || 0) % count) + count) % count;
  }

  function weeklyCarouselTodayIndex(rows = state.weeklyPlaques) {
    const todayId = operationalDayIdFromDate(operationalNow(), TZ);
    const source = Array.isArray(rows) && rows.length === 7 ? rows : state.weeklyPlaques;
    const index = source.findIndex(row => row?.dayId === todayId);
    return index >= 0 ? index : 0;
  }


  function weeklyCarouselTemporalClass(dayIndex = 0, todayIndex = 0, total = 7) {
    const count = Math.max(1, Math.trunc(Number(total) || 7));
    const index = weeklyCarouselModulo(dayIndex,count);
    const current = weeklyCarouselModulo(todayIndex,count);
    const forward = weeklyCarouselModulo(index - current,count);
    const backward = weeklyCarouselModulo(current - index,count);
    if (forward === 0) return "today";
    return forward <= backward ? "future" : "past";
  }

  function ensureWeeklySelectorAudioContext() {
    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return null;
      if (!state.weeklySelectorAudioContext) state.weeklySelectorAudioContext = new AudioContextCtor();
      if (state.weeklySelectorAudioContext.state === "suspended") state.weeklySelectorAudioContext.resume?.().catch?.(() => {});
      state.weeklySelectorAudioUnlocked = true;
      return state.weeklySelectorAudioContext;
    } catch (_) {
      return null;
    }
  }

  function playWeeklySelectorCrack() {
    try {
      const now = performance.now();
      if (now - (state.weeklySelectorLastCrackAt || 0) < 90) return;
      const context = ensureWeeklySelectorAudioContext();
      if (!context || context.state === "closed") return;
      state.weeklySelectorLastCrackAt = now;
      const start = context.currentTime + 0.004;
      const master = context.createGain();
      master.gain.setValueAtTime(0.0001, start);
      master.gain.exponentialRampToValueAtTime(0.11, start + 0.006);
      master.gain.exponentialRampToValueAtTime(0.0001, start + 0.075);
      master.connect(context.destination);

      const click = context.createOscillator();
      click.type = "triangle";
      click.frequency.setValueAtTime(1180, start);
      click.frequency.exponentialRampToValueAtTime(360, start + 0.055);
      click.connect(master);
      click.start(start);
      click.stop(start + 0.08);

      const bufferSize = Math.max(1, Math.floor(context.sampleRate * 0.032));
      const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i += 1) channel[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      const noise = context.createBufferSource();
      noise.buffer = buffer;
      const noiseGain = context.createGain();
      noiseGain.gain.setValueAtTime(0.035, start);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.045);
      noise.connect(noiseGain);
      noiseGain.connect(master);
      noise.start(start);
      noise.stop(start + 0.05);
    } catch (_) {}
  }

  function weeklyCarouselSetIndex(index = 0, options = {}) {
    const rows = Array.isArray(state.weeklyPlaques) && state.weeklyPlaques.length === 7
      ? state.weeklyPlaques
      : weekShell(currentPeriod(), operationalDayIdFromDate(operationalNow(), TZ));
    state.weeklyCarouselIndex = weeklyCarouselModulo(index, rows.length);
    state.weeklyCarouselLastReason = text(options.reason || "manual");
    renderWeeklyPlaques(rows, { preserveIndex:true });
    return state.weeklyCarouselIndex;
  }

  function isWeeklySelectorManualSoundReason(reason = "") {
    return reason === "swipe" || reason === "tap-left" || reason === "tap-right";
  }

  function weeklyCarouselMove(direction = 0, reason = "swipe") {
    const rows = Array.isArray(state.weeklyPlaques) && state.weeklyPlaques.length === 7 ? state.weeklyPlaques : [];
    if (!rows.length) return 0;
    const previousIndex = weeklyCarouselModulo(state.weeklyCarouselIndex ?? weeklyCarouselTodayIndex(rows), rows.length);
    const targetIndex = weeklyCarouselModulo(previousIndex + direction, rows.length);
    if (isWeeklySelectorManualSoundReason(reason) && targetIndex !== previousIndex) {
      state.weeklyCarouselManualHold = true;
      playWeeklySelectorCrack();
    }
    const nextIndex = weeklyCarouselSetIndex(targetIndex, { reason });
    return nextIndex;
  }

  function returnWeeklyCarouselToToday() {
    if (document.documentElement.dataset.performanceNavMode !== "daily-winners") return false;
    const rows = Array.isArray(state.weeklyPlaques) && state.weeklyPlaques.length === 7
      ? state.weeklyPlaques
      : weekShell(currentPeriod(), operationalDayIdFromDate(operationalNow(), TZ));
    if (!rows.length) return false;
    state.weeklyCarouselManualHold = false;
    weeklyCarouselSetIndex(weeklyCarouselTodayIndex(rows), { reason:"vertical-scroll-today" });
    return true;
  }

  function installWeeklyCarouselReturnTriggers() {
    const html = document.documentElement;
    if (html.dataset.weeklyCarouselReturnTriggers === "true") return;
    html.dataset.weeklyCarouselReturnTriggers = "true";

    let touchStartX = 0, touchStartY = 0;
    let verticalTouchHandled = false, wheelHandled = false, wheelTimer = 0;

    document.addEventListener("touchstart", event => {
      const touch = event.touches?.[0];
      if (!touch) return;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      verticalTouchHandled = false;
    }, { passive:true, capture:true });

    document.addEventListener("touchmove", event => {
      if (verticalTouchHandled || event.target?.closest?.("#performanceGoalViewport")) return;
      const touch = event.touches?.[0];
      if (!touch) return;
      const deltaX = Math.abs(touch.clientX - touchStartX);
      const deltaY = Math.abs(touch.clientY - touchStartY);
      if (deltaY > 16 && deltaY > deltaX * 1.25) {
        verticalTouchHandled = true;
        returnWeeklyCarouselToToday();
      }
    }, { passive:true, capture:true });

    const resetTouchGesture = () => { verticalTouchHandled = false; };
    document.addEventListener("touchend", resetTouchGesture, { passive:true, capture:true });
    document.addEventListener("touchcancel", resetTouchGesture, { passive:true, capture:true });

    document.addEventListener("wheel", event => {
      if (event.target?.closest?.("#performanceGoalViewport")) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || Math.abs(event.deltaY) < 6) return;
      clearTimeout(wheelTimer);
      if (!wheelHandled) {
        wheelHandled = true;
        returnWeeklyCarouselToToday();
      }
      wheelTimer = window.setTimeout(() => { wheelHandled = false; }, 260);
    }, { passive:true, capture:true });

    window.addEventListener("explora:operational-date-changed", () => { state.weeklyCarouselManualHold = false; returnWeeklyCarouselToToday(); });
    window.addEventListener("explora:operational-period-changed", () => { state.weeklyCarouselManualHold = false; returnWeeklyCarouselToToday(); });
    window.addEventListener("resize", () => renderWeeklyPlaques(state.weeklyPlaques, { preserveIndex:true }), { passive:true });
    window.addEventListener("orientationchange", () => window.setTimeout(() => renderWeeklyPlaques(state.weeklyPlaques, { preserveIndex:true }), 80), { passive:true });
  }

  function bindWeeklyCarousel(viewport, track) {
    if (!viewport || !track || track.dataset.weeklyCarouselBound === "true") return;
    track.dataset.weeklyCarouselBound = "true";
    let pointerStartX = 0, pointerStartY = 0, pointerActive = false;
    const start = (x, y) => { ensureWeeklySelectorAudioContext(); pointerStartX = x; pointerStartY = y; pointerActive = true; };
    const moveFromPlaqueTap = (target, reasonPrefix = "tap") => {
      const plaque = target?.closest?.("[data-weekly-award-slot]");
      if (!plaque) return false;
      const slot = plaque.dataset.weeklyAwardSlot || "center";
      if (slot === "left") { weeklyCarouselMove(-1, `${reasonPrefix}-left`); return true; }
      if (slot === "right") { weeklyCarouselMove(1, `${reasonPrefix}-right`); return true; }
      return false;
    };
    const finish = (x, y) => {
      if (!pointerActive) return false;
      pointerActive = false;
      const deltaX = x - pointerStartX;
      const deltaY = y - pointerStartY;
      if (Math.abs(deltaX) < 28 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.1) return false;
      weeklyCarouselMove(deltaX < 0 ? 1 : -1, "swipe");
      return true;
    };

    viewport.addEventListener("touchstart", event => {
      const touch = event.touches?.[0];
      if (touch) start(touch.clientX, touch.clientY);
    }, { passive:true });
    viewport.addEventListener("touchend", event => {
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const wasSwipe = finish(touch.clientX, touch.clientY);
      if (wasSwipe) return;
      const deltaX = Math.abs(touch.clientX - pointerStartX);
      const deltaY = Math.abs(touch.clientY - pointerStartY);
      if (deltaX <= 12 && deltaY <= 12 && moveFromPlaqueTap(event.target, "tap")) {
        state.weeklyCarouselLastTouchTapAt = performance.now();
      }
    }, { passive:true });
    viewport.addEventListener("pointerdown", event => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      start(event.clientX, event.clientY);
    }, { passive:true });
    viewport.addEventListener("pointerup", event => finish(event.clientX, event.clientY), { passive:true });
    viewport.addEventListener("pointercancel", () => { pointerActive = false; }, { passive:true });
    viewport.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      weeklyCarouselMove(event.key === "ArrowRight" ? 1 : -1, "keyboard");
    });
    track.addEventListener("click", event => {
      if (performance.now() - (state.weeklyCarouselLastTouchTapAt || 0) < 360) return;
      if (moveFromPlaqueTap(event.target, "tap")) return;
      const plaque = event.target.closest?.("[data-weekly-award-slot]");
      if (!plaque) return;
      window.ExploraPerformanceEngine?.open?.("ranking");
    });
    installWeeklyCarouselReturnTriggers();
  }

  function renderWeeklyPlaques(rows = state.weeklyPlaques, options = {}) {
    if (document.documentElement.dataset.performanceNavMode !== "daily-winners") return rows;
    const track = $("performanceGoalTrack"), viewport = $("performanceGoalViewport");
    if (!track || !viewport) {
      diagnostic("RENDER_WEEKLY_PLAQUES","WEEKLY_PLAQUES_HOST_MISSING",new Error("No existe el contenedor visual de las placas semanales."),{functionName:"renderWeeklyPlaques",weeklyPeriodId:state.weeklyPlaquesPeriodId,operationalDayId:state.dayId,firestorePath:"DOM#performanceGoalViewport / DOM#performanceGoalTrack",query:"getElementById"});
      return rows;
    }
    const period = currentPeriod(), todayId = operationalDayIdFromDate(operationalNow(),TZ);
    const safeRows = Array.isArray(rows) && rows.length === 7 ? rows : weekShell(period,todayId);
    state.weeklyPlaques = safeRows;
    const todayIndex = weeklyCarouselTodayIndex(safeRows);
    const mustResetToToday = (!options.preserveIndex && !state.weeklyCarouselManualHold) || !Number.isFinite(Number(state.weeklyCarouselIndex));
    if (mustResetToToday) state.weeklyCarouselIndex = todayIndex;
    state.weeklyCarouselIndex = weeklyCarouselModulo(state.weeklyCarouselIndex, safeRows.length);
    const centerIndex = state.weeklyCarouselIndex;
    const leftIndex = weeklyCarouselModulo(centerIndex - 1, safeRows.length);
    const rightIndex = weeklyCarouselModulo(centerIndex + 1, safeRows.length);
    const visible = [
      { row:safeRows[leftIndex], index:leftIndex, slot:"left" },
      { row:safeRows[centerIndex], index:centerIndex, slot:"center" },
      { row:safeRows[rightIndex], index:rightIndex, slot:"right" }
    ];
    const temporalSignature = safeRows.map((row,index) => weeklyCarouselTemporalClass(index,todayIndex,safeRows.length)).join(":");
    const signature = safeRows.map(row => [row.dayId,row.state,row.winnerDriverId,row.winnerDriverName,row.totalBonusAmount,row.winnerLeadPercentage,row.tieBreakApplied].join(":" )).join("|") + `|center:${centerIndex}|temporal:${temporalSignature}`;
    track.classList.add("weekly-winner-plaque-track");
    track.dataset.weeklyAwardsHost = "true";
    track.dataset.weeklyCarouselMode = "fixed-three";
    track.dataset.weeklyCarouselSelectedDay = safeRows[centerIndex]?.dayId || "";
    viewport.classList.add("weekly-winner-plaque-viewport");
    viewport.setAttribute("aria-label","Ganadores diarios de la semana. Deslizá izquierda o derecha para recorrer los siete días.");
    viewport.setAttribute("tabindex","0");
    if (track.dataset.weeklyPlaqueSignature !== signature || track.querySelectorAll("[data-weekly-award-slot]").length !== 3) {
      const template = document.createElement("template");
      template.innerHTML = visible.map(item => {
        const row = item.row || {};
        const temporalClass = weeklyCarouselTemporalClass(item.index,todayIndex,safeRows.length);
        const isUnreachedFuture = temporalClass === "future";
        const displayRow = isUnreachedFuture
          ? { ...row,state:"locked",rankingBonusAmount:0,derivationBonusAmount:0,totalBonusAmount:0 }
          : row;
        const timeClass = isUnreachedFuture ? " is-future-day is-unreached-future" : temporalClass === "past" ? " is-past-day" : " is-today-day";
        return weeklyPlaqueMarkup(displayRow,item.index,safeRows.length)
          .replace('class="weekly-winner-plaque', `class="weekly-winner-plaque is-carousel-${item.slot}${item.slot === "center" ? " is-carousel-selected" : ""}${timeClass}`)
          .replace('<button ', `<button data-weekly-award-slot="${item.slot}" data-weekly-award-index="${item.index}" `)
          .replace('aria-posinset="'+(item.index+1)+'"', 'aria-posinset="'+(item.index+1)+'"');
      }).join("");
      track.replaceChildren(template.content.cloneNode(true));
      track.dataset.weeklyPlaqueSignature = signature;
      delete track.dataset.goalSignature; delete track.dataset.activeGoalId; delete track.dataset.goalCentered;
      delete track.dataset.weeklyPlaqueCentered;
      for (const plaque of track.querySelectorAll(".weekly-winner-plaque")) plaque.removeAttribute("aria-current");
      const center = track.querySelector('[data-weekly-award-slot="center"]');
      if (center) center.setAttribute("aria-current", "true");
    }
    bindWeeklyCarousel(viewport,track);
    return safeRows;
  }

  function plaqueFromBillingRows(rows = [], definition, storedData = {}) {
    const result = buildDailyLeaderResult(rows,definition.dayId,definition.weeklyPeriodId);
    if (!result?.hasLeader || !result.winnerDriverId) return {
      ...definition,state:"no_activity",rankingBonusAmount:0,derivationBonusAmount:0,totalBonusAmount:0,
      winnerDriverId:"",winnerDriverName:"",winnerLeadPercentage:null,tieBreakApplied:false,leaderReason:"",
      source:"billing-verified",billingVerified:true
    };
    const derivationBonusAmount = explicitDerivationBonus(storedData);
    return {
      ...definition,state:"winner",winnerDriverId:text(result.winnerDriverId),winnerDriverName:text(result.winnerDriverName || "Chofer"),
      winnerLeadPercentage:result.winnerLeadPercentage ?? null,tieBreakApplied:Boolean(result.tieBreakApplied),
      leaderReason:text(result.leaderReason || "billing_history_recovery"),rankingBonusAmount:DAILY_RANKING_BONUS_AMOUNT,
      derivationBonusAmount,totalBonusAmount:DAILY_RANKING_BONUS_AMOUNT + derivationBonusAmount,
      source:"billing-recovery",billingVerified:true,repairPending:true
    };
  }

  async function verifyHistoricalPlaqueFromBilling(definition, storedData = {}) {
    try {
      const records = await withTimeout(
        readBillingForPeriods([definition.weeklyPeriodId],{
          dayId:definition.dayId,driverIds:knownDriverIds(),preferDriverQueries:false,allowDriverQueries:false
        }),
        GLOBAL_DAILY_READ_TIMEOUT_MS,
        "WEEKLY_PLAQUE_BILLING_RECOVERY_TIMEOUT"
      );
      const rows = aggregateDay(records,definition.dayId,definition.weeklyPeriodId);
      const plaque = plaqueFromBillingRows(rows,definition,storedData);
      if (plaque.state === "winner") {
        diagnostic("RECOVER_WEEKLY_PLAQUE_FROM_BILLING","WEEKLY_PLAQUE_FALSE_NO_ACTIVITY_REPAIRED",new Error("La placa histórica estaba sin actividad, pero billing_records contiene cobros válidos. Se reconstruyó el ganador real."),{
          functionName:"verifyHistoricalPlaqueFromBilling",eventType:"RECOVERY",operationalDayId:definition.dayId,
          weeklyPeriodId:definition.weeklyPeriodId,driverUid:plaque.winnerDriverId,driverName:plaque.winnerDriverName,
          firestorePath:"billing_records",query:"reconstrucción histórica global por día"
        });
      }
      return plaque;
    } catch (error) {
      diagnostic("VERIFY_WEEKLY_PLAQUE_BILLING",error?.code || "WEEKLY_PLAQUE_BILLING_RECOVERY_FAILED",error,{
        functionName:"verifyHistoricalPlaqueFromBilling",eventType:"BACKGROUND_REPAIR_READ",operationalDayId:definition.dayId,
        weeklyPeriodId:definition.weeklyPeriodId,firestorePath:"billing_records",query:"reconstrucción histórica global por día"
      });
      return null;
    }
  }

  async function readWeeklyPlaqueData(period, todayId) {
    const definitions = weekDayDefinitions(period), failures = [];
    const existingByDay = new Map((state.weeklyPlaques || []).map(row => [row.dayId,row]));
    const storedResults = await Promise.all(definitions.map(async definition => {
      if (!isWeeklyPlaquePast(definition,todayId,period)) return {definition,data:null};
      try {
        let data = await readDocByIdOrDayQuery(publicCollectionName(),definition.dayId);
        const publicHasWinner = Boolean(text(data?.winnerDriverId || data?.winnerUid || data?.uidGanador || data?.ganadorUid || data?.leaderId || data?.leaderUid || data?.driverId || data?.driverUid || data?.choferUid || data?.uid));
        const publicHasRows = publicRows(data?.rankingRows || data?.rows).length > 0;
        if (!data || (!publicHasWinner && !publicHasRows) || (publicHasWinner && !isFinalizedResult(data))) {
          try {
            const bonusData = await readDocByIdOrDayQuery(bonusCollectionName(),definition.dayId);
            if (bonusData) {
              if (!data) diagnostic("READ_WEEKLY_PLAQUES","WEEKLY_PLAQUE_PUBLIC_RESULT_MISSING",new Error("Existe el bono diario definitivo, pero falta su resumen público sincronizado."),{functionName:"readWeeklyPlaqueData",eventType:"INCONSISTENCY",operationalDayId:definition.dayId,weeklyPeriodId:definition.weeklyPeriodId,firestorePath:`${publicCollectionName()}/${definition.dayId}`,query:`fallback ${bonusCollectionName()}/${definition.dayId}`});
              data = {...(data || {}),...bonusData,source:"bonus-fallback"};
            }
          } catch (fallbackError) {
            diagnostic("READ_WEEKLY_PLAQUE_BONUS_FALLBACK",fallbackError?.code || "BONUS_FALLBACK_FAILED",fallbackError,{functionName:"readWeeklyPlaqueData",eventType:"BACKGROUND_REPAIR_READ",operationalDayId:definition.dayId,weeklyPeriodId:definition.weeklyPeriodId,firestorePath:`${bonusCollectionName()}/${definition.dayId}`,query:"lectura secundaria no bloqueante"});
          }
        }
        return {definition,data};
      } catch (error) {
        failures.push({dayId:definition.dayId,path:`${publicCollectionName()}/${definition.dayId}`,code:error?.code || "PUBLIC_DAY_READ_FAILED",message:error?.message || String(error)});
        return {definition,error};
      }
    }));
    if (failures.length) diagnostic("READ_WEEKLY_PLAQUES","WEEKLY_PLAQUES_READ_FAILED",new Error("No se pudieron sincronizar uno o más resultados diarios de la semana."),{functionName:"readWeeklyPlaqueData",operationalDayId:todayId,weeklyPeriodId:period.id,firestorePath:publicCollectionName(),query:"getDoc por cada día anterior",failures});

    return Promise.all(storedResults.map(async ({definition,data,error}) => {
      if (!isWeeklyPlaquePast(definition,todayId,period)) return plaqueFromStoredResult(data,definition,todayId,period);
      const previous = existingByDay.get(definition.dayId);
      if (previous?.state === "winner" || (previous?.state === "no_activity" && previous?.billingVerified)) return previous;
      const storedPlaque = error
        ? {...definition,state:"no_data",rankingBonusAmount:0,derivationBonusAmount:0,totalBonusAmount:0,backgroundRetry:true}
        : plaqueFromStoredResult(data,definition,todayId,period);
      if (storedPlaque.state === "winner") return storedPlaque;
      const verified = await verifyHistoricalPlaqueFromBilling(definition,data || {});
      if (verified) return verified;
      return storedPlaque.state === "no_activity"
        ? {...storedPlaque,state:"no_data",backgroundRetry:true,source:"unverified-no-activity"}
        : storedPlaque;
    }));
  }

  async function refreshWeeklyPlaques({ force = false, background = false } = {}) {
    const period = currentPeriod(), todayId = operationalDayIdFromDate(operationalNow(),TZ);
    const contextKey = weeklyPlaquesContext(period,todayId);
    if (state.weeklyPlaquesContextKey && state.weeklyPlaquesContextKey !== contextKey) invalidateWeeklyPlaques("context-key-changed");
    state.weeklyPlaquesContextKey = contextKey;
    if (state.weeklyPlaquesPromise && !force) return state.weeklyPlaquesPromise;

    const generation = ++state.weeklyPlaquesGeneration;
    const requestId = ++state.weeklyPlaquesRequestId;
    const previousPlaquePeriodId = state.weeklyPlaquesPeriodId;
    state.weeklyPlaquesLoading = true; state.weeklyPlaquesPeriodId = period.id;
    if (!Array.isArray(state.weeklyPlaques) || previousPlaquePeriodId !== period.id || !state.weeklyPlaques.length) state.weeklyPlaques = weekShell(period,todayId);
    renderWeeklyPlaques(state.weeklyPlaques);
    if (!auth?.currentUser?.uid || !db) { state.weeklyPlaquesLoading = false; scheduleWeeklyPlaquesRetry(); return state.weeklyPlaques; }

    const activePromise = (async () => {
      const hasClosedDays = weekDayDefinitions(period).some(item => item.dayId < todayId);
      if (isAdmin() && hasClosedDays && Date.now() - Number(state.lastPlaqueFinalizeAt || 0) > 15000) {
        state.lastPlaqueFinalizeAt = Date.now();
        Promise.resolve().then(() => finalizeExpiredDays()).catch(error => diagnostic("FINALIZE_WEEKLY_PLAQUES","WEEKLY_PLAQUES_FINALIZE_FAILED",error,{functionName:"refreshWeeklyPlaques",operationalDayId:todayId,weeklyPeriodId:period.id,firestorePath:bonusCollectionName(),query:"reparación secundaria no bloqueante"}));
      }
      const rows = applyExistingDerivationAward(await readWeeklyPlaqueData(period,todayId),period.id);
      const currentContext = weeklyPlaquesContext(currentPeriod(),operationalDayIdFromDate(operationalNow(),TZ));
      if (generation !== state.weeklyPlaquesGeneration || requestId !== state.weeklyPlaquesRequestId || currentContext !== contextKey) return state.weeklyPlaques;
      const previousByDay = new Map((state.weeklyPlaques || []).map(row => [row.dayId,row]));
      const merged = rows.map(row => {
        const previous = previousByDay.get(row.dayId);
        if (previous?.state === "winner" && row.state !== "winner") return previous;
        if (row.state !== "no_data") return row;
        return previous && ["winner","no_activity"].includes(previous.state) ? previous : row;
      });
      state.weeklyPlaques = merged; state.weeklyPlaquesPeriodId = period.id;
      saveWeeklyPlaquesCache(period,merged); renderWeeklyPlaques(merged);
      if (merged.some(row => row.state === "no_data" && isWeeklyPlaquePast(row,todayId,period))) scheduleWeeklyPlaquesRetry();
      return merged;
    })().catch(error => {
      diagnostic("REFRESH_WEEKLY_PLAQUES",error?.code || "WEEKLY_PLAQUES_REFRESH_FAILED",error,{functionName:"refreshWeeklyPlaques",operationalDayId:todayId,weeklyPeriodId:period.id,requestId,firestorePath:publicCollectionName(),query:"lectura histórica no bloqueante"});
      if (generation === state.weeklyPlaquesGeneration) {
        const fallback = state.weeklyPlaques?.length ? state.weeklyPlaques : weekShell(period,todayId);
        state.weeklyPlaques = fallback; renderWeeklyPlaques(fallback); scheduleWeeklyPlaquesRetry();
      }
      return state.weeklyPlaques;
    }).finally(() => {
      if (state.weeklyPlaquesPromise === activePromise) state.weeklyPlaquesPromise = null;
      if (generation === state.weeklyPlaquesGeneration) state.weeklyPlaquesLoading = false;
    });
    state.weeklyPlaquesPromise = activePromise;
    return activePromise;
  }

  function renderAll() { renderDashboard(); renderDetail(); renderWeeklyPlaques(); }

  function resultFromStoredBonus(data = {}) {
    const row = normalizeDailyBonusRow(data);
    if (row.status !== "finalized" || !(row.bonusAmount > 0) || !row.winnerDriverId) return null;
    const message = dailyLeaderCurrentMessage({hasLeader:true,winnerDailyAmount:row.winnerDailyAmount,runnerUpDailyAmount:row.runnerUpDailyAmount,winnerLeadPercentage:row.winnerLeadPercentage});
    return Object.freeze({
      operationalDayId:row.operationalDayId, weeklyPeriodId:row.weeklyPeriodId, hasLeader:true,
      status:row.tieBreakApplied ? "tiebreak" : row.leaderReason === "single_activity" ? "single" : "lead",
      message, winner:null, runnerUp:null, winnerDriverId:row.winnerDriverId,
      winnerDriverName:row.winnerDriverName, winnerDriverAvatar:row.winnerDriverAvatar,
      winnerDailyAmount:row.winnerDailyAmount, runnerUpDailyAmount:row.runnerUpDailyAmount,
      winnerServiceCount:row.winnerServiceCount, winnerReachedAtMs:row.winnerReachedAtMs,
      winnerLeadPercentage:row.winnerLeadPercentage, leaderReason:row.leaderReason,
      tieBreakApplied:row.tieBreakApplied, tieBreakRule:row.tieBreakRule,
      activeDriverCount:1, bonusAmount:row.bonusAmount, finalized:true
    });
  }
  function publicRows(rows = []) {
    return (Array.isArray(rows) ? rows : []).map(row => ({
      driverId:text(row.driverId || row.driverUid || row.choferUid || row.uid || row.userId || row.id),
      driverName:text(row.driverName || row.choferName || row.nombreChofer || row.displayName || row.name || "Chofer"),
      driverAvatar:text(row.driverAvatar || row.avatar || row.photoURL || row.foto),
      dailyAmount:positive(row.dailyAmount ?? row.amount ?? row.total ?? row.grossBilling ?? row.facturacion ?? row.monto),
      serviceCount:Math.max(0,Math.trunc(Number(row.serviceCount ?? row.services ?? row.count ?? row.cantidadServicios ?? 0)||0)),
      reachedAtMs:Math.max(0,Number(row.reachedAtMs ?? row.updatedAtMs ?? row.lastActivityAtMs ?? row.timestampMs ?? 0)||0)
    })).map(row => ({...row,serviceCount:row.serviceCount > 0 ? row.serviceCount : (row.dailyAmount > 0 ? 1 : 0)}))
      .filter(row => row.driverId && row.dailyAmount > 0);
  }

  async function readDocByIdOrDayQuery(collectionName, dayId) {
    const direct = await withTimeout(getDoc(doc(db,collectionName,dayId)),FIRESTORE_READ_TIMEOUT_MS,`${collectionName.toUpperCase()}_DIRECT_TIMEOUT`);
    if (direct.exists()) return {id:direct.id,...(direct.data() || {})};
    for (const field of ["operationalDayId","dayId","fechaOperativa"]) {
      try {
        const snapshot = await withTimeout(getDocs(query(collection(db,collectionName),where(field,"==",dayId))),FIRESTORE_READ_TIMEOUT_MS,`${collectionName.toUpperCase()}_QUERY_TIMEOUT`);
        if (!snapshot.empty) {
          const item = snapshot.docs[0];
          return {id:item.id,...(item.data() || {})};
        }
      } catch (_) {}
    }
    return null;
  }
  function buildPublicDailyCandidate(data = {}, expectedDayId = "", expectedPeriodId = "") {
    const dayId = text(data.operationalDayId || data.dayId);
    const periodId = text(data.weeklyPeriodId || data.periodId);
    if (!dayId || dayId !== expectedDayId || (periodId && expectedPeriodId && periodId !== expectedPeriodId)) {
      if (dayId) diagnostic("VALIDATE_PUBLIC_DAY","DAILY_RANKING_PUBLIC_PERIOD_MISMATCH",new Error("El resumen público recibido pertenece a otro día o período y fue descartado."),{functionName:"buildPublicDailyCandidate",eventType:"WARNING",operationalDayId:expectedDayId,weeklyPeriodId:expectedPeriodId,receivedDayId:dayId,receivedPeriodId:periodId,firestorePath:`${publicCollectionName()}/${dayId}`,query:"getDoc / onSnapshot"});
      return null;
    }
    const resolvedPeriodId = expectedPeriodId || periodId;
    const today = operationalDayIdFromDate(operationalNow(),TZ);
    const stored = dayId < today ? resultFromStoredBonus(data) : null;
    const rows = publicRows(data.rankingRows || data.rows);
    const computed = buildDailyLeaderResult(rows,dayId,resolvedPeriodId);
    const winnerFromDocument = text(data.winnerDriverId || data.winnerUid || data.uidGanador || data.ganadorUid || data.leaderId || data.leaderUid || data.driverId || data.driverUid || data.choferUid || data.uid);
    const documentResult = winnerFromDocument ? resultFromStoredPublic(data,dayId,resolvedPeriodId) : null;
    const liveDocumentResult = documentResult?.hasLeader ? Object.freeze({
      ...documentResult,
      status:data.tieBreakApplied ? "tiebreak" : text(data.leaderReason) === "single_activity" ? "single" : "lead",
      message:dailyLeaderCurrentMessage(documentResult),
      activeDriverCount:Math.max(1,rows.length,Math.trunc(Number(data.activeDriverCount)||0)),
      bonusAmount:DAILY_RANKING_BONUS_AMOUNT, finalized:Boolean(data.finalized), source:"daily-public-document",
      generatedAtMs:Math.max(timestampMs(data.updatedAt),timestampMs(data.generatedAt),timestampMs(data.calculatedAt),Number(data.updatedAtMs || data.generatedAtMs || data.winnerReachedAtMs || 0)||0)
    }) : null;
    const result = stored || (computed.hasLeader ? computed : liveDocumentResult) || computed;
    return {dayId,weeklyPeriodId:resolvedPeriodId,rows,records:[],result:sourcedDailyResult(result,"daily-public"),source:"daily-public"};
  }
  function applyPublicData(data = {}, expectedDayId = "", expectedPeriodId = "") {
    const candidate = buildPublicDailyCandidate(data,expectedDayId,expectedPeriodId);
    if (!candidate) return false;
    const currentOperationalResult = state.dayId === candidate.dayId && state.result?.source === "global-operational";
    if (currentOperationalResult || state.loading) {
      state.pendingPublicDaily = candidate;
      return false;
    }
    const committed = commitDailyLeaderState(candidate,{source:"daily-public",render:true,dispatch:false,generation:state.requestId});
    if (committed) {
      saveDailyGlobalCache(candidate.dayId,candidate.weeklyPeriodId,candidate.rows,state.result);
      validateResultConsistency(state.result,candidate.rows,candidate.dayId,state.weeklyPeriodId);
    }
    return committed;
  }
  async function readPublicDay(dayId, weeklyPeriodId, { commit = true } = {}) {
    if (!db || !dayId) return commit ? false : null;
    try {
      const snapshot = await getDoc(doc(db,publicCollectionName(),dayId));
      if (!snapshot.exists()) return commit ? false : null;
      const candidate = buildPublicDailyCandidate(snapshot.data() || {},dayId,weeklyPeriodId);
      if (!commit) return candidate;
      return candidate ? applyPublicData(snapshot.data() || {},dayId,weeklyPeriodId) : false;
    } catch (error) {
      diagnostic("READ_PUBLIC_DAILY_RANKING",error?.code || "DAILY_RANKING_PUBLIC_READ_FAILED",error,{functionName:"readPublicDay",operationalDayId:dayId,weeklyPeriodId,firestorePath:`${publicCollectionName()}/${dayId}`,query:"getDoc"});
      return commit ? false : null;
    }
  }
  async function readLockedBonus(dayId) {
    if (!db || !dayId) return null;
    try {
      const snapshot = await getDoc(doc(db,bonusCollectionName(),dayId));
      return snapshot.exists() ? resultFromStoredBonus({id:snapshot.id,...(snapshot.data() || {})}) : null;
    } catch (error) {
      diagnostic("READ_LOCKED_DAILY_BONUS",error?.code || "DAILY_RANKING_LOCKED_READ_FAILED",error,{functionName:"readLockedBonus",operationalDayId:dayId,firestorePath:`${bonusCollectionName()}/${dayId}`,query:"getDoc"});
      return null;
    }
  }
  function stopPublicSubscription() {
    try { state.publicUnsubscribe?.(); } catch (_) {}
    state.publicUnsubscribe = null; state.publicDayId = "";
  }
  function subscribePublicDay(dayId, weeklyPeriodId) {
    if (!db || !dayId || isAdmin()) { stopPublicSubscription(); return; }
    if (state.publicUnsubscribe && state.publicDayId === dayId) return;
    stopPublicSubscription(); state.publicDayId = dayId;
    state.publicUnsubscribe = onSnapshot(doc(db,publicCollectionName(),dayId), snapshot => {
      const currentDay = operationalDayIdFromDate(operationalNow(),TZ);
      if (dayId !== currentDay || state.publicDayId !== dayId || !snapshot.exists()) return;
      if (snapshot.metadata?.fromCache && state.result?.hasLeader && state.result?.operationalDayId === dayId) return;
      if (applyPublicData(snapshot.data() || {},dayId,weeklyPeriodId)) {
        window.dispatchEvent(new CustomEvent("explora:daily-ranking-updated",{detail:getState()}));
      }
    }, error => {
      diagnostic("LISTEN_PUBLIC_DAILY_RANKING",error?.code || "DAILY_RANKING_PUBLIC_LISTENER_FAILED",error,{functionName:"subscribePublicDay",operationalDayId:dayId,weeklyPeriodId,firestorePath:`${publicCollectionName()}/${dayId}`,query:"onSnapshot"});
    });
  }
  async function publishPublicDay(dayId, weeklyPeriodId, rows, result) {
    if (!db || !isAdmin() || !dayId || dayId !== operationalDayIdFromDate(operationalNow(),TZ)) return;
    const rankingRows = publicRows(rows);
    await setDoc(doc(db,publicCollectionName(),dayId),{
      operationalDayId:dayId, weeklyPeriodId:text(weeklyPeriodId), rankingRows,
      hasLeader:Boolean(result?.hasLeader), winnerDriverId:text(result?.winnerDriverId),
      winnerDriverName:text(result?.winnerDriverName), winnerDriverAvatar:text(result?.winnerDriverAvatar),
      winnerDailyAmount:positive(result?.winnerDailyAmount), runnerUpDailyAmount:positive(result?.runnerUpDailyAmount),
      winnerServiceCount:Math.max(0,Math.trunc(Number(result?.winnerServiceCount)||0)),
      winnerReachedAtMs:Math.max(0,Number(result?.winnerReachedAtMs)||0),
      winnerLeadPercentage:result?.winnerLeadPercentage ?? null, leaderReason:text(result?.leaderReason),
      tieBreakApplied:Boolean(result?.tieBreakApplied), tieBreakRule:text(result?.tieBreakRule),
      bonusAmount:result?.hasLeader ? DAILY_RANKING_BONUS_AMOUNT : 0,
      status:result?.hasLeader ? "live" : "no_activity", calculationVersion:DAILY_RANKING_VERSION,
      updatedAt:serverTimestamp()
    },{merge:false});
  }

  async function readGlobalOperationalDay(dayId, weeklyPeriodId) {
    const records = await withTimeout(
      readBillingForPeriods([weeklyPeriodId],{dayId,driverIds:knownDriverIds(),preferDriverQueries:false,allowDriverQueries:false}),
      GLOBAL_DAILY_READ_TIMEOUT_MS,
      "DAILY_RANKING_GLOBAL_READ_TIMEOUT"
    );
    const rows = aggregateDay(records,dayId,weeklyPeriodId);
    return {records,rows,result:sourcedDailyResult(buildDailyLeaderResult(rows,dayId,weeklyPeriodId),"global-operational")};
  }

  async function loadWeeklyBonuses(weeklyPeriodId, { finalize = false } = {}) {
    if (!db || !weeklyPeriodId) return [];
    if (finalize) await finalizeExpiredDays().catch(error => diagnostic("FINALIZE_WEEKLY_BONUS_LIST","DAILY_RANKING_FINALIZE_SCAN_FAILED",error,{functionName:"loadWeeklyBonuses",weeklyPeriodId,firestorePath:bonusCollectionName(),query:"finalizeExpiredDays"}));
    const rows = [];
    try {
      const uid = text(auth?.currentUser?.uid);
      const sourceQuery = isAdmin()
        ? query(collection(db,bonusCollectionName()),where("weeklyPeriodId","==",text(weeklyPeriodId)))
        : query(collection(db,bonusCollectionName()),where("winnerDriverId","==",uid));
      const snapshot = await getDocs(sourceQuery);
      snapshot.forEach(item => {
        const row = normalizeDailyBonusRow({id:item.id,...(item.data() || {})});
        if (row.weeklyPeriodId === text(weeklyPeriodId) && row.status === "finalized" && row.bonusAmount > 0 && row.winnerDriverId && (isAdmin() || row.winnerDriverId === uid)) rows.push(row);
      });
    } catch (error) {
      diagnostic("READ_WEEKLY_DAILY_BONUSES",error?.code || "DAILY_RANKING_BONUS_LIST_FAILED",error,{functionName:"loadWeeklyBonuses",weeklyPeriodId,firestorePath:bonusCollectionName(),query:isAdmin()?"where weeklyPeriodId":"where winnerDriverId"});
      return [];
    }
    rows.sort((a,b) => a.operationalDayId.localeCompare(b.operationalDayId));
    return rows;
  }

  function resultFromStoredPublic(data = {}, dayId = "", weeklyPeriodId = "") {
    const winnerDriverId = text(data.winnerDriverId || data.winnerUid || data.uidGanador || data.ganadorUid || data.leaderId || data.leaderUid || data.driverId || data.driverUid || data.choferUid || data.uid);
    const hasLeader = Boolean(winnerDriverId && data.hasLeader !== false);
    if (!hasLeader) return buildDailyLeaderResult([],dayId,weeklyPeriodId);
    return {
      operationalDayId:dayId, weeklyPeriodId, hasLeader:true,
      winnerDriverId, winnerDriverName:text(data.winnerDriverName || data.winnerName || data.nombreGanador || data.ganadorNombre || data.leaderName || data.driverName || data.choferName || data.name || "Chofer"),
      winnerDriverAvatar:text(data.winnerDriverAvatar || data.driverAvatar || data.avatar),
      winnerDailyAmount:positive(data.winnerDailyAmount || data.dailyAmount || data.amount),
      runnerUpDailyAmount:positive(data.runnerUpDailyAmount),
      winnerServiceCount:Math.max(1,Math.trunc(Number(data.winnerServiceCount || data.serviceCount) || 1)),
      winnerReachedAtMs:Math.max(0,Number(data.winnerReachedAtMs) || 0),
      winnerLeadPercentage:data.winnerLeadPercentage ?? null,
      leaderReason:text(data.leaderReason || "recovered_pending_result"),
      tieBreakApplied:Boolean(data.tieBreakApplied), tieBreakRule:text(data.tieBreakRule),
      status:"finalized", message:dailyLeaderCurrentMessage({hasLeader:true,winnerDailyAmount:positive(data.winnerDailyAmount || data.dailyAmount || data.amount),runnerUpDailyAmount:positive(data.runnerUpDailyAmount),winnerLeadPercentage:data.winnerLeadPercentage ?? null})
    };
  }

  async function finalizeDay(dayId, weeklyPeriodId, records) {
    if (!db || !isAdmin() || !dayId || dayId >= operationalDayIdFromDate(operationalNow(),TZ)) return null;
    const rows = aggregateDay(records,dayId,weeklyPeriodId);
    const bonusReference = doc(db,bonusCollectionName(),dayId);
    const publicReference = doc(db,publicCollectionName(),dayId);
    const saved = await runTransaction(db, async transaction => {
      const [existingBonus,existingPublic] = await Promise.all([transaction.get(bonusReference),transaction.get(publicReference)]);
      const bonusData = existingBonus.exists() ? (existingBonus.data() || {}) : null;
      const publicData = existingPublic.exists() ? (existingPublic.data() || {}) : null;
      const storedFinalResult = bonusData && isFinalizedResult(bonusData)
        ? resultFromStoredPublic(bonusData,dayId,weeklyPeriodId)
        : null;
      const billingResult = rows.length ? buildDailyLeaderResult(rows,dayId,weeklyPeriodId) : null;
      const authoritativeResult = storedFinalResult?.hasLeader
        ? storedFinalResult
        : billingResult?.hasLeader
          ? billingResult
          : publicData && text(publicData.winnerDriverId || publicData.winnerUid || publicData.uidGanador || publicData.ganadorUid || publicData.leaderId || publicData.leaderUid || publicData.driverId || publicData.driverUid || publicData.choferUid || publicData.uid)
            ? resultFromStoredPublic(publicData,dayId,weeklyPeriodId)
            : buildDailyLeaderResult([],dayId,weeklyPeriodId);
      const payload = dailyRankingBonusDocument(authoritativeResult);
      const falseNoActivityRepair = Boolean(existingBonus.exists() && isFinalizedResult(bonusData || {}) && !storedFinalResult?.hasLeader && billingResult?.hasLeader);
      const timestamps = { finalizedAt:serverTimestamp(), updatedAt:serverTimestamp() };
      if (!existingBonus.exists()) {
        transaction.set(bonusReference,{
          ...payload, finalized:true, immutable:true, sourceOperationIds:[...new Set(rows.flatMap(row => row.operationIds || []))],
          sourceOperationCount:rows.reduce((sum,row) => sum + Number(row.serviceCount || 0),0),
          createdAt:serverTimestamp(), ...timestamps
        },{merge:false});
      } else if (!isFinalizedResult(bonusData || {}) || falseNoActivityRepair) {
        transaction.set(bonusReference,{
          ...payload,finalized:true,immutable:true,
          falseNoActivityRepair,repairVersion:WEEKLY_PLAQUES_VERSION,
          sourceOperationIds:[...new Set(rows.flatMap(row => row.operationIds || []))],
          sourceOperationCount:rows.reduce((sum,row) => sum + Number(row.serviceCount || 0),0),
          ...timestamps
        },{merge:true});
      }
      transaction.set(publicReference,{
        ...payload, rankingRows:rows.length ? publicRows(rows) : (Array.isArray(publicData?.rankingRows) ? publicData.rankingRows : []),
        finalized:true, immutable:true, repairVersion:WEEKLY_PLAQUES_VERSION,
        createdAt:publicData?.createdAt || serverTimestamp(), ...timestamps
      },{merge:true});
      return { id:dayId, reused:existingBonus.exists() && isFinalizedResult(bonusData || {}), repaired:Boolean(publicData && !isFinalizedResult(publicData)), data:payload };
    });
    state.finalizedDays.add(dayId);
    return saved;
  }

  function expiredOperationalDays(period, todayId) {
    const start = text(period?.id || period?.weeklyPeriodId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return [];
    const days = [];
    for (let index = 0; index < 7; index += 1) {
      const dayId = addOperationalDays(start,index);
      if (dayId < todayId) days.push({dayId,periodId:start});
    }
    return days;
  }

  async function finalizeExpiredDays() {
    if (!db || !auth?.currentUser?.uid || !isAdmin()) return [];
    const now = operationalNow();
    const today = operationalDayIdFromDate(now,TZ);
    const active = currentPeriod(now);
    const previous = previousPeriod(active);
    const periods = [previous,active].filter(period => period?.id);
    const periodIds = periods.map(period => period.id);
    const records = await readBillingForPeriods(periodIds);
    const candidates = new Map();
    periods.flatMap(period => expiredOperationalDays(period,today)).forEach(item => candidates.set(item.dayId,item.periodId));
    for (const record of records) {
      if (!isValidRecord(record)) continue;
      const dayId = dayIdOf(record);
      if (!dayId || dayId >= today) continue;
      const periodId = periodIdOf(record) || weeklyPeriodFromDate(new Date(`${dayId}T12:00:00-03:00`),TZ).id;
      if (periodIds.includes(periodId)) candidates.set(dayId,periodId);
    }
    const results = [];
    for (const [dayId,periodId] of [...candidates.entries()].sort((a,b) => a[0].localeCompare(b[0]))) {
      try { results.push(await finalizeDay(dayId,periodId,records)); } catch (error) {
        diagnostic("FINALIZE_DAILY_RANKING",error?.code || "DAILY_RANKING_FINALIZE_FAILED",error,{functionName:"finalizeExpiredDays",operationalDayId:dayId,weeklyPeriodId:periodId,firestorePath:`${bonusCollectionName()}/${dayId} + ${publicCollectionName()}/${dayId}`,query:"transactional repair of all expired operational days"});
      }
    }
    if (results.some(Boolean)) {
      state.weeklyPlaquesPeriodId = "";
      window.dispatchEvent(new CustomEvent("explora:daily-ranking-history-repaired",{detail:{today,results:results.filter(Boolean)}}));
    }
    return results.filter(Boolean);
  }

  async function refresh({ force = false } = {}) {
    if (state.refreshPromise && !force) return state.refreshPromise;
    const requestId = ++state.requestId;
    state.loading = true;
    state.refreshPromise = (async () => {
      const now = operationalNow(), dayId = operationalDayIdFromDate(now,TZ), period = currentPeriod(now);
      setDailyLoading(dayId,period.id);
      if (!auth?.currentUser?.uid) {
        state.dayId = dayId; state.weeklyPeriodId = period.id; state.rows = []; state.records = [];
        state.result = buildDailyLeaderResult([],dayId,period.id); renderAll(); return state.result;
      }
      if (!db) throw Object.assign(new Error("Firestore no fue inicializado para el ranking diario."),{code:"DAILY_RANKING_FIRESTORE_NOT_READY"});
      const locked = dayId < operationalDayIdFromDate(operationalNow(),TZ) ? await readLockedBonus(dayId) : null;
      if (requestId !== state.requestId || dayId !== operationalDayIdFromDate(operationalNow(),TZ)) return state.result;
      if (locked) {
        stopPublicSubscription(); state.dayId = dayId; state.weeklyPeriodId = period.id; state.rows = []; state.records = []; state.result = locked; state.lastError = null;
        renderAll(); window.dispatchEvent(new CustomEvent("explora:daily-ranking-updated",{detail:getState()})); return state.result;
      }
      if (!isAdmin()) {
        const cachedGlobal = loadDailyGlobalCache(dayId,period.id);
        const [publicAttempt,operationalAttempt] = await Promise.allSettled([
          withTimeout(readPublicDay(dayId,period.id,{commit:false}),FIRESTORE_READ_TIMEOUT_MS,"DAILY_RANKING_PUBLIC_READ_TIMEOUT"),
          readGlobalOperationalDay(dayId,period.id)
        ]);
        if (requestId !== state.requestId || dayId !== operationalDayIdFromDate(operationalNow(),TZ)) return state.result;
        const publicCandidate = publicAttempt.status === "fulfilled" ? publicAttempt.value : null;
        const globalSnapshot = operationalAttempt.status === "fulfilled" ? operationalAttempt.value : null;
        const candidate = globalSnapshot?.result?.hasLeader
          ? {dayId,weeklyPeriodId:period.id,records:globalSnapshot.records,rows:globalSnapshot.rows,result:globalSnapshot.result,source:"global-operational"}
          : publicCandidate?.result?.hasLeader
            ? {...publicCandidate,records:globalSnapshot?.records || [],source:"daily-public"}
            : globalSnapshot
              ? {dayId,weeklyPeriodId:period.id,records:globalSnapshot.records,rows:globalSnapshot.rows,result:globalSnapshot.result,source:"global-operational"}
              : cachedGlobal?.result
                ? {dayId,weeklyPeriodId:period.id,records:[],rows:cachedGlobal.rows || [],result:sourcedDailyResult(cachedGlobal.result,"daily-global-cache"),source:"daily-global-cache"}
                : {dayId,weeklyPeriodId:period.id,records:[],rows:[],result:neutralDailyResult(dayId,period.id,"no-global-data"),source:"no-global-data"};
        state.lastError = operationalAttempt.status === "rejected" ? operationalAttempt.reason : null;
        commitDailyLeaderState({...candidate,lastError:state.lastError},{source:candidate.source,render:true,dispatch:true,generation:requestId});
        subscribePublicDay(dayId,period.id);
        if (state.result?.hasLeader || globalSnapshot) saveDailyGlobalCache(dayId,period.id,state.rows,state.result);
        validateResultConsistency(state.result,state.rows,dayId,period.id);
        if (operationalAttempt.status === "rejected") diagnostic("READ_GLOBAL_DAILY_BILLING",operationalAttempt.reason?.code || "DAILY_RANKING_GLOBAL_READ_FAILED",operationalAttempt.reason,{functionName:"refresh",eventType:"WARNING",operationalDayId:dayId,weeklyPeriodId:period.id,firestorePath:"billing_records",query:"consulta global por período y fecha, sin fallback privado"});
        return state.result;
      }
      stopPublicSubscription();
      const previous = previousPeriod(period);
      const records = await readBillingForPeriods([previous?.id,period.id],{dayId,driverIds:knownDriverIds()});
      if (requestId !== state.requestId || dayId !== operationalDayIdFromDate(operationalNow(),TZ)) return state.result;
      const rows = aggregateDay(records,dayId,period.id);
      const adminResult = sourcedDailyResult(buildDailyLeaderResult(rows,dayId,period.id),"global-operational");
      commitDailyLeaderState({dayId,weeklyPeriodId:period.id,records,rows,result:adminResult,source:"global-operational"},{source:"global-operational",render:true,dispatch:false,generation:requestId});
      validateResultConsistency(state.result,rows,dayId,period.id);
      publishPublicDay(dayId,period.id,rows,state.result).catch(error => diagnostic("PUBLISH_PUBLIC_DAILY_RANKING",error?.code || "DAILY_RANKING_PUBLIC_WRITE_FAILED",error,{functionName:"publishPublicDay",operationalDayId:dayId,weeklyPeriodId:period.id,documentsRead:records.length,documentsValid:rows.length,rankingLength:rows.length,firestorePath:`${publicCollectionName()}/${dayId}`,query:"setDoc"}));
      finalizeExpiredDays().catch(error => diagnostic("FINALIZE_EXPIRED_DAYS",error?.code || "DAILY_RANKING_FINALIZE_SCAN_FAILED",error,{functionName:"finalizeExpiredDays",operationalDayId:dayId,weeklyPeriodId:period.id,firestorePath:bonusCollectionName(),query:"billing_records + runTransaction"}));
      window.dispatchEvent(new CustomEvent("explora:daily-ranking-updated",{detail:getState()}));
      return state.result;
    })().catch(error => {
      const now = operationalNow(), dayId = operationalDayIdFromDate(now,TZ), period = currentPeriod(now);
      diagnostic("REFRESH_DAILY_RANKING",error?.code || "DAILY_RANKING_REFRESH_FAILED",error,{functionName:"refresh",operationalDayId:dayId,weeklyPeriodId:period.id,requestId,firestorePath:"billing_records / dailyRankingPublic",query:"reconstrucción completa"});
      const cached = loadDailyGlobalCache(dayId,period.id);
      const keepCurrent = state.dayId === dayId && state.result?.hasLeader;
      if (!keepCurrent) {
        state.dayId = dayId; state.weeklyPeriodId = period.id; state.rows = cached?.rows || []; state.records = [];
        state.result = cached?.result ? sourcedDailyResult(cached.result,"daily-global-cache") : neutralDailyResult(dayId,period.id,"refresh-error");
      }
      renderAll();
      return state.result;
    }).finally(() => { state.loading = false; state.refreshPromise = null; scheduleMidnightRefresh(); scheduleLiveRefresh(); refreshWeeklyPlaques({force:true}).catch(error => diagnostic("REFRESH_WEEKLY_PLAQUES_AFTER_RANKING",error?.code || "WEEKLY_PLAQUES_REFRESH_FAILED",error,{functionName:"refresh.finally",operationalDayId:state.dayId,weeklyPeriodId:state.weeklyPeriodId,firestorePath:publicCollectionName(),query:"sincronización posterior al ranking"})); });
    return state.refreshPromise;
  }

  function millisecondsUntilNextOperationalDay() {
    const now = operationalNow();
    const dayId = operationalDayIdFromDate(now,TZ);
    const next = new Date(`${addOperationalDays(dayId,1)}T00:00:00-03:00`).getTime();
    const current = now.getTime();
    return Math.max(1000,Math.min(24*60*60*1000,next-current+250));
  }
  function scheduleMidnightRefresh() {
    clearTimeout(state.timer);
    state.timer = window.setTimeout(() => refresh({force:true}).catch(() => {}),millisecondsUntilNextOperationalDay());
  }
  function scheduleLiveRefresh() {
    clearTimeout(state.liveRefreshTimer);
    if (!auth?.currentUser?.uid) return;
    state.liveRefreshTimer = window.setTimeout(() => {
      if (document.hidden) { scheduleLiveRefresh(); return; }
      refresh({force:true}).catch(() => {});
    },LIVE_RANKING_REFRESH_MS);
  }
  function getState() {
    return Object.freeze({
      version:DAILY_RANKING_VERSION, operationalDayId:state.dayId, weeklyPeriodId:state.weeklyPeriodId,
      rows:state.rows.map(row => ({...row})), result:state.result, loading:state.loading,
      bonusCollection:bonusCollectionName(), weeklyPlaquesVersion:WEEKLY_PLAQUES_VERSION, weeklyPlaques:state.weeklyPlaques.map(row => ({...row})), weeklyPlaquesLoading:state.weeklyPlaquesLoading, readDiagnostics:state.readDiagnostics ? {...state.readDiagnostics,attempts:[...(state.readDiagnostics.attempts || [])]} : null, expectedActivity:state.expectedActivity ? {...state.expectedActivity} : null, lastError:state.lastError ? {code:state.lastError.code || "DAILY_RANKING_ERROR",message:state.lastError.message || String(state.lastError)} : null
    });
  }

  window.ExploraDailyRanking = Object.freeze({
    version:DAILY_RANKING_VERSION, bonusAmount:DAILY_RANKING_BONUS_AMOUNT, refresh, getState,
    renderDashboard, renderDetail, renderWeeklyPlaques, refreshWeeklyPlaques, finalizeExpiredDays, loadWeeklyBonuses, bonusCollectionName, publicCollectionName,
    bonusesForDriver:dailyBonusesForDriver, totalBonuses:totalDailyBonuses
  });

  const activityEvents = new Set(["explora:cobro-registrado","explora:payment-registered","explora:derivacion-completada","explora:derivacion-facturada"]);
  const trigger = event => {
    try {
      const currentDay = operationalDayIdFromDate(operationalNow(),TZ);
      if (["explora:operational-date-changed","explora:operational-period-changed"].includes(event?.type)) { state.expectedActivity = null; invalidateWeeklyPlaques(event.type); }
      if (activityEvents.has(event?.type)) {
        const detail = event?.detail || {};
        state.expectedActivity = {
          eventType:event.type, dayId:currentDay, driverUid:text(detail.driverUid || detail.choferUid || detail.uid || detail.receptorUid),
          operationId:text(detail.billingId || detail.operationId || detail.id || detail.derivationId), amount:positive(detail.amount ?? detail.monto ?? detail.finalAmount), createdAt:Date.now()
        };
      }
    } catch (error) { diagnostic("CAPTURE_DAILY_ACTIVITY_EVENT","DAILY_RANKING_EVENT_CAPTURE_FAILED",error,{functionName:"trigger",query:event?.type || "evento desconocido"}); }
    refresh({force:true}).catch(error => diagnostic("TRIGGER_DAILY_RANKING_REFRESH",error?.code || "DAILY_RANKING_TRIGGER_FAILED",error,{functionName:"trigger",query:event?.type || "evento"}));
  };
  ["explora:operational-date-changed","explora:operational-period-changed","explora:cobro-registrado","explora:payment-registered","explora:derivacion-completada","explora:derivacion-facturada","explora:operational-snapshot-updated","explora:firestore-global-state","explora:session-opened","explora:simulation-updated"].forEach(name => window.addEventListener(name,trigger));
  document.addEventListener("visibilitychange",() => { if (!document.hidden) trigger(); });
  window.addEventListener("online",trigger);
  window.addEventListener("beforeunload",() => { clearTimeout(state.timer); clearTimeout(state.liveRefreshTimer); clearTimeout(state.weeklyPlaquesRetryTimer); stopPublicSubscription(); try { state.plaqueObserver?.disconnect?.(); } catch (_) {} },{once:true});
  window.addEventListener("explora:performance-updated",() => {
    if (!state.weeklyPlaques.length) return;
    state.weeklyPlaques = applyExistingDerivationAward(state.weeklyPlaques,state.weeklyPlaquesPeriodId);
    renderWeeklyPlaques(state.weeklyPlaques);
  });
  if (auth) onAuthStateChanged(auth,user => { invalidateWeeklyPlaques("auth-changed"); state.authUid = user?.uid || ""; if (user) trigger(); else { stopPublicSubscription(); state.rows=[]; state.result=null; state.weeklyPlaques=[]; renderAll(); } });
  ensureDiagnosticCopyButton();
  queueMicrotask(() => { refresh().catch(() => {}); refreshWeeklyPlaques().catch(() => {}); });
})();
