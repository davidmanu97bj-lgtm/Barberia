import {
  firebaseConfig, BUSINESS_ID, USER_EMAIL_DOMAIN, LOGIN_ALIASES
} from "./firebase-config.js?v=20260824-3";

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore, collection, addDoc, doc, getDoc, setDoc,
  onSnapshot, serverTimestamp
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
let payments = [];
let expenses = [];
let uberClosures = [];
let currentProfile = null;

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
function totalFor(method) {
  return payments.filter(p => p.method === method).reduce((a,p)=>a+Number(p.amount||0),0);
}
function expensesTotal() {
  return expenses.reduce((a,e)=>a+Number(e.amount||0),0);
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
function settlementModel() {
  const cash = totalFor("cash");
  const uber = uberTodayTotal();
  const digital = totalFor("digital");
  const expense = expensesTotal();
  const driverHeld = cash + uber;
  const cashBox = driverHeld * 0.05;
  const expenseHalf = expense * 0.50;

  // Totales visuales de cada lado.
  const cashAdjusted = driverHeld + cashBox;
  const digitalAdjusted = digital + expenseHalf;

  // Deudas usadas para definir quién paga a quién.
  const cashDebt = (driverHeld * 0.50) + cashBox;
  const digitalDebt = (digital * 0.50) + expenseHalf;
  const balance = cashDebt - digitalDebt;
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
    cash, uber, digital, expense, driverHeld, cashBox, expenseHalf,
    cashAdjusted, digitalAdjusted,
    cashDebt, digitalDebt, balance, amount, from, to,
    grand: cash + uber + digital
  };
}

function renderSettlement(model) {
  const label = $("summarySettlementLabel");
  const amount = $("summarySettlementAmount");
  const closeSettlement = $("closeSettlement");

  if (model.from === "balanced") {
    label.textContent = "Equilibrado";
    amount.textContent = money(0);
    closeSettlement.innerHTML = `<span>Cuentas equilibradas</span><strong>${money(0)}</strong>`;
    return;
  }

  const fromLabel = model.from === "cash" ? "Efectivo" : "Digital";
  const toLabel = model.to === "cash" ? "Efectivo" : "Digital";
  label.textContent = `${fromLabel} paga a ${toLabel}`;
  amount.textContent = money(model.amount);
  closeSettlement.innerHTML = `<span>${fromLabel} paga a ${toLabel}</span><strong>${money(model.amount)}</strong>`;
}

function render() {
  const model = settlementModel();
  const cashItems = payments.filter(p => p.method === "cash");
  const digitalItems = payments.filter(p => p.method === "digital");

  $("cashTotal").textContent = money(model.cash);
  $("uberCashTotal").textContent = money(model.uber);
  $("cashBoxTotal").textContent = money(model.cashBox);
  $("cashAdjustedTotal").textContent = money(model.cashAdjusted);

  $("digitalTotal").textContent = money(model.digital);
  $("expenseHalfTotal").textContent = money(model.expenseHalf);
  $("digitalAdjustedTotal").textContent = money(model.digitalAdjusted);

  $("uberTotal").textContent = money(model.uber);

  $("closeCash").textContent = money(model.cash);
  $("closeUber").textContent = money(model.uber);
  $("closeCashBox").textContent = money(model.cashBox);
  $("closeCashAdjusted").textContent = money(model.cashAdjusted);
  $("closeDigital").textContent = money(model.digital);
  $("closeExpenseHalf").textContent = money(model.expenseHalf);
  $("closeDigitalAdjusted").textContent = money(model.digitalAdjusted);
  $("closeGrand").textContent = money(model.grand);
  $("cashCount").textContent = cashItems.length;
  $("digitalCount").textContent = digitalItems.length;
  $("expenseCount").textContent = expenses.length;
  $("uberCount").textContent = uberClosures.length;

  renderSettlement(model);
  renderList("cashList", cashItems, false);
  renderList("digitalList", digitalItems, true);
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
    const proof = isDigital
      ? (item.proofUrl
          ? `<a class="proof" target="_blank" rel="noopener" href="${item.proofUrl}">Ver foto</a>`
          : `<span class="proof">Sin archivo</span>`)
      : "";
    const icon = isDigital
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
    return `<article class="receipt ${isDigital ? "receipt-digital" : "receipt-cash"}">
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

  box.innerHTML = expenses.map(item => {
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

  box.innerHTML = uberClosures.map(item => {
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

  const paymentsRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "payments");
  const expensesRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "expenses");
  const uberRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "uber");
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
    payments = [];
    expenses = [];
    uberClosures = [];
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

  try {
    currentProfile = await loadProfile(user);
    if (currentProfile.active === false) {
      await signOut(auth);
      $("loginStatus").textContent = "Este usuario está desactivado.";
      $("loginStatus").className = "status error";
      return;
    }
    $("operatorName").textContent = currentProfile.displayName || currentProfile.username || user.email.split("@")[0];
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

$("closeDayBtn").addEventListener("click", () => {
  render();
  $("closeStatus").textContent = "";
  $("closeStatus").className = "status";
  $("closeModal").classList.remove("hidden");
});

$("confirmClose").addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  $("confirmClose").disabled = true;
  $("confirmClose").textContent = "Enviando…";
  try {
    const model = settlementModel();
    const closuresRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "closures");
    await addDoc(closuresRef, {
      dayKey: localDayKey(),
      cashTotal: model.cash,
      uberTotal: model.uber,
      cashPlusUber: model.driverHeld,
      cashBox5: model.cashBox,
      cashAdjustedTotal: model.cashAdjusted,
      digitalTotal: model.digital,
      expensesTotal: model.expense,
      expensesShare50: model.expenseHalf,
      digitalAdjustedTotal: model.digitalAdjusted,
      cashDebt: model.cashDebt,
      digitalDebt: model.digitalDebt,
      settlementAmount: model.from === "balanced" ? 0 : model.amount,
      settlementFrom: model.from,
      settlementTo: model.to,
      total: model.grand,
      status: "pending",
      operatorUid: user.uid,
      operatorName: currentProfile?.displayName || currentProfile?.username || "",
      requestedAt: serverTimestamp()
    });
    $("closeStatus").textContent = model.from === "balanced"
      ? "Cierre enviado. Las cuentas quedaron equilibradas."
      : `Cierre enviado. Liquidación: ${money(model.amount)}.`;
    $("closeStatus").className = "status";
    setTimeout(() => $("closeModal").classList.add("hidden"), 1100);
  } catch (err) {
    console.error(err);
    $("closeStatus").textContent = "No se pudo enviar el cierre.";
    $("closeStatus").className = "status error";
  } finally {
    $("confirmClose").disabled = false;
    $("confirmClose").textContent = "Enviar pedido";
  }
});

$("todayLabel").textContent = new Intl.DateTimeFormat("es-AR", {
  weekday:"short", day:"2-digit", month:"short"
}).format(new Date());
