import {
  firebaseConfig,
  BUSINESS_ID,
  USER_EMAIL_DOMAIN,
  FUNCTIONS_REGION,
  LOGIN_ALIASES
} from "./firebase-config.js?v=4";
import {
  SERVICES,
  numberFromMoney,
  formatMoney,
  modelForPeriod,
  impactForCharge,
  normalizedBalance,
  timestampMs,
  safeText
} from "./barberia-core.mjs?v=4";

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  limit,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = initializeFirestore(firebaseApp, { experimentalAutoDetectLongPolling: true });
const storage = getStorage(firebaseApp);
const functions = getFunctions(firebaseApp, FUNCTIONS_REGION);
const adminCreateBarber = httpsCallable(functions, "adminCreateBarber");
const adminUpdateBarber = httpsCallable(functions, "adminUpdateBarber");
const syncPublicBarberBoard = httpsCallable(functions, "syncPublicBarberBoard");
const authReady = setPersistence(auth, browserLocalPersistence)
  .catch(() => setPersistence(auth, browserSessionPersistence))
  .catch(() => setPersistence(auth, inMemoryPersistence));

const $ = id => document.getElementById(id);
const PROFILE_COLLECTIONS = ["barberos", "usuarios", "users", "perfiles", "administradores", "admins"];
const ADMIN_ROLES = new Set(["admin", "administrador", "owner", "propietario", "superadmin"]);
const MAX_VISIBLE_RECEIPTS = 8;

let currentProfile = null;
let currentCharges = [];
let currentAdvertisingReceipts = [];
let currentClosures = [];
let adminBarbers = [];
let adminCharges = [];
let adminAdvertisingReceipts = [];
let adminClosures = [];
let teamBarberSummaries = [];
let currentUnsubscribers = [];
let adminUnsubscribers = [];
let teamSummaryUnsubscribe = null;
let pendingCharge = null;
let selectedAdminClosureId = "";
let managerMode = "create";
let receiptsExpanded = false;
let toastTimer = null;
let chargeSubmitting = false;
let closureSubmitting = false;
const adminProfileSources = new Map();
const dismissedPendingClosures = new Set();

function roleValue(profile = {}) {
  return String(profile.role || profile.rol || profile.tipoUsuario || profile.tipo || "barber").trim().toLowerCase();
}

function profileIsAdmin(profile = currentProfile) {
  return Boolean(profile?.admin === true || profile?.isAdmin === true || ADMIN_ROLES.has(roleValue(profile)));
}

function profileIsActive(profile = {}) {
  const status = String(profile.status || profile.estado || "").toLowerCase();
  return profile.active !== false && profile.activo !== false && !/inactiv|disabled|eliminad|deleted/.test(status);
}

function profileName(profile = {}) {
  return String(profile.displayName || profile.nombreCompleto || profile.nombre || profile.username || profile.usuario || "Barbero").trim() || "Barbero";
}

function profileUid(profile = {}) {
  return String(profile.uid || profile.authUid || profile.barberUid || profile.barberoUid || profile.id || "");
}

function cleanUsername(value) {
  return String(value || "").trim().normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function randomId(prefix) {
  const token = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, "")
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${token}`;
}

function formatDate(ms) {
  if (!Number(ms || 0)) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(Number(ms)));
}

function statusMessage(elementId, message = "", type = "") {
  const element = $(elementId);
  if (!element) return;
  element.textContent = message;
  element.className = `status${type ? ` ${type}` : ""}`;
}

function showModal(id) {
  $(id)?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function hideModal(id) {
  const modal = $(id);
  if (modal?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  modal?.classList.add("hidden");
  if (!document.querySelector(".modal:not(.hidden)")) document.body.style.overflow = "";
}

function showToast(title, message) {
  clearTimeout(toastTimer);
  $("toastTitle").textContent = title;
  $("toastMessage").textContent = message;
  $("successToast").classList.remove("hidden");
  toastTimer = setTimeout(() => $("successToast")?.classList.add("hidden"), 2700);
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function settlementPresentation(balance, name = "El barbero", adminPerspective = false) {
  const value = normalizedBalance(balance);
  if (value > 0) {
    return {
      className: "barber-owes",
      label: adminPerspective ? `${name} debe a la barbería` : "Debés pagar a la barbería",
      hint: adminPerspective
        ? "El barbero conserva más efectivo del que le corresponde después del reparto."
        : "Tenés en efectivo más de lo que te corresponde. La diferencia debe ingresar a la cuenta de la barbería."
    };
  }
  if (value < 0) {
    return {
      className: "business-owes",
      label: adminPerspective ? `La barbería debe a ${name}` : "La barbería debe pagarte",
      hint: adminPerspective
        ? "La barbería recibió más dinero digital del que le corresponde después del reparto."
        : "La barbería cobró en digital más de lo que le corresponde y debe entregarte la diferencia."
    };
  }
  return {
    className: "balanced",
    label: "Cuentas equilibradas",
    hint: "No hay diferencia pendiente entre el barbero y la barbería."
  };
}

function loginCandidates(value) {
  const normalized = cleanUsername(value);
  if (!normalized) return [];
  if (normalized.includes("@")) return [normalized];
  return [...new Set([
    LOGIN_ALIASES?.[normalized],
    `${normalized}@${USER_EMAIL_DOMAIN}`
  ].filter(Boolean))];
}

async function signInFromForm(username, password) {
  await authReady;
  let lastError;
  for (const email of loginCandidates(username)) {
    try {
      return await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      lastError = error;
      if (!/invalid-credential|user-not-found|wrong-password|invalid-email/.test(String(error?.code || ""))) throw error;
    }
  }
  throw lastError || new Error("No se pudo iniciar sesión.");
}

function loginError(error) {
  const code = String(error?.code || "");
  if (/invalid-credential|user-not-found|wrong-password/.test(code)) return "Usuario o clave incorrectos.";
  if (/too-many-requests/.test(code)) return "Demasiados intentos. Esperá unos minutos y volvé a probar.";
  if (/network-request-failed|unavailable/.test(code)) return "No hay conexión estable. Revisá internet e intentá otra vez.";
  return error?.message || "No se pudo iniciar sesión.";
}

async function loadProfile(user) {
  for (const collectionName of PROFILE_COLLECTIONS) {
    try {
      const snapshot = await getDoc(doc(db, collectionName, user.uid));
      if (!snapshot.exists()) continue;
      const data = snapshot.data() || {};
      return {
        ...data,
        id: snapshot.id,
        uid: data.uid || data.authUid || user.uid,
        displayName: profileName({ ...data, displayName: data.displayName || user.displayName }),
        role: collectionName === "administradores" || collectionName === "admins" ? "admin" : roleValue(data),
        active: profileIsActive(data)
      };
    } catch (_) {}
  }

  for (const collectionName of ["barberos", "usuarios", "users", "perfiles"]) {
    try {
      const byUid = await getDocs(query(collection(db, collectionName), where("uid", "==", user.uid), limit(1)));
      if (!byUid.empty) {
        const data = byUid.docs[0].data() || {};
        return { ...data, id: byUid.docs[0].id, uid: user.uid, displayName: profileName(data), role: roleValue(data), active: profileIsActive(data) };
      }
    } catch (_) {}
  }

  const token = await user.getIdTokenResult().catch(() => ({ claims: {} }));
  const claimRole = String(token.claims?.role || token.claims?.rol || "barber").toLowerCase();
  return {
    id: user.uid,
    uid: user.uid,
    displayName: user.displayName || user.email?.split("@")[0] || "Barbero",
    username: user.email?.split("@")[0] || "",
    role: claimRole,
    active: true
  };
}

function normalizeCharge(id, data = {}) {
  return {
    ...data,
    id,
    amount: Number(data.amount || data.monto || 0),
    method: /cash|efectivo/.test(String(data.method || data.metodo || "").toLowerCase()) ? "cash" : "digital",
    service: data.service || data.servicio || "Corte",
    detail: data.detail || data.detalle || "",
    proofUrl: data.proofUrl || data.comprobanteUrl || "",
    barberUid: data.barberUid || data.barberoUid || data.uid || "",
    barberName: data.barberName || data.barberoNombre || data.nombreBarbero || "Barbero"
  };
}

function normalizeAdvertisingReceipt(id, data = {}) {
  const receiptMethod = data.advertisingMethod || data.sourcePaymentMethod || data.method || "";
  const grossChargeAmount = Math.max(0, Number(data.grossChargeAmount || data.sourceGrossAmount || 0));
  const normalizedAmount = grossChargeAmount > 0 ? grossChargeAmount * 0.05 : Number(data.amount || 0);
  return {
    ...data,
    id,
    amount: normalizedAmount,
    rate: 0.05,
    barberUid: data.barberUid || data.barberoUid || data.uid || "",
    barberName: data.barberName || data.barberoNombre || "Barbero",
    method: /cash|efectivo/.test(String(receiptMethod).toLowerCase()) ? "cash" : "digital"
  };
}

function normalizeBarberSummary(id, data = {}) {
  const balance = normalizedBalance(Number(data.balance || 0));
  return {
    ...data,
    id,
    barberUid: data.barberUid || data.barberoUid || data.uid || id,
    barberName: data.barberName || data.barberoNombre || data.displayName || data.nombre || "Barbero",
    active: data.active !== false && data.activo !== false,
    balance,
    amount: Math.abs(balance)
  };
}

function normalizeClosure(id, data = {}) {
  return {
    ...data,
    id,
    settlementAmount: Number(data.settlementAmount || 0),
    cashTotal: Number(data.cashTotal || 0),
    digitalTotal: Number(data.digitalTotal || 0),
    advertisingFund: Number(data.advertisingFund || 0),
    totalBilled: Number(data.totalBilled || 0),
    barberUid: data.barberUid || data.barberoUid || data.uid || "",
    barberName: data.barberName || data.barberoNombre || "Barbero",
    status: String(data.status || "pending").toLowerCase()
  };
}

function unsubscribeAll(list) {
  list.splice(0).forEach(unsubscribe => {
    try { unsubscribe?.(); } catch (_) {}
  });
}

function listenOwned(collectionName, uid, normalizer, assign) {
  return onSnapshot(query(collection(db, collectionName), where("barberUid", "==", uid)), snapshot => {
    assign(snapshot.docs.map(item => normalizer(item.id, item.data())).sort((a, b) => timestampMs(b) - timestampMs(a)));
    renderBarberDashboard();
    if ($("syncStatus")) {
      $("syncStatus").textContent = "En tiempo real";
      $("syncStatus").className = "sync-status ok";
    }
  }, error => {
    console.error(`No se pudo sincronizar ${collectionName}`, error);
    if ($("syncStatus")) {
      $("syncStatus").textContent = "Error de conexión";
      $("syncStatus").className = "sync-status error";
    }
  });
}

function subscribeBarber(user) {
  unsubscribeAll(currentUnsubscribers);
  currentCharges = [];
  currentAdvertisingReceipts = [];
  currentClosures = [];
  currentUnsubscribers.push(listenOwned("cobros", user.uid, normalizeCharge, rows => { currentCharges = rows; }));
  currentUnsubscribers.push(listenOwned("caja_publicidad", user.uid, normalizeAdvertisingReceipt, rows => { currentAdvertisingReceipts = rows; }));
  currentUnsubscribers.push(listenOwned("cierres", user.uid, normalizeClosure, rows => { currentClosures = rows; }));
}

function subscribeTeamBarberBoard() {
  try { teamSummaryUnsubscribe?.(); } catch (_) {}
  teamBarberSummaries = [];
  teamSummaryUnsubscribe = onSnapshot(collection(db, "saldos_barberos"), snapshot => {
    teamBarberSummaries = snapshot.docs
      .map(item => normalizeBarberSummary(item.id, item.data()))
      .filter(item => item.active)
      .sort((a, b) => a.barberName.localeCompare(b.barberName, "es", { sensitivity: "base" }));
    renderTeamBarberBoard();
  }, error => {
    console.error("No se pudo sincronizar el tablero de barberos", error);
    if ($("teamBarberList")) $("teamBarberList").innerHTML = `<div class="empty-state">No se pudo cargar el tablero general.</div>`;
  });
}

function renderTeamBarberBoard() {
  const list = $("teamBarberList");
  if (!list) return;
  if (!teamBarberSummaries.length) {
    list.innerHTML = `<div class="empty-state">No hay barberos activos para mostrar.</div>`;
    return;
  }
  list.innerHTML = teamBarberSummaries.map(barber => {
    const presentation = settlementPresentation(barber.balance, barber.barberName, true);
    return `<article class="team-barber-row ${presentation.className}">
      <strong>${safeText(barber.barberName)}</strong>
      <div><span>${safeText(presentation.label)}</span><b>${formatMoney(barber.amount)}</b></div>
    </article>`;
  }).join("");
}

function mergeAdminBarbers() {
  const merged = new Map();
  for (const rows of adminProfileSources.values()) {
    for (const row of rows) {
      const uid = profileUid(row);
      if (!uid) continue;
      const previous = merged.get(uid) || {};
      merged.set(uid, { ...previous, ...row, id: uid, uid });
    }
  }
  adminBarbers = [...merged.values()]
    .filter(item => !profileIsAdmin(item))
    .sort((a, b) => profileName(a).localeCompare(profileName(b), "es", { sensitivity: "base" }));
}

function renderAllAdminViews() {
  mergeAdminBarbers();
  renderAdminDashboard();
  renderBarberOptions();
  renderAdminClosures();
  renderAdminHistory();
  maybeOpenPendingClosure();
}

function subscribeAdmin() {
  unsubscribeAll(adminUnsubscribers);
  adminProfileSources.clear();

  for (const collectionName of ["barberos", "usuarios"]) {
    const stop = onSnapshot(collection(db, collectionName), snapshot => {
      adminProfileSources.set(collectionName, snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
      renderAllAdminViews();
    }, error => console.warn(`No se pudo leer ${collectionName}`, error));
    adminUnsubscribers.push(stop);
  }

  const listen = (collectionName, normalizer, assign) => {
    const stop = onSnapshot(collection(db, collectionName), snapshot => {
      assign(snapshot.docs.map(item => normalizer(item.id, item.data())).sort((a, b) => timestampMs(b) - timestampMs(a)));
      renderAllAdminViews();
    }, error => console.error(`No se pudo leer ${collectionName}`, error));
    adminUnsubscribers.push(stop);
  };
  listen("cobros", normalizeCharge, rows => { adminCharges = rows; });
  listen("caja_publicidad", normalizeAdvertisingReceipt, rows => { adminAdvertisingReceipts = rows; });
  listen("cierres", normalizeClosure, rows => { adminClosures = rows; });
}

function advertisingReceiptsForOpenPeriod(receipts, closures) {
  const cutoff = modelForPeriod([], closures).cutoffAtMs;
  const open = receipts
    .filter(item => item.deleted !== true && timestampMs(item) > cutoff)
    .sort((a, b) => timestampMs(b) - timestampMs(a));
  const consolidated = new Map();
  for (const item of open) {
    const key = String(item.sourceChargeId || item.operationId || item.id);
    const method = /cash|efectivo/.test(String(item.sourcePaymentMethod || item.method || "").toLowerCase()) ? "cash" : "digital";
    const previous = consolidated.get(key);
    if (previous) {
      previous.amount += Number(item.amount || 0);
      continue;
    }
    consolidated.set(key, { ...item, method, advertisingMethod: method });
  }
  return [...consolidated.values()].sort((a, b) => timestampMs(b) - timestampMs(a));
}

function receiptCardHtml(item, type) {
  const methodLabel = item.method === "cash" ? "Efectivo" : "Digital";
  if (type === "advertising") {
    return `<article class="receipt advertising ${item.method}">
      <div class="receipt-top"><strong>Caja para publicidad · ${safeText(methodLabel)}</strong><b>${formatMoney(item.amount)}</b></div>
      <p>5% de este cobro reservado para publicidad</p>
      <div class="receipt-foot"><span>${safeText(formatDate(timestampMs(item)))}</span><em>${safeText(methodLabel)}</em></div>
    </article>`;
  }
  return `<article class="receipt ${item.method}">
    <div class="receipt-top"><strong>${safeText(methodLabel)} · ${safeText(item.service)}</strong><b>${formatMoney(item.amount)}</b></div>
    <p>${safeText(item.detail || `${methodLabel} · Corte registrado`)}</p>
    <div class="receipt-foot"><span>${safeText(formatDate(timestampMs(item)))}</span>${item.proofUrl ? `<a href="${safeText(item.proofUrl)}" target="_blank" rel="noopener">Ver archivo</a>` : ""}</div>
  </article>`;
}

function renderReceiptGroup(listId, items, type, emptyMessage) {
  const list = $(listId);
  if (!list) return;
  const visible = receiptsExpanded ? items : items.slice(0, MAX_VISIBLE_RECEIPTS);
  list.innerHTML = visible.length
    ? visible.map(item => receiptCardHtml(item, type)).join("")
    : `<div class="empty-state compact">${safeText(emptyMessage)}</div>`;
}

function renderBarberDashboard() {
  if (!currentProfile || profileIsAdmin()) return;
  const model = modelForPeriod(currentCharges, currentClosures);
  const openAdvertising = advertisingReceiptsForOpenPeriod(currentAdvertisingReceipts, currentClosures);
  const presentation = settlementPresentation(model.balance, profileName(currentProfile));

  $("advertisingFund").textContent = formatMoney(model.advertisingFund);
  $("cashTotal").textContent = formatMoney(model.cash);
  $("digitalTotal").textContent = formatMoney(model.digital);
    const cashAdvertisingFundEl = $("cashAdvertisingFund");
  if (cashAdvertisingFundEl) cashAdvertisingFundEl.textContent = formatMoney(model.cashAdvertising);
    const digitalAdvertisingFundEl = $("digitalAdvertisingFund");
  if (digitalAdvertisingFundEl) digitalAdvertisingFundEl.textContent = formatMoney(model.digitalAdvertising);
  $("settlementDirection").textContent = presentation.label;
  $("settlementAmount").textContent = formatMoney(model.amount);
  $("settlementHint").textContent = presentation.hint;
  $("settlementCard").classList.remove("barber-owes", "business-owes", "balanced");
  $("settlementCard").classList.add(presentation.className);

  const unifiedReceipts = [
    ...model.charges.map(item => ({ ...item, receiptType: "charge" })),
    ...openAdvertising.map(item => ({ ...item, receiptType: "advertising" }))
  ].sort((a, b) => timestampMs(b) - timestampMs(a));
  $("receiptCount").textContent = String(unifiedReceipts.length);
  const hasMore = unifiedReceipts.length > MAX_VISIBLE_RECEIPTS;
  $("receiptToggle").classList.toggle("hidden", !hasMore);
  $("receiptToggle").textContent = receiptsExpanded ? "Ver menos comprobantes" : "Ver más comprobantes";
  const visibleReceipts = receiptsExpanded ? unifiedReceipts : unifiedReceipts.slice(0, MAX_VISIBLE_RECEIPTS);
  const receiptList = $("receiptList");
  receiptList.innerHTML = visibleReceipts.length
    ? visibleReceipts.map(item => receiptCardHtml(item, item.receiptType)).join("")
    : `<div class="empty-state compact">Todavía no hay comprobantes en este período.</div>`;
}

function recordsForBarber(rows, barber) {
  const uid = profileUid(barber);
  return rows.filter(item => String(item.barberUid || "") === uid);
}

function modelForAdminBarber(barber) {
  return modelForPeriod(recordsForBarber(adminCharges, barber), recordsForBarber(adminClosures, barber));
}

function renderAdminDashboard() {
  if (!currentProfile || !profileIsAdmin()) return;
  const active = adminBarbers.filter(profileIsActive);
  if (!active.length) {
    $("adminBarberList").innerHTML = `<div class="empty-state">No hay barberos activos.</div>`;
  } else {
    $("adminBarberList").innerHTML = active.map(barber => {
      const model = modelForAdminBarber(barber);
      const presentation = settlementPresentation(model.balance, profileName(barber), true);
      return `<article class="admin-barber-row ${presentation.className}">
        <strong class="admin-barber-name">${safeText(profileName(barber))}</strong>
        <div class="admin-barber-balance"><span>${safeText(presentation.label)}</span><strong>${formatMoney(model.amount)}</strong></div>
      </article>`;
    }).join("");
  }

  const pendingCount = adminClosures.filter(item => item.status === "pending").length;
  $("pendingClosuresBadge").textContent = String(pendingCount);
  $("pendingClosuresBadge").classList.toggle("hidden", pendingCount === 0);
}

function renderBarberOptions() {
  const options = adminBarbers.map(barber => `<option value="${safeText(profileUid(barber))}">${safeText(profileName(barber))}${profileIsActive(barber) ? "" : " · inactivo"}</option>`).join("");
  for (const id of ["editBarberSelect", "historyBarberSelect"]) {
    const select = $(id);
    if (!select) continue;
    const previous = select.value;
    select.innerHTML = options || `<option value="">No hay barberos</option>`;
    if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
  }
  syncEditBarberForm();
}

function pendingClosures() {
  return adminClosures.filter(item => item.status === "pending").sort((a, b) => timestampMs(a) - timestampMs(b));
}

function renderAdminClosures() {
  const list = $("adminClosureList");
  if (!list) return;
  const pending = pendingClosures();
  if (!pending.length) {
    list.innerHTML = `<div class="empty-state compact">No hay cierres pendientes.</div>`;
    return;
  }
  list.innerHTML = pending.map(item => {
    const direction = item.direction === "barber_pays_business"
      ? `${item.barberName} paga a la barbería`
      : item.direction === "business_pays_barber"
        ? `La barbería paga a ${item.barberName}`
        : "Sin diferencia pendiente";
    return `<article class="closure-row">
      <div class="closure-row-head"><strong>${safeText(item.barberName)}</strong><b>${formatMoney(item.settlementAmount)}</b></div>
      <p>${safeText(direction)} · Efectivo ${formatMoney(item.cashTotal)} · Digital ${formatMoney(item.digitalTotal)} · Publicidad ${formatMoney(item.advertisingFund)}</p>
      <div class="closure-row-foot"><span>${safeText(formatDate(item.requestedAtMs || timestampMs(item)))}</span><button type="button" data-resolve-closure="${safeText(item.id)}">Resolver</button></div>
    </article>`;
  }).join("");
  list.querySelectorAll("[data-resolve-closure]").forEach(button => button.addEventListener("click", () => openResolveClosure(button.dataset.resolveClosure)));
}

function historyRowsForBarber(barber) {
  if (!barber) return [];
  const rows = [];
  recordsForBarber(adminCharges, barber).forEach(item => rows.push({
    kind: item.method === "cash" ? "Cobro efectivo" : "Cobro digital",
    title: item.service,
    detail: item.detail || "Corte registrado",
    amount: item.amount,
    proofUrl: item.proofUrl,
    createdAtMs: timestampMs(item),
    className: item.method
  }));
  recordsForBarber(adminAdvertisingReceipts, barber).forEach(item => rows.push({
    kind: "Caja para publicidad",
    title: item.advertisingMethod === "cash" || item.contributionFrom === "cash" ? "Comprobante efectivo · 5%" : "Comprobante digital · 5%",
    detail: "Fondo reservado a favor de la barbería",
    amount: item.amount,
    createdAtMs: timestampMs(item),
    className: "advertising"
  }));
  recordsForBarber(adminClosures, barber).forEach(item => rows.push({
    kind: "Cierre",
    title: item.status === "pending" ? "Cierre pendiente" : "Cierre completado",
    detail: `Efectivo ${formatMoney(item.cashTotal)} · Digital ${formatMoney(item.digitalTotal)}`,
    amount: item.settlementAmount,
    proofUrl: item.adminProofUrl || item.barberProofUrl || "",
    createdAtMs: item.requestedAtMs || timestampMs(item),
    className: "closure"
  }));
  return rows.sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 120);
}

function renderAdminHistory() {
  const select = $("historyBarberSelect");
  const list = $("historyList");
  if (!select || !list) return;
  const barber = adminBarbers.find(item => profileUid(item) === select.value);
  if (!barber) {
    list.innerHTML = `<div class="empty-state compact">Seleccioná un barbero.</div>`;
    return;
  }
  const rows = historyRowsForBarber(barber);
  if (!rows.length) {
    list.innerHTML = `<div class="empty-state compact">Todavía no hay movimientos para ${safeText(profileName(barber))}.</div>`;
    return;
  }
  list.innerHTML = rows.map(item => `<article class="history-row ${safeText(item.className)}">
    <div class="history-row-head"><strong>${safeText(item.kind)}</strong><b>${formatMoney(item.amount)}</b></div>
    <p><b>${safeText(item.title)}</b><br>${safeText(item.detail || "")}</p>
    <div class="history-row-foot"><span>${safeText(formatDate(item.createdAtMs))}</span>${item.proofUrl ? `<a href="${safeText(item.proofUrl)}" target="_blank" rel="noopener">Ver archivo</a>` : ""}</div>
  </article>`).join("");
}

function applyRoleUI() {
  const admin = profileIsAdmin();
  $("adminDashboard").classList.toggle("hidden", !admin);
  $("barberDashboard").classList.toggle("hidden", admin);
  $("logoutButton").classList.toggle("hidden", admin);
  $("operatorGreeting").textContent = `Hola ${profileName(currentProfile)}`;
}

function resetState() {
  unsubscribeAll(currentUnsubscribers);
  unsubscribeAll(adminUnsubscribers);
  try { teamSummaryUnsubscribe?.(); } catch (_) {}
  teamSummaryUnsubscribe = null;
  currentProfile = null;
  currentCharges = [];
  currentAdvertisingReceipts = [];
  currentClosures = [];
  adminBarbers = [];
  adminCharges = [];
  adminAdvertisingReceipts = [];
  adminClosures = [];
  teamBarberSummaries = [];
  adminProfileSources.clear();
}

function showAuthenticatedApp() {
  $("loginScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");
  applyRoleUI();
  syncPublicBarberBoard().catch(error => console.warn("No se pudo actualizar el tablero público", error));
  if (profileIsAdmin()) {
    subscribeAdmin();
  } else {
    subscribeTeamBarberBoard();
    subscribeBarber(auth.currentUser);
  }
}

async function uploadProof(file, storagePath) {
  if (!file) return { url: "", path: "", contentType: "", fileName: "" };
  const safeName = String(file.name || "comprobante").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
  const path = `${storagePath}/${Date.now()}_${safeName}`;
  const fileRef = ref(storage, path);
  const contentType = file.type || "application/octet-stream";
  await uploadBytes(fileRef, file, { contentType });
  return { url: await getDownloadURL(fileRef), path, contentType, fileName: safeName };
}

function renderServiceOptions() {
  $("serviceGrid").innerHTML = SERVICES.map(service => `<button class="service-option" type="button" data-service-id="${service.id}"><strong>${safeText(service.name)}</strong><span>${formatMoney(service.price)}</span></button>`).join("");
  $("serviceGrid").querySelectorAll("[data-service-id]").forEach(button => {
    button.addEventListener("click", () => {
      const service = SERVICES.find(item => item.id === button.dataset.serviceId);
      if (!service) return;
      $("selectedService").value = service.id;
      setMoneyInput($("chargeAmount"), service.price);
      $("serviceGrid").querySelectorAll(".service-option").forEach(item => item.classList.toggle("selected", item === button));
    });
  });
}

function setMoneyInput(input, value) {
  input.value = Number(value || 0) > 0 ? new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(Number(value)) : "";
}

function selectedServiceDefinition() {
  return SERVICES.find(item => item.id === $("selectedService").value) || null;
}

function selectedChargeProof() {
  return $("chargeCameraProof").files?.[0] || $("chargeProof").files?.[0] || null;
}

function updateChargeProofSelection(selectedInput = null) {
  const cameraInput = $("chargeCameraProof");
  const galleryInput = $("chargeProof");
  if (selectedInput === cameraInput && cameraInput.files?.[0]) galleryInput.value = "";
  if (selectedInput === galleryInput && galleryInput.files?.[0]) cameraInput.value = "";
  const proof = selectedChargeProof();
  $("chargeProofName").textContent = proof
    ? `Comprobante seleccionado: ${proof.name || "foto tomada"}`
    : "Todavía no seleccionaste un comprobante.";
}

function openChargeModal(mode) {
  $("chargeForm").reset();
  updateChargeProofSelection();
  $("selectedService").value = "";
  $("chargeMode").value = mode;
  $("chargeModal").dataset.mode = mode;
  $("chargeModalTitle").textContent = mode === "cash" ? "Cobrar efectivo" : "Cobrar digital";
  $("chargeModeKicker").textContent = mode === "cash" ? "EFECTIVO · EN MANOS DEL BARBERO" : "DIGITAL · CUENTA DE LA BARBERÍA";
  $("digitalProofField").classList.toggle("hidden", mode !== "digital");
  $("serviceGrid").querySelectorAll(".service-option").forEach(item => item.classList.remove("selected"));
  statusMessage("chargeStatus");
  showModal("chargeModal");
}

function openChargePreview() {
  const service = selectedServiceDefinition();
  const amount = numberFromMoney($("chargeAmount").value);
  const mode = $("chargeMode").value;
  const proof = selectedChargeProof();
  if (!service) return statusMessage("chargeStatus", "Seleccioná un servicio.", "error");
  if (!(amount > 0)) return statusMessage("chargeStatus", "Ingresá un importe válido.", "error");
  if (mode === "digital" && !proof) return statusMessage("chargeStatus", "El cobro digital necesita comprobante.", "error");

  const model = modelForPeriod(currentCharges, currentClosures);
  const impact = impactForCharge(mode, amount);
  const afterBalance = normalizedBalance(model.balance + impact);
  const beforePresentation = settlementPresentation(model.balance, profileName(currentProfile));
  const afterPresentation = settlementPresentation(afterBalance, profileName(currentProfile));
  const operationId = randomId("cobro");
  pendingCharge = {
    operationId,
    mode,
    amount,
    service,
    detail: $("chargeDetail").value.trim(),
    proof,
    beforeBalance: model.balance,
    afterBalance,
    impact
  };

  $("previewChargeAmount").textContent = formatMoney(amount);
  $("previewAdvertisingAmount").textContent = `${formatMoney(amount * 0.05)} · ${mode === "cash" ? "Efectivo" : "Digital"}`;
  $("previewImpactAmount").textContent = `${impact >= 0 ? "+" : "−"}${formatMoney(Math.abs(impact))}`;
  $("previewBeforeLabel").textContent = beforePresentation.label;
  $("previewBeforeAmount").textContent = formatMoney(Math.abs(model.balance));
  $("previewAfterLabel").textContent = afterPresentation.label;
  $("previewAfterAmount").textContent = formatMoney(Math.abs(afterBalance));
  statusMessage("previewStatus");
  hideModal("chargeModal");
  showModal("previewModal");
}

async function savePendingCharge() {
  if (!pendingCharge || chargeSubmitting) return;
  chargeSubmitting = true;
  $("confirmChargeButton").disabled = true;
  $("confirmChargeButton").textContent = "Guardando…";
  statusMessage("previewStatus", "Registrando el cobro y su publicidad…");
  const item = pendingCharge;
  try {
    const uid = auth.currentUser.uid;
    const proof = await uploadProof(item.proof, `cobros/${uid}/${item.operationId}`);
    const createdAtMs = Date.now();
    const chargeRef = doc(db, "cobros", item.operationId);
    const advertisingRef = doc(db, "caja_publicidad", `${item.operationId}_${item.mode}`);
    const base = {
      businessId: BUSINESS_ID,
      barberUid: uid,
      barberoUid: uid,
      barberName: profileName(currentProfile),
      barberoNombre: profileName(currentProfile),
      method: item.mode,
      paymentMethod: item.mode,
      operationId: item.operationId,
      createdAt: serverTimestamp(),
      createdAtMs,
      status: "active"
    };
    const batch = writeBatch(db);
    batch.set(chargeRef, {
      ...base,
      amount: item.amount,
      monto: item.amount,
      service: item.service.name,
      serviceId: item.service.id,
      detail: item.detail,
      proofUrl: proof.url,
      proofPath: proof.path,
      proofContentType: proof.contentType,
      proofFileName: proof.fileName,
      barberShareAmount: item.amount * 0.475,
      businessShareAmount: item.amount * 0.475,
      advertisingAmount: item.amount * 0.05,
      advertisingReceiptAmount: item.amount * 0.05,
      balanceBefore: item.beforeBalance,
      balanceImpact: item.impact,
      balanceAfter: item.afterBalance,
      cashHeldByBarber: item.mode === "cash",
      digitalHeldByBusiness: item.mode === "digital",
      telegramReady: true,
      telegramEventType: "barber_charge_created",
      telegramPayloadVersion: 1
    });
    batch.set(advertisingRef, {
      ...base,
      sourceChargeId: item.operationId,
      sourcePaymentMethod: item.mode,
      amount: item.amount * 0.05,
      grossChargeAmount: item.amount,
      rate: 0.05,
      contributionFrom: item.mode,
      advertisingMethod: item.mode,
      label: `Caja para publicidad · ${item.mode === "cash" ? "Efectivo" : "Digital"} 5%`,
      beneficiary: "barberia",
      destination: "barberia_account",
      internalReceipt: true
    });
    await batch.commit();
    pendingCharge = null;
    hideModal("previewModal");
    showToast("Cobro registrado", `Comprobante ${item.mode === "cash" ? "en efectivo" : "digital"} y publicidad del 5% guardados.`);
    scrollToTop();
  } catch (error) {
    console.error(error);
    statusMessage("previewStatus", error?.message || "No se pudo registrar el cobro.", "error");
  } finally {
    chargeSubmitting = false;
    $("confirmChargeButton").disabled = false;
    $("confirmChargeButton").textContent = "Confirmar cobro";
  }
}

function closureSummaryHtml(model, barberName = profileName(currentProfile)) {
  const presentation = settlementPresentation(model.balance, barberName);
  const cashAdvertising = Number(model.cashAdvertising ?? model.advertisingCashReceipt ?? (Number(model.cash || 0) * 0.05));
  const digitalAdvertising = Number(model.digitalAdvertising ?? model.advertisingDigitalReceipt ?? (Number(model.digital || 0) * 0.05));
  return `<div class="closure-direction"><span>${safeText(presentation.label)}</span><strong>${formatMoney(model.amount)}</strong></div>
    <div class="closure-figures">
      <div><span>Total facturado</span><strong>${formatMoney(model.total)}</strong></div>
      <div><span>Publicidad efectivo 5%</span><strong>${formatMoney(cashAdvertising)}</strong></div>
      <div><span>Publicidad digital 5%</span><strong>${formatMoney(digitalAdvertising)}</strong></div>
      <div><span>Caja publicidad total</span><strong>${formatMoney(model.advertisingFund)}</strong></div>
      <div><span>Efectivo</span><strong>${formatMoney(model.cash)}</strong></div>
      <div><span>Digital</span><strong>${formatMoney(model.digital)}</strong></div>
      <div><span>Barbero 47,5%</span><strong>${formatMoney(model.barberShare)}</strong></div>
      <div><span>Barbería 47,5%</span><strong>${formatMoney(model.businessShare)}</strong></div>
    </div>`;
}

function openClosureModal() {
  const model = modelForPeriod(currentCharges, currentClosures);
  if (!(model.total > 0)) {
    showToast("Sin cobros para cerrar", "El período ya está en cero.");
    return;
  }
  $("closureForm").reset();
  $("closureSummary").innerHTML = closureSummaryHtml(model);
  $("barberPaymentProofField").classList.toggle("hidden", model.direction !== "barber_pays_business");
  $("barberBankFields").classList.toggle("hidden", model.direction !== "business_pays_barber");
  $("barberAlias").required = model.direction === "business_pays_barber";
  $("barberCuit").required = model.direction === "business_pays_barber";
  statusMessage("closureStatus");
  showModal("closureModal");
}

async function createClosure() {
  if (closureSubmitting) return;
  const model = modelForPeriod(currentCharges, currentClosures);
  if (!(model.total > 0)) return statusMessage("closureStatus", "El período ya fue cerrado.", "error");
  if (model.direction === "business_pays_barber" && (!$("barberAlias").value.trim() || !$("barberCuit").value.trim())) {
    return statusMessage("closureStatus", "Completá alias y CUIT para recibir el pago.", "error");
  }
  closureSubmitting = true;
  $("confirmClosureButton").disabled = true;
  $("confirmClosureButton").textContent = "Cerrando…";
  statusMessage("closureStatus", "Guardando el cierre y reiniciando el período…");
  try {
    const uid = auth.currentUser.uid;
    const closureId = randomId("cierre");
    const requestedAtMs = Date.now();
    const proofFile = $("barberClosureProof").files?.[0] || null;
    const proof = await uploadProof(proofFile, `cierres/${uid}/${closureId}/barbero`);
    const payload = {
      businessId: BUSINESS_ID,
      barberUid: uid,
      barberoUid: uid,
      barberName: profileName(currentProfile),
      barberoNombre: profileName(currentProfile),
      status: "pending",
      direction: model.direction,
      settlementAmount: model.amount,
      balanceSnapshot: model.balance,
      cashTotal: model.cash,
      digitalTotal: model.digital,
      totalBilled: model.total,
      advertisingFund: model.advertisingFund,
      advertisingCashReceipt: model.cashAdvertising,
      advertisingDigitalReceipt: model.digitalAdvertising,
      barberShare: model.barberShare,
      businessShare: model.businessShare,
      periodStartAtMs: model.cutoffAtMs,
      cutoffAtMs: requestedAtMs,
      cutoffActive: true,
      requestedAt: serverTimestamp(),
      requestedAtMs,
      barberProofUrl: proof.url,
      barberProofPath: proof.path,
      paymentAlias: $("barberAlias").value.trim(),
      paymentCuit: $("barberCuit").value.trim(),
      resetAppliedImmediately: true,
      telegramReady: true,
      telegramEventType: "barber_closure_requested",
      telegramPayloadVersion: 1
    };
    await setDoc(doc(db, "cierres", closureId), payload);
    currentClosures = [normalizeClosure(closureId, payload), ...currentClosures];
    renderBarberDashboard();
    hideModal("closureModal");
    showToast("Cierre solicitado", "El período volvió a cero y el pedido quedó pendiente para el administrador.");
    scrollToTop();
  } catch (error) {
    console.error(error);
    statusMessage("closureStatus", error?.message || "No se pudo pedir el cierre.", "error");
  } finally {
    closureSubmitting = false;
    $("confirmClosureButton").disabled = false;
    $("confirmClosureButton").textContent = "Confirmar cierre";
  }
}

function setManagerMode(mode) {
  managerMode = mode === "edit" ? "edit" : "create";
  $("barberManagerMode").value = managerMode;
  $("createBarberFields").classList.toggle("hidden", managerMode !== "create");
  $("editBarberFields").classList.toggle("hidden", managerMode !== "edit");
  document.querySelectorAll("[data-manager-mode]").forEach(button => button.classList.toggle("selected", button.dataset.managerMode === managerMode));
  $("saveBarberButton").textContent = managerMode === "create" ? "Crear barbero" : "Guardar cambios";
  statusMessage("barberManagerStatus");
  syncEditBarberForm();
}

function syncEditBarberForm() {
  const barber = adminBarbers.find(item => profileUid(item) === $("editBarberSelect")?.value);
  if (!barber) return;
  $("editBarberName").value = profileName(barber);
  $("editBarberActive").checked = profileIsActive(barber);
  $("editBarberPassword").value = "";
}

function callableError(error) {
  const message = String(error?.message || "").replace(/^FirebaseError:\s*/i, "");
  if (/permission-denied/.test(String(error?.code || ""))) return "Tu usuario no tiene permiso de administrador en Firebase.";
  return message || "No se pudo completar la operación.";
}

async function saveBarberManager() {
  $("saveBarberButton").disabled = true;
  $("saveBarberButton").textContent = "Guardando…";
  statusMessage("barberManagerStatus", "Actualizando acceso…");
  try {
    if (managerMode === "create") {
      const name = $("newBarberName").value.trim();
      const username = cleanUsername($("newBarberUsername").value);
      const password = $("newBarberPassword").value;
      if (!name || !username || password.length < 6) throw new Error("Completá nombre, usuario y una clave de al menos 6 caracteres.");
      await adminCreateBarber({ name, username, password });
      $("barberManagerForm").reset();
      showToast("Barbero creado", `${name} ya puede ingresar con su usuario.`);
    } else {
      const barberUid = $("editBarberSelect").value;
      const name = $("editBarberName").value.trim();
      const password = $("editBarberPassword").value;
      if (!barberUid || !name) throw new Error("Seleccioná un barbero y completá el nombre.");
      await adminUpdateBarber({ barberUid, name, password, active: $("editBarberActive").checked });
      showToast("Barbero actualizado", "Los cambios quedaron guardados.");
    }
    hideModal("barberManagerModal");
  } catch (error) {
    console.error(error);
    statusMessage("barberManagerStatus", callableError(error), "error");
  } finally {
    $("saveBarberButton").disabled = false;
    $("saveBarberButton").textContent = managerMode === "create" ? "Crear barbero" : "Guardar cambios";
  }
}

function openResolveClosure(id) {
  const item = adminClosures.find(closure => closure.id === id);
  if (!item) return;
  selectedAdminClosureId = id;
  $("resolveClosureId").value = id;
  $("resolveClosureSummary").innerHTML = closureSummaryHtml({
    balance: item.balanceSnapshot,
    amount: item.settlementAmount,
    cash: item.cashTotal,
    digital: item.digitalTotal,
    total: item.totalBilled,
    advertisingFund: item.advertisingFund,
    advertisingCashReceipt: item.advertisingCashReceipt,
    advertisingDigitalReceipt: item.advertisingDigitalReceipt,
    barberShare: item.barberShare,
    businessShare: item.businessShare
  }, item.barberName);
  $("adminClosureProofField").classList.toggle("hidden", item.direction !== "business_pays_barber");
  $("adminClosureProof").required = item.direction === "business_pays_barber";
  $("completeClosureButton").textContent = item.direction === "barber_pays_business" ? "Confirmar dinero recibido" : item.direction === "business_pays_barber" ? "Registrar pago" : "Completar cierre";
  $("adminClosureList").classList.add("hidden");
  $("resolveClosureForm").classList.remove("hidden");
  statusMessage("resolveClosureStatus");
}

function closeResolveClosure() {
  selectedAdminClosureId = "";
  $("resolveClosureForm").reset();
  $("resolveClosureForm").classList.add("hidden");
  $("adminClosureList").classList.remove("hidden");
}

async function completeAdminClosure() {
  const item = adminClosures.find(closure => closure.id === selectedAdminClosureId);
  if (!item) return;
  const proofFile = $("adminClosureProof").files?.[0] || null;
  if (item.direction === "business_pays_barber" && !proofFile) {
    return statusMessage("resolveClosureStatus", "Adjuntá el comprobante del pago.", "error");
  }
  $("completeClosureButton").disabled = true;
  $("completeClosureButton").textContent = "Guardando…";
  try {
    const proof = await uploadProof(proofFile, `cierres/${item.barberUid}/${item.id}/administrador`);
    await updateDoc(doc(db, "cierres", item.id), {
      status: "completed",
      completedAt: serverTimestamp(),
      completedAtMs: Date.now(),
      completedByUid: auth.currentUser.uid,
      completedByName: profileName(currentProfile),
      adminProofUrl: proof.url,
      adminProofPath: proof.path,
      telegramUpdateReady: true,
      telegramUpdateEventType: "barber_closure_completed"
    });
    closeResolveClosure();
    showToast("Cierre completado", "El cierre quedó resuelto sin afectar los cobros del nuevo período.");
  } catch (error) {
    console.error(error);
    statusMessage("resolveClosureStatus", error?.message || "No se pudo completar el cierre.", "error");
  } finally {
    $("completeClosureButton").disabled = false;
  }
}

function maybeOpenPendingClosure() {
  if (!currentProfile || !profileIsAdmin() || !$("adminClosuresModal").classList.contains("hidden")) return;
  const candidate = pendingClosures().find(item => !dismissedPendingClosures.has(item.id));
  if (!candidate) return;
  dismissedPendingClosures.add(candidate.id);
  renderAdminClosures();
  showModal("adminClosuresModal");
}

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("loginButton").disabled = true;
  $("loginButton").textContent = "Ingresando…";
  statusMessage("loginStatus", "Verificando acceso…");
  try {
    await signInFromForm($("loginUser").value, $("loginPassword").value);
  } catch (error) {
    statusMessage("loginStatus", loginError(error), "error");
  } finally {
    $("loginButton").disabled = false;
    $("loginButton").textContent = "Ingresar";
  }
});

$("togglePassword").addEventListener("click", () => {
  const visible = $("loginPassword").type === "text";
  $("loginPassword").type = visible ? "password" : "text";
  $("togglePassword").textContent = visible ? "Ver" : "Ocultar";
});

async function logout() {
  await signOut(auth).catch(() => {});
}

$("logoutButton").addEventListener("click", logout);
$("adminLogoutButton").addEventListener("click", logout);
document.querySelectorAll("[data-close-modal]").forEach(button => button.addEventListener("click", () => hideModal(button.dataset.closeModal)));
document.querySelectorAll("[data-charge-mode]").forEach(button => button.addEventListener("click", () => openChargeModal(button.dataset.chargeMode)));
$("chargeAmount").addEventListener("input", event => {
  const digits = String(event.target.value || "").replace(/\D/g, "");
  event.target.value = digits ? new Intl.NumberFormat("es-AR").format(Number(digits)) : "";
});
$("chargeCameraProof").addEventListener("change", event => updateChargeProofSelection(event.currentTarget));
$("chargeProof").addEventListener("change", event => updateChargeProofSelection(event.currentTarget));
$("chargeForm").addEventListener("submit", event => { event.preventDefault(); openChargePreview(); });
$("backToChargeButton").addEventListener("click", () => { hideModal("previewModal"); showModal("chargeModal"); });
$("confirmChargeButton").addEventListener("click", savePendingCharge);
$("receiptToggle").addEventListener("click", () => { receiptsExpanded = !receiptsExpanded; renderBarberDashboard(); });
$("requestClosureButton").addEventListener("click", openClosureModal);
$("closureForm").addEventListener("submit", event => { event.preventDefault(); createClosure(); });
$("adminBarbersButton").addEventListener("click", () => { $("barberManagerForm").reset(); setManagerMode("create"); showModal("barberManagerModal"); });
document.querySelectorAll("[data-manager-mode]").forEach(button => button.addEventListener("click", () => setManagerMode(button.dataset.managerMode)));
$("editBarberSelect").addEventListener("change", syncEditBarberForm);
$("barberManagerForm").addEventListener("submit", event => { event.preventDefault(); saveBarberManager(); });
$("adminClosuresButton").addEventListener("click", () => { closeResolveClosure(); renderAdminClosures(); showModal("adminClosuresModal"); });
$("cancelResolveClosure").addEventListener("click", closeResolveClosure);
$("resolveClosureForm").addEventListener("submit", event => { event.preventDefault(); completeAdminClosure(); });
$("adminHistoryButton").addEventListener("click", () => { renderBarberOptions(); renderAdminHistory(); showModal("historyModal"); });
$("historyBarberSelect").addEventListener("change", renderAdminHistory);

renderServiceOptions();

onAuthStateChanged(auth, async user => {
  if (!user) {
    resetState();
    $("appScreen").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
    $("splashScreen").classList.add("hidden");
    return;
  }
  try {
    currentProfile = await loadProfile(user);
    if (!profileIsActive(currentProfile)) throw new Error("Tu usuario está inactivo. Consultá al administrador.");
    showAuthenticatedApp();
    statusMessage("loginStatus");
  } catch (error) {
    await signOut(auth).catch(() => {});
    statusMessage("loginStatus", error?.message || "No se pudo cargar el perfil.", "error");
  } finally {
    setTimeout(() => $("splashScreen")?.classList.add("hidden"), 350);
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(error => console.warn("Service worker", error)));
}
