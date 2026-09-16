import { getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

(() => {
  "use strict";
  if (window.__exploraPersonalRecordReadOnlyV2456) return;
  window.__exploraPersonalRecordReadOnlyV2456 = true;

  const app = getApps().length ? getApp() : null;
  const auth = app ? getAuth(app) : null;
  const db = app ? getFirestore(app) : null;
  const RECORD_COLLECTION = "driverPersonalRecords";
  const EVENT_COLLECTION = "personalRecordEvents";
  const BONUS_RATE = 0.05;
  const TIMEZONE = "America/Argentina/Cordoba";
  const state = {
    user: null,
    record: null,
    event: null,
    status: "loading",
    error: null,
    unsubscribeRecord: null,
    unsubscribeEvent: null,
    renderedSignature: ""
  };

  const text = value => String(value ?? "").trim();
  const positive = value => Math.max(0, Math.round(Number(value) || 0));
  const esc = value => text(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = value => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(positive(value));
  const initials = name => text(name).split(/\s+/).filter(Boolean).slice(0,2).map(part => part[0]?.toUpperCase() || "").join("") || "CH";

  function operationalNow() {
    const value = window.ExploraOperationalClock?.getNow?.();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
  }
  function operationalDayId(date = operationalNow()) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone:TIMEZONE, year:"numeric", month:"2-digit", day:"2-digit" }).format(date);
    } catch (_) {
      return date.toISOString().slice(0,10);
    }
  }
  function resetPersonalRecordState() {
    try { state.unsubscribeRecord?.(); } catch (_) {}
    try { state.unsubscribeEvent?.(); } catch (_) {}
    state.unsubscribeRecord = null;
    state.unsubscribeEvent = null;
    state.record = null;
    state.event = null;
    state.error = null;
    state.status = state.user ? "loading" : "no-record";
    state.renderedSignature = "";
  }
  function normalizeRecord(data = {}) {
    const amount = positive(data.recordAmount);
    if (!amount) return null;
    return {
      driverUid: text(data.driverUid),
      driverName: text(data.driverName || "Chofer"),
      driverAvatar: text(data.driverAvatar),
      recordAmount: amount,
      recordDayId: text(data.recordDayId),
      weeklyPeriodId: text(data.weeklyPeriodId),
      baselineEstablished: data.baselineEstablished === true,
      migrationStatus: text(data.migrationStatus)
    };
  }
  function normalizeEvent(id, data = {}) {
    const amount = positive(data.newRecordAmount);
    const status = text(data.status || "provisional").toLowerCase();
    if (!amount || ["void","reversed"].includes(status)) return null;
    return {
      id: text(data.eventId || id),
      driverUid: text(data.driverUid),
      driverName: text(data.driverName || "Chofer"),
      driverAvatar: text(data.driverAvatar),
      operationalDayId: text(data.operationalDayId),
      weeklyPeriodId: text(data.weeklyPeriodId),
      previousRecordAmount: positive(data.previousRecordAmount),
      newRecordAmount: amount,
      bonusRate: Number(data.bonusRate) || BONUS_RATE,
      bonusAmount: positive(data.bonusAmount),
      status,
      recordType: text(data.recordType || (positive(data.previousRecordAmount) > 0 ? "broken" : "baseline"))
    };
  }
  function avatarMarkup(item = {}) {
    return item.driverAvatar
      ? `<span class="personal-record-avatar"><img alt="Foto de ${esc(item.driverName)}" src="${esc(item.driverAvatar)}" onerror="this.remove();this.parentElement.textContent='${esc(initials(item.driverName))}'"></span>`
      : `<span class="personal-record-avatar">${esc(initials(item.driverName))}</span>`;
  }
  function statusMarkup() {
    if (!state.user) return `<article class="personal-record-card is-neutral"><span class="personal-record-kicker">RÉCORD PERSONAL EXPLORA</span><strong>Iniciá sesión para ver tu marca</strong><small>La información se muestra únicamente al chofer correspondiente.</small></article>`;
    if (state.status === "loading") return `<article class="personal-record-card is-neutral is-loading"><span class="personal-record-kicker">RÉCORD PERSONAL EXPLORA</span><strong>Estamos calculando tu progreso</strong><small>Sincronizando información confirmada…</small></article>`;
    if (state.status === "offline-pending") return `<article class="personal-record-card is-neutral"><span class="personal-record-kicker">RÉCORD PERSONAL EXPLORA</span><strong>Información pendiente de sincronización</strong><small>Se actualizará cuando vuelva la conexión.</small></article>`;
    if (state.status === "error") return `<article class="personal-record-card is-neutral"><span class="personal-record-kicker">RÉCORD PERSONAL EXPLORA</span><strong>No pudimos actualizar tu récord</strong><small>${esc(state.error || "Intenta nuevamente.")}</small></article>`;
    if (!state.record) return `<article class="personal-record-card is-neutral"><span class="personal-record-kicker">RÉCORD PERSONAL EXPLORA</span><strong>Todavía no tienes suficiente historial para calcular tu récord</strong><small>Tu primera marca aparecerá cuando sea confirmada por el servidor.</small></article>`;
    return "";
  }
  function eventMarkup(event = {}, detail = false) {
    const isBaseline = event.recordType === "baseline" || positive(event.previousRecordAmount) <= 0;
    if (isBaseline) {
      return `<article class="personal-record-card is-baseline" data-record-event="${esc(event.id)}"><span class="personal-record-kicker">PRIMERA MARCA REGISTRADA</span><div class="personal-record-winner">${avatarMarkup(event)}<span class="personal-record-copy"><b>${esc(event.driverName)}</b><span>Ya tiene una marca personal para superar</span></span></div><span class="personal-record-bonus is-baseline-value"><span>MARCA ACTUAL</span><b>${money(event.newRecordAmount)}</b></span><small>Esta primera marca no genera bono.</small></article>`;
    }
    const provisional = event.status === "provisional";
    return `<article class="personal-record-card is-new-record" data-record-event="${esc(event.id)}"><span class="personal-record-kicker">${provisional ? "RÉCORD PROVISIONAL" : "NUEVO RÉCORD PERSONAL"}</span><div class="personal-record-winner">${avatarMarkup(event)}<span class="personal-record-copy"><b>${esc(event.driverName)}</b><span>${provisional ? "Superaste provisionalmente tu récord" : "Nuevo récord confirmado"}</span></span></div><div class="personal-record-values"><span class="personal-record-value"><span>RÉCORD ANTERIOR</span><b>${money(event.previousRecordAmount)}</b></span><span class="personal-record-value"><span>NUEVA MARCA</span><b>${money(event.newRecordAmount)}</b></span></div>${detail && !provisional ? `<span class="personal-record-bonus"><span>BONO DEL 5%</span><b>+${money(event.bonusAmount)}</b></span>` : `<small>${provisional ? "Pendiente de validación del servidor" : "Logro confirmado por EXPLORA"}</small>`}</article>`;
  }
  function recordMarkup(record = {}) {
    return `<article class="personal-record-card is-neutral"><span class="personal-record-kicker">RÉCORD PERSONAL EXPLORA</span><strong>Tu mejor marca: ${money(record.recordAmount)}</strong><small>${record.recordDayId ? `Registrada el ${esc(record.recordDayId)}.` : "Seguí sumando para superarte."}</small></article>`;
  }
  function visibleItem() {
    const today = operationalDayId();
    return state.event && state.event.driverUid === state.user?.uid && state.event.operationalDayId === today ? state.event : null;
  }
  function render() {
    const event = visibleItem();
    const fallback = statusMarkup();
    const dashboardHtml = event ? eventMarkup(event, false) : (fallback || recordMarkup(state.record));
    const detailHtml = event ? eventMarkup(event, true) : (fallback || recordMarkup(state.record));
    const signature = `${state.user?.uid || "none"}|${state.status}|${state.record?.recordAmount || 0}|${event?.id || "none"}|${event?.newRecordAmount || 0}|${state.error || ""}`;
    if (signature === state.renderedSignature) return;
    state.renderedSignature = signature;
    const dashboard = document.getElementById("personalRecordDashboardHost");
    const detail = document.getElementById("personalRecordDetailHost");
    if (dashboard) dashboard.innerHTML = dashboardHtml;
    if (detail) detail.innerHTML = detailHtml;
  }
  function subscribeOwnRecord(uid) {
    resetPersonalRecordState();
    if (!db || !uid) { render(); return; }
    state.status = "loading";
    const recordRef = doc(db, RECORD_COLLECTION, uid);
    const eventRef = doc(db, EVENT_COLLECTION, `${uid}_${operationalDayId()}`);
    state.unsubscribeRecord = onSnapshot(recordRef, { includeMetadataChanges:true }, snap => {
      if (snap.metadata.fromCache && !navigator.onLine) state.status = "offline-pending";
      else state.status = snap.exists() ? "record-found" : "no-record";
      state.record = snap.exists() ? normalizeRecord(snap.data() || {}) : null;
      state.error = null;
      render();
    }, error => {
      state.status = error?.code === "unavailable" ? "offline-pending" : "error";
      state.error = error?.code === "permission-denied" ? "No tienes permiso para consultar esta marca." : "Intenta nuevamente.";
      console.warn("[EXPLORA récord personal] lectura del récord propio no disponible", error?.code || error?.message || error);
      render();
    });
    state.unsubscribeEvent = onSnapshot(eventRef, { includeMetadataChanges:true }, snap => {
      state.event = snap.exists() ? normalizeEvent(snap.id, snap.data() || {}) : null;
      if (snap.metadata.hasPendingWrites || (snap.metadata.fromCache && !navigator.onLine)) state.status = "offline-pending";
      else if (state.status !== "error") state.status = state.record ? "record-found" : "no-record";
      render();
    }, error => {
      state.status = error?.code === "unavailable" ? "offline-pending" : "error";
      state.error = error?.code === "permission-denied" ? "No tienes permiso para consultar este evento." : "Intenta nuevamente.";
      console.warn("[EXPLORA récord personal] lectura del evento propio no disponible", error?.code || error?.message || error);
      render();
    });
  }

  // Compatibilidad: el ranking puede seguir notificando, pero el cliente ya no escribe ni recorre choferes.
  async function evaluateRows() { return { skipped:true, reason:"server-authoritative" }; }

  window.ExploraPersonalRecord = Object.freeze({
    version:"2.4.56-server-authoritative",
    bonusRate:BONUS_RATE,
    evaluateRows,
    getLatest:() => visibleItem() ? {...visibleItem()} : null,
    resetPersonalRecordState
  });
  window.addEventListener("explora:operational-date-changed", () => {
    if (state.user?.uid) subscribeOwnRecord(state.user.uid);
  });
  window.addEventListener("online", () => { if (state.user?.uid) subscribeOwnRecord(state.user.uid); });
  window.addEventListener("offline", () => { state.status = "offline-pending"; render(); });
  if (auth) onAuthStateChanged(auth, user => {
    resetPersonalRecordState();
    state.user = user || null;
    if (user?.uid) subscribeOwnRecord(user.uid);
    else render();
  });
  else render();
  window.addEventListener("beforeunload", resetPersonalRecordState, { once:true });
})();
