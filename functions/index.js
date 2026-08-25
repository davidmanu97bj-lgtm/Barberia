"use strict";

const crypto = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { calculateOpenBillingBalance, isDriverBillingSettlementPayment } = require("./telegram-billing-balance");
const {
  buildAdminDebtPaymentTelegramText,
  isAdminDebtPayment
} = require("./telegram-debt-payment");
const {
  buildAdminDriverDebtTelegramText,
  isAdminDriverDebt
} = require("./telegram-driver-debt");

const PROJECT_ID = "explora-control-operativo";
const STORAGE_BUCKET = `${PROJECT_ID}.firebasestorage.app`;

initializeApp({ storageBucket: STORAGE_BUCKET });
const db = getFirestore();
const auth = getAuth();
const bucket = getStorage().bucket(STORAGE_BUCKET);

const ADMIN_UIDS = new Set(["2LziyTTdFcZzSOhK3hLbAKs2U4s2"]);
const ADMIN_ROLES = new Set(["admin", "administrador", "owner", "superadmin"]);
const ADMIN_PROFILE_COLLECTIONS = ["administradores", "admins", "usuarios", "choferes"];
const DELETION_JOBS_COLLECTION = "admin_driver_deletion_jobs";
const ADMIN_AUDIT_COLLECTION = "admin_audit";
const PAGE_SIZE = 180;
const MAX_SCANNED_DOCUMENTS = 25000;


// Telegram: secretos administrados por Firebase Secret Manager.
// TELEGRAM_BOT_TOKEN ya puede existir; TELEGRAM_CHAT_ID debe contener el ID del chat/grupo.
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineSecret("TELEGRAM_CHAT_ID");
const TELEGRAM_NOTIFICATIONS_COLLECTION = "telegram_notifications";
const TELEGRAM_FUNCTION_REGION = "us-central1";
const TELEGRAM_PROCESSING_LEASE_MS = 10 * 60 * 1000;
const TELEGRAM_BALANCE_FALLBACK_DRIVER_FIELDS = ["choferUid", "uid"];

// WhatsApp operativo deshabilitado: todas las notificaciones solicitadas salen por Telegram.

function telegramSafeText(value) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

function telegramMoney(value) {
  const parsed = Number(value ?? 0);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(amount);
}

function telegramTimestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value._seconds === "number") return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1000000);
  if (typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
  return 0;
}

function telegramDateLabel(data = {}) {
  const ms = telegramTimestampMs(data.createdAt)
    || telegramTimestampMs(data.completedAt)
    || telegramTimestampMs(data.expenseDate)
    || telegramTimestampMs(data.receiptUploadedAt)
    || Number(data.createdAtMs || 0)
    || Date.now();
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(ms));
}

function telegramDriverName(data = {}) {
  return telegramSafeText(
    data.driverName || data.choferNombre || data.nombreChofer || data.nombreConductor ||
    data.displayName || data.chofer || data.usuario || "Chofer"
  );
}

function telegramAmount(data = {}) {
  for (const value of [data.amount, data.monto, data.valor, data.finalPrice, data.totalAmount, data.total, data.importe]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function telegramPaymentMethod(data = {}) {
  const raw = telegramSafeText(
    data.paymentMethod || data.metodoPago || data.financialCategory ||
    data.receiptPaymentMethod || data.paymentProvider || data.method || data.tipoPago
  ).toLowerCase();
  if (/qr/.test(raw)) return { key: "qr", label: "QR" };
  if (/card|tarjeta|point|posnet/.test(raw)) return { key: "card", label: "Tarjeta" };
  if (/transfer|alias|transf/.test(raw)) return { key: "transfer", label: "Transferencia" };
  if (/digital|online|electr[oó]nic/.test(raw)) return { key: "digital", label: "Digital" };
  if (/cash|efectivo/.test(raw)) return { key: "cash", label: "Efectivo" };
  return { key: raw || "unknown", label: raw ? raw.toUpperCase() : "Sin especificar" };
}

function telegramExpenseType(data = {}) {
  const raw = telegramSafeText(data.expenseType || data.tipo || data.category || data.categoria || "Gasto");
  const normalizedType = raw.toLowerCase();
  const labels = {
    combustible: "Combustible",
    fuel: "Combustible",
    peaje: "Peaje",
    toll: "Peaje",
    mantenimiento: "Mantenimiento",
    maintenance: "Mantenimiento",
    lavado: "Lavado",
    wash: "Lavado",
    estacionamiento: "Estacionamiento",
    parking: "Estacionamiento",
    otros: "Otros",
    other: "Otros"
  };
  return labels[normalizedType] || raw || "Gasto";
}

function telegramDriverUid(data = {}) {
  return telegramSafeText(
    data.driverUid || data.choferUid || data.uid || data.ownerUid ||
    data.driverId || data.choferId || data.userUid || data.createdByUid
  );
}

async function telegramDriverDocuments(collectionName, driverUid) {
  const targetUid = telegramSafeText(driverUid);
  if (!targetUid) throw new Error(`No se pudo identificar el chofer para consultar ${collectionName}.`);

  const documents = new Map();
  try {
    const canonicalSnap = await db.collection(collectionName).where("driverUid", "==", targetUid).get();
    canonicalSnap.docs.forEach(docSnap => documents.set(docSnap.id, { id: docSnap.id, ...(docSnap.data() || {}) }));
    return [...documents.values()];
  } catch (canonicalError) {
    console.warn("[telegram balance] canonical query failed", collectionName, canonicalError?.code || canonicalError?.message || canonicalError);
  }

  const attempts = await Promise.all(TELEGRAM_BALANCE_FALLBACK_DRIVER_FIELDS.map(async field => {
    try {
      const snap = await db.collection(collectionName).where(field, "==", targetUid).get();
      snap.docs.forEach(docSnap => documents.set(docSnap.id, { id: docSnap.id, ...(docSnap.data() || {}) }));
      return true;
    } catch (error) {
      console.warn("[telegram balance] query skipped", collectionName, field, error?.code || error?.message || error);
      return false;
    }
  }));

  if (!attempts.some(Boolean)) throw new Error(`No se pudo consultar ${collectionName} para calcular el saldo.`);
  return [...documents.values()];
}

async function telegramOpenBillingBalance(data = {}, docId = "") {
  const driverUid = telegramDriverUid(data);
  const [records, closures, uberWeeks] = await Promise.all([
    telegramDriverDocuments("billing_records", driverUid),
    telegramDriverDocuments("cierres_semanales", driverUid),
    telegramDriverDocuments("uber_weekly_closures", driverUid)
  ]);
  const currentId = telegramSafeText(docId);
  const currentRecord = { id: currentId, ...data };
  const allRecords = currentId
    ? [...records.filter(row => telegramSafeText(row.id) !== currentId), currentRecord]
    : [...records, currentRecord];
  return calculateOpenBillingBalance({ records: allRecords, closures, uberWeeks });
}

function telegramBillingBalanceLine(balance = {}) {
  const amountFromDriver = Number(balance.amountFromDriver || 0);
  const amountToDriver = Number(balance.amountToDriver || 0);
  if (amountFromDriver > 0.49) {
    return `Saldo acumulado: Chofer debe liquidar a Explora ${telegramMoney(amountFromDriver)}`;
  }
  if (amountToDriver > 0.49) {
    return `Saldo acumulado: Explora debe liquidar al chofer ${telegramMoney(amountToDriver)}`;
  }
  return "Saldo acumulado: nadie debe liquidar";
}

function telegramDirectPhotoUrl(data = {}) {
  const candidates = [
    data.telegramPhotoUrl, data.notificationPhotoUrl, data.firebasePhotoUrl,
    data.whatsappPhotoUrl, data.receiptUrl, data.comprobanteUrl, data.downloadURL,
    data.fileUrl, data.photoUrl, data.imageUrl, data.archivoUrl
  ];
  for (const value of candidates) {
    const url = telegramSafeText(value);
    if (/^https?:\/\//i.test(url)) return url;
  }
  return "";
}

async function telegramResolvePhotoUrl(kind, docId, data = {}) {
  const direct = telegramDirectPhotoUrl(data);
  if (direct) return direct;

  const candidateIds = kind === "billing"
    ? [`payment_${docId}`, `billing_${docId}`]
    : [`expense_${docId}`, `gasto_${docId}`];
  for (const receiptId of candidateIds) {
    const snap = await db.collection("receipt_index").doc(receiptId).get();
    if (snap.exists) {
      const url = telegramDirectPhotoUrl(snap.data() || {});
      if (url) return url;
    }
  }

  const byRecord = await db.collection("receipt_index").where("recordId", "==", docId).limit(3).get();
  for (const row of byRecord.docs) {
    const url = telegramDirectPhotoUrl(row.data() || {});
    if (url) return url;
  }
  return "";
}

function telegramNotificationDocId(kind, docId) {
  return `${kind}_${docId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 300);
}

async function telegramClaimNotification(kind, notificationKey, sourceCollection, sourceDocumentId, eventId) {
  const key = telegramSafeText(notificationKey || sourceDocumentId);
  const ref = db.collection(TELEGRAM_NOTIFICATIONS_COLLECTION).doc(telegramNotificationDocId(kind, key));
  const nowMs = Date.now();
  const claimed = await db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const current = snap.exists ? (snap.data() || {}) : {};
    if (current.status === "sent") return false;
    if (current.status === "processing" && Number(current.updatedAtMs || 0) > nowMs - TELEGRAM_PROCESSING_LEASE_MS) return false;
    transaction.set(ref, {
      type: kind,
      sourceDocumentId: telegramSafeText(sourceDocumentId),
      sourceCollection: telegramSafeText(sourceCollection),
      eventId: telegramSafeText(eventId),
      status: "processing",
      attempts: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtMs: nowMs,
      createdAt: current.createdAt || FieldValue.serverTimestamp()
    }, { merge: true });
    return true;
  });
  return { claimed, ref };
}

async function telegramApi(method, payload, { multipart = false } = {}) {
  const token = telegramSafeText(TELEGRAM_BOT_TOKEN.value());
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN no está configurado.");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: multipart ? undefined : { "content-type": "application/json" },
    body: multipart ? payload : JSON.stringify(payload)
  });
  const bodyText = await response.text();
  let body = null;
  try { body = JSON.parse(bodyText); } catch (_) { body = { ok: false, description: bodyText }; }
  if (!response.ok || !body?.ok) {
    const error = new Error(`Telegram ${method}: ${body?.description || response.statusText || response.status}`);
    error.telegramStatus = response.status;
    throw error;
  }
  return body.result;
}

async function telegramSendPhoto(photoUrl, caption) {
  const chatId = telegramSafeText(TELEGRAM_CHAT_ID.value());
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID no está configurado.");

  try {
    return await telegramApi("sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption.slice(0, 1024)
    });
  } catch (urlError) {
    // Respaldo: descarga la imagen desde Firebase y la adjunta físicamente.
    const imageResponse = await fetch(photoUrl, { redirect: "follow" });
    if (!imageResponse.ok) throw urlError;
    const bytes = await imageResponse.arrayBuffer();
    const contentType = telegramSafeText(imageResponse.headers.get("content-type")) || "image/jpeg";
    const extension = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption.slice(0, 1024));
    form.append("photo", new Blob([bytes], { type: contentType }), `comprobante.${extension}`);
    return telegramApi("sendPhoto", form, { multipart: true });
  }
}

function telegramAttachmentIsPdf(data = {}, url = "") {
  const mimeType = telegramSafeText(
    data.receiptMimeType || data.comprobanteMimeType || data.fileMimeType || data.mimeType
  ).toLowerCase();
  const fileName = telegramSafeText(
    data.receiptName || data.receiptFileName || data.comprobanteNombre || data.fileName
  ).toLowerCase();
  const cleanUrl = telegramSafeText(url).split(/[?#]/, 1)[0].toLowerCase();
  return mimeType.includes("pdf") || fileName.endsWith(".pdf") || cleanUrl.endsWith(".pdf");
}

async function telegramSendDocument(documentUrl, caption) {
  const chatId = telegramSafeText(TELEGRAM_CHAT_ID.value());
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID no está configurado.");

  try {
    return await telegramApi("sendDocument", {
      chat_id: chatId,
      document: documentUrl,
      caption: caption.slice(0, 1024)
    });
  } catch (urlError) {
    const documentResponse = await fetch(documentUrl, { redirect: "follow" });
    if (!documentResponse.ok) throw urlError;
    const bytes = await documentResponse.arrayBuffer();
    const contentType = telegramSafeText(documentResponse.headers.get("content-type")) || "application/pdf";
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption.slice(0, 1024));
    form.append("document", new Blob([bytes], { type: contentType }), "comprobante.pdf");
    return telegramApi("sendDocument", form, { multipart: true });
  }
}

async function telegramSendText(text) {
  const chatId = telegramSafeText(TELEGRAM_CHAT_ID.value());
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID no está configurado.");
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096)
  });
}

async function telegramProcessNotification({
  kind,
  docId,
  notificationKey = docId,
  sourceCollection = kind === "billing" ? "billing_records" : kind === "expense" ? "gastos" : "",
  sourceDocumentId = docId,
  data,
  eventId,
  caption,
  requirePhoto = true
}) {
  const { claimed, ref } = await telegramClaimNotification(
    kind,
    notificationKey,
    sourceCollection,
    sourceDocumentId,
    eventId
  );
  if (!claimed) return { skipped: true, reason: "already-processed-or-processing" };
  try {
    let photoUrl = "";
    let message = null;
    if (requirePhoto) {
      photoUrl = await telegramResolvePhotoUrl(kind, sourceDocumentId, data);
      if (!photoUrl) throw new Error(`El documento ${sourceCollection || kind}/${sourceDocumentId} no contiene una URL de foto.`);
      message = telegramAttachmentIsPdf(data, photoUrl)
        ? await telegramSendDocument(photoUrl, caption)
        : await telegramSendPhoto(photoUrl, caption);
    } else {
      message = await telegramSendText(caption);
    }
    await ref.set({
      status: "sent",
      telegramMessageId: message?.message_id || null,
      telegramChatId: telegramSafeText(message?.chat?.id),
      photoUrl: photoUrl || FieldValue.delete(),
      sentAt: FieldValue.serverTimestamp(),
      sentAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtMs: Date.now(),
      lastError: FieldValue.delete()
    }, { merge: true });
    return { sent: true, messageId: message?.message_id || null };
  } catch (error) {
    await ref.set({
      status: "error",
      lastError: telegramSafeText(error?.message || error).slice(0, 900),
      failedAt: FieldValue.serverTimestamp(),
      failedAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtMs: Date.now()
    }, { merge: true }).catch(() => {});
    throw error;
  }
}


function closureTelegramAllowed(data = {}) {
  const role = telegramSafeText(data.requestedByRole || data.createdByRole).toLowerCase();
  if (role && role !== "driver" && role !== "chofer") return false;
  const keys = [
    data.closureKind, data.closureType, data.moduleKey, data.closureModuleKey,
    data.payTab, data.homeModule, data.requestModule, data.originModule
  ].map(value => telegramSafeText(value).toLowerCase().replace(/[\s-]+/g, "_"));
  const allowed = new Set(["chofer", "explora", "facturacion", "billing", "gastos", "gasto", "expenses", "caja_chica", "cashbox"]);
  return data.billingClosure === true || data.autoClosesCashbox === true || keys.some(key => allowed.has(key));
}

function closureTelegramText(data = {}) {
  const kind = telegramSafeText(data.closureKind || data.closureType || data.moduleKey || data.payTab || "cierre");
  const amountFromDriver = Number(data.amountDueFromDriver || 0);
  const amountToDriver = Number(data.amountDueToDriver || 0);
  const result = amountFromDriver > 0.49
    ? `Chofer debe pagar ${telegramMoney(amountFromDriver)}`
    : amountToDriver > 0.49
      ? `Explora debe pagar ${telegramMoney(amountToDriver)}`
      : "Sin saldo a liquidar";
  return [
    "PEDIDO DE CIERRE EXPLORA",
    `Chofer: ${telegramDriverName(data)}`,
    `Tipo: ${kind || "cierre"}`,
    `Resultado: ${result}`,
    `Total facturado: ${telegramMoney(data.gross || data.grossAmount || 0)}`,
    `Gastos: ${telegramMoney(data.expenseTotal || 0)}`,
    `Caja chica: ${telegramMoney(data.cashboxTotal || data.cashboxGeneratedTotal || 0)}`,
    `Fecha: ${telegramDateLabel(data)}`
  ].join("\n");
}

function uberTelegramText(data = {}) {
  const review = telegramSafeText(data.reviewStatus || data.status).toLowerCase();
  const noData = data.noData === true || review === "no_data";
  if (noData) {
    return [
      "CIERRE UBER SIN DATOS",
      `Chofer: ${telegramDriverName(data)}`,
      `Semana: ${telegramSafeText(data.weekLabel || data.weekId || "—")}`,
      "Estado: cerrada sin datos por el chofer.",
      `Fecha: ${telegramDateLabel(data)}`
    ].join("\n");
  }
  return [
    "NUEVO COMPROBANTE UBER",
    `Chofer: ${telegramDriverName(data)}`,
    `Semana cargada: ${telegramSafeText(data.weekLabel || data.weekId || "—")}`,
    `Total Uber: ${telegramMoney(data.totalAmount || data.grossAmount || 0)}`,
    `Deudas (50%): ${telegramMoney(data.debtAmount || data.exploraShare || 0)}`,
    `Caja chica Uber (5%): ${telegramMoney(data.cashboxAmount || data.uberCashboxAmount || 0)}`,
    "Estado: pendiente de revisión en Explora.",
    `Fecha: ${telegramDateLabel(data)}`
  ].join("\n");
}

const PROTECTED_ROOT_COLLECTIONS = new Set([
  "system", "configuracion", "explora_config", "tarifas", "settings",
  "app_reset_audit", "app_operational_state", "app_reset_storage_manifests",
  "app_reset_storage_manifest_items", DELETION_JOBS_COLLECTION, ADMIN_AUDIT_COLLECTION,
  "administradores", "admins"
]);
const SPECIAL_ROOT_COLLECTIONS = new Set(["choferes", "login_aliases", "vehiculos"]);

// El reseteo por chofer conserva identidad, acceso y vehículo. Sólo elimina
// información operativa que pertenece al chofer seleccionado.
const DRIVER_RESET_MASTER_COLLECTIONS = new Set([
  ...PROTECTED_ROOT_COLLECTIONS,
  ...SPECIAL_ROOT_COLLECTIONS,
  "usuarios", "users", "perfiles"
]);
const DRIVER_RESET_OPERATIONAL_COLLECTIONS = new Set([
  "billing_records", "gastos", "facturacion_semanal", "gastos_semanales", "servicios_facturados", "cobros", "ingresos", "payment_operations", "receipt_index",
  "derivaciones", "derivaciones_pendientes", "historial_derivaciones", "derivation_audit", "colaboraciones", "retenciones", "bonos_derivaciones",
  "cierres_semanales", "cierres_mensuales", "pagos_semanales", "acumulados_semanales", "historial_cierres",
  "prestamos_operativos", "prestamos_explora", "prestamos_explora_ventanas_8s", "prestamos_explora_ventanas_publicas_8s", "prestamos_explora_historial", "deudas_choferes", "deuda_pagos", "deuda_movimientos",
  "performance_awards", "performance_cycles", "performance_derivation_winners", "performance_public", "derivation_ranking_public", "ranking_metas_public", "ranking_derivaciones_public",
  "derivation_ranking", "derivation_rankings", "derivation_stats", "derivation_monthly_stats", "derivation_summary", "derivation_summaries", "derivation_winners", "derivation_bonus", "derivation_bonuses", "ranking_derivaciones", "ranking_derivador", "ranking_derivadores", "ranking_derivaciones_historial", "ranking_derivaciones_estadisticas",
  "ranking_facturador", "ranking_semanal", "ranking_mensual", "performance_mensual", "performance_semanal", "historial_rendimiento_temporal", "historial_metricas", "historial_rendimiento", "historial_financiero", "metricas_ciclo", "beneficios_ciclo", "ventanas_metas", "metas_temporales", "beneficios_temporales",
  "simulaciones_choferes", "simulation_operations", "novedades", "novedades_temporales", "notificaciones", "notificaciones_temporales", "estados_temporales",
  "cache_rankings", "cache_metas", "cache_dashboard", "cache_derivaciones", "cache_novedades", "cache_performance", "snapshots_semanales", "snapshots_mensuales", "snapshots_financieros", "personalRecordEvents"
]);
const DRIVER_OPERATIONAL_PROFILE_FIELDS = [
  "deuda", "deudaActual", "deudaTotal", "saldoDeuda", "prestamo", "prestamoActual", "prestamoActivo", "loanBalance",
  "facturacionSemanal", "gastosSemanales", "rankingSemanal", "rankingMensual", "performanceMensual", "performanceSemanal",
  "cierreSemanal", "cierreMensual", "simulacionActiva", "simulationActive", "simulationConfigId", "totalFacturado",
  "totalGastos", "weeklyRevenue", "monthlyRevenue", "currentGoal", "goalPercent", "benefitAmount", "derivationAmount",
  "rankingPosition", "derivationRankingPosition", "derivationRank", "derivedMoney", "totalDerivedMoney", "completedDerivations", "sentCompletedDerivations", "derivationCount", "derivationBonus", "bonusAmount", "currentWinner", "previousWinner", "derivationStats", "monthlyDerivationStats", "derivationSummary", "closureStatus", "debtBalance", "currentWeekSnapshot", "lastClosure", "pendingReceipt",
  "pendingNotification", "performanceHistory", "operationalStats", "cashBalance", "cashboxBalance", "cashboxResetAt", "lastCashboxResetAt",
  "driverBalance", "exploraBalance", "expenseBalance", "debtPending", "pendingClosure", "pendingClosures", "lastSettlement", "lastLiquidation"
];
const DRIVER_RESET_STORAGE_FIELDS = new Set([
  "storagepath", "fullpath", "receiptpath", "comprobantepath", "adminreceiptpath",
  "driverreceiptpath", "expensereceiptpath", "billingreceiptpath", "closurereceiptpath",
  "debtreceiptpath", "loanreceiptpath", "filepath", "archivopath", "davidreceiptpath",
  "downloadurl", "receipturl", "comprobanteurl", "adminreceipturl", "driverreceipturl",
  "expensereceipturl", "billingreceipturl", "closurereceipturl", "debtreceipturl",
  "loanreceipturl", "fileurl", "archivourl", "davidreceipturl"
]);

const STRONG_OWNER_FIELDS = [
  "driverUid", "simulationDriverUid", "choferUid", "uid", "userId", "usuarioUid",
  "ownerUid", "driverId", "choferId", "profileId", "perfilId", "profileDocumentId",
  "conductorId", "createdForUid", "ownerId", "winnerUid", "leaderUid",
  "currentWinnerUid", "dailyWinnerUid", "winnerDriverId", "leaderId", "uidGanador", "ganadorUid"
];
const SHARED_PARTICIPANT_FIELDS = [
  "emisorUid", "receptorUid", "senderUid", "receiverUid", "derivadorUid",
  "choferReceptorUid", "fromUid", "toUid", "acceptedByUid", "completedByUid",
  "choferOrigenId", "choferReceptorId", "emisorId", "receptorId"
];
const METADATA_IDENTITY_FIELDS = [
  "createdByUid", "updatedByUid", "deletedByUid", "approvedByUid", "uploadedByUid",
  "createdBy", "updatedBy"
];
const WEAK_IDENTITY_FIELDS = [
  "usuario", "username", "usuarioNormalizado", "chofer", "choferNombre", "nombreChofer",
  "driverName", "conductorNombre", "nombreConductor", "nombreUsuario", "choferEmail",
  "email", "correo", "contactEmail", "authEmail", "winnerDriverName", "winnerName", "nombreGanador", "ganadorNombre", "leaderName"
];

const NAME_FIELDS_BY_UID_FIELD = {
  emisorUid: ["emisorName", "senderName", "choferOrigen", "fromName"],
  senderUid: ["senderName", "emisorName", "choferOrigen", "fromName"],
  receptorUid: ["receptorName", "receiverName", "choferDestino", "toName"],
  receiverUid: ["receiverName", "receptorName", "choferDestino", "toName"],
  derivadorUid: ["derivadorNombre", "derivatorName", "senderName"],
  choferReceptorUid: ["choferReceptorNombre", "receiverName"]
};
const PHOTO_FIELDS_BY_UID_FIELD = {
  emisorUid: ["emisorPhotoUrl", "senderPhotoUrl"],
  senderUid: ["senderPhotoUrl", "emisorPhotoUrl"],
  receptorUid: ["receptorPhotoUrl", "receiverPhotoUrl"],
  receiverUid: ["receiverPhotoUrl", "receptorPhotoUrl"],
  derivadorUid: ["derivadorPhotoUrl", "senderPhotoUrl"],
  choferReceptorUid: ["choferReceptorPhotoUrl", "receiverPhotoUrl"]
};

const STORAGE_VALUE_FIELDS = new Set([
  "storagepath", "fullpath", "receiptpath", "comprobantepath", "adminreceiptpath",
  "driverreceiptpath", "expensereceiptpath", "billingreceiptpath", "closurereceiptpath",
  "debtreceiptpath", "loanreceiptpath", "filepath", "archivopath", "davidreceiptpath",
  "downloadurl", "receipturl", "comprobanteurl", "adminreceipturl", "driverreceipturl",
  "expensereceipturl", "billingreceipturl", "closurereceipturl", "debtreceipturl",
  "loanreceipturl", "fileurl", "archivourl", "davidreceipturl", "photourl", "avatarurl"
]);

function text(value) { return String(value ?? "").trim(); }
function normalized(value) { return text(value).toLowerCase(); }
function normalizeUsername(value) { return normalized(value).replace(/\s+/g, ""); }
function isValidUsername(value) { return /^[a-z0-9._-]{3,32}$/.test(normalizeUsername(value)); }
function isValidPassword(value) { const valueText = text(value); return valueText.length >= 6 && valueText.length <= 72; }
function isValidEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(text(value)); }
function legacyEmailFromLogin(username) { return `${normalizeUsername(username)}@explora.local`; }
function isReservedUsername(username) { return ADMIN_ROLES.has(normalizeUsername(username)) || ["admin", "administrator", "root", "firebase", "explora"].includes(normalizeUsername(username)); }
function dateInArgentina() { return new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date()); }
function jobIdForDriver(driverId) { return crypto.createHash("sha256").update(text(driverId)).digest("hex").slice(0, 40); }
function hashIdentity(value) { return crypto.createHash("sha256").update(text(value)).digest("hex"); }
function matchAlias(value, aliases) { return aliases.has(normalized(value)); }
function safeErrorMessage(error, fallback) { return text(error?.message || fallback).slice(0, 500); }


function debtPenaltyMoney(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 100) / 100) : 0;
}
function debtPenaltyTimestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value._seconds === "number") return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1000000);
  if (typeof value.seconds === "number") return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
  return 0;
}
function debtPenaltyDayKey(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone:"America/Argentina/Buenos_Aires", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date(ms));
}
function debtPenaltyStatusIsActive(row = {}) {
  const raw = normalized(row.status || row.debtStatus || row.estado || "active");
  if (row.cancelled === true || row.cancelado === true) return false;
  if (raw.includes("cancel") || raw.includes("paid") || raw.includes("pagad") || raw.includes("liquidad") || raw.includes("closed") || raw.includes("cerrad")) return false;
  return true;
}
function debtPenaltyCreatedMs(row = {}) {
  return debtPenaltyTimestampMs(row.createdAt)
    || debtPenaltyTimestampMs(row.createdAtClient)
    || debtPenaltyTimestampMs(row.createdAtMs)
    || debtPenaltyTimestampMs(row.incidentDate)
    || debtPenaltyTimestampMs(row.fechaIncidente);
}
function debtPenaltyRemaining(row = {}) {
  const explicit = row.remainingAmount ?? row.saldoPendiente ?? row.remainingBalance ?? row.balance;
  if (explicit !== undefined && explicit !== null && explicit !== "") return debtPenaltyMoney(explicit);
  const total = debtPenaltyMoney(row.totalAmount ?? row.originalAmount ?? row.amount ?? row.montoTotal ?? row.monto);
  const paid = debtPenaltyMoney(row.paidAmount ?? row.amountPaid ?? row.importePagado ?? 0);
  return debtPenaltyMoney(total - paid);
}
function debtPenaltyDaysToApply({ row, nowMs, rate }) {
  if (!(rate > 0)) return 0;
  const graceDays = Math.max(0, Math.trunc(Number(row.penaltyGraceDays ?? 15) || 15));
  const createdMs = debtPenaltyCreatedMs(row);
  const penaltyStartMs = debtPenaltyTimestampMs(row.penaltyStartAt)
    || debtPenaltyTimestampMs(row.penaltyStartAtMs)
    || (createdMs ? createdMs + graceDays * 86400000 : 0);
  if (!penaltyStartMs || nowMs < penaltyStartMs) return 0;
  const lastMs = debtPenaltyTimestampMs(row.lastPenaltyAppliedAt) || debtPenaltyTimestampMs(row.lastPenaltyAppliedAtMs);
  const todayStart = Math.floor(nowMs / 86400000) * 86400000;
  const firstPenaltyDay = Math.floor(penaltyStartMs / 86400000) * 86400000;
  const nextDay = lastMs > 0 ? Math.floor(lastMs / 86400000) * 86400000 + 86400000 : firstPenaltyDay;
  if (nextDay > todayStart) return 0;
  return Math.max(0, Math.min(60, Math.floor((todayStart - nextDay) / 86400000) + 1));
}


async function disableAndDeleteAuthUser(uid) {
  if (!uid) return true;
  await auth.updateUser(uid, { disabled: true }).catch(error => {
    if (error?.code !== "auth/user-not-found") throw error;
  });
  try {
    await auth.deleteUser(uid);
    return true;
  } catch (error) {
    if (error?.code === "auth/user-not-found") return true;
    return false;
  }
}

async function assertAdmin(request) {
  const callerUid = text(request.auth?.uid);
  if (!callerUid) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  // Regla dura v4015: ningún documento, rol viejo ni custom claim convierte a un chofer en Admin.
  // Sólo el UID oficial de David puede ejecutar altas/bajas administrativas.
  if (ADMIN_UIDS.has(callerUid)) return callerUid;
  throw new HttpsError("permission-denied", "Sólo el administrador oficial puede realizar esta acción.");
}

function collectAliases(driverId, data = {}) {
  return new Set([
    driverId, data.uid, data.authUid, data.choferUid, data.choferId, data.driverId,
    data.profileId, data.perfilId, data.profileDocumentId, data.usuario, data.username,
    data.usuarioNormalizado, data.email, data.contactEmail, data.authEmail, data.correo,
    data.nombre, data.nombreCompleto
  ].map(normalized).filter(Boolean));
}

function classifyDocument(data = {}, aliases) {
  const matchedOwnerFields = STRONG_OWNER_FIELDS.filter(field => matchAlias(data[field], aliases));
  const matchedSharedFields = SHARED_PARTICIPANT_FIELDS.filter(field => matchAlias(data[field], aliases));
  const matchedMetadataFields = METADATA_IDENTITY_FIELDS.filter(field => matchAlias(data[field], aliases));
  const matchedWeakFields = WEAK_IDENTITY_FIELDS.filter(field => matchAlias(data[field], aliases));
  const sharedValues = SHARED_PARTICIPANT_FIELDS.map(field => normalized(data[field])).filter(Boolean);
  const hasOtherParticipant = sharedValues.some(value => !aliases.has(value) && value !== "deleted-driver");

  // Borrado total de chofer v4015: si el chofer participa como dueño o participante,
  // el documento se elimina para que no vuelva a aparecer en selectores, cierres o actividad.
  if (matchedOwnerFields.length || matchedSharedFields.length) {
    return { action: "delete", matchedSharedFields, matchedMetadataFields, matchedWeakFields };
  }
  if (matchedMetadataFields.length || matchedWeakFields.length) {
    return { action: "anonymize", matchedSharedFields, matchedMetadataFields, matchedWeakFields };
  }
  return { action: "keep", matchedSharedFields: [], matchedMetadataFields: [], matchedWeakFields: [] };
}

function anonymizePatch(data, classification, adminUid) {
  const patch = {
    deletedParticipant: true,
    deletedParticipantAt: FieldValue.serverTimestamp(),
    deletedParticipantByUid: adminUid,
    updatedAt: FieldValue.serverTimestamp()
  };
  for (const field of classification.matchedSharedFields || []) {
    patch[field] = "deleted-driver";
    for (const nameField of NAME_FIELDS_BY_UID_FIELD[field] || []) {
      if (Object.prototype.hasOwnProperty.call(data, nameField)) patch[nameField] = "Chofer eliminado";
    }
    for (const photoField of PHOTO_FIELDS_BY_UID_FIELD[field] || []) {
      if (Object.prototype.hasOwnProperty.call(data, photoField)) patch[photoField] = null;
    }
  }
  for (const field of classification.matchedMetadataFields || []) patch[field] = "deleted-driver";
  for (const field of classification.matchedWeakFields || []) {
    const key = field.toLowerCase();
    patch[field] = key.includes("email") || key.includes("correo") ? null : "Chofer eliminado";
  }
  return patch;
}

function collectStorageCandidates(value, out = new Set(), key = "") {
  if (Array.isArray(value)) {
    value.forEach(item => collectStorageCandidates(item, out, key));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) collectStorageCandidates(childValue, out, childKey);
    return out;
  }
  if (typeof value !== "string" || !STORAGE_VALUE_FIELDS.has(normalized(key))) return out;
  const candidate = value.trim();
  if (candidate.startsWith("gs://") || /firebasestorage\.googleapis\.com/i.test(candidate)) out.add(candidate);
  else if (candidate && !candidate.startsWith("http") && !candidate.startsWith("data:")) out.add(`gs://${STORAGE_BUCKET}/${candidate.replace(/^\/+/, "")}`);
  return out;
}

function storagePathFromCandidate(candidate) {
  try {
    if (candidate.startsWith("gs://")) {
      const withoutScheme = candidate.slice(5);
      const slash = withoutScheme.indexOf("/");
      const candidateBucket = slash >= 0 ? withoutScheme.slice(0, slash) : withoutScheme;
      if (candidateBucket !== STORAGE_BUCKET) return "";
      return slash >= 0 ? decodeURIComponent(withoutScheme.slice(slash + 1)) : "";
    }
    const url = new URL(candidate);
    const bucketMatch = url.pathname.match(/\/v0\/b\/([^/]+)\/o\/([^?]+)/);
    if (bucketMatch) {
      if (decodeURIComponent(bucketMatch[1]) !== STORAGE_BUCKET) return "";
      return decodeURIComponent(bucketMatch[2]);
    }
    const objectMatch = url.pathname.match(/\/o\/([^?]+)/);
    return objectMatch ? decodeURIComponent(objectMatch[1]) : "";
  } catch (_) { return ""; }
}

async function deleteStorageCandidate(candidate) {
  const path = storagePathFromCandidate(candidate);
  if (!path) return 0;
  try {
    await bucket.file(path).delete({ ignoreNotFound: true });
    return 1;
  } catch (error) {
    if (error?.code === 404 || error?.code === "404") return 0;
    throw error;
  }
}

async function deleteStorageForDocument(data, counters) {
  const candidates = collectStorageCandidates(data);
  for (const candidate of candidates) counters.deletedFiles += await deleteStorageCandidate(candidate);
}

async function processCollection(collectionRef, aliases, adminUid, counters) {
  let lastDoc = null;
  do {
    let query = collectionRef.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    for (const docSnap of snapshot.docs) {
      counters.scannedDocuments += 1;
      if (counters.scannedDocuments > MAX_SCANNED_DOCUMENTS) {
        throw new HttpsError("resource-exhausted", "La eliminación superó el límite seguro de documentos. La cuenta quedó deshabilitada para reintentar.");
      }
      const data = docSnap.data() || {};
      const classification = classifyDocument(data, aliases);
      if (classification.action === "delete") {
        await deleteStorageForDocument(data, counters);
        await db.recursiveDelete(docSnap.ref);
        counters.deletedDocuments += 1;
        continue;
      }
      if (classification.action === "anonymize") {
        await docSnap.ref.set(anonymizePatch(data, classification, adminUid), { merge: true });
        counters.anonymizedDocuments += 1;
      }
      const subcollections = await docSnap.ref.listCollections();
      for (const subcollection of subcollections) await processCollection(subcollection, aliases, adminUid, counters);
    }
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  } while (lastDoc);
}

function classifyDriverResetDocument(data = {}, aliases, collectionId = "") {
  const matchedOwnerFields = STRONG_OWNER_FIELDS.filter(field => matchAlias(data[field], aliases));
  const matchedSharedFields = SHARED_PARTICIPANT_FIELDS.filter(field => matchAlias(data[field], aliases));
  const matchedMetadataFields = METADATA_IDENTITY_FIELDS.filter(field => matchAlias(data[field], aliases));
  const matchedWeakFields = WEAK_IDENTITY_FIELDS.filter(field => matchAlias(data[field], aliases));
  if (matchedOwnerFields.length || matchedSharedFields.length || matchedMetadataFields.length) return "delete";
  if (matchedWeakFields.length && DRIVER_RESET_OPERATIONAL_COLLECTIONS.has(text(collectionId))) return "delete";
  return "keep";
}

function collectDriverResetStorageCandidates(value, out = new Set(), key = "") {
  if (Array.isArray(value)) {
    value.forEach(item => collectDriverResetStorageCandidates(item, out, key));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) collectDriverResetStorageCandidates(childValue, out, childKey);
    return out;
  }
  if (typeof value !== "string" || !DRIVER_RESET_STORAGE_FIELDS.has(normalized(key))) return out;
  const candidate = value.trim();
  if (candidate.startsWith("gs://") || /firebasestorage\.googleapis\.com/i.test(candidate)) out.add(candidate);
  else if (candidate && !candidate.startsWith("http") && !candidate.startsWith("data:")) out.add(`gs://${STORAGE_BUCKET}/${candidate.replace(/^\/+/, "")}`);
  return out;
}

async function deleteDriverResetStorageForDocument(data, counters) {
  const candidates = collectDriverResetStorageCandidates(data);
  for (const candidate of candidates) counters.deletedFiles += await deleteStorageCandidate(candidate);
}

async function processCollectionForDriverReset(collectionRef, aliases, counters) {
  let lastDoc = null;
  do {
    let query = collectionRef.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    for (const docSnap of snapshot.docs) {
      counters.scannedDocuments += 1;
      if (counters.scannedDocuments > MAX_SCANNED_DOCUMENTS) {
        throw new HttpsError("resource-exhausted", "El reseteo superó el límite seguro de documentos. No se modificó la cuenta ni el acceso del chofer.");
      }
      const data = docSnap.data() || {};
      if (classifyDriverResetDocument(data, aliases, collectionRef.id) === "delete") {
        await deleteDriverResetStorageForDocument(data, counters);
        await db.recursiveDelete(docSnap.ref);
        counters.deletedDocuments += 1;
        continue;
      }
      const subcollections = await docSnap.ref.listCollections();
      for (const subcollection of subcollections) await processCollectionForDriverReset(subcollection, aliases, counters);
    }
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  } while (lastDoc);
}

async function deleteCollectionCompletelyForDriverReset(collectionRef, counters) {
  let lastDoc = null;
  do {
    let query = collectionRef.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    for (const docSnap of snapshot.docs) {
      counters.scannedDocuments += 1;
      if (counters.scannedDocuments > MAX_SCANNED_DOCUMENTS) {
        throw new HttpsError("resource-exhausted", "El reseteo superó el límite seguro de documentos. No se modificó la cuenta ni el acceso del chofer.");
      }
      await deleteDriverResetStorageForDocument(docSnap.data() || {}, counters);
      await db.recursiveDelete(docSnap.ref);
      counters.deletedDocuments += 1;
    }
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  } while (lastDoc);
}

function driverOperationalProfilePatch(data = {}, adminUid = "") {
  const patch = {};
  for (const field of DRIVER_OPERATIONAL_PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field)) patch[field] = FieldValue.delete();
  }
  const operationalKey = /deuda|prestamo|factur|gasto|ranking|performance|deriv|cierre|receipt|billing|saldo|balance|cashbox|caja|pending|snapshot|simulation|novedad|notification|operational|liquidation|settlement/i;
  const protectedKey = /nombre|username|usuario|email|correo|phone|telefono|cuit|alias|role|rol|uid|auth|vehicle|vehiculo|patente|photo|avatar|created|fechaalta|password/i;
  const protectedExact = new Set(["status", "estado", "active", "activo", "isdeleted", "deletedat", "deletedbyuid", "updatedat", "actualizado"]);
  for (const field of Object.keys(data)) {
    if (!protectedExact.has(normalized(field)) && !protectedKey.test(field) && operationalKey.test(field)) patch[field] = FieldValue.delete();
  }
  patch.ultimaActividad = "sin registro";
  if (Object.prototype.hasOwnProperty.call(data, "lastActivity")) patch.lastActivity = "sin registro";
  patch.lastOperationalResetAt = FieldValue.serverTimestamp();
  patch.lastOperationalResetByUid = adminUid;
  patch.updatedAt = FieldValue.serverTimestamp();
  return patch;
}

async function resetMatchingDriverProfiles(aliases, adminUid, counters) {
  for (const collectionName of ["choferes", "usuarios", "users", "perfiles"]) {
    const snapshot = await db.collection(collectionName).get().catch(() => null);
    if (!snapshot) continue;
    for (const profileDoc of snapshot.docs) {
      const data = profileDoc.data() || {};
      const role = normalized(data.role || data.rol);
      const authUid = text(data.authUid || data.uid || profileDoc.id);
      if (ADMIN_ROLES.has(role) || ADMIN_UIDS.has(authUid) || ADMIN_UIDS.has(profileDoc.id)) continue;
      const values = [profileDoc.id, data.uid, data.authUid, data.firebaseUid, data.userId, data.driverUid, data.driverId, data.choferUid, data.choferId, data.profileId, data.usuario, data.username, data.usuarioNormalizado, data.email, data.authEmail, data.contactEmail, data.correo, data.nombre, data.nombreCompleto];
      if (!values.some(value => matchAlias(value, aliases))) continue;
      const subcollections = await profileDoc.ref.listCollections();
      for (const subcollection of subcollections) await deleteCollectionCompletelyForDriverReset(subcollection, counters);
      await profileDoc.ref.set(driverOperationalProfilePatch(data, adminUid), { merge: true });
      counters.updatedProfiles += 1;
    }
  }
}

async function deleteDriverOperationalFilesBySafePrefixes(identityValues, counters) {
  const roots = ["receipts", "comprobantes", "gastos", "prestamos", "deudas", "cierres_semanales"];
  const safeValues = [...identityValues].filter(value => /^[a-zA-Z0-9._-]{3,128}$/.test(value) && !value.includes("@"));
  for (const value of safeValues) {
    for (const root of roots) {
      const [files] = await bucket.getFiles({ prefix: `${root}/${value}/` });
      for (const file of files) {
        try {
          await file.delete({ ignoreNotFound: true });
          counters.deletedFiles += 1;
        } catch (error) {
          if (error?.code !== 404 && error?.code !== "404") throw error;
        }
      }
    }
  }
}

async function deleteFilesBySafePrefixes(identityValues, counters) {
  const roots = [
    "drivers", "choferes", "profiles", "profile_photos", "avatars", "driver_photos",
    "receipts", "comprobantes", "gastos", "prestamos", "deudas", "cierres_semanales"
  ];
  const safeValues = [...identityValues].filter(value => /^[a-zA-Z0-9._-]{3,128}$/.test(value) && !value.includes("@"));
  for (const value of safeValues) {
    for (const root of roots) {
      const [files] = await bucket.getFiles({ prefix: `${root}/${value}/` });
      for (const file of files) {
        try {
          await file.delete({ ignoreNotFound: true });
          counters.deletedFiles += 1;
        } catch (error) {
          if (error?.code !== 404 && error?.code !== "404") throw error;
        }
      }
    }
  }
}

async function unassignVehicles(aliases, adminUid, counters) {
  const snapshot = await db.collection("vehiculos").get();
  for (const vehicleDoc of snapshot.docs) {
    const data = vehicleDoc.data() || {};
    const fields = ["currentDriverUid", "currentDriverDocumentId", "driverUid", "driverId", "choferUid", "choferId"];
    if (!fields.some(field => matchAlias(data[field], aliases))) continue;
    await vehicleDoc.ref.set({
      currentDriverUid: null, currentDriverDocumentId: null, currentDriverName: null,
      driverUid: null, driverId: null, driverName: null, choferUid: null, choferId: null,
      isAssigned: false, updatedAt: FieldValue.serverTimestamp(), updatedByUid: adminUid
    }, { merge: true });
    counters.updatedVehicles += 1;
  }
}

async function deleteLoginAliases(aliases, counters) {
  const snapshot = await db.collection("login_aliases").get();
  for (const aliasDoc of snapshot.docs) {
    const data = aliasDoc.data() || {};
    const identityValues = [aliasDoc.id, data.uid, data.authUid, data.profileId, data.driverId, data.choferId, data.username, data.usuario, data.email, data.authEmail];
    if (!identityValues.some(value => matchAlias(value, aliases))) continue;
    await db.recursiveDelete(aliasDoc.ref);
    counters.deletedDocuments += 1;
  }
}

async function deleteAdminAuditEntries(aliases, counters) {
  const snapshot = await db.collection(ADMIN_AUDIT_COLLECTION).get().catch(() => null);
  if (!snapshot) return;
  for (const auditDoc of snapshot.docs) {
    const data = auditDoc.data() || {};
    const identityValues = [auditDoc.id, data.targetUid, data.targetUsername, data.targetEmail, data.driverId, data.authUid, data.username, data.usuario, data.email];
    if (!identityValues.some(value => matchAlias(value, aliases))) continue;
    await db.recursiveDelete(auditDoc.ref);
    counters.deletedDocuments += 1;
  }
}

async function deleteLegacyProfiles(aliases, primaryDriverId, counters) {
  for (const collectionName of ["choferes", "usuarios", "users", "perfiles"]) {
    const snapshot = await db.collection(collectionName).get().catch(() => null);
    if (!snapshot) continue;
    for (const profileDoc of snapshot.docs) {
      const data = profileDoc.data() || {};
      const role = normalized(data.role || data.rol);
      const authUid = text(data.authUid || data.uid || profileDoc.id);
      if (ADMIN_ROLES.has(role) || ADMIN_UIDS.has(authUid) || ADMIN_UIDS.has(profileDoc.id)) continue;
      const values = [profileDoc.id, data.uid, data.authUid, data.firebaseUid, data.userId, data.driverUid, data.driverId, data.choferUid, data.choferId, data.profileId, data.usuario, data.username, data.usuarioNormalizado, data.email, data.authEmail, data.contactEmail, data.correo, data.nombre, data.nombreCompleto];
      if (!values.some(value => matchAlias(value, aliases))) continue;
      if (collectionName === "choferes" && profileDoc.id === primaryDriverId) continue;
      await deleteStorageForDocument(data, counters);
      await db.recursiveDelete(profileDoc.ref);
      counters.deletedDocuments += 1;
    }
  }
}

exports.adminCreateDriver = onCall({ region: "southamerica-east1", timeoutSeconds: 120, memory: "512MiB", invoker: "public" }, async (request) => {
  const adminUid = await assertAdmin(request);
  const nombre = text(request.data?.nombre);
  const username = normalizeUsername(request.data?.username);
  const password = text(request.data?.password);
  const requestedEmail = normalized(request.data?.email);
  const email = requestedEmail || legacyEmailFromLogin(username);
  const phone = text(request.data?.phone);
  const cuit = text(request.data?.cuit);
  const alias = normalized(request.data?.alias);
  const role = normalized(request.data?.role || "chofer");
  const vehicleId = text(request.data?.vehicleId);
  const allowReassign = request.data?.allowReassign === true;

  if (!nombre || nombre.length > 100) throw new HttpsError("invalid-argument", "El nombre es obligatorio y debe tener hasta 100 caracteres.");
  if (role !== "chofer" && role !== "driver") throw new HttpsError("invalid-argument", "El único rol permitido desde este panel es chofer.");
  if (!isValidUsername(username) || isReservedUsername(username)) throw new HttpsError("invalid-argument", "El ID de acceso no es válido o está reservado.");
  if (!isValidPassword(password)) throw new HttpsError("invalid-argument", "La contraseña debe tener entre 6 y 72 caracteres.");
  if (!isValidEmail(email)) throw new HttpsError("invalid-argument", "El email interno no es válido.");

  const aliasRef = db.collection("login_aliases").doc(username);
  if ((await aliasRef.get()).exists) throw new HttpsError("already-exists", "Ese ID de acceso ya está en uso.");

  let userRecord;
  try {
    userRecord = await auth.createUser({ email, password, displayName: nombre, disabled: false });
    await auth.setCustomUserClaims(userRecord.uid, { role: "driver", rol: "chofer" });
  } catch (error) {
    if (userRecord?.uid) await disableAndDeleteAuthUser(userRecord.uid).catch(() => false);
    if (error?.code === "auth/email-already-exists") throw new HttpsError("already-exists", "Ese email ya está en uso.");
    throw new HttpsError("internal", safeErrorMessage(error, "No se pudo crear la cuenta."));
  }

  const uid = userRecord.uid;
  const driverRef = db.collection("choferes").doc(uid);
  const vehicleRef = vehicleId ? db.collection("vehiculos").doc(vehicleId) : null;
  const auditRef = db.collection(ADMIN_AUDIT_COLLECTION).doc(`create_${uid}`);

  try {
    await db.runTransaction(async tx => {
      const freshAlias = await tx.get(aliasRef);
      if (freshAlias.exists) throw new HttpsError("already-exists", "Ese ID de acceso ya está en uso.");

      let vehicleData = null;
      if (vehicleRef) {
        const vehicleSnap = await tx.get(vehicleRef);
        if (!vehicleSnap.exists) throw new HttpsError("not-found", "El vehículo seleccionado no existe.");
        vehicleData = vehicleSnap.data() || {};
        const assignedProfileId = text(vehicleData.currentDriverDocumentId || vehicleData.driverId);
        const assignedUid = text(vehicleData.currentDriverUid || vehicleData.driverUid || vehicleData.choferUid);
        const assignedIdentity = assignedProfileId || assignedUid;
        if (assignedIdentity && assignedIdentity !== uid && !allowReassign) {
          throw new HttpsError("failed-precondition", "El vehículo ya está asignado a otro chofer.");
        }
        if (assignedIdentity && assignedIdentity !== uid) {
          const oldDriverRef = db.collection("choferes").doc(assignedIdentity);
          tx.set(oldDriverRef, {
            vehicleId: null, vehiculoId: null, assignedVehicleId: null, patente: null,
            updatedAt: FieldValue.serverTimestamp(), updatedByUid: adminUid
          }, { merge: true });
        }
      }

      const now = FieldValue.serverTimestamp();
      tx.create(driverRef, {
        nombre, nombreCompleto: nombre, uid, authUid: uid,
        usuario: username, username, usuarioNormalizado: username,
        rol: "chofer", role: "driver", email, authEmail: email,
        contactEmail: requestedEmail || "", telefono: phone, phone,
        cuit: cuit || "", cuitFiscal: cuit || "", alias: alias || "", aliasCobro: alias || "",
        estado: "disponible", activo: true, active: true, status: "active", isDeleted: false,
        createdAt: now, createdByUid: adminUid, fechaAlta: dateInArgentina(), ultimaActividad: "sin registro",
        vehicleId: vehicleId || null, vehiculoId: vehicleId || null, assignedVehicleId: vehicleId || null,
        patente: vehicleData ? text(vehicleData.patente || vehicleData.plate) : null
      });
      tx.create(aliasRef, {
        username, usuario: username, email, authEmail: email, uid, authUid: uid,
        profileId: uid, driverId: uid, choferId: uid, role: "chofer", rol: "chofer",
        active: true, activo: true, createdAt: now, createdByUid: adminUid
      });
      if (vehicleRef) {
        tx.set(vehicleRef, {
          currentDriverUid: uid, currentDriverDocumentId: uid, currentDriverName: nombre,
          driverUid: uid, driverId: uid, driverName: nombre, isAssigned: true,
          updatedAt: now, updatedByUid: adminUid
        }, { merge: true });
      }
      tx.set(auditRef, {
        action: "admin_create_driver", adminUid, targetUid: uid, targetUsername: username,
        vehicleId: vehicleId || null, createdAt: now, status: "completed"
      });
    });
    return { ok: true, uid, username, email, vehicleId: vehicleId || null };
  } catch (error) {
    const cleanupOk = await disableAndDeleteAuthUser(uid).catch(() => false);
    if (!cleanupOk) {
      await auditRef.set({ action:"admin_create_driver", adminUid, targetUid:uid, targetUsername:username, status:"cleanup_failed", failedAt:FieldValue.serverTimestamp() }, { merge:true }).catch(() => {});
      throw new HttpsError("internal", "La creación no se completó y la cuenta residual quedó deshabilitada. Revisá Firebase Authentication antes de reintentar.");
    }
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", safeErrorMessage(error, "No se pudo completar la creación del chofer."));
  }
});

exports.adminResetDriverOperationalData = onCall({ region: "southamerica-east1", timeoutSeconds: 540, memory: "1GiB" }, async request => {
  const adminUid = await assertAdmin(request);
  const driverId = text(request.data?.driverId);
  const confirmation = text(request.data?.confirmation);
  if (!driverId) throw new HttpsError("invalid-argument", "Falta el ID del chofer.");
  if (ADMIN_UIDS.has(driverId)) throw new HttpsError("failed-precondition", "No se puede resetear la cuenta administradora.");

  const driverRef = db.collection("choferes").doc(driverId);
  const driverSnap = await driverRef.get();
  if (!driverSnap.exists) throw new HttpsError("not-found", "El chofer no existe.");
  const driver = driverSnap.data() || {};
  const driverName = text(driver.nombreCompleto || driver.nombre || driver.username || driver.usuario || driverId);
  const expectedConfirmation = `RESETEAR ${driverName}`;
  if (confirmation !== expectedConfirmation) throw new HttpsError("failed-precondition", "La confirmación de reseteo no coincide con el chofer seleccionado.");

  const role = normalized(driver.role || driver.rol);
  const authUid = text(driver.authUid || driver.uid || driverId);
  if (ADMIN_ROLES.has(role) || ADMIN_UIDS.has(authUid)) throw new HttpsError("failed-precondition", "No se puede resetear una cuenta administradora.");

  const aliases = collectAliases(driverId, driver);
  const counters = { scannedDocuments:0, deletedDocuments:0, deletedFiles:0, updatedProfiles:0 };
  const startedAt = Date.now();

  try {
    const rootCollections = await db.listCollections();
    for (const collectionRef of rootCollections) {
      if (DRIVER_RESET_MASTER_COLLECTIONS.has(collectionRef.id)) continue;
      await processCollectionForDriverReset(collectionRef, aliases, counters);
    }

    await resetMatchingDriverProfiles(aliases, adminUid, counters);
    await deleteDriverOperationalFilesBySafePrefixes(aliases, counters);

    const auditRef = db.collection(ADMIN_AUDIT_COLLECTION).doc(`reset_${driverId}_${Date.now()}`);
    await auditRef.set({
      action:"admin_reset_driver_operational_data",
      adminUid,
      targetUid:authUid,
      driverId,
      driverName,
      status:"completed",
      result:counters,
      createdAt:FieldValue.serverTimestamp(),
      durationMs:Date.now() - startedAt
    });

    return {
      ok:true,
      driverId,
      driverName,
      accountPreserved:true,
      vehiclePreserved:true,
      ...counters,
      durationMs:Date.now() - startedAt
    };
  } catch (error) {
    const message = safeErrorMessage(error, "No se pudo completar el reseteo de datos del chofer.");
    await db.collection(ADMIN_AUDIT_COLLECTION).doc(`reset_failed_${driverId}_${Date.now()}`).set({
      action:"admin_reset_driver_operational_data",
      adminUid,
      targetUid:authUid,
      driverId,
      driverName,
      status:"failed",
      partialResult:counters,
      errorCode:text(error?.code || "internal"),
      errorMessage:message,
      createdAt:FieldValue.serverTimestamp(),
      durationMs:Date.now() - startedAt
    }).catch(() => {});
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", message);
  }
});

exports.adminDeleteDriverCompletely = onCall({ region: "southamerica-east1", timeoutSeconds: 540, memory: "1GiB" }, async request => {
  const adminUid = await assertAdmin(request);
  const driverId = text(request.data?.driverId);
  const confirmation = text(request.data?.confirmation);
  if (!driverId) throw new HttpsError("invalid-argument", "Falta el ID del chofer.");
  if (ADMIN_UIDS.has(driverId)) throw new HttpsError("failed-precondition", "No se puede eliminar la cuenta administradora.");

  const jobId = jobIdForDriver(driverId);
  const jobRef = db.collection(DELETION_JOBS_COLLECTION).doc(jobId);
  const existingJob = await jobRef.get();
  const previousJob = existingJob.exists ? (existingJob.data() || {}) : {};
  if (previousJob.status === "completed") return { ok: true, ...(previousJob.result || {}), alreadyCompleted: true };

  const driverRef = db.collection("choferes").doc(driverId);
  const driverSnap = await driverRef.get();
  const driver = driverSnap.exists ? (driverSnap.data() || {}) : (previousJob.targetSnapshot || {});
  if (!driverSnap.exists && !previousJob.targetSnapshot) throw new HttpsError("not-found", "El chofer no existe.");

  const driverName = text(driver.nombreCompleto || driver.nombre || driver.username || driver.usuario || driverId);
  const expectedConfirmation = `ELIMINAR ${driverName}`;
  if (confirmation !== expectedConfirmation) throw new HttpsError("failed-precondition", "La confirmación de eliminación no coincide con el chofer seleccionado.");

  const role = normalized(driver.role || driver.rol);
  const authUid = text(driver.authUid || driver.uid || previousJob.authUid || driverId);
  if (ADMIN_ROLES.has(role) || ADMIN_UIDS.has(authUid)) throw new HttpsError("failed-precondition", "No se puede eliminar una cuenta administradora.");

  const aliases = collectAliases(driverId, driver);
  const counters = {
    scannedDocuments: 0, deletedDocuments: 0, anonymizedDocuments: 0,
    deletedFiles: 0, updatedVehicles: 0
  };

  try {
    await auth.updateUser(authUid, { disabled: true }).catch(error => {
      if (error?.code !== "auth/user-not-found") throw error;
    });

    const targetSnapshot = {
      authUid, uid: text(driver.uid), username: text(driver.username || driver.usuario),
      email: text(driver.email || driver.authEmail), nombre: driverName,
      role: text(driver.role || driver.rol), vehicleId: text(driver.vehicleId || driver.vehiculoId || driver.assignedVehicleId)
    };
    await jobRef.set({
      status: "running", driverId, authUid, targetSnapshot, adminUid,
      startedAt: previousJob.startedAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), attempts: FieldValue.increment(1)
    }, { merge: true });
    if (driverSnap.exists) {
      await driverRef.set({
        activo: false, active: false, status: "deleting", deletionStatus: "running",
        deletionJobId: jobId, updatedAt: FieldValue.serverTimestamp(), updatedByUid: adminUid
      }, { merge: true });
    }

    const rootCollections = await db.listCollections();
    for (const collectionRef of rootCollections) {
      if (PROTECTED_ROOT_COLLECTIONS.has(collectionRef.id) || SPECIAL_ROOT_COLLECTIONS.has(collectionRef.id)) continue;
      await processCollection(collectionRef, aliases, adminUid, counters);
    }

    await unassignVehicles(aliases, adminUid, counters);
    await deleteLoginAliases(aliases, counters);
    await deleteLegacyProfiles(aliases, driverId, counters);
    await deleteAdminAuditEntries(aliases, counters);
    await deleteStorageForDocument(driver, counters);
    await deleteFilesBySafePrefixes(aliases, counters);

    await auth.deleteUser(authUid).catch(error => {
      if (error?.code !== "auth/user-not-found") throw error;
    });

    if (driverSnap.exists || (await driverRef.get()).exists) {
      await db.recursiveDelete(driverRef);
      counters.deletedDocuments += 1;
    }

    const storedResult = { authUidHash: hashIdentity(authUid), ...counters };
    // No dejamos documentos visibles de eliminación para que el chofer no vuelva a aparecer.
    await jobRef.delete().catch(() => {});
    return { ok: true, driverId, ...storedResult };
  } catch (error) {
    const message = safeErrorMessage(error, "No se pudo completar la eliminación segura del chofer.");
    await jobRef.set({
      status: "failed", errorCode: text(error?.code || "internal"), errorMessage: message,
      partialResult: counters, failedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});
    await driverRef.set({
      activo: false, active: false, status: "deletion_failed", deletionStatus: "failed",
      deletionJobId: jobId, deletionError: message, nombre: driverName, nombreCompleto: driverName, authUid, uid: authUid, updatedAt: FieldValue.serverTimestamp(), updatedByUid: adminUid
    }, { merge: true }).catch(() => {});
    throw new HttpsError("internal", `${message} La cuenta quedó deshabilitada para evitar acceso con datos parcialmente eliminados. Podés reintentar la misma eliminación.`);
  }
});


// ============================================================================
// BORRADO MANUAL FINANCIERO — Admin oficial
// Borra cobros/gastos o excluye caja chica y ajusta cierres afectados.
// ============================================================================
const FINANCIAL_DRIVER_FIELDS = [
  "driverUid", "choferUid", "uid", "ownerUid", "driverId", "choferId",
  "userUid", "userId", "createdByUid", "ownerId", "conductorUid", "assignedDriverUid"
];
const FINANCIAL_AMOUNT_FIELDS = [
  "amount", "monto", "valor", "finalPrice", "total", "importe", "price", "precio",
  "precioFinal", "montoFinal", "montoCobrado", "importeTotal", "finalAmount", "totalAmount",
  "billingAmount", "chargedAmount", "paidAmount", "fare", "tarifa", "value", "totalCobrado", "facturacion", "billingTotal"
];

function financialNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = text(value).replace(/\s/g, "");
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9,.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "," || cleaned === ".") return 0;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalizedValue = cleaned;
  if (lastComma >= 0 && lastDot >= 0) normalizedValue = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(/,/g, ".") : cleaned.replace(/,/g, "");
  else if (lastDot >= 0) normalizedValue = cleaned.slice(lastDot + 1).length === 3 ? cleaned.replace(/\./g, "") : cleaned;
  else if (lastComma >= 0) normalizedValue = cleaned.slice(lastComma + 1).length === 3 ? cleaned.replace(/,/g, "") : cleaned.replace(/,/g, ".");
  const parsed = Number(normalizedValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

function financialAmountOf(data = {}) {
  for (const field of FINANCIAL_AMOUNT_FIELDS) {
    if (data[field] === undefined || data[field] === null || data[field] === "") continue;
    const amount = financialNumber(data[field]);
    if (amount > 0) return amount;
  }
  return 0;
}

function financialMethodOf(data = {}) {
  const raw = normalized(data.paymentMethod || data.metodoPago || data.financialCategory || data.receiptPaymentMethod || data.paymentProvider || data.method);
  if (/cash|efectivo/.test(raw)) return "cash";
  if (/qr/.test(raw)) return "qr";
  if (/card|tarjeta|point/.test(raw)) return "card";
  if (/transfer|alias|transf/.test(raw)) return "transfer";
  return raw || "cash";
}

function financialIsBillingSettlementPayment(data = {}) {
  const type = normalized(data.type || data.operationType || data.movementType);
  const source = normalized(data.sourceModule || data.category || data.module);
  return data.affectsBillingSettlement === true ||
    type === "admin_billing_settlement_payment" ||
    (type === "driver_payment" && /factur|billing/.test(source));
}

function financialDriverValues(data = {}) {
  return FINANCIAL_DRIVER_FIELDS.map(field => text(data[field])).filter(Boolean);
}
async function financialDriverAllowedAliases(driverUid = "") {
  const aliases = new Set([text(driverUid)]);
  for (const collectionName of ["choferes", "usuarios"]) {
    const snap = await db.collection(collectionName).doc(driverUid).get().catch(() => null);
    if (!snap?.exists) continue;
    const data = snap.data() || {};
    for (const field of FINANCIAL_DRIVER_FIELDS.concat(["authUid", "profileDocumentId", "perfilId", "id", "username", "usuario"])) {
      const value = text(data[field]);
      if (value) aliases.add(value);
    }
  }
  return aliases;
}
async function financialBelongsToDriver(data = {}, driverUid = "") {
  const target = text(driverUid);
  if (!target) return false;
  const values = financialDriverValues(data);
  if (values.includes(target)) return true;
  const aliases = await financialDriverAllowedAliases(target);
  return values.some(value => aliases.has(value));
}
function financialClosureKind(data = {}) {
  const raw = normalized(data.closureKind || data.closureType || data.payTab || data.closeKind || data.kind || data.cierreTipo || data.type || data.category);
  if (/caja|chica|cashbox|bruto/.test(raw)) return "caja_chica";
  if (/gasto|expense/.test(raw)) return "gastos";
  if (/explora|digital|transfer|qr|card|tarjeta/.test(raw)) return "explora";
  if (/chofer|driver|efectivo|cash|factur|billing|cobro/.test(raw)) return "facturacion";
  return "";
}
function financialIsBillingClosure(kind = "") {
  return ["chofer", "explora", "facturacion"].includes(kind);
}
function financialRemoveArrayItem(value, item) {
  return Array.isArray(value) ? value.map(text).filter(v => v && v !== text(item)) : [];
}
function financialExpenseParts(data = {}) {
  const amount = financialAmountOf(data);
  const rawRate = Number(data.sharedRate ?? data.porcentajeCompartido ?? data.driverShareRate ?? data.porcentajeChofer);
  const rate = Number.isFinite(rawRate) ? (rawRate > 1 ? rawRate / 100 : rawRate) : .5;
  const driverPart = amount * Math.min(1, Math.max(0, rate || .5));
  const exploraPart = Math.max(0, amount - driverPart);
  return { amount, driverPart, exploraPart };
}

async function financialRelatedClosures(driverUid, documentId, includeField) {
  const results = new Map();
  const collectionRef = db.collection("cierres_semanales");
  try {
    const direct = await collectionRef.where(includeField, "array-contains", documentId).get();
    direct.docs.forEach(docSnap => results.set(docSnap.id, docSnap));
  } catch (error) {
    console.warn("[admin financial delete] included query skipped", includeField, error?.code || error?.message || error);
  }
  for (const field of ["driverUid", "choferUid", "uid", "driverId", "choferId"]) {
    try {
      const snap = await collectionRef.where(field, "==", driverUid).limit(300).get();
      snap.docs.forEach(docSnap => {
        const data = docSnap.data() || {};
        if (Array.isArray(data[includeField]) && data[includeField].map(text).includes(documentId)) results.set(docSnap.id, docSnap);
      });
    } catch (_) {}
  }
  return [...results.values()];
}

function financialBillingClosurePatch(closure = {}, movement = {}, { cashboxOnly = false } = {}) {
  const amount = financialAmountOf(movement);
  const method = financialMethodOf(movement);
  const oldCash = financialNumber(closure.cashInDriver ?? closure.cashGrossInDriver ?? closure.driverActualCash);
  const oldDigital = financialNumber(closure.exploraCash ?? closure.nonCashInExplora ?? closure.nonCashGrossInExplora);
  const cash = Math.max(0, oldCash - (!cashboxOnly && method === "cash" ? amount : 0));
  const digital = Math.max(0, oldDigital - (!cashboxOnly && method !== "cash" ? amount : 0));
  const cashboxExcluded = movement.excludeFromCashbox === true || movement.cashboxExcluded === true || movement.cajaChicaEliminada === true || movement.ignoreCashbox === true || movement.noCashbox === true;
  const cashboxGenerates = method === "cash" && !cashboxExcluded;
  const oldCashboxGross = financialNumber(closure.billingCashboxGross ?? closure.cashboxGross ?? oldCash);
  const oldEligibleGross = financialNumber(closure.billingCashboxEligibleGross ?? closure.cashboxEligibleGross ?? oldCashboxGross);
  const cashboxGross = Math.max(0, oldCashboxGross - (cashboxGenerates ? amount : 0));
  const eligibleGross = Math.max(0, oldEligibleGross - (cashboxGenerates ? amount : 0));
  const gross = cash + digital;
  const share = gross * .5;
  const netBeforeCashboxToDriver = share - cash;
  const cashboxRate = Math.max(0, financialNumber(closure.cashboxRate || .05));
  const cashboxGenerated = cashboxGross * cashboxRate;
  const cashboxEligibleAmount = eligibleGross * cashboxRate;
  const autoClosesCashbox = closure.autoClosesCashbox === true || closure.cashboxClosedWithBilling === true || closure.cashboxAutoClosed === true || (Array.isArray(closure.affectsTabs) && closure.affectsTabs.includes("caja_chica"));
  const alreadyCompensated = autoClosesCashbox ? Math.max(0, financialNumber(closure.cashboxAlreadyCompensated || 0)) : 0;
  const cashboxPending = autoClosesCashbox ? Math.max(0, cashboxGenerated - alreadyCompensated) : cashboxEligibleAmount;
  const cashboxOffsetApplied = autoClosesCashbox ? cashboxPending : (netBeforeCashboxToDriver > 0 ? Math.min(netBeforeCashboxToDriver, cashboxEligibleAmount) : 0);
  const netToDriver = netBeforeCashboxToDriver - cashboxOffsetApplied;
  const settlementPaymentTotal = Math.max(0, financialNumber(closure.billingSettlementPaymentTotal));
  const netAfterDriverPayments = netToDriver + settlementPaymentTotal;
  const amountFromDriver = Math.max(0, -netAfterDriverPayments);
  const amountToDriver = Math.max(0, netAfterDriverPayments);
  const payerRole = amountFromDriver > .49 ? "driver" : amountToDriver > .49 ? "admin" : "balanced";
  return {
    gross, grossBeforeCashbox:gross, cashInDriver:cash, cashGrossInDriver:cash,
    exploraCash:digital, nonCashInExplora:digital, nonCashGrossInExplora:digital,
    billingShareEach:share, driverShare:share, exploraShare:share, driverEntitlement:share, driverFinal:share,
    billingNetBeforeCashboxToDriver:netBeforeCashboxToDriver,
    billingAmountToDriverBeforeCashbox:Math.max(0, netBeforeCashboxToDriver),
    billingCashboxGross:cashboxGross,
    billingCashboxEligibleGross:eligibleGross,
    billingCashboxGenerated:autoClosesCashbox ? cashboxPending : cashboxGenerated,
    billingCashboxEligibleAmount:autoClosesCashbox ? cashboxPending : cashboxEligibleAmount,
    billingCashboxOffsetApplied:cashboxOffsetApplied,
    cashboxGeneratedTotal:cashboxGenerated,
    cashboxTotal:autoClosesCashbox ? cashboxPending : cashboxGenerated,
    cashboxIncludedInSettlement:autoClosesCashbox ? cashboxPending : financialNumber(closure.cashboxIncludedInSettlement || 0),
    cashboxInDriver:autoClosesCashbox ? cashboxPending : Math.max(0, cashboxEligibleAmount - cashboxOffsetApplied),
    cashboxInExplora:autoClosesCashbox ? 0 : cashboxOffsetApplied,
    billingNetBeforeDriverPayments:netToDriver,
    billingSettlementPaymentTotal:settlementPaymentTotal,
    netSettlementToDriver:netAfterDriverPayments,
    amountDueFromDriver:amountFromDriver, amountFromDriver,
    amountDueToDriver:amountToDriver, amountToDriver,
    pendingPayerRole:payerRole,
    receiptRequiredFrom:payerRole,
    paymentDirection:payerRole === "driver" ? "driver_to_explora" : payerRole === "admin" ? "explora_to_driver" : "balanced"
  };
}

function financialCashboxClosurePatch(closure = {}, movement = {}) {
  const amount = financialAmountOf(movement);
  const reduction = amount * .05;
  const gross = Math.max(0, financialNumber(closure.cashboxGross ?? closure.gross ?? closure.cashboxBase) - amount);
  const total = Math.max(0, financialNumber(closure.cashboxTotal ?? closure.mainTotal ?? closure.amountDueFromDriver) - reduction);
  return {
    gross, cashboxGross:gross, mainTotal:total,
    cashboxTotal:total, cashboxInDriver:total, cashboxInExplora:0,
    amountDueFromDriver:total, amountFromDriver:total,
    amountDueToDriver:0, amountToDriver:0,
    netSettlementToDriver:-total
  };
}

function financialBillingSettlementClosurePatch(closure = {}, movement = {}) {
  const amount = financialAmountOf(movement);
  const previousPaymentTotal = Math.max(0, financialNumber(closure.billingSettlementPaymentTotal));
  const paymentTotal = Math.max(0, previousPaymentTotal - amount);
  const previousNet = financialNumber(closure.netSettlementToDriver);
  const netBeforePayments = Number.isFinite(Number(closure.billingNetBeforeDriverPayments))
    ? financialNumber(closure.billingNetBeforeDriverPayments)
    : previousNet - previousPaymentTotal;
  const netToDriver = netBeforePayments + paymentTotal;
  const amountFromDriver = Math.max(0, -netToDriver);
  const amountToDriver = Math.max(0, netToDriver);
  const payerRole = amountFromDriver > .49 ? "driver" : amountToDriver > .49 ? "admin" : "balanced";
  return {
    billingSettlementPaymentTotal:paymentTotal,
    billingNetBeforeDriverPayments:netBeforePayments,
    netSettlementToDriver:netToDriver,
    amountDueFromDriver:amountFromDriver,
    amountFromDriver,
    amountDueToDriver:amountToDriver,
    amountToDriver,
    pendingPayerRole:payerRole,
    receiptRequiredFrom:payerRole,
    paymentDirection:payerRole === "driver" ? "driver_to_explora" : payerRole === "admin" ? "explora_to_driver" : "balanced"
  };
}

function financialExpenseClosurePatch(closure = {}, movement = {}) {
  const { amount, driverPart, exploraPart } = financialExpenseParts(movement);
  const total = Math.max(0, financialNumber(closure.expenseTotal ?? closure.mainTotal ?? closure.gross) - amount);
  const oldDriver = financialNumber(closure.driverExpenseShare);
  const oldExplora = financialNumber(closure.exploraExpenseShare ?? closure.amountDueToDriver);
  const newDriver = Math.max(0, oldDriver - driverPart);
  const newExplora = Math.max(0, oldExplora - exploraPart);
  const debtOffset = Math.min(newExplora, Math.max(0, financialNumber(closure.expenseDebtOffsetApplied)));
  const amountToDriver = Math.max(0, newExplora - debtOffset);
  return {
    expenseTotal:total, mainTotal:total, gross:total,
    driverExpenseShare:newDriver, exploraExpenseShare:newExplora,
    expenseAmountToDriverBeforeDebt:newExplora,
    expenseDebtOffsetApplied:debtOffset,
    expenseAmountToDriverAfterDebt:amountToDriver,
    amountDueFromDriver:0, amountFromDriver:0,
    amountDueToDriver:amountToDriver, amountToDriver,
    netSettlementToDriver:amountToDriver
  };
}

function financialExpenseAmountCorrectionPatch(closure = {}, movement = {}, newAmount = 0) {
  const previous = financialExpenseParts(movement);
  const nextAmount = Math.max(0, Math.round(financialNumber(newAmount)));
  if (!(previous.amount > 0) || !(nextAmount > 0) || previous.amount === nextAmount) return null;
  const next = financialExpenseParts({ ...movement, amount:nextAmount, monto:nextAmount, valor:nextAmount, totalAmount:nextAmount });
  const currentTotal = Math.max(0, financialNumber(closure.expenseTotal ?? closure.mainTotal ?? closure.gross));
  const previousDriverShare = closure.driverExpenseShare !== undefined
    ? Math.max(0, financialNumber(closure.driverExpenseShare))
    : currentTotal * (previous.driverPart / previous.amount);
  const previousExploraShare = closure.exploraExpenseShare !== undefined
    ? Math.max(0, financialNumber(closure.exploraExpenseShare))
    : closure.expenseAmountToDriverBeforeDebt !== undefined
      ? Math.max(0, financialNumber(closure.expenseAmountToDriverBeforeDebt))
      : Math.max(0, currentTotal - previousDriverShare);
  const total = Math.max(0, currentTotal + next.amount - previous.amount);
  const driverShare = Math.max(0, previousDriverShare + next.driverPart - previous.driverPart);
  const exploraShare = Math.max(0, previousExploraShare + next.exploraPart - previous.exploraPart);
  const debtOffset = Math.min(exploraShare, Math.max(0, financialNumber(closure.expenseDebtOffsetApplied)));
  const amountToDriver = Math.max(0, exploraShare - debtOffset);
  return {
    expenseTotal:total, mainTotal:total, gross:total,
    driverExpenseShare:driverShare, exploraExpenseShare:exploraShare,
    expenseAmountToDriverBeforeDebt:exploraShare,
    expenseDebtOffsetApplied:debtOffset,
    expenseAmountToDriverAfterDebt:amountToDriver,
    amountDueFromDriver:0, amountFromDriver:0,
    amountDueToDriver:amountToDriver, amountToDriver,
    netSettlementToDriver:amountToDriver
  };
}

async function financialAdjustClosures({ type, driverUid, documentId, movement, adminUid }) {
  const settlementPayment = type === "cobro" && financialIsBillingSettlementPayment(movement);
  const includeField = type === "gasto" ? "includedExpenseIds" : settlementPayment ? "includedBillingSettlementPaymentIds" : "includedBillingIds";
  const docsMap = new Map();
  for (const field of (type === "gasto" || settlementPayment ? [includeField] : [includeField, "includedCashboxIds"])) {
    const found = await financialRelatedClosures(driverUid, documentId, field);
    found.forEach(docSnap => docsMap.set(docSnap.id, docSnap));
  }
  const docs = [...docsMap.values()];
  let adjusted = 0;
  for (const docSnap of docs) {
    const closure = docSnap.data() || {};
    const kind = financialClosureKind(closure);
    let patch = null;
    const inBillingIds = Array.isArray(closure.includedBillingIds) && closure.includedBillingIds.map(text).includes(text(documentId));
    const inCashboxIds = Array.isArray(closure.includedCashboxIds) && closure.includedCashboxIds.map(text).includes(text(documentId));
    if (type === "gasto" && kind === "gastos") patch = financialExpenseClosurePatch(closure, movement);
    if (settlementPayment && financialIsBillingClosure(kind)) patch = financialBillingSettlementClosurePatch(closure, movement);
    else if (type === "cobro" && financialIsBillingClosure(kind)) patch = financialBillingClosurePatch(closure, movement, { cashboxOnly:!inBillingIds && inCashboxIds });
    if (type === "caja_chica" && financialIsBillingClosure(kind) && financialMethodOf(movement) === "cash") patch = financialBillingClosurePatch(closure, movement, { cashboxOnly:true });
    if ((type === "cobro" || type === "caja_chica") && kind === "caja_chica" && financialMethodOf(movement) === "cash") patch = financialCashboxClosurePatch(closure, movement);
    if (!patch) continue;
    const primaryIds = Array.isArray(closure[includeField]) ? closure[includeField].map(text) : [];
    const removesPrimaryMovement = (type !== "caja_chica" || kind === "caja_chica") && primaryIds.includes(text(documentId));
    const decrementsIncludedCount = removesPrimaryMovement && !settlementPayment;
    const remainingIds = removesPrimaryMovement ? financialRemoveArrayItem(closure[includeField], documentId) : closure[includeField];
    const generatedIds = Array.isArray(closure.includedCashboxGeneratedBillingIds)
      ? financialRemoveArrayItem(closure.includedCashboxGeneratedBillingIds, documentId)
      : closure.includedCashboxGeneratedBillingIds;
    const eligibleIds = Array.isArray(closure.includedCashboxEligibleBillingIds)
      ? financialRemoveArrayItem(closure.includedCashboxEligibleBillingIds, documentId)
      : closure.includedCashboxEligibleBillingIds;
    const cashboxIds = Array.isArray(closure.includedCashboxIds)
      ? financialRemoveArrayItem(closure.includedCashboxIds, documentId)
      : closure.includedCashboxIds;
    await docSnap.ref.set({
      ...patch,
      [includeField]:remainingIds,
      ...(generatedIds !== undefined ? { includedCashboxGeneratedBillingIds:generatedIds } : {}),
      ...(eligibleIds !== undefined ? { includedCashboxEligibleBillingIds:eligibleIds } : {}),
      ...(cashboxIds !== undefined ? { includedCashboxIds:cashboxIds } : {}),
      includedCount:decrementsIncludedCount ? Math.max(0, Number(closure.includedCount || 0) - 1) : Number(closure.includedCount || 0),
      adminAdjusted:true,
      adminAdjustedReason:type === "caja_chica" ? "Caja chica excluida manualmente" : "Movimiento eliminado manualmente",
      adminAdjustedAt:FieldValue.serverTimestamp(),
      adminAdjustedAtMs:Date.now(),
      adminAdjustedByUid:adminUid,
      updatedAt:FieldValue.serverTimestamp(),
      updatedAtMs:Date.now(),
      version:"v4077-caja-chica-cierre-automatico"
    }, { merge:true });
    adjusted += 1;
  }
  return adjusted;
}

async function financialReceiptIndexDocuments(documentId = "", type = "") {
  const id = text(documentId);
  if (!id) return [];
  const found = new Map();
  const canonicalIds = type === "gasto" ? [`expense_${id}`, `gasto_${id}`] : [`payment_${id}`, `billing_${id}`];
  for (const receiptId of canonicalIds) {
    const snap = await db.collection("receipt_index").doc(receiptId).get().catch(() => null);
    if (snap?.exists) found.set(snap.id, snap);
  }
  for (const field of ["recordId", "relatedDocumentId", "operationId"]) {
    const snap = await db.collection("receipt_index").where(field, "==", id).limit(30).get().catch(error => {
      console.warn("[admin financial delete] receipt index query skipped", field, error?.code || error?.message || error);
      return null;
    });
    snap?.docs?.forEach(item => found.set(item.id, item));
  }
  return [...found.values()];
}

async function financialDeleteStorageArtifacts(rows = [], counters = { deletedFiles:0 }) {
  const paths = new Set();
  for (const row of rows) {
    const data = row?.data && typeof row.data === "function" ? row.data() || {} : row || {};
    for (const candidate of collectStorageCandidates(data)) {
      const path = storagePathFromCandidate(candidate);
      if (path) paths.add(path);
    }
  }
  for (const path of paths) {
    try {
      await bucket.file(path).delete({ ignoreNotFound:true });
      counters.deletedFiles += 1;
    } catch (error) {
      if (error?.code !== 404 && error?.code !== "404") console.warn("[admin financial delete] storage skip", path, error?.code || error?.message || error);
    }
  }
}

exports.adminDeleteFinancialMovement = onCall({ region:"southamerica-east1", timeoutSeconds:180, memory:"512MiB" }, async request => {
  const adminUid = await assertAdmin(request);
  const type = normalized(request.data?.type);
  const documentId = text(request.data?.documentId);
  const requestedDriverUid = text(request.data?.driverUid);
  const reason = text(request.data?.reason || "Borrado manual desde panel administrador").slice(0, 280);
  if (!documentId) throw new HttpsError("invalid-argument", "Falta el movimiento.");
  if (!["cobro", "gasto", "caja_chica"].includes(type)) throw new HttpsError("invalid-argument", "Tipo de movimiento no permitido.");

  const collectionName = type === "gasto" ? "gastos" : "billing_records";
  const ref = db.collection(collectionName).doc(documentId);
  const snap = await ref.get();
  const receiptIndexes = type === "caja_chica" ? [] : await financialReceiptIndexDocuments(documentId, type);
  if (!snap.exists && !receiptIndexes.length) throw new HttpsError("not-found", "El movimiento ya no existe en Firestore.");
  const data = snap.exists ? (snap.data() || {}) : ({ id:documentId, ...(receiptIndexes[0]?.data() || {}) });
  const requestedMatches = requestedDriverUid ? await financialBelongsToDriver(data, requestedDriverUid) : false;
  const driverUid = requestedMatches ? requestedDriverUid : (financialDriverValues(data)[0] || requestedDriverUid);
  if (!driverUid) throw new HttpsError("failed-precondition", "El movimiento no tiene un chofer identificable.");
  if (type === "caja_chica" && financialMethodOf(data) !== "cash") throw new HttpsError("failed-precondition", "Solo los cobros en efectivo generan caja chica.");

  const auditRef = db.collection(ADMIN_AUDIT_COLLECTION).doc(`financial_delete_${Date.now()}_${documentId}`);
  const counters = { deletedFiles:0 };
  const closuresAdjusted = await financialAdjustClosures({ type, driverUid, documentId, movement:data, adminUid });

  if (type === "caja_chica") {
    await ref.set({
      excludeFromCashbox:true, cashboxExcluded:true, cajaChicaEliminada:true,
      cajaChicaEliminadaAt:FieldValue.serverTimestamp(), cajaChicaEliminadaAtMs:Date.now(),
      cajaChicaEliminadaByUid:adminUid,
      cajaChicaEliminadaReason:reason,
      updatedAt:FieldValue.serverTimestamp(), updatedAtMs:Date.now(), updatedByUid:adminUid
    }, { merge:true });
  } else {
    await financialDeleteStorageArtifacts([data, ...receiptIndexes], counters);
    const batch = db.batch();
    if (snap.exists) batch.delete(ref);
    receiptIndexes.forEach(item => batch.delete(item.ref));
    await batch.commit();
  }

  await auditRef.set({
    action:"admin_delete_financial_movement", type, collectionName, documentId, driverUid,
    adminUid, reason, amount:financialAmountOf(data), method:financialMethodOf(data), closuresAdjusted,
    deletedFiles:counters.deletedFiles || 0, deletedReceiptIndexes:receiptIndexes.length, createdAt:FieldValue.serverTimestamp(), createdAtMs:Date.now()
  }, { merge:true }).catch(() => {});
  return { ok:true, type, collectionName, documentId, driverUid, closuresAdjusted, deletedFiles:counters.deletedFiles || 0, deletedReceiptIndexes:receiptIndexes.length };
});

exports.adminModifyExpenseAmount = onCall({ region:"southamerica-east1", timeoutSeconds:180, memory:"512MiB" }, async request => {
  const adminUid = await assertAdmin(request);
  const documentId = text(request.data?.documentId);
  const requestedDriverUid = text(request.data?.driverUid);
  const newAmount = Math.max(0, Math.round(financialNumber(request.data?.newAmount)));
  if (!documentId) throw new HttpsError("invalid-argument", "Falta el gasto.");
  if (!(newAmount > 0)) throw new HttpsError("invalid-argument", "El importe nuevo debe ser mayor a cero.");

  const expenseRef = db.collection("gastos").doc(documentId);
  const initialSnapshot = await expenseRef.get();
  if (!initialSnapshot.exists) throw new HttpsError("not-found", "El gasto original ya no existe en Firestore.");
  const initialData = initialSnapshot.data() || {};
  const requestedMatches = requestedDriverUid ? await financialBelongsToDriver(initialData, requestedDriverUid) : false;
  const driverUid = requestedMatches ? requestedDriverUid : (financialDriverValues(initialData)[0] || requestedDriverUid);
  if (!driverUid) throw new HttpsError("failed-precondition", "El gasto no tiene un chofer identificable.");

  const receiptIndexes = await financialReceiptIndexDocuments(documentId, "gasto");
  const closureDocuments = await financialRelatedClosures(driverUid, documentId, "includedExpenseIds");
  const auditRef = db.collection(ADMIN_AUDIT_COLLECTION).doc(`expense_modify_${Date.now()}_${documentId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180));
  let previousAmount = 0;
  const closureUpdates = [];

  await db.runTransaction(async transaction => {
    const expenseSnapshot = await transaction.get(expenseRef);
    if (!expenseSnapshot.exists) throw new HttpsError("not-found", "El gasto original ya no existe en Firestore.");
    const indexSnapshots = [];
    for (const item of receiptIndexes) indexSnapshots.push(await transaction.get(item.ref));
    const closureSnapshots = [];
    for (const item of closureDocuments) closureSnapshots.push({ id:item.id, ref:item.ref, snapshot:await transaction.get(item.ref) });

    const expenseData = expenseSnapshot.data() || {};
    previousAmount = Math.max(0, Math.round(financialAmountOf(expenseData)));
    if (!(previousAmount > 0)) throw new HttpsError("failed-precondition", "El gasto anterior no tiene un importe válido.");
    if (previousAmount === newAmount) return;

    const expenseUpdate = {
      amount:newAmount, monto:newAmount,
      previousAmount, amountBeforeCorrection:previousAmount,
      amountCorrectionCount:Math.max(0, Number(expenseData.amountCorrectionCount || 0)) + 1,
      amountCorrectedByUid:adminUid, amountCorrectedByRole:"admin",
      amountCorrectedAt:FieldValue.serverTimestamp(),
      updatedAt:FieldValue.serverTimestamp(), updatedAtMs:Date.now(),
      version:"v4146-expense-receipt-actions"
    };
    for (const key of ["valor", "totalAmount", "importe", "price", "total"]) {
      if (Object.prototype.hasOwnProperty.call(expenseData, key)) expenseUpdate[key] = newAmount;
    }
    transaction.update(expenseRef, expenseUpdate);

    indexSnapshots.forEach(snapshot => {
      if (!snapshot.exists) return;
      transaction.update(snapshot.ref, {
        amount:newAmount, previousAmount,
        amountCorrectedByUid:adminUid, amountCorrectedByRole:"admin",
        amountCorrectedAt:FieldValue.serverTimestamp(),
        updatedAt:FieldValue.serverTimestamp(), updatedAtMs:Date.now(),
        version:"v4146-expense-receipt-actions"
      });
    });

    closureUpdates.length = 0;
    closureSnapshots.forEach(item => {
      if (!item.snapshot.exists) return;
      const patch = financialExpenseAmountCorrectionPatch(item.snapshot.data() || {}, expenseData, newAmount);
      if (!patch) return;
      transaction.update(item.ref, {
        ...patch,
        adminAdjusted:true, adminAdjustedReason:"Valor de gasto corregido",
        amountCorrectionRecordId:documentId,
        amountCorrectionPrevious:previousAmount,
        amountCorrectionNew:newAmount,
        amountCorrectionDifference:newAmount - previousAmount,
        amountCorrectedByUid:adminUid, amountCorrectedByRole:"admin",
        amountCorrectedAt:FieldValue.serverTimestamp(),
        updatedAt:FieldValue.serverTimestamp(), updatedAtMs:Date.now(),
        version:"v4146-expense-receipt-actions"
      });
      closureUpdates.push({ id:item.id, patch });
    });

    transaction.set(auditRef, {
      action:"admin_modify_expense_amount", type:"gasto", collectionName:"gastos",
      documentId, recordId:documentId, driverUid, adminUid,
      previousAmount, newAmount, difference:newAmount - previousAmount,
      adjustedClosureCount:closureUpdates.length,
      adjustedClosureIds:closureUpdates.map(item => item.id),
      createdAt:FieldValue.serverTimestamp(), createdAtMs:Date.now(),
      version:"v4146-expense-receipt-actions"
    }, { merge:false });
  });

  return {
    ok:true, type:"gasto", collectionName:"gastos", documentId, driverUid,
    previousAmount, newAmount, closureUpdates,
    adjustedClosureCount:closureUpdates.length,
    updatedReceiptIndexes:receiptIndexes.length
  };
});


// ============================================================================
// RÉCORD PERSONAL — autoridad del servidor
// ============================================================================
const PERSONAL_RECORD_TIMEZONE = "America/Argentina/Cordoba";
const PERSONAL_RECORD_BONUS_RATE = 0.05;
const PERSONAL_RECORD_UID_FIELDS = ["driverUid", "choferUid", "uid", "authUid", "userUid", "driverId", "choferId"];
const PERSONAL_RECORD_AMOUNT_FIELDS = ["amount", "monto", "valor", "grossAmount", "billingAmount", "finalPrice", "finalAmount", "totalAmount", "total", "facturacion", "importe", "precioFinal"];
const PERSONAL_RECORD_DATE_FIELDS = ["operationalDate", "completedAt", "confirmedAt", "paidAt", "invoicedAt", "createdAt", "updatedAt"];
const PERSONAL_RECORD_INVALID_STATUS = ["cancel", "rechaz", "elimin", "borrador", "anulad", "void", "deleted", "failed", "vencid", "pending", "pendiente"];

function personalRecordPositive(value) { return Math.max(0, Math.round(Number(value) || 0)); }
function personalRecordUid(data = {}) {
  for (const field of PERSONAL_RECORD_UID_FIELDS) {
    const value = text(data[field]);
    if (value) return value;
  }
  return "";
}
function personalRecordAmount(data = {}) {
  for (const field of PERSONAL_RECORD_AMOUNT_FIELDS) {
    const amount = personalRecordPositive(data[field]);
    if (amount > 0) return amount;
  }
  return 0;
}
function personalRecordIsTest(data = {}) {
  const flags = [data.isTest, data.testMode, data.demo, data.simulation, data.prueba];
  if (flags.some(value => value === true || normalized(value) === "true")) return true;
  return normalized(data.environment) === "test" || normalized(data.entorno) === "test";
}
function personalRecordIsValid(data = {}) {
  if (!data || personalRecordIsTest(data) || data.deleted === true || data.isDeleted === true || isDriverBillingSettlementPayment(data) || data.excludeFromPerformance === true || data.excludeFromRanking === true) return false;
  const status = normalized(data.status || data.estado || data.paymentStatus || data.billingStatus);
  if (PERSONAL_RECORD_INVALID_STATUS.some(token => status.includes(token))) return false;
  return personalRecordAmount(data) > 0 && Boolean(personalRecordUid(data));
}
function personalRecordDateValue(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function personalRecordDayId(data = {}) {
  const explicit = text(data.operationalDayId || data.dayId || data.fechaOperativa);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  for (const field of PERSONAL_RECORD_DATE_FIELDS) {
    const date = personalRecordDateValue(data[field]);
    if (!date || !Number.isFinite(date.getTime())) continue;
    return new Intl.DateTimeFormat("en-CA", { timeZone: PERSONAL_RECORD_TIMEZONE, year:"numeric", month:"2-digit", day:"2-digit" }).format(date);
  }
  return "";
}
function personalRecordWeeklyPeriodId(dayId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayId)) return "";
  const [year, month, day] = dayId.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const daysSinceSaturday = (date.getUTCDay() + 1) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceSaturday);
  return date.toISOString().slice(0, 10);
}
async function personalRecordAliases(uid) {
  const aliases = new Set([uid]);
  for (const collectionName of ["choferes", "usuarios"]) {
    const snap = await db.collection(collectionName).doc(uid).get().catch(() => null);
    if (!snap?.exists) continue;
    const data = snap.data() || {};
    for (const field of PERSONAL_RECORD_UID_FIELDS.concat(["profileDocumentId", "id"])) {
      const value = text(data[field]);
      if (value) aliases.add(value);
    }
  }
  return aliases;
}
async function personalRecordBillingDocuments(aliases) {
  const documents = new Map();
  const collection = db.collection("billing_records");
  for (const alias of aliases) {
    for (const field of PERSONAL_RECORD_UID_FIELDS) {
      const snap = await collection.where(field, "==", alias).get().catch(error => {
        console.warn("[record propio] consulta omitida", field, error?.code || error?.message || error);
        return null;
      });
      for (const docSnap of snap?.docs || []) documents.set(docSnap.id, docSnap);
    }
  }
  return [...documents.values()];
}
async function personalRecordMigrateLegacy(uid, aliases) {
  const canonicalRef = db.collection("driverPersonalRecords").doc(uid);
  const canonicalSnap = await canonicalRef.get();
  let best = canonicalSnap.exists ? (canonicalSnap.data() || {}) : null;
  let bestAmount = personalRecordPositive(best?.recordAmount);
  const migratedFrom = [];
  for (const alias of aliases) {
    if (!alias || alias === uid) continue;
    const legacyRef = db.collection("driverPersonalRecords").doc(alias.replace(/[^a-zA-Z0-9_-]/g, "_"));
    const legacySnap = await legacyRef.get().catch(() => null);
    if (!legacySnap?.exists) continue;
    const data = legacySnap.data() || {};
    migratedFrom.push(legacySnap.id);
    if (personalRecordPositive(data.recordAmount) > bestAmount) {
      best = data;
      bestAmount = personalRecordPositive(data.recordAmount);
    }
    await legacyRef.set({ migratedToUid: uid, migrationStatus:"preserved-legacy", migratedAt:FieldValue.serverTimestamp() }, { merge:true });
  }
  if (best && (!canonicalSnap.exists || migratedFrom.length)) {
    await canonicalRef.set({
      ...best,
      driverUid: uid,
      driverKey: uid,
      driverId: uid,
      migrationStatus: migratedFrom.length ? "unified" : text(best.migrationStatus),
      migratedFrom,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge:true });
  }
}
async function recomputePersonalRecord(uid) {
  if (!uid) return;
  const aliases = await personalRecordAliases(uid);
  await personalRecordMigrateLegacy(uid, aliases);
  const docs = await personalRecordBillingDocuments(aliases);
  const daily = new Map();
  let driverName = "Chofer";
  let driverAvatar = "";
  for (const docSnap of docs) {
    const data = docSnap.data() || {};
    if (!personalRecordIsValid(data)) continue;
    const owner = personalRecordUid(data);
    if (!aliases.has(owner)) continue;
    const dayId = personalRecordDayId(data);
    if (!dayId) continue;
    const current = daily.get(dayId) || { amount:0, operationIds:[] };
    current.amount += personalRecordAmount(data);
    current.operationIds.push(docSnap.id);
    daily.set(dayId, current);
    driverName = text(data.driverName || data.choferNombre || data.nombreChofer || driverName);
    driverAvatar = text(data.driverAvatar || data.driverPhotoUrl || data.photoUrl || driverAvatar);
  }

  const recordRef = db.collection("driverPersonalRecords").doc(uid);
  const eventCollection = db.collection("personalRecordEvents");
  const existingEvents = await eventCollection.where("driverUid", "==", uid).get().catch(() => null);
  const desired = new Map();
  let runningBest = 0;
  let runningBestDay = "";
  for (const dayId of [...daily.keys()].sort()) {
    const day = daily.get(dayId);
    if (!day || day.amount <= 0) continue;
    if (runningBest === 0) {
      desired.set(`${uid}_${dayId}`, {
        eventId:`${uid}_${dayId}`, driverUid:uid, driverId:uid, driverKey:uid, driverName, driverAvatar,
        operationalDayId:dayId, weeklyPeriodId:personalRecordWeeklyPeriodId(dayId), previousRecordAmount:0,
        newRecordAmount:day.amount, bonusRate:PERSONAL_RECORD_BONUS_RATE, bonusAmount:0,
        recordType:"baseline", status:"confirmed", source:"billing-records-server", sourceOperationIds:day.operationIds,
        sourceOperationCount:day.operationIds.length, calculationVersion:"2.4.56"
      });
      runningBest = day.amount;
      runningBestDay = dayId;
      continue;
    }
    if (day.amount > runningBest) {
      desired.set(`${uid}_${dayId}`, {
        eventId:`${uid}_${dayId}`, driverUid:uid, driverId:uid, driverKey:uid, driverName, driverAvatar,
        operationalDayId:dayId, weeklyPeriodId:personalRecordWeeklyPeriodId(dayId), previousRecordAmount:runningBest,
        newRecordAmount:day.amount, bonusRate:PERSONAL_RECORD_BONUS_RATE,
        bonusAmount:Math.round(day.amount * PERSONAL_RECORD_BONUS_RATE), recordType:"broken", status:"confirmed",
        source:"billing-records-server", sourceOperationIds:day.operationIds,
        sourceOperationCount:day.operationIds.length, calculationVersion:"2.4.56"
      });
      runningBest = day.amount;
      runningBestDay = dayId;
    }
  }

  const batch = db.batch();
  for (const eventSnap of existingEvents?.docs || []) {
    if (!desired.has(eventSnap.id)) {
      batch.set(eventSnap.ref, { status:"reversed", reversedAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp(), reversalReason:"billing-records-recalculated" }, { merge:true });
    }
  }
  for (const [eventId, payload] of desired) {
    batch.set(eventCollection.doc(eventId), { ...payload, updatedAt:FieldValue.serverTimestamp(), createdAt:FieldValue.serverTimestamp() }, { merge:true });
  }
  if (runningBest > 0) {
    batch.set(recordRef, {
      driverUid:uid, driverId:uid, driverKey:uid, driverName, driverAvatar,
      recordAmount:runningBest, recordDayId:runningBestDay, weeklyPeriodId:personalRecordWeeklyPeriodId(runningBestDay),
      baselineEstablished:true, source:"billing-records-server", calculationVersion:"2.4.56", updatedAt:FieldValue.serverTimestamp()
    }, { merge:true });
  } else {
    batch.set(recordRef, { driverUid:uid, driverId:uid, driverKey:uid, recordAmount:0, recordDayId:"", baselineEstablished:false, status:"no-record", updatedAt:FieldValue.serverTimestamp() }, { merge:true });
  }
  await batch.commit();
}

exports.onBillingRecordWritePersonalRecord = onDocumentWritten({
  document: "billing_records/{billingRecordId}",
  region: "southamerica-east1",
  timeoutSeconds: 540,
  memory: "1GiB"
}, async event => {
  const before = event.data?.before?.exists ? (event.data.before.data() || {}) : {};
  const after = event.data?.after?.exists ? (event.data.after.data() || {}) : {};
  if (isDriverBillingSettlementPayment(before) && isDriverBillingSettlementPayment(after)) return { skipped:true, reason:"billing-settlement-payment" };
  const affected = new Set([personalRecordUid(before), personalRecordUid(after)].filter(Boolean));
  for (const uid of affected) await recomputePersonalRecord(uid);
});

exports.applyDailyDebtPenalties = onSchedule({
  schedule: "15 3 * * *",
  timeZone: "America/Argentina/Buenos_Aires",
  region: "southamerica-east1",
  timeoutSeconds: 540,
  memory: "512MiB"
}, async () => {
  const nowMs = Date.now();
  const todayKey = debtPenaltyDayKey(nowMs);
  const snap = await db.collection("deudas_choferes").limit(1000).get();
  let batch = db.batch();
  let writes = 0;
  let processed = 0;
  let skipped = 0;
  let totalInterest = 0;
  const commitIfNeeded = async (force = false) => {
    if (!writes) return;
    if (!force && writes < 420) return;
    await batch.commit();
    batch = db.batch();
    writes = 0;
  };

  for (const docSnap of snap.docs) {
    const row = docSnap.data() || {};
    if (row.penaltyEnabled === false) { skipped += 1; continue; }
    if (!debtPenaltyStatusIsActive(row)) { skipped += 1; continue; }
    if (String(row.lastPenaltyAppliedDay || "") === todayKey) { skipped += 1; continue; }
    const remaining = debtPenaltyRemaining(row);
    if (!(remaining > 0)) { skipped += 1; continue; }
    const rate = Number(row.penaltyDailyRate ?? 0.03);
    const days = debtPenaltyDaysToApply({ row, nowMs, rate });
    if (!(days > 0)) { skipped += 1; continue; }
    const interestAmount = debtPenaltyMoney(remaining * (Math.pow(1 + rate, days) - 1));
    if (!(interestAmount > 0)) { skipped += 1; continue; }
    const newBalance = debtPenaltyMoney(remaining + interestAmount);
    const driverUid = text(row.driverUid || row.choferUid || row.uid || row.driverId);
    const debtId = text(row.debtId || row.id || docSnap.id) || docSnap.id;
    const movementId = `penalty_${docSnap.id}_${todayKey}`;

    batch.set(docSnap.ref, {
      remainingAmount: newBalance,
      saldoPendiente: newBalance,
      penaltyAccruedAmount: FieldValue.increment(interestAmount),
      lastPenaltyAppliedAt: FieldValue.serverTimestamp(),
      lastPenaltyAppliedAtMs: nowMs,
      lastPenaltyAppliedDay: todayKey,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtMs: nowMs,
      sourceModule: "pendientes"
    }, { merge:true });
    writes += 1;

    batch.set(db.collection("deuda_movimientos").doc(movementId), {
      movementId,
      driverUid,
      debtId,
      type: "penalty",
      amount: interestAmount,
      previousBalance: remaining,
      newBalance,
      rate,
      days,
      dayKey: todayKey,
      createdAt: FieldValue.serverTimestamp(),
      createdAtMs: nowMs,
      sourceModule: "pendientes",
      version: "applyDailyDebtPenalties-v1"
    }, { merge:false });
    writes += 1;
    processed += 1;
    totalInterest = debtPenaltyMoney(totalInterest + interestAmount);
    await commitIfNeeded(false);
  }
  await commitIfNeeded(true);
  console.info("applyDailyDebtPenalties", { processed, skipped, scanned:snap.size, totalInterest, todayKey });
});

// Envía a Telegram cada cobro nuevo:
// - digital (tarjeta, QR o transferencia), con foto;
// - efectivo, sin foto pero con los datos de la operación.
exports.notifyBillingRecordV2 = onDocumentCreated({
  document: "billing_records/{docId}",
  region: TELEGRAM_FUNCTION_REGION,
  memory: "256MiB",
  timeoutSeconds: 120,
  retry: true,
  secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
}, async event => {
  const data = event.data?.data() || {};
  if (data.suppressTelegram === true) {
    return { skipped: true, reason: "suppressed-by-source" };
  }
  if (data.isSimulated === true || data.createdBySimulation === true || data.verificationMode === "simulation") {
    return { skipped: true, reason: "simulation-record" };
  }
  const method = telegramPaymentMethod(data);
  if (isDriverBillingSettlementPayment(data)) {
    if (!new Set(["cash", "transfer"]).has(method.key)) {
      return { skipped: true, reason: "unsupported-settlement-payment-method", method: method.key };
    }
    if (!(telegramAmount(data) > 0)) {
      return { skipped: true, reason: "invalid-settlement-payment-amount" };
    }
    const docId = telegramSafeText(event.params?.docId || event.data?.id);
    const balance = await telegramOpenBillingBalance(data, docId);
    const previousPayload = Number(data.previousBillingBalance);
    const currentPayload = Number(data.newBillingBalance);
    const previousBalance = Number.isFinite(previousPayload) ? Math.max(0, previousPayload) : Math.max(0, Number(balance.amountFromDriver || 0) + telegramAmount(data));
    const currentBalance = Number.isFinite(currentPayload) ? Math.max(0, currentPayload) : Math.max(0, Number(balance.amountFromDriver || 0));
    const notes = telegramSafeText(data.reason || data.notes || data.detalle || data.descripcion || data.description);
    const caption = [
      "PAGO DEL CHOFER · FACTURACIÓN",
      `Chofer: ${telegramDriverName(data)}`,
      `Monto recibido: ${telegramMoney(telegramAmount(data))}`,
      `Método: ${method.label}`,
      ...(notes ? [`Motivo: ${notes.slice(0, 300)}`] : []),
      `Facturación anterior: ${telegramMoney(previousBalance)}`,
      `Facturación actual: ${telegramMoney(currentBalance)}`,
      currentBalance > 0.49 ? `Quién paga a quién: Chofer debe liquidar a Explora ${telegramMoney(currentBalance)}` : "Quién paga a quién: nadie debe liquidar en Facturación",
      "Deudas independientes: sin cambios",
      `Fecha: ${telegramDateLabel(data)}`
    ].join("\n");
    return telegramProcessNotification({
      kind: "billing",
      docId,
      data,
      eventId: event.id,
      caption,
      requirePhoto: method.key === "transfer"
    });
  }
  const isDigital = new Set(["card", "qr", "transfer", "digital"]).has(method.key);
  const isCash = method.key === "cash";
  if (!isDigital && !isCash) {
    return { skipped: true, reason: "unsupported-payment-method", method: method.key };
  }

  const docId = telegramSafeText(event.params?.docId || event.data?.id);
  const notes = telegramSafeText(data.notes || data.detalle || data.descripcion || data.observaciones || data.serviceDescription);
  const balance = await telegramOpenBillingBalance(data, docId);
  const caption = [
    isCash ? "COBRO EN EFECTIVO REGISTRADO" : "COBRO DIGITAL REGISTRADO",
    `Chofer: ${telegramDriverName(data)}`,
    `Monto: ${telegramMoney(telegramAmount(data))}`,
    `Método: ${method.label}`,
    ...(notes ? [`Detalle: ${notes.slice(0, 300)}`] : []),
    telegramBillingBalanceLine(balance),
    `Fecha: ${telegramDateLabel(data)}`
  ].join("\n");

  return telegramProcessNotification({
    kind: "billing",
    docId,
    data,
    eventId: event.id,
    caption,
    requirePhoto: isDigital
  });
});

// Envía a Telegram cada gasto nuevo con la foto del comprobante.
exports.notifyExpenseV2 = onDocumentCreated({
  document: "gastos/{docId}",
  region: TELEGRAM_FUNCTION_REGION,
  memory: "256MiB",
  timeoutSeconds: 120,
  retry: true,
  secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
}, async event => {
  const data = event.data?.data() || {};
  const docId = telegramSafeText(event.params?.docId || event.data?.id);
  const notes = telegramSafeText(data.notes || data.detalle || data.descripcion || data.observaciones);
  const captionLines = [
    "GASTO REGISTRADO",
    `Chofer: ${telegramDriverName(data)}`,
    `Monto: ${telegramMoney(telegramAmount(data))}`,
    `Tipo: ${telegramExpenseType(data)}`,
    ...(notes ? [`Detalle: ${notes.slice(0, 300)}`] : []),
    `Fecha: ${telegramDateLabel(data)}`
  ];

  return telegramProcessNotification({
    kind: "expense",
    docId,
    data,
    eventId: event.id,
    caption: captionLines.join("\n")
  });
});

// Envía a Telegram cada entrega de deuda registrada por el administrador.
// Efectivo se informa como texto; transferencia incluye el comprobante.
exports.notifyAdminDebtPaymentTelegramV1 = onDocumentCreated({
  document: "deuda_pagos/{docId}",
  region: TELEGRAM_FUNCTION_REGION,
  memory: "256MiB",
  timeoutSeconds: 120,
  retry: true,
  secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
}, async event => {
  const data = event.data?.data() || {};
  if (!isAdminDebtPayment(data)) {
    return { skipped: true, reason: "not-an-admin-debt-payment" };
  }

  const method = telegramPaymentMethod(data);
  if (!new Set(["cash", "transfer"]).has(method.key)) {
    return { skipped: true, reason: "unsupported-payment-method", method: method.key };
  }
  if (!(telegramAmount(data) > 0)) {
    return { skipped: true, reason: "invalid-payment-amount" };
  }

  const docId = telegramSafeText(event.params?.docId || event.data?.id);
  return telegramProcessNotification({
    kind: "admin_debt_payment",
    docId,
    sourceCollection: "deuda_pagos",
    sourceDocumentId: docId,
    data,
    eventId: event.id,
    caption: buildAdminDebtPaymentTelegramText(data, {
      formatMoney: telegramMoney,
      formatDate: telegramDateLabel
    }),
    requirePhoto: Boolean(telegramDirectPhotoUrl(data))
  });
});

// Envía a Telegram cada deuda del chofer cargada desde el menú administrador.
// El importe queda 100 % a cargo del chofer; el comprobante es opcional.
exports.notifyAdminDriverDebtTelegramV1 = onDocumentCreated({
  document: "deudas_choferes/{docId}",
  region: TELEGRAM_FUNCTION_REGION,
  memory: "256MiB",
  timeoutSeconds: 120,
  retry: true,
  secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
}, async event => {
  const data = event.data?.data() || {};
  if (!isAdminDriverDebt(data)) {
    return { skipped: true, reason: "not-an-admin-driver-debt" };
  }
  if (!(telegramAmount(data) > 0)) {
    return { skipped: true, reason: "invalid-debt-amount" };
  }

  const docId = telegramSafeText(event.params?.docId || event.data?.id);
  return telegramProcessNotification({
    kind: "admin_driver_debt",
    docId,
    sourceCollection: "deudas_choferes",
    sourceDocumentId: docId,
    data,
    eventId: event.id,
    caption: buildAdminDriverDebtTelegramText(data, {
      formatMoney: telegramMoney,
      formatDate: telegramDateLabel
    }),
    requirePhoto: Boolean(telegramDirectPhotoUrl(data))
  });
});

// Telegram grupal · cierres solicitados por chofer: gastos, caja chica y facturación.
exports.notifyClosureTelegramGroupV1 = onDocumentCreated({
  document: "cierres_semanales/{docId}",
  region: TELEGRAM_FUNCTION_REGION,
  memory: "256MiB",
  timeoutSeconds: 120,
  retry: true,
  secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
}, async event => {
  const data = event.data?.data() || {};
  if (!closureTelegramAllowed(data)) return { skipped: true, reason: "not-a-driver-operational-closure" };
  const docId = telegramSafeText(event.params?.docId || event.data?.id);
  return telegramProcessNotification({
    kind: "closure",
    docId,
    sourceCollection: "cierres_semanales",
    sourceDocumentId: docId,
    data,
    eventId: event.id,
    caption: closureTelegramText(data),
    requirePhoto: false
  });
});

// Telegram grupal · cierre semanal de Uber. onDocumentWritten permite volver a avisar
// si un cierre rechazado es corregido y reenviado con el mismo ID.
exports.notifyUberClosureTelegramGroupV1 = onDocumentWritten({
  document: "uber_weekly_closures/{docId}",
  region: TELEGRAM_FUNCTION_REGION,
  memory: "256MiB",
  timeoutSeconds: 120,
  retry: true,
  secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
}, async event => {
  const before = event.data?.before?.exists ? (event.data.before.data() || {}) : {};
  const after = event.data?.after?.exists ? (event.data.after.data() || {}) : null;
  if (!after) return { skipped: true, reason: "deleted" };
  const role = telegramSafeText(after.createdByRole).toLowerCase();
  if (role && role !== "driver" && role !== "chofer") return { skipped: true, reason: "not-driver-created" };
  const review = telegramSafeText(after.reviewStatus || after.status).toLowerCase();
  const isPending = review === "pending" || review === "pending_review";
  const isNoData = after.noData === true || review === "no_data";
  if (!isPending && !isNoData) return { skipped: true, reason: "not-submitted" };

  const beforeReview = telegramSafeText(before.reviewStatus || before.status).toLowerCase();
  const beforeReceipt = telegramSafeText(before.receiptUrl || before.notificationPhotoUrl);
  const afterReceipt = telegramSafeText(after.receiptUrl || after.notificationPhotoUrl);
  const firstWrite = !event.data?.before?.exists;
  const resubmitted = !firstWrite && (
    beforeReview !== review ||
    beforeReceipt !== afterReceipt ||
    Number(before.updatedAtMs || 0) !== Number(after.updatedAtMs || 0)
  );
  if (!firstWrite && !resubmitted) return { skipped: true, reason: "no-new-submission" };

  const docId = telegramSafeText(event.params?.docId || event.data?.after?.id);
  const revisionKey = `${docId}_${Number(after.updatedAtMs || after.createdAtMs || Date.now())}`;
  return telegramProcessNotification({
    kind: "uber",
    docId,
    notificationKey: revisionKey,
    sourceCollection: "uber_weekly_closures",
    sourceDocumentId: docId,
    data: after,
    eventId: event.id,
    caption: uberTelegramText(after),
    requirePhoto: !isNoData
  });
});


// Compatibilidad de despliegue: conserva los nombres de las funciones WhatsApp anteriores
// pero las vuelve NO-OP. Así, un deploy normal reemplaza cualquier versión activa que
// todavía pudiera estar enviando mensajes por WhatsApp.
exports.notifyBillingWhatsappGroupV1 = onDocumentCreated({
  document: "billing_records/{docId}",
  region: TELEGRAM_FUNCTION_REGION
}, async () => ({ skipped: true, reason: "whatsapp-disabled-use-telegram-group" }));

exports.notifyExpenseWhatsappGroupV1 = onDocumentCreated({
  document: "gastos/{docId}",
  region: TELEGRAM_FUNCTION_REGION
}, async () => ({ skipped: true, reason: "whatsapp-disabled-use-telegram-group" }));

exports.notifyClosureWhatsappGroupV1 = onDocumentCreated({
  document: "cierres_semanales/{docId}",
  region: TELEGRAM_FUNCTION_REGION
}, async () => ({ skipped: true, reason: "whatsapp-disabled-use-telegram-group" }));

exports.notifyUberClosureWhatsappGroupV1 = onDocumentWritten({
  document: "uber_weekly_closures/{docId}",
  region: TELEGRAM_FUNCTION_REGION
}, async () => ({ skipped: true, reason: "whatsapp-disabled-use-telegram-group" }));
