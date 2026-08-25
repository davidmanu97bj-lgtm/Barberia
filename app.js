import * as firebaseSettings from "./firebase-config.js?v=20260824-13";

const { firebaseConfig, BUSINESS_ID, USER_EMAIL_DOMAIN } = firebaseSettings;
const LOGIN_ALIASES = firebaseSettings.LOGIN_ALIASES || {};

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore, collection, addDoc, doc, getDoc, setDoc,
  onSnapshot, serverTimestamp, query, where, writeBatch, runTransaction
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
let unsubscribePayments = null;
let unsubscribeExpenses = null;
let unsubscribeUber = null;
let unsubscribeClosures = null;
let unsubscribeDebts = null;
let unsubscribeAdvances = null;
let payments = [];
let expenses = [];
let uberClosures = [];
let closures = [];
let debts = [];
let advances = [];
let advancesLoaded = false;
let currentProfile = null;
let selectedCloseDirection = "";
let selectedAdminClosureId = "";
const RECENT_RECEIPTS_LIMIT = 6;
// Primera semana administrada por este selector. Desde aquí, toda semana
// cerrada sin comprobante permanece pendiente hasta que el chofer la cargue.
const UBER_TRACKING_START_DATE = "2026-08-24";
const ADVANCE_MAX_AMOUNT = 400000;
const ADVANCE_INTEREST_RATE = 0.40;
const ADVANCE_DIFFERENCE_LIMIT = 50000;

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

function loginEmailCandidates(usernameOrEmail) {
  const value = usernameOrEmail.trim().toLowerCase();
  if (value.includes("@")) return [value];

  const username = safeUsername(value);
  return [...new Set([
    LOGIN_ALIASES[value],
    username === "barberia" ? "barberia@gmail.com" : "",
    username ? `${username}@${USER_EMAIL_DOMAIN}` : ""
  ].filter(Boolean))];
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
  const candidates = loginEmailCandidates(usernameOrEmail);
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
  const username = user.email?.split("@")[0] || "barberia";
  return { username, displayName: username, role: "barber", active: true };
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
function revenueTotalFor(method) {
  return payments
    .filter(p => p.method === method && !isSettlementAdjustment(p) && !isReimbursementCompensation(p))
    .reduce((a,p)=>a+Number(p.amount||0),0);
}
function adjustmentTotal(direction) {
  return payments
    .filter(p => isSettlementAdjustment(p) && p.adjustmentDirection === direction)
    .reduce((total, item) => {
      const amount = Number(item.amount || 0);
      const paidToAdvance = direction === "driver_to_explora"
        ? Number(item.advanceRepaymentAmount || 0)
        : 0;
      return total + Math.max(0, amount - paidToAdvance);
    }, 0);
}
function expensesTotal() {
  return expenses.reduce((a,e)=>a+Number(e.amount||0),0);
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
  return payments
    .filter(isReimbursementCompensation)
    .reduce((a,item)=>a+Number(item.amount||0),0);
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

// Billeteras espejo compensadas:
// - Chofer → Explora: 50% de Efectivo/Uber + 5% de caja chica + deudas/adelantos.
// - Explora → Chofer: 50% de Digital que no se haya aplicado a un adelanto.
// - El saldo positivo identifica quién debe compensar; el negativo, quién recibe.
// - Ambas billeteras muestran siempre el mismo saldo con signos opuestos.
function settlementModel() {
  const cashRevenue = revenueTotalFor("cash");
  const uber = uberTodayTotal();
  const digitalRevenue = revenueTotalFor("digital");
  const driverPaid = adjustmentTotal("driver_to_explora");
  const exploraPaid = adjustmentTotal("explora_to_driver");
  const adminDebt = debtsTotal();
  const advanceDebt = advancesOutstandingTotal();
  const advanceRepaidToday = advanceRepaymentAppliedTotal();
  const cash = cashRevenue;
  const digital = digitalRevenue;
  const expense = expensesTotal();
  const driverHeld = cashRevenue + uber;
  const cashShare = cashRevenue * 0.50;
  const uberShare = uber * 0.50;
  const digitalShareGross = digitalRevenue * 0.50;
  // La parte del chofer en los cobros digitales paga primero sus adelantos.
  // Solo el excedente continúa disponible para compensar la billetera espejo.
  const digitalShare = Math.max(0, digitalShareGross - advanceRepaidToday);
  const cashBox = driverHeld * 0.05;
  const expenseHalf = expense * 0.50;
  const reimbursementApplied = Math.min(reimbursementCompensationTotal(), expenseHalf);
  const expenseReimbursement = Math.max(0, expenseHalf - reimbursementApplied);

  // Obligaciones base antes de pagos compensatorios anteriores.
  const cashDebt = cashShare + uberShare + cashBox + adminDebt + advanceDebt;
  // El reintegro de gastos se mantiene separado hasta que el chofer decide
  // utilizarlo para reducir su diferencia pendiente con Explora.
  const digitalDebt = digitalShare;
  // Un pago del chofer completa Explora; uno de Explora completa Chofer.
  const cashAdjusted = cashDebt + exploraPaid;
  const digitalAdjusted = digitalDebt + driverPaid;
  const baseBalance = cashDebt - digitalDebt;
  const balance = baseBalance - driverPaid + exploraPaid - reimbursementApplied;
  const amount = Math.abs(balance);
  const normalizedBalance = amount > 0.5 ? balance : 0;
  const compensationAvailable = Math.min(expenseReimbursement, Math.max(0, normalizedBalance));
  const driverWallet = normalizedBalance;
  const exploraWallet = -normalizedBalance;

  let from = "balanced";
  let to = "balanced";
  if (balance > 0.5) {
    from = "cash";
    to = "digital";
  } else if (balance < -0.5) {
    from = "digital";
    to = "cash";
  }

  return {
    cash, uber, digital, expense, adminDebt, advanceDebt, advanceRepaidToday, driverHeld,
    cashShare, uberShare, digitalShare, digitalShareGross, cashBox, expenseHalf,
    expenseReimbursement, reimbursementApplied, compensationAvailable,
    cashRevenue, digitalRevenue, driverPaid, exploraPaid, baseBalance,
    cashAdjusted, digitalAdjusted,
    cashDebt, digitalDebt, balance: normalizedBalance, amount: Math.abs(normalizedBalance),
    driverWallet, exploraWallet, from, to,
    grand: cashRevenue + uber + digitalRevenue
  };
}

function renderWalletStatus(elementId, walletBalance) {
  const element = $(elementId);
  if (!element) return;

  element.classList.remove("is-paying", "is-receiving", "is-balanced");
  if (walletBalance > 0.5) {
    element.textContent = "Debe compensar";
    element.classList.add("is-paying");
  } else if (walletBalance < -0.5) {
    element.textContent = "Debe recibir";
    element.classList.add("is-receiving");
  } else {
    element.textContent = "Billetera equilibrada";
    element.classList.add("is-balanced");
  }
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
  renderWalletStatus("cashWalletStatus", model.driverWallet);
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
  renderWalletStatus("digitalWalletStatus", model.exploraWallet);
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
  const profileRef = doc(db, "businesses", BUSINESS_ID, "users", user.uid);
  const snap = await getDoc(profileRef);
  if (snap.exists()) return snap.data();

  const username = user.email?.split("@")[0] || "barbero";
  const profile = { username, displayName: username, role: "barber", active: true, createdAt: serverTimestamp() };
  await setDoc(profileRef, profile, { merge: true });
  return profile;
}

function subscribeToday(user) {
  if (unsubscribePayments) unsubscribePayments();
  if (unsubscribeExpenses) unsubscribeExpenses();
  if (unsubscribeUber) unsubscribeUber();
  if (unsubscribeDebts) unsubscribeDebts();
  if (unsubscribeAdvances) unsubscribeAdvances();
  advancesLoaded = false;

  const paymentsRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "payments");
  const expensesRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "expenses");
  const uberRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "uber");
  const advancesRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "advances");
  const debtsRef = collection(db, "businesses", BUSINESS_ID, "debts");
  $("syncStatus").textContent = "Sincronizando…";
  $("syncStatus").className = "sync";

  unsubscribePayments = onSnapshot(paymentsRef, snap => {
    const today = localDayKey();
    payments = snap.docs
      .map(d => ({ id:d.id, ...d.data() }))
      .filter(item => item.dayKey === today)
      .sort((a, b) => {
        const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bMs - aMs;
      });
    render();
    $("syncStatus").textContent = "En tiempo real";
    $("syncStatus").className = "sync ok";
  }, err => {
    console.error("Firestore payments snapshot error:", err);
    $("syncStatus").textContent = "Error de datos";
    $("syncStatus").className = "sync bad";
  });

  unsubscribeExpenses = onSnapshot(expensesRef, snap => {
    const today = localDayKey();
    expenses = snap.docs
      .map(d => ({ id:d.id, ...d.data() }))
      .filter(item => item.dayKey === today)
      .sort((a, b) => {
        const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bMs - aMs;
      });
    render();
  }, err => {
    console.error("Firestore expenses snapshot error:", err);
    $("syncStatus").textContent = "Error de gastos";
    $("syncStatus").className = "sync bad";
  });

  unsubscribeUber = onSnapshot(uberRef, snap => {
    uberClosures = snap.docs
      .map(d => ({ id:d.id, ...d.data() }))
      .sort((a, b) => {
        const dateCmp = String(b.weekCloseDate || "").localeCompare(String(a.weekCloseDate || ""));
        if (dateCmp) return dateCmp;
        const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bMs - aMs;
      });
    render();
    if (!$("uberModal")?.classList.contains("hidden")) renderUberWeekSelector();
  }, err => {
    console.error("Firestore Uber snapshot error:", err);
    $("syncStatus").textContent = "Error de Uber";
    $("syncStatus").className = "sync bad";
  });

  unsubscribeDebts = onSnapshot(debtsRef, snap => {
    const today = localDayKey();
    debts = snap.docs
      .map(d => ({ id:d.id, ...d.data() }))
      .filter(item => item.dayKey === today)
      .sort((a, b) => {
        const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bMs - aMs;
      });
    render();
  }, err => {
    console.error("Firestore debts snapshot error:", err);
    $("syncStatus").textContent = "Error de deudas";
    $("syncStatus").className = "sync bad";
  });

  unsubscribeAdvances = onSnapshot(advancesRef, snap => {
    advances = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bMs - aMs;
      });
    advancesLoaded = true;
    render();
  }, err => {
    console.error("Firestore advances snapshot error:", err);
    // Un fallo aislado del módulo de adelantos no debe bloquear los cobros
    // digitales ni el ingreso al resto de la aplicación.
    advances = [];
    advancesLoaded = true;
    render();
    $("syncStatus").textContent = "Error de adelantos";
    $("syncStatus").className = "sync bad";
  });
}

function isAdminProfile() {
  return currentProfile?.role === "admin";
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
  const baseRef = collection(db, "businesses", BUSINESS_ID, "closures");
  const source = isAdminProfile()
    ? baseRef
    : query(baseRef, where("operatorUid", "==", user.uid));

  unsubscribeClosures = onSnapshot(source, snap => {
    closures = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const aMs = a.requestedAt?.toMillis ? a.requestedAt.toMillis() : 0;
        const bMs = b.requestedAt?.toMillis ? b.requestedAt.toMillis() : 0;
        return bMs - aMs;
      });
    renderAdminClosures();
  }, err => {
    console.error("Firestore closures snapshot error:", err);
    if (isAdminProfile()) {
      $("adminClosureList").innerHTML = `<div class="admin-empty error">No se pudieron cargar los cierres.</div>`;
    }
  });
}

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
    await waitForAuthReady();
    await signInFromLogin(usernameOrEmail, password);
    $("loginStatus").textContent = "Acceso correcto. Cargando caja…";
    $("loginStatus").className = "status success";
  } catch (err) {
    console.error(err);
    $("loginStatus").textContent = loginErrorMessage(err);
    $("loginStatus").className = "status error";
  } finally {
    $("loginBtn").disabled = false;
    $("loginBtn").textContent = "Ingresar";
  }
});

$("logoutBtn")?.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async user => {
  if (!user) {
    if (unsubscribePayments) unsubscribePayments();
    if (unsubscribeExpenses) unsubscribeExpenses();
    if (unsubscribeUber) unsubscribeUber();
    if (unsubscribeClosures) unsubscribeClosures();
    if (unsubscribeDebts) unsubscribeDebts();
    if (unsubscribeAdvances) unsubscribeAdvances();
    payments = [];
    expenses = [];
    uberClosures = [];
    closures = [];
    debts = [];
    advances = [];
    advancesLoaded = false;
    currentProfile = null;
    $("app").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
    return;
  }

  // Authentication ya fue validada. Mostramos la caja inmediatamente para
  // que una lectura lenta o una regla pendiente de Firestore no expulse al usuario.
  currentProfile = fallbackProfile(user);
  $("operatorName").textContent = currentProfile.displayName;
  $("loginScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  subscribeToday(user);
  applyRoleUI();
  subscribeClosures(user);

  try {
    currentProfile = await loadProfile(user);
    if (currentProfile.active === false) {
      await signOut(auth);
      $("loginStatus").textContent = "Este usuario está desactivado.";
      $("loginStatus").className = "status error";
      return;
    }
    $("operatorName").textContent = currentProfile.displayName || currentProfile.username || user.email.split("@")[0];
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
    const compensationRef = doc(db, "businesses", BUSINESS_ID, "users", user.uid, "payments", compensationId);
    await setDoc(compensationRef, {
      method: "digital",
      type: "reimbursement_compensation",
      amount,
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
      operatorName: currentProfile?.displayName || currentProfile?.username || "",
      businessId: BUSINESS_ID,
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
    const advancesRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "advances");
    await addDoc(advancesRef, {
      type: "cash_advance",
      principalAmount: quote.principal,
      interestPercent: 40,
      interestAmount: quote.interest,
      totalDebt: quote.total,
      remainingAmount: quote.total,
      repaidAmount: 0,
      status: "active",
      differenceAtRequest: difference,
      requestedDayKey: localDayKey(),
      operatorUid: user.uid,
      operatorName: currentProfile?.displayName || currentProfile?.username || "",
      businessId: BUSINESS_ID,
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
      proofPath = `businesses/${BUSINESS_ID}/users/${user.uid}/proofs/${localDayKey()}/${Date.now()}_${cleanName}`;
      const storageRef = ref(storage, proofPath);
      await uploadBytes(storageRef, file);
      proofUrl = await getDownloadURL(storageRef);
    }

    const paymentsRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "payments");
    const paymentRef = doc(paymentsRef);
    const enteredDetail = $("detail").value.trim();
    const candidateAdvanceRefs = mode === "digital"
      ? advances
          .filter(item => advanceRemaining(item) > 0.5)
          .map(item => doc(db, "businesses", BUSINESS_ID, "users", user.uid, "advances", item.id))
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
        amount,
        service,
        detail: paymentDetail,
        advanceRepaymentAmount: repaymentPlan.totalApplied,
        advanceAllocations: repaymentPlan.allocations.map(item => ({
          advanceId: item.id,
          amount: item.applied
        })),
        proofUrl,
        proofPath,
        dayKey: localDayKey(),
        operatorUid: user.uid,
        operatorName: currentProfile?.displayName || currentProfile?.username || "",
        businessId: BUSINESS_ID,
        createdAt: serverTimestamp()
      });
      repaymentPlan.allocations.forEach(item => {
        const advanceRef = doc(db, "businesses", BUSINESS_ID, "users", user.uid, "advances", item.id);
        transaction.update(advanceRef, {
          remainingAmount: item.remainingAmount,
          repaidAmount: item.repaidAmount,
          status: item.status,
          updatedAt: serverTimestamp()
        });
      });
    });

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
      proofPath = `businesses/${BUSINESS_ID}/users/${admin.uid}/proofs/debts/${localDayKey()}_${Date.now()}_${cleanName}`;
      const storageRef = ref(storage, proofPath);
      await uploadBytes(storageRef, file);
      proofUrl = await getDownloadURL(storageRef);
    }

    const debtsRef = collection(db, "businesses", BUSINESS_ID, "debts");
    await addDoc(debtsRef, {
      type: "admin_debt",
      amount,
      detail,
      proofUrl,
      proofPath,
      dayKey: localDayKey(),
      businessId: BUSINESS_ID,
      createdByUid: admin.uid,
      createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
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
    const proofPath = `businesses/${BUSINESS_ID}/users/${user.uid}/proofs/${localDayKey()}/expense_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    const expensesRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "expenses");
    await addDoc(expensesRef, {
      amount,
      detail,
      proofUrl,
      proofPath,
      dayKey: localDayKey(),
      operatorUid: user.uid,
      operatorName: currentProfile?.displayName || currentProfile?.username || "",
      businessId: BUSINESS_ID,
      createdAt: serverTimestamp()
    });

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
    const uberDocRef = doc(db, "businesses", BUSINESS_ID, "users", user.uid, "uber", week.weekKey);
    const existing = await getDoc(uberDocRef);
    if (existing.exists() || isUberWeekLoaded(week)) {
      $("uberStatus").textContent = `La semana ${week.label} ya tiene comprobante.`;
      $("uberStatus").className = "status error";
      renderUberWeekSelector();
      return;
    }

    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const proofPath = `businesses/${BUSINESS_ID}/users/${user.uid}/proofs/uber/${week.weekKey}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    await setDoc(uberDocRef, {
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
      createdAt: serverTimestamp()
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
    const closureRef = doc(collection(db, "businesses", BUSINESS_ID, "closures"));
    let proofUrl = "";
    let proofPath = "";
    const remainingAmount = Math.max(0, model.amount - amount);

    if (isDriverPayment) {
      const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
      proofPath = `businesses/${BUSINESS_ID}/users/${user.uid}/proofs/closures/${closureRef.id}_${Date.now()}_${cleanName}`;
      const storageRef = ref(storage, proofPath);
      await uploadBytes(storageRef, file);
      proofUrl = await getDownloadURL(storageRef);

      const paymentRef = doc(collection(db, "businesses", BUSINESS_ID, "users", user.uid, "payments"));
      const candidateAdvanceRefs = advances
        .filter(item => advanceRemaining(item) > 0.5)
        .map(item => doc(db, "businesses", BUSINESS_ID, "users", user.uid, "advances", item.id));
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
          method: "digital",
          type: "settlement_adjustment",
          adjustmentDirection: "driver_to_explora",
          amount,
          advanceRepaymentAmount: repaymentPlan.totalApplied,
          advanceAllocations: repaymentPlan.allocations.map(item => ({
            advanceId: item.id,
            amount: item.applied
          })),
          service: "Ajuste del chofer",
          detail,
          proofUrl,
          proofPath,
          closureId: closureRef.id,
          dayKey: localDayKey(),
          operatorUid: user.uid,
          operatorName: currentProfile?.displayName || currentProfile?.username || "",
          businessId: BUSINESS_ID,
          createdAt: serverTimestamp()
        });
        transaction.set(closureRef, {
          direction: "driver_pays_explora",
          requestedAmount: model.amount,
          settlementAmount: model.amount,
          paidAmountTotal: amount,
          remainingAmount,
          proofUrl,
          proofPath,
          proofUploadedByUid: user.uid,
          proofUploadedByRole: "driver",
          status: remainingAmount <= 0.5 ? "completed" : "partial",
          dayKey: localDayKey(),
          cashTotal: model.cash,
          uberTotal: model.uber,
          debtTotal: model.adminDebt + model.advanceDebt,
          advanceDebtTotal: model.advanceDebt,
          advanceRepaidAmount: repaymentPlan.totalApplied,
          cashBox5: model.cashBox,
          digitalTotal: model.digital,
          expensesTotal: model.expense,
          total: model.grand,
          operatorUid: user.uid,
          operatorName: currentProfile?.displayName || currentProfile?.username || "",
          businessId: BUSINESS_ID,
          requestedAt: serverTimestamp(),
          completedAt: remainingAmount <= 0.5 ? serverTimestamp() : null
        });
        repaymentPlan.allocations.forEach(item => {
          const advanceRef = doc(db, "businesses", BUSINESS_ID, "users", user.uid, "advances", item.id);
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
      await setDoc(closureRef, {
        direction: "explora_pays_driver",
        requestedAmount: model.amount,
        settlementAmount: model.amount,
        paidAmountTotal: 0,
        remainingAmount: model.amount,
        status: "awaiting_admin_proof",
        dayKey: localDayKey(),
        cashTotal: model.cash,
        uberTotal: model.uber,
        debtTotal: model.adminDebt + model.advanceDebt,
        advanceDebtTotal: model.advanceDebt,
        cashBox5: model.cashBox,
        digitalTotal: model.digital,
        expensesTotal: model.expense,
        total: model.grand,
        operatorUid: user.uid,
        operatorName: currentProfile?.displayName || currentProfile?.username || "",
        businessId: BUSINESS_ID,
        requestedAt: serverTimestamp()
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
    const proofPath = `businesses/${BUSINESS_ID}/users/${admin.uid}/proofs/closures/admin_${item.id}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    const paymentRef = doc(collection(db, "businesses", BUSINESS_ID, "users", item.operatorUid, "payments"));
    const closureRef = doc(db, "businesses", BUSINESS_ID, "closures", item.id);
    const newPaidTotal = Number(item.paidAmountTotal || 0) + amount;
    const newRemaining = Math.max(0, remaining - amount);
    const batch = writeBatch(db);
    batch.set(paymentRef, {
      method: "cash",
      type: "settlement_adjustment",
      adjustmentDirection: "explora_to_driver",
      amount,
      service: "Ajuste de Explora",
      detail: newRemaining <= 0.5 ? "Pago total de Explora" : "Pago parcial de Explora",
      proofUrl,
      proofPath,
      closureId: item.id,
      dayKey: localDayKey(),
      operatorUid: item.operatorUid,
      operatorName: item.operatorName || "",
      createdByUid: admin.uid,
      createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      businessId: BUSINESS_ID,
      createdAt: serverTimestamp()
    });
    batch.update(closureRef, {
      paidAmountTotal: newPaidTotal,
      remainingAmount: newRemaining,
      lastProofUrl: proofUrl,
      lastProofPath: proofPath,
      proofUrl,
      proofPath,
      proofUploadedByUid: admin.uid,
      proofUploadedByRole: "admin",
      status: newRemaining <= 0.5 ? "completed" : "partially_paid",
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
