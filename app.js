import * as firebaseSettings from "./firebase-config.js?v=20260824-15";

const { firebaseConfig, BUSINESS_ID, USER_EMAIL_DOMAIN } = firebaseSettings;
const LOGIN_ALIASES = firebaseSettings.LOGIN_ALIASES || {};

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore, collection, addDoc, doc, getDoc, getDocs, setDoc,
  onSnapshot, serverTimestamp, query, where, limit, writeBatch, runTransaction
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
const storage = getStorage(app);
const authReady = setPersistence(auth, browserLocalPersistence)
  .catch(() => setPersistence(auth, browserSessionPersistence))
  .catch(() => setPersistence(auth, inMemoryPersistence))
  .catch(err => console.warn("No se pudo guardar la persistencia de sesión:", err));
const AUTH_READY_TIMEOUT_MS = 2500;

const $ = id => document.getElementById(id);
const SPLASH_MIN_VISIBLE_MS = 900;
let splashStartedAt = Date.now();
let splashProgress = 4;
let splashTimer = null;
let splashTransition = 0;
let unsubscribePayments = null;
let unsubscribeExpenses = null;
let unsubscribeUber = null;
let unsubscribeClosures = null;
let unsubscribeDebts = null;
let unsubscribeDebtPayments = null;
let unsubscribeAdvances = null;
let payments = [];
let expenses = [];
let uberClosures = [];
let closures = [];
let debts = [];
let debtPayments = [];
let advances = [];
let advancesLoaded = false;
let currentProfile = null;
// Históricos de Santander pueden usar aliases anteriores a driverUid.
// Se cargan una vez y se fusionan con el listener canónico en tiempo real.
const legacyOwnedCache = new Map();
const canonicalOwnedCache = new Map();
const OWNERSHIP_FIELDS = [
  "driverUid", "choferUid", "uid", "ownerUid", "driverId", "choferId",
  "driver_id", "chofer_id", "userUid", "userId", "createdByUid", "ownerId",
  "conductorUid", "conductorId", "assignedDriverUid", "enteredOnBehalfOf", "simulationDriverUid"
];
let selectedCloseDirection = "";
let selectedAdminClosureId = "";
const RECENT_RECEIPTS_LIMIT = 6;
// Primera semana administrada por este selector. Desde aquí, toda semana
// cerrada sin comprobante permanece pendiente hasta que el chofer la cargue.
const UBER_TRACKING_START_DATE = "2026-08-24";
const ADVANCE_MAX_AMOUNT = 400000;
const ADVANCE_INTEREST_RATE = 0.40;
const ADVANCE_DIFFERENCE_LIMIT = 50000;
const EXPLORA_ADMIN_UIDS = new Set(["2LziyTTdFcZzSOhK3hLbAKs2U4s2"]);
const ROOT_COLLECTIONS = Object.freeze({
  payments: "billing_records",
  expenses: "gastos",
  uber: "uber_weekly_closures",
  closures: "cierres_semanales",
  debts: "deudas_choferes",
  debtPayments: "deuda_pagos",
  advances: "prestamos_operativos"
});

function profileRole(profile = {}, user = auth.currentUser) {
  if (user?.uid && EXPLORA_ADMIN_UIDS.has(user.uid)) return "admin";
  const raw = String(profile.role || profile.rol || profile.tipoUsuario || profile.tipo || "chofer").trim().toLowerCase();
  return ["admin", "administrador", "owner", "superadmin"].includes(raw) ? "admin" : "barber";
}

function moneyNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").replace(/\s/g, "");
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9,.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "," || cleaned === ".") return 0;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(/,/g, ".") : cleaned.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const tail = cleaned.slice(lastDot + 1);
    normalized = tail.length === 3 ? cleaned.replace(/\./g, "") : cleaned;
  } else if (lastComma >= 0) {
    const tail = cleaned.slice(lastComma + 1);
    normalized = tail.length === 3 ? cleaned.replace(/,/g, "") : cleaned.replace(/,/g, ".");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordAmount(item = {}) {
  for (const value of [item.amount, item.monto, item.valor, item.finalPrice, item.totalAmount, item.total, item.importe,
    item.price, item.precio, item.precioFinal, item.montoFinal, item.montoCobrado, item.importeTotal,
    item.finalAmount, item.billingAmount, item.chargedAmount, item.paidAmount, item.fare, item.tarifa,
    item.value, item.totalCobrado, item.facturacion, item.billingTotal]) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = moneyNumber(value);
    if (parsed >= 0) return parsed;
  }
  return 0;
}

function recordTimestampMs(item = {}) {
  const candidates = [item.createdAt, item.completedAt, item.updatedAt, item.expenseDate, item.receiptUploadedAt];
  for (const value of candidates) {
    if (!value) continue;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.toDate === "function") return value.toDate().getTime();
    if (value instanceof Date) return value.getTime();
  }
  for (const value of [item.createdAtMs, item.completedAtMs, item.updatedAtMs, item.timestampMs]) {
    const parsed = Number(value || 0);
    if (parsed > 0) return parsed;
  }
  for (const value of [item.fechaISO, item.date, item.fecha]) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function recordDayKey(item = {}) {
  if (item.dayKey) return String(item.dayKey);
  const ms = recordTimestampMs(item);
  return ms ? localDayKey(new Date(ms)) : "";
}

function recordProofUrl(item = {}) {
  return String(item.proofUrl || item.receiptUrl || item.downloadURL || item.comprobanteUrl || item.notificationPhotoUrl || "");
}

function recordProofPath(item = {}) {
  return String(item.proofPath || item.receiptPath || item.storagePath || item.fullPath || item.comprobantePath || "");
}

function normalizePaymentRecord(id, item = {}) {
  const rawMethod = String(item.method || item.paymentMethod || item.metodoPago || item.financialCategory || "").toLowerCase();
  const method = /cash|efectivo/.test(rawMethod) ? "cash" : "digital";
  const originalType = String(item.type || item.operationType || "");
  const sourceModule = String(item.sourceModule || item.category || item.module || "").toLowerCase();
  let adjustmentDirection = String(item.adjustmentDirection || item.settlementDirection || item.paymentDirection || "").toLowerCase();
  if (["driver_pays_explora", "chofer_a_explora", "chofer_a_david"].includes(adjustmentDirection)) adjustmentDirection = "driver_to_explora";
  if (["explora_pays_driver", "explora_a_chofer", "david_a_chofer"].includes(adjustmentDirection)) adjustmentDirection = "explora_to_driver";
  const isLegacyBillingSettlement = item.affectsBillingSettlement === true ||
    originalType.toLowerCase() === "admin_billing_settlement_payment" ||
    (String(item.operationType || item.movementType || "").toLowerCase() === "driver_payment" && /factur|billing/.test(sourceModule));
  if (isLegacyBillingSettlement && !adjustmentDirection) adjustmentDirection = "driver_to_explora";
  let type = originalType;
  // No convertir las compensaciones de gastos: también son internas, pero tienen
  // una lógica propia distinta de un pago de cierre.
  if (adjustmentDirection || isLegacyBillingSettlement) type = "settlement_adjustment";
  return {
    ...item,
    id,
    amount: recordAmount(item),
    method,
    type,
    adjustmentDirection,
    service: item.service || item.serviceDescription || item.categoryLabel || (method === "cash" ? "Cobro en efectivo" : "Cobro digital"),
    detail: item.detail || item.notes || item.detalle || item.descripcion || "Servicio registrado",
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey: recordDayKey(item),
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || "",
    operatorName: item.operatorName || item.driverName || item.choferNombre || item.nombreChofer || ""
  };
}

function normalizeExpenseRecord(id, item = {}) {
  return {
    ...item,
    id,
    amount: recordAmount(item),
    detail: item.detail || item.notes || item.detalle || item.descripcion || item.expenseType || item.tipo || "Gasto",
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey: recordDayKey(item),
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || item.ownerUid || "",
    operatorName: item.operatorName || item.driverName || item.choferNombre || ""
  };
}

function normalizeUberRecord(id, item = {}) {
  const dayKey = recordDayKey(item);
  const weekCloseDate = item.weekCloseDate || (item.weekDisplayEndMs ? localDayKey(new Date(Number(item.weekDisplayEndMs))) : dayKey);
  return {
    ...item,
    id,
    amount: recordAmount({ amount: item.grossAmount ?? item.totalAmount ?? item.amount ?? item.monto }),
    weekKey: item.weekKey || item.weekId || id,
    weekLabel: item.weekLabel || item.weekId || id,
    weekStartDate: item.weekStartDate || (item.weekStartMs ? localDayKey(new Date(Number(item.weekStartMs))) : ""),
    weekCloseDate,
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey,
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || "",
    operatorName: item.operatorName || item.driverName || item.choferNombre || ""
  };
}

function normalizeDebtRecord(id, item = {}) {
  const remaining = Number(item.remainingAmount ?? item.saldoPendiente ?? item.amount ?? item.totalAmount ?? 0);
  const status = String(item.status || item.debtStatus || item.estado || "active").toLowerCase();
  return {
    ...item,
    id,
    amount: /paid|pagad|closed|cerrad|cancel/.test(status) ? 0 : Math.max(0, Number.isFinite(remaining) ? remaining : 0),
    detail: item.detail || item.reason || item.notes || item.descripcion || "Deuda",
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey: recordDayKey(item),
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || ""
  };
}

function normalizeDebtPaymentRecord(id, item = {}) {
  const rawMethod = String(item.paymentMethod || item.method || item.paymentChannel || "").toLowerCase();
  const usesExpenses = item.expenseOffset === true || item.usedExpenseBalance === true ||
    rawMethod === "expense_offset" || /expense.*offset|gasto.*deuda|deuda.*gasto/.test(rawMethod) ||
    String(item.type || item.operationType || "").toLowerCase() === "debt_expense_offset";
  return {
    ...item,
    id,
    amount: recordAmount(item),
    expenseOffset: usesExpenses,
    dayKey: recordDayKey(item),
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || item.ownerUid || ""
  };
}

function normalizeClosureRecord(id, item = {}) {
  let direction = String(item.direction || item.paymentDirection || "");
  if (["driver_to_explora", "chofer_a_david", "chofer_a_explora"].includes(direction)) direction = "driver_pays_explora";
  if (["explora_to_driver", "david_a_chofer", "explora_a_chofer"].includes(direction)) direction = "explora_pays_driver";
  if (!direction) {
    if (Number(item.amountDueFromDriver || item.amountFromDriver || 0) > 0) direction = "driver_pays_explora";
    else if (Number(item.amountDueToDriver || item.amountToDriver || 0) > 0) direction = "explora_pays_driver";
  }
  const settlementAmount = Number(item.settlementAmount ?? item.requestedAmount ?? item.amountDueFromDriver ?? item.amountFromDriver ?? item.amountDueToDriver ?? item.amountToDriver ?? 0) || 0;
  const paidAmountTotal = Number(item.paidAmountTotal ?? item.amountPaid ?? item.billingSettlementPaymentTotal ?? 0) || 0;
  return {
    ...item,
    id,
    direction,
    settlementAmount,
    requestedAmount: Number(item.requestedAmount ?? settlementAmount) || settlementAmount,
    paidAmountTotal,
    remainingAmount: Number(item.remainingAmount ?? Math.max(0, settlementAmount - paidAmountTotal)) || 0,
    operatorUid: item.operatorUid || item.driverUid || item.choferUid || item.uid || "",
    operatorName: item.operatorName || item.driverName || item.choferNombre || item.nombreChofer || "",
    proofUrl: recordProofUrl(item),
    proofPath: recordProofPath(item),
    dayKey: recordDayKey(item),
    requestedAt: item.requestedAt || item.createdAt || null
  };
}

function normalizeAdvanceRecord(id, item = {}) {
  return {
    ...item,
    id,
    type: item.type || item.loanType || "",
    remainingAmount: Number(item.remainingAmount ?? item.balance ?? item.saldoPendiente ?? item.totalDebt ?? 0) || 0,
    totalDebt: Number(item.totalDebt ?? item.totalAmount ?? item.originalAmount ?? item.amount ?? 0) || 0
  };
}

function currentWeeklyPeriodId(reference = new Date()) {
  const date = new Date(reference);
  date.setHours(12, 0, 0, 0);
  const daysSinceSaturday = (date.getDay() - 6 + 7) % 7;
  date.setDate(date.getDate() - daysSinceSaturday);
  return localDayKey(date);
}

function currentDriverUid() {
  return auth.currentUser?.uid || "";
}

function currentDriverName() {
  return currentProfile?.displayName || currentProfile?.nombre || currentProfile?.nombreCompleto || currentProfile?.username || auth.currentUser?.displayName || "Chofer";
}

function ownedQuery(collectionName, uid = currentDriverUid()) {
  return query(collection(db, collectionName), where("driverUid", "==", uid));
}

function cacheKey(collectionName, uid) {
  return `${collectionName}::${uid}`;
}

function mergeOwnedRows(collectionName, uid, canonicalRows = []) {
  const key = cacheKey(collectionName, uid);
  const map = new Map();
  for (const row of legacyOwnedCache.get(key) || []) map.set(row.id, row);
  for (const row of canonicalRows || []) map.set(row.id, row);
  return Array.from(map.values());
}

async function loadOwnedHistory(collectionName, uid) {
  const targetUid = String(uid || "").trim();
  if (!targetUid) return [];
  const key = cacheKey(collectionName, targetUid);
  const map = new Map();
  const tasks = OWNERSHIP_FIELDS.map(async field => {
    try {
      const snap = await getDocs(query(collection(db, collectionName), where(field, "==", targetUid), limit(900)));
      snap.forEach(d => map.set(d.id, { id:d.id, ...d.data() }));
    } catch (err) {
      // Algunos aliases pueden no estar permitidos por reglas/índices; seguimos con los demás.
      console.warn("EXPLORA_HISTORY_QUERY", collectionName, field, err?.code || err?.message || err);
    }
  });
  await Promise.allSettled(tasks);
  const rows = Array.from(map.values());
  legacyOwnedCache.set(key, rows);
  return rows;
}

function setCanonicalRows(collectionName, uid, rows) {
  canonicalOwnedCache.set(cacheKey(collectionName, uid), rows || []);
}

function canonicalRows(collectionName, uid) {
  return canonicalOwnedCache.get(cacheKey(collectionName, uid)) || [];
}

function setSplashProgress(value) {
  const progress = Math.max(0, Math.min(100, Number(value) || 0));
  splashProgress = progress;

  const arc = $("splashProgressArc");
  const dot = $("splashProgressDot");
  const progressBox = document.querySelector(".splash-progress");
  if (arc) arc.style.strokeDashoffset = String(100 - progress);
  if (progressBox) progressBox.setAttribute("aria-valuenow", String(Math.round(progress)));

  if (dot) {
    const angle = (-90 + (360 * progress / 100)) * Math.PI / 180;
    dot.setAttribute("cx", String(60 + 48 * Math.cos(angle)));
    dot.setAttribute("cy", String(60 + 48 * Math.sin(angle)));
  }
}

function startSplash() {
  splashTransition += 1;
  splashStartedAt = Date.now();
  splashProgress = 4;
  $("splashScreen")?.classList.remove("hidden", "is-leaving");
  $("loginScreen")?.classList.add("hidden");
  $("app")?.classList.add("hidden");
  setSplashProgress(splashProgress);

  if (splashTimer) window.clearInterval(splashTimer);
  splashTimer = window.setInterval(() => {
    const remaining = 91 - splashProgress;
    setSplashProgress(Math.min(91, splashProgress + Math.max(1.1, remaining * .075)));
  }, 90);
}

async function finishSplash(targetId) {
  const transitionId = ++splashTransition;
  if (splashTimer) {
    window.clearInterval(splashTimer);
    splashTimer = null;
  }

  const elapsed = Date.now() - splashStartedAt;
  if (elapsed < SPLASH_MIN_VISIBLE_MS) {
    await new Promise(resolve => window.setTimeout(resolve, SPLASH_MIN_VISIBLE_MS - elapsed));
  }
  if (transitionId !== splashTransition) return;

  setSplashProgress(100);
  await new Promise(resolve => window.setTimeout(resolve, 190));
  if (transitionId !== splashTransition) return;

  const splash = $("splashScreen");
  splash?.classList.add("is-leaving");
  await new Promise(resolve => window.setTimeout(resolve, 220));
  if (transitionId !== splashTransition) return;

  splash?.classList.add("hidden");
  splash?.classList.remove("is-leaving");
  $("loginScreen")?.classList.toggle("hidden", targetId !== "loginScreen");
  $("app")?.classList.toggle("hidden", targetId !== "app");
}

startSplash();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .catch(err => console.warn("No se pudo registrar el acceso directo:", err));
  });
}

const money = value => new Intl.NumberFormat("es-AR", {
  style: "currency", currency: "ARS", maximumFractionDigits: 0
}).format(value || 0);
const signedMoney = value => {
  const numericValue = Number(value || 0);
  if (Math.abs(numericValue) < 0.5) return money(0);
  return `${numericValue > 0 ? "+" : "−"} ${money(Math.abs(numericValue))}`;
};
const moneyInputFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const moneyAnimationFrames = new WeakMap();

function moneyForElement(element, value) {
  return element?.dataset.moneyFormat === "signed" ? signedMoney(value) : money(value);
}

function canAnimateMoney() {
  try {
    const reducesMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return !reducesMotion
      && typeof window.requestAnimationFrame === "function"
      && typeof window.cancelAnimationFrame === "function";
  } catch {
    return false;
  }
}

function setAnimatedMoney(elementOrId, targetValue) {
  const element = typeof elementOrId === "string" ? $(elementOrId) : elementOrId;
  if (!element) return;

  const target = Number(targetValue || 0);
  const storedCurrent = Number(element.dataset.moneyCurrent);
  const hasPreviousValue = element.dataset.moneyCurrent !== undefined && Number.isFinite(storedCurrent);
  const previous = hasPreviousValue ? storedCurrent : target;
  const activeFrame = moneyAnimationFrames.get(element);

  if (activeFrame !== undefined) {
    window.cancelAnimationFrame(activeFrame);
    moneyAnimationFrames.delete(element);
  }

  // El valor correcto se muestra primero. La animación es una mejora visual y
  // nunca debe impedir el inicio de sesión ni dejar una cifra desactualizada.
  element.textContent = moneyForElement(element, target);
  element.dataset.moneyCurrent = String(target);
  element.setAttribute("aria-label", moneyForElement(element, target));

  if (!hasPreviousValue || Math.abs(target - previous) < 0.5 || !canAnimateMoney()) {
    element.classList.remove("money-rolling");
    return;
  }

  try {
    element.classList.remove("money-rolling");
    void element.offsetWidth;
    element.classList.add("money-rolling");
    element.addEventListener("animationend", () => {
      element.classList.remove("money-rolling");
    }, { once: true });

    let startedAt;
    const duration = 760;

    const tick = now => {
      if (startedAt === undefined) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = previous + (target - previous) * eased;

      element.textContent = moneyForElement(element, Math.round(current));
      element.dataset.moneyCurrent = String(current);

      if (progress < 1) {
        moneyAnimationFrames.set(element, window.requestAnimationFrame(tick));
        return;
      }

      element.textContent = moneyForElement(element, target);
      element.dataset.moneyCurrent = String(target);
      moneyAnimationFrames.delete(element);
    };

    moneyAnimationFrames.set(element, window.requestAnimationFrame(tick));
  } catch (err) {
    console.warn("Animación de importes desactivada:", err);
    element.classList.remove("money-rolling");
    element.textContent = money(target);
    element.dataset.moneyCurrent = String(target);
    moneyAnimationFrames.delete(element);
  }
}

function moneyInputDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function parseMoneyInput(value) {
  const digits = moneyInputDigits(value);
  return digits ? Number(digits) : 0;
}

function formattedMoneyInput(value) {
  const amount = typeof value === "number" ? Math.round(value) : parseMoneyInput(value);
  return amount > 0 ? moneyInputFormatter.format(amount) : "";
}

function setMoneyInput(inputOrId, value) {
  const input = typeof inputOrId === "string" ? $(inputOrId) : inputOrId;
  if (input) input.value = formattedMoneyInput(value);
}

document.querySelectorAll("[data-money-input]").forEach(input => {
  input.addEventListener("input", () => {
    const digits = moneyInputDigits(input.value);
    input.value = digits ? moneyInputFormatter.format(Number(digits)) : "";
  });
});

function localDayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function safeUsername(value) {
  return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g,"").replace(/[^a-z0-9._-]/g,"");
}

async function loginEmailCandidates(usernameOrEmail) {
  const value = usernameOrEmail.trim().toLowerCase();
  if (value.includes("@")) return [value];

  const username = safeUsername(value);
  const candidates = [
    LOGIN_ALIASES[value],
    username ? `${username}@${USER_EMAIL_DOMAIN}` : ""
  ].filter(Boolean);

  if (username) {
    try {
      const aliasSnap = await getDoc(doc(db, "login_aliases", username));
      if (aliasSnap.exists()) {
        const data = aliasSnap.data() || {};
        const aliasEmail = String(data.authEmail || data.email || data.correo || data.firebaseEmail || "").trim().toLowerCase();
        if (aliasEmail.includes("@")) candidates.push(aliasEmail);
      }
    } catch (err) {
      console.warn("No se pudo consultar login_aliases; se intenta el acceso histórico.", err?.code || err);
    }
  }

  return [...new Set(candidates)];
}

function isCredentialError(err) {
  return ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"]
    .includes(String(err?.code || ""));
}

async function waitForAuthReady() {
  await Promise.race([
    authReady,
    new Promise(resolve => setTimeout(resolve, AUTH_READY_TIMEOUT_MS))
  ]);
}

async function signInFromLogin(usernameOrEmail, password) {
  const candidates = await loginEmailCandidates(usernameOrEmail);
  let lastError = Object.assign(new Error("Faltan credenciales"), { code: "auth/invalid-credential" });

  for (const email of candidates) {
    try {
      return await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      lastError = err;
      if (!isCredentialError(err)) throw err;
    }
  }

  throw lastError;
}

function loginErrorMessage(err) {
  const code = String(err?.code || "");
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(code)) {
    return "El usuario o la contraseña no son correctos.";
  }
  if (code === "auth/too-many-requests") {
    return "Hubo varios intentos. Esperá un momento y volvé a probar.";
  }
  if (code === "auth/network-request-failed") {
    return "No hay conexión con Firebase. Revisá internet e intentá nuevamente.";
  }
  if (code === "auth/unauthorized-domain") {
    return "Este dominio todavía no está autorizado en Firebase.";
  }
  if (code === "auth/operation-not-allowed") {
    return "Activá el acceso con correo y contraseña en Firebase Authentication.";
  }
  return "No se pudo iniciar sesión. Intentá nuevamente.";
}

function fallbackProfile(user) {
  const username = user.email?.split("@")[0] || "explora";
  return { username, displayName: user.displayName || username, role: EXPLORA_ADMIN_UIDS.has(user.uid) ? "admin" : "barber", active: true, uid:user.uid };
}
function isSettlementAdjustment(item) {
  return item.type === "settlement_adjustment";
}
function isReimbursementCompensation(item) {
  // El tipo anterior se conserva para interpretar correctamente cualquier
  // comprobante que ya se haya generado antes de esta corrección.
  return item.type === "reimbursement_compensation" || item.type === "debt_compensation";
}
function isAdminDebt(item) {
  return item.type === "admin_debt";
}
function isExpenseReceipt(item) {
  return item.type === "expense_receipt";
}
function isUberReceipt(item) {
  return item.type === "uber_receipt";
}
function isCashAdvance(item) {
  return item.type === "cash_advance";
}
function movementIsDeleted(item = {}) {
  const status = String(item.status || item.estado || item.state || item.deletionStatus || "").toLowerCase();
  return item.deleted === true || item.isDeleted === true || item.eliminado === true || /deleted|eliminado|borrado|anulado/.test(status);
}
function cashboxIsExcluded(item = {}) {
  return item.excludeFromCashbox === true || item.cashboxExcluded === true || item.cajaChicaEliminada === true || item.ignoreCashbox === true || item.noCashbox === true;
}
function revenueTotalFor(method) {
  return openBillingPayments()
    .filter(p => !movementIsDeleted(p) && p.method === method && !isSettlementAdjustment(p) && !isReimbursementCompensation(p))
    .reduce((a,p)=>a+Number(p.amount||0),0);
}
function adjustmentTotal(direction) {
  return openBillingPayments()
    .filter(p => !movementIsDeleted(p) && isSettlementAdjustment(p) && p.adjustmentDirection === direction)
    .reduce((total, item) => {
      const amount = Number(item.amount || 0);
      const paidToAdvance = direction === "driver_to_explora"
        ? Number(item.advanceRepaymentAmount || 0)
        : 0;
      return total + Math.max(0, amount - paidToAdvance);
    }, 0);
}
function expensesTotal() {
  return openExpenses().reduce((a,e)=>a+Number(e.amount||0),0);
}
function debtsTotal() {
  return debts.reduce((a,item)=>a+Number(item.amount||0),0);
}
function advanceRemaining(item) {
  return Math.max(0, Number(item.remainingAmount ?? item.totalDebt ?? 0) || 0);
}
function advancesOutstandingTotal() {
  return advances.reduce((total, item) => total + advanceRemaining(item), 0);
}
function advanceRepaymentAppliedTotal() {
  return payments
    .filter(item => item.method === "digital" && !isSettlementAdjustment(item))
    .reduce((total, item) => total + Number(item.advanceRepaymentAmount || 0), 0);
}
function planAdvanceRepayment(availableAmount, sourceAdvances = advances) {
  let available = Math.max(0, Number(availableAmount || 0));
  const allocations = [];
  const activeAdvances = [...sourceAdvances]
    .filter(item => advanceRemaining(item) > 0.5)
    .sort((a, b) => {
      const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return aMs - bMs;
    });

  for (const advance of activeAdvances) {
    if (available <= 0.5) break;
    const before = advanceRemaining(advance);
    const applied = Math.min(before, available);
    const after = Math.max(0, before - applied);
    allocations.push({
      id: advance.id,
      applied,
      remainingAmount: after,
      repaidAmount: Math.max(0, Number(advance.totalDebt || 0) - after),
      status: after <= 0.5 ? "paid" : "active"
    });
    available -= applied;
  }

  return {
    allocations,
    totalApplied: allocations.reduce((total, item) => total + item.applied, 0)
  };
}
function reimbursementCompensationTotal() {
  const cutoff = lastExpensesClosureMs();

  // Compatibilidad completa con Santander Main:
  // 1) los ajustes históricos de deuda con Gastos viven en `deuda_pagos`;
  // 2) las compensaciones creadas por esta interfaz viven en `billing_records`.
  // Ambos reducen el reintegro bruto del 50% de gastos del período abierto.
  const legacyDebtOffsets = debtPayments
    .filter(item => {
      const linkedPeriodStart = Number(item.expensePeriodStartMs || item.gastosPeriodStartMs || 0);
      return linkedPeriodStart > 0 ? linkedPeriodStart === cutoff : recordTimestampMs(item) > cutoff;
    })
    .filter(item => item.expenseOffset === true)
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);

  const newCompensations = payments
    .filter(item => recordTimestampMs(item) > cutoff)
    .filter(isReimbursementCompensation)
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);

  return legacyDebtOffsets + newCompensations;
}
function uberTodayItems() {
  const today = localDayKey();
  return uberClosures.filter(item => item.dayKey === today);
}
function uberTodayTotal() {
  return uberTodayItems().reduce((a,item)=>a+Number(item.amount||0),0);
}
function isoWeekKey(dateString) {
  const [y,m,d] = String(dateString).split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;
}
function parseLocalDateKey(dateString) {
  const [year, month, day] = String(dateString || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}
function addLocalDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
function startOfUberWeek(referenceDate = new Date()) {
  const date = new Date(referenceDate);
  date.setHours(12, 0, 0, 0);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return date;
}
function formatUberWeekDate(dateString) {
  const date = parseLocalDateKey(dateString);
  if (!date) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" })
    .format(date)
    .replace(/\./g, "");
}
function buildUberWeek(startDate) {
  const start = new Date(startDate);
  const close = addLocalDays(start, 7);
  const weekStartDate = localDayKey(start);
  const weekCloseDate = localDayKey(close);
  return {
    weekStartDate,
    weekCloseDate,
    weekKey: isoWeekKey(weekCloseDate),
    label: `${formatUberWeekDate(weekStartDate)} – ${formatUberWeekDate(weekCloseDate)}`
  };
}
function currentUberWeek(referenceDate = new Date()) {
  return buildUberWeek(startOfUberWeek(referenceDate));
}
function uberWeekLabelForItem(item) {
  if (item.weekLabel) return item.weekLabel;
  const close = parseLocalDateKey(item.weekCloseDate);
  if (!close) return item.weekKey || "Semana sin fecha";
  const start = item.weekStartDate || localDayKey(addLocalDays(close, -7));
  return `${formatUberWeekDate(start)} – ${formatUberWeekDate(item.weekCloseDate)}`;
}
function isUberWeekLoaded(week) {
  return uberClosures.some(item =>
    item.weekStartDate === week.weekStartDate
    || item.weekCloseDate === week.weekCloseDate
    || item.weekKey === week.weekKey
    || item.id === week.weekKey
  );
}
function pendingUberWeeks(referenceDate = new Date()) {
  const firstWeek = parseLocalDateKey(UBER_TRACKING_START_DATE);
  const today = parseLocalDateKey(localDayKey(referenceDate));
  if (!firstWeek || !today) return [];

  const pending = [];
  let cursor = firstWeek;
  let safety = 0;
  while (cursor.getTime() < today.getTime() && safety < 520) {
    const week = buildUberWeek(cursor);
    const closeDate = parseLocalDateKey(week.weekCloseDate);
    // El comprobante se habilita al día siguiente del cierre. Ejemplo:
    // la semana 24–31 de agosto empieza a solicitarse el 1 de septiembre.
    if (!closeDate || closeDate.getTime() >= today.getTime()) break;
    if (!isUberWeekLoaded(week)) pending.push(week);
    cursor = addLocalDays(cursor, 7);
    safety += 1;
  }
  return pending;
}
function selectedPendingUberWeek() {
  const selectedStart = $("uberWeekSelect")?.value || "";
  return pendingUberWeeks().find(week => week.weekStartDate === selectedStart) || null;
}
function updateUberWeekSummary() {
  const week = selectedPendingUberWeek();
  const startLabel = $("uberWeekStartLabel");
  const endLabel = $("uberWeekEndLabel");
  const stateLabel = $("uberWeekStateLabel");
  if (!startLabel || !endLabel || !stateLabel) return;

  startLabel.textContent = week ? formatUberWeekDate(week.weekStartDate) : "—";
  endLabel.textContent = week ? formatUberWeekDate(week.weekCloseDate) : "—";
  stateLabel.textContent = week ? "Falta cargar" : "Al día";
}
function renderUberWeekSelector() {
  const select = $("uberWeekSelect");
  const notice = $("uberPendingNotice");
  const amountInput = $("uberAmount");
  const proofInput = $("uberProof");
  const saveButton = $("saveUberBtn");
  if (!select || !notice || !amountInput || !proofInput || !saveButton) return;

  const pending = pendingUberWeeks();
  const previousValue = select.value;
  const hasPending = pending.length > 0;

  notice.classList.toggle("is-clear", !hasPending);
  if (hasPending) {
    notice.innerHTML = `<strong>${pending.length} ${pending.length === 1 ? "semana pendiente" : "semanas pendientes"}</strong><span>${pending.length === 1 ? "Seleccioná la semana cerrada y cargá su comprobante." : "Los comprobantes atrasados se acumulan. Cargá uno por cada semana."}</span>`;
    select.innerHTML = pending
      .map(week => `<option value="${week.weekStartDate}">${week.label} · Falta cargar</option>`)
      .join("");
    select.value = pending.some(week => week.weekStartDate === previousValue)
      ? previousValue
      : pending[0].weekStartDate;
  } else {
    const activeWeek = currentUberWeek();
    notice.innerHTML = `<strong>Comprobantes al día</strong><span>La semana ${activeWeek.label} todavía está en curso.</span>`;
    select.innerHTML = `<option value="">No hay semanas cerradas pendientes</option>`;
  }

  select.disabled = !hasPending;
  amountInput.disabled = !hasPending;
  proofInput.disabled = !hasPending;
  saveButton.disabled = !hasPending;
  updateUberWeekSummary();
}
function renderUberPendingBadge() {
  const button = $("addUberBtn");
  const badge = $("uberPendingBadge");
  if (!button || !badge) return;
  const count = pendingUberWeeks().length;
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
  button.classList.toggle("has-pending-alert", count > 0);
  button.title = count
    ? `${count} ${count === 1 ? "semana de Uber pendiente" : "semanas de Uber pendientes"}`
    : "No hay semanas de Uber pendientes";
}
function formatDate(dateString) {
  const [y,m,d] = String(dateString || "").split("-").map(Number);
  if (!y || !m || !d) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", {day:"2-digit", month:"2-digit", year:"2-digit"}).format(new Date(y,m-1,d));
}
function escapeHtml(s="") {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function closureCutoffMs(item = {}) {
  const direct = Number(item.cutoffAtMs || item.requestedAtMs || item.createdAtMs || 0);
  if (direct > 0) return direct;
  return recordTimestampMs({
    createdAt: item.cutoffAt || item.requestedAt || item.createdAt || item.completedAt || item.closedAt,
    createdAtMs: item.cutoffAtMs || item.requestedAtMs || item.createdAtMs || item.completedAtMs || item.closedAtMs
  });
}

function closureInvalidatesCutoff(item = {}) {
  const text = [item.status, item.estado, item.closureStatus, item.paymentStatus, item.receiptStatus,
    item.rejectionReason, item.rollbackStatus, item.closureMode, item.periodType]
    .map(v => String(v || "").toLowerCase()).join(" | ");
  return item.rejected === true || item.rollbackRestored === true || item.invalidatesCutoff === true ||
    item.cutoffActive === false || /reject|rechaz|cancel|anulad|no aceptado|rejected_on_demand/.test(text);
}

function closureKind(item = {}) {
  const raw = String(item.closureKind || item.closureType || item.payTab || item.closeKind || item.kind ||
    item.cierreTipo || item.type || item.category || item.homeModule || item.homeTab || item.moduleKey || "").toLowerCase();
  if (/gasto|expense/.test(raw)) return "gastos";
  if (/caja|chica|cashbox/.test(raw)) return "caja_chica";
  if (/factur|billing|cobro|explora|digital|transfer|qr|card|tarjeta|chofer|driver|efectivo|cash/.test(raw)) return "facturacion";
  return "";
}

function closureUsesCutoff(item = {}) {
  const mode = String(item.closureMode || item.periodType || "").toLowerCase();
  // Misma regla que Santander Main: solo un cierre on_demand válido corta el período abierto.
  return mode === "on_demand" && !closureInvalidatesCutoff(item);
}

function lastBillingClosureMs() {
  return closures
    .filter(closureUsesCutoff)
    .filter(item => closureKind(item) === "facturacion")
    .map(closureCutoffMs)
    .filter(Boolean)
    .sort((a,b) => b-a)[0] || 0;
}

function lastExpensesClosureMs() {
  return closures
    .filter(closureUsesCutoff)
    .filter(item => closureKind(item) === "gastos")
    .map(closureCutoffMs)
    .filter(Boolean)
    .sort((a,b) => b-a)[0] || 0;
}

function billingClosureClosesCashbox(item = {}) {
  const affects = Array.isArray(item.affectsTabs) ? item.affectsTabs.map(v => String(v || "").toLowerCase()) : [];
  return item.autoClosesCashbox === true || item.cashboxClosedWithBilling === true || item.cashboxAutoClosed === true ||
    affects.some(v => /caja|cashbox/.test(v));
}

function lastCashboxResetMs() {
  // Un cierre de Facturación NO reinicia la caja chica ni la facturación.
  // Solo un cierre explícito del módulo Caja chica puede cortar ese módulo.
  return closures
    .filter(closureUsesCutoff)
    .filter(item => closureKind(item) === "caja_chica")
    .map(closureCutoffMs).filter(Boolean).sort((a,b)=>b-a)[0] || 0;
}

function openBillingPayments() {
  // La facturación es acumulativa y nunca se reinicia por pedir o completar un cierre.
  // Los cierres solo se reflejan como ajustes de liquidación que llevan el saldo a 0.
  return payments.filter(item => !movementIsDeleted(item));
}

function openCashboxAmount() {
  // Un cierre de Facturación no reinicia la caja chica. Solo un cierre específico
  // de Caja chica puede iniciar un nuevo tramo para ese módulo independiente.
  const cutoff = lastCashboxResetMs();
  const regularCash = payments
    .filter(item => !movementIsDeleted(item) && !cashboxIsExcluded(item) && recordTimestampMs(item) > cutoff)
    .filter(item => item.method === "cash" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .reduce((sum,item) => sum + Number(item.amount || 0) * 0.05, 0);
  const uberCashbox = uberClosures
    .filter(item => !movementIsDeleted(item) && recordTimestampMs(item) > cutoff)
    .filter(item => !/reject|rechaz/.test(String(item.reviewStatus || item.status || "").toLowerCase()))
    .reduce((sum,item) => sum + Number(item.amount || 0) * 0.05, 0);
  return regularCash + uberCashbox;
}

function openExpenses() {
  const cutoff = lastExpensesClosureMs();
  return expenses.filter(item => recordTimestampMs(item) > cutoff);
}

// Billeteras espejo compensadas — regla operativa vigente:
// - Facturación compartida = efectivo + Uber + digital.
// - El chofer conserva físicamente 100% de efectivo y Uber, pero debe reintegrar 50% de ambos a Explora.
// - Caja chica = 5% de (efectivo + Uber) y también se suma a lo que debe liquidar el chofer.
// - Gastos, deudas y adelantos se mantienen como módulos separados.

// - Explora → Chofer: 50% de Digital que no se haya aplicado a un adelanto.
// - El saldo positivo identifica quién debe compensar; el negativo, quién recibe.
// - Ambas billeteras muestran siempre el mismo saldo con signos opuestos.
function settlementModel() {
  const cashRevenue = revenueTotalFor("cash");
  const digitalRevenue = revenueTotalFor("digital");
  const driverPaid = adjustmentTotal("driver_to_explora");
  const exploraPaid = adjustmentTotal("explora_to_driver");
  const uberRevenue = uberClosures
    .filter(item => !movementIsDeleted(item))
    .filter(item => !/reject|rechaz/.test(String(item.reviewStatus || item.status || "").toLowerCase()))
    .reduce((sum,item) => sum + Number(item.amount || 0), 0);
  const cash = cashRevenue;
  const digital = digitalRevenue;
  const expense = expensesTotal();
  const cashShare = cashRevenue * 0.50;
  const uberShare = uberRevenue * 0.50;
  const digitalShare = digitalRevenue * 0.50;
  const cashBox = openCashboxAmount();
  const expenseHalf = expense * 0.50;
  const reimbursementApplied = Math.min(reimbursementCompensationTotal(), expenseHalf);
  const expenseReimbursement = Math.max(0, expenseHalf - reimbursementApplied);

  // Fórmula autoritativa vigente:
  // 50% efectivo + 50% Uber + 5% de (efectivo + Uber) - 50% digital,
  // corregida únicamente por pagos de liquidación ya registrados.
  const baseBalance = cashShare + uberShare + cashBox - digitalShare;
  const balance = baseBalance - driverPaid + exploraPaid;
  const normalizedBalance = Math.abs(balance) > 0.5 ? balance : 0;
  const compensationAvailable = Math.min(expenseReimbursement, Math.max(0, normalizedBalance));

  return {
    cash, uber:uberRevenue, digital, expense,
    adminDebt:debtsTotal(), advanceDebt:advancesOutstandingTotal(), advanceRepaidToday:advanceRepaymentAppliedTotal(),
    driverHeld:cashRevenue + uberRevenue,
    cashShare, uberShare, digitalShare, digitalShareGross:digitalShare,
    cashBox, expenseHalf, expenseReimbursement, reimbursementApplied, compensationAvailable,
    cashRevenue, digitalRevenue, driverPaid, exploraPaid, baseBalance,
    cashAdjusted:cashShare + uberShare + cashBox + exploraPaid,
    digitalAdjusted:digitalShare + driverPaid,
    cashDebt:cashShare + uberShare + cashBox,
    digitalDebt:digitalShare,
    balance:normalizedBalance, amount:Math.abs(normalizedBalance),
    driverWallet:normalizedBalance, exploraWallet:-normalizedBalance,
    from:normalizedBalance > 0.5 ? "cash" : normalizedBalance < -0.5 ? "digital" : "balanced",
    to:normalizedBalance > 0.5 ? "digital" : normalizedBalance < -0.5 ? "cash" : "balanced",
    grand:cashRevenue + uberRevenue + digitalRevenue,
    billingShareEach:(cashRevenue + uberRevenue + digitalRevenue) * 0.50,
    billingCutoffMs:0
  };
}

function renderWalletStatus(elementId, settlementBalance) {
  const element = $(elementId);
  if (!element) return;

  const isDriver = elementId === "cashWalletStatus";
  element.classList.remove("is-paying", "is-receiving", "is-balanced", "is-hidden-direction");

  // La dirección se decide UNA sola vez con el saldo autoritativo del cierre.
  // balance > 0  => el chofer debe liquidar a Explora.
  // balance < 0  => Explora debe liquidar al chofer.
  // Nunca se interpreta el signo de cada billetera espejo por separado.
  if (Math.abs(settlementBalance) <= 0.5) {
    if (isDriver) {
      element.textContent = "Cuentas equilibradas";
      element.classList.add("is-balanced");
    } else {
      element.textContent = "";
      element.classList.add("is-hidden-direction");
    }
    return;
  }

  const driverMustPay = settlementBalance > 0.5;
  const thisSideMustPay = (driverMustPay && isDriver) || (!driverMustPay && !isDriver);

  if (!thisSideMustPay) {
    element.textContent = "";
    element.classList.add("is-hidden-direction");
    return;
  }

  element.textContent = driverMustPay
    ? "Chofer debe liquidar a Explora"
    : "Explora debe liquidar al chofer";
  element.classList.add("is-paying");
}

function renderBilledTotal(model) {
  setAnimatedMoney("summaryBilledAmount", model.grand);
  const reimbursementAmount = $("summaryReimbursementAmount");
  if (reimbursementAmount) reimbursementAmount.textContent = money(model.expenseReimbursement);
  const button = $("compensateDebtBtn");
  if (!button) return;
  // El botón siempre abre el detalle. Si no hay saldo aplicable, el modal
  // explica el motivo en lugar de parecer que la aplicación no responde.
  button.disabled = false;
  button.title = model.expenseReimbursement <= 0.5
    ? "No hay reintegros disponibles."
    : model.balance <= 0.5
      ? "El chofer no tiene una diferencia pendiente a favor de Explora."
      : "Utilizar el reintegro para reducir la diferencia Chofer–Explora.";
}

function openDebtCompensationModal() {
  const modal = $("debtCompensationModal");
  if (!modal) return;
  const model = settlementModel();

  $("compensationReimbursementAvailable").textContent = money(model.expenseReimbursement);
  $("compensationDebtAvailable").textContent = money(Math.max(0, model.balance));
  $("compensationMaximum").textContent = money(model.compensationAvailable);
  if (model.compensationAvailable > 0.5) {
    $("compensationOutcome").textContent = `Se utilizarán ${money(model.compensationAvailable)}. El nuevo saldo que el chofer deberá compensar será de ${money(model.balance - model.compensationAvailable)} y el reintegro pendiente quedará en ${money(model.expenseReimbursement - model.compensationAvailable)}.`;
  } else if (model.expenseReimbursement <= 0.5) {
    $("compensationOutcome").textContent = "Todavía no hay dinero pendiente de reintegro para utilizar en una compensación.";
  } else {
    $("compensationOutcome").textContent = "El chofer no tiene una diferencia pendiente a favor de Explora para compensar con este reintegro.";
  }
  $("debtCompensationStatus").textContent = "";
  $("debtCompensationStatus").className = "status";
  $("confirmDebtCompensation").disabled = model.compensationAvailable <= 0.5;
  $("confirmDebtCompensation").textContent = model.compensationAvailable > 0.5 ? "OK, compensar" : "Sin saldo para compensar";
  modal.classList.remove("hidden");
}

function advanceQuote(principalValue) {
  const principal = Math.max(0, Number(principalValue || 0));
  const interest = Math.round(principal * ADVANCE_INTEREST_RATE);
  return { principal, interest, total: principal + interest };
}

function renderAdvanceQuote() {
  const input = $("advanceAmount");
  if (!input) return;
  const quote = advanceQuote(parseMoneyInput(input.value));
  const principal = $("advancePrincipalPreview");
  const interest = $("advanceInterestPreview");
  const total = $("advanceTotalPreview");
  if (principal) principal.textContent = money(quote.principal);
  if (interest) interest.textContent = money(quote.interest);
  if (total) total.textContent = money(quote.total);
}

function openAdvanceModal() {
  if (isAdminProfile()) return;
  const form = $("advanceForm");
  const modal = $("advanceModal");
  if (!form || !modal) return;
  form.reset();
  $("advanceStatus").textContent = "";
  $("advanceStatus").className = "status";
  $("confirmAdvanceBtn").disabled = false;
  $("confirmAdvanceBtn").textContent = "Confirmar adelanto";
  renderAdvanceQuote();
  modal.classList.remove("hidden");
}


function syncMoneyPanelRows() {
  const panels = Array.from(document.querySelectorAll('.workspace > .money-panel .panel-head'));
  if (panels.length < 2) return;

  // Remove placeholders from previous render before recounting visible data rows.
  panels.forEach(panel => panel.querySelectorAll('.adjustment.is-symmetry-placeholder').forEach(el => el.remove()));

  const visibleRows = panels.map(panel =>
    Array.from(panel.querySelectorAll(':scope > .adjustment')).filter(row => !row.classList.contains('hidden'))
  );
  const target = Math.max(...visibleRows.map(rows => rows.length));

  panels.forEach((panel, index) => {
    const missing = target - visibleRows[index].length;
    const actions = panel.querySelector('.panel-action-stack');
    if (!actions || missing <= 0) return;
    for (let i = 0; i < missing; i += 1) {
      const spacer = document.createElement('div');
      spacer.className = 'adjustment is-symmetry-placeholder';
      spacer.setAttribute('aria-hidden', 'true');
      spacer.innerHTML = '<span>&nbsp;</span><strong>&nbsp;</strong>';
      panel.insertBefore(spacer, actions);
    }
  });
}

function render() {
  const model = settlementModel();
  const cashItems = [
    ...payments.filter(p => p.method === "cash"),
    ...debts.map(item => ({ ...item, method: "cash", type: "admin_debt", service: "Deuda" })),
    ...advances.map(item => ({
      ...item,
      method: "cash",
      type: "cash_advance",
      amount: Number(item.principalAmount || 0),
      service: "Adelanto en efectivo",
      detail: `Deuda con 40%: ${money(item.totalDebt)} · Saldo pendiente: ${money(advanceRemaining(item))}`
    })),
    ...uberClosures.map(item => ({
      ...item,
      method: "cash",
      type: "uber_receipt",
      service: "Uber",
      detail: `Semana ${uberWeekLabelForItem(item)}`
    }))
  ].sort((a, b) => {
    const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    return bMs - aMs;
  });
  const digitalItems = [
    ...payments.filter(p => p.method === "digital"),
    ...expenses.map(item => ({
      ...item,
      method: "digital",
      type: "expense_receipt",
      service: "Gasto",
      detail: `${item.detail || "Gasto"} · 50% reconocido: ${money(Number(item.amount || 0) * 0.5)}`
    }))
  ].sort((a, b) => {
    const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    return bMs - aMs;
  });
  const visibleCashItems = cashItems.slice(0, RECENT_RECEIPTS_LIMIT);
  const visibleDigitalItems = digitalItems.slice(0, RECENT_RECEIPTS_LIMIT);

  setAnimatedMoney("cashTotal", model.driverWallet);
  renderWalletStatus("cashWalletStatus", model.balance);
  $("cashBaseTotal").textContent = money(model.cashRevenue);
  $("uberCashTotal").textContent = money(model.uber);
  $("cashBoxTotal").textContent = money(model.cashBox);
  $("exploraAdjustmentTotal").textContent = money(model.exploraPaid);
  $("adminDebtTotal").textContent = money(model.adminDebt);
  const advanceDebtTotal = $("advanceDebtTotal");
  const advanceDebtRow = $("advanceDebtRow");
  if (advanceDebtTotal) advanceDebtTotal.textContent = money(model.advanceDebt);
  if (advanceDebtRow) advanceDebtRow.classList.toggle("hidden", model.advanceDebt <= 0.5);
  const cashCompensationTotal = $("cashDebtCompensationTotal");
  const cashCompensationRow = $("cashDebtCompensationRow");
  if (cashCompensationTotal) cashCompensationTotal.textContent = money(model.reimbursementApplied);
  if (cashCompensationRow) cashCompensationRow.classList.toggle("hidden", model.reimbursementApplied <= 0.5);

  setAnimatedMoney("digitalTotal", model.exploraWallet);
  renderWalletStatus("digitalWalletStatus", model.balance);
  $("digitalBaseTotal").textContent = money(model.digitalRevenue);
  $("driverAdjustmentTotal").textContent = money(model.driverPaid);
  const advanceRepaymentTotal = $("advanceRepaymentTotal");
  const advanceRepaymentRow = $("advanceRepaymentRow");
  if (advanceRepaymentTotal) advanceRepaymentTotal.textContent = money(model.advanceRepaidToday);
  if (advanceRepaymentRow) advanceRepaymentRow.classList.toggle("hidden", model.advanceRepaidToday <= 0.5);
  const digitalCompensationTotal = $("digitalDebtCompensationTotal");
  const digitalCompensationRow = $("digitalDebtCompensationRow");
  if (digitalCompensationTotal) digitalCompensationTotal.textContent = money(model.reimbursementApplied);
  if (digitalCompensationRow) digitalCompensationRow.classList.toggle("hidden", model.reimbursementApplied <= 0.5);

  $("cashCount").textContent = visibleCashItems.length;
  $("digitalCount").textContent = visibleDigitalItems.length;

  renderBilledTotal(model);
  renderUberPendingBadge();
  renderList("cashList", visibleCashItems, false);
  renderList("digitalList", visibleDigitalItems, true);
  syncMoneyPanelRows();
}

function renderList(containerId, items, isDigital) {
  const box = $(containerId);
  if (!items.length) {
    box.innerHTML = `<div class="empty">${isDigital
      ? "Los cobros digitales y los gastos aparecerán acá."
      : "Los cobros en efectivo y Uber aparecerán acá."}</div>`;
    return;
  }
  box.innerHTML = items.map(item => {
    const time = item.createdAt?.toDate
      ? item.createdAt.toDate().toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})
      : "Ahora";
    const uberReceipt = isUberReceipt(item);
    const debtCompensation = isReimbursementCompensation(item);
    const cashAdvance = isCashAdvance(item);
    const showsProof = isDigital || isSettlementAdjustment(item) || isAdminDebt(item) || uberReceipt || cashAdvance;
    const proof = showsProof
      ? (debtCompensation || cashAdvance
          ? `<span class="proof internal-proof">Comprobante interno</span>`
          : item.proofUrl
          ? `<a class="proof" target="_blank" rel="noopener" href="${item.proofUrl}">Ver foto</a>`
          : `<span class="proof">Sin archivo</span>`)
      : "";
    const expenseReceipt = isExpenseReceipt(item);
    const icon = expenseReceipt
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`
      : uberReceipt
        ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16h14M7 16l1-5h8l1 5M8 11l1.2-3h5.6l1.2 3M6.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/></svg>`
      : debtCompensation
        ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12 4 4 8-9M5 20h14"/></svg>`
      : cashAdvance
        ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M7 7.5h7.2a3 3 0 0 1 0 6H9.8a3 3 0 0 0 0 6H17"/></svg>`
      : isDigital
        ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>`
        : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
    const amountPrefix = debtCompensation ? "−" : "+";
    const footerLabel = uberReceipt
      ? `Semana ${escapeHtml(uberWeekLabelForItem(item))}`
      : cashAdvance
        ? `${advanceRemaining(item) <= 0.5 ? "Adelanto pagado" : "Sin vencimiento"}`
      : `Hoy · ${time}`;
    return `<article class="receipt ${isDigital ? "receipt-digital" : "receipt-cash"} ${isSettlementAdjustment(item) ? "receipt-adjustment" : ""} ${isAdminDebt(item) ? "receipt-debt" : ""} ${expenseReceipt ? "receipt-expense" : ""} ${uberReceipt ? "receipt-uber" : ""} ${debtCompensation ? "receipt-debt-compensation" : ""} ${cashAdvance ? "receipt-advance" : ""}">
      <div class="receipt-main">
        <span class="receipt-icon">${icon}</span>
        <div class="receipt-copy">
          <strong>${escapeHtml(item.service || "Cobro")}</strong>
          <small>${escapeHtml(item.detail || "Servicio registrado")}</small>
        </div>
        <div class="amount">${amountPrefix}${money(item.amount)}</div>
      </div>
      <div class="receipt-footer">
        <span>${footerLabel}</span>${proof}
      </div>
    </article>`;
  }).join("");
}

async function loadProfile(user) {
  const directRefs = [doc(db, "usuarios", user.uid), doc(db, "choferes", user.uid)];
  for (const profileRef of directRefs) {
    try {
      const snap = await getDoc(profileRef);
      if (snap.exists()) {
        const data = snap.data() || {};
        return {
          ...data,
          username: data.username || data.usuario || user.email?.split("@")[0] || "explora",
          displayName: data.displayName || data.nombre || data.nombreCompleto || user.displayName || user.email?.split("@")[0] || "Explora",
          role: profileRole(data, user),
          active: !(data.active === false || data.activo === false || String(data.estado || "").toLowerCase() === "inactivo")
        };
      }
    } catch (_) {}
  }

  try {
    const byUid = await getDocs(query(collection(db, "choferes"), where("uid", "==", user.uid), limit(1)));
    if (!byUid.empty) {
      const data = byUid.docs[0].data() || {};
      return {
        ...data,
        username: data.username || data.usuario || user.email?.split("@")[0] || "explora",
        displayName: data.displayName || data.nombre || data.nombreCompleto || user.displayName || user.email?.split("@")[0] || "Explora",
        role: profileRole(data, user),
        active: !(data.active === false || data.activo === false || String(data.estado || "").toLowerCase() === "inactivo")
      };
    }
  } catch (_) {}

  if (user.email) {
    try {
      const byEmail = await getDocs(query(collection(db, "choferes"), where("email", "==", user.email.toLowerCase()), limit(1)));
      if (!byEmail.empty) {
        const data = byEmail.docs[0].data() || {};
        return {
          ...data,
          username: data.username || data.usuario || user.email.split("@")[0],
          displayName: data.displayName || data.nombre || data.nombreCompleto || user.displayName || user.email.split("@")[0],
          role: profileRole(data, user),
          active: !(data.active === false || data.activo === false || String(data.estado || "").toLowerCase() === "inactivo")
        };
      }
    } catch (_) {}
  }

  return fallbackProfile(user);
}

function subscribeToday(user) {
  if (unsubscribePayments) unsubscribePayments();
  if (unsubscribeExpenses) unsubscribeExpenses();
  if (unsubscribeUber) unsubscribeUber();
  if (unsubscribeDebts) unsubscribeDebts();
  if (unsubscribeDebtPayments) unsubscribeDebtPayments();
  if (unsubscribeAdvances) unsubscribeAdvances();
  advancesLoaded = false;

  const uid = user.uid;
  const setup = ({ collectionName, normalizer, assign, onError, afterRender }) => {
    // Primero recupera todos los aliases históricos de Santander.
    loadOwnedHistory(collectionName, uid).then(rows => {
      const merged = mergeOwnedRows(collectionName, uid, canonicalRows(collectionName, uid));
      assign(merged.map(row => normalizer(row.id, row)).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a)));
      render();
      afterRender?.();
    }).catch(err => console.warn("EXPLORA_HISTORY_LOAD", collectionName, err));

    // Luego mantiene en vivo el camino canónico driverUid para todos los movimientos nuevos.
    return onSnapshot(ownedQuery(collectionName, uid), snap => {
      const canon = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      setCanonicalRows(collectionName, uid, canon);
      const merged = mergeOwnedRows(collectionName, uid, canon);
      assign(merged.map(row => normalizer(row.id, row)).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a)));
      render();
      afterRender?.();
      $("syncStatus").textContent = "En tiempo real";
      $("syncStatus").className = "sync ok";
    }, err => {
      console.error(`Firestore ${collectionName} snapshot error:`, err);
      onError?.(err);
    });
  };

  $("syncStatus").textContent = "Sincronizando período…";
  $("syncStatus").className = "sync";

  unsubscribePayments = setup({
    collectionName:ROOT_COLLECTIONS.payments,
    normalizer:normalizePaymentRecord,
    assign:rows => { payments = rows; },
    onError:() => { $("syncStatus").textContent = "Error de datos"; $("syncStatus").className = "sync bad"; }
  });
  unsubscribeExpenses = setup({
    collectionName:ROOT_COLLECTIONS.expenses,
    normalizer:normalizeExpenseRecord,
    assign:rows => { expenses = rows; },
    onError:() => { $("syncStatus").textContent = "Error de gastos"; $("syncStatus").className = "sync bad"; }
  });
  unsubscribeUber = setup({
    collectionName:ROOT_COLLECTIONS.uber,
    normalizer:normalizeUberRecord,
    assign:rows => { uberClosures = rows.filter(item => item.noData !== true); },
    afterRender:() => { if (!$("uberModal")?.classList.contains("hidden")) renderUberWeekSelector(); },
    onError:() => { $("syncStatus").textContent = "Error de Uber"; $("syncStatus").className = "sync bad"; }
  });
  unsubscribeDebts = setup({
    collectionName:ROOT_COLLECTIONS.debts,
    normalizer:normalizeDebtRecord,
    assign:rows => { debts = rows.filter(item => item.amount > 0); },
    onError:() => { $("syncStatus").textContent = "Error de deudas"; $("syncStatus").className = "sync bad"; }
  });
  unsubscribeDebtPayments = setup({
    collectionName:ROOT_COLLECTIONS.debtPayments,
    normalizer:normalizeDebtPaymentRecord,
    assign:rows => { debtPayments = rows; },
    onError:() => { console.warn("No se pudieron sincronizar los pagos de deuda históricos."); }
  });
  unsubscribeAdvances = setup({
    collectionName:ROOT_COLLECTIONS.advances,
    normalizer:normalizeAdvanceRecord,
    assign:rows => {
      advances = rows.filter(item => item.type === "cash_advance" || item.loanType === "cash_advance");
      advancesLoaded = true;
    },
    onError:() => { advances = []; advancesLoaded = true; render(); $("syncStatus").textContent = "Error de adelantos"; $("syncStatus").className = "sync bad"; }
  });
}

function isAdminProfile() {
  return EXPLORA_ADMIN_UIDS.has(auth.currentUser?.uid || "") || currentProfile?.role === "admin";
}

function applyRoleUI() {
  $("closeDayBtn").textContent = isAdminProfile() ? "Gestionar cierres" : "Pedir cierre";
  $("addDebtBtn").classList.toggle("hidden", !isAdminProfile());
  $("advanceBox")?.classList.toggle("hidden", isAdminProfile());
}

function closureRemaining(item) {
  const original = Number(item.settlementAmount || item.requestedAmount || 0);
  const paid = Number(item.paidAmountTotal || 0);
  return Math.max(0, Number(item.remainingAmount ?? (original - paid)) || 0);
}

function renderAdminClosures() {
  if (!isAdminProfile()) return;
  const box = $("adminClosureList");
  const pending = closures.filter(item =>
    item.direction === "explora_pays_driver" && closureRemaining(item) > 0 && item.status !== "completed"
  );
  const driverPayments = closures.filter(item => item.direction === "driver_pays_explora").slice(0, 6);

  const pendingHtml = pending.length ? pending.map(item => `
    <article class="admin-closure-card pending">
      <div class="admin-closure-top">
        <div><small>Cobrar a Explora</small><strong>${escapeHtml(item.operatorName || "Chofer")}</strong></div>
        <b>${money(closureRemaining(item))}</b>
      </div>
      <p>Explora debe pagar este saldo al chofer. Puede abonarlo completo o parcialmente.</p>
      <button type="button" class="admin-proof-button" data-admin-closure="${escapeHtml(item.id)}">Pagar y subir comprobante</button>
    </article>`).join("") : `<div class="admin-empty">No hay pagos pendientes de Explora.</div>`;

  const receivedHtml = driverPayments.length ? `
    <div class="admin-history-title">Pagos recibidos de choferes</div>
    ${driverPayments.map(item => `
      <article class="admin-closure-card received">
        <div class="admin-closure-top">
          <div><small>Ajuste del chofer</small><strong>${escapeHtml(item.operatorName || "Chofer")}</strong></div>
          <b>${money(item.paidAmountTotal || item.settlementAmount || 0)}</b>
        </div>
        ${item.proofUrl ? `<a class="proof admin-proof-link" target="_blank" rel="noopener" href="${item.proofUrl}">Ver comprobante</a>` : ""}
      </article>`).join("")}` : "";

  box.innerHTML = pendingHtml + receivedHtml;
  box.querySelectorAll("[data-admin-closure]").forEach(button => {
    button.addEventListener("click", () => openAdminPayment(button.dataset.adminClosure));
  });
}

function subscribeClosures(user) {
  if (unsubscribeClosures) unsubscribeClosures();
  const baseRef = collection(db, ROOT_COLLECTIONS.closures);

  if (isAdminProfile()) {
    unsubscribeClosures = onSnapshot(baseRef, snap => {
      closures = snap.docs.map(d => normalizeClosureRecord(d.id, d.data())).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a));
      render();
      renderAdminClosures();
    }, err => {
      console.error("Firestore cierres_semanales snapshot error:", err);
      $("adminClosureList").innerHTML = `<div class="admin-empty error">No se pudieron cargar los cierres.</div>`;
    });
    return;
  }

  const uid = user.uid;
  loadOwnedHistory(ROOT_COLLECTIONS.closures, uid).then(rows => {
    const merged = mergeOwnedRows(ROOT_COLLECTIONS.closures, uid, canonicalRows(ROOT_COLLECTIONS.closures, uid));
    closures = merged.map(row => normalizeClosureRecord(row.id, row)).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a));
    render();
  }).catch(err => console.warn("EXPLORA_HISTORY_LOAD cierres", err));

  unsubscribeClosures = onSnapshot(ownedQuery(ROOT_COLLECTIONS.closures, uid), snap => {
    const canon = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    setCanonicalRows(ROOT_COLLECTIONS.closures, uid, canon);
    const merged = mergeOwnedRows(ROOT_COLLECTIONS.closures, uid, canon);
    closures = merged.map(row => normalizeClosureRecord(row.id, row)).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a));
    render();
  }, err => console.error("Firestore cierres_semanales snapshot error:", err));
}

$("loginPasswordToggle")?.addEventListener("click", () => {
  const input = $("pass");
  const button = $("loginPasswordToggle");
  if (!input || !button) return;
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  button.textContent = showing ? "Ver" : "Ocultar";
});

$("loginForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  $("loginStatus").textContent = "";
  $("loginStatus").className = "status";
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Ingresando…";
  try {
    const usernameOrEmail = $("user").value.trim();
    const password = $("pass").value;
    if (!usernameOrEmail || !password) {
      throw Object.assign(new Error("Faltan credenciales"), { code: "auth/invalid-credential" });
    }
    startSplash();
    await waitForAuthReady();
    await signInFromLogin(usernameOrEmail, password);
  } catch (err) {
    console.error(err);
    await finishSplash("loginScreen");
    $("loginStatus").textContent = loginErrorMessage(err);
    $("loginStatus").className = "status error";
  } finally {
    $("loginBtn").disabled = false;
    $("loginBtn").textContent = "Ingresar";
  }
});

$("logoutBtn")?.addEventListener("click", async () => {
  startSplash();
  try {
    await signOut(auth);
  } catch (err) {
    console.error(err);
    await finishSplash("app");
  }
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    if (unsubscribePayments) unsubscribePayments();
    if (unsubscribeExpenses) unsubscribeExpenses();
    if (unsubscribeUber) unsubscribeUber();
    if (unsubscribeClosures) unsubscribeClosures();
    if (unsubscribeDebts) unsubscribeDebts();
    if (unsubscribeDebtPayments) unsubscribeDebtPayments();
    if (unsubscribeAdvances) unsubscribeAdvances();
    payments = [];
    expenses = [];
    uberClosures = [];
    closures = [];
    debts = [];
    advances = [];
    advancesLoaded = false;
    currentProfile = null;
    await finishSplash("loginScreen");
    return;
  }

  // Authentication ya fue validada. Mostramos la caja inmediatamente para
  // que una lectura lenta o una regla pendiente de Firestore no expulse al usuario.
  currentProfile = fallbackProfile(user);
  $("operatorName").textContent = `Hola ${currentProfile.displayName || currentProfile.username || user.email?.split("@")[0] || "Chofer"}`;
  subscribeToday(user);
  applyRoleUI();
  subscribeClosures(user);
  await finishSplash("app");

  try {
    currentProfile = await loadProfile(user);
    if (currentProfile.active === false) {
      await signOut(auth);
      $("loginStatus").textContent = "Este usuario está desactivado.";
      $("loginStatus").className = "status error";
      return;
    }
    $("operatorName").textContent = `Hola ${currentProfile.displayName || currentProfile.username || user.email.split("@")[0]}`;
    applyRoleUI();
    subscribeClosures(user);
  } catch (err) {
    console.warn("Se inició sesión usando el perfil básico:", err);
    $("syncStatus").textContent = "Sesión activa · revisando datos";
    $("syncStatus").className = "sync warn";
  }
});

document.querySelectorAll("[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    $("chargeForm").reset();
    $("chargeMode").value = mode;
    $("chargeModal").dataset.tone = mode;
    $("chargeTitle").textContent = mode === "cash" ? "Cobro en efectivo" : "Cobro digital";
    $("proofField").classList.toggle("hidden", mode !== "digital");
    $("proof").required = mode === "digital";
    $("chargeStatus").textContent = "";
    $("chargeStatus").className = "status";
    $("chargeModal").classList.remove("hidden");
  });
});

document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => $(btn.dataset.close).classList.add("hidden"));
});

$("compensateDebtBtn")?.addEventListener("click", openDebtCompensationModal);

$("confirmDebtCompensation")?.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;

  // Se vuelve a calcular al confirmar para no utilizar un saldo desactualizado.
  const model = settlementModel();
  const amount = model.compensationAvailable;
  if (amount <= 0.5) {
    $("debtCompensationStatus").textContent = "Ya no hay saldo disponible para compensar.";
    $("debtCompensationStatus").className = "status error";
    return;
  }

  const remainingBalance = Math.max(0, model.balance - amount);
  const remainingReimbursement = Math.max(0, model.expenseReimbursement - amount);
  const button = $("confirmDebtCompensation");
  button.disabled = true;
  button.textContent = "Compensando…";
  $("debtCompensationStatus").textContent = "";

  try {
    // El identificador determinístico evita que dos dispositivos registren
    // dos veces la misma compensación antes de recibir la actualización.
    const compensationId = [
      "balance_comp",
      localDayKey(),
      Math.round(model.balance),
      Math.round(model.expenseHalf),
      Math.round(model.reimbursementApplied)
    ].join("_");
    const compensationRef = doc(db, ROOT_COLLECTIONS.payments, compensationId);
    await setDoc(compensationRef, {
      method: "digital",
      paymentMethod: "internal_compensation",
      type: "reimbursement_compensation",
      internalSettlementAdjustment: true,
      excludeFromBillingSettlement: true,
      suppressTelegram: true,
      amount,
      monto: amount,
      service: "Reintegro aplicado",
      detail: `Se utilizaron ${money(amount)} del reintegro de gastos para reducir la diferencia Chofer–Explora. Saldo restante: ${money(remainingBalance)}.`,
      compensationSource: "expense_reimbursement",
      reimbursementBefore: model.expenseReimbursement,
      reimbursementAfter: remainingReimbursement,
      settlementBefore: model.balance,
      settlementAfter: remainingBalance,
      internalReceipt: true,
      proofUrl: "",
      proofPath: "",
      dayKey: localDayKey(),
      operatorUid: user.uid,
      operatorName: currentDriverName(),
      driverUid: user.uid,
      choferUid: user.uid,
      uid: user.uid,
      driverName: currentDriverName(),
      businessId: BUSINESS_ID,
      weeklyPeriodId: currentWeeklyPeriodId(),
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });

    $("debtCompensationStatus").textContent = `Se aplicaron ${money(amount)} para reducir la diferencia Chofer–Explora.`;
    $("debtCompensationStatus").className = "status success";
    setTimeout(() => $("debtCompensationModal").classList.add("hidden"), 1200);
  } catch (err) {
    console.error(err);
    if (err?.code === "permission-denied") {
      $("debtCompensationStatus").textContent = "Esta compensación ya fue registrada. Actualizando los saldos…";
      $("debtCompensationStatus").className = "status success";
      setTimeout(() => $("debtCompensationModal").classList.add("hidden"), 1200);
    } else {
      $("debtCompensationStatus").textContent = "No se pudo compensar la diferencia. Intentá nuevamente.";
      $("debtCompensationStatus").className = "status error";
      button.disabled = false;
      button.textContent = "OK, compensar";
    }
  }
});

$("requestAdvanceBtn")?.addEventListener("click", openAdvanceModal);
$("advanceAmount")?.addEventListener("input", renderAdvanceQuote);

$("advanceForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || isAdminProfile()) return;

  const principal = parseMoneyInput($("advanceAmount").value);
  const quote = advanceQuote(principal);
  if (!principal || principal <= 0) {
    $("advanceStatus").textContent = "Ingresá el monto que querés recibir.";
    $("advanceStatus").className = "status error";
    return;
  }
  if (principal > ADVANCE_MAX_AMOUNT) {
    $("advanceStatus").textContent = `El adelanto máximo es de ${money(ADVANCE_MAX_AMOUNT)}.`;
    $("advanceStatus").className = "status error";
    return;
  }

  // La elegibilidad se valida solamente al confirmar, tal como se informa
  // en el formulario. El chofer puede completar y revisar antes la cotización.
  const model = settlementModel();
  const difference = Math.abs(model.balance);
  if (difference >= ADVANCE_DIFFERENCE_LIMIT) {
    $("advanceStatus").textContent = model.balance > 0
      ? `Actualmente le debés ${money(difference)} a Explora. Reducí esa diferencia por debajo de ${money(ADVANCE_DIFFERENCE_LIMIT)} y volvé a solicitar el adelanto.`
      : `La diferencia actual entre Chofer y Explora es de ${money(difference)}. Debe ser menor a ${money(ADVANCE_DIFFERENCE_LIMIT)} para solicitar un adelanto.`;
    $("advanceStatus").className = "status error";
    return;
  }

  const button = $("confirmAdvanceBtn");
  button.disabled = true;
  button.textContent = "Solicitando…";
  $("advanceStatus").textContent = "";

  try {
    const advancesRef = collection(db, ROOT_COLLECTIONS.advances);
    await addDoc(advancesRef, {
      type: "cash_advance",
      loanType: "cash_advance",
      driverUid: user.uid,
      choferUid: user.uid,
      uid: user.uid,
      driverId: user.uid,
      driverName: currentDriverName(),
      amount: quote.principal,
      originalAmount: quote.principal,
      principalAmount: quote.principal,
      interestPercent: 40,
      interestAmount: quote.interest,
      totalDebt: quote.total,
      remainingAmount: quote.total,
      repaidAmount: 0,
      status: "active",
      differenceAtRequest: difference,
      requestedDayKey: localDayKey(),
      weeklyPeriodId: currentWeeklyPeriodId(),
      operatorUid: user.uid,
      operatorName: currentDriverName(),
      businessId: BUSINESS_ID,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    $("advanceStatus").textContent = `Adelanto solicitado: recibís ${money(quote.principal)} y devolvés ${money(quote.total)} sin vencimiento.`;
    $("advanceStatus").className = "status success";
    setTimeout(() => $("advanceModal").classList.add("hidden"), 1700);
  } catch (err) {
    console.error(err);
    $("advanceStatus").textContent = "No se pudo registrar el adelanto. Intentá nuevamente.";
    $("advanceStatus").className = "status error";
    button.disabled = false;
    button.textContent = "Confirmar adelanto";
  }
});

$("chargeForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;
  const mode = $("chargeMode").value;
  const service = mode === "cash" ? "Cobro en efectivo" : "Cobro digital";
  const amount = parseMoneyInput($("chargeAmount").value);
  const file = $("proof").files?.[0];

  if (!amount || amount <= 0) {
    $("chargeStatus").textContent = "Ingresá un importe válido.";
    $("chargeStatus").className = "status error";
    return;
  }

  if (mode === "digital" && !file) {
    $("chargeStatus").textContent = "Adjuntá el comprobante del cobro digital.";
    $("chargeStatus").className = "status error";
    return;
  }
  if (mode === "digital" && !advancesLoaded) {
    $("chargeStatus").textContent = "Esperá un momento mientras se actualiza el saldo de adelantos.";
    $("chargeStatus").className = "status error";
    return;
  }

  $("saveChargeBtn").disabled = true;
  $("saveChargeBtn").textContent = "Guardando…";
  $("chargeStatus").textContent = "";

  try {
    let proofUrl = "";
    let proofPath = "";
    if (mode === "digital" && file) {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
      proofPath = `billing_receipts/${user.uid}/${localDayKey()}/${Date.now()}_${cleanName}`;
      const storageRef = ref(storage, proofPath);
      await uploadBytes(storageRef, file);
      proofUrl = await getDownloadURL(storageRef);
    }

    const paymentsRef = collection(db, ROOT_COLLECTIONS.payments);
    const paymentRef = doc(paymentsRef);
    const enteredDetail = $("detail").value.trim();
    const candidateAdvanceRefs = mode === "digital"
      ? advances
          .filter(item => advanceRemaining(item) > 0.5)
          .map(item => doc(db, ROOT_COLLECTIONS.advances, item.id))
      : [];

    // La transacción vuelve a leer los adelantos antes de descontarlos. Así,
    // dos cobros simultáneos no pueden pisarse ni perder una devolución.
    await runTransaction(db, async transaction => {
      const freshAdvances = [];
      for (const advanceRef of candidateAdvanceRefs) {
        const snap = await transaction.get(advanceRef);
        if (snap.exists()) freshAdvances.push({ id: snap.id, ...snap.data() });
      }

      const repaymentPlan = mode === "digital"
        ? planAdvanceRepayment(Math.floor(amount * 0.50), freshAdvances)
        : { allocations: [], totalApplied: 0 };
      const paymentDetail = [
        enteredDetail,
        repaymentPlan.totalApplied > 0.5 ? `Aplicado al adelanto: ${money(repaymentPlan.totalApplied)}` : ""
      ].filter(Boolean).join(" · ");

      transaction.set(paymentRef, {
        method: mode,
        paymentMethod: mode === "cash" ? "cash" : "digital",
        metodoPago: mode === "cash" ? "cash" : "digital",
        financialCategory: mode === "cash" ? "cash" : "digital",
        type: mode === "cash" ? "billing" : "payment",
        amount,
        monto: amount,
        valor: amount,
        finalPrice: amount,
        service,
        serviceDescription: service,
        detail: paymentDetail,
        notes: paymentDetail,
        advanceRepaymentAmount: repaymentPlan.totalApplied,
        advanceAllocations: repaymentPlan.allocations.map(item => ({
          advanceId: item.id,
          amount: item.applied
        })),
        proofUrl,
        proofPath,
        receiptUrl: proofUrl,
        receiptPath: proofPath,
        receiptRequired: mode === "digital",
        dayKey: localDayKey(),
        weeklyPeriodId: currentWeeklyPeriodId(),
        operatorUid: user.uid,
        operatorName: currentDriverName(),
        driverUid: user.uid,
        choferUid: user.uid,
        uid: user.uid,
        ownerUid: user.uid,
        driverId: user.uid,
        driverName: currentDriverName(),
        status: "completed",
        source: "barberia-main-migrated",
        createdAtMs: Date.now(),
        businessId: BUSINESS_ID,
        createdAt: serverTimestamp()
      });
      repaymentPlan.allocations.forEach(item => {
        const advanceRef = doc(db, ROOT_COLLECTIONS.advances, item.id);
        transaction.update(advanceRef, {
          remainingAmount: item.remainingAmount,
          repaidAmount: item.repaidAmount,
          status: item.status,
          updatedAt: serverTimestamp()
        });
      });
    });

    $("chargeStatus").textContent = mode === "cash"
      ? "Cobro en efectivo registrado correctamente."
      : "Cobro digital registrado correctamente.";
    $("chargeStatus").className = "status success";
    $("chargeForm").reset();
    await new Promise(resolve => setTimeout(resolve, 1100));
    $("chargeModal").classList.add("hidden");
  } catch (err) {
    console.error(err);
    $("chargeStatus").textContent = "No se pudo registrar el cobro.";
    $("chargeStatus").className = "status error";
  } finally {
    $("saveChargeBtn").disabled = false;
    $("saveChargeBtn").textContent = "Registrar cobro";
  }
});

$("addExpenseBtn")?.addEventListener("click", () => {
  $("expenseForm").reset();
  $("expenseStatus").textContent = "";
  $("expenseStatus").className = "status";
  $("expenseModal").classList.remove("hidden");
});

$("addDebtBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  $("debtForm").reset();
  $("debtStatus").textContent = "";
  $("debtStatus").className = "status";
  $("debtModal").classList.remove("hidden");
});

$("debtForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;

  const amount = parseMoneyInput($("debtAmount").value);
  const detail = $("debtDetail").value.trim();
  const file = $("debtProof").files?.[0];

  if (!amount || amount <= 0) {
    $("debtStatus").textContent = "Ingresá un importe válido.";
    $("debtStatus").className = "status error";
    return;
  }
  if (!detail) {
    $("debtStatus").textContent = "Indicá el motivo de la deuda.";
    $("debtStatus").className = "status error";
    return;
  }

  $("saveDebtBtn").disabled = true;
  $("saveDebtBtn").textContent = "Guardando…";
  $("debtStatus").textContent = "";

  try {
    let proofUrl = "";
    let proofPath = "";
    if (file) {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
      proofPath = `deudas/${admin.uid}/${localDayKey()}_${Date.now()}_${cleanName}`;
      const storageRef = ref(storage, proofPath);
      await uploadBytes(storageRef, file);
      proofUrl = await getDownloadURL(storageRef);
    }

    const debtsRef = collection(db, ROOT_COLLECTIONS.debts);
    await addDoc(debtsRef, {
      type: "admin_debt",
      debtType: "admin_debt",
      amount,
      totalAmount: amount,
      remainingAmount: amount,
      saldoPendiente: amount,
      paidAmount: 0,
      amountPaid: 0,
      detail,
      reason: detail,
      notes: detail,
      proofUrl,
      proofPath,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      dayKey: localDayKey(),
      driverUid: admin.uid,
      choferUid: admin.uid,
      uid: admin.uid,
      driverId: admin.uid,
      driverName: currentDriverName(),
      sourceModule: "pendientes",
      status: "active",
      debtStatus: "active",
      createdByRole: "admin",
      businessId: BUSINESS_ID,
      createdByUid: admin.uid,
      createdByName: currentDriverName() || "Administrador",
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });

    $("debtModal").classList.add("hidden");
  } catch (err) {
    console.error(err);
    $("debtStatus").textContent = "No se pudo registrar la deuda.";
    $("debtStatus").className = "status error";
  } finally {
    $("saveDebtBtn").disabled = false;
    $("saveDebtBtn").textContent = "Registrar deuda";
  }
});

$("expenseForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;

  const amount = parseMoneyInput($("expenseAmount").value);
  const detail = $("expenseDetail").value.trim();
  const file = $("expenseProof").files?.[0];

  if (!amount || amount <= 0) {
    $("expenseStatus").textContent = "Ingresá un importe válido.";
    $("expenseStatus").className = "status error";
    return;
  }
  if (!detail) {
    $("expenseStatus").textContent = "Indicá el motivo del gasto.";
    $("expenseStatus").className = "status error";
    return;
  }
  if (!file) {
    $("expenseStatus").textContent = "Adjuntá el comprobante del gasto.";
    $("expenseStatus").className = "status error";
    return;
  }

  $("saveExpenseBtn").disabled = true;
  $("saveExpenseBtn").textContent = "Guardando…";
  $("expenseStatus").textContent = "";

  try {
    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const proofPath = `gastos/${user.uid}/expense_${Date.now()}/comprobante_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    const expensesRef = collection(db, ROOT_COLLECTIONS.expenses);
    // El resumen se informa por Telegram, no se agrega un panel nuevo en la app.
    // Se guarda el mismo cálculo que usa la interfaz para garantizar que ambos coincidan.
    const expenseBefore = expensesTotal();
    const reimbursementAppliedBefore = reimbursementCompensationTotal();
    const accumulatedTotal = expenseBefore + amount;
    const exploraReimbursement = Math.max(0, accumulatedTotal * 0.50 - reimbursementAppliedBefore);

    await addDoc(expensesRef, {
      amount,
      monto: amount,
      detail,
      notes: detail,
      expenseType: "otros",
      tipo: "otros",
      category: "otros",
      proofUrl,
      proofPath,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      dayKey: localDayKey(),
      weeklyPeriodId: currentWeeklyPeriodId(),
      operatorUid: user.uid,
      operatorName: currentDriverName(),
      driverUid: user.uid,
      choferUid: user.uid,
      uid: user.uid,
      ownerUid: user.uid,
      driverId: user.uid,
      choferId: user.uid,
      driverName: currentDriverName(),
      choferNombre: currentDriverName(),
      payerRole: "driver",
      sharedRate: 0.5,
      porcentajeCompartido: 50,
      // Snapshot para la notificación de Telegram. Coincide con "Total a reintegrar por Explora".
      telegramExpenseLoadedAmount: amount,
      telegramExpenseAccumulatedTotal: accumulatedTotal,
      telegramExploraReimbursement: exploraReimbursement,
      status: "active",
      createdAtMs: Date.now(),
      businessId: BUSINESS_ID,
      createdAt: serverTimestamp()
    });

    $("expenseStatus").textContent = "Gasto registrado correctamente.";
    $("expenseStatus").className = "status success";
    $("expenseForm").reset();
    await new Promise(resolve => setTimeout(resolve, 1100));
    $("expenseModal").classList.add("hidden");
  } catch (err) {
    console.error(err);
    $("expenseStatus").textContent = "No se pudo registrar el gasto.";
    $("expenseStatus").className = "status error";
  } finally {
    $("saveExpenseBtn").disabled = false;
    $("saveExpenseBtn").textContent = "Registrar gasto";
  }
});

$("addUberBtn")?.addEventListener("click", () => {
  $("uberForm").reset();
  $("uberStatus").textContent = "";
  $("uberStatus").className = "status";
  renderUberWeekSelector();
  $("uberModal").classList.remove("hidden");
});

$("uberWeekSelect")?.addEventListener("change", updateUberWeekSummary);

$("uberForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;

  const amount = parseMoneyInput($("uberAmount").value);
  const week = selectedPendingUberWeek();
  const file = $("uberProof").files?.[0];

  if (!week) {
    $("uberStatus").textContent = "Elegí una semana cerrada pendiente.";
    $("uberStatus").className = "status error";
    renderUberWeekSelector();
    return;
  }
  if (!amount || amount <= 0) {
    $("uberStatus").textContent = "Ingresá el total semanal de Uber.";
    $("uberStatus").className = "status error";
    return;
  }
  if (!file) {
    $("uberStatus").textContent = `Adjuntá el comprobante de la semana ${week.label}.`;
    $("uberStatus").className = "status error";
    return;
  }

  $("saveUberBtn").disabled = true;
  $("saveUberBtn").textContent = "Guardando…";
  $("uberStatus").textContent = "";

  try {
    // Se usa una identificación determinística para impedir que la misma
    // semana se cargue dos veces, incluso desde dos dispositivos distintos.
    const uberDocumentId = `uber_${user.uid}_${week.weekKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const uberDocRef = doc(db, ROOT_COLLECTIONS.uber, uberDocumentId);
    const existing = await getDoc(uberDocRef);
    if (existing.exists() || isUberWeekLoaded(week)) {
      $("uberStatus").textContent = `La semana ${week.label} ya tiene comprobante.`;
      $("uberStatus").className = "status error";
      renderUberWeekSelector();
      return;
    }

    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const proofPath = `uber_weekly/${user.uid}/${week.weekKey}/${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file, {
      contentType: file.type || "image/jpeg",
      customMetadata: {
        module: "uber_weekly",
        driverUid: user.uid,
        weekId: week.weekKey,
        uploadedByUid: user.uid
      }
    });
    const proofUrl = await getDownloadURL(storageRef);

    await setDoc(uberDocRef, {
      closureId: uberDocumentId,
      weekId: week.weekKey,
      weekKey: week.weekKey,
      weekLabel: week.label,
      weekStartDate: week.weekStartDate,
      weekCloseDate: week.weekCloseDate,
      weekStartMs: parseLocalDateKey(week.weekStartDate)?.getTime() || Date.now(),
      weekEndMs: parseLocalDateKey(week.weekCloseDate)?.getTime() || Date.now(),
      grossAmount: amount,
      totalAmount: amount,
      amount,
      driverShare: amount * 0.50,
      driverNetAmount: amount * 0.50,
      exploraShare: amount * 0.50,
      debtAmount: amount * 0.50,
      cashboxRate: 0.05,
      cashboxAmount: amount * 0.05,
      uberCashboxAmount: amount * 0.05,
      proofUrl,
      proofPath,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      notificationPhotoUrl: proofUrl,
      telegramPhotoUrl: proofUrl,
      firebasePhotoUrl: proofUrl,
      dayKey: localDayKey(),
      driverUid: user.uid,
      choferUid: user.uid,
      uid: user.uid,
      driverId: user.uid,
      createdByUid: user.uid,
      createdByRole: "driver",
      driverName: currentDriverName(),
      operatorUid: user.uid,
      operatorName: currentDriverName(),
      reviewStatus: "pending",
      status: "pending_review",
      locked: true,
      businessId: BUSINESS_ID,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    // Reflejo inmediato: permite continuar con la siguiente semana atrasada
    // sin esperar la confirmación visual del listener de Firestore.
    const savedAt = new Date();
    uberClosures = [{
      id: week.weekKey,
      amount,
      weekStartDate: week.weekStartDate,
      weekCloseDate: week.weekCloseDate,
      weekKey: week.weekKey,
      weekLabel: week.label,
      proofUrl,
      proofPath,
      dayKey: localDayKey(),
      operatorUid: user.uid,
      operatorName: currentProfile?.displayName || currentProfile?.username || "",
      businessId: BUSINESS_ID,
      createdAt: { toMillis: () => savedAt.getTime(), toDate: () => savedAt }
    }, ...uberClosures.filter(item => item.id !== week.weekKey)];
    render();

    $("uberAmount").value = "";
    $("uberProof").value = "";
    renderUberWeekSelector();
    const remaining = pendingUberWeeks().length;
    $("uberStatus").textContent = remaining
      ? `Comprobante de ${week.label} guardado. Quedan ${remaining} ${remaining === 1 ? "semana pendiente" : "semanas pendientes"}.`
      : `Comprobante de ${week.label} guardado. Ya no quedan semanas pendientes.`;
    $("uberStatus").className = "status success";
    if (!remaining) setTimeout(() => $("uberModal").classList.add("hidden"), 1300);
  } catch (err) {
    console.error(err);
    $("uberStatus").textContent = err?.code === "permission-denied"
      ? "Esa semana ya fue registrada o no tenés permiso para volver a cargarla."
      : "No se pudo registrar el comprobante de Uber.";
    $("uberStatus").className = "status error";
  } finally {
    $("saveUberBtn").disabled = pendingUberWeeks().length === 0;
    $("saveUberBtn").textContent = "Registrar Uber";
  }
});

function resetDriverClose() {
  selectedCloseDirection = "";
  $("driverCloseForm").reset();
  $("driverCloseForm").classList.add("hidden");
  $("driverCloseAmountField").classList.add("hidden");
  $("driverCloseProofField").classList.add("hidden");
  $("adminProofNotice").classList.add("hidden");
  $("driverCloseProof").required = false;
  $("closeStatus").textContent = "";
  $("closeStatus").className = "status";
  document.querySelectorAll(".close-choice").forEach(button => button.classList.remove("selected"));
}

function prepareDriverClose() {
  resetDriverClose();
  const model = settlementModel();
  const payButton = $("choosePayExplora");
  const collectButton = $("chooseCollectExplora");

  if (model.from === "balanced") {
    $("closeBalanceMessage").innerHTML = `<strong>Las cuentas ya están equilibradas.</strong><span>No hay ningún importe pendiente.</span>`;
    payButton.disabled = true;
    collectButton.disabled = true;
    return;
  }

  if (model.from === "cash") {
    $("closeBalanceMessage").innerHTML = `<strong>Debe pagar a Explora ${money(model.amount)}.</strong><span>Ese es el total necesario para que ambos queden equilibrados.</span>`;
    payButton.disabled = false;
    collectButton.disabled = true;
    payButton.classList.add("required-action");
    collectButton.classList.remove("required-action");
  } else {
    $("closeBalanceMessage").innerHTML = `<strong>Debe cobrar a Explora ${money(model.amount)}.</strong><span>Ese es el total necesario para que ambos queden equilibrados.</span>`;
    payButton.disabled = true;
    collectButton.disabled = false;
    collectButton.classList.add("required-action");
    payButton.classList.remove("required-action");
  }
}

function selectDriverClose(direction) {
  const model = settlementModel();
  const expected = model.from === "cash" ? "driver_to_explora" : model.from === "digital" ? "explora_to_driver" : "";
  if (!expected || direction !== expected) return;

  selectedCloseDirection = direction;
  $("driverCloseForm").reset();
  $("driverCloseForm").classList.remove("hidden");
  $("closeStatus").textContent = "";
  $("closeStatus").className = "status";
  document.querySelectorAll(".close-choice").forEach(button => button.classList.remove("selected"));

  if (direction === "driver_to_explora") {
    $("choosePayExplora").classList.add("selected");
    $("driverCloseSelected").innerHTML = `<small>Pagar a Explora</small><strong>${money(model.amount)} pendientes</strong><span>Podés pagar el total o ingresar un importe menor.</span>`;
    setMoneyInput("driverCloseAmount", model.amount);
    $("driverCloseLimit").textContent = `Máximo disponible: ${money(model.amount)}.`;
    $("driverCloseAmountField").classList.remove("hidden");
    $("driverCloseProofField").classList.remove("hidden");
    $("driverCloseProof").required = true;
    $("adminProofNotice").classList.add("hidden");
    $("confirmClose").textContent = "Registrar pago";
  } else {
    $("chooseCollectExplora").classList.add("selected");
    $("driverCloseSelected").innerHTML = `<small>Cobrar a Explora</small><strong>${money(model.amount)} pendientes</strong><span>El administrador decidirá si paga el total o un importe parcial.</span>`;
    $("driverCloseAmountField").classList.add("hidden");
    $("driverCloseProofField").classList.add("hidden");
    $("driverCloseProof").required = false;
    $("adminProofNotice").classList.remove("hidden");
    $("confirmClose").textContent = "Solicitar cobro";
  }
}

function openAdminPayment(closureId) {
  const item = closures.find(closure => closure.id === closureId);
  if (!item) return;
  const remaining = closureRemaining(item);
  if (remaining <= 0) return;

  selectedAdminClosureId = closureId;
  $("adminClosureId").value = closureId;
  $("adminPaymentForm").reset();
  setMoneyInput("adminPaymentAmount", remaining);
  $("adminPaymentLimit").textContent = `Saldo máximo: ${money(remaining)}.`;
  $("adminPaymentSummary").innerHTML = `<small>Explora paga a</small><strong>${escapeHtml(item.operatorName || "Chofer")} · ${money(remaining)}</strong><span>Podés abonar el total o un importe menor.</span>`;
  $("adminPaymentStatus").textContent = "";
  $("adminPaymentStatus").className = "status";
  $("adminClosureList").classList.add("hidden");
  $("adminPaymentForm").classList.remove("hidden");
}

$("closeDayBtn")?.addEventListener("click", () => {
  render();
  $("closeModal").classList.remove("hidden");
  if (isAdminProfile()) {
    $("closeModalTitle").textContent = "Gestionar cierres";
    $("closeDriverView").classList.add("hidden");
    $("closeAdminView").classList.remove("hidden");
    $("adminPaymentForm").classList.add("hidden");
    $("adminClosureList").classList.remove("hidden");
    selectedAdminClosureId = "";
    renderAdminClosures();
  } else {
    $("closeModalTitle").textContent = "Pedir cierre";
    $("closeAdminView").classList.add("hidden");
    $("closeDriverView").classList.remove("hidden");
    prepareDriverClose();
  }
});

$("choosePayExplora")?.addEventListener("click", () => selectDriverClose("driver_to_explora"));
$("chooseCollectExplora")?.addEventListener("click", () => selectDriverClose("explora_to_driver"));
$("driverUseFullAmount")?.addEventListener("click", () => {
  const model = settlementModel();
  setMoneyInput("driverCloseAmount", model.amount);
});

$("driverCloseForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !selectedCloseDirection || isAdminProfile()) return;

  const model = settlementModel();
  const expected = model.from === "cash" ? "driver_to_explora" : model.from === "digital" ? "explora_to_driver" : "";
  if (expected !== selectedCloseDirection) {
    $("closeStatus").textContent = "El saldo cambió. Volvé a abrir el cierre para recalcularlo.";
    $("closeStatus").className = "status error";
    return;
  }

  const isDriverPayment = selectedCloseDirection === "driver_to_explora";
  const amount = isDriverPayment ? parseMoneyInput($("driverCloseAmount").value) : model.amount;
  const file = $("driverCloseProof").files?.[0];
  if (!amount || amount <= 0 || amount > model.amount + 0.5) {
    $("closeStatus").textContent = `Ingresá un importe entre $1 y ${money(model.amount)}.`;
    $("closeStatus").className = "status error";
    return;
  }
  if (isDriverPayment && !file) {
    $("closeStatus").textContent = "Adjuntá el comprobante del pago a Explora.";
    $("closeStatus").className = "status error";
    return;
  }
  if (!isDriverPayment) {
    const alreadyPending = closures.some(item =>
      item.operatorUid === user.uid && item.direction === "explora_pays_driver" && closureRemaining(item) > 0 && item.status !== "completed"
    );
    if (alreadyPending) {
      $("closeStatus").textContent = "Ya tenés un cobro pendiente de Explora.";
      $("closeStatus").className = "status error";
      return;
    }
  }

  $("confirmClose").disabled = true;
  $("confirmClose").textContent = isDriverPayment ? "Guardando pago…" : "Enviando pedido…";
  try {
    const closureRef = doc(collection(db, ROOT_COLLECTIONS.closures));
    let proofUrl = "";
    let proofPath = "";
    const remainingAmount = Math.max(0, model.amount - amount);

    if (isDriverPayment) {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
      proofPath = `cierres_semanales/${currentWeeklyPeriodId()}/${user.uid}/${closureRef.id}_${Date.now()}_${cleanName}`;
      const storageRef = ref(storage, proofPath);
      await uploadBytes(storageRef, file);
      proofUrl = await getDownloadURL(storageRef);

      const paymentRef = doc(collection(db, ROOT_COLLECTIONS.payments));
      const candidateAdvanceRefs = advances
        .filter(item => advanceRemaining(item) > 0.5)
        .map(item => doc(db, ROOT_COLLECTIONS.advances, item.id));
      await runTransaction(db, async transaction => {
        const freshAdvances = [];
        for (const advanceRef of candidateAdvanceRefs) {
          const snap = await transaction.get(advanceRef);
          if (snap.exists()) freshAdvances.push({ id: snap.id, ...snap.data() });
        }
        const repaymentPlan = planAdvanceRepayment(amount, freshAdvances);
        const baseDetail = remainingAmount <= 0.5 ? "Pago total a Explora" : "Pago parcial a Explora";
        const detail = [
          baseDetail,
          repaymentPlan.totalApplied > 0.5 ? `Aplicado al adelanto: ${money(repaymentPlan.totalApplied)}` : ""
        ].filter(Boolean).join(" · ");

        transaction.set(paymentRef, {
          // En la UI nueva se muestra como movimiento digital; para el backend histórico
          // es un pago de liquidación por transferencia, con comprobante obligatorio.
          method: "digital",
          paymentMethod: "transfer",
          metodoPago: "transfer",
          financialCategory: "transfer",
          type: "admin_billing_settlement_payment",
          operationType: "admin_billing_settlement_payment",
          movementType: "driver_payment",
          sourceModule: "facturacion",
          affectsBillingSettlement: true,
          adjustmentDirection: "driver_to_explora",
          amount,
          monto: amount,
          previousBillingBalance: model.amount,
          newBillingBalance: remainingAmount,
          advanceRepaymentAmount: repaymentPlan.totalApplied,
          advanceAllocations: repaymentPlan.allocations.map(item => ({
            advanceId: item.id,
            amount: item.applied
          })),
          service: "Ajuste del chofer",
          notes: detail,
          detail,
          proofUrl,
          proofPath,
          receiptUrl: proofUrl,
          receiptPath: proofPath,
          closureId: closureRef.id,
          dayKey: localDayKey(),
          weeklyPeriodId: currentWeeklyPeriodId(),
          driverUid: user.uid,
          choferUid: user.uid,
          uid: user.uid,
          ownerUid: user.uid,
          driverId: user.uid,
          driverName: currentDriverName(),
          operatorUid: user.uid,
          operatorName: currentProfile?.displayName || currentProfile?.username || "",
          businessId: BUSINESS_ID,
          createdAtMs: Date.now(),
          createdAt: serverTimestamp()
        });
        const closureNowMs = Date.now();
        transaction.set(closureRef, {
          direction: "driver_pays_explora",
          paymentDirection: "driver_to_explora",
          requestedAmount: model.amount,
          settlementAmount: model.amount,
          paidAmountTotal: amount,
          remainingAmount,
          amountDueFromDriver: remainingAmount,
          amountFromDriver: remainingAmount,
          amountDueToDriver: 0,
          amountToDriver: 0,
          gross: model.grand,
          grossAmount: model.grand,
          expenseTotal: model.expense,
          cashboxTotal: model.cashBox,
          proofUrl,
          proofPath,
          receiptUrl: proofUrl,
          receiptPath: proofPath,
          proofUploadedByUid: user.uid,
          proofUploadedByRole: "driver",
          status: remainingAmount <= 0.5 ? "completed" : "partial",
          dayKey: localDayKey(),
          weeklyPeriodId: currentWeeklyPeriodId(),
          closureKind: "facturacion",
          closureType: "facturacion",
          moduleKey: "facturacion",
          payTab: "facturacion",
          billingClosure: true,
          closureMode: "settlement_only",
          autoClosesCashbox: false,
          cashboxClosedWithBilling: false,
          affectsTabs: ["chofer", "explora"],
          cashTotal: model.cash,
          uberTotal: model.uber,
          debtTotal: model.adminDebt + model.advanceDebt,
          advanceDebtTotal: model.advanceDebt,
          advanceRepaidAmount: repaymentPlan.totalApplied,
          cashBox5: model.cashBox,
          digitalTotal: model.digital,
          expensesTotal: model.expense,
          total: model.grand,
          driverUid: user.uid,
          choferUid: user.uid,
          uid: user.uid,
          driverName: currentDriverName(),
          operatorUid: user.uid,
          operatorName: currentProfile?.displayName || currentProfile?.username || "",
          requestedByUid: user.uid,
          requestedByRole: "driver",
          createdByUid: user.uid,
          createdByRole: "driver",
          businessId: BUSINESS_ID,
          cutoffAtMs: closureNowMs,
          requestedAtMs: closureNowMs,
          createdAtMs: closureNowMs,
          requestedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          completedAt: remainingAmount <= 0.5 ? serverTimestamp() : null
        });
        repaymentPlan.allocations.forEach(item => {
          const advanceRef = doc(db, ROOT_COLLECTIONS.advances, item.id);
          transaction.update(advanceRef, {
            remainingAmount: item.remainingAmount,
            repaidAmount: item.repaidAmount,
            status: item.status,
            updatedAt: serverTimestamp()
          });
        });
      });
      $("closeStatus").textContent = remainingAmount <= 0.5
        ? "Pago registrado. Las partes quedaron equilibradas."
        : `Pago parcial registrado. Quedan ${money(remainingAmount)} pendientes.`;
    } else {
      const closureNowMs = Date.now();
      await setDoc(closureRef, {
        direction: "explora_pays_driver",
        paymentDirection: "explora_to_driver",
        requestedAmount: model.amount,
        settlementAmount: model.amount,
        paidAmountTotal: 0,
        remainingAmount: model.amount,
        amountDueFromDriver: 0,
        amountFromDriver: 0,
        amountDueToDriver: model.amount,
        amountToDriver: model.amount,
        gross: model.grand,
        grossAmount: model.grand,
        expenseTotal: model.expense,
        cashboxTotal: model.cashBox,
        status: "awaiting_admin_proof",
        dayKey: localDayKey(),
        weeklyPeriodId: currentWeeklyPeriodId(),
        closureKind: "facturacion",
        closureType: "facturacion",
        moduleKey: "facturacion",
        payTab: "facturacion",
        billingClosure: true,
        closureMode: "settlement_only",
        autoClosesCashbox: false,
        cashboxClosedWithBilling: false,
        affectsTabs: ["chofer", "explora"],
        cashTotal: model.cash,
        uberTotal: model.uber,
        debtTotal: model.adminDebt + model.advanceDebt,
        advanceDebtTotal: model.advanceDebt,
        cashBox5: model.cashBox,
        digitalTotal: model.digital,
        expensesTotal: model.expense,
        total: model.grand,
        driverUid: user.uid,
        choferUid: user.uid,
        uid: user.uid,
        driverName: currentDriverName(),
        operatorUid: user.uid,
        operatorName: currentProfile?.displayName || currentProfile?.username || "",
        requestedByUid: user.uid,
        requestedByRole: "driver",
        createdByUid: user.uid,
        createdByRole: "driver",
        businessId: BUSINESS_ID,
        cutoffAtMs: closureNowMs,
        requestedAtMs: closureNowMs,
        createdAtMs: closureNowMs,
        requestedAt: serverTimestamp(),
        createdAt: serverTimestamp()
      });
      $("closeStatus").textContent = "Cobro solicitado. Falta el pago y comprobante del administrador.";
    }
    $("closeStatus").className = "status success";
    setTimeout(() => $("closeModal").classList.add("hidden"), 1500);
  } catch (err) {
    console.error(err);
    $("closeStatus").textContent = "No se pudo registrar el cierre.";
    $("closeStatus").className = "status error";
  } finally {
    $("confirmClose").disabled = false;
    $("confirmClose").textContent = isDriverPayment ? "Registrar pago" : "Solicitar cobro";
  }
});

$("adminUseFullAmount")?.addEventListener("click", () => {
  const item = closures.find(closure => closure.id === selectedAdminClosureId);
  if (item) setMoneyInput("adminPaymentAmount", closureRemaining(item));
});

$("cancelAdminPayment")?.addEventListener("click", () => {
  selectedAdminClosureId = "";
  $("adminPaymentForm").classList.add("hidden");
  $("adminClosureList").classList.remove("hidden");
  renderAdminClosures();
});

$("adminPaymentForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile() || !selectedAdminClosureId) return;
  const item = closures.find(closure => closure.id === selectedAdminClosureId);
  if (!item) return;

  const remaining = closureRemaining(item);
  const amount = parseMoneyInput($("adminPaymentAmount").value);
  const file = $("adminCloseProof").files?.[0];
  if (!amount || amount <= 0 || amount > remaining + 0.5) {
    $("adminPaymentStatus").textContent = `Ingresá un importe entre $1 y ${money(remaining)}.`;
    $("adminPaymentStatus").className = "status error";
    return;
  }
  if (!file) {
    $("adminPaymentStatus").textContent = "Adjuntá el comprobante del pago de Explora.";
    $("adminPaymentStatus").className = "status error";
    return;
  }

  $("confirmAdminPayment").disabled = true;
  $("confirmAdminPayment").textContent = "Guardando pago…";
  try {
    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const proofPath = `cierres_semanales/${currentWeeklyPeriodId()}/${item.operatorUid}/admin_${item.id}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    const paymentRef = doc(collection(db, ROOT_COLLECTIONS.payments));
    const closureRef = doc(db, ROOT_COLLECTIONS.closures, item.id);
    const newPaidTotal = Number(item.paidAmountTotal || 0) + amount;
    const newRemaining = Math.max(0, remaining - amount);
    const batch = writeBatch(db);
    batch.set(paymentRef, {
      // Ajuste interno: la UI lo muestra del lado efectivo del chofer, pero no debe
      // sumarse otra vez a la facturación histórica ni disparar un Telegram de cobro.
      method: "cash",
      paymentMethod: "internal_admin_payment",
      metodoPago: "internal_admin_payment",
      financialCategory: "internal_admin_payment",
      type: "settlement_adjustment",
      operationType: "settlement_adjustment",
      adjustmentDirection: "explora_to_driver",
      internalSettlementAdjustment: true,
      excludeFromBillingSettlement: true,
      suppressTelegram: true,
      amount,
      monto: amount,
      service: "Ajuste de Explora",
      notes: newRemaining <= 0.5 ? "Pago total de Explora" : "Pago parcial de Explora",
      detail: newRemaining <= 0.5 ? "Pago total de Explora" : "Pago parcial de Explora",
      proofUrl,
      proofPath,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      closureId: item.id,
      dayKey: localDayKey(),
      weeklyPeriodId: currentWeeklyPeriodId(),
      driverUid: item.operatorUid,
      choferUid: item.operatorUid,
      uid: item.operatorUid,
      ownerUid: item.operatorUid,
      driverId: item.operatorUid,
      driverName: item.operatorName || "Chofer",
      operatorUid: item.operatorUid,
      operatorName: item.operatorName || "",
      createdByUid: admin.uid,
      createdByRole: "admin",
      createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      businessId: BUSINESS_ID,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });
    batch.update(closureRef, {
      paidAmountTotal: newPaidTotal,
      remainingAmount: newRemaining,
      amountDueToDriver: newRemaining,
      amountToDriver: newRemaining,
      amountDueFromDriver: 0,
      amountFromDriver: 0,
      lastProofUrl: proofUrl,
      lastProofPath: proofPath,
      proofUrl,
      proofPath,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      proofUploadedByUid: admin.uid,
      proofUploadedByRole: "admin",
      status: newRemaining <= 0.5 ? "completed" : "partially_paid",
      updatedAtMs: Date.now(),
      lastPaymentAt: serverTimestamp(),
      completedAt: newRemaining <= 0.5 ? serverTimestamp() : null
    });
    await batch.commit();

    $("adminPaymentStatus").textContent = newRemaining <= 0.5
      ? "Pago registrado. El cierre quedó equilibrado."
      : `Pago parcial registrado. Quedan ${money(newRemaining)} pendientes.`;
    $("adminPaymentStatus").className = "status success";
    setTimeout(() => {
      selectedAdminClosureId = "";
      $("adminPaymentForm").classList.add("hidden");
      $("adminClosureList").classList.remove("hidden");
      renderAdminClosures();
    }, 1300);
  } catch (err) {
    console.error(err);
    $("adminPaymentStatus").textContent = "No se pudo registrar el pago de Explora.";
    $("adminPaymentStatus").className = "status error";
  } finally {
    $("confirmAdminPayment").disabled = false;
    $("confirmAdminPayment").textContent = "Registrar pago";
  }
});
