import { firebaseConfig, BUSINESS_ID, USER_EMAIL_DOMAIN } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, doc, getDoc, setDoc,
  query, where, orderBy, onSnapshot, serverTimestamp
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
let payments = [];
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
function escapeHtml(s="") {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function render() {
  const cash = totalFor("cash");
  const digital = totalFor("digital");
  const grand = cash + digital;
  $("cashTotal").textContent = money(cash);
  $("digitalTotal").textContent = money(digital);
  $("grandTotal").textContent = money(grand);
  $("centerTotal").textContent = money(grand);
  $("closeCash").textContent = money(cash);
  $("closeDigital").textContent = money(digital);
  $("closeGrand").textContent = money(grand);
  renderList("cashList", payments.filter(p=>p.method==="cash"), false);
  renderList("digitalList", payments.filter(p=>p.method==="digital"), true);
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

async function loadProfile(user) {
  const profileRef = doc(db, "businesses", BUSINESS_ID, "users", user.uid);
  const snap = await getDoc(profileRef);
  if (snap.exists()) return snap.data();

  // First-login fallback. Creates a basic profile if rules permit.
  const username = user.email?.split("@")[0] || "barbero";
  const profile = { username, displayName: username, role: "barber", active: true, createdAt: serverTimestamp() };
  await setDoc(profileRef, profile, { merge: true });
  return profile;
}

function subscribeToday(user) {
  if (unsubscribePayments) unsubscribePayments();
  const paymentsRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "payments");
  const q = query(paymentsRef, where("dayKey","==",localDayKey()), orderBy("createdAt","desc"));
  $("syncStatus").textContent = "Sincronizando…";
  $("syncStatus").className = "sync";

  unsubscribePayments = onSnapshot(q, snap => {
    payments = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    render();
    $("syncStatus").textContent = "En tiempo real";
    $("syncStatus").className = "sync ok";
  }, err => {
    console.error(err);
    $("syncStatus").textContent = "Error de conexión";
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
    payments = [];
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
    $("chargeTitle").textContent = mode === "cash" ? "Cobro en efectivo" : "Cobro digital";
    $("proofField").classList.toggle("hidden", mode !== "digital");
    $("proof").required = false;
    $("chargeStatus").textContent = "";
    $("chargeModal").classList.remove("hidden");
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
  const amount = Number($("amount").value.replace(/[^\d]/g,""));
  if (!amount) return;

  $("saveChargeBtn").disabled = true;
  $("saveChargeBtn").textContent = "Guardando…";
  $("chargeStatus").textContent = "";

  try {
    let proofUrl = "";
    let proofPath = "";
    const file = $("proof").files?.[0];

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
      service: $("service").value,
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

$("closeDayBtn").addEventListener("click", () => {
  render();
  $("closeStatus").textContent = "";
  $("closeModal").classList.remove("hidden");
});

$("confirmClose").addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  $("confirmClose").disabled = true;
  $("confirmClose").textContent = "Enviando…";
  try {
    const cash = totalFor("cash");
    const digital = totalFor("digital");
    const closuresRef = collection(db, "businesses", BUSINESS_ID, "users", user.uid, "closures");
    await addDoc(closuresRef, {
      dayKey: localDayKey(),
      cashTotal: cash,
      digitalTotal: digital,
      total: cash + digital,
      status: "pending",
      operatorUid: user.uid,
      operatorName: currentProfile?.displayName || currentProfile?.username || "",
      requestedAt: serverTimestamp()
    });
    $("closeStatus").textContent = "Pedido de cierre enviado.";
    $("closeStatus").className = "status";
    setTimeout(() => $("closeModal").classList.add("hidden"), 900);
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
