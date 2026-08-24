import { firebaseConfig, BUSINESS_ID, USER_EMAIL_DOMAIN } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, doc, getDoc, setDoc,
  onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const $ = id => document.getElementById(id);
let unsubscribePayments = null;
let unsubscribeExpenses = null;
let payments = [];
let expenses = [];
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
  return `${safeUsername(value)}@${USER_EMAIL_DOMAIN}`;
}
function totalFor(method) {
  return payments.filter(p => p.method === method).reduce((a,p)=>a+Number(p.amount||0),0);
}
function expensesTotal() {
  return expenses.reduce((a,e)=>a+Number(e.amount||0),0);
}
function escapeHtml(s="") {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

// Lógica de equilibrio de la barbería:
// - El lado Efectivo conserva el 100% del efectivo cobrado.
// - El lado Digital conserva el 100% de lo cobrado digital.
// - Para repartir la facturación 50/50, cada lado genera una deuda del 50% de sus cobros.
// - Caja chica: Efectivo suma además el 5% completo de sus cobros como deuda.
// - Gastos: como los paga Efectivo, Digital suma el 50% del gasto como deuda a favor de Efectivo.
function settlementModel() {
  const cash = totalFor("cash");
  const digital = totalFor("digital");
  const expense = expensesTotal();
  const cashBox = cash * 0.05;
  const expenseHalf = expense * 0.50;

  // Totales visuales pedidos para cada columna.
  const cashAdjusted = cash + cashBox;
  const digitalAdjusted = digital + expenseHalf;

  // Deudas reales usadas para definir quién paga a quién.
  const cashDebt = (cash * 0.50) + cashBox;
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
    cash, digital, expense, cashBox, expenseHalf,
    cashAdjusted, digitalAdjusted,
    cashDebt, digitalDebt, balance, amount, from, to,
    grand: cash + digital
  };
}

function renderSettlement(model) {
  const status = $("settleStatus");
  const closeSettlement = $("closeSettlement");

  if (model.from === "balanced") {
    status.innerHTML = `<strong>Equilibrado</strong><span>No hay pagos pendientes entre Efectivo y Digital.</span>`;
    closeSettlement.innerHTML = `<span>Cuentas equilibradas</span><strong>${money(0)}</strong>`;
    return;
  }

  const fromLabel = model.from === "cash" ? "Efectivo" : "Digital";
  const toLabel = model.to === "cash" ? "Efectivo" : "Digital";
  status.innerHTML = `<strong>${fromLabel} paga a ${toLabel}</strong><span>${money(model.amount)} · al cerrar la jornada</span>`;
  closeSettlement.innerHTML = `<span>${fromLabel} paga a ${toLabel}</span><strong>${money(model.amount)}</strong>`;
}

function render() {
  const model = settlementModel();

  $("cashTotal").textContent = money(model.cash);
  $("cashBoxTotal").textContent = money(model.cashBox);
  $("cashAdjustedTotal").textContent = money(model.cashAdjusted);

  $("digitalTotal").textContent = money(model.digital);
  $("expenseHalfTotal").textContent = money(model.expenseHalf);
  $("digitalAdjustedTotal").textContent = money(model.digitalAdjusted);

  $("grandTotal").textContent = money(model.grand);
  $("centerTotal").textContent = money(model.grand);

  $("closeCash").textContent = money(model.cash);
  $("closeCashBox").textContent = money(model.cashBox);
  $("closeCashAdjusted").textContent = money(model.cashAdjusted);
  $("closeDigital").textContent = money(model.digital);
  $("closeExpenseHalf").textContent = money(model.expenseHalf);
  $("closeDigitalAdjusted").textContent = money(model.digitalAdjusted);
  $("closeGrand").textContent = money(model.grand);

  renderSettlement(model);
  renderList("cashList", payments.filter(p=>p.method==="cash"), false);
  renderList("digitalList", payments.filter(p=>p.method==="digital"), true);
  renderExpenseList();
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
          ? `<a class="proof" target="_blank" rel="noopener" href="${item.proofUrl}">Ver comprobante</a>`
          : `<span class="proof">Sin archivo</span>`)
      : "";
    return `<div class="receipt">
      <div class="receipt-top">
        <strong>${escapeHtml(item.service || "Cobro")}</strong>
        <div class="amount">${money(item.amount)}</div>
      </div>
      <div class="receipt-meta">
        <span>${escapeHtml(item.detail || "Sin detalle")} · ${time}</span>${proof}
      </div>
    </div>`;
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
      ? `<a class="proof" target="_blank" rel="noopener" href="${item.proofUrl}">Comprobante</a>`
      : `<span class="proof">Sin archivo</span>`;
    return `<div class="expense-item">
      <div><strong>${escapeHtml(item.detail || "Gasto")}</strong><small>${time} · 50% a Digital: ${money(Number(item.amount||0)*0.5)}</small></div>
      <div class="expense-amount">${money(item.amount)}</div>
      ${proof}
    </div>`;
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

  const paymentsRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "payments");
  const expensesRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "expenses");
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
    await signInWithEmailAndPassword(auth, usernameToEmail(usernameOrEmail), password);
  } catch (err) {
    console.error(err);
    $("loginStatus").textContent = "Usuario o contraseña incorrectos.";
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
    payments = [];
    expenses = [];
    currentProfile = null;
    $("app").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
    return;
  }

  try {
    currentProfile = await loadProfile(user);
    if (currentProfile.active === false) throw new Error("Usuario desactivado");
    $("operatorName").textContent = currentProfile.displayName || currentProfile.username || user.email.split("@")[0];
    $("loginScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    subscribeToday(user);
  } catch (err) {
    console.error(err);
    await signOut(auth);
    $("loginStatus").textContent = "No se pudo cargar el usuario.";
    $("loginStatus").className = "status error";
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
