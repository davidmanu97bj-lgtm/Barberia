import {
  DRIVER_DEBT_VERSION,
  normalizeDebt,
  summarizeDebts,
  formatCompactMoney,
  previewInstallmentApplication
} from "../core/driver-debt-core.mjs";

const DRIVER_INCIDENTS_MODULE_VERSION = "v2.2.7-driver-incidents-lazy-firebase";

if (window.ExploraDriverIncidents?.version !== DRIVER_INCIDENTS_MODULE_VERSION) {
  "use strict";
  const { getApps, getApp } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
  const { getAuth, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js");
  const {
    getFirestore, collection, doc, getDoc, getDocs, query, where, limit,
    onSnapshot, runTransaction, serverTimestamp
  } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");

  let auth = null;
  let db = null;
  let firebaseReadyPromise = null;
  let unsubscribeAuth = null;

  async function ensureFirebaseContext(timeoutMs = 15000) {
    if (auth && db) return { auth, db };
    if (firebaseReadyPromise) return firebaseReadyPromise;
    firebaseReadyPromise = (async () => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const live = window.ExploraFirebase || {};
        if (live.auth && live.db) {
          auth = live.auth;
          db = live.db;
          return { auth, db };
        }
        const apps = getApps();
        if (apps.length) {
          const app = getApp();
          auth = getAuth(app);
          db = getFirestore(app);
          return { auth, db };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("EXPLORA_FIREBASE_NOT_READY_FOR_DRIVER_INCIDENTS");
    })();
    try {
      return await firebaseReadyPromise;
    } catch (error) {
      firebaseReadyPromise = null;
      throw error;
    }
  }

  const currentUser = () => auth?.currentUser || window.ExploraFirebase?.auth?.currentUser || null;
  const $ = id => document.getElementById(id);
  const clean = value => String(value ?? "").trim();
  const esc = value => clean(value).replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
  const money = value => formatCompactMoney(value);
  const ADMIN_ROLES = new Set(["admin", "administrador", "owner", "superadmin"]);
  const isAdminSession = () => document.body?.classList.contains("explora-shared-admin") || ADMIN_ROLES.has(clean(window.ExploraSession?.role || window.ExploraSession?.profile?.role || window.ExploraSession?.profile?.rol).toLowerCase());
  const state = {
    uid:"", rows:[], summary:summarizeDebts([], ""), unsubscribe:null, generation:0,
    legacy:new Map(), expanded:new Set(), history:new Map(), loadingHistory:new Set(), viewerItems:[], viewerIndex:0, viewerTrigger:null, reconcilePromise:null
  };

  function activePeriodId() {
    return clean(window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id || window.ExploraCanonicalWeeklyClosure?.getWeeklyPeriod?.().id || "");
  }
  function dateValue(value) {
    try {
      const date = value?.toDate ? value.toDate() : new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    } catch { return null; }
  }
  function displayDate(value) {
    const date = dateValue(value);
    return date ? new Intl.DateTimeFormat("es-AR", { day:"2-digit", month:"2-digit", year:"numeric" }).format(date) : "—";
  }
  function displayDateTime(value) {
    const date = dateValue(value);
    return date ? new Intl.DateTimeFormat("es-AR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" }).format(date) : "—";
  }
  function mergeRows(canonical = []) {
    const map = new Map(state.legacy);
    canonical.forEach(row => map.set(row.id, row));
    state.rows = [...map.values()].sort((a,b) => (dateValue(b.incidentDate || b.createdAt)?.getTime() || 0) - (dateValue(a.incidentDate || a.createdAt)?.getTime() || 0));
    state.summary = summarizeDebts(state.rows, activePeriodId());
    applyDashboardState();
    if ($("driverIncidentsScreen")?.classList.contains("is-open")) renderScreen();
    window.dispatchEvent(new CustomEvent("explora:driver-debts-updated", { detail:{ uid:state.uid, rows:state.rows, summary:state.summary, weeklyPeriodId:activePeriodId() } }));
  }
  function dashboardButton() { return document.querySelector('[data-action="multas-choques"]'); }
  function applyDashboardState() {
    const button = dashboardButton();
    if (!button) return;
    if (isAdminSession()) {
      button.dataset.debtState = "admin";
      let adminStatus = button.querySelector("#driverIncidentsDashboardStatus, .vehicle-management-debt-status");
      if (!adminStatus) {
        adminStatus = document.createElement("small");
        adminStatus.id = "driverIncidentsDashboardStatus";
        adminStatus.className = "vehicle-management-debt-status";
        button.appendChild(adminStatus);
      }
      adminStatus.textContent = "Crear y gestionar registros";
      button.setAttribute("aria-label", "Abrir Multas y choques para crear o editar registros");
      return;
    }
    const dashboard = state.summary.dashboard;
    button.dataset.debtState = dashboard.code;
    let status = button.querySelector("#driverIncidentsDashboardStatus, .vehicle-management-debt-status");
    if (!status) {
      status = document.createElement("small");
      status.id = "driverIncidentsDashboardStatus";
      status.className = "vehicle-management-debt-status";
      button.appendChild(status);
    }
    status.textContent = dashboard.code === "pending" ? "🔴 Pago pendiente" : dashboard.code === "installment" ? `🟡 ${dashboard.label}` : "🟢 Sin deudas";
    button.setAttribute("aria-label", `Abrir Multas y choques. ${dashboard.fullLabel}`);
  }
  async function loadLegacy(uid, generation) {
    const map = new Map();
    for (const field of ["choferUid", "uid", "driverId"]) {
      const snap = await getDocs(query(collection(db,"deudas_choferes"), where(field,"==",uid), limit(100))).catch(error => {
        console.warn("DRIVER_DEBTS_LEGACY_QUERY_FAILED", field, error?.code || error?.message);
        return null;
      });
      snap?.docs?.forEach(item => map.set(item.id, { id:item.id, ...item.data() }));
    }
    if (generation !== state.generation || state.uid !== uid) return;
    state.legacy = map;
  }
  async function reconcileClosedDebtInstallments(uid, generation = state.generation) {
    if (!uid || state.reconcilePromise) return state.reconcilePromise || [];
    state.reconcilePromise = (async () => {
      const snap = await getDocs(query(collection(db,"cierres_semanales"), where("driverUid","==",uid), limit(100))).catch(error => {
        console.warn("DRIVER_DEBT_CLOSURE_RECONCILIATION_READ_FAILED", error?.code || error?.message);
        return null;
      });
      if (!snap || generation !== state.generation || state.uid !== uid) return [];
      const closures = snap.docs.map(item => ({ id:item.id, ...item.data() }))
        .filter(row => row.testMode !== true && row.snapshotValidated !== false && clean(row.weeklyPeriodId || row.periodId))
        .sort((a,b) => clean(a.weeklyPeriodId || a.periodId).localeCompare(clean(b.weeklyPeriodId || b.periodId)));
      const results = [];
      for (const closure of closures) {
        if (generation !== state.generation || state.uid !== uid) break;
        const applied = await applyClosure({ closureId:closure.closureId || closure.id, weeklyPeriodId:closure.weeklyPeriodId || closure.periodId, snapshot:closure.weeklySnapshot || closure });
        results.push(...applied);
      }
      return results;
    })().finally(() => { state.reconcilePromise = null; });
    return state.reconcilePromise;
  }
  async function start(uid = "", options = {}) {
    const { waitForInitial = false } = options;
    try {
      await ensureFirebaseContext();
    } catch (error) {
      console.error("DRIVER_INCIDENTS_FIREBASE_INIT_FAILED", error);
      return false;
    }
    const nextUid = clean(uid || currentUser()?.uid || "");
    if (isAdminSession()) { stop(); return false; }
    if (!nextUid) { stop(); return false; }
    if (state.uid === nextUid && state.unsubscribe) {
      reconcileClosedDebtInstallments(nextUid, state.generation);
      return true;
    }
    stop(false);
    state.uid = nextUid;
    const generation = ++state.generation;
    state.legacy = new Map();
    state.rows = [];
    state.summary = summarizeDebts([], activePeriodId());
    applyDashboardState();
    await loadLegacy(nextUid, generation);
    if (generation !== state.generation) return false;
    let resolveInitial = null;
    let initialResolved = false;
    const initialPromise = new Promise(resolve => { resolveInitial = resolve; });
    const finishInitial = value => {
      if (initialResolved) return;
      initialResolved = true;
      resolveInitial?.(value);
    };
    state.unsubscribe = onSnapshot(
      query(collection(db,"deudas_choferes"), where("driverUid","==",nextUid)),
      snap => {
        if (generation !== state.generation || state.uid !== nextUid) { finishInitial(false); return; }
        mergeRows(snap.docs.map(item => ({ id:item.id, ...item.data() })));
        finishInitial(true);
      },
      error => {
        console.error("DRIVER_DEBTS_REALTIME_FAILED", error);
        if (generation === state.generation && state.uid === nextUid) {
          mergeRows([]);
          const status = $("driverIncidentsStatus");
          if (status && $("driverIncidentsScreen")?.classList.contains("is-open")) {
            status.hidden = false;
            status.className = "vehicle-detail-status is-error";
            status.textContent = "No se pudieron actualizar las multas y choques. Revisa tu conexión.";
          }
        }
        finishInitial(false);
      }
    );
    reconcileClosedDebtInstallments(nextUid, generation);
    if (!waitForInitial) return true;
    return Promise.race([
      initialPromise,
      new Promise(resolve => setTimeout(() => resolve(false), 7000))
    ]);
  }
  function stop(clear = true) {
    try { state.unsubscribe?.(); } catch (error) { console.warn("DRIVER_DEBTS_UNSUBSCRIBE_FAILED", error); }
    state.unsubscribe = null;
    state.generation++;
    if (clear) {
      state.uid = ""; state.rows = []; state.legacy.clear(); state.expanded.clear(); state.history.clear();
      state.summary = summarizeDebts([], activePeriodId());
      applyDashboardState();
    }
  }
  function updateOverlayState() {
    const hasOpen = Boolean(document.querySelector(".vehicle-detail-screen.is-open"));
    document.body.classList.toggle("vehicle-detail-open", hasOpen);
    if (!hasOpen) document.body.style.overflow = "";
  }
  function openScreen() {
    const screen = $("driverIncidentsScreen");
    if (!screen) return;
    closeViewer({ restoreFocus:false });
    document.querySelectorAll(".vehicle-detail-screen.is-open").forEach(item => {
      item.classList.remove("is-open"); item.setAttribute("aria-hidden","true"); item.setAttribute("inert",""); item.hidden = true;
    });
    screen.hidden = false;
    screen.removeAttribute("inert");
    screen.classList.add("is-open"); screen.setAttribute("aria-hidden","false"); screen.scrollTop = 0;
    document.body.style.overflow = "hidden";
    document.body.classList.add("vehicle-detail-open");
  }
  function closeScreen() {
    const screen = $("driverIncidentsScreen");
    if (!screen) return;
    closeViewer({ restoreFocus:false });
    screen.classList.remove("is-open"); screen.setAttribute("aria-hidden","true"); screen.setAttribute("inert",""); screen.hidden = true;
    updateOverlayState();
  }
  function statusMarkup(debt) {
    const icon = debt.status === "paid" ? "🟢" : debt.status === "installment" ? "🟡" : debt.status === "cancelled" ? "⚪" : "🔴";
    return `${icon} ${debt.statusLabel}`;
  }
  function summaryMarkup() {
    const s = state.summary;
    const general = s.dashboard.code === "pending" ? "🔴 Pago pendiente" : s.dashboard.code === "installment" ? "🟡 En cuotas" : "🟢 Sin deudas";
    return `<section class="driver-incidents-summary" aria-label="Resumen de multas y choques">
      <div><span>Deuda pendiente</span><strong>${esc(money(s.totalPending))}</strong></div>
      <div><span>Cuota semanal</span><strong>${esc(money(s.weeklyTotal))}</strong></div>
      <div><span>Multas activas</span><strong>${s.fines}</strong></div>
      <div><span>Choques activos</span><strong>${s.crashes}</strong></div>
      <p class="driver-incidents-general" data-state="${esc(s.dashboard.code)}">${general}</p>
    </section>`;
  }
  function attachmentRow(debt) {
    if (!debt.attachments.length) return "";
    const label = debt.attachments.length === 1 ? "Archivo adjunto" : `${debt.attachments.length} archivos adjuntos`;
    return `<div class="driver-debt-attachment-row"><span>📎 ${esc(label)}</span><button type="button" data-debt-attachments="${esc(debt.id)}">Ver</button></div>`;
  }
  function historyMarkup(debt) {
    if (state.loadingHistory.has(debt.id)) return '<p class="driver-debt-history-empty">Cargando historial…</p>';
    const rows = state.history.get(debt.id) || [];
    if (!rows.length) return '<p class="driver-debt-history-empty">Todavía no hay descuentos confirmados.</p>';
    return `<div class="driver-debt-history">${rows.map(row => `<article><strong>Semana ${esc(row.weeklyPeriodId || "—")}</strong><span>Cuota: ${esc(money(row.amount || row.discountAmount))}</span><span>Saldo anterior: ${esc(money(row.previousBalance))}</span><span>Saldo posterior: ${esc(money(row.newBalance))}</span><small>${esc(row.status || "applied")} · ${esc(displayDateTime(row.appliedAt || row.createdAt))}</small></article>`).join("")}</div>`;
  }
  function detailMarkup(debt) {
    return `<div class="driver-debt-detail" ${state.expanded.has(debt.id) ? "" : "hidden"}>
      <div class="driver-debt-detail-grid">
        <div><span>Tipo</span><strong>${esc(debt.typeLabel)}</strong></div><div><span>Fecha</span><strong>${esc(displayDate(debt.incidentDate))}</strong></div>
        <div><span>Importe total</span><strong>${esc(money(debt.totalAmount))}</strong></div><div><span>Importe pagado</span><strong>${esc(money(debt.paidAmount))}</strong></div>
        <div><span>Saldo pendiente</span><strong>${esc(money(debt.remainingAmount))}</strong></div><div><span>Cuota semanal</span><strong>${esc(money(debt.weeklyInstallmentAmount))}</strong></div>
        <div><span>Cantidad de cuotas</span><strong>${debt.installmentCount}</strong></div><div><span>Cuotas pagadas</span><strong>${debt.paidInstallments}</strong></div>
        <div><span>Próximo descuento</span><strong>${esc(debt.nextWeeklyPeriodId || "—")}</strong></div><div><span>Estado</span><strong>${esc(statusMarkup(debt))}</strong></div>
        <div><span>Vehículo involucrado</span><strong>${esc(debt.vehiclePlate || debt.vehicleId || "—")}</strong></div>
      </div>
      <div class="driver-debt-copy"><span>Motivo o descripción</span><p>${esc(debt.description)}</p></div>
      ${debt.adminNotes ? `<div class="driver-debt-copy"><span>Observaciones del administrador</span><p>${esc(debt.adminNotes)}</p></div>` : ""}
      <section class="driver-debt-history-wrap"><h3>HISTORIAL DE PAGOS</h3>${historyMarkup(debt)}</section>
      <button class="driver-debt-collapse" type="button" data-debt-detail="${esc(debt.id)}">Contraer detalle</button>
    </div>`;
  }
  function cardMarkup(debt) {
    const typeDate = `${debt.typeLabel} · ${displayDate(debt.incidentDate)}`;
    return `<article class="driver-debt-card" data-debt-id="${esc(debt.id)}" data-state="${esc(debt.status)}">
      <header><strong>${esc(typeDate)}</strong><span>${esc(statusMarkup(debt))} · ${esc(money(debt.remainingAmount))}</span></header>
      <div class="driver-debt-card-meta"><span>Cuota semanal: <b>${esc(money(debt.weeklyInstallmentAmount))}</b></span>${debt.vehiclePlate ? `<span>Patente: <b>${esc(debt.vehiclePlate)}</b></span>` : ""}</div>
      ${attachmentRow(debt)}
      <button class="driver-debt-detail-toggle" type="button" data-debt-detail="${esc(debt.id)}">${state.expanded.has(debt.id) ? "Ocultar detalle" : "Ver detalle"}</button>
      ${detailMarkup(debt)}
    </article>`;
  }
  function renderScreen() {
    const status = $("driverIncidentsStatus"), list = $("driverIncidentsList");
    if (!status || !list) return;
    const rows = state.summary.normalized.filter(row => row.status !== "cancelled");
    status.hidden = true;
    list.hidden = false;
    list.innerHTML = summaryMarkup() + (rows.length ? `<div class="driver-debt-list">${rows.map(cardMarkup).join("")}</div>` : '<div class="driver-debt-empty">🟢<strong>Sin deudas</strong><span>No tienes multas ni choques pendientes.</span></div>');
  }
  async function show() {
    if (isAdminSession()) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const openDebt = window.ExploraAdminTools?.openDebt;
        if (typeof openDebt === "function") {
          await openDebt();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      openScreen();
      const status = $("driverIncidentsStatus"), list = $("driverIncidentsList");
      if (list) { list.hidden = true; list.innerHTML = ""; }
      if (status) {
        status.hidden = false;
        status.className = "vehicle-detail-status is-error";
        status.textContent = "No se pudo abrir la administración de Multas y choques. Recarga la app e inténtalo nuevamente.";
      }
      return;
    }
    openScreen();
    const status = $("driverIncidentsStatus"), list = $("driverIncidentsList");
    if (status) { status.hidden = false; status.className = "vehicle-detail-status"; status.textContent = "Cargando multas y choques…"; }
    if (list) { list.hidden = true; list.innerHTML = ""; }
    try {
      await ensureFirebaseContext();
    } catch (error) {
      console.error("DRIVER_INCIDENTS_FIREBASE_INIT_FAILED", error);
      if (status) {
        status.hidden = false;
        status.className = "vehicle-detail-status is-error";
        status.textContent = "No se pudo iniciar Firebase para Multas y choques. Recarga la app e inténtalo nuevamente.";
      }
      return;
    }
    const uid = currentUser()?.uid;
    if (!uid) { if (status) status.textContent = "No hay una sesión activa."; return; }
    const confirmed = await start(uid, { waitForInitial:true });
    if (confirmed || state.rows.length || state.legacy.size) {
      renderScreen();
      return;
    }
    if (status && !status.classList.contains("is-error")) {
      status.hidden = false;
      status.className = "vehicle-detail-status is-error";
      status.textContent = "No se pudo confirmar la información de multas y choques. Revisa tu conexión.";
    }
  }
  async function loadHistory(debtId) {
    if (!debtId || state.loadingHistory.has(debtId) || state.history.has(debtId)) return;
    await ensureFirebaseContext();
    state.loadingHistory.add(debtId); renderScreen();
    try {
      const snap = await getDocs(collection(db,"deudas_choferes",debtId,"payment_history"));
      const rows = snap.docs.map(item => ({ id:item.id, ...item.data() })).sort((a,b) => clean(b.weeklyPeriodId).localeCompare(clean(a.weeklyPeriodId)));
      state.history.set(debtId, rows);
    } catch (error) {
      console.error("DRIVER_DEBT_HISTORY_LOAD_FAILED", error);
      state.history.set(debtId, []);
    } finally { state.loadingHistory.delete(debtId); renderScreen(); }
  }
  function debtById(id) { return state.summary.normalized.find(row => row.id === id); }
  function renderViewerItem() {
    const body = $("driverDebtViewerBody"), title = $("driverDebtViewerTitle"), meta = $("driverDebtViewerMeta"), open = $("driverDebtViewerOpen"), prev = $("driverDebtViewerPrev"), next = $("driverDebtViewerNext"), counter = $("driverDebtViewerCounter");
    const item = state.viewerItems[state.viewerIndex];
    if (!body || !title || !meta || !open || !item) return;
    const mime = clean(item.mimeType).toLowerCase(), isPdf = mime.includes("pdf") || /\.pdf(?:$|\?)/i.test(item.url);
    title.textContent = item.name || "Archivo adjunto";
    meta.textContent = `${displayDateTime(item.uploadedAt)} · Cargado por ${clean(item.uploadedByRole).toLowerCase().includes("admin") ? "Administrador" : "Usuario"}`;
    body.innerHTML = isPdf ? `<iframe title="${esc(item.name || "Archivo PDF")}" src="${esc(item.url)}"></iframe>` : `<img alt="${esc(item.name || "Archivo adjunto")}" src="${esc(item.url)}">`;
    open.href = item.url; open.hidden = false;
    if (counter) counter.textContent = `${state.viewerIndex + 1} de ${state.viewerItems.length}`;
    if (prev) prev.disabled = state.viewerItems.length < 2;
    if (next) next.disabled = state.viewerItems.length < 2;
  }
  function openViewer(items, index = 0) {
    const screen = $("driverIncidentsScreen"), viewer = $("driverDebtAttachmentViewer");
    if (!screen?.classList.contains("is-open") || !viewer || !items?.length) return;
    state.viewerTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.viewerItems = items;
    state.viewerIndex = Math.max(0, Math.min(items.length - 1, index));
    renderViewerItem();
    viewer.hidden = false;
    viewer.removeAttribute("inert");
    viewer.classList.add("is-open");
    viewer.setAttribute("aria-hidden","false");
    requestAnimationFrame(() => $("driverDebtViewerClose")?.focus?.({ preventScroll:true }));
  }
  function moveViewer(step) {
    if (state.viewerItems.length < 2) return;
    state.viewerIndex = (state.viewerIndex + step + state.viewerItems.length) % state.viewerItems.length;
    renderViewerItem();
  }
  function closeViewer(options = {}) {
    const { restoreFocus = true } = options;
    const viewer = $("driverDebtAttachmentViewer"), body = $("driverDebtViewerBody"), open = $("driverDebtViewerOpen");
    const trigger = state.viewerTrigger;
    if (viewer) {
      viewer.classList.remove("is-open");
      viewer.setAttribute("aria-hidden","true");
      viewer.setAttribute("inert","");
      viewer.hidden = true;
    }
    if (body) body.innerHTML = "";
    if (open) { open.hidden = true; open.removeAttribute("href"); }
    const prev = $("driverDebtViewerPrev"), next = $("driverDebtViewerNext"), counter = $("driverDebtViewerCounter");
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    if (counter) counter.textContent = "1 de 1";
    state.viewerItems = [];
    state.viewerIndex = 0;
    state.viewerTrigger = null;
    if (restoreFocus && trigger?.isConnected && $("driverIncidentsScreen")?.classList.contains("is-open")) {
      requestAnimationFrame(() => trigger.focus?.({ preventScroll:true }));
    }
  }
  async function applyDebtInstallment(debtId, weeklyPeriodId, requestedAmount, closureId) {
    await ensureFirebaseContext();
    const debtRef = doc(db,"deudas_choferes",debtId), historyRef = doc(db,"deudas_choferes",debtId,"payment_history",weeklyPeriodId);
    return runTransaction(db, async transaction => {
      const [debtSnap, historySnap] = await Promise.all([transaction.get(debtRef), transaction.get(historyRef)]);
      if (historySnap.exists()) return { applied:false, duplicate:true, debtId, weeklyPeriodId };
      if (!debtSnap.exists()) throw new Error(`DEBT_NOT_FOUND:${debtId}`);
      const raw = { id:debtSnap.id, ...debtSnap.data() };
      const preview = previewInstallmentApplication(raw, weeklyPeriodId, requestedAmount);
      if (!preview.applied) return { ...preview, debtId, weeklyPeriodId };
      const installments = (Array.isArray(raw.installments) ? raw.installments : []).map(item => {
        const itemPeriod = clean(item.weeklyPeriodId || item.periodoSemanalId);
        if (itemPeriod !== weeklyPeriodId) return item;
        return { ...item, status:"paid", paidAmount:preview.amount, paidAtClient:new Date().toISOString(), closureId:closureId || null };
      });
      const paidInstallments = installments.filter(item => ["paid","settled"].includes(clean(item.status).toLowerCase())).length;
      const next = installments.find(item => !["paid","settled","cancelled","canceled"].includes(clean(item.status).toLowerCase()));
      transaction.update(debtRef, {
        installments,
        remainingAmount:preview.newBalance, saldoPendiente:preview.newBalance,
        paidAmount:Math.max(0, Number(raw.totalAmount || raw.amount || 0) - preview.newBalance),
        paidInstallments, pendingInstallments:Math.max(0, installments.length - paidInstallments),
        nextWeeklyPeriodId:next?.weeklyPeriodId || null,
        status:preview.paid ? "paid" : "installment", debtStatus:preview.paid ? "paid" : "installment",
        lastPaidWeeklyPeriodId:weeklyPeriodId, lastClosureId:closureId || null,
        lastPaymentAmount:preview.amount, lastPaymentAt:serverTimestamp(), updatedAt:serverTimestamp()
      });
      transaction.set(historyRef, {
        debtId, driverUid:clean(raw.driverUid || raw.choferUid || raw.uid), vehicleId:clean(raw.vehicleId || raw.vehiculoId),
        weeklyPeriodId, closureId:closureId || null, amount:preview.amount,
        previousBalance:preview.previousBalance, newBalance:preview.newBalance,
        installmentNumber:preview.installmentNumber, installmentCount:preview.installmentCount,
        status:"applied", appliedAt:serverTimestamp(), createdAt:serverTimestamp()
      }, { merge:false });
      return { ...preview, debtId, weeklyPeriodId };
    });
  }
  async function applyClosure(detail = {}) {
    const snapshot = detail.snapshot || detail.data?.weeklySnapshot || detail.data || {};
    const weeklyPeriodId = clean(detail.weeklyPeriodId || snapshot.weeklyPeriodId);
    const closureId = clean(detail.closureId || detail.data?.closureId || snapshot.closureId);
    const rows = Array.isArray(snapshot.directDebtInstallments) ? snapshot.directDebtInstallments : [];
    if (!weeklyPeriodId || !rows.length) return [];
    const unique = new Map();
    rows.forEach(row => { const id = clean(row.debtId || row.documentId || clean(row.id).replace(/_\d+$/,"")); if (id) unique.set(id, row); });
    const results = [];
    for (const [debtId,row] of unique) {
      try { results.push(await applyDebtInstallment(debtId, weeklyPeriodId, Number(row.amount || 0), closureId)); }
      catch (error) {
        console.error("DRIVER_DEBT_CLOSURE_APPLY_FAILED", { debtId, weeklyPeriodId, closureId, error });
        window.dispatchEvent(new CustomEvent("explora:driver-debt-error", { detail:{ debtId, weeklyPeriodId, closureId, code:error?.code || "DEBT_CLOSURE_APPLY_FAILED", message:error?.message || String(error) } }));
      }
    }
    return results;
  }

  document.addEventListener("click", event => {
    const detail = event.target.closest?.("[data-debt-detail]");
    if (detail) {
      event.preventDefault();
      const id = detail.dataset.debtDetail;
      if (state.expanded.has(id)) state.expanded.delete(id); else { state.expanded.add(id); loadHistory(id); }
      renderScreen(); return;
    }
    const attachment = event.target.closest?.("[data-debt-attachments]");
    if (attachment) { event.preventDefault(); const debt = debtById(attachment.dataset.debtAttachments); if (debt) openViewer(debt.attachments); return; }
    if (event.target.closest?.("#driverDebtViewerClose, #driverDebtViewerCloseBottom") || event.target.id === "driverDebtAttachmentViewer") { event.preventDefault(); closeViewer(); return; }
    if (event.target.closest?.("#driverDebtViewerPrev")) { event.preventDefault(); moveViewer(-1); return; }
    if (event.target.closest?.("#driverDebtViewerNext")) { event.preventDefault(); moveViewer(1); }
  }, { passive:false });
  $("driverIncidentsBack")?.addEventListener("click", closeScreen);
  document.addEventListener("keydown", event => { if (event.key === "Escape") { if ($("driverDebtAttachmentViewer")?.classList.contains("is-open")) closeViewer(); else if ($("driverIncidentsScreen")?.classList.contains("is-open")) closeScreen(); } });
  async function syncForCurrentSession() {
    try {
      await ensureFirebaseContext();
      if (isAdminSession()) {
        stop();
        applyDashboardState();
        return;
      }
      const user = currentUser();
      if (user?.uid) await start(user.uid);
      else stop();
    } catch (error) {
      console.error("DRIVER_INCIDENTS_SESSION_SYNC_FAILED", error);
    }
  }

  async function bindAuthObserver() {
    if (unsubscribeAuth) return;
    try {
      await ensureFirebaseContext();
      unsubscribeAuth = onAuthStateChanged(auth, user => {
        if (user) queueMicrotask(() => isAdminSession() ? stop() : start(user.uid));
        else stop();
      });
    } catch (error) {
      console.error("DRIVER_INCIDENTS_AUTH_OBSERVER_FAILED", error);
    }
  }

  window.addEventListener("explora:weekly-closure", event => applyClosure(event.detail || {}));
  window.addEventListener("explora:session-opened", syncForCurrentSession);
  window.addEventListener("explora:auth-ready", syncForCurrentSession);
  window.addEventListener("explora:auth-cleared", () => { stop(); closeScreen(); });
  window.addEventListener("explora:app-date-refresh", () => { state.summary = summarizeDebts(state.rows, activePeriodId()); applyDashboardState(); if ($("driverIncidentsScreen")?.classList.contains("is-open")) renderScreen(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncForCurrentSession(); });
  window.addEventListener("pageshow", () => closeViewer({ restoreFocus:false }));

  void bindAuthObserver();
  void syncForCurrentSession();
  closeViewer({ restoreFocus:false });
  applyDashboardState();
  document.documentElement.dataset.driverIncidentsModule = DRIVER_INCIDENTS_MODULE_VERSION;
  window.ExploraActions = window.ExploraActions || {};
  window.ExploraActions["multas-choques"] = show;

  window.ExploraDriverIncidents = Object.freeze({
    version:DRIVER_INCIDENTS_MODULE_VERSION, coreVersion:DRIVER_DEBT_VERSION, show, close:closeScreen, refresh:() => start(currentUser()?.uid),
    applyDashboardState, applyClosure, applyDebtInstallment, reconcileClosedDebtInstallments,
    getState:() => ({ uid:state.uid, rows:[...state.rows], summary:state.summary, weeklyPeriodId:activePeriodId() }),
    ensureFirebase:ensureFirebaseContext
  });
}
