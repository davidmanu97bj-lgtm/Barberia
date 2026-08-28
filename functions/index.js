const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

initializeApp();

const auth = getAuth();
const db = getFirestore();
const REGION = "southamerica-east1";
const BUSINESS_ID = "barberia-c25a1";
const USER_EMAIL_DOMAIN = "barberia.local";
const ADMIN_ROLES = new Set(["admin", "administrador", "owner", "propietario", "superadmin"]);
const PROFILE_COLLECTIONS = ["administradores", "admins", "barberos", "usuarios", "users", "perfiles"];

function text(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return text(value).normalize("NFKC").toLowerCase();
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
