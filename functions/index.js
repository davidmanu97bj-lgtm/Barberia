const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

initializeApp();

const auth = getAuth();
const db = getFirestore();
const REGION = "southamerica-east1";
const BUSINESS_ID = "barberia-c25a1";
const USER_EMAIL_DOMAIN = "barberia.local";
const ADMIN_ROLES = new Set(["admin", "administrador", "owner", "propietario", "superadmin"]);
const PROFILE_COLLECTIONS = ["administradores", "admins", "barberos", "usuarios", "users", "perfiles"];
const TELEGRAM_CHAT_ID = "-5393018000";
const TELEGRAM_BOT_TOKEN = defineSecret("BARBERIA_TELEGRAM_BOT_TOKEN");
const TELEGRAM_DELIVERY_COLLECTION = "_telegram_delivery";

function text(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return text(value).normalize("NFKC").toLowerCase();
}


function money(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(Number.isFinite(amount) ? amount : 0);
}

function paymentMethodLabel(method) {
  return normalized(method) === "digital" ? "Digital" : "Efectivo";
}

function settlementLine(direction, amount, barberName) {
  const name = text(barberName) || "Barbero";
  const settlementAmount = Math.abs(Number(amount || 0));
  if (direction === "barber_pays_business") {
    return `${name} debe entregar a Barbería: ${money(settlementAmount)}`;
  }
  if (direction === "business_pays_barber") {
    return `Barbería debe pagar a ${name}: ${money(settlementAmount)}`;
  }
  return "Saldo equilibrado: no hay dinero por liquidar.";
}

function directionFromBalance(balance) {
  const amount = Number(balance || 0);
  if (amount > 0.5) return "barber_pays_business";
  if (amount < -0.5) return "business_pays_barber";
  return "balanced";
}

function buildChargeTelegramMessage(data = {}) {
  const amount = Number(data.amount || data.monto || 0);
  const barberName = text(data.barberName || data.barberoNombre) || "Barbero";
  const balanceAfter = Number(data.balanceAfter || 0);
  const direction = directionFromBalance(balanceAfter);
  return [
    "💈 NUEVO COBRO · BARBERÍA",
    `Barbero: ${barberName}`,
    `Servicio: ${text(data.service) || "Sin detalle"}`,
    `Método: ${paymentMethodLabel(data.method || data.paymentMethod)}`,
    `Cobro: ${money(amount)}`,
    `Publicidad 10%: ${money(amount * 0.10)} (5% efectivo + 5% digital)`,
    `Barbero 45%: ${money(amount * 0.45)}`,
    `Barbería 45%: ${money(amount * 0.45)}`,
    settlementLine(direction, Math.abs(balanceAfter), barberName)
  ].join("\n");
}

function buildClosureRequestedTelegramMessage(data = {}) {
  const barberName = text(data.barberName || data.barberoNombre) || "Barbero";
  return [
    "🧾 CIERRE SOLICITADO · BARBERÍA",
    `Barbero: ${barberName}`,
    `Total facturado: ${money(data.totalBilled)}`,
    `Efectivo: ${money(data.cashTotal)}`,
    `Digital: ${money(data.digitalTotal)}`,
    `Publicidad 10%: ${money(data.advertisingFund)}`,
    settlementLine(data.direction, data.settlementAmount, barberName),
    "Estado: pendiente de resolución."
  ].join("\n");
}

function buildClosureCompletedTelegramMessage(data = {}) {
  const barberName = text(data.barberName || data.barberoNombre) || "Barbero";
  return [
    "✅ CIERRE COMPLETADO · BARBERÍA",
    `Barbero: ${barberName}`,
    settlementLine(data.direction, data.settlementAmount, barberName),
    `Total del período: ${money(data.totalBilled)}`,
    `Resuelto por: ${text(data.completedByName) || "Administrador"}`,
    "Estado: completado."
  ].join("\n");
}

function safeDeliveryId(value) {
  return text(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 240);
}

async function sendTelegramMessage(message) {
  const token = TELEGRAM_BOT_TOKEN.value();
  if (!token) throw new Error("Falta configurar BARBERIA_TELEGRAM_BOT_TOKEN.");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Telegram respondió ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
}

async function deliverTelegramOnce(deliveryId, message) {
  const ref = db.collection(TELEGRAM_DELIVERY_COLLECTION).doc(safeDeliveryId(deliveryId));
  try {
    await ref.create({
      businessId: BUSINESS_ID,
      chatId: TELEGRAM_CHAT_ID,
      status: "processing",
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    if (error?.code === 6 || error?.code === "already-exists" || error?.code === "6") {
      logger.info("Notificación de Telegram ya procesada.", { deliveryId });
      return false;
    }
    throw error;
  }

  try {
    await sendTelegramMessage(message);
    await ref.set({ status: "sent", sentAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  } catch (error) {
    await ref.delete().catch(() => {});
    logger.error("No se pudo enviar la notificación de Barbería a Telegram.", {
      deliveryId,
      error: error?.message || String(error)
    });
    throw error;
  }
}

function normalizeUsername(value) {
  return normalized(value)
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9._-]/g, "");
}

function validUsername(value) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(value);
}

function validPassword(value) {
  return typeof value === "string" && value.length >= 6 && value.length <= 72;
}

function isAdminProfile(data = {}) {
  return data.admin === true || data.isAdmin === true ||
    ADMIN_ROLES.has(normalized(data.role || data.rol || data.tipoUsuario || data.tipo));
}

async function assertAdmin(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  const token = request.auth.token || {};
  if (token.admin === true || ADMIN_ROLES.has(normalized(token.role || token.rol))) {
    return request.auth.uid;
  }

  for (const collectionName of PROFILE_COLLECTIONS) {
    const snapshot = await db.collection(collectionName).doc(request.auth.uid).get().catch(() => null);
    if (!snapshot?.exists) continue;
    if (collectionName === "administradores" || collectionName === "admins" || isAdminProfile(snapshot.data() || {})) {
      return request.auth.uid;
    }
  }
  throw new HttpsError("permission-denied", "Tu cuenta no tiene permisos de administrador.");
}

function publicBarberProfile({ uid, username, email, name, active, adminUid, now }) {
  return {
    uid,
    authUid: uid,
    barberUid: uid,
    barberoUid: uid,
    username,
    usuario: username,
    usuarioNormalizado: username,
    email,
    authEmail: email,
    displayName: name,
    nombre: name,
    nombreCompleto: name,
    role: "barber",
    rol: "barbero",
    active,
    activo: active,
    status: active ? "active" : "inactive",
    estado: active ? "activo" : "inactivo",
    businessId: BUSINESS_ID,
    updatedAt: now,
    updatedByUid: adminUid
  };
}

exports.adminCreateBarber = onCall({
  region: REGION,
  timeoutSeconds: 120,
  memory: "512MiB",
  invoker: "public"
}, async request => {
  const adminUid = await assertAdmin(request);
  const name = text(request.data?.name || request.data?.nombre);
  const username = normalizeUsername(request.data?.username || request.data?.usuario);
  const password = text(request.data?.password);
  const requestedEmail = normalized(request.data?.email);
  const email = requestedEmail || `${username}@${USER_EMAIL_DOMAIN}`;

  if (!name || name.length > 100) {
    throw new HttpsError("invalid-argument", "El nombre es obligatorio y debe tener hasta 100 caracteres.");
  }
  if (!validUsername(username)) {
    throw new HttpsError("invalid-argument", "El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.");
  }
  if (!validPassword(password)) {
    throw new HttpsError("invalid-argument", "La clave debe tener entre 6 y 72 caracteres.");
  }

  const aliasRef = db.collection("login_aliases").doc(username);
  if ((await aliasRef.get()).exists) {
    throw new HttpsError("already-exists", "Ese usuario ya está en uso.");
  }

  let userRecord;
  try {
    userRecord = await auth.createUser({ email, password, displayName: name, disabled: false });
    await auth.setCustomUserClaims(userRecord.uid, { role: "barber", rol: "barbero", businessId: BUSINESS_ID });
  } catch (error) {
    if (error?.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "Ese correo o usuario ya existe.");
    }
    throw new HttpsError("internal", error?.message || "No se pudo crear el acceso del barbero.");
  }

  const uid = userRecord.uid;
  const now = FieldValue.serverTimestamp();
  const profile = {
    ...publicBarberProfile({ uid, username, email, name, active: true, adminUid, now }),
    createdAt: now,
    createdByUid: adminUid
  };
  const batch = db.batch();
  batch.create(db.collection("barberos").doc(uid), profile);
  batch.set(db.collection("usuarios").doc(uid), profile, { merge: true });
  batch.create(aliasRef, {
    uid,
    authUid: uid,
    barberUid: uid,
    username,
    usuario: username,
    email,
    role: "barber",
    rol: "barbero",
    active: true,
    businessId: BUSINESS_ID,
    createdAt: now,
    createdByUid: adminUid
  });
  batch.create(db.collection("admin_audit").doc(`create_barber_${uid}`), {
    action: "admin_create_barber",
    adminUid,
    targetUid: uid,
    targetName: name,
    targetUsername: username,
    createdAt: now
  });

  try {
    await batch.commit();
  } catch (error) {
    await auth.deleteUser(uid).catch(() => {});
    throw new HttpsError("internal", error?.message || "No se pudo guardar el perfil del barbero.");
  }

  return { ok: true, uid, username, email, name };
});

exports.adminUpdateBarber = onCall({
  region: REGION,
  timeoutSeconds: 120,
  memory: "512MiB",
  invoker: "public"
}, async request => {
  const adminUid = await assertAdmin(request);
  const barberUid = text(request.data?.barberUid || request.data?.barberoUid || request.data?.uid);
  const name = text(request.data?.name || request.data?.nombre);
  const password = text(request.data?.password);
  const active = request.data?.active !== false;

  if (!barberUid) throw new HttpsError("invalid-argument", "Falta seleccionar el barbero.");
  if (!name || name.length > 100) throw new HttpsError("invalid-argument", "El nombre no es válido.");
  if (password && !validPassword(password)) {
    throw new HttpsError("invalid-argument", "La nueva clave debe tener entre 6 y 72 caracteres.");
  }

  const primaryRef = db.collection("barberos").doc(barberUid);
  let snapshot = await primaryRef.get();
  if (!snapshot.exists) snapshot = await db.collection("usuarios").doc(barberUid).get();
  if (!snapshot.exists) throw new HttpsError("not-found", "No se encontró el barbero.");
  const existing = snapshot.data() || {};
  const authUid = text(existing.authUid || existing.uid || barberUid);
  const username = normalizeUsername(existing.username || existing.usuario || "");
  const email = normalized(existing.authEmail || existing.email || (username ? `${username}@${USER_EMAIL_DOMAIN}` : ""));

  const authUpdate = { displayName: name, disabled: !active };
  if (password) authUpdate.password = password;
  try {
    await auth.updateUser(authUid, authUpdate);
  } catch (error) {
    throw new HttpsError("internal", error?.message || "No se pudo actualizar el acceso.");
  }

  const now = FieldValue.serverTimestamp();
  const profile = publicBarberProfile({ uid: authUid, username, email, name, active, adminUid, now });
  const batch = db.batch();
  batch.set(primaryRef, profile, { merge: true });
  batch.set(db.collection("usuarios").doc(barberUid), profile, { merge: true });
  if (username) {
    batch.set(db.collection("login_aliases").doc(username), {
      uid: authUid,
      authUid,
      barberUid,
      username,
      email,
      active,
      role: "barber",
      rol: "barbero",
      businessId: BUSINESS_ID,
      updatedAt: now,
      updatedByUid: adminUid
    }, { merge: true });
  }
  batch.create(db.collection("admin_audit").doc(`update_barber_${barberUid}_${Date.now()}`), {
    action: "admin_update_barber",
    adminUid,
    targetUid: barberUid,
    targetName: name,
    active,
    passwordChanged: Boolean(password),
    createdAt: now
  });
  await batch.commit();

  return { ok: true, barberUid, name, active, passwordChanged: Boolean(password) };
});

exports.telegramBarberChargeCreated = onDocumentCreated({
  document: "cobros/{chargeId}",
  region: REGION,
  memory: "256MiB",
  timeoutSeconds: 60,
  secrets: [TELEGRAM_BOT_TOKEN]
}, async event => {
  const snapshot = event.data;
  if (!snapshot) return;
  const data = snapshot.data() || {};
  if (data.businessId !== BUSINESS_ID || data.telegramReady !== true || data.telegramEventType !== "barber_charge_created") return;

  const sent = await deliverTelegramOnce(
    `charge_created_${event.params.chargeId}`,
    buildChargeTelegramMessage(data)
  );
  if (sent) {
    await snapshot.ref.set({
      telegramStatus: "sent",
      telegramChatId: TELEGRAM_CHAT_ID,
      telegramSentAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
});

exports.telegramBarberClosureRequested = onDocumentCreated({
  document: "cierres/{closureId}",
  region: REGION,
  memory: "256MiB",
  timeoutSeconds: 60,
  secrets: [TELEGRAM_BOT_TOKEN]
}, async event => {
  const snapshot = event.data;
  if (!snapshot) return;
  const data = snapshot.data() || {};
  if (data.businessId !== BUSINESS_ID || data.telegramReady !== true || data.telegramEventType !== "barber_closure_requested") return;

  const sent = await deliverTelegramOnce(
    `closure_requested_${event.params.closureId}`,
    buildClosureRequestedTelegramMessage(data)
  );
  if (sent) {
    await snapshot.ref.set({
      telegramRequestStatus: "sent",
      telegramChatId: TELEGRAM_CHAT_ID,
      telegramRequestSentAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
});

exports.telegramBarberClosureCompleted = onDocumentUpdated({
  document: "cierres/{closureId}",
  region: REGION,
  memory: "256MiB",
  timeoutSeconds: 60,
  secrets: [TELEGRAM_BOT_TOKEN]
}, async event => {
  if (!event.data) return;
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const becameCompleted = before.status !== "completed" && after.status === "completed";
  if (!becameCompleted || after.businessId !== BUSINESS_ID || after.telegramUpdateReady !== true || after.telegramUpdateEventType !== "barber_closure_completed") return;

  const sent = await deliverTelegramOnce(
    `closure_completed_${event.params.closureId}`,
    buildClosureCompletedTelegramMessage(after)
  );
  if (sent) {
    await event.data.after.ref.set({
      telegramCompletionStatus: "sent",
      telegramChatId: TELEGRAM_CHAT_ID,
      telegramCompletionSentAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
});

