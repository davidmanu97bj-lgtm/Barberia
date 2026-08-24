import {
  firebaseConfig, BUSINESS_ID, USER_EMAIL_DOMAIN, LOGIN_ALIASES
} from "./firebase-config.js?v=20260824-6";

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore, collection, addDoc, doc, getDoc, setDoc,
  onSnapshot, serverTimestamp, query, where, writeBatch
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
  .catch(err => console.warn("No se pudo guardar la persistencia de sesión:", err));

const $ = id => document.getElementById(id);
let unsubscribePayments = null;
let unsubscribeExpenses = null;
let unsubscribeUber = null;
let unsubscribeClosures = null;
let unsubscribeDebts = null;
let payments = [];
let expenses = [];
let uberClosures = [];
let closures = [];
let debts = [];
let currentProfile = null;
let selectedCloseDirection = "";
let selectedAdminClosureId = "";
const RECENT_RECEIPTS_LIMIT = 6;

const money = value => new Intl.NumberFormat("es-AR", {
  style: "currency", currency: "ARS", maximumFractionDigits: 0
}).format(value || 0);

function localDayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function safeUsername(value) {
  return value.trim().toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9._-]/g,"");
}
function usernameToEmail(usernameOrEmail) {
  const value = usernameOrEmail.trim().toLowerCase();
  if (value.includes("@")) return value;
  if (LOGIN_ALIASES[value]) return LOGIN_ALIASES[value];
  return `${safeUsername(value)}@${USER_EMAIL_DOMAIN}`;
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
function isAdminDebt(item) {
  return item.type === "admin_debt";
}
function revenueTotalFor(method) {
  return payments
    .filter(p => p.method === method && !isSettlementAdjustment(p))
    .reduce((a,p)=>a+Number(p.amount||0),0);
}
function adjustmentTotal(direction) {
  return payments
    .filter(p => isSettlementAdjustment(p) && p.adjustmentDirection === direction)
    .reduce((a,p)=>a+Number(p.amount||0),0);
}
function expensesTotal() {
  return expenses.reduce((a,e)=>a+Number(e.amount||0),0);
}
function debtsTotal() {
  return debts.reduce((a,item)=>a+Number(item.amount||0),0);
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

// Lógica de equilibrio de la barbería:
// - Efectivo conserva el 100% de los cobros en efectivo.
// - El chofer conserva también el 100% de Uber.
// - Digital conserva el 100% de los cobros digitales.
// - Para equilibrar 50/50, Efectivo + Uber generan deuda del 50% hacia Digital.
// - Caja chica: 5% completo sobre Efectivo + Uber, porque ambos quedan en manos del chofer.
// - Gastos: Digital reconoce el 50% de cada gasto pagado por el chofer.
// - Deuda: el administrador la suma a Efectivo por su valor completo; no genera caja chica.
function settlementModel() {
  const cashRevenue = revenueTotalFor("cash");
  const uber = uberTodayTotal();
  const digitalRevenue = revenueTotalFor("digital");
  const driverPaid = adjustmentTotal("driver_to_explora");
  const exploraPaid = adjustmentTotal("explora_to_driver");
  const adminDebt = debtsTotal();
  const cash = cashRevenue;
  const digital = digitalRevenue;
  const expense = expensesTotal();
  const driverHeld = cashRevenue + uber;
  const cashBox = driverHeld * 0.05;
  const expenseHalf = expense * 0.50;

  // Totales visuales de cada lado.
  const cashAdjusted = driverHeld + exploraPaid + adminDebt + cashBox;
  const digitalAdjusted = digitalRevenue + driverPaid + expenseHalf;

  // Deudas usadas para definir quién paga a quién.
  const cashDebt = (driverHeld * 0.50) + cashBox + adminDebt;
  const digitalDebt = (digitalRevenue * 0.50) + expenseHalf;
  const baseBalance = cashDebt - digitalDebt;
  // Los ajustes son transferencias entre las partes, no nueva facturación.
  // Por eso reducen el saldo por su valor completo y no vuelven a dividirse 50/50.
  const balance = baseBalance - driverPaid + exploraPaid;
  const amount = Math.abs(balance);

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
    cash, uber, digital, expense, adminDebt, driverHeld, cashBox, expenseHalf,
    cashRevenue, digitalRevenue, driverPaid, exploraPaid, baseBalance,
    cashAdjusted, digitalAdjusted,
    cashDebt, digitalDebt, balance, amount, from, to,
    grand: cashRevenue + uber + digitalRevenue
  };
}

function renderSettlement(model) {
  const label = $("summarySettlementLabel");
  const amount = $("summarySettlementAmount");

  if (model.from === "balanced") {
    label.textContent = "Equilibrado";
    amount.textContent = money(0);
    return;
  }

  label.textContent = model.from === "cash"
    ? "Chofer paga a Explora"
    : "Explora paga al chofer";
  amount.textContent = money(model.amount);
}

function render() {
  const model = settlementModel();
  const cashItems = [
    ...payments.filter(p => p.method === "cash"),
    ...debts.map(item => ({ ...item, method: "cash", type: "admin_debt", service: "Deuda" }))
  ].sort((a, b) => {
    const aMs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const bMs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    return bMs - aMs;
  });
  const digitalItems = payments.filter(p => p.method === "digital");
  const visibleCashItems = cashItems.slice(0, RECENT_RECEIPTS_LIMIT);
  const visibleDigitalItems = digitalItems.slice(0, RECENT_RECEIPTS_LIMIT);

  $("cashTotal").textContent = money(model.cashAdjusted);
  $("cashBaseTotal").textContent = money(model.cash);
  $("uberCashTotal").textContent = money(model.uber);
  $("cashBoxTotal").textContent = money(model.cashBox);
  $("exploraAdjustmentTotal").textContent = money(model.exploraPaid);
  $("adminDebtTotal").textContent = money(model.adminDebt);

  $("digitalTotal").textContent = money(model.digitalAdjusted);
  $("digitalBaseTotal").textContent = money(model.digital);
  $("driverAdjustmentTotal").textContent = money(model.driverPaid);
  $("expenseHalfTotal").textContent = money(model.expenseHalf);

  $("uberTotal").textContent = money(model.uber);

  $("cashCount").textContent = visibleCashItems.length;
  $("digitalCount").textContent = visibleDigitalItems.length;
  $("expenseCount").textContent = Math.min(expenses.length, RECENT_RECEIPTS_LIMIT);
  $("uberCount").textContent = Math.min(uberClosures.length, RECENT_RECEIPTS_LIMIT);

  renderSettlement(model);
  renderList("cashList", visibleCashItems, false);
  renderList("digitalList", visibleDigitalItems, true);
  renderExpenseList();
  renderUberList();
}

function renderList(containerId, items, isDigital) {
  const box = $(containerId);
  if (!items.length) {
    box.innerHTML = `<div class="empty">${isDigital
      ? "Los cobros digitales y sus comprobantes aparecerán acá."
      : "Los cobros en efectivo aparecerán acá."}</div>`;
    return;
  }
  box.innerHTML = items.map(item => {
    const time = item.createdAt?.toDate
      ? item.createdAt.toDate().toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})
      : "Ahora";
    const showsProof = isDigital || isSettlementAdjustment(item) || isAdminDebt(item);
    const proof = showsProof
      ? (item.proofUrl
          ? `<a class="proof" target="_blank" rel="noopener" href="${item.proofUrl}">Ver foto</a>`
          : `<span class="proof">Sin archivo</span>`)
      : "";
    const icon = isDigital
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
    return `<article class="receipt ${isDigital ? "receipt-digital" : "receipt-cash"} ${isSettlementAdjustment(item) ? "receipt-adjustment" : ""} ${isAdminDebt(item) ? "receipt-debt" : ""}">
      <div class="receipt-main">
        <span class="receipt-icon">${icon}</span>
        <div class="receipt-copy">
          <strong>${escapeHtml(item.service || "Cobro")}</strong>
          <small>${escapeHtml(item.detail || "Servicio registrado")}</small>
        </div>
        <div class="amount">+${money(item.amount)}</div>
      </div>
      <div class="receipt-footer">
        <span>Hoy · ${time}</span>${proof}
      </div>
    </article>`;
  }).join("");
}

function renderExpenseList() {
  const box = $("expenseList");
  if (!expenses.length) {
    box.innerHTML = `<div class="expense-empty">Sin gastos cargados hoy.</div>`;
    return;
  }

  box.innerHTML = expenses.slice(0, RECENT_RECEIPTS_LIMIT).map(item => {
    const time = item.createdAt?.toDate
      ? item.createdAt.toDate().toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})
      : "Ahora";
    const proof = item.proofUrl
      ? `<a class="proof" target="_blank" rel="noopener" href="${item.proofUrl}">Ver foto</a>`
      : `<span class="proof">Sin archivo</span>`;
    return `<article class="expense-item">
      <div class="expense-main">
        <span class="receipt-icon expense-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></span>
        <div class="receipt-copy"><strong>${escapeHtml(item.detail || "Gasto")}</strong><small>50% reconocido: ${money(Number(item.amount||0)*0.5)}</small></div>
        <div class="expense-amount">-${money(item.amount)}</div>
      </div>
      <div class="receipt-footer"><span>Hoy · ${time}</span>${proof}</div>
    </article>`;
  }).join("");
}

function renderUberList() {
  const box = $("uberList");
  if (!uberClosures.length) {
    box.innerHTML = `<div class="uber-empty">Los cierres semanales aparecerán acá.</div>`;
    return;
  }

  box.innerHTML = uberClosures.slice(0, RECENT_RECEIPTS_LIMIT).map(item => {
    const proof = item.proofUrl
      ? `<a class="proof" target="_blank" rel="noopener" href="${item.proofUrl}">Ver foto</a>`
      : `<span class="proof">Sin archivo</span>`;
    const todayMark = item.dayKey === localDayKey() ? " · suma hoy" : "";
    return `<article class="uber-receipt ${item.proofUrl ? "completed" : "pending"}">
      <span class="uber-week">${escapeHtml(item.weekKey || "Semana")}</span>
      <strong>${money(item.amount)}</strong>
      <small>Cierre ${formatDate(item.weekCloseDate)}${todayMark}</small>
      ${proof}
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

  const paymentsRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "payments");
  const expensesRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "expenses");
  const uberRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "uber");
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
}

function isAdminProfile() {
  return currentProfile?.role === "admin";
}

function applyRoleUI() {
  $("closeDayBtn").textContent = isAdminProfile() ? "Gestionar cierres" : "Pedir cierre";
  $("addDebtBtn").classList.toggle("hidden", !isAdminProfile());
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

$("loginForm").addEventListener("submit", async e => {
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
    await authReady;
    await signInWithEmailAndPassword(auth, usernameToEmail(usernameOrEmail), password);
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

$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async user => {
  if (!user) {
    if (unsubscribePayments) unsubscribePayments();
    if (unsubscribeExpenses) unsubscribeExpenses();
    if (unsubscribeUber) unsubscribeUber();
    if (unsubscribeClosures) unsubscribeClosures();
    if (unsubscribeDebts) unsubscribeDebts();
    payments = [];
    expenses = [];
    uberClosures = [];
    closures = [];
    debts = [];
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
    $("selectedService").value = "";
    $("selectedAmount").value = "";
    document.querySelectorAll(".service-option").forEach(option => option.classList.remove("selected"));
    $("chargeTitle").textContent = mode === "cash" ? "Cobro en efectivo" : "Cobro digital";
    $("proofField").classList.toggle("hidden", mode !== "digital");
    $("proof").required = mode === "digital";
    $("chargeStatus").textContent = "";
    $("chargeStatus").className = "status";
    $("chargeModal").classList.remove("hidden");
  });
});

document.querySelectorAll(".service-option").forEach(option => {
  option.addEventListener("click", () => {
    document.querySelectorAll(".service-option").forEach(item => item.classList.remove("selected"));
    option.classList.add("selected");
    $("selectedService").value = option.dataset.service;
    $("selectedAmount").value = option.dataset.amount;
    $("chargeStatus").textContent = "";
    $("chargeStatus").className = "status";
  });
});

document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => $(btn.dataset.close).classList.add("hidden"));
});

$("chargeForm").addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;
  const mode = $("chargeMode").value;
  const service = $("selectedService").value;
  const amount = Number($("selectedAmount").value);
  const file = $("proof").files?.[0];

  if (!service || !amount) {
    $("chargeStatus").textContent = "Elegí uno de los servicios.";
    $("chargeStatus").className = "status error";
    return;
  }

  if (mode === "digital" && !file) {
    $("chargeStatus").textContent = "Adjuntá el comprobante del cobro digital.";
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
    await addDoc(paymentsRef, {
      method: mode,
      amount,
      service,
      detail: $("detail").value.trim(),
      proofUrl,
      proofPath,
      dayKey: localDayKey(),
      operatorUid: user.uid,
      operatorName: currentProfile?.displayName || currentProfile?.username || "",
      businessId: BUSINESS_ID,
      createdAt: serverTimestamp()
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

$("addExpenseBtn").addEventListener("click", () => {
  $("expenseForm").reset();
  $("expenseStatus").textContent = "";
  $("expenseStatus").className = "status";
  $("expenseModal").classList.remove("hidden");
});

$("addDebtBtn").addEventListener("click", () => {
  if (!isAdminProfile()) return;
  $("debtForm").reset();
  $("debtStatus").textContent = "";
  $("debtStatus").className = "status";
  $("debtModal").classList.remove("hidden");
});

$("debtForm").addEventListener("submit", async event => {
  event.preventDefault();
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;

  const amount = Number($("debtAmount").value);
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

$("expenseForm").addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;

  const amount = Number($("expenseAmount").value);
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

$("addUberBtn").addEventListener("click", () => {
  $("uberForm").reset();
  $("uberCloseDate").value = localDayKey();
  $("uberStatus").textContent = "";
  $("uberStatus").className = "status";
  $("uberModal").classList.remove("hidden");
});

$("uberForm").addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;

  const amount = Number($("uberAmount").value);
  const weekCloseDate = $("uberCloseDate").value;
  const weekKey = isoWeekKey(weekCloseDate);
  const file = $("uberProof").files?.[0];

  if (!amount || amount <= 0) {
    $("uberStatus").textContent = "Ingresá el total semanal de Uber.";
    $("uberStatus").className = "status error";
    return;
  }
  if (!weekCloseDate || !weekKey) {
    $("uberStatus").textContent = "Elegí la fecha de cierre de Uber.";
    $("uberStatus").className = "status error";
    return;
  }
  if (weekCloseDate > localDayKey()) {
    $("uberStatus").textContent = "La fecha de cierre no puede estar en el futuro.";
    $("uberStatus").className = "status error";
    return;
  }
  if (!file) {
    $("uberStatus").textContent = "Adjuntá el comprobante semanal de Uber.";
    $("uberStatus").className = "status error";
    return;
  }

  $("saveUberBtn").disabled = true;
  $("saveUberBtn").textContent = "Guardando…";
  $("uberStatus").textContent = "";

  try {
    const uberDocRef = doc(db, "businesses", BUSINESS_ID, "users", user.uid, "uber", weekKey);
    const existing = await getDoc(uberDocRef);
    if (existing.exists()) {
      $("uberStatus").textContent = `Ya existe un comprobante para ${weekKey}.`;
      $("uberStatus").className = "status error";
      return;
    }

    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const proofPath = `businesses/${BUSINESS_ID}/users/${user.uid}/proofs/uber/${weekKey}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    await setDoc(uberDocRef, {
      amount,
      weekCloseDate,
      weekKey,
      proofUrl,
      proofPath,
      dayKey: localDayKey(),
      operatorUid: user.uid,
      operatorName: currentProfile?.displayName || currentProfile?.username || "",
      businessId: BUSINESS_ID,
      createdAt: serverTimestamp()
    });

    $("uberModal").classList.add("hidden");
  } catch (err) {
    console.error(err);
    $("uberStatus").textContent = "No se pudo registrar el cierre de Uber.";
    $("uberStatus").className = "status error";
  } finally {
    $("saveUberBtn").disabled = false;
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
    $("driverCloseAmount").value = String(Math.round(model.amount));
    $("driverCloseAmount").max = String(Math.round(model.amount));
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
  $("adminPaymentAmount").value = String(Math.round(remaining));
  $("adminPaymentAmount").max = String(Math.round(remaining));
  $("adminPaymentLimit").textContent = `Saldo máximo: ${money(remaining)}.`;
  $("adminPaymentSummary").innerHTML = `<small>Explora paga a</small><strong>${escapeHtml(item.operatorName || "Chofer")} · ${money(remaining)}</strong><span>Podés abonar el total o un importe menor.</span>`;
  $("adminPaymentStatus").textContent = "";
  $("adminPaymentStatus").className = "status";
  $("adminClosureList").classList.add("hidden");
  $("adminPaymentForm").classList.remove("hidden");
}

$("closeDayBtn").addEventListener("click", () => {
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

$("choosePayExplora").addEventListener("click", () => selectDriverClose("driver_to_explora"));
$("chooseCollectExplora").addEventListener("click", () => selectDriverClose("explora_to_driver"));
$("driverUseFullAmount").addEventListener("click", () => {
  const model = settlementModel();
  $("driverCloseAmount").value = String(Math.round(model.amount));
});

$("driverCloseForm").addEventListener("submit", async event => {
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
  const amount = isDriverPayment ? Number($("driverCloseAmount").value) : model.amount;
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
      const batch = writeBatch(db);
      batch.set(paymentRef, {
        method: "digital",
        type: "settlement_adjustment",
        adjustmentDirection: "driver_to_explora",
        amount,
        service: "Ajuste del chofer",
        detail: remainingAmount <= 0.5 ? "Pago total a Explora" : "Pago parcial a Explora",
        proofUrl,
        proofPath,
        closureId: closureRef.id,
        dayKey: localDayKey(),
        operatorUid: user.uid,
        operatorName: currentProfile?.displayName || currentProfile?.username || "",
        businessId: BUSINESS_ID,
        createdAt: serverTimestamp()
      });
      batch.set(closureRef, {
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
        debtTotal: model.adminDebt,
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
      await batch.commit();
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
        debtTotal: model.adminDebt,
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

$("adminUseFullAmount").addEventListener("click", () => {
  const item = closures.find(closure => closure.id === selectedAdminClosureId);
  if (item) $("adminPaymentAmount").value = String(Math.round(closureRemaining(item)));
});

$("cancelAdminPayment").addEventListener("click", () => {
  selectedAdminClosureId = "";
  $("adminPaymentForm").classList.add("hidden");
  $("adminClosureList").classList.remove("hidden");
  renderAdminClosures();
});

$("adminPaymentForm").addEventListener("submit", async event => {
  event.preventDefault();
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile() || !selectedAdminClosureId) return;
  const item = closures.find(closure => closure.id === selectedAdminClosureId);
  if (!item) return;

  const remaining = closureRemaining(item);
  const amount = Number($("adminPaymentAmount").value);
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
