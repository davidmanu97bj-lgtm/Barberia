import {createReceiptBundle,createReceiptPhoto,shortReceiptName,shortInvoiceName} from "./receipt-files.js?v=20260916-uber-retired-316";
import {statementHtml,documentButton} from "./period-statement.js?v=20260916-reparto-40-60-v1";
import {buildClosurePreview,closureReportHtml,createClosurePdf} from "./closure-report.js?v=20260916-cierre-proof-320";
import { app, auth, authReady } from "./auth-session.js?v=20260914-web-only-1";
import { movementColor } from "./movement-colors.js?v=20260914-web-only-1";
import { tourismCatalog, tourismRoute, searchTourismPlaces, tourismCountryNames } from "./tourism-catalog.js";
import { mountTripCalendar } from "./trip-calendar.js?v=20260913-calendario-detalles";
import { monthRange, normalizeTripDraft, canManageTrip } from "./calendar-core.js?v=20260913-calendario-detalles";
import * as firebaseSettings from "./firebase-config.js?v=20260824-15";

const { BUSINESS_ID, USER_EMAIL_DOMAIN } = firebaseSettings;
const LOGIN_ALIASES = firebaseSettings.LOGIN_ALIASES || {};

import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  initializeFirestore, collection, addDoc, doc, getDoc, getDocFromServer, getDocs, setDoc,
  onSnapshot, onSnapshotsInSync, serverTimestamp, deleteField, query, where, or, orderBy, limit, writeBatch, runTransaction
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
const storage = getStorage(app);
const functions = getFunctions(app, "southamerica-east1");
const exploraRouteCallable = httpsCallable(functions, "exploraRoute");
const adminCreateDriverCallable = httpsCallable(functions, "adminCreateDriver");
const adminUpdateDriverCallable = httpsCallable(functions, "adminUpdateDriver");
const ensureTeamRealtimeBalancesCallable = httpsCallable(functions, "ensureTeamRealtimeBalances");
const adminDeleteFinancialMovementCallable = httpsCallable(functions, "adminDeleteFinancialMovement");
const adminModifyExpenseAmountCallable = httpsCallable(functions, "adminModifyExpenseAmount");
const adminModifyBillingAmountCallable = httpsCallable(functions, "adminModifyBillingAmount");
const AUTH_READY_TIMEOUT_MS = 2500;

const $ = id => document.getElementById(id);


let statementInvoices = new Map();
let unsubscribeStatementInvoices = null;
let documentFileUrls = new Set();
let documentGeneration = 0;

function subscribeStatementInvoices(user) {
  unsubscribeStatementInvoices?.();
  statementInvoices = new Map();
  const uid = user.uid;
  unsubscribeStatementInvoices = onSnapshot(query(collection(db,"arca_invoices"),where("driverUid","==",uid)), snapshot => {
    if (auth.currentUser?.uid !== uid) return;
    statementInvoices = new Map(snapshot.docs.map(item => [item.id,{id:item.id,...item.data()}]));
    scheduleDashboardRender();
  }, error => { console.warn("Facturas del extracto:", error.code); });
}

function renderPeriodStatement(model) {
  const container = $("periodStatement");
  if (!container) return;
  const orderedRows = Object.fromEntries(Object.entries(model.rows).map(([key, rows]) => [key,
    sortUnifiedReceipts(rows.map(item => ({...item,_receiptGroupKey:key+":"+item.id,_sortPriority:2})), receiptSortOrder)]));
  container.innerHTML = statementHtml({model,driverName:currentDriverName(),invoices:statementInvoices,orderedRows});
  const sync = document.createElement("span"); sync.className="statement-sync";
  sync.textContent=$("syncStatus")?.textContent || "";
  container.querySelector(".statement-heading>div")?.append(sync);
  $("driverDashboard").classList.add("has-period-statement");
}

async function uploadOperationalReceipt(file, basePath, kind, id, requireImage = false) {
  if (requireImage && !String(file?.type || '').startsWith('image/')) throw new Error("Adjuntá una foto JPG, PNG o WebP legible.");
  const photo = await createReceiptPhoto(file);
  const imagePath = basePath + "/imagen.jpg";
  const imageRef = ref(storage,imagePath);
  await retryFirebaseOperation(() => uploadBytes(imageRef,photo,{contentType:"image/jpeg"}),4);
  const imageUrl = await retryFirebaseOperation(() => getDownloadURL(imageRef),4);
  return {proofUrl:imageUrl,proofPath:imagePath,receiptUrl:imageUrl,receiptPath:imagePath,receiptPdfPath:"",
    proofMimeType:"image/jpeg",receiptMimeType:"image/jpeg",proofFileName:"imagen.jpg",receiptFileName:"imagen.jpg",receiptPdfFileName:shortReceiptName(kind,id),
    telegramPhotoUrl:imageUrl,telegramPhotoPath:imagePath,notificationPhotoUrl:imageUrl,telegramPhotoMimeType:"image/jpeg",
    receiptFormatVersion:"image-first-pdf-later-v2"};
}

function prepareOperationalPdfInBackground(response) {
  const collectionName=String(response?.collection || ''), id=String(response?.id || '');
  if (!collectionName || !id || collectionName === ROOT_COLLECTIONS.payments && response?.row?.method === 'cash') return;
  window.setTimeout(() => {
    httpsCallable(functions,"receiptPdf",{timeout:90000})({collectionName,id}).catch(error => {
      console.info("PDF pendiente; se preparará al abrirlo:",firebaseErrorCode(error));
    });
  },80);
}

function clearDocumentFiles() {
  documentGeneration++;
  for (const url of documentFileUrls) URL.revokeObjectURL(url);
  documentFileUrls.clear();
  $("documentActions")?.replaceChildren();
}

async function openStatementDocument(kind,id,collectionName) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  clearDocumentFiles();
  const generation = documentGeneration;
  $("documentModal").classList.remove("hidden");
  $("documentTitle").textContent = kind === "invoice" ? "Factura ARCA" : "Comprobante PDF";
  $("documentStatus").textContent = "Preparando PDF…";
  try {
    const name = kind === "invoice" ? "arcaInvoicePdf" : "receiptPdf";
    const payload = kind === "invoice" ? {id} : {id,collectionName};
    const {data} = await httpsCallable(functions,name,{timeout:90000})(payload);
    if (auth.currentUser?.uid !== uid || generation !== documentGeneration) return;
    const binary = atob(data.base64 || "");
    if (!binary.startsWith("%PDF-")) throw new Error("El servidor no devolvió un PDF válido.");
    const safeName = String(data.filename || "comprobante.pdf").replace(/[^A-Za-z0-9_.-]/g,"_");
    const file = new File([Uint8Array.from(binary,c=>c.charCodeAt(0))],safeName,{type:"application/pdf"});
    const url = URL.createObjectURL(file); documentFileUrls.add(url);
    $("documentTitle").textContent = safeName;
    $("documentStatus").textContent = kind === "invoice" ? "Factura autorizada. El comprobante de pago se conserva por separado." : "PDF listo. La imagen original se conserva para verificación.";
    const open = document.createElement("a"); open.href=url;open.target="_blank";open.rel="noopener";open.className="primary";open.textContent="Abrir PDF";
    const save = document.createElement("a");save.href=url;save.download=safeName;save.className="secondary";save.textContent="Guardar PDF";
    $("documentActions").append(open,save);
    if (navigator.canShare?.({files:[file]})) {
      const share=document.createElement("button");share.type="button";share.className="secondary";share.textContent="Compartir PDF";
      share.addEventListener("click",async()=>{try{await navigator.share({files:[file],title:safeName});}catch(error){if(error.name!=="AbortError")$("documentStatus").textContent="Usá Abrir PDF o Guardar PDF.";}});
      $("documentActions").append(share);
    }
  } catch(error) {
    if (generation !== documentGeneration || auth.currentUser?.uid !== uid) return;
    const invoice = statementInvoices.get(id);
    $("documentStatus").textContent = kind === "invoice" && invoice?.status !== "authorized"
      ? "Todavía no hay una factura ARCA autorizada para este cobro. Revisá Facturas de viajes y la configuración fiscal. No se reemplazará por una imagen ni por un PDF sin validez fiscal."
      : (error.message || "No se pudo preparar el PDF. Volvé a intentarlo.");
    const retry=document.createElement("button");retry.type="button";retry.className="secondary";retry.textContent="Reintentar";
    retry.addEventListener("click",()=>openStatementDocument(kind,id,collectionName));$("documentActions").append(retry);
  }
}

function operationalReferenceForUrl(url) {
  const sources = [[payments,ROOT_COLLECTIONS.payments],[expenses,ROOT_COLLECTIONS.expenses],[uberClosures,ROOT_COLLECTIONS.uber],
    [debts,ROOT_COLLECTIONS.debts],[debtPayments,ROOT_COLLECTIONS.debtPayments],[advances,ROOT_COLLECTIONS.advances],[closures,ROOT_COLLECTIONS.closures],
    [adminPayments,ROOT_COLLECTIONS.payments],[adminExpenses,ROOT_COLLECTIONS.expenses],[adminUberClosures,ROOT_COLLECTIONS.uber],
    [adminDebts,ROOT_COLLECTIONS.debts],[adminAllClosures,ROOT_COLLECTIONS.closures]];
  for (const [rows,collectionName] of sources) {
    const item = rows.find(row => [row.proofUrl,row.receiptUrl,row.adminProofUrl,row.driverProofUrl].includes(url));
    if (item) return {id:item.id,collectionName};
  }
  return null;
}

function photoPicker(key) {
  return document.querySelector(`[data-photo-picker="${key}"]`);
}

function selectedPhotoFile(key) {
  const picker = photoPicker(key);
  if (!picker) return null;
  const selectedInput = $(picker.dataset.selectedInput || "");
  if (selectedInput?.files?.[0]) return selectedInput.files[0];
  return Array.from(picker.querySelectorAll(".photo-source-input"))
    .map(input => input.files?.[0] || null)
    .find(Boolean) || null;
}

function clearPhotoPicker(key) {
  const picker = photoPicker(key);
  if (!picker) return;
  picker.querySelectorAll(".photo-source-input").forEach(input => { input.value = ""; });
  delete picker.dataset.selectedInput;
  const selection = picker.querySelector("[data-photo-selection]");
  if (selection) {
    selection.textContent = ["management","closure"].includes(key) ? "Ningún comprobante seleccionado." : "Ninguna foto seleccionada.";
    selection.classList.remove("has-photo");
  }
}

function setPhotoPickerDisabled(key, disabled) {
  const picker = photoPicker(key);
  if (!picker) return;
  picker.querySelectorAll(".photo-source-input, [data-photo-input]").forEach(control => {
    control.disabled = Boolean(disabled);
  });
}

function initializePhotoSourcePickers() {
  document.querySelectorAll("[data-photo-picker]").forEach(picker => {
    picker.querySelectorAll("[data-photo-input]").forEach(button => {
      button.addEventListener("click", () => {
        const input = $(button.dataset.photoInput || "");
        if (!input || input.disabled) return;
        input.click();
      });
    });

    picker.querySelectorAll(".photo-source-input").forEach(input => {
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;
        picker.querySelectorAll(".photo-source-input").forEach(other => {
          if (other !== input) other.value = "";
        });
        picker.dataset.selectedInput = input.id;
        const selection = picker.querySelector("[data-photo-selection]");
        if (selection) {
          const source = input.dataset.photoSource === "camera" ? "Foto tomada" : input.dataset.photoSource === "file" ? "Archivo seleccionado" : "Foto de galería";
          selection.textContent = `${source}: ${file.name || "imagen seleccionada"}`;
          selection.classList.add("has-photo");
        }
      });
    });

    picker.closest("form")?.addEventListener("reset", () => {
      window.setTimeout(() => clearPhotoPicker(picker.dataset.photoPicker), 0);
    });
  });
}

initializePhotoSourcePickers();
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
let teamRealtimeBalances = [];
let unsubscribeTeamRealtimeBalances = null;
let teamRealtimeLoadError = "";
let unsubscribeOwnProfileStatus = null;
let disabledProfileSignoutInProgress = false;

// Estado exclusivo del panel Admin. Se mantiene separado de la pantalla del chofer.
let adminDrivers = [];
let adminPayments = [];
let adminExpenses = [];
let adminUberClosures = [];
let adminAllClosures = [];
let adminDebts = [];
let adminDebtPayments = [];
let adminAdvances = [];
let adminUnsubscribers = [];
let adminSnapshotReady = new Set();
let adminPendingAction = null;
const adminDismissedPendingActionIds = new Set();
// Conserva los aliases históricos consultables con las reglas actuales.
// Una consulta OR entrega cada documento una sola vez y también sus cambios/bajas.
const OWNERSHIP_FIELDS = [
  "driverUid", "choferUid", "uid", "ownerUid", "driverId", "choferId",
  "userUid", "createdByUid"
];
let authGeneration = 0;
let dashboardLoad = null;
const dashboardRenderJobs = new Set();
let dashboardRenderFrame = null;
let selectedCloseDirection = "";
let selectedDriverClosePaymentMethod = "cash";
let selectedAdminClosureId = "";
const RECENT_RECEIPTS_LIMIT = 10;
const RECEIPTS_PAGE_SIZE = 10;
let visibleReceiptCount = RECENT_RECEIPTS_LIMIT;
let receiptSortOrder = "newest";
let pendingOperationPreview = null;
// Primera semana administrada por este selector. Desde aquí, toda semana
// cerrada sin comprobante permanece pendiente hasta que el chofer la cargue.
const UBER_TRACKING_START_DATE = "2026-09-07";
const ADVANCE_MAX_AMOUNT = 400000;
const ADVANCE_INTEREST_RATE = 0.40;
const ADVANCE_DIFFERENCE_LIMIT = 50000;
const EXPLORA_TRANSFER_ALIAS = "MP.explora";
const EXPLORA_CUIT = "20-40411688-7";
const EXPLORA_ADMIN_UIDS = new Set(); // Administrators are provisioned per project, never inherited by UID.
const ROOT_COLLECTIONS = Object.freeze({
  payments: "billing_records",
  expenses: "gastos",
  uber: "uber_weekly_closures",
  closures: "cierres_semanales",
  debts: "deudas_choferes",
  debtPayments: "deuda_pagos",
  advances: "prestamos_operativos"
});
const ADMIN_REQUIRED_SNAPSHOT_KEYS = new Set([
  "choferes",
  ROOT_COLLECTIONS.payments,
  ROOT_COLLECTIONS.expenses,
  ROOT_COLLECTIONS.uber,
  ROOT_COLLECTIONS.closures,
  ROOT_COLLECTIONS.debts,
  ROOT_COLLECTIONS.debtPayments,
  ROOT_COLLECTIONS.advances
]);
const TEAM_REALTIME_BALANCES_COLLECTION = "team_realtime_balances";
const PENDING_OPERATION_STORAGE_PREFIX = "explora_pending_operations_v1";
const PENDING_OPERATION_TTL_MS = 48 * 60 * 60 * 1000;
const pendingOperationFallback = new Map();
const activeSubmissionLocks = new Set();
const submissionPreviewBalances = new Map();
const submissionPreviewModels = new Map();

function operationStorageKey(kind, uid) {
  return `${PENDING_OPERATION_STORAGE_PREFIX}:${String(uid || "anonymous")}:${kind}`;
}

function safePendingRegistry(kind, uid) {
  const key = operationStorageKey(kind, uid);
  let registry = pendingOperationFallback.get(key) || {};
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored && typeof stored === "object" && !Array.isArray(stored)) registry = stored;
    }
  } catch (_) {}

  const now = Date.now();
  const fresh = Object.fromEntries(Object.entries(registry).filter(([, entry]) => (
    entry && typeof entry.operationId === "string" && Number(entry.expiresAtMs || 0) > now
  )));
  pendingOperationFallback.set(key, fresh);
  try { localStorage.setItem(key, JSON.stringify(fresh)); } catch (_) {}
  return fresh;
}

function savePendingRegistry(kind, uid, registry) {
  const key = operationStorageKey(kind, uid);
  pendingOperationFallback.set(key, registry);
  try { localStorage.setItem(key, JSON.stringify(registry)); } catch (_) {}
}

function randomOperationToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function reservePendingOperation(kind, uid, fingerprint) {
  const registry = safePendingRegistry(kind, uid);
  const current = registry[fingerprint];
  if (current?.operationId) return current;
  const createdAtMs = Date.now();
  const entry = {
    operationId: `${kind}_${randomOperationToken()}`,
    createdAtMs,
    expiresAtMs: createdAtMs + PENDING_OPERATION_TTL_MS
  };
  registry[fingerprint] = entry;
  savePendingRegistry(kind, uid, registry);
  return entry;
}

function clearPendingOperation(kind, uid, fingerprint, operationId) {
  const registry = safePendingRegistry(kind, uid);
  if (registry[fingerprint]?.operationId !== operationId) return;
  delete registry[fingerprint];
  savePendingRegistry(kind, uid, registry);
}

function fallbackHash(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

async function sha256Hex(input) {
  try {
    if (globalThis.crypto?.subtle) {
      const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    }
  } catch (_) {}
  const fallbackValue = typeof input === "string"
    ? input
    : Array.from(new Uint8Array(input)).join(",");
  return fallbackHash(fallbackValue);
}

async function buildSubmissionFingerprint(kind, fields) {
  const normalizedFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    typeof value === "string"
      ? value.trim().normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase("es-AR")
      : value
  ]));
  return `sha256_${await sha256Hex(JSON.stringify({ kind, fields:normalizedFields }))}`;
}

function acquireSubmissionLock(kind, capture = true) {
  if (activeSubmissionLocks.has(kind)) return false;
  activeSubmissionLocks.add(kind);
  if (capture) { // Preserve historical preview behavior for the remaining workflows.
    try { captureSubmissionBalance(kind); }
    catch (error) { activeSubmissionLocks.delete(kind); submissionPreviewBalances.delete(kind); submissionPreviewModels.delete(kind); throw error; }
  }
  return true;
}

function releaseSubmissionLock(kind) {
  activeSubmissionLocks.delete(kind);
  submissionPreviewBalances.delete(kind);
  submissionPreviewModels.delete(kind);
  scheduleDashboardRender();
}

function captureSubmissionBalance(kind) {
  const model = settlementModel();
  const balance = model.balance;
  if (activeSubmissionLocks.has(kind)) { submissionPreviewBalances.set(kind, balance); submissionPreviewModels.set(kind, {...model}); }
  return balance;
}

function previewSettlementBalance(kind) {
  // El listener puede recibir el alta mientras el formulario aún está abierto.
  // Conservamos su punto de partida para no volver a sumar la misma operación.
  return submissionPreviewBalances.get(kind) ?? settlementModel().balance;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function firebaseErrorCode(error) {
  return String(error?.code || error?.name || "").toLowerCase();
}

function isTransientFirebaseError(error) {
  const code = firebaseErrorCode(error);
  return [
    "unavailable",
    "deadline-exceeded",
    "aborted",
    "resource-exhausted",
    "internal",
    "unknown",
    "network-request-failed",
    "storage/retry-limit-exceeded",
    "storage/unknown",
    "storage/server-file-wrong-size"
  ].some(value => code.includes(value));
}

async function retryFirebaseOperation(task, attempts = 4) {
  const waits = [0, 650, 1500, 3000];
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (waits[attempt]) await delay(waits[attempt]);
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isTransientFirebaseError(error) || attempt >= attempts - 1) throw error;
    }
  }
  throw lastError;
}

async function runTransactionWithRetry(handler) {
  return retryFirebaseOperation(() => runTransaction(db, handler), 4);
}

async function confirmCommittedOperation(documentRef, operationId, fingerprint) {
  // Un dato local pendiente no equivale a una confirmación del servidor.
  // Una conexión inestable nunca debe anunciar como guardado un alta sin confirmar.
  const matchesOperation = snapshot => {
    if (!snapshot?.exists?.()) return false;
    if (snapshot.metadata?.hasPendingWrites || snapshot.metadata?.fromCache) return false;
    const data = snapshot.data() || {};
    return data.idempotencyKey === operationId && data.submissionFingerprint === fingerprint;
  };

  try {
    const localOrServerSnapshot = await getDoc(documentRef);
    if (matchesOperation(localOrServerSnapshot)) return true;
  } catch (_) {}

  // Si todavía no aparece, reintenta contra servidor durante unos segundos.
  // Nunca genera otro documento: siempre consulta el mismo operationId.
  const waits = [0, 500, 1200, 2200, 3800, 6000];
  for (const waitMs of waits) {
    if (waitMs) await delay(waitMs);
    try {
      const snapshot = await getDocFromServer(documentRef);
      if (matchesOperation(snapshot)) return true;
    } catch (_) {}
  }
  return false;
}

function assertSameCommittedOperation(snapshot, operationId, fingerprint) {
  if (!snapshot.exists()) return false;
  const data = snapshot.data() || {};
  if (data.idempotencyKey === operationId && data.submissionFingerprint === fingerprint) return true;
  const error = new Error("El identificador de la operación ya está ocupado por otro registro.");
  error.code = "operation-id-conflict";
  throw error;
}

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
  const grossAmount = recordAmount({ amount: item.grossAmount ?? item.totalAmount ?? item.amount ?? item.monto });
  const hasSplitAmounts = Object.prototype.hasOwnProperty.call(item, "cashAmount")
    || Object.prototype.hasOwnProperty.call(item, "uberCashAmount")
    || Object.prototype.hasOwnProperty.call(item, "transferAmount")
    || Object.prototype.hasOwnProperty.call(item, "uberTransferAmount");
  const cashAmount = hasSplitAmounts
    ? Math.max(0, Number(item.cashAmount ?? item.uberCashAmount ?? 0))
    : grossAmount;
  const transferAmount = hasSplitAmounts
    ? Math.max(0, Number(item.transferAmount ?? item.uberTransferAmount ?? item.digitalAmount ?? 0))
    : 0;
  return {
    ...item,
    id,
    amount: grossAmount,
    cashAmount,
    uberCashAmount: cashAmount,
    transferAmount,
    uberTransferAmount: transferAmount,
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

function uberGrossRevenueOf(item = {}) {
  return Math.max(0, Number(item.grossAmount ?? item.totalAmount ?? item.amount ?? item.monto ?? 0));
}

function uberHasSplitAmounts(item = {}) {
  return Object.prototype.hasOwnProperty.call(item, "cashAmount")
    || Object.prototype.hasOwnProperty.call(item, "uberCashAmount")
    || Object.prototype.hasOwnProperty.call(item, "transferAmount")
    || Object.prototype.hasOwnProperty.call(item, "uberTransferAmount");
}

function uberCashRevenueOf(item = {}) {
  return uberHasSplitAmounts(item)
    ? Math.max(0, Number(item.cashAmount ?? item.uberCashAmount ?? 0))
    : uberGrossRevenueOf(item);
}

function uberTransferRevenueOf(item = {}) {
  return uberHasSplitAmounts(item)
    ? Math.max(0, Number(item.transferAmount ?? item.uberTransferAmount ?? item.digitalAmount ?? 0))
    : 0;
}

function uberSettlementDelta(cashAmount = 0, transferAmount = 0) {
  return (Math.max(0, Number(cashAmount || 0)) * 0.55)
    - (Math.max(0, Number(transferAmount || 0)) * 0.50);
}

function uberUsesGrossCashRule(item = {}) {
  return item.settlementRuleVersion === "uber_gross_cash_cashbox_5_v1";
}
function uberGrossPrincipalDelta(records = []) {
  return records.filter(uberUsesGrossCashRule).reduce((sum, item) => sum + uberCashRevenueOf(item) * 0.50, 0);
}
function uberDriverSubmissionDelta(grossAmount = 0, item = {settlementRuleVersion:"uber_gross_cash_cashbox_5_v1"}) {
  return Math.max(0, Number(grossAmount || 0)) * (uberUsesGrossCashRule(item) ? 1.05 : 0.55);
}

function uberImpactsSettlement(item = {}) {
  const workflow = String(item.settlementWorkflowVersion || item.workflowVersion || "").toLowerCase();
  const status = String(item.reviewStatus || item.status || "").toLowerCase();
  if (workflow === "v85_verified_direct") return item.verifiedAutomatically === true && status === "completed";
  if (workflow === "v84_driver_submission_admin_review") {
    return item.adminConfirmed === true && /approved|confirmed|completed/.test(status);
  }
  if (workflow === "v82_admin_driver_confirmation") {
    return item.driverConfirmed === true && /approved|confirmed|completed/.test(status);
  }
  return !/reject|rechaz|cancel|anulad/.test(status);
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

function formatCuit(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? `${digits.slice(0,2)}-${digits.slice(2,10)}-${digits.slice(10)}` : String(value || "").trim() || "No informado";
}

function formatCuitInput(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 10) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

function ownedQuery(collectionName, uid = currentDriverUid()) {
  const fields = collectionName === ROOT_COLLECTIONS.uber ? ["driverUid"] : OWNERSHIP_FIELDS;
  return query(collection(db, collectionName), or(...fields.map(field => where(field, "==", uid))));
}

function createDashboardLoad(keys) {
  const ready = new Set(), cached = new Set(), errors = new Set(), pendingWrites = new Set();
  let resolve;
  const settled = new Promise(done => { resolve = done; });
  return {
    ready, cached, errors, pendingWrites, settled,
    complete: () => keys.every(key => ready.has(key)) && !errors.size,
    update(key, fromCache, error = false, hasPendingWrites = false) {
      if (error) { errors.add(key); resolve(); return; }
      errors.delete(key);
      if (hasPendingWrites) pendingWrites.add(key);
      else pendingWrites.delete(key);
      if (fromCache) cached.add(key);
      else { cached.delete(key); ready.add(key); }
      if (keys.every(item => ready.has(item))) resolve();
    }
  };
}

function scheduleDashboardRender(job = render) {
  dashboardRenderJobs.add(job);
  if (dashboardRenderFrame !== null) return;
  dashboardRenderFrame = window.requestAnimationFrame(() => {
    dashboardRenderFrame = null;
    flushDashboardRender();
  });
}

function flushDashboardRender() {
  if (dashboardRenderFrame !== null) window.cancelAnimationFrame(dashboardRenderFrame);
  dashboardRenderFrame = null;
  const jobs = [...dashboardRenderJobs];
  dashboardRenderJobs.clear();
  for (const update of jobs) update();
}

function cancelDashboardRender() {
  if (dashboardRenderFrame !== null) window.cancelAnimationFrame(dashboardRenderFrame);
  dashboardRenderFrame = null;
  dashboardRenderJobs.clear();
}

// Firestore avisa cuando todos los listeners afectados procesaron el cambio.
// Dibujamos saldo e historial juntos, sin esperar otro frame ni consultar otra vez.
onSnapshotsInSync(db, flushDashboardRender);

function resumeDashboard() {
  if (document.hidden || !auth.currentUser) return;
  if (typeof scheduleOperationalRecovery === "function") scheduleOperationalRecovery(1000);
  scheduleDashboardRender(isAdminProfile() ? renderAdminDashboardUpdates : render);
  scheduleDashboardRender(renderTeamRealtimeList);
  flushDashboardRender();
}
document.addEventListener("visibilitychange", resumeDashboard);
window.addEventListener("pageshow", resumeDashboard);
window.addEventListener("online", resumeDashboard);
window.addEventListener("offline", resumeDashboard);

function renderDriverLoadState() {
  const ready = dashboardLoad?.complete() === true;
  const failed = Boolean(dashboardLoad?.errors.size);
  const syncing = !ready || Boolean(dashboardLoad?.cached.size);
  const pending = Boolean(dashboardLoad?.pendingWrites.size);
  const offline = navigator.onLine === false;
  const recovering = typeof operationalRecoveryCacheGuard !== "undefined" && operationalRecoveryCacheGuard === dashboardLoad && !operationalLiveReady(dashboardLoad);
  $("syncStatus").textContent = failed ? "No se pudo sincronizar · recargá" : offline ? "Sin conexión" : pending ? "Guardando…" : syncing ? "Sincronizando…" : recovering ? "Sincronizado · recuperando conexión" : "En tiempo real";
  $("syncStatus").className = failed ? "sync bad" : syncing || pending || offline ? "sync" : "sync ok";
  $("driverBalanceCard").setAttribute("aria-busy", String(!ready));
  document.querySelectorAll("#driverQuickActions button").forEach(button => {
    const independent = button.id === "addExpenseBtn" || button.hasAttribute("data-mode");
    button.disabled = !ready && !independent;
  });
  if (!ready) {
    $("settlementDirection").textContent = failed ? "Revisá la conexión" : "Consultando tu saldo";
    $("settlementTotal").textContent = "—";
    $("settlementTotal").removeAttribute("aria-label");
    delete $("settlementTotal").dataset.moneyCurrent;
    $("driverBalanceBadge").textContent = failed ? "Reintentar" : "Actualizando";
    $("receiptCount").textContent = "";
    $("receiptList").innerHTML = `<div class="empty">${failed ? "No pudimos cargar los movimientos. Recargá para volver a intentar." : "Consultando tus movimientos…"}</div>`;
    $("receiptsToggle").classList.add("hidden");
  }
  return ready;
}

function subscribeOwnedRecords(user, { collectionName, normalizer, assign, afterRender }) {
  const load = dashboardLoad;
  const records = new Map();
  let active = true, received = false;
  const valid = () => active && dashboardLoad === load && auth.currentUser?.uid === user.uid;
  const stop = onSnapshot(ownedQuery(collectionName, user.uid), { includeMetadataChanges:true }, snap => {
    if (!valid()) return;
    if (typeof operationalRecoveryCacheGuard !== "undefined" && operationalRecoveryCacheGuard === load && snap.metadata.fromCache) return;
    if (typeof operationalDataEpoch !== "undefined") operationalDataEpoch++;
    if (!snap.metadata.fromCache && typeof operationalNativeReadyByLoad !== "undefined") {
      if (!operationalNativeReadyByLoad.has(load)) operationalNativeReadyByLoad.set(load,new Set());
      operationalNativeReadyByLoad.get(load).add(collectionName);
    }
    const changes = snap.docChanges();
    const changed = !received || changes.length > 0;
    const wasReady = load.complete();
    if (changed) {
      if (!received) {
        for (const row of snap.docs) records.set(row.id, normalizer(row.id, row.data()));
      } else {
        for (const change of changes) {
          if (change.type === "removed") records.delete(change.doc.id);
          else records.set(change.doc.id, normalizer(change.doc.id, change.doc.data()));
        }
      }
      assign([...records.values()].sort((a,b) => recordTimestampMs(b)-recordTimestampMs(a)));
    }
    received = true;
    load.update(collectionName, snap.metadata.fromCache, false, snap.metadata.hasPendingWrites);
    if (changed || wasReady !== load.complete()) scheduleDashboardRender();
    else scheduleDashboardRender(renderDriverLoadState);
    if (changed && afterRender) scheduleDashboardRender(afterRender);
  }, err => {
    if (!valid()) return;
    console.error(`Firestore ${collectionName} snapshot error:`, err);
    load.update(collectionName, false, true);
    if (typeof operationalNativeReadyByLoad !== "undefined") operationalNativeReadyByLoad.get(load)?.delete(collectionName);
    scheduleDashboardRender();
    scheduleOperationalRecovery();
  });
  return () => { active = false; stop(); };
}

function startSplash(message = "Ingresando…") {
  $("splashMessage").textContent = message;
  $("splashScreen")?.classList.remove("hidden");
  $("loginScreen")?.classList.add("hidden");
  $("app")?.classList.add("hidden");
}

function finishSplash(targetId) {
  $("loginScreen")?.classList.toggle("hidden", targetId !== "loginScreen");
  $("app")?.classList.toggle("hidden", targetId !== "app");
  $("splashScreen")?.classList.add("hidden");
}

startSplash("Abriendo Explora…");

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .catch(err => console.warn("No se pudo registrar el acceso directo:", err));
  });
}

const moneyFormatter = new Intl.NumberFormat("es-AR", {
  style: "currency", currency: "ARS", maximumFractionDigits: 0
});
const money = value => moneyFormatter.format(value || 0);
const signedMoney = value => {
  const numericValue = Number(value || 0);
  if (Math.abs(numericValue) < 0.5) return money(0);
  return `${numericValue > 0 ? "+" : "−"} ${money(Math.abs(numericValue))}`;
};
const moneyInputFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });

function moneyForElement(element, value) {
  return element?.dataset.moneyFormat === "signed" ? signedMoney(value) : money(value);
}

function setMoney(elementOrId, targetValue) {
  const element = typeof elementOrId === "string" ? $(elementOrId) : elementOrId;
  if (!element) return;
  const target = Number(targetValue || 0);
  const formatted = moneyForElement(element, target);
  // Siempre el importe exacto: sin interpolación ni lecturas que fuerzan layout.
  element.textContent = formatted;
  element.dataset.moneyCurrent = String(target);
  element.setAttribute("aria-label", formatted);
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

function directLoginEmails(usernameOrEmail) {
  const value = usernameOrEmail.trim().toLowerCase();
  if (value.includes("@")) return [value];
  const username = safeUsername(value);
  return [...new Set([
    LOGIN_ALIASES[value],
    username ? `${username}@${USER_EMAIL_DOMAIN}` : ""
  ].filter(Boolean))];
}

async function loginEmailCandidates(usernameOrEmail) {
  const candidates = directLoginEmails(usernameOrEmail);
  if (usernameOrEmail.includes("@")) return candidates;
  const username = safeUsername(usernameOrEmail.trim().toLowerCase());
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
  let timer;
  try {
    await Promise.race([authReady, new Promise(resolve => { timer = setTimeout(resolve, AUTH_READY_TIMEOUT_MS); })]);
  } finally { clearTimeout(timer); }
}

async function signInFromLogin(usernameOrEmail, password) {
  const candidates = directLoginEmails(usernameOrEmail);
  const attempted = new Set();
  let lastError = Object.assign(new Error("Faltan credenciales"), { code: "auth/invalid-credential" });
  // El usuario habitual entra directamente. Los aliases históricos se consultan
  // solo si fallan las credenciales directas, sin repetir un intento ya hecho.
  for (let pass = 0; pass < 2; pass += 1) {
    if (pass === 1) {
      if (usernameOrEmail.includes("@")) break;
      candidates.push(...await loginEmailCandidates(usernameOrEmail));
    }
    for (const email of candidates) {
      if (attempted.has(email)) continue;
      attempted.add(email);
      try {
        return await signInWithEmailAndPassword(auth, email, password);
      } catch (err) {
        lastError = err;
        if (!isCredentialError(err)) throw err;
      }
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
function isCashboxReceipt(item) {
  return item.type === "cashbox_receipt";
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
function digitalCashboxAmount(records = []) {
  return records
    .filter(item => !movementIsDeleted(item) && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .filter(item => item.method === "digital" && !cashboxIsExcluded(item))
    .filter(item => item.settlementRuleVersion === "gross_cash_digital_cashbox_5_v1")
    .reduce((sum, item) => sum + Number(item.amount || 0) * 0.05, 0);
}
function grossFlowPrincipalDelta(records = []) {
  // Legacy calculators already include 50% of each payment. New receipts add
  // the other 50% with the same sign; cashbox is counted separately, exactly once.
  return records
    .filter(item => !movementIsDeleted(item) && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .filter(item => item.settlementRuleVersion === "gross_cash_digital_cashbox_5_v1" && ["cash", "digital"].includes(item.method))
    .reduce((sum, item) => sum + Number(item.amount || 0) * (item.method === "cash" ? 0.50 : -0.50), 0);
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

// Gastos que participan de "Quién paga a quién".
// Se toman con la misma base de Facturación (no con el cierre independiente de Gastos),
// para que cerrar el módulo Gastos no borre el 50% que ya impactó en la liquidación.
function billingExpensesTotal() {
  const baseline = billingMigrationBaselineMs();
  return expenses
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline)
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

// IMPORTANTE · migración del 26/08/2026:
// Los gastos anteriores al cambio de "50% automático" NO pueden aplicarse de golpe
// a Facturación, porque algunos ya habían sido utilizados manualmente como reintegro.
// Las versiones v68+ dejan una fotografía del saldo en el propio gasto; además desde
// esta corrección guardamos marcadores explícitos. Así distinguimos con seguridad los
// gastos nuevos de los históricos sin depender de una hora fija de despliegue.
function expenseUsesAutomaticBilling50(item = {}) {
  if (item.receiptFlowVersion === "gross_expense_policy_v3") return true;
  if (item.autoApplyToBilling === true || item.gastoAuto50 === true) return true;
  if (String(item.billingImpactMode || "").toLowerCase() === "auto_50") return true;
  const hasAuto50Snapshot = Object.prototype.hasOwnProperty.call(item, "telegramSettlementBeforeBalance") ||
    Object.prototype.hasOwnProperty.call(item, "telegramSettlementAfterBalance") ||
    Object.prototype.hasOwnProperty.call(item, "telegramExpenseRecognizedAmount");
  return hasAuto50Snapshot;
}

function expenseRefundRate(item = {}) {
  return item.receiptFlowVersion === "gross_expense_policy_v3" ? ExploraExpensePolicy.refundRate(item) : 0.5;
}
function expenseNetDriverRate(item = {}) {
  if (item.receiptFlowVersion === "gross_expense_policy_v3") return 1 - expenseRefundRate(item);
  return item.receiptFlowVersion === "gross_expense_driver_debit_50_v2" ? 0.5 : -0.5;
}

function automaticExpenseBillingImpactTotal(sourceExpenses = expenses, baseline = billingMigrationBaselineMs()) {
  return sourceExpenses
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline)
    .filter(expenseUsesAutomaticBilling50)
    .reduce((sum, item) => sum - Number(item.amount || 0) * expenseNetDriverRate(item), 0);
}
function isAdminSettlementDebt(item = {}) {
  const type = String(item.type || item.debtType || "").toLowerCase();
  const role = String(item.createdByRole || item.registeredByRole || "").toLowerCase();
  const source = String(item.sourceModule || item.registrationOrigin || item.origin || "").toLowerCase();
  if (/uber_weekly/.test(source) || type === "uber_weekly") return false;
  return ExploraPeriodSettlement.isSelfDeclaredDebt(item) || type === "admin_debt" || role === "admin" || role === "administrador" || source === "admin_debt_menu";
}

// Desde esta versión, las deudas nuevas cargadas por Admin requieren confirmación
// explícita del chofer antes de impactar en "Quién paga a quién". Las deudas
// históricas no llevan este marcador y conservan exactamente su comportamiento.
function debtRequiresDriverConfirmation(item = {}) {
  return isAdminSettlementDebt(item) && item.driverConfirmationRequired === true;
}

function debtImpactsSettlement(item = {}) {
  return isAdminSettlementDebt(item)
    && (!debtRequiresDriverConfirmation(item) || item.acknowledgedByDriver === true);
}

function pendingDriverDebtConfirmations() {
  if (isAdminProfile()) return [];
  return debts
    .filter(item => !movementIsDeleted(item))
    .filter(item => Number(item.amount || 0) > 0.5)
    .filter(item => debtRequiresDriverConfirmation(item) && item.acknowledgedByDriver !== true)
    .sort((a, b) => recordTimestampMs(a) - recordTimestampMs(b));
}

function debtsTotal() {
  return debts
    .filter(item => !movementIsDeleted(item) && debtImpactsSettlement(item))
    .reduce((a,item)=>a+Number(item.amount||0),0);
}
function advanceRemaining(item) {
  const status = String(item.status || item.approvalStatus || "active").toLowerCase();
  if (/pending|solicit|reject|rechaz|cancel/.test(status)) return 0;
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

// Impacto histórico sobre Facturación. A diferencia del saldo disponible del módulo
// Gastos, este efecto debe sobrevivir a un cierre de Gastos y permanecer hasta el
// próximo cierre/base de Facturación.
function billingExpenseCompensationImpactTotal() {
  const baseline = billingMigrationBaselineMs();
  const legacyDebtOffsets = debtPayments
    .filter(item => recordTimestampMs(item) > baseline)
    .filter(item => item.expenseOffset === true)
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);

  const paymentCompensations = payments
    .filter(item => recordTimestampMs(item) > baseline)
    .filter(isReimbursementCompensation)
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0)), 0);

  return legacyDebtOffsets + paymentCompensations;
}

function latestReimbursementSettlementAnchor(sourcePayments = payments, baseline = billingMigrationBaselineMs()) {
  const anchors = sourcePayments
    .filter(item => !movementIsDeleted(item))
    .filter(isReimbursementCompensation)
    .map(item => ({
      item,
      timestamp: recordTimestampMs(item),
      settlementAfter: Number(item.settlementAfter)
    }))
    .filter(entry => entry.timestamp > baseline && Number.isFinite(entry.settlementAfter))
    .sort((a, b) => b.timestamp - a.timestamp);

  if (!anchors.length) return null;
  const latest = anchors[0];
  return {
    item: latest.item,
    timestamp: latest.timestamp,
    balance: Math.abs(latest.settlementAfter) > 0.5 ? latest.settlementAfter : 0,
    amount: Math.max(0, Number(latest.item.amount || latest.item.monto || 0))
  };
}

function settlementMovementDeltaSince(cutoffMs, sourcePayments = payments, sourceUber = uberClosures, sourceExpenses = expenses) {
  const scopedPayments = sourcePayments
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > cutoffMs);

  const cashRevenue = scopedPayments
    .filter(item => item.method === "cash" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const cashboxEligibleCash = scopedPayments
    .filter(item => item.method === "cash" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .filter(item => !cashboxIsExcluded(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const digitalRevenue = scopedPayments
    .filter(item => item.method === "digital" && !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const driverPaid = scopedPayments
    .filter(item => isSettlementAdjustment(item) && item.adjustmentDirection === "driver_to_explora")
    .reduce((sum, item) => sum + Math.max(0, Number(item.amount || 0) - Number(item.advanceRepaymentAmount || 0)), 0);

  const exploraPaid = scopedPayments
    .filter(item => isSettlementAdjustment(item) && item.adjustmentDirection === "explora_to_driver")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const scopedUber = sourceUber
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > cutoffMs)
    .filter(uberImpactsSettlement);
  const uberPrincipalExtra = uberGrossPrincipalDelta(scopedUber);
  const uberCashRevenue = scopedUber.reduce((sum, item) => sum + uberCashRevenueOf(item), 0);
  const uberTransferRevenue = scopedUber.reduce((sum, item) => sum + uberTransferRevenueOf(item), 0);
  const uberRevenue = uberCashRevenue + uberTransferRevenue;

  const cashBox = (cashboxEligibleCash + uberCashRevenue) * 0.05 + digitalCashboxAmount(scopedPayments);
  const automaticExpenseImpact = automaticExpenseBillingImpactTotal(sourceExpenses, cutoffMs);
  const delta = (cashRevenue * 0.50) + (uberCashRevenue * 0.50 + uberPrincipalExtra) + cashBox
    - (digitalRevenue * 0.50) - (uberTransferRevenue * 0.50)
    - automaticExpenseImpact - driverPaid + exploraPaid + grossFlowPrincipalDelta(scopedPayments);

  return {
    cashRevenue, digitalRevenue, uberRevenue, uberCashRevenue, uberTransferRevenue, cashBox, automaticExpenseImpact,
    driverPaid, exploraPaid, delta
  };
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
    !/reject|rechaz|cancel|anulad/.test(String(item.reviewStatus || item.status || "").toLowerCase())
    && (item.weekStartDate === week.weekStartDate
      || item.weekCloseDate === week.weekCloseDate
      || item.weekKey === week.weekKey
      || item.id === week.weekKey)
  );
}
function pendingUberWeeks(referenceDate = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Argentina/Buenos_Aires", year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(referenceDate);
  const part = type => parts.find(item => item.type === type).value;
  const today = parseLocalDateKey(part("year") + "-" + part("month") + "-" + part("day"));
  const monday = startOfUberWeek(today);
  // A Monday closure becomes available on Tuesday, never during the closing day.
  const start = addLocalDays(monday, today.getDay() === 1 ? -14 : -7);
  if (localDayKey(start) < UBER_TRACKING_START_DATE) return [];
  const week = buildUberWeek(start);
  return isUberWeekLoaded(week) ? [] : [week];
}

function selectedPendingUberWeek() {
  const selectedStart = $("uberWeekSelect")?.value || "";
  return pendingUberWeeks().find(week => week.weekStartDate === selectedStart) || null;
}

async function resolveUberSubmissionTarget(userUid, week, maxRevisions = 20) {
  const normalizedWeekId = String(week?.weekKey || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!userUid || !normalizedWeekId) throw new Error("No se pudo identificar la semana de Uber.");

  // No dependemos sólo del listener local: consultamos los IDs determinísticos
  // para distinguir un cierre ya existente de un verdadero error de permisos.
  // Si un intento fue rechazado, avanzamos a la siguiente revisión disponible.
  for (let revision = 1; revision <= maxRevisions; revision += 1) {
    const id = `uber_${userUid}_${normalizedWeekId}_v84_r${revision}`;
    const refDoc = doc(db, ROOT_COLLECTIONS.uber, id);
    const snap = await getDoc(refDoc);
    if (!snap.exists()) return { id, ref:refDoc, revision, blocked:false };

    const data = snap.data() || {};
    const state = String(data.reviewStatus || data.status || "").toLowerCase();
    if (/reject|rechaz|cancel|anulad/.test(state)) continue;

    return { id, ref:refDoc, revision, blocked:true, state, data };
  }

  throw new Error("Hay demasiados intentos anteriores para esta semana. David debe revisar el historial de Uber.");
}
function updateUberWeekSummary() {
  const week = selectedPendingUberWeek();
  const startLabel = $("uberWeekStartLabel");
  const endLabel = $("uberWeekEndLabel");
  const stateLabel = $("uberWeekStateLabel");
  if (!startLabel || !endLabel || !stateLabel) return;

  startLabel.textContent = week ? formatUberWeekDate(week.weekStartDate) : "—";
  endLabel.textContent = week ? formatUberWeekDate(week.weekCloseDate) : "—";
  stateLabel.textContent = week ? "Falta pedir" : "Al día";
}
function renderUberWeekSelector() {
  const select = $("uberWeekSelect");
  const notice = $("uberPendingNotice");
  const saveButton = $("saveUberBtn");
  if (!select || !notice || !saveButton) return;

  const pending = pendingUberWeeks();
  const previousValue = select.value;
  const hasPending = pending.length > 0;

  notice.classList.toggle("is-clear", !hasPending);
  if (hasPending) {
    notice.innerHTML = `<strong>${pending.length} ${pending.length === 1 ? "semana pendiente" : "semanas pendientes"}</strong><span>${pending.length === 1 ? "Cargá el total y el comprobante de esta semana." : "Los cierres atrasados se acumulan. Cargá uno por cada semana."}</span>`;
    select.innerHTML = pending
      .map(week => `<option value="${week.weekStartDate}">${week.label} · Falta pedir</option>`)
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
  saveButton.disabled = !hasPending;
  updateUberWeekSummary();
}
function renderUberPendingBadge() {
  const button = $("addUberBtn");
  const badge = $("uberPendingBadge");
  if (!button || !badge) return;
  const count = pendingUberWeeks().length;
  button.classList.toggle("hidden", count === 0 || dashboardLoad?.complete() !== true);
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
  button.classList.toggle("has-pending-alert", count > 0);
  button.title = count
    ? `${count} ${count === 1 ? "semana de Uber pendiente" : "semanas de Uber pendientes"}`
    : "No hay semanas de Uber pendientes";
}

setInterval(() => { if (auth.currentUser && !isAdminProfile()) renderUberPendingBadge(); }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && auth.currentUser && !isAdminProfile()) renderUberPendingBadge(); });

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

function billingMigrationBaselineMs() {
  // Conservamos exactamente el período abierto que ya existía en Santander Main.
  // Solo los cierres históricos `on_demand` anteriores a la migración fijan la base.
  // Los cierres nuevos usan `settlement_only`, por lo que NUNCA vuelven a reiniciar
  // la facturación: únicamente registran pagos/ajustes hasta llevar el saldo a cero.
  return lastBillingClosureMs();
}

function openBillingPayments() {
  const baseline = billingMigrationBaselineMs();
  return payments
    .filter(item => !movementIsDeleted(item))
    .filter(item => recordTimestampMs(item) > baseline);
}

function openCashboxAmount() {
  return settlementModel().cashBox;
}

function openExpenses() {
  const cutoff = lastExpensesClosureMs();
  return expenses.filter(item => recordTimestampMs(item) > cutoff);
}

// Billeteras espejo compensadas — regla operativa vigente:
// - En el cierre semanal de Uber, todo el dinero queda en poder del chofer.
// - Explora recibe el 50% del total y el 5% adicional de caja chica; el chofer conserva 45%.
// - Los cierres históricos que separaban efectivo/transferencia se siguen interpretando
//   con sus campos originales para no alterar saldos ya confirmados.
// - Los gastos históricos mantienen el porcentaje y el sentido de su versión.
// - Deudas y adelantos continúan como módulos separados.

// Modelo vigente: cobros menos gastos; Caja 10% del neto; remanente dividido por mitades.
// Los snapshots históricos se conservan como evidencia; no gobiernan el saldo vivo.
// - El saldo positivo identifica quién debe compensar; el negativo, quién recibe.
// - Ambas billeteras muestran siempre el mismo saldo con signos opuestos.
function settlementModel() {
  const model = ExploraPeriodSettlement.calculate({records:payments, expenses, uberWeeks:uberClosures, debts, closures});
  return {...model, advanceDebt:advancesOutstandingTotal(), advanceRepaidToday:advanceRepaymentAppliedTotal()};
}

function renderDriverNews(settlementBalance) {
  const card = $("driverNewsCard");
  const title = $("driverNewsTitle");
  const text = $("driverNewsText");
  if (!card || !title || !text) return;

  const balance = Number(settlementBalance || 0);
  const amount = Math.abs(balance);
  card.classList.remove("is-driver-owes", "is-explora-owes", "is-balanced");

  if (amount <= 0.5) {
    card.classList.add("is-balanced");
    title.textContent = "Todo está en orden";
    text.textContent = "Tu cuenta está equilibrada con Explora. Seguí así.";
    return;
  }

  if (balance > 0.5) {
    card.classList.add("is-driver-owes");
    title.textContent = "Estás en rojo";
    text.textContent = "Pedí a los pasajeros que paguen en digital o pedí un cierre para pagar tu deuda con efectivo sobrante en mano, alias o depósito.";
    return;
  }

  card.classList.add("is-explora-owes");
  title.textContent = "Estás en verde";
  text.textContent = "Priorizá cobrar en efectivo. También podés pedir un cierre para cobrar a Explora la deuda pendiente.";
}

function renderWalletStatus(elementId, settlementBalance) {
  const element = $(elementId);
  if (!element) return;

  renderDriverNews(settlementBalance);

  const differenceHint = $("settlementDifferenceHint");
  const amount = Math.abs(Number(settlementBalance || 0));

  element.classList.remove(
    "is-paying",
    "is-receiving",
    "is-balanced",
    "is-hidden-direction",
    "is-driver-owes",
    "is-explora-owes"
  );
  if (differenceHint) {
    differenceHint.classList.remove("is-driver-owes", "is-explora-owes", "is-balanced");
  }

  if (amount <= 0.5) {
    element.textContent = "Cuentas equilibradas";
    element.classList.add("is-balanced");
    if (differenceHint) {
      differenceHint.textContent = "Vos y Explora están equilibrados. No hay diferencia pendiente.";
      differenceHint.classList.add("is-balanced");
    }
    return;
  }

  if (settlementBalance > 0.5) {
    element.textContent = "Chofer debe";
    element.classList.add("is-driver-owes");
    if (differenceHint) {
      differenceHint.textContent = `Tenés ${money(amount)} más de tu lado que Explora. Esa diferencia corresponde a Explora.`;
      differenceHint.classList.add("is-driver-owes");
    }
    return;
  }

  element.textContent = "Explora debe";
  element.classList.add("is-explora-owes");
  if (differenceHint) {
    differenceHint.textContent = `Explora tiene ${money(amount)} más de su lado que vos. Esa diferencia te corresponde a vos.`;
    differenceHint.classList.add("is-explora-owes");
  }
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


function buildUnifiedReceipts(order = "newest") {
  const regularPayments = payments
    .filter(item => !movementIsDeleted(item))
    .map(item => ({ ...item, _receiptGroupKey:`payment:${item.id}`, _sortPriority: 2 }));

  // Cada cobro con caja chica muestra el ingreso y su 5% separado. El segundo se deriva del primero para
  // que una corrección o eliminación nunca deje valores huérfanos.
  const cashboxReceipts = regularPayments
    .filter(item => item.method === "cash" || (item.method === "digital" && item.settlementRuleVersion === "gross_cash_digital_cashbox_5_v1"))
    .filter(item => !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
    .filter(item => item.settlementRuleVersion !== ExploraPeriodSettlement.VERSION)
    .filter(item => !cashboxIsExcluded(item))
    .map(item => ({
      ...item,
      id: `${item.id}_cashbox_5`,
      type: "cashbox_receipt",
      service: "Caja chica 5%",
      detail: `A favor de Explora · Incluida en el cobro ${item.method === "cash" ? "en efectivo (en poder del chofer)" : "digital (recibido por Explora)"}${item.detail ? ` · ${item.detail}` : ""}`,
      amount: Number(item.amount || 0) * 0.05,
      _cashboxGrossAmount: Number(item.amount || 0),
      proofUrl: "",
      proofPath: "",
      _sortPriority: 1
    }));

  const debtReceipts = debts
    .filter(item => !movementIsDeleted(item) && debtImpactsSettlement(item))
    .map(item => ({
      ...item,
      method: "debt",
      type: "admin_debt",
      service: "Deuda agregada por Explora",
      amount: Number(item.totalAmount || item.originalAmount || item.amount || 0),
      detail: item.detail || item.reason || "Deuda del chofer",
      _sortPriority: 2
    }));

  const advanceReceipts = advances.map(item => {
    const state = String(item.approvalStatus || item.status || "active").toLowerCase();
    const pending = /pending/.test(state);
    const rejected = /reject|rechaz/.test(state);
    return {
      ...item,
      method: "advance",
      type: "cash_advance",
      amount: Number(item.principalAmount || item.originalAmount || item.amount || 0),
      service: pending ? "Adelanto solicitado" : rejected ? "Adelanto rechazado" : "Adelanto en efectivo",
      detail: pending
        ? `Pendiente de aprobación de Admin · Total si se aprueba: ${money(item.totalDebt)}`
        : rejected
          ? `Solicitud rechazada por Admin · Monto solicitado: ${money(item.principalAmount || item.originalAmount || item.amount || 0)}`
          : `Deuda con 40%: ${money(item.totalDebt)} · Saldo pendiente: ${money(advanceRemaining(item))}`,
      _sortPriority: 2
    };
  });

  const uberReceipts = uberClosures
    .filter(item => !movementIsDeleted(item))
    .filter(uberImpactsSettlement)
    .map(item => ({
      ...item,
      method:"cash",
      type:"billing",
      service:"Cobro en efectivo",
      amount:uberGrossRevenueOf(item),
      detail:"Movimiento histórico incorporado al efectivo",
      _receiptGroupKey:"legacy-cash:"+item.id,
      _sortPriority:2
    }));

  const expenseReceipts = expenses
    .filter(item => !movementIsDeleted(item))
    .flatMap(item => {
      const refundRate = expenseRefundRate(item);
      const expense = {
      ...item,
      _receiptGroupKey:`expense:${item.id}`,
      method: "expense",
      type: "expense_receipt",
      service: `Gasto · ${String(item.expenseLabel || item.detail || item.expenseType || "Varios").slice(0, 60)}`,
      detail: item.receiptFlowVersion === ExploraPeriodSettlement.VERSION ? `${item.detail || "Gasto"} · Descontado antes del reparto` : `${item.detail || "Gasto"} · ${refundRate ? `Reintegro ${refundRate * 100}%: ${money(Number(item.amount || 0) * refundRate)}` : "100% chofer · Sin reintegro"}`,
      _sortPriority: 2
      };
      if (!refundRate || !["gross_expense_reimbursement_50_v1","gross_expense_driver_debit_50_v2","gross_expense_policy_v3"].includes(item.receiptFlowVersion)) return [expense];
      return [expense, {
        ...expense,
        id:`${item.id}_reimbursement_${refundRate * 100}`,
        type:"expense_reimbursement_receipt",
        service:item.receiptFlowVersion === "gross_expense_policy_v3" ? `Reintegro de gasto · ${refundRate * 100}%` : "Reintegro de gasto",
        detail:`Explora devuelve el ${refundRate * 100}% de ${money(item.amount)} · ${item.detail || "Gasto"}`,
        amount:Number(item.amount || 0) * refundRate,
        _expenseGrossAmount:Number(item.amount || 0),
        proofUrl:"", proofPath:"",
        _sortPriority:1
      }];
    });

  return sortUnifiedReceipts([
    ...regularPayments,
    ...cashboxReceipts,
    ...debtReceipts,
    ...advanceReceipts,
    ...uberReceipts,
    ...expenseReceipts
  ], order);
}

function receiptGroupKey(item) {
  return item._receiptGroupKey || `${item.method || item.type}:${item.id}`;
}

function sortUnifiedReceipts(receipts, order = "newest") {
  return [...receipts].sort((a, b) => {
    const byDate = recordTimestampMs(a) - recordTimestampMs(b);
    if (byDate) return order === "oldest" ? byDate : -byDate;
    const byGroup = receiptGroupKey(a).localeCompare(receiptGroupKey(b));
    const byStep = Number(a._sortPriority || 0) - Number(b._sortPriority || 0);
    return byGroup || (order === "oldest" ? -byStep : byStep);
  });
}

function visibleReceiptRows(receipts, limit) {
  let end = Math.min(limit, receipts.length);
  while (end > 0 && end < receipts.length && receiptGroupKey(receipts[end - 1]) === receiptGroupKey(receipts[end])) end += 1;
  return receipts.slice(0, end);
}

function render() {
  if (!auth.currentUser || isAdminProfile()) return;
  if (!renderDriverLoadState()) {
    $("driverDashboard")?.classList.remove("has-period-statement");
    if ($("periodStatement")) $("periodStatement").innerHTML = "";
    return;
  }
  syncDriverDebtConfirmationModal();
  syncUberDriverConfirmationModal();
  const model = settlementModel();
  const receipts = buildUnifiedReceipts(receiptSortOrder);
  const visibleReceipts = visibleReceiptRows(receipts, Math.max(RECENT_RECEIPTS_LIMIT, visibleReceiptCount));

  setMoney("settlementTotal", Math.abs(model.balance));
  renderWalletStatus("settlementDirection", model.balance);
  $("settlementDirection").textContent = settlementPreviewCopy(model.balance).label;
  $("driverBalanceCard").dataset.state = model.balance > 0.5 ? "owing" : model.balance < -0.5 ? "receiving" : "balanced";
  $("driverBalanceBadge").textContent = model.balance > 0.5 ? "Por liquidar" : model.balance < -0.5 ? "A tu favor" : "Al día";
  $("receiptCount").textContent = receipts.length;

  const toggle = $("receiptsToggle");
  toggle.classList.toggle("hidden", visibleReceipts.length >= receipts.length);
  toggle.textContent = "Ver más movimientos";

  renderUberPendingBadge();
  if (!$("uberModal")?.classList.contains("hidden") && uberStep === 2) renderUberAccountPreview();
  renderPeriodStatement(model);
  renderList("receiptList", visibleReceipts);
  if (!$("chargeModal").classList.contains("hidden")) renderChargePreview();
  if (!$("managementModal").classList.contains("hidden")) renderManagementPreview();
  if (!$("expenseModal").classList.contains("hidden")) renderExpensePreview();
  window.setTimeout(maybeShowDriverDebtConfirmation, 0);
  window.setTimeout(maybeShowUberDriverConfirmation, 120);
}

function debtProofIsImage(item = {}) {
  const mime = String(item.proofMimeType || item.receiptMimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  if (mime === "application/pdf") return false;
  const path = String(item.proofPath || item.receiptPath || item.proofFileName || item.receiptFileName || item.proofUrl || "").toLowerCase();
  if (/\.pdf(?:$|[?#])/.test(path)) return false;
  return /\.(?:png|jpe?g|webp|gif|heic|heif)(?:$|[?#])/.test(path) || Boolean(item.proofUrl);
}

function settlementPreviewCopy(balance) {
  const value = Math.abs(Number(balance || 0)) < 0.005 ? 0 : Number(balance || 0);
  if (value > 0) return { label:"Debes a Explora", amount:value, tone:"driver" };
  if (value < 0) return { label:"Explora te debe", amount:Math.abs(value), tone:"explora" };
  return { label:"Cuenta al día", amount:0, tone:"balanced" };
}

let activeDriverDebtConfirmationId = "";
let acceptingDriverDebtConfirmation = false;

function closeDriverDebtConfirmationModal() {
  $("driverDebtConfirmationModal")?.classList.add("hidden");
  document.documentElement.classList.remove("driver-debt-modal-open");
  document.body.classList.remove("driver-debt-modal-open");
  activeDriverDebtConfirmationId = "";
  window.setTimeout(maybeShowUberDriverConfirmation, 100);
}

function syncDriverDebtConfirmationModal() {
  if (acceptingDriverDebtConfirmation || !activeDriverDebtConfirmationId) return;
  const modal = $("driverDebtConfirmationModal");
  if (!modal || modal.classList.contains("hidden")) return;
  const stillPending = pendingDriverDebtConfirmations().some(item => item.id === activeDriverDebtConfirmationId);
  if (!stillPending) closeDriverDebtConfirmationModal();
}

function renderDriverDebtConfirmation(item = {}) {
  const modal = $("driverDebtConfirmationModal");
  const body = $("driverDebtConfirmationBody");
  const accept = $("acceptDriverDebtBtn");
  const status = $("driverDebtConfirmationStatus");
  if (!modal || !body || !accept || !status || !item?.id) return;

  const amount = Math.max(0, Number(item.totalAmount || item.originalAmount || item.amount || 0));
  const currentBalance = Number(settlementModel().balance || 0);
  const afterBalance = currentBalance + amount;
  const before = settlementPreviewCopy(currentBalance);
  const after = settlementPreviewCopy(afterBalance);
  const concept = String(item.detail || item.reason || item.notes || "Deuda agregada por Explora").trim();
  const proofUrl = String(item.proofUrl || item.receiptUrl || "");
  const imageProof = proofUrl && debtProofIsImage(item);

  activeDriverDebtConfirmationId = item.id;
  acceptingDriverDebtConfirmation = false;
  status.textContent = "";
  status.className = "status driver-debt-confirmation-status";
  accept.disabled = false;
  accept.textContent = "Aceptar deuda";

  body.innerHTML = `
    <div class="driver-debt-alert-badge">Explora agregó una deuda</div>
    <div class="driver-debt-confirmation-amount">${money(amount)}</div>
    <div class="driver-debt-confirmation-concept"><span>Concepto</span><strong>${escapeHtml(concept)}</strong></div>
    ${proofUrl ? (imageProof
      ? `<button type="button" class="driver-debt-confirmation-proof" data-proof-preview="${escapeHtml(proofUrl)}" data-proof-alt="Comprobante de ${escapeHtml(concept)}" aria-label="Ampliar comprobante de deuda"><img src="${escapeHtml(proofUrl)}" alt="Comprobante de ${escapeHtml(concept)}"></button>`
      : `<a class="driver-debt-confirmation-proof-link" target="_blank" rel="noopener" href="${escapeHtml(proofUrl)}">Abrir comprobante adjunto</a>`)
      : `<div class="driver-debt-confirmation-proof-missing">Comprobante no disponible.</div>`}
    <div class="driver-debt-balance-grid" aria-label="Saldo antes y después de aceptar la deuda">
      <div class="driver-debt-balance-card is-${before.tone}">
        <span>Ahora</span>
        <strong>${escapeHtml(before.label)}</strong>
        <b>${money(before.amount)}</b>
      </div>
      <div class="driver-debt-balance-card is-${after.tone}">
        <span>Después de aceptar</span>
        <strong>${escapeHtml(after.label)}</strong>
        <b>${money(after.amount)}</b>
      </div>
    </div>
    <p class="driver-debt-confirmation-note">Al tocar “Aceptar deuda”, este importe se incorporará al saldo con Explora y aparecerá abajo como comprobante.</p>`;

  modal.classList.remove("hidden");
  document.documentElement.classList.add("driver-debt-modal-open");
  document.body.classList.add("driver-debt-modal-open");
  window.setTimeout(() => accept.focus({ preventScroll:true }), 60);
}

function maybeShowDriverDebtConfirmation() {
  if (!auth.currentUser || isAdminProfile() || acceptingDriverDebtConfirmation) return;
  const modal = $("driverDebtConfirmationModal");
  if (!modal) return;
  if (!modal.classList.contains("hidden")) return;

  const anotherModalOpen = Array.from(document.querySelectorAll(".modal:not(.hidden)"))
    .some(node => node.id !== "driverDebtConfirmationModal");
  if (anotherModalOpen) return;

  const pending = pendingDriverDebtConfirmations();
  if (pending.length) renderDriverDebtConfirmation(pending[0]);
}

async function acceptDriverDebtConfirmation() {
  if (acceptingDriverDebtConfirmation || !activeDriverDebtConfirmationId || isAdminProfile()) return;
  const user = auth.currentUser;
  const item = debts.find(row => row.id === activeDriverDebtConfirmationId);
  const accept = $("acceptDriverDebtBtn");
  const status = $("driverDebtConfirmationStatus");
  if (!user || !item || !debtRequiresDriverConfirmation(item)) {
    closeDriverDebtConfirmationModal();
    acceptingDriverDebtConfirmation = false;
    window.setTimeout(maybeShowDriverDebtConfirmation, 0);
    return;
  }

  acceptingDriverDebtConfirmation = true;
  accept.disabled = true;
  accept.textContent = "Confirmando…";
  status.textContent = "Guardando aceptación…";
  status.className = "status driver-debt-confirmation-status";

  try {
    await setDoc(doc(db, ROOT_COLLECTIONS.debts, item.id), {
      acknowledgedByDriver: true,
      acknowledgedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge:true });

    item.acknowledgedByDriver = true;
    status.textContent = "Deuda aceptada y sumada al saldo.";
    status.className = "status success driver-debt-confirmation-status";
    accept.textContent = "Aceptada ✓";
    render();
    window.setTimeout(() => {
      closeDriverDebtConfirmationModal();
      acceptingDriverDebtConfirmation = false;
      window.setTimeout(maybeShowDriverDebtConfirmation, 120);
    }, 700);
  } catch (err) {
    console.error("No se pudo aceptar la deuda:", err);
    acceptingDriverDebtConfirmation = false;
    accept.disabled = false;
    accept.textContent = "Aceptar deuda";
    status.textContent = "No se pudo confirmar. Revisá la conexión e intentá nuevamente.";
    status.className = "status error driver-debt-confirmation-status";
  }
}

$("acceptDriverDebtBtn")?.addEventListener("click", acceptDriverDebtConfirmation);

let activeUberDriverConfirmationId = "";
let acceptingUberDriverConfirmation = false;

function uberAdminDecisionStorageKey(item = {}) {
  const uid = auth.currentUser?.uid || "anonymous";
  const revision = Number(item.approvedAtMs || item.rejectedAtMs || item.updatedAtMs || 0);
  return `explora_uber_admin_decision_v84:${uid}:${item.id || "unknown"}:${revision}`;
}

function uberAdminDecisionWasSeen(item = {}) {
  try {
    return localStorage.getItem(uberAdminDecisionStorageKey(item)) === "seen";
  } catch (_) {
    return false;
  }
}

function pendingUberDriverConfirmations() {
  return uberClosures
    .filter(item => String(item.settlementWorkflowVersion || "").toLowerCase() === "v84_driver_submission_admin_review")
    .filter(item => /approved|rejected/.test(String(item.reviewStatus || item.status || "").toLowerCase()))
    .filter(item => !uberAdminDecisionWasSeen(item))
    .sort((a, b) => recordTimestampMs(a) - recordTimestampMs(b));
}

function closeUberDriverConfirmationModal() {
  $("uberDriverConfirmationModal")?.classList.add("hidden");
  activeUberDriverConfirmationId = "";
  window.setTimeout(maybeShowUberDriverConfirmation, 100);
}

function syncUberDriverConfirmationModal() {
  if (acceptingUberDriverConfirmation || !activeUberDriverConfirmationId) return;
  const modal = $("uberDriverConfirmationModal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (!pendingUberDriverConfirmations().some(item => item.id === activeUberDriverConfirmationId)) {
    closeUberDriverConfirmationModal();
  }
}

function renderUberDriverConfirmation(item = {}) {
  const modal = $("uberDriverConfirmationModal");
  const body = $("uberDriverConfirmationBody");
  const button = $("confirmUberDriverResult");
  const status = $("uberDriverConfirmationStatus");
  if (!modal || !body || !button || !status || !item.id) return;

  const review = String(item.reviewStatus || item.status || "").toLowerCase();
  const approved = /approved|confirmed|completed/.test(review) && item.adminConfirmed === true;
  const amount = uberGrossRevenueOf(item);
  const exploraShare = amount * 0.50;
  const cashboxAmount = amount * 0.05;
  const driverShare = amount * 0.45;
  const isNetPeriod = item.settlementRuleVersion === ExploraPeriodSettlement.VERSION;
  const impact = isNetPeriod ? Number(item.settlementImpact || 0) : uberDriverSubmissionDelta(amount, item);
  const storedAfter = Number(item.telegramSettlementAfterBalance ?? item.settlementAfterAdminDecision);
  const afterBalance = Number.isFinite(storedAfter)
    ? normalizedSettlementBalance(storedAfter)
    : settlementModel().balance;
  const storedBefore = Number(item.telegramSettlementBeforeBalance ?? item.settlementBeforeAdminDecision);
  const beforeBalance = Number.isFinite(storedBefore)
    ? normalizedSettlementBalance(storedBefore)
    : normalizedSettlementBalance(approved ? afterBalance - impact : afterBalance);
  const before = settlementState(beforeBalance, "before");
  const after = settlementState(afterBalance, "now");
  const proofUrl = recordProofUrl(item);

  activeUberDriverConfirmationId = item.id;
  acceptingUberDriverConfirmation = false;
  status.textContent = "";
  status.className = "status";
  button.disabled = false;
  button.textContent = "Entendido";
  $("uberDriverConfirmationTitle").textContent = approved ? "Cierre de Uber confirmado" : "Cierre de Uber rechazado";
  body.innerHTML = `
    <div class="uber-driver-confirmation-week">Semana ${escapeHtml(uberWeekLabelForItem(item))}</div>
    ${proofUrl ? `<button type="button" class="uber-driver-proof" data-proof-preview="${escapeHtml(proofUrl)}" data-proof-alt="Comprobante semanal de Uber">Ver comprobante de Uber</button>` : ""}
    <div class="uber-decision-title ${approved ? "uber-decision-approved" : "uber-decision-rejected"}">${approved ? "David verificó y confirmó el cierre" : "David rechazó el comprobante"}</div>
    <div class="uber-driver-result-grid">
      <div><span>Ganancias verificadas</span><b>${money(amount)}</b></div>
      ${isNetPeriod ? `<div><span>Destino del dinero</span><b>${item.moneyHolder === "explora" ? "Explora" : "Chofer"}</b></div>
        <div><span>Impacto en la liquidación</span><b>${signedMoney(impact)}</b></div>
        <div><span>Regla del período</span><b>Gastos → Caja 10% → reparto 50/50</b></div>` : `
        <div><span>${uberUsesGrossCashRule(item) ? "Importe completo" : "Explora 50%"}</span><b>${money(uberUsesGrossCashRule(item) ? amount : exploraShare)}</b></div>
        <div><span>Caja chica histórica 5%</span><b>${money(cashboxAmount)}</b></div>
        <div><span>Impacto histórico</span><b>${money(impact)}</b></div>`}

    </div>
    <div class="uber-driver-balance-comparison">
      <div class="is-${before.payer}"><small>SALDO ANTERIOR</small><span>${escapeHtml(before.label)}</span><strong>${money(before.amount)}</strong></div>
      <div class="uber-driver-balance-arrow" aria-hidden="true">↓</div>
      <div class="is-${after.payer}"><small>${approved ? "SALDO ACTUAL" : "SALDO SIN CAMBIOS"}</small><span>${escapeHtml(after.label)}</span><strong>${money(after.amount)}</strong></div>
    </div>
    <p class="uber-driver-confirmation-note">${approved ? "El cierre ya fue aplicado y el comprobante quedó guardado en tu historial." : `${escapeHtml(item.rejectionReason || "El comprobante no pudo verificarse.")} Podés volver a cargar esta semana con una imagen correcta.`}</p>`;
  modal.classList.remove("hidden");
}

function maybeShowUberDriverConfirmation() {
  return; // Uber no longer exists as a new operational category. Historical rows remain internal.
  if (!auth.currentUser || isAdminProfile() || acceptingUberDriverConfirmation) return;
  const modal = $("uberDriverConfirmationModal");
  if (!modal || !modal.classList.contains("hidden")) return;
  const anotherModalOpen = Array.from(document.querySelectorAll(".modal:not(.hidden)"))
    .some(node => node.id !== "uberDriverConfirmationModal");
  if (anotherModalOpen) return;
  const pending = pendingUberDriverConfirmations();
  if (pending.length) renderUberDriverConfirmation(pending[0]);
}

function confirmUberDriverResult() {
  if (acceptingUberDriverConfirmation || !activeUberDriverConfirmationId || isAdminProfile()) return;
  const item = uberClosures.find(row => row.id === activeUberDriverConfirmationId);
  if (!item) return;
  acceptingUberDriverConfirmation = true;
  try {
    localStorage.setItem(uberAdminDecisionStorageKey(item), "seen");
  } catch (_) {}
  closeUberDriverConfirmationModal();
  acceptingUberDriverConfirmation = false;
}

$("confirmUberDriverResult")?.addEventListener("click", confirmUberDriverResult);


function ensureProofImageViewer() {
  let viewer = $("proofImageViewer");
  if (viewer) return viewer;

  viewer = document.createElement("div");
  viewer.id = "proofImageViewer";
  viewer.className = "proof-image-viewer hidden";
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-modal", "true");
  viewer.setAttribute("aria-label", "Comprobante ampliado");
  viewer.innerHTML = `
    <button type="button" class="proof-image-viewer-close" aria-label="Cerrar comprobante">×</button>
    <div class="proof-image-viewer-stage">
      <img class="proof-image-viewer-img" alt="Comprobante ampliado">
    </div>`;
  document.body.appendChild(viewer);

  const close = () => closeProofImageViewer();
  viewer.querySelector(".proof-image-viewer-close")?.addEventListener("click", close);
  viewer.addEventListener("click", event => {
    if (event.target === viewer || event.target?.classList?.contains("proof-image-viewer-stage")) close();
  });
  return viewer;
}

function openProofImageViewer(url, alt = "Comprobante ampliado") {
  const safeUrl = String(url || "").trim();
  if (!safeUrl) return;
  const viewer = ensureProofImageViewer();
  const img = viewer.querySelector(".proof-image-viewer-img");
  if (!img) return;

  img.src = safeUrl;
  img.alt = String(alt || "Comprobante ampliado");
  viewer.classList.remove("hidden");
  document.documentElement.classList.add("proof-image-viewer-open");
  document.body.classList.add("proof-image-viewer-open");
  window.setTimeout(() => viewer.querySelector(".proof-image-viewer-close")?.focus({ preventScroll:true }), 30);
}

function closeProofImageViewer() {
  const viewer = $("proofImageViewer");
  if (!viewer || viewer.classList.contains("hidden")) return;
  viewer.classList.add("hidden");
  document.documentElement.classList.remove("proof-image-viewer-open");
  document.body.classList.remove("proof-image-viewer-open");
  const img = viewer.querySelector(".proof-image-viewer-img");
  if (img) img.removeAttribute("src");
}

document.addEventListener("click", event => {
  const trigger = event.target?.closest?.("[data-proof-preview]");
  if (!trigger) return;
  event.preventDefault();
  event.stopPropagation();
  openProofImageViewer(trigger.getAttribute("data-proof-preview"), trigger.getAttribute("data-proof-alt") || "Comprobante ampliado");
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeProofImageViewer();
});

function receiptFooterLabel(item = {}) {
  if (isUberReceipt(item)) return `Semana ${escapeHtml(uberWeekLabelForItem(item))}`;
  if (isCashAdvance(item)) {
    const state = String(item.approvalStatus || item.status || "").toLowerCase();
    if (/pending/.test(state)) return "Pendiente de Admin";
    if (/reject|rechaz/.test(state)) return "Rechazado";
    return advanceRemaining(item) <= 0.5 ? "Adelanto pagado" : "Sin vencimiento";
  }
  const timestamp = recordTimestampMs(item);
  if (!timestamp) return "Ahora";
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("es-AR", { hour:"2-digit", minute:"2-digit" });
  return recordDayKey(item) === localDayKey()
    ? `Hoy · ${time}`
    : `${date.toLocaleDateString("es-AR", { day:"2-digit", month:"2-digit", year:"2-digit" })} · ${time}`;
}

// Historical balances must come from the operation's saved snapshot. Never
// backfill old receipts from today's balance or count the cashbox detail twice.
function receiptBalanceSnapshot(item = {}) {
  if (item.type === "cash_advance" || Number(item.amountCorrectionCount || 0) > 0 || cashboxIsExcluded(item)) return null;
  const before = item.telegramSettlementBeforeBalance ?? item.settlementBeforeAdminDecision;
  const after = item.telegramSettlementAfterBalance ?? item.settlementAfterAdminDecision;
  const valid = value => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
  if (!valid(before) || !valid(after)) return null;
  let start = Number(before), finish = Number(after);
  const currentFlow = item.settlementRuleVersion === "gross_cash_digital_cashbox_5_v1";
  if (uberUsesGrossCashRule(item) && item.method === "uber") {
    const principal = Number(item.type === "cashbox_receipt" ? item._cashboxGrossAmount : item.amount);
    if (!Number.isFinite(principal)) return null;
    if (item.type === "cashbox_receipt") start += principal;
    else finish = start + principal;
  } else if (currentFlow && ["cash", "digital"].includes(item.method) && !isSettlementAdjustment(item) && !isReimbursementCompensation(item)) {
    const principal = Number(item.type === "cashbox_receipt" ? item._cashboxGrossAmount : item.amount);
    if (!Number.isFinite(principal)) return null;
    const intermediate = start + principal * (item.method === "cash" ? 1 : -1);
    if (item.type === "cashbox_receipt") start = intermediate;
    else finish = intermediate;
  } else if (["gross_expense_reimbursement_50_v1","gross_expense_driver_debit_50_v2","gross_expense_policy_v3"].includes(item.receiptFlowVersion) && ["expense_receipt", "expense_reimbursement_receipt"].includes(item.type)) {
    const grossExpense = Number(item.type === "expense_reimbursement_receipt" ? item._expenseGrossAmount : item.amount);
    if (!Number.isFinite(grossExpense)) return null;
    const intermediate = start + grossExpense * (item.receiptFlowVersion === "gross_expense_reimbursement_50_v1" ? -1 : 1);
    if (item.type === "expense_reimbursement_receipt") start = intermediate;
    else finish = intermediate;
  } else if (item.type === "cashbox_receipt") return null;
  return { before:start, after:finish, movementImpact:finish - start };
}

function receiptBalanceLabel(value) {
  const state = settlementPreviewCopy(value);
  return `${state.label}${state.amount ? ` ${money(state.amount)}` : ""}`;
}

function renderList(containerId, items) {
  const box = $(containerId);
  if (!items.length) {
    box.innerHTML = `<div class="driver-empty"><span aria-hidden="true">↗</span><strong>Tu historial empieza acá</strong><p>Registrá un cobro o un gasto para ver tus movimientos.</p></div>`;
    return;
  }

  box.innerHTML = items.map(item => {
    const uberReceipt = isUberReceipt(item);
    const debtCompensation = isReimbursementCompensation(item);
    const cashAdvance = isCashAdvance(item);
    const expenseReceipt = isExpenseReceipt(item);
    const expenseReimbursement = item.type === "expense_reimbursement_receipt";
    const cashboxReceipt = isCashboxReceipt(item);
    const adminDebt = isAdminDebt(item);
    const digitalReceipt = item.method === "digital" && !isSettlementAdjustment(item) && !cashboxReceipt && !debtCompensation && !cashAdvance && !adminDebt;
    const regularCashReceipt = item.method === "cash"
      && !isSettlementAdjustment(item)
      && !adminDebt
      && !debtCompensation
      && !cashAdvance
      && !expenseReceipt
      && !uberReceipt
      && !cashboxReceipt;
    const proofUrl = String(item.proofUrl || item.receiptUrl || "");
    const imageProof = proofUrl && debtProofIsImage(item);
    const proofLabel = cashboxReceipt
      ? "Caja chica"
      : regularCashReceipt
        ? "Cobro en efectivo"
        : debtCompensation
          ? "Comprobante interno"
          : cashAdvance
            ? (/pending/.test(String(item.approvalStatus || item.status || "").toLowerCase()) ? "Esperando Admin" : /reject|rechaz/.test(String(item.approvalStatus || item.status || "").toLowerCase()) ? "Rechazado" : "Aprobado")
            : adminDebt
              ? "Deuda agregada"
              : digitalReceipt
                ? "Cobro digital"
                : expenseReceipt
                  ? "Gasto"
                  : uberReceipt
                    ? "Uber"
                    : isSettlementAdjustment(item)
                      ? (item.internalManagement ? "Gestión" : "Cierre")
                      : "Operación registrada";
    const proof = regularCashReceipt || digitalReceipt
      ? documentButton(item,"invoice",statementInvoices)
      : proofUrl || item.proofPath || item.receiptPdfPath
        ? documentButton(item,expenseReceipt ? "expense" : uberReceipt ? "uber" : adminDebt ? "debt" : cashAdvance ? "advance" : "management",statementInvoices)
        : `<span class="proof internal-proof">${escapeHtml(proofLabel)}</span>`;

    const icon = cashboxReceipt
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="2"/><circle cx="16" cy="16" r="2"/><path d="M7 17 17 7"/></svg>`
      : expenseReceipt
        ? `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`
        : uberReceipt
          ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16h14M7 16l1-5h8l1 5M8 11l1.2-3h5.6l1.2 3M6.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/></svg>`
          : debtCompensation
            ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12 4 4 8-9M5 20h14"/></svg>`
            : cashAdvance
              ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M7 7.5h7.2a3 3 0 0 1 0 6H9.8a3 3 0 0 0 0 6H17"/></svg>`
              : adminDebt
                ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M12 19h.01M5 21h14L12 3 5 21Z"/></svg>`
                : digitalReceipt
                  ? `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>`
                  : isSettlementAdjustment(item)
                    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/></svg>`
                    : `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><ellipse cx="12" cy="12" rx="3" ry="4"/><path d="M5 8h.01M19 16h.01"/></svg>`;

    const receiptToneClass = expenseReimbursement ? "receipt-tone-cash" : expenseReceipt
      ? "receipt-tone-expense"
      : uberReceipt
        ? "receipt-tone-uber"
        : (cashboxReceipt || regularCashReceipt)
          ? "receipt-tone-cash"
          : digitalReceipt
            ? "receipt-tone-digital"
            : "receipt-tone-other";

    const snapshot = receiptBalanceSnapshot(item);
    const impact = snapshot?.movementImpact || 0;
    const currentRule = item.settlementRuleVersion === "gross_cash_digital_cashbox_5_v1";
    const title = cashboxReceipt && currentRule ? `Caja ${item.method === "cash" ? "efectivo" : "digital"} · 5%` : regularCashReceipt ? "Cobro en efectivo" : digitalReceipt ? "Cobro digital" : item.service || proofLabel;
    const strip = snapshot
      ? `<div class="movement-balances" aria-label="Saldo histórico de esta operación">
          <div><span>Antes</span><p>${escapeHtml(receiptBalanceLabel(snapshot.before))}</p></div>
          <div><span>Impacto</span><strong class="${expenseReceipt ? "negative" : expenseReimbursement ? "positive" : impact > 0 ? "positive" : impact < 0 ? "negative" : "neutral"}">${impact > 0 ? "+" : impact < 0 ? "−" : ""}${money(Math.abs(impact))}</strong></div>
          <div><span>Después</span><p>${escapeHtml(receiptBalanceLabel(snapshot.after))}</p></div>
        </div>`
      : `<div class="movement-no-snapshot"><span>${cashboxReceipt ? "Incluida en el cobro · a favor de Explora" : cashAdvance ? "Adelanto · cuenta separada" : "Saldo histórico no disponible"}</span><strong>${money(item.amount)}</strong></div>`;
    return `<article class="movement-card ${receiptToneClass}" data-movement-color="${movementColor(item, {expensePolicy:ExploraExpensePolicy})}">
      <details class="movement-details">
        <summary><span class="movement-icon">${icon}</span><span class="movement-copy"><strong>${escapeHtml(title)}</strong></span><span class="movement-date">${receiptFooterLabel(item)}</span><span class="movement-chevron" aria-hidden="true">›</span></summary>
        <div class="movement-attachment"><p>${escapeHtml(item.detail || "Operación registrada")}</p>${currentRule && !cashboxIsExcluded(item) && (regularCashReceipt || digitalReceipt) ? `<p>El 100% ${regularCashReceipt ? "del efectivo queda en poder del chofer y suma al saldo" : "del digital lo recibe Explora y resta del saldo"}. La caja chica de 5% se suma una sola vez, en la tarjeta siguiente.</p>` : ""}${proof}${snapshot ? `<small>Saldo positivo: el chofer debe a Explora. Saldo negativo: Explora debe al chofer. Los importes muestran el paso histórico de esta tarjeta.</small>` : ""}</div>
      </details>${strip}
    </article>`;
  }).join("");
}

$("receiptsToggle")?.addEventListener("click", () => {
  visibleReceiptCount += RECEIPTS_PAGE_SIZE;
  render();
});

$("receiptSort")?.addEventListener("change", event => {
  receiptSortOrder = event.target.value;
  visibleReceiptCount = RECENT_RECEIPTS_LIMIT;
  render();
});

let driverProfileOpener = null;
function openDriverProfile(opener) {
  if (!auth.currentUser || isAdminProfile()) return;
  driverProfileOpener = opener;
  $("driverProfileName").textContent = currentProfile?.displayName || auth.currentUser.displayName || "Conductor";
  $("driverProfileModal").classList.remove("hidden");
  $("driverProfileModal").querySelector("[data-close]").focus();
}
$("driverProfileBtn")?.addEventListener("click", event => openDriverProfile(event.currentTarget));
const tripCalendar = mountTripCalendar({
  getUser: () => auth.currentUser ? {uid:auth.currentUser.uid,name:currentDriverName(),isAdmin:isAdminProfile()} : null,
  listenMonth(month, onRows, onError) {
    const {start,end} = monthRange(month);
    return onSnapshot(query(collection(db,"trip_calendar"),
      where("serviceDate",">=",start),where("serviceDate","<",end),orderBy("serviceDate")),
      {includeMetadataChanges:true}, snapshot => onRows(snapshot.docs.map(item => ({
        ...item.data(),id:item.id,pending:item.metadata.hasPendingWrites
      })),{fromCache:snapshot.metadata.fromCache}),onError);
  },
  async saveTrip(input) {
    const user = auth.currentUser;
    if (!user) throw new Error("Iniciá sesión para agendar.");
    const driverName = currentDriverName().slice(0,120);
    const draft = normalizeTripDraft(input);
    const fingerprint = await buildSubmissionFingerprint("calendar",draft);
    const operation = reservePendingOperation("calendar",user.uid,fingerprint);
    const target = doc(db,"trip_calendar",operation.operationId);
    await runTransaction(db,async transaction => {
      const existing = await transaction.get(target);
      if (existing.exists() && existing.data().driverUid !== user.uid) throw new Error("Viaje de otro chofer.");
      if (assertSameCommittedOperation(existing,operation.operationId,fingerprint)) return;
      transaction.set(target,{
        version:"trip_calendar_v1",driverUid:user.uid,driverName,...draft,
        idempotencyKey:operation.operationId,submissionFingerprint:fingerprint,createdAt:serverTimestamp()
      });
    });
    clearPendingOperation("calendar",user.uid,fingerprint,operation.operationId);
  },
  async setTripDeleted(id, deleted) {
    const user = auth.currentUser && {uid:auth.currentUser.uid,isAdmin:isAdminProfile()};
    if (!user || typeof id !== "string" || !id || id.includes("/")) throw new Error("Viaje inválido.");
    return runTransaction(db,async transaction => {
      const target=doc(db,"trip_calendar",id),snapshot=await transaction.get(target);
      if (!snapshot.exists()) {
        if (deleted) return false;
        throw new Error("El viaje ya no está disponible.");
      }
      const trip=snapshot.data();
      if (!canManageTrip(trip,user)) throw Object.assign(new Error("No podés modificar este viaje."),{code:"permission-denied"});
      if (Boolean(trip.deletedAt) === deleted) return false;
      transaction.update(target,deleted ? {deletedAt:serverTimestamp(),deletedBy:user.uid} : {deletedAt:deleteField(),deletedBy:deleteField()});
      return true;
    });
  }
});
$("adminCalendarBtn")?.addEventListener("click",event => tripCalendar.open(event.currentTarget));
document.querySelectorAll("[data-driver-nav]").forEach(button => {
  button.addEventListener("click", () => {
    const destination = button.dataset.driverNav;
    if (destination === "calendar") { tripCalendar.open(button); return; }
    if (destination === "profile") { openDriverProfile(button); return; }
    document.querySelectorAll("[data-driver-nav]").forEach(item => item.removeAttribute("aria-current"));
    button.setAttribute("aria-current", "page");
    const target = destination === "history" ? $("driverHistory") : destination === "charges" ? $("driverQuickActions") : $("app");
    target.scrollIntoView({ behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block:"start" });
    if (destination !== "home") target.focus({ preventScroll:true });
  });
});
$("driverProfileModal")?.addEventListener("keydown", event => {
  const close = $("driverProfileModal").querySelector("[data-close]");
  const last = $("logoutBtn");
  if (event.key === "Escape") close.click();
  if (event.key === "Tab" && event.shiftKey && document.activeElement === close) { event.preventDefault(); last.focus(); }
  else if (event.key === "Tab" && !event.shiftKey && document.activeElement === last) { event.preventDefault(); close.focus(); }
});

async function loadProfile(user) {
  const directRefs = [doc(db, "usuarios", user.uid), doc(db, "choferes", user.uid)];
  // Conserva la prioridad histórica, pero un perfil encontrado no tiene que
  // esperar a que termine una consulta secundaria que ya no hace falta.
  const directSnapshots = directRefs.map(profileRef => getDoc(profileRef).catch(() => null));
  for (const pendingSnapshot of directSnapshots) {
    try {
      const snap = await pendingSnapshot;
      if (snap?.exists()) {
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

  // Only when both direct documents are missing: start the two historical
  // lookups together, but keep the original uid-before-email role priority.
  const byUidTask = getDocs(query(collection(db, "choferes"), where("uid", "==", user.uid), limit(1))).catch(() => null);
  const byEmailTask = user.email
    ? getDocs(query(collection(db, "choferes"), where("email", "==", user.email.toLowerCase()), limit(1))).catch(() => null)
    : Promise.resolve(null);
  try {
    const byUid = await byUidTask;
    if (byUid && !byUid.empty) {
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
      const byEmail = await byEmailTask;
      if (byEmail && !byEmail.empty) {
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
  subscribeStatementInvoices(user);
  if (unsubscribePayments) unsubscribePayments();
  if (unsubscribeExpenses) unsubscribeExpenses();
  if (unsubscribeUber) unsubscribeUber();
  if (unsubscribeDebts) unsubscribeDebts();
  if (unsubscribeDebtPayments) unsubscribeDebtPayments();
  if (unsubscribeAdvances) unsubscribeAdvances();
  advancesLoaded = false;

  const setup = options => subscribeOwnedRecords(user, options);

  unsubscribePayments = setup({
    collectionName:ROOT_COLLECTIONS.payments,
    normalizer:normalizePaymentRecord,
    assign:rows => { payments = rows; }
  });
  unsubscribeExpenses = setup({
    collectionName:ROOT_COLLECTIONS.expenses,
    normalizer:normalizeExpenseRecord,
    assign:rows => { expenses = rows; }
  });
  unsubscribeUber = setup({
    collectionName:ROOT_COLLECTIONS.uber,
    normalizer:normalizeUberRecord,
    assign:rows => { uberClosures = rows.filter(item => item.noData !== true); },
    afterRender:() => { if (!$("uberModal")?.classList.contains("hidden")) renderUberWeekSelector(); }
  });
  unsubscribeDebts = setup({
    collectionName:ROOT_COLLECTIONS.debts,
    normalizer:normalizeDebtRecord,
    assign:rows => { debts = rows.filter(item => item.amount > 0); }
  });
  unsubscribeDebtPayments = setup({
    collectionName:ROOT_COLLECTIONS.debtPayments,
    normalizer:normalizeDebtPaymentRecord,
    assign:rows => { debtPayments = rows; }
  });
  unsubscribeAdvances = setup({
    collectionName:ROOT_COLLECTIONS.advances,
    normalizer:normalizeAdvanceRecord,
    assign:rows => {
      advances = rows.filter(item => item.type === "cash_advance" || item.loanType === "cash_advance");
      advancesLoaded = true;
    }
  });
}

function isAdminProfile() {
  return EXPLORA_ADMIN_UIDS.has(auth.currentUser?.uid || "") || currentProfile?.role === "admin";
}

function applyRoleUI() {
  const admin = isAdminProfile();
  $("app").classList.toggle("driver-view", !admin);
  resetTeamRealtimeDisclosure();
  $("driverDashboard")?.classList.toggle("hidden", admin);
  $("adminDashboard")?.classList.toggle("hidden", !admin);
  // En Admin, el único botón de salida queda dentro del panel para evitar duplicados.
  $("logoutBtn")?.classList.toggle("hidden", admin);

  // Main unificado v71: algunos controles históricos ya no existen en el HTML.
  // Todos los accesos visuales de este cambio deben tolerar que el elemento haya
  // sido retirado para no interrumpir el arranque ni dejar el splash en Cargando.
  const closeDayButton = $("closeDayBtn");
  if (closeDayButton) closeDayButton.setAttribute("aria-label", admin ? "Gestionar cierres" : "Cierre");
  if (admin && closeDayButton) closeDayButton.disabled = false;
  $("addDebtBtn")?.classList.toggle("hidden", !admin);
  $("advanceBox")?.classList.toggle("hidden", admin);
}


function adminDriverLabel(driver = {}) {
  return String(driver.displayName || driver.nombreCompleto || driver.nombre || driver.username || driver.usuario || "Chofer").trim() || "Chofer";
}

function adminDriverIsActive(driver = {}) {
  const state = String(driver.status || driver.estado || "").trim().toLowerCase();
  return driver.active !== false
    && driver.activo !== false
    && driver.deleted !== true
    && driver.isDeleted !== true
    && driver.eliminado !== true
    && !/inactiv|disabled|eliminad|deleted/.test(state);
}

function teamRealtimeDriverLabel(row = {}) {
  return String(row.driverName || row.displayName || row.nombre || row.username || "").trim();
}

function teamRealtimeHasValidDriver(row = {}) {
  return Boolean(teamRealtimeDriverLabel(row));
}

function setTeamRealtimeExpanded(expanded = false) {
  const card = document.querySelector(".team-realtime-card");
  const button = $("teamRealtimeToggle");
  if (!card || !button) return;
  card.classList.toggle("is-collapsed", !expanded);
  button.textContent = expanded ? "Cerrar choferes" : "Abrir choferes";
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function resetTeamRealtimeDisclosure() {
  setTeamRealtimeExpanded(false);
}

function teamRealtimeSignedBalance(row = {}) {
  const explicit = Number(row.settlementBalance);
  if (Number.isFinite(explicit)) return Math.abs(explicit) > 0.5 ? explicit : 0;
  const amount = Math.max(0, Number(row.amount || 0));
  const direction = String(row.direction || "").toLowerCase();
  if (direction === "driver_to_explora") return amount;
  if (direction === "explora_to_driver") return -amount;
  return 0;
}

function teamRealtimeIsCurrentDriver(row = {}) {
  const uid = String(auth.currentUser?.uid || "");
  if (!uid) return false;
  return [row.driverUid, row.profileDocumentId, row.driverId]
    .map(value => String(value || ""))
    .includes(uid);
}

function renderTeamRealtimeList() {
  const box = $("teamRealtimeList");
  if (!box) return;

  const rows = teamRealtimeBalances
    .filter(row => row.active !== false)
    .filter(teamRealtimeHasValidDriver)
    .sort((a, b) => teamRealtimeDriverLabel(a).localeCompare(teamRealtimeDriverLabel(b), "es", { sensitivity:"base" }));

  if (!rows.length) {
    box.innerHTML = teamRealtimeLoadError
      ? `<div class="team-realtime-empty error">${escapeHtml(teamRealtimeLoadError)}</div>`
      : `<div class="team-realtime-empty">Preparando saldos en tiempo real…</div>`;
    return;
  }

  box.innerHTML = rows.map(row => {
    const balance = teamRealtimeSignedBalance(row);
    const amount = Math.abs(balance);
    const stateClass = balance > 0.5 ? "driver-owes" : balance < -0.5 ? "explora-owes" : "balanced";
    const label = balance > 0.5
      ? "Chofer debe"
      : balance < -0.5
        ? "Explora debe"
        : "Cuentas equilibradas";
    const currentClass = teamRealtimeIsCurrentDriver(row) ? "is-current-driver" : "";
    return `<article class="team-driver-row ${stateClass} ${currentClass}">
      <strong class="team-driver-name">${escapeHtml(teamRealtimeDriverLabel(row))}</strong>
      <div class="team-driver-balance">
        <span>${label}</span>
        <b>${money(amount)}</b>
      </div>
    </article>`;
  }).join("");
}

function unsubscribeTeamRealtimeDashboard() {
  if (unsubscribeTeamRealtimeBalances) {
    try { unsubscribeTeamRealtimeBalances(); } catch (_) {}
  }
  unsubscribeTeamRealtimeBalances = null;
}

function subscribeTeamRealtimeDashboard() {
  unsubscribeTeamRealtimeDashboard();
  const generation = authGeneration;
  teamRealtimeLoadError = "";
  renderTeamRealtimeList();

  unsubscribeTeamRealtimeBalances = onSnapshot(
    collection(db, TEAM_REALTIME_BALANCES_COLLECTION),
    snapshot => {
      if (generation !== authGeneration) return;
      teamRealtimeBalances = snapshot.docs.map(document => ({ id:document.id, ...document.data() }));
      teamRealtimeLoadError = "";
      scheduleDashboardRender(renderTeamRealtimeList);
      scheduleDashboardRender(renderAdminDashboardUpdates);
    },
    error => {
      if (generation !== authGeneration) return;
      console.error("No se pudieron sincronizar los saldos del equipo:", error);
      teamRealtimeLoadError = "No se pudieron cargar los saldos en tiempo real.";
      renderTeamRealtimeList();
    }
  );

  ensureTeamRealtimeBalancesCallable({})
    .catch(error => {
      if (generation !== authGeneration) return;
      console.warn("No se pudo inicializar Tiempo real:", error);
      if (!teamRealtimeBalances.length) {
        teamRealtimeLoadError = "No se pudieron preparar los saldos en tiempo real.";
        renderTeamRealtimeList();
      }
    });
}

function unsubscribeOwnProfileDashboard() {
  if (unsubscribeOwnProfileStatus) {
    try { unsubscribeOwnProfileStatus(); } catch (_) {}
  }
  unsubscribeOwnProfileStatus = null;
  disabledProfileSignoutInProgress = false;
}

function subscribeOwnProfileDashboard(user) {
  unsubscribeOwnProfileDashboard();
  const generation = authGeneration;
  if (!user?.uid || EXPLORA_ADMIN_UIDS.has(user.uid)) return;
  unsubscribeOwnProfileStatus = onSnapshot(doc(db, "choferes", user.uid), async snapshot => {
    if (generation !== authGeneration || auth.currentUser?.uid !== user.uid) return;
    if (!snapshot.exists() || adminDriverIsActive(snapshot.data() || {}) || disabledProfileSignoutInProgress) return;
    disabledProfileSignoutInProgress = true;
    try {
      await signOut(auth);
      $("loginStatus").textContent = "Este usuario fue inhabilitado por el administrador.";
      $("loginStatus").className = "status error";
    } catch (error) {
      console.error("No se pudo cerrar la sesión inhabilitada:", error);
      disabledProfileSignoutInProgress = false;
    }
  }, error => {
    console.warn("No se pudo vigilar el estado del chofer:", error);
  });
}

function adminDriverIsAdministrator(driver = {}) {
  const role = String(driver.role || driver.rol || "").trim().toLowerCase();
  return EXPLORA_ADMIN_UIDS.has(String(driver.id || driver.uid || driver.authUid || ""))
    || ["admin", "administrador", "owner", "superadmin"].includes(role);
}

function adminDriverIdentitySet(driver = {}) {
  const values = [
    driver.id, driver.uid, driver.authUid, driver.firebaseUid, driver.userId,
    driver.driverUid, driver.driverId, driver.choferUid, driver.choferId,
    driver.profileId, driver.profileDocumentId, driver.usuario, driver.username,
    driver.usuarioNormalizado, driver.email, driver.authEmail, driver.contactEmail,
    driver.correo
  ];
  return new Set(values.map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
}

function adminRecordIdentityValues(item = {}) {
  const values = [
    item.driverUid, item.choferUid, item.uid, item.ownerUid, item.driverId, item.choferId,
    item.driver_id, item.chofer_id, item.userUid, item.userId, item.ownerId,
    item.conductorUid, item.conductorId, item.assignedDriverUid,
    item.enteredOnBehalfOf, item.simulationDriverUid, item.operatorUid
  ];
  return values.map(value => String(value || "").trim().toLowerCase()).filter(Boolean);
}

function adminRecordBelongsToDriver(item = {}, driver = {}) {
  const aliases = adminDriverIdentitySet(driver);
  const ownershipValues = adminRecordIdentityValues(item);
  if (ownershipValues.length) return ownershipValues.some(value => aliases.has(value));

  // Solo para históricos sin UID: usar el nombre como último recurso.
  const driverNames = new Set([
    driver.displayName, driver.nombreCompleto, driver.nombre
  ].map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
  const recordNames = [
    item.operatorName, item.driverName, item.choferNombre, item.nombreChofer
  ].map(value => String(value || "").trim().toLowerCase()).filter(Boolean);
  return recordNames.some(value => driverNames.has(value));
}

function adminBillingBaselineForDriver(driver = {}) {
  return adminAllClosures
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(closureUsesCutoff)
    .filter(item => closureKind(item) === "facturacion")
    .map(closureCutoffMs)
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || 0;
}

function adminBillingBalanceForDriver(driver = {}) {
  const own = rows => rows.filter(item => adminRecordBelongsToDriver(item, driver));
  return ExploraPeriodSettlement.calculate({records:own(adminPayments), expenses:own(adminExpenses),
    uberWeeks:own(adminUberClosures), debts:own(adminDebts), closures:own(adminAllClosures)}).balance;
}

function adminOpenDebtItemsForDriver(driver = {}) {
  return adminDebts
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => !movementIsDeleted(item))
    .filter(item => debtImpactsSettlement(item))
    .filter(item => Number(item.amount || 0) > 0.5)
    .sort((a, b) => recordTimestampMs(a) - recordTimestampMs(b));
}

function adminOpenDebtTotalForDriver(driver = {}) {
  return adminOpenDebtItemsForDriver(driver).reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

function adminDriverById(driverId = "") {
  return adminDrivers.find(driver => String(driver.id) === String(driverId)) || null;
}

function renderAdminDriverOptions() {
  const drivers = adminDrivers
    .filter(driver => !adminDriverIsAdministrator(driver))
    .sort((a, b) => adminDriverLabel(a).localeCompare(adminDriverLabel(b), "es", { sensitivity: "base" }));

  const historicalOptions = drivers.map(driver => {
    const inactive = !adminDriverIsActive(driver);
    return `<option value="${escapeHtml(driver.id)}">${escapeHtml(adminDriverLabel(driver))}${inactive ? " · inactivo" : ""}</option>`;
  }).join("");

  const activeOptions = drivers.filter(adminDriverIsActive).map(driver =>
    `<option value="${escapeHtml(driver.id)}">${escapeHtml(adminDriverLabel(driver))}</option>`
  ).join("");

  [
    ["editDriverSelect", activeOptions],
    ["deleteDriverSelect", activeOptions],
    ["debtDriver", activeOptions],
    ["adjustmentDriver", activeOptions],
    ["historyDriver", historicalOptions],
    ["movementDriver", historicalOptions]
  ].forEach(([id, options]) => {
    const select = $(id);
    if (!select) return;
    const previous = select.value;
    select.innerHTML = options || `<option value="">No hay choferes disponibles</option>`;
    if (previous && Array.from(select.options).some(option => option.value === previous)) select.value = previous;
  });

}

function renderAdminDriverList() {
  const box = $("adminDriverList");
  if (!box || !isAdminProfile()) return;

  const active = adminDrivers
    .filter(driver => !adminDriverIsAdministrator(driver) && adminDriverIsActive(driver))
    .sort((a, b) => adminDriverLabel(a).localeCompare(adminDriverLabel(b), "es", { sensitivity: "base" }));

  if (!active.length) {
    box.innerHTML = `<div class="admin-driver-empty">No hay choferes activos.</div>`;
    renderAdminDriverOptions();
    return;
  }

  box.innerHTML = active.map(driver => {
    // Admin ya escucha todos los movimientos y calcula de inmediato, sin esperar
    // los segundos que puede tardar el disparador que actualiza la vista pública.
    const balance = adminBillingBalanceForDriver(driver);
    const amount = Math.abs(balance);
    const stateClass = balance > 0.5 ? "driver-owes" : balance < -0.5 ? "explora-owes" : "balanced";
    const label = balance > 0.5
      ? "Chofer debe"
      : balance < -0.5
        ? "Explora debe"
        : "Cuentas equilibradas";
    return `<article class="admin-driver-row ${stateClass}">
      <strong class="admin-driver-name">${escapeHtml(adminDriverLabel(driver))}</strong>
      <div class="admin-driver-balance">
        <span>${label}</span>
        <b>${money(amount)}</b>
      </div>
    </article>`;
  }).join("");

  renderAdminDriverOptions();
}

function renderAdminHistory() {
  const box = $("adminHistoryList");
  if (!box) return;
  const driver = adminDriverById($("historyDriver")?.value || "");
  if (!driver) {
    box.innerHTML = `<div class="admin-empty">Seleccioná un chofer.</div>`;
    return;
  }

  const rows = [];

  adminPayments
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => isSettlementAdjustment(item))
    .forEach(item => rows.push({
      kind: "Ajuste",
      title: item.adjustmentDirection === "driver_to_explora" ? "Chofer pagó a Explora" : "Explora pagó al chofer",
      amount: Number(item.amount || 0),
      detail: item.detail || item.notes || "",
      proofUrl: item.proofUrl || "",
      createdAt: recordTimestampMs(item),
      className: "adjustment",
      visualMovementColor: movementColor(item)
    }));

  adminDebts
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .forEach(item => rows.push({
      kind: "Deuda",
      title: movementIsDeleted(item) || Number(item.amount || 0) <= 0.5 ? "Deuda cerrada / anulada" : "Deuda agregada",
      amount: Number(item.amount || 0),
      originalAmount: Number(item.totalAmount || item.amount || 0),
      detail: item.detail || item.reason || "",
      proofUrl: item.proofUrl || "",
      createdAt: recordTimestampMs(item),
      className: "debt",
      debtId: item.id,
      canAnnul: !movementIsDeleted(item) && Number(item.amount || 0) > 0.5 && String(item.type || item.debtType || "") === "admin_debt"
    }));

  adminDebtPayments
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .forEach(item => rows.push({
      kind: "Pago de deuda",
      title: "Pago registrado",
      amount: Number(item.amount || 0),
      detail: item.detail || item.notes || "",
      proofUrl: item.proofUrl || item.receiptUrl || "",
      createdAt: recordTimestampMs(item),
      className: "debt-payment"
    }));

  adminAllClosures
    .filter(item => adminRecordBelongsToDriver(item, driver))
    .filter(item => closureKind(item) === "facturacion")
    .forEach(item => rows.push({
      kind: "Cierre",
      title: item.direction === "driver_pays_explora" ? "Cierre · paga chofer" : item.direction === "explora_pays_driver" ? "Cierre · paga Explora" : "Cierre de facturación",
      amount: Number(item.settlementAmount || item.requestedAmount || 0),
      detail: String(item.status || item.estado || ""),
      proofUrl: item.proofUrl || "",
      createdAt: recordTimestampMs(item),
      className: "closure",
      visualMovementColor: movementColor(item)
    }));

  rows.sort((a, b) => b.createdAt - a.createdAt);
  const visible = rows.slice(0, 40);

  if (!visible.length) {
    box.innerHTML = `<div class="admin-empty">Todavía no hay movimientos para ${escapeHtml(adminDriverLabel(driver))}.</div>`;
    return;
  }

  box.innerHTML = visible.map(item => {
    const date = item.createdAt
      ? new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(item.createdAt))
      : "Sin fecha";
    return `<article class="admin-history-item ${item.className}" data-movement-color="${item.visualMovementColor || ""}">
      <div class="admin-history-top"><span>${escapeHtml(item.kind)}</span><b>${money(item.amount || item.originalAmount || 0)}</b></div>
      <strong>${escapeHtml(item.title)}</strong>
      ${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}
      <div class="admin-history-foot">
        <small>${escapeHtml(date)}</small>
        <div>
          ${item.proofUrl ? `<a href="${item.proofUrl}" target="_blank" rel="noopener">Ver comprobante</a>` : ""}
          ${item.canAnnul ? `<button type="button" data-annul-debt="${escapeHtml(item.debtId)}">Anular deuda</button>` : ""}
        </div>
      </div>
    </article>`;
  }).join("");

  box.querySelectorAll("[data-annul-debt]").forEach(button => {
    button.addEventListener("click", () => annulAdminDebt(button.dataset.annulDebt));
  });
}

function adminDashboardFinancialReady() {
  return [...ADMIN_REQUIRED_SNAPSHOT_KEYS].every(key => adminSnapshotReady.has(key));
}

function refreshOpenAdminUberCalculation() {
  if (adminPendingAction?.kind !== "uber_request") return;
  const modal = $("adminPendingActionModal");
  if (!modal || modal.classList.contains("hidden")) return;
  renderAdminUberCalculation(adminPendingAction.item || {});
}

function unsubscribeAdminDashboard() {
  adminUnsubscribers.forEach(unsubscribe => {
    try { unsubscribe?.(); } catch (_) {}
  });
  adminUnsubscribers = [];
  adminSnapshotReady.clear();
}

function renderAdminDashboardUpdates() {
  if (!auth.currentUser || !isAdminProfile()) return;
  if (!dashboardLoad?.complete()) {
    $("adminDriverList").innerHTML = `<div class="admin-driver-empty">${dashboardLoad?.errors.size ? "No se pudieron cargar los saldos. Recargá para volver a intentar." : "Consultando los saldos del equipo…"}</div>`;
    return;
  }
  renderAdminDriverList();
  renderAdminClosures();
  refreshOpenAdminUberCalculation();
  maybeShowAdminPendingAction();
  if (!$("adminHistoryModal")?.classList.contains("hidden")) renderAdminHistory();
  if (!$("adminMovementsModal")?.classList.contains("hidden")) renderAdminFinancialMovements();
}

function subscribeAdminDashboard() {
  if (!isAdminProfile()) return;
  unsubscribeAdminDashboard();

  const load = dashboardLoad;
  const generation = authGeneration;
  const listen = (collectionName, normalize, assign) => {
    let received = false;
    const stop = onSnapshot(collection(db, collectionName), { includeMetadataChanges:true }, snap => {
      if (generation !== authGeneration || load !== dashboardLoad) return;
      const changed = !received || snap.docChanges().length > 0;
      received = true;
      const wasReady = load.complete();
      load.update(collectionName, snap.metadata.fromCache);
      if (!snap.metadata.fromCache) adminSnapshotReady.add(collectionName);
      if (!changed && wasReady === load.complete()) return;
      const rows = snap.docs.map(d => normalize ? normalize(d.id, d.data()) : ({ id: d.id, ...d.data() }));
      assign(rows);
      scheduleDashboardRender(renderAdminDashboardUpdates);
    }, err => {
      if (generation !== authGeneration || load !== dashboardLoad) return;
      load.update(collectionName, false, true);
      console.error(`Admin snapshot ${collectionName}:`, err);
      const box = $("adminDriverList");
      if (box) box.innerHTML = `<div class="admin-driver-empty error">No se pudieron cargar los datos del administrador.</div>`;
    });
    adminUnsubscribers.push(stop);
  };

  listen("choferes", null, rows => { adminDrivers = rows; });
  listen(ROOT_COLLECTIONS.payments, normalizePaymentRecord, rows => { adminPayments = rows; });
  listen(ROOT_COLLECTIONS.expenses, normalizeExpenseRecord, rows => { adminExpenses = rows; });
  listen(ROOT_COLLECTIONS.uber, normalizeUberRecord, rows => { adminUberClosures = rows; });
  listen(ROOT_COLLECTIONS.closures, normalizeClosureRecord, rows => {
    adminAllClosures = rows.sort((a, b) => recordTimestampMs(b) - recordTimestampMs(a));
    closures = [...adminAllClosures];
  });
  listen(ROOT_COLLECTIONS.debts, normalizeDebtRecord, rows => { adminDebts = rows; });
  listen(ROOT_COLLECTIONS.debtPayments, normalizeDebtPaymentRecord, rows => { adminDebtPayments = rows; });
  listen(ROOT_COLLECTIONS.advances, normalizeAdvanceRecord, rows => { adminAdvances = rows; });
}


function adminFinancialMovementRows() {
  const driver = adminDriverById($("movementDriver")?.value || "");
  if (!driver) return [];
  const filter = $("movementTypeFilter")?.value || "all";
  const rows = [];

  if (filter === "all" || filter === "cobro") {
    adminPayments
      .filter(item => adminRecordBelongsToDriver(item, driver))
      .filter(item => !movementIsDeleted(item))
      .filter(item => !isSettlementAdjustment(item) && !isReimbursementCompensation(item))
      .filter(item => item.method === "cash" || item.method === "digital")
      .forEach(item => rows.push({
        id:item.id,
        type:"cobro",
        label:item.method === "cash" ? "Cobro en efectivo" : "Cobro digital",
        amount:Number(item.amount || 0),
        detail:item.detail || item.notes || item.service || "",
        createdAt:recordTimestampMs(item),
        method:item.method,
        visualMovementColor:movementColor(item),
        proofUrl:item.proofUrl || item.receiptUrl || ""
      }));
  }

  if (filter === "all" || filter === "gasto") {
    adminExpenses
      .filter(item => adminRecordBelongsToDriver(item, driver))
      .filter(item => !movementIsDeleted(item))
      .forEach(item => rows.push({
        id:item.id,
        type:"gasto",
        label:"Gasto",
        amount:Number(item.amount || 0),
        detail:item.detail || item.notes || item.expenseType || "",
        createdAt:recordTimestampMs(item),
        method:"expense",
        visualMovementColor:movementColor({...item, method:"expense"}, {expensePolicy:ExploraExpensePolicy}),
        proofUrl:item.proofUrl || item.receiptUrl || ""
      }));
  }

  if (filter === "all" || filter === "uber") {
    adminUberClosures.filter(item => adminRecordBelongsToDriver(item,driver))
      .filter(item => !movementIsDeleted(item)).forEach(item => rows.push({
        id:item.id,type:"uber",label:"Liquidación Uber",amount:uberGrossRevenueOf(item),
        detail:uberWeekLabelForItem(item),createdAt:recordTimestampMs(item),method:"cash",proofUrl:recordProofUrl(item)
      }));
  }

  return rows.sort((a,b)=>b.createdAt-a.createdAt).slice(0, 80);
}

function renderAdminFinancialMovements() {
  const box = $("adminMovementList");
  if (!box) return;
  const driver = adminDriverById($("movementDriver")?.value || "");
  if (!driver) {
    box.innerHTML = `<div class="admin-empty">Seleccioná un chofer.</div>`;
    return;
  }
  const rows = adminFinancialMovementRows();
  if (!rows.length) {
    box.innerHTML = `<div class="admin-empty">No hay movimientos para ${escapeHtml(adminDriverLabel(driver))}.</div>`;
    return;
  }
  box.innerHTML = rows.map(item => {
    const when = item.createdAt ? new Date(item.createdAt).toLocaleString("es-AR", { dateStyle:"short", timeStyle:"short" }) : "";
    return `<article class="admin-movement-item" data-movement-color="${item.visualMovementColor || ""}">
      <div class="admin-history-top"><span>${escapeHtml(item.label)}</span><b>${money(item.amount)}</b></div>
      <strong>${escapeHtml(item.detail || "Sin detalle")}</strong>
      <div class="admin-history-foot">
        <div><small>${escapeHtml(when)}</small>${item.proofUrl ? `<a target="_blank" rel="noopener" href="${item.proofUrl}">Comprobante</a>` : ""}</div>
        <div class="admin-movement-actions">
          ${item.type === "uber" ? "" : `<button type="button" data-edit-financial="${escapeHtml(item.id)}" data-financial-type="${item.type}" data-financial-amount="${item.amount}" data-financial-color="${item.visualMovementColor || ""}">Modificar</button>`}
          <button type="button" class="danger" data-delete-financial="${escapeHtml(item.id)}" data-financial-type="${item.type}">Eliminar</button>
        </div>
      </div>
    </article>`;
  }).join("");

  box.querySelectorAll("[data-edit-financial]").forEach(button => {
    button.addEventListener("click", () => openAdminFinancialEdit({
      id:button.dataset.editFinancial,
      type:button.dataset.financialType,
      amount:Number(button.dataset.financialAmount || 0),
      visualMovementColor:button.dataset.financialColor || ""
    }));
  });
  box.querySelectorAll("[data-delete-financial]").forEach(button => {
    button.addEventListener("click", () => deleteAdminFinancialMovement(button.dataset.financialType, button.dataset.deleteFinancial));
  });
}

function openAdminFinancialEdit(item = {}) {
  const driver = adminDriverById($("movementDriver")?.value || "");
  if (!driver || !item.id) return;
  $("financialEditModal").dataset.movementColor = ["green","red"].includes(item.visualMovementColor) ? item.visualMovementColor : "";
  $("financialEditDocumentId").value = item.id;
  $("financialEditType").value = item.type;
  $("financialEditDriverId").value = driver.id;
  setMoneyInput("financialEditAmount", item.amount || 0);
  $("financialEditReason").value = "";
  $("financialEditStatus").textContent = "";
  $("financialEditStatus").className = "status";
  $("financialEditModal").classList.remove("hidden");
}

async function deleteAdminFinancialMovement(type, documentId) {
  const driver = adminDriverById($("movementDriver")?.value || "");
  if (!driver || !documentId || !["cobro","gasto","uber"].includes(type)) return;
  const reason = window.prompt(`Motivo para eliminar este ${type}:`);
  if (!String(reason || "").trim()) return;
  const confirmed = window.confirm(`¿Eliminar este ${type}? El saldo se recalculará automáticamente.`);
  if (!confirmed) return;
  const status = $("adminMovementStatus");
  status.textContent = "Eliminando movimiento…";
  status.className = "status";
  try {
    await adminDeleteFinancialMovementCallable({
      type,
      documentId,
      driverUid:driver.id,
      reason:String(reason).trim()
    });
    status.textContent = "Movimiento eliminado. Los saldos y cierres relacionados fueron recalculados.";
    status.className = "status success";
    setTimeout(renderAdminFinancialMovements, 350);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message?.replace(/^FirebaseError:\s*/i, "") || "No se pudo eliminar el movimiento.";
    status.className = "status error";
  }
}

function syncDriverEditForm() {
  const select = $("editDriverSelect");
  const name = $("editDriverName");
  if (!select || !name) return;
  const driver = adminDriverById(select.value);
  if (!driver) {
    name.value = "";
    return;
  }
  name.value = adminDriverLabel(driver);
}

function setDriverManagerMode(mode = "create") {
  const normalizedMode = mode === "edit" ? "edit" : mode === "delete" ? "delete" : "create";
  const createMode = normalizedMode === "create";
  const editMode = normalizedMode === "edit";
  const deleteMode = normalizedMode === "delete";
  $("driverManagerMode").value = normalizedMode;
  $("driverCreateFields").classList.toggle("hidden", !createMode);
  $("driverEditFields").classList.toggle("hidden", !editMode);
  $("driverDeleteFields").classList.toggle("hidden", !deleteMode);
  $("driverManagerCreateTab").classList.toggle("selected", createMode);
  $("driverManagerEditTab").classList.toggle("selected", editMode);
  $("driverManagerDisableTab").classList.toggle("selected", deleteMode);
  $("saveDriverManagerBtn").textContent = createMode ? "Crear chofer" : editMode ? "Guardar cambios" : "Borrar chofer";
  $("saveDriverManagerBtn").classList.toggle("danger", deleteMode);

  ["newDriverName", "newDriverUsername", "newDriverPassword"].forEach(id => {
    const input = $(id);
    if (input) input.required = createMode;
  });
  $("editDriverSelect").required = editMode;
  $("editDriverName").required = editMode;
  $("deleteDriverSelect").required = deleteMode;
  if (editMode) syncDriverEditForm();
}

async function writeAdminAudit(action, data = {}) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;
  try {
    await addDoc(collection(db, "admin_audit"), {
      action,
      adminUid: admin.uid,
      adminName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      ...data,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.warn("No se pudo guardar auditoría admin:", err);
  }
}

function closureRemaining(item) {
  const original = Number(item.settlementAmount || item.requestedAmount || 0);
  const paid = Number(item.paidAmountTotal || 0);
  return Math.max(0, Number(item.remainingAmount ?? (original - paid)) || 0);
}

function closureDriverPaymentMethod(item = {}) {
  const raw = String(item.paymentMethod || item.method || item.metodoPago || item.financialCategory || "").toLowerCase();
  return /transfer|alias|transf/.test(raw) ? "transfer" : "cash";
}

function closureDriverPaymentMethodLabel(item = {}) {
  return closureDriverPaymentMethod(item) === "transfer" ? "Transferencia" : "Efectivo";
}

function renderAdminClosures() {
  if (!isAdminProfile()) return;
  const box = $("adminClosureList");
  const pendingExplora = closures.filter(item => {
    const status = String(item.status || "").toLowerCase();
    return item.direction === "explora_pays_driver" && closureRemaining(item) > 0 && !/completed|reject|rechaz|cancel/.test(status);
  });
  const pendingDriverReview = closures.filter(item =>
    item.direction === "driver_pays_explora" && /awaiting_admin_review|pending_admin_review/.test(String(item.status || "").toLowerCase())
  );
  const driverPayments = closures.filter(item => {
    const status = String(item.status || "").toLowerCase();
    return item.direction === "driver_pays_explora" && Number(item.paidAmountTotal || 0) > 0.5 && !/reject|rechaz|awaiting|pending/.test(status);
  }).slice(0, 6);

  const reviewHtml = pendingDriverReview.map(item => {
    const method = closureDriverPaymentMethod(item);
    const methodLabel = closureDriverPaymentMethodLabel(item);
    return `
      <article class="admin-closure-card pending">
        <div class="admin-closure-top">
          <div><small>Pago a Explora por confirmar · ${methodLabel}</small><strong>${escapeHtml(item.operatorName || "Chofer")}</strong></div>
          <b>${money(item.requestedPaymentAmount || item.settlementAmount || 0)}</b>
        </div>
        <p>${method === "transfer" ? "El chofer realizó una transferencia y adjuntó el comprobante." : "El chofer informó que entregará el efectivo en mano a David."} Confirmá solamente después de recibir el dinero.</p>
        <button type="button" class="admin-proof-button" data-admin-review-closure="${escapeHtml(item.id)}">${method === "transfer" ? "Revisar comprobante" : "Confirmar entrega"}</button>
      </article>`;
  }).join("");

  const payHtml = pendingExplora.map(item => `
    <article class="admin-closure-card pending">
      <div class="admin-closure-top">
        <div><small>Cobrar a Explora</small><strong>${escapeHtml(item.operatorName || "Chofer")}</strong></div>
        <b>${money(closureRemaining(item))}</b>
      </div>
      <p>Transferir a ${escapeHtml(item.recipientAlias || "alias no informado")} · CUIT ${escapeHtml(formatCuit(item.recipientCuit || ""))}.</p>
      <button type="button" class="admin-proof-button" data-admin-closure="${escapeHtml(item.id)}">Pagar y subir comprobante</button>
    </article>`).join("");

  const pendingHtml = reviewHtml || payHtml
    ? reviewHtml + payHtml
    : `<div class="admin-empty">No hay cierres pendientes.</div>`;

  const receivedHtml = driverPayments.length ? `
    <div class="admin-history-title">Pagos confirmados de choferes</div>
    ${driverPayments.map(item => `
      <article class="admin-closure-card received">
        <div class="admin-closure-top">
          <div><small>Ajuste del chofer · ${closureDriverPaymentMethodLabel(item)}</small><strong>${escapeHtml(item.operatorName || "Chofer")}</strong></div>
          <b>${money(item.paidAmountTotal || 0)}</b>
        </div>
        ${item.proofUrl ? `<a class="proof admin-proof-link" target="_blank" rel="noopener" href="${item.proofUrl}">Ver comprobante</a>` : ""}
      </article>`).join("")}` : "";

  box.innerHTML = pendingHtml + receivedHtml;
  box.querySelectorAll("[data-admin-closure]").forEach(button => {
    button.addEventListener("click", () => openAdminPayment(button.dataset.adminClosure));
  });
  box.querySelectorAll("[data-admin-review-closure]").forEach(button => {
    button.addEventListener("click", () => {
      const candidate = adminPendingCandidates().find(row => row.key === `closure:${button.dataset.adminReviewClosure}`);
      if (!candidate) return;
      adminDismissedPendingActionIds.delete(candidate.key);
      renderAdminPendingAction(candidate);
    });
  });
}

function adminPendingCandidates() {
  if (!isAdminProfile()) return [];
  const rows = [];
  adminAllClosures.forEach(item => {
    const status = String(item.status || item.reviewStatus || "").toLowerCase();
    if (item.direction === "driver_pays_explora" && /awaiting_admin_review|pending_admin_review/.test(status)) {
      rows.push({ key:`closure:${item.id}`, kind:"closure_driver_payment", id:item.id, createdAt:recordTimestampMs(item), item });
      return;
    }
    if (item.direction === "explora_pays_driver" && closureRemaining(item) > 0.5 && /awaiting_admin_payment|awaiting_admin_proof|pending_admin_payment/.test(status)) {
      rows.push({ key:`closure:${item.id}`, kind:"closure_explora_payment", id:item.id, createdAt:recordTimestampMs(item), item });
    }
  });
  adminAdvances.forEach(item => {
    const status = String(item.approvalStatus || item.status || "").toLowerCase();
    if (/pending/.test(status)) {
      rows.push({ key:`advance:${item.id}`, kind:"advance", id:item.id, createdAt:recordTimestampMs(item), item });
    }
  });
  adminUberClosures.forEach(item => {
    const workflow = String(item.settlementWorkflowVersion || "").toLowerCase();
    const status = String(item.reviewStatus || item.status || "").toLowerCase();
    if (workflow === "v84_driver_submission_admin_review" && status === "pending_admin_review") {
      rows.push({ key:`uber:${item.id}`, kind:"uber_request", id:item.id, createdAt:recordTimestampMs(item), item });
    } else if (workflow === "v82_admin_driver_confirmation" && /pending_admin_breakdown|awaiting_driver_confirmation/.test(status)) {
      rows.push({ key:`uber:${item.id}`, kind:"uber_legacy_request", id:item.id, createdAt:recordTimestampMs(item), item });
    }
  });
  return rows.sort((a,b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function adminDriverForUberItem(item = {}) {
  return adminDrivers.find(driver => adminRecordBelongsToDriver(item, driver)) || null;
}

function adminUberPeriodModel(driver = {}) {
  const own = rows => rows.filter(item => adminRecordBelongsToDriver(item, driver));
  return ExploraPeriodSettlement.calculate({records:own(adminPayments),expenses:own(adminExpenses),
    uberWeeks:own(adminUberClosures),debts:own(adminDebts),closures:own(adminAllClosures)});
}

function renderAdminUberCalculation(item = {}) {
  const output = $("adminUberCalculation");
  if (!output) return;
  if (!adminDashboardFinancialReady()) {
    output.innerHTML = `<div><span>Saldo del chofer</span><b>Sincronizando datos…</b></div>`;
    const approve = $("adminPendingApproveBtn");
    if (approve) approve.disabled = true;
    return;
  }
  const amount = parseUberAmount($("adminUberVerifiedAmount")?.value || "");
  const driver = adminDriverForUberItem(item);
  if (!driver) {
    output.innerHTML = `<div><span>Saldo del chofer</span><b>Sincronizando…</b></div>`;
    const approve = $("adminPendingApproveBtn");
    if (approve) approve.disabled = true;
    return;
  }
  const approve = $("adminPendingApproveBtn");
  if (approve) approve.disabled = false;
  const model = adminUberPeriodModel(driver);
  const beforeBalance = model.balance;
  const destination = item.settlementDestination === "digital" || item.moneyHolder === "explora" ? "digital" : "cash";
  const impact = ExploraPeriodSettlement.incremental(model,"uber",amount,destination);
  const afterBalance = normalizedSettlementBalance(beforeBalance + impact);
  const before = settlementState(beforeBalance, "before");
  const after = settlementState(afterBalance, "now");
  output.innerHTML = `
    <div><span>Ganancias verificadas</span><b>${money(amount)}</b></div>
    <div><span>Dinero recibido por</span><b>${destination === "digital" ? "Explora" : "Chofer"}</b></div>
    <div><span>Cálculo del período</span><b>Gastos → Caja 10% → reparto 50/50</b></div>
    <div><span>Impacto en la liquidación</span><b>${signedMoney(impact)}</b></div>
    <div class="admin-uber-balance-row"><span>${escapeHtml(before.label)}</span><b>${money(before.amount)}</b></div>
    <div class="admin-uber-balance-row result"><span>${escapeHtml(after.label)}</span><b>${money(after.amount)}</b></div>`;
}

function bindAdminUberForm(item = {}) {
  [$("adminUberVerifiedAmount")].filter(Boolean).forEach(input => {
    input.addEventListener("input", () => {
      renderAdminUberCalculation(item);
    });
  });
  renderAdminUberCalculation(item);
}

function renderAdminPendingAction(candidate) {
  const modal = $("adminPendingActionModal");
  if (!modal || !candidate) return;
  adminPendingAction = candidate;
  const item = candidate.item || {};
  const title = $("adminPendingActionTitle");
  const body = $("adminPendingActionBody");
  const approve = $("adminPendingApproveBtn");
  const reject = $("adminPendingRejectBtn");
  const status = $("adminPendingActionStatus");
  status.textContent = "";
  status.className = "status";
  approve.disabled = false;
  reject.disabled = false;
  reject.classList.remove("hidden");

  if (candidate.kind === "advance") {
    title.textContent = "Pedido de adelanto pendiente";
    const principal = Number(item.principalAmount || item.originalAmount || item.amount || 0);
    const totalDebt = Number(item.totalDebt || item.requestedTotalDebt || 0);
    body.innerHTML = `<div class="admin-pending-type">Adelanto / préstamo</div>
      <strong class="admin-pending-driver">${escapeHtml(item.driverName || item.operatorName || "Chofer")}</strong>
      <div class="admin-pending-amount">${money(principal)}</div>
      <div class="admin-pending-details">
        <div><span>Interés</span><b>${Number(item.interestPercent || 40)}%</b></div>
        <div><span>Total a devolver</span><b>${money(totalDebt)}</b></div>
        <div><span>Diferencia al pedir</span><b>${money(item.differenceAtRequest || 0)}</b></div>
      </div>`;
    approve.textContent = "Aprobar adelanto";
    reject.textContent = "Rechazar";
  } else if (candidate.kind === "uber_request") {
    title.textContent = "Confirmar cierre de Uber";
    const submittedAmount = uberGrossRevenueOf(item);
    const proofUrl = recordProofUrl(item);
    body.innerHTML = `<div class="admin-pending-type">El chofer cargó su cierre semanal de Uber</div>
      <strong class="admin-pending-driver">${escapeHtml(item.operatorName || item.driverName || "Chofer")}</strong>
      <div class="admin-uber-week-label">Semana ${escapeHtml(uberWeekLabelForItem(item))}</div>
      <div class="admin-uber-submission">
        <div><span>Monto informado por el chofer</span><strong>${money(submittedAmount)}</strong></div>
        ${proofUrl ? `<button type="button" class="admin-uber-proof" data-proof-preview="${escapeHtml(proofUrl)}" data-proof-alt="Comprobante semanal de Uber de ${escapeHtml(item.operatorName || item.driverName || "Chofer")}">Ver comprobante completo</button>` : `<div class="admin-proof-notice">No se encontró el comprobante. Rechazá este cierre.</div>`}
      </div>
      <div class="field"><label for="adminUberVerifiedAmount">Monto verificado por David</label><div class="money-entry"><span>$</span><input id="adminUberVerifiedAmount" class="money-input" type="text" inputmode="decimal" value="${escapeHtml(new Intl.NumberFormat("es-AR",{maximumFractionDigits:2}).format(submittedAmount))}" placeholder="0" autocomplete="off"></div><div class="file-note">Si el comprobante muestra otro total, corregilo antes de confirmar.</div></div>
      <label class="admin-uber-verified"><input id="adminUberVerified" type="checkbox"><span>Comprobante y semana verificados</span></label>
      <div id="adminUberCalculation" class="admin-uber-calculation"></div>`;
    approve.textContent = "Confirmar cierre";
    reject.textContent = "Rechazar comprobante";
    bindAdminUberForm(item);
  } else if (candidate.kind === "uber_legacy_request") {
    title.textContent = "Actualizar pedido de Uber";
    body.innerHTML = `<div class="admin-pending-type">Pedido creado con el menú anterior</div>
      <strong class="admin-pending-driver">${escapeHtml(item.operatorName || item.driverName || "Chofer")}</strong>
      <div class="admin-uber-week-label">Semana ${escapeHtml(uberWeekLabelForItem(item))}</div>
      <div class="admin-proof-notice">Este pedido no contiene monto ni comprobante. Liberá la semana para que el chofer la cargue nuevamente desde el menú actualizado.</div>`;
    approve.textContent = "Liberar semana";
    reject.classList.add("hidden");
  } else if (candidate.kind === "closure_driver_payment") {
    title.textContent = "Cierre pendiente de confirmación";
    const requested = Number(item.requestedPaymentAmount || item.settlementAmount || 0);
    const paymentMethod = closureDriverPaymentMethod(item);
    const paymentMethodLabel = closureDriverPaymentMethodLabel(item);
    body.innerHTML = `<div class="admin-pending-type">El chofer pagó a Explora · ${paymentMethodLabel}</div>
      <strong class="admin-pending-driver">${escapeHtml(item.operatorName || item.driverName || "Chofer")}</strong>
      <div class="admin-pending-amount">${money(requested)}</div>
      ${paymentMethod === "transfer"
        ? `<div class="admin-bank-card"><span>Transferencia enviada a</span><strong>${escapeHtml(item.transferAlias || EXPLORA_TRANSFER_ALIAS)}</strong><small>CUIT ${escapeHtml(item.transferCuit || EXPLORA_CUIT)}</small></div>
          ${item.proofUrl ? `<a class="admin-pending-proof" target="_blank" rel="noopener" href="${item.proofUrl}">Ver comprobante del chofer</a>` : `<div class="admin-proof-notice">No se encontró el comprobante. No confirmes hasta verificar la transferencia.</div>`}`
        : `<div class="admin-bank-card"><span>Entrega informada</span><strong>Efectivo en mano a David</strong><small>Confirmá únicamente después de recibirlo.</small></div>`}`;
    approve.textContent = "Confirmar pago";
    reject.textContent = paymentMethod === "transfer" ? "Rechazar comprobante" : "Rechazar entrega";
  } else {
    title.textContent = "Pedido de cierre pendiente";
    body.innerHTML = `<div class="admin-pending-type">Explora debe pagar al chofer</div>
      <strong class="admin-pending-driver">${escapeHtml(item.operatorName || item.driverName || "Chofer")}</strong>
      <div class="admin-pending-amount">${money(closureRemaining(item))}</div>
      <div class="admin-bank-card"><span>Transferir a</span><strong>${escapeHtml(item.recipientAlias || "Alias no informado")}</strong><small>CUIT ${escapeHtml(formatCuit(item.recipientCuit || ""))}</small></div>`;
    approve.textContent = "Pagar ahora";
    reject.textContent = "Rechazar pedido";
  }
  modal.classList.remove("hidden");
}

function maybeShowAdminPendingAction() {
  if (!isAdminProfile() || !adminDashboardFinancialReady()) return;
  const modal = $("adminPendingActionModal");
  if (!modal || !modal.classList.contains("hidden")) return;
  const anotherModalOpen = Array.from(document.querySelectorAll(".modal:not(.hidden)")).some(node => node.id !== "adminPendingActionModal");
  if (anotherModalOpen) return;
  const candidate = adminPendingCandidates().find(item => !adminDismissedPendingActionIds.has(item.key));
  if (candidate) renderAdminPendingAction(candidate);
}

function dismissAdminPendingAction({ showNext = false } = {}) {
  if (adminPendingAction?.key) adminDismissedPendingActionIds.add(adminPendingAction.key);
  adminPendingAction = null;
  $("adminPendingActionModal")?.classList.add("hidden");
  if (showNext) setTimeout(maybeShowAdminPendingAction, 80);
}

async function decideAdvanceFromAdmin(item, approved) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;
  const refAdvance = doc(db, ROOT_COLLECTIONS.advances, item.id);
  const totalDebt = Number(item.totalDebt || item.requestedTotalDebt || 0);
  await runTransaction(db, async transaction => {
    const snap = await transaction.get(refAdvance);
    if (!snap.exists()) throw new Error("La solicitud ya no existe.");
    const current = snap.data() || {};
    const state = String(current.approvalStatus || current.status || "").toLowerCase();
    if (!/pending/.test(state)) throw new Error("Esta solicitud ya fue resuelta.");
    transaction.update(refAdvance, approved ? {
      status:"active",
      approvalStatus:"approved",
      remainingAmount:Number(current.totalDebt || current.requestedTotalDebt || totalDebt),
      approvedByUid:admin.uid,
      approvedByName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      approvedAt:serverTimestamp(),
      approvedAtMs:Date.now(),
      updatedAt:serverTimestamp(),
      updatedAtMs:Date.now()
    } : {
      status:"rejected",
      approvalStatus:"rejected",
      remainingAmount:0,
      rejectedByUid:admin.uid,
      rejectedByName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      rejectedAt:serverTimestamp(),
      rejectedAtMs:Date.now(),
      updatedAt:serverTimestamp(),
      updatedAtMs:Date.now()
    });
  });
}

async function approveUberClosureFromAdmin(item = {}) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) throw new Error("Solo David puede confirmar este cierre.");
  if (!adminDashboardFinancialReady()) throw new Error("Los saldos todavía se están sincronizando. Esperá unos segundos antes de confirmar.");
  const amount = parseUberAmount($("adminUberVerifiedAmount")?.value || "");
  if (!(amount > 0)) throw new Error("Ingresá el monto verificado del comprobante.");
  if (!$("adminUberVerified")?.checked) throw new Error("Marcá que verificaste el comprobante y la semana.");

  const uberRef = doc(db, ROOT_COLLECTIONS.uber, item.id);
  const currentSnap = await getDoc(uberRef);
  if (!currentSnap.exists()) throw new Error("El pedido ya no existe.");
  const current = currentSnap.data() || {};
  if (String(current.settlementWorkflowVersion || "").toLowerCase() !== "v84_driver_submission_admin_review"
      || String(current.status || current.reviewStatus || "").toLowerCase() !== "pending_admin_review") {
    throw new Error("Este cierre ya fue confirmado o resuelto.");
  }

  const driverUid = current.driverUid || current.choferUid || current.uid || current.driverId || "";
  if (!driverUid) throw new Error("No se pudo identificar al chofer.");
  if (!recordProofUrl(current)) throw new Error("El cierre no tiene comprobante. Rechazalo para que el chofer lo vuelva a cargar.");

  const driver = adminDriverForUberItem({ ...item, ...current });
  if (!driver) throw new Error("El saldo del chofer todavía se está sincronizando. Intentá nuevamente en unos segundos.");
  const model = adminUberPeriodModel(driver);
  const destination = current.settlementDestination === "digital" || current.moneyHolder === "explora" ? "digital" : "cash";
  const settlementBefore = model.balance;
  const settlementImpact = ExploraPeriodSettlement.incremental(model,"uber",amount,destination);
  const settlementAfter = normalizedSettlementBalance(settlementBefore + settlementImpact);
  const cashAmount = destination === "cash" ? amount : 0;
  const transferAmount = destination === "digital" ? amount : 0;
  const submittedAmount = uberGrossRevenueOf(current);
  const corrected = Math.abs(submittedAmount - amount) > 0.5;

  await setDoc(uberRef, {
    driverSubmittedAmount:Number(current.driverSubmittedAmount ?? submittedAmount),
    grossAmount:amount,
    totalAmount:amount,
    amount,
    cashAmount, uberCashAmount:cashAmount, transferAmount, uberTransferAmount:transferAmount,
    digitalAmount:transferAmount, moneyHolder:destination === "cash" ? "driver" : "explora",
    settlementDestination:destination, settlementRuleVersion:ExploraPeriodSettlement.VERSION,
    driverShare:deleteField(), driverNetAmount:deleteField(), exploraShare:deleteField(),
    debtAmount:settlementImpact, cashboxRate:0.10, cashboxAmount:0, uberCashboxAmount:0,
    cashboxBasis:"net_period_after_expenses",
    settlementImpact,
    settlementBeforeAdminDecision:settlementBefore,
    settlementAfterAdminDecision:settlementAfter,
    telegramSettlementBeforeBalance:settlementBefore,
    telegramSettlementAfterBalance:settlementAfter,
    telegramSettlementPayer:settlementAfter > 0.5 ? "driver" : settlementAfter < -0.5 ? "explora" : "balanced",
    correctedByAdmin:corrected,
    correctedByAdminUid:corrected ? admin.uid : "",
    correctedAt:corrected ? serverTimestamp() : null,
    correctedAtMs:corrected ? Date.now() : 0,
    adminConfirmed:true,
    approvedByUid:admin.uid,
    approvedByName:currentProfile?.displayName || currentProfile?.username || "David",
    approvedAt:serverTimestamp(),
    approvedAtMs:Date.now(),
    reviewStatus:"approved",
    status:"approved",
    updatedAt:serverTimestamp(),
    updatedAtMs:Date.now()
  }, { merge:true });
}

async function releaseLegacyUberRequestFromAdmin(item = {}) {
  await rejectUberRequestFromAdmin({ ...item, rejectionReason:"Pedido anterior liberado para cargar monto y comprobante" });
}

async function rejectUberRequestFromAdmin(item = {}) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;
  await setDoc(doc(db, ROOT_COLLECTIONS.uber, item.id), {
    reviewStatus:"rejected",
    status:"rejected",
    rejectionReason:item.rejectionReason || "El comprobante semanal de Uber fue rechazado por David",
    rejectedByUid:admin.uid,
    rejectedByName:currentProfile?.displayName || currentProfile?.username || "David",
    rejectedAt:serverTimestamp(),
    rejectedAtMs:Date.now(),
    updatedAt:serverTimestamp(),
    updatedAtMs:Date.now()
  }, { merge:true });
}

async function approveDriverClosurePayment(item) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;
  const closureRef = doc(db, ROOT_COLLECTIONS.closures, item.id);
  const driverUid = item.operatorUid || item.driverUid || item.choferUid || item.uid || "";
  const paymentRef = doc(collection(db, ROOT_COLLECTIONS.payments));

  await runTransaction(db, async transaction => {
    const closureSnap = await transaction.get(closureRef);
    if (!closureSnap.exists()) throw new Error("El cierre ya no existe.");
    const current = closureSnap.data() || {};
    if (!/awaiting_admin_review|pending_admin_review/.test(String(current.status || "").toLowerCase())) {
      throw new Error("Este cierre ya fue resuelto.");
    }
    const settlementAmount = Number(current.settlementAmount || current.requestedAmount || 0);
    const amount = Math.min(settlementAmount, Number(current.requestedPaymentAmount || settlementAmount || 0));
    const paymentMethod = closureDriverPaymentMethod(current);
    const paymentMethodLabel = paymentMethod === "transfer" ? "Transferencia" : "Efectivo";
    const newRemaining = Math.max(0, settlementAmount - amount);
    const detail = [
      newRemaining <= 0.5 ? "Pago confirmado por Admin" : "Pago parcial confirmado por Admin",
      paymentMethodLabel,
      "Deudas independientes y adelantos sin cambios"
    ].filter(Boolean).join(" · ");

    transaction.set(paymentRef, {
      method:paymentMethod, paymentMethod, metodoPago:paymentMethod, financialCategory:paymentMethod,
      receiptRequired:paymentMethod === "transfer",
      receiptStatus:paymentMethod === "transfer" ? "uploaded" : "not_required",
      type:"admin_billing_settlement_payment", operationType:"admin_billing_settlement_payment", movementType:"driver_payment",
      sourceModule:"facturacion", affectsBillingSettlement:true, adjustmentDirection:"driver_to_explora",
      amount, monto:amount, previousBillingBalance:settlementAmount, newBillingBalance:newRemaining,
      advanceRepaymentAmount:0,
      advanceAllocations:[],
      service:"Ajuste del chofer", notes:detail, detail,
      proofUrl:current.proofUrl || "", proofPath:current.proofPath || "", receiptUrl:current.receiptUrl || current.proofUrl || "", receiptPath:current.receiptPath || current.proofPath || "",
      closureId:item.id, dayKey:current.dayKey || localDayKey(), weeklyPeriodId:current.weeklyPeriodId || currentWeeklyPeriodId(),
      driverUid, choferUid:driverUid, uid:driverUid, ownerUid:driverUid, driverId:driverUid,
      driverName:current.driverName || current.operatorName || "Chofer", operatorUid:driverUid, operatorName:current.operatorName || current.driverName || "",
      approvedByUid:admin.uid, approvedByName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      businessId:BUSINESS_ID, createdAtMs:Date.now(), createdAt:serverTimestamp()
    });
    transaction.update(closureRef, {
      paidAmountTotal:amount,
      remainingAmount:newRemaining,
      amountDueFromDriver:newRemaining,
      amountFromDriver:newRemaining,
      projectedRemainingAmount:newRemaining,
      projectedBalanceAfterApproval:newRemaining,
      telegramSettlementAfterBalance:newRemaining,
      reviewStatus:"approved",
      status:newRemaining <= 0.5 ? "completed" : "partial",
      actionedByAdminUid:admin.uid,
      actionedByAdminName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      approvedAt:serverTimestamp(),
      approvedAtMs:Date.now(),
      updatedAt:serverTimestamp(),
      updatedAtMs:Date.now(),
      completedAt:newRemaining <= 0.5 ? serverTimestamp() : null
    });
  });
}

async function rejectClosureFromAdmin(item) {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;
  const closureRef = doc(db, ROOT_COLLECTIONS.closures, item.id);
  const isExploraPayment = item.direction === "explora_pays_driver";
  await runTransaction(db, async transaction => {
    const snap = await transaction.get(closureRef);
    if (!snap.exists()) throw new Error("El cierre ya no existe.");
    const current = snap.data() || {};
    const status = String(current.status || "").toLowerCase();
    if (/completed|reject|rechaz|cancel/.test(status)) throw new Error("Este cierre ya fue resuelto.");
    transaction.update(closureRef, {
      status:"rejected",
      reviewStatus:"rejected",
      rejectionReason:isExploraPayment ? "Pedido de cobro rechazado por Admin" : "Comprobante rechazado por Admin",
      ...(isExploraPayment ? { remainingAmount:0, amountDueToDriver:0, amountToDriver:0 } : {}),
      rejectedByUid:admin.uid,
      rejectedByName:currentProfile?.displayName || currentProfile?.username || "Administrador",
      rejectedAt:serverTimestamp(),
      rejectedAtMs:Date.now(),
      updatedAt:serverTimestamp(),
      updatedAtMs:Date.now()
    });
  });
}

$("adminPendingDismissBtn")?.addEventListener("click", () => dismissAdminPendingAction({ showNext:true }));

$("adminPendingApproveBtn")?.addEventListener("click", async () => {
  const candidate = adminPendingAction;
  if (!candidate) return;
  const approve = $("adminPendingApproveBtn");
  const reject = $("adminPendingRejectBtn");
  const status = $("adminPendingActionStatus");
  if (candidate.kind === "closure_explora_payment") {
    $("adminPendingActionModal").classList.add("hidden");
    adminPendingAction = null;
    $("closeModal").classList.remove("hidden");
    $("closeModalTitle").textContent = "Resolver cierre pendiente";
    $("closeDriverView").classList.add("hidden");
    $("closeAdminView").classList.remove("hidden");
    $("adminClosureList").classList.add("hidden");
    openAdminPayment(candidate.id);
    return;
  }
  approve.disabled = true;
  reject.disabled = true;
  status.textContent = "Procesando…";
  status.className = "status";
  try {
    if (candidate.kind === "advance") await decideAdvanceFromAdmin(candidate.item, true);
    else if (candidate.kind === "uber_request") await approveUberClosureFromAdmin(candidate.item);
    else if (candidate.kind === "uber_legacy_request") await releaseLegacyUberRequestFromAdmin(candidate.item);
    else await approveDriverClosurePayment(candidate.item);
    adminDismissedPendingActionIds.add(candidate.key);
    status.textContent = candidate.kind === "advance"
      ? "Adelanto aprobado."
      : candidate.kind === "uber_request"
        ? "Cierre confirmado. El saldo ya fue actualizado."
        : candidate.kind === "uber_legacy_request"
          ? "Semana liberada. El chofer ya puede cargarla nuevamente."
        : "Pago confirmado.";
    status.className = "status success";
    setTimeout(() => { adminPendingAction = null; $("adminPendingActionModal").classList.add("hidden"); maybeShowAdminPendingAction(); }, 700);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message || "No se pudo completar la acción.";
    status.className = "status error";
    approve.disabled = false;
    reject.disabled = false;
  }
});

$("adminPendingRejectBtn")?.addEventListener("click", async () => {
  const candidate = adminPendingAction;
  if (!candidate) return;
  const approve = $("adminPendingApproveBtn");
  const reject = $("adminPendingRejectBtn");
  const status = $("adminPendingActionStatus");
  approve.disabled = true;
  reject.disabled = true;
  status.textContent = "Procesando rechazo…";
  status.className = "status";
  try {
    if (candidate.kind === "advance") await decideAdvanceFromAdmin(candidate.item, false);
    else if (candidate.kind === "uber_request" || candidate.kind === "uber_legacy_request") await rejectUberRequestFromAdmin(candidate.item);
    else await rejectClosureFromAdmin(candidate.item);
    adminDismissedPendingActionIds.add(candidate.key);
    status.textContent = candidate.kind === "advance" ? "Adelanto rechazado." : "Cierre rechazado.";
    status.className = "status success";
    setTimeout(() => { adminPendingAction = null; $("adminPendingActionModal").classList.add("hidden"); maybeShowAdminPendingAction(); }, 700);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message || "No se pudo rechazar el pedido.";
    status.className = "status error";
    approve.disabled = false;
    reject.disabled = false;
  }
});

function subscribeClosures(user) {
  if (unsubscribeClosures) unsubscribeClosures();
  unsubscribeClosures = subscribeOwnedRecords(user, {
    collectionName: ROOT_COLLECTIONS.closures,
    normalizer: normalizeClosureRecord,
    assign: rows => { closures = rows; }
  });
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
  startSplash("Cerrando sesión…");
  try {
    await signOut(auth);
  } catch (err) {
    console.error(err);
    await finishSplash("app");
  }
});


$("adminLogoutBtn")?.addEventListener("click", async () => {
  startSplash("Cerrando sesión…");
  try {
    await signOut(auth);
  } catch (err) {
    console.error(err);
    await finishSplash("app");
  }
});


$("adminDriversBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  $("driverManagerForm").reset();
  $("driverManagerStatus").textContent = "";
  $("driverManagerStatus").className = "status";
  renderAdminDriverOptions();
  setDriverManagerMode("create");
  $("driverManagerModal").classList.remove("hidden");
});

document.querySelectorAll("[data-driver-manager-mode]").forEach(button => {
  button.addEventListener("click", () => setDriverManagerMode(button.dataset.driverManagerMode));
});

$("editDriverSelect")?.addEventListener("change", syncDriverEditForm);

$("driverManagerForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!isAdminProfile()) return;

  const mode = $("driverManagerMode").value || "create";
  const status = $("driverManagerStatus");
  const button = $("saveDriverManagerBtn");
  status.textContent = "";
  status.className = "status";
  button.disabled = true;

  try {
    if (mode === "create") {
      const nombre = $("newDriverName").value.trim();
      const username = $("newDriverUsername").value.trim().toLowerCase();
      const password = $("newDriverPassword").value;
      if (!nombre || !username || password.length < 6) throw new Error("Completá nombre, ID de acceso y una clave de al menos 6 caracteres.");

      button.textContent = "Creando…";
      await adminCreateDriverCallable({ nombre, username, password, role: "chofer" });
      status.textContent = `Chofer ${nombre} creado correctamente.`;
    } else if (mode === "edit") {
      const driverId = $("editDriverSelect").value;
      const nombre = $("editDriverName").value.trim();
      const password = $("editDriverPassword").value;
      if (!driverId || !nombre) throw new Error("Seleccioná un chofer e indicá su nombre.");
      if (password && password.length < 6) throw new Error("La nueva clave debe tener al menos 6 caracteres.");

      button.textContent = "Guardando…";
      await adminUpdateDriverCallable({ driverId, nombre, active:true, password });
      status.textContent = `Datos de ${nombre} actualizados.`;
    } else {
      const driverId = $("deleteDriverSelect").value;
      const driver = adminDriverById(driverId);
      if (!driverId || !driver) throw new Error("Seleccioná un chofer para borrar.");
      const nombre = adminDriverLabel(driver);
      const confirmed = window.confirm(`¿Borrar definitivamente a ${nombre}? Se eliminará su acceso y desaparecerá de los menús. Los movimientos históricos se conservarán.`);
      if (!confirmed) {
        status.textContent = "Borrado cancelado.";
        status.className = "status";
        return;
      }

      button.textContent = "Borrando…";
      await adminUpdateDriverCallable({ driverId, nombre, deleteDriver:true });
      status.textContent = `${nombre} fue borrado correctamente.`;
    }

    status.className = "status success";
    setTimeout(() => $("driverManagerModal").classList.add("hidden"), 1000);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message?.replace(/^FirebaseError:\s*/i, "") || "No se pudo guardar el chofer.";
    status.className = "status error";
  } finally {
    button.disabled = false;
    button.textContent = mode === "create" ? "Crear chofer" : mode === "edit" ? "Guardar cambios" : "Borrar chofer";
  }
});

$("adminAddDebtBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("debtForm").reset();
  $("debtStatus").textContent = "";
  $("debtStatus").className = "status";
  $("debtModal").classList.remove("hidden");
});

$("adminAdjustmentBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("adminAdjustmentForm").reset();
  $("adminAdjustmentStatus").textContent = "";
  $("adminAdjustmentStatus").className = "status";
  $("adminAdjustmentModal").classList.remove("hidden");
});


$("adminMovementsBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("adminMovementStatus").textContent = "";
  $("adminMovementStatus").className = "status";
  $("adminMovementsModal").classList.remove("hidden");
  renderAdminFinancialMovements();
});

$("movementDriver")?.addEventListener("change", renderAdminFinancialMovements);
$("movementTypeFilter")?.addEventListener("change", renderAdminFinancialMovements);

$("financialEditForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!isAdminProfile()) return;
  const type = $("financialEditType").value;
  const documentId = $("financialEditDocumentId").value;
  const driverUid = $("financialEditDriverId").value;
  const newAmount = parseMoneyInput($("financialEditAmount").value);
  const reason = $("financialEditReason").value.trim();
  const status = $("financialEditStatus");
  const button = $("saveFinancialEditBtn");
  if (!documentId || !driverUid || !["cobro","gasto"].includes(type)) return;
  if (!newAmount || newAmount <= 0) {
    status.textContent = "Ingresá un importe válido.";
    status.className = "status error";
    return;
  }
  if (!reason) {
    status.textContent = "Indicá el motivo de la modificación.";
    status.className = "status error";
    return;
  }
  button.disabled = true;
  button.textContent = "Guardando…";
  status.textContent = "";
  try {
    const callable = type === "gasto" ? adminModifyExpenseAmountCallable : adminModifyBillingAmountCallable;
    await callable({ documentId, driverUid, newAmount, reason });
    status.textContent = "Importe modificado. El saldo fue recalculado automáticamente.";
    status.className = "status success";
    setTimeout(() => {
      $("financialEditModal").classList.add("hidden");
      renderAdminFinancialMovements();
    }, 850);
  } catch (err) {
    console.error(err);
    status.textContent = err?.message?.replace(/^FirebaseError:\s*/i, "") || "No se pudo modificar el movimiento.";
    status.className = "status error";
  } finally {
    button.disabled = false;
    button.textContent = "Guardar modificación";
  }
});

$("adminHistoryBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("adminHistoryStatus").textContent = "";
  $("adminHistoryStatus").className = "status";
  $("adminHistoryModal").classList.remove("hidden");
  renderAdminHistory();
});

$("historyDriver")?.addEventListener("change", renderAdminHistory);

$("adminManageClosuresBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  $("closeDayBtn")?.click();
});

onAuthStateChanged(auth, async user => {
  tripCalendar.reset();
  const generation = ++authGeneration;
  const isCurrent = () => generation === authGeneration && auth.currentUser?.uid === user?.uid;
  cancelDashboardRender();
  dashboardLoad = null;
  if (!user) {
    $("driverProfileModal")?.classList.add("hidden");
    driverProfileOpener = null;
    if (unsubscribePayments) unsubscribePayments();
    if (unsubscribeExpenses) unsubscribeExpenses();
    if (unsubscribeUber) unsubscribeUber();
    if (unsubscribeClosures) unsubscribeClosures();
    if (unsubscribeDebts) unsubscribeDebts();
    if (unsubscribeDebtPayments) unsubscribeDebtPayments();
    if (unsubscribeAdvances) unsubscribeAdvances();
    unsubscribeTeamRealtimeDashboard();
    unsubscribeStatementInvoices?.(); statementInvoices = new Map(); clearDocumentFiles();
    $("periodStatement")?.replaceChildren(); $("driverDashboard")?.classList.remove("has-period-statement");
    unsubscribeOwnProfileDashboard();
    unsubscribeAdminDashboard();
    payments = [];
    expenses = [];
    uberClosures = [];
    closures = [];
    debts = [];
    debtPayments = [];
    advances = [];
    advancesLoaded = false;
    teamRealtimeBalances = [];
    teamRealtimeLoadError = "";
    adminDrivers = [];
    adminPayments = [];
    adminExpenses = [];
    adminUberClosures = [];
    adminAllClosures = [];
    adminDebts = [];
    adminDebtPayments = [];
    adminAdvances = [];
    adminSnapshotReady.clear();
    adminPendingAction = null;
    adminDismissedPendingActionIds.clear();
    currentProfile = null;
    visibleReceiptCount = RECENT_RECEIPTS_LIMIT;
    await finishSplash("loginScreen");
    return;
  }

  visibleReceiptCount = RECENT_RECEIPTS_LIMIT;
  $("splashMessage").textContent = "Cargando tu cuenta…";
  currentProfile = fallbackProfile(user);
  const initialAdmin = isAdminProfile();
  const profileTask = loadProfile(user);
  scheduleOperationalRecovery(12000);
  const subscribeDashboard = () => {
    dashboardLoad = createDashboardLoad(isAdminProfile()
      ? [...ADMIN_REQUIRED_SNAPSHOT_KEYS] : Object.values(ROOT_COLLECTIONS));
    if (isAdminProfile()) subscribeAdminDashboard();
    else { renderDriverLoadState(); subscribeToday(user); subscribeClosures(user); }
  };
  $("operatorName").textContent = `Hola ${currentProfile.displayName || currentProfile.username || user.email?.split("@")[0] || "Chofer"}`;
  applyRoleUI();
  subscribeOwnProfileDashboard(user);
  subscribeDashboard();
  try {
    const profile = await profileTask;
    if (!isCurrent()) return;
    currentProfile = profile;
    if (currentProfile.active === false) {
      await signOut(auth);
      $("loginStatus").textContent = "Este usuario está desactivado.";
      $("loginStatus").className = "status error";
      return;
    }
    $("operatorName").textContent = `Hola ${currentProfile.displayName || currentProfile.username || user.email?.split("@")[0] || "Chofer"}`;
    applyRoleUI();
    if (isAdminProfile() !== initialAdmin) {
      cancelDashboardRender();
      [unsubscribePayments, unsubscribeExpenses, unsubscribeUber, unsubscribeDebts,
        unsubscribeDebtPayments, unsubscribeAdvances, unsubscribeClosures].forEach(stop => stop?.());
      unsubscribeAdminDashboard();
      subscribeDashboard();
    }
  } catch (err) {
    if (!isCurrent()) return;
    console.warn("Se inició sesión usando el perfil básico:", err);
  }
  if (!isCurrent()) return;
  // El acceso depende del perfil, no de descargar todo el historial. Los
  // importes y operaciones mantienen su bloqueo hasta sincronizar cada colección.
  if (isAdminProfile()) renderAdminDashboardUpdates();
  else render();
  await finishSplash("app");
  if (isCurrent()) {
    subscribeTeamRealtimeDashboard();
    refreshArcaBillingStatus();
  }
});

document.querySelectorAll("[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    refreshArcaBillingStatus();
    $("chargeForm").reset();
    resetChargeRoute();
    syncChargeCustomerFields();
    clearPhotoPicker("digital");
    delete $("chargeForm").dataset.previewConfirmed;
    $("chargeMode").value = mode;
    $("chargeModal").dataset.tone = mode;
    $("chargeTitle").textContent = mode === "cash" ? "Cobro en efectivo" : "Cobro digital";
    $("chargeIntro").textContent = mode === "cash" ? "El dinero queda en tu poder." : "El pago ingresa a Explora. Adjuntá el comprobante.";
    $("chargeIcon").innerHTML = mode === "cash" ? '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><ellipse cx="12" cy="12" rx="3" ry="4"/></svg>' : '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>';
    $("chargeDigitalTypeField").classList.toggle("hidden", mode !== "digital");
    $("chargeServiceDate").value = localDayKey();
    $("proofField").classList.toggle("hidden", mode !== "digital");
    $("chargeStatus").textContent = "";
    $("chargeStatus").className = "status";
    $("saveChargeBtn").disabled = false;
    $("saveChargeBtn").textContent = "Confirmar cobro";
    $("chargeModal").classList.remove("hidden");
    showChargeStep(0);
    renderChargePreview();
    $("chargeModal").scrollTop = 0;
    $("chargeAmount").focus({preventScroll:true});
  });
});

function syncChargeCustomerFields() {
  const enabled = $("chargeNamedInvoice").checked;
  $("chargeCustomerFields").classList.toggle("hidden", !enabled);
  $("chargeNamedInvoice").setAttribute("aria-expanded", String(enabled));
  for (const id of ["chargeCustomerName","chargeCustomerDocType","chargeCustomerDoc","chargeCustomerVat"]) $(id).disabled = !enabled;
  $("chargeCustomerName").required = enabled;
  $("chargeCustomerDoc").required = enabled;
}
$("chargeNamedInvoice")?.addEventListener("change", syncChargeCustomerFields);
function chargeDraftRequest() {
  return {
    version:"arca_c_v1",
    serviceDate:$("chargeServiceDate").value,
    origin:$("chargeOrigin").value.trim(), destination:$("chargeDestination").value.trim(),
    distanceKm:Number($("chargeDistance").value), scope:$("chargeTripScope").value,
    paymentChannel:$("chargeMode").value === "cash" ? "cash" : $("chargeDigitalType").value,
    customer:$("chargeNamedInvoice").checked ? {requested:true,name:$("chargeCustomerName").value.trim(),documentType:$("chargeCustomerDocType").value,documentNumber:$("chargeCustomerDoc").value.trim(),vatCondition:$("chargeCustomerVat").value} : {}
  };
}

function renderChargePreview() {
  const amount = parseMoneyInput($("chargeAmount").value) || 0;
  $("chargeInvoiceTotal").textContent = money(amount);
  $("chargeModal").dataset.movementColor = $("chargeMode").value === "cash" ? "red" : "green";
  // The balance and impact are shown only in Inicio. Internal snapshots still feed Telegram.
}
$("chargeAmount")?.addEventListener("input", renderChargePreview);
$("chargeModal")?.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("saveChargeBtn").disabled) $("chargeModal").classList.add("hidden");
  if (event.key === "Tab") {
    const controls = [...$("chargeModal").querySelectorAll('button,input,select,summary')].filter(el => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  }
});

document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => {
    $(btn.dataset.close).classList.add("hidden");
    if (btn.dataset.close === "driverProfileModal") driverProfileOpener?.focus();
    window.setTimeout(maybeShowDriverDebtConfirmation, 0);
    window.setTimeout(maybeShowUberDriverConfirmation, 100);
  });
});

// Se llama únicamente después de confirmar el guardado, sin una espera visual extra.
function closeModalAndGoTop(modalId) {
  $(modalId)?.classList.add("hidden");
  scheduleDashboardRender();
  flushDashboardRender();
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
}

function settlementState(balance, tense = "now") {
  const value = Math.abs(Number(balance || 0)) < 0.005 ? 0 : Number(balance || 0);
  if (value > 0) {
    return {
      label: "Chofer debe",
      amount: value,
      payer: "driver"
    };
  }
  if (value < 0) {
    return {
      label: "Explora debe",
      amount: Math.abs(value),
      payer: "explora"
    };
  }
  return { label: "Cuentas equilibradas", amount: 0, payer: "balanced" };
}

function previewDefinition(kind, amount, details = {}) {
  const value = Math.max(0, Number(amount || 0));
  const names = {cash:"cobro en efectivo", digital:"cobro digital", expense:"gasto", uber:"liquidación de Uber"};
  const model = submissionPreviewModels.get(["cash","digital"].includes(kind) ? "charge" : kind) || settlementModel();
  const delta = ExploraPeriodSettlement.incremental(model, kind, value, details.destination || "cash");
  return {
    title:"Confirmar " + (names[kind] || "movimiento"),
    subtitle:kind === "expense" ? "El gasto se descuenta del dinero disponible antes de calcular la caja y el reparto." : "El dinero queda en poder de quien lo cobra; el saldo muestra cuánto falta liquidar.",
    amountLabel:kind === "expense" ? "Gasto total" : kind === "uber" ? "Ganancias semanales" : "Importe cobrado",
    impactLabel:"Cambio en el saldo a liquidar", delta,
    notice:"Del disponible después de gastos se separa 10% para Caja Explora y el resto se divide 50% / 50%. Los comprobantes fiscales solo aparecen cuando ARCA los autoriza.",
    confirmLabel:kind === "expense" ? "Confirmar gasto" : kind === "uber" ? "Registrar liquidación" : "Confirmar cobro"
  };
}

function normalizedSettlementBalance(value) {
  const balance = Math.round(Number(value || 0) * 100) / 100;
  return Math.abs(balance) >= 0.005 ? balance : 0;
}

function operationImpactMessage(delta, afterBalance) {
  const change = Math.abs(Number(delta || 0));
  if (Math.abs(afterBalance) <= 0.5) return `La operación cambia la diferencia ${money(change)} y deja las cuentas equilibradas.`;
  return Number(delta || 0) > 0
    ? `La operación suma ${money(change)} al lado que debe liquidar el chofer.`
    : `La operación suma ${money(change)} al lado que debe liquidar Explora.`;
}

function renderOperationPreview() {
  if (!pendingOperationPreview) return;
  const details = pendingOperationPreview.details || {};
  const definition = previewDefinition(pendingOperationPreview.kind, pendingOperationPreview.amount, details);
  const beforeState = settlementState(pendingOperationPreview.beforeBalance, "before");
  const afterState = settlementState(pendingOperationPreview.afterBalance, "now");

  $("operationPreviewModal").dataset.tone = pendingOperationPreview.kind;
  $("operationPreviewModal").dataset.movementColor = movementColor({
    method:pendingOperationPreview.kind, type:pendingOperationPreview.kind === "expense" ? "expense_receipt" : "billing", ...details
  }, {expensePolicy:ExploraExpensePolicy});
  $("operationPreviewTitle").textContent = definition.title;
  $("operationPreviewSubtitle").textContent = definition.subtitle;
  $("operationPreviewAmountLabel").textContent = definition.amountLabel;
  $("operationPreviewAmount").textContent = money(pendingOperationPreview.amount);
  $("operationPreviewImpactLabel").textContent = definition.impactLabel;
  const isCharge = ["cash","digital"].includes(pendingOperationPreview.kind);
  $("operationPreviewImpact").textContent = signedMoney(definition.delta);
  $("operationPreviewBeforeLabel").textContent = beforeState.label;
  $("operationPreviewBeforeAmount").textContent = money(beforeState.amount);
  $("operationPreviewAfterLabel").textContent = afterState.label;
  $("operationPreviewAfterAmount").textContent = money(afterState.amount);
  $("operationPreviewImpactText").textContent = operationImpactMessage(definition.delta, pendingOperationPreview.afterBalance);
  $("operationPreviewNotice").textContent = pendingOperationPreview.kind === "uber"
    ? `${definition.notice} Nada se guarda antes de tocar Enviar a David.`
    : `${definition.notice} Nada se guarda antes de confirmar.`;
  $("operationPreviewConfirm").textContent = definition.confirmLabel;
  $("operationPreviewConfirm").disabled = false;
}

function openOperationPreview({ kind, amount, formId, details = {} }) {
  const definition = previewDefinition(kind, amount, details);
  const beforeBalance = settlementModel().balance;
  pendingOperationPreview = {
    kind,
    amount:Number(amount || 0),
    details,
    formId,
    beforeBalance,
    afterBalance:normalizedSettlementBalance(beforeBalance + definition.delta)
  };
  $("operationPreviewStatus").textContent = "";
  $("operationPreviewStatus").className = "status";
  renderOperationPreview();
  $("operationPreviewModal").classList.remove("hidden");
}

function closeOperationPreview() {
  $("operationPreviewModal")?.classList.add("hidden");
  pendingOperationPreview = null;
}

$("operationPreviewBack")?.addEventListener("click", closeOperationPreview);

$("operationPreviewConfirm")?.addEventListener("click", () => {
  if (!pendingOperationPreview) return;

  // Si llegó otra operación mientras el segundo aviso estaba abierto, se
  // actualiza la calculadora y se exige una nueva confirmación sobre ese valor.
  const currentBalance = settlementModel().balance;
  if (Math.abs(currentBalance - pendingOperationPreview.beforeBalance) > 0.5) {
    const definition = previewDefinition(
      pendingOperationPreview.kind,
      pendingOperationPreview.amount,
      pendingOperationPreview.details || {}
    );
    pendingOperationPreview.beforeBalance = currentBalance;
    pendingOperationPreview.afterBalance = normalizedSettlementBalance(currentBalance + definition.delta);
    $("operationPreviewStatus").textContent = "El saldo cambió. Revisá los valores actualizados y confirmá nuevamente.";
    $("operationPreviewStatus").className = "status error";
    renderOperationPreview();
    return;
  }

  const form = $(pendingOperationPreview.formId);
  if (!form) return;
  form.dataset.previewConfirmed = "true";
  $("operationPreviewConfirm").disabled = true;
  $("operationPreviewModal").classList.add("hidden");
  pendingOperationPreview = null;
  form.requestSubmit();
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
  const pendingAdvance = advances.some(item => /pending/.test(String(item.approvalStatus || item.status || "").toLowerCase()));
  if (pendingAdvance) {
    $("advanceStatus").textContent = "Ya tenés una solicitud de adelanto pendiente de respuesta de Admin.";
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
      requestedTotalDebt: quote.total,
      remainingAmount: 0,
      repaidAmount: 0,
      status: "pending_admin_approval",
      approvalStatus: "pending",
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

    $("advanceStatus").textContent = `Solicitud enviada. Admin debe aprobar el adelanto de ${money(quote.principal)} antes de que se active.`;
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
  if ($("saveChargeBtn").disabled) return;
  const step = Number($("chargeForm").dataset.step || 0);
  if (!validateChargeStep(step)) return;
  const steps = chargeSteps(), nextStep = steps[steps.indexOf(step) + 1];
  if (nextStep !== undefined) { showChargeStep(nextStep); return; }
  for (const requiredStep of steps) if (!validateChargeStep(requiredStep)) return;
  const user = auth.currentUser;
  if (!user) { $("chargeStatus").textContent = "Iniciá sesión antes de guardar."; return; }
  const mode = $("chargeMode").value;
  await submitOperationalMovement({kind:mode, user, file:mode === "digital" ? selectedPhotoFile("digital") : null,
    fields:{amount:parseMoneyInput($("chargeAmount").value), detail:$("detail").value.trim(), invoiceRequest:chargeDraftRequest()}});
});

$("addExpenseBtn")?.addEventListener("click", () => {
  $("expenseForm").reset();
  $("expenseType").value = "";
  $("expenseEntryKind").value = "";
  clearPhotoPicker("expense");
  $("saveExpenseBtn").disabled = false;
  $("expenseStepBack").disabled = false;
  setPhotoPickerDisabled("expense", false);
  $("expenseModal").querySelectorAll("[data-close]").forEach(button => button.disabled = false);
  renderExpenseTypes();
  $("expenseModal").classList.remove("hidden");
  showExpenseStep(0);
});

$("addDebtBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) return;
  renderAdminDriverOptions();
  $("debtForm").reset();
  $("debtStatus").textContent = "";
  $("debtStatus").className = "status";
  $("debtModal").classList.remove("hidden");
});

$("debtForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;

  const driver = adminDriverById($("debtDriver").value);
  const amount = parseMoneyInput($("debtAmount").value);
  const detail = $("debtDetail").value.trim();
  const file = $("debtProof").files?.[0];

  if (!driver || !adminDriverIsActive(driver)) {
    $("debtStatus").textContent = "Seleccioná un chofer activo.";
    $("debtStatus").className = "status error";
    return;
  }
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
  if (!file) {
    $("debtStatus").textContent = "Adjuntá el comprobante de la deuda.";
    $("debtStatus").className = "status error";
    return;
  }

  $("saveDebtBtn").disabled = true;
  $("saveDebtBtn").textContent = "Guardando…";
  $("debtStatus").textContent = "";

  try {
    const settlementBeforeDebt = adminBillingBalanceForDriver(driver);
    const debtBalanceBefore = adminDebts
      .filter(item => adminRecordBelongsToDriver(item, driver))
      .filter(item => !movementIsDeleted(item) && debtImpactsSettlement(item))
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const settlementAfterDebt = settlementBeforeDebt + amount;
    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const proofPath = `deudas/${driver.id}/${localDayKey()}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    const debtRef = await addDoc(collection(db, ROOT_COLLECTIONS.debts), {
      type: "admin_debt",
      debtType: "admin_debt",
      amount,
      monto: amount,
      totalAmount: amount,
      originalAmount: amount,
      remainingAmount: amount,
      saldoPendiente: amount,
      paidAmount: 0,
      amountPaid: 0,
      detail,
      reason: detail,
      notes: detail,
      proofUrl,
      proofPath,
      proofMimeType: file.type || "",
      proofFileName: file.name || cleanName,
      receiptUrl: proofUrl,
      receiptPath: proofPath,
      receiptMimeType: file.type || "",
      receiptFileName: file.name || cleanName,
      dayKey: localDayKey(),
      driverUid: driver.id,
      choferUid: driver.id,
      uid: driver.id,
      ownerUid: driver.id,
      driverId: driver.id,
      operatorUid: driver.id,
      driverName: adminDriverLabel(driver),
      operatorName: adminDriverLabel(driver),
      sourceModule: "pendientes",
      status: "active",
      debtStatus: "active",
      acknowledgedByDriver: false,
      driverConfirmationRequired: true,
      driverConfirmationVersion: 1,
      createdByRole: "admin",
      registeredByAdmin: true,
      registrationOrigin: "admin_debt_menu",
      driverDebtBalanceBefore: debtBalanceBefore,
      driverDebtBalanceAfter: debtBalanceBefore + amount,
      telegramSettlementBeforeBalance: settlementBeforeDebt,
      telegramSettlementAfterBalance: settlementAfterDebt,
      telegramSettlementPayer: settlementAfterDebt > 0.5 ? "driver" : settlementAfterDebt < -0.5 ? "explora" : "balanced",
      businessId: BUSINESS_ID,
      createdByUid: admin.uid,
      createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    });

    await writeAdminAudit("admin_add_driver_debt", {
      targetUid: driver.id,
      targetName: adminDriverLabel(driver),
      debtId: debtRef.id,
      amount,
      detail,
      proofUrl
    });

    $("debtStatus").textContent = `Deuda de ${money(amount)} agregada a ${adminDriverLabel(driver)}.`;
    $("debtStatus").className = "status success";
    setTimeout(() => $("debtModal").classList.add("hidden"), 900);
  } catch (err) {
    console.error(err);
    $("debtStatus").textContent = "No se pudo registrar la deuda.";
    $("debtStatus").className = "status error";
  } finally {
    $("saveDebtBtn").disabled = false;
    $("saveDebtBtn").textContent = "Registrar deuda";
  }
});



$("adminAdjustmentForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile()) return;

  const driver = adminDriverById($("adjustmentDriver").value);
  const movementType = $("adjustmentType").value;
  const amount = parseMoneyInput($("adjustmentAmount").value);
  const detail = $("adjustmentDetail").value.trim();
  const file = $("adjustmentProof").files?.[0];
  const status = $("adminAdjustmentStatus");
  const button = $("saveAdminAdjustmentBtn");

  if (!driver) {
    status.textContent = "Seleccioná un chofer.";
    status.className = "status error";
    return;
  }
  if (!amount || amount <= 0) {
    status.textContent = "Ingresá un importe válido.";
    status.className = "status error";
    return;
  }
  if (!detail) {
    status.textContent = "Indicá el motivo del movimiento.";
    status.className = "status error";
    return;
  }
  if (!file) {
    status.textContent = "Adjuntá el comprobante.";
    status.className = "status error";
    return;
  }

  if (movementType === "debt_payment") {
    const debtTotal = adminOpenDebtTotalForDriver(driver);
    if (debtTotal <= 0.5) {
      status.textContent = `${adminDriverLabel(driver)} no tiene deuda pendiente.`;
      status.className = "status error";
      return;
    }
    if (amount > debtTotal + 0.5) {
      status.textContent = `El pago no puede superar la deuda pendiente de ${money(debtTotal)}.`;
      status.className = "status error";
      return;
    }
  }

  button.disabled = true;
  button.textContent = "Guardando…";
  status.textContent = "";

  try {
    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const folder = movementType === "debt_payment" ? "deudas" : "billing_receipts";
    const proofPath = movementType === "debt_payment"
      ? `${folder}/${driver.id}/pagos/${localDayKey()}_${Date.now()}_${cleanName}`
      : `${folder}/${driver.id}/admin_${localDayKey()}_${Date.now()}_${cleanName}`;
    const storageRef = ref(storage, proofPath);
    await uploadBytes(storageRef, file);
    const proofUrl = await getDownloadURL(storageRef);

    if (movementType === "debt_payment") {
      const localDebts = adminOpenDebtItemsForDriver(driver);
      const debtRefs = localDebts.map(item => doc(db, ROOT_COLLECTIONS.debts, item.id));
      const paymentRef = doc(collection(db, ROOT_COLLECTIONS.debtPayments));

      await runTransaction(db, async transaction => {
        const snapshots = [];
        for (const debtRef of debtRefs) snapshots.push(await transaction.get(debtRef));

        let remainingPayment = amount;
        const allocations = [];

        for (const snap of snapshots) {
          if (!snap.exists() || remainingPayment <= 0.5) continue;
          const data = snap.data() || {};
          const statusText = String(data.status || data.debtStatus || "").toLowerCase();
          if (/paid|pagad|closed|cerrad|cancel|anulad|deleted|eliminad/.test(statusText)) continue;

          const currentRemaining = Math.max(0, Number(data.remainingAmount ?? data.saldoPendiente ?? data.amount ?? data.totalAmount ?? 0) || 0);
          if (currentRemaining <= 0.5) continue;
          const applied = Math.min(currentRemaining, remainingPayment);
          const nextRemaining = Math.max(0, currentRemaining - applied);
          const previousPaid = Math.max(0, Number(data.paidAmount ?? data.amountPaid ?? 0) || 0);
          const nextPaid = previousPaid + applied;

          transaction.update(snap.ref, {
            remainingAmount: nextRemaining,
            saldoPendiente: nextRemaining,
            paidAmount: nextPaid,
            amountPaid: nextPaid,
            status: nextRemaining <= 0.5 ? "paid" : "active",
            debtStatus: nextRemaining <= 0.5 ? "paid" : "active",
            lastPaymentAt: serverTimestamp(),
            lastPaymentAtMs: Date.now(),
            lastPaymentMethod: "admin_registered_payment",
            updatedAt: serverTimestamp(),
            updatedAtMs: Date.now()
          });

          allocations.push({ debtId: snap.id, amount: applied });
          remainingPayment -= applied;
        }

        transaction.set(paymentRef, {
          type: "admin_debt_payment",
          operationType: "debt_payment",
          paymentMethod: "admin_registered_payment",
          amount,
          monto: amount,
          detail,
          notes: detail,
          allocations,
          proofUrl,
          proofPath,
          receiptUrl: proofUrl,
          receiptPath: proofPath,
          driverUid: driver.id,
          choferUid: driver.id,
          uid: driver.id,
          ownerUid: driver.id,
          driverId: driver.id,
          operatorUid: driver.id,
          driverName: adminDriverLabel(driver),
          operatorName: adminDriverLabel(driver),
          sourceModule: "pendientes",
          createdByUid: admin.uid,
          createdByRole: "admin",
          createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
          businessId: BUSINESS_ID,
          dayKey: localDayKey(),
          createdAtMs: Date.now(),
          createdAt: serverTimestamp()
        });
      });

      await writeAdminAudit("admin_register_driver_debt_payment", {
        targetUid: driver.id,
        targetName: adminDriverLabel(driver),
        amount,
        detail,
        proofUrl
      });

      status.textContent = `Pago de deuda de ${money(amount)} registrado para ${adminDriverLabel(driver)}.`;
    } else {
      const direction = movementType === "explora_to_driver" ? "explora_to_driver" : "driver_to_explora";
      const method = direction === "explora_to_driver" ? "cash" : "digital";
      const service = direction === "explora_to_driver" ? "Ajuste de Explora" : "Ajuste del chofer";
      const paymentRef = await addDoc(collection(db, ROOT_COLLECTIONS.payments), {
        method,
        paymentMethod: "admin_manual_adjustment",
        metodoPago: "admin_manual_adjustment",
        financialCategory: "admin_manual_adjustment",
        type: "settlement_adjustment",
        operationType: "settlement_adjustment",
        sourceModule: "facturacion",
        affectsBillingSettlement: true,
        adjustmentDirection: direction,
        internalSettlementAdjustment: true,
        excludeFromBillingSettlement: true,
        suppressTelegram: true,
        amount,
        monto: amount,
        service,
        detail,
        notes: detail,
        proofUrl,
        proofPath,
        receiptUrl: proofUrl,
        receiptPath: proofPath,
        dayKey: localDayKey(),
        weeklyPeriodId: currentWeeklyPeriodId(),
        driverUid: driver.id,
        choferUid: driver.id,
        uid: driver.id,
        ownerUid: driver.id,
        driverId: driver.id,
        operatorUid: driver.id,
        driverName: adminDriverLabel(driver),
        operatorName: adminDriverLabel(driver),
        createdByUid: admin.uid,
        createdByRole: "admin",
        createdByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
        businessId: BUSINESS_ID,
        createdAtMs: Date.now(),
        createdAt: serverTimestamp()
      });

      await writeAdminAudit("admin_register_billing_adjustment", {
        targetUid: driver.id,
        targetName: adminDriverLabel(driver),
        paymentId: paymentRef.id,
        direction,
        amount,
        detail,
        proofUrl
      });

      status.textContent = `${service} por ${money(amount)} registrado para ${adminDriverLabel(driver)}.`;
    }

    status.className = "status success";
    $("adminAdjustmentForm").reset();
    renderAdminDriverOptions();
    setTimeout(() => $("adminAdjustmentModal").classList.add("hidden"), 1100);
  } catch (err) {
    console.error(err);
    status.textContent = "No se pudo registrar el movimiento.";
    status.className = "status error";
  } finally {
    button.disabled = false;
    button.textContent = "Registrar movimiento";
  }
});

async function annulAdminDebt(debtId = "") {
  const admin = auth.currentUser;
  if (!admin || !isAdminProfile() || !debtId) return;

  const debt = adminDebts.find(item => item.id === debtId);
  if (!debt || Number(debt.amount || 0) <= 0.5) return;

  const reason = window.prompt("Motivo de la anulación de la deuda:");
  if (!String(reason || "").trim()) return;

  const status = $("adminHistoryStatus");
  status.textContent = "Anulando deuda…";
  status.className = "status";

  try {
    const debtRef = doc(db, ROOT_COLLECTIONS.debts, debtId);
    await setDoc(debtRef, {
      remainingAmount: 0,
      saldoPendiente: 0,
      status: "anulado",
      debtStatus: "anulado",
      annulledReason: String(reason).trim(),
      annulledByUid: admin.uid,
      annulledByName: currentProfile?.displayName || currentProfile?.username || "Administrador",
      annulledAtMs: Date.now(),
      annulledAt: serverTimestamp(),
      updatedAtMs: Date.now(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    await writeAdminAudit("admin_annul_driver_debt", {
      targetUid: debt.operatorUid || debt.driverUid || debt.uid || "",
      debtId,
      originalAmount: Number(debt.totalAmount || debt.amount || 0),
      reason: String(reason).trim()
    });

    status.textContent = "Deuda anulada. El movimiento quedó registrado en el historial.";
    status.className = "status success";
  } catch (err) {
    console.error(err);
    status.textContent = "No se pudo anular la deuda.";
    status.className = "status error";
  }
}

$("expenseForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  if ($("saveExpenseBtn").disabled) return;
  const step = Number($("expenseForm").dataset.step || 0);
  if (!validateExpenseStep(step)) return;
  if (step < 2) { showExpenseStep(step + 1); return; }
  for (const requiredStep of [0,1,2]) if (!validateExpenseStep(requiredStep)) return;
  const user = auth.currentUser;
  if (!user) { $("expenseStatus").textContent = "Iniciá sesión antes de guardar."; return; }
  const type = ExploraExpensePolicy.find($("expenseType").value);
  await submitOperationalMovement({kind:$("expenseEntryKind").value === "debt" ? "debt" : "expense", user,
    file:selectedPhotoFile("expense"), fields:{amount:parseMoneyInput($("expenseAmount").value),
    detail:$("expenseDetail").value.trim() || type.label, expenseType:type.id}});
});

function parseUberAmount(value) {
  const text = String(value || '').replace(/[^0-9.,]/g,'');
  if (!text) return 0;
  const normalized = text.includes(',') ? text.replace(/\./g,'').replace(',','.') : /\.\d{3}(?:\.\d{3})*$/.test(text) ? text.replace(/\./g,'') : text;
  return Number(normalized);
}
let uberStep = 0;
let uberProofCheck = null;
let uberScanBusy = false;
let uberProofPreviewUrl = "";
function renderUberStep(step = uberStep) {
  uberStep = step;
  document.querySelectorAll("[data-uber-step]").forEach(panel => panel.classList.toggle("hidden", Number(panel.dataset.uberStep) !== step));
  $("uberStepLabel").textContent = "Paso " + (step + 1) + " de 3 · " + ["Monto", "Captura", "Movimientos"][step];
  $("uberStepTrack").innerHTML = [0,1,2].map(index => '<span class="' + (index <= step ? 'complete' : '') + '"></span>').join("");
  $("uberStepBack").textContent = step ? "Atrás" : "Cancelar";
  $("saveUberBtn").textContent = step === 2 ? "Registrar liquidación" : "Continuar";
  const week = selectedPendingUberWeek();
  $("uberWeekCaption").textContent = week ? "Semana del " + week.label : "Sin semanas pendientes";
  $("uberProofWeek").textContent = week ? "Captura de la semana del " + week.label : "";
  $("uberExampleWeek").textContent = week ? week.label : "Semana anterior";
  $("uberExampleAmount").textContent = money(parseUberAmount($("uberGrossAmount").value) || 100000);
  $("uberStatus").textContent = "";
  if (step === 2) renderUberAccountPreview();
}
function renderUberAccountPreview() {
  const amount = parseUberAmount($("uberGrossAmount").value) || 0;
  const destination = $("uberMoneyHolder")?.value || "cash";
  const before = previewSettlementBalance("uber");
  const delta = previewDefinition("uber", amount, {destination}).delta;
  const after = normalizedSettlementBalance(before + delta);
  $("uberPrincipalPreview").innerHTML = `<div><span>Antes</span><small>${escapeHtml(receiptBalanceLabel(before))}</small></div><div><span>Impacto</span><strong>${signedMoney(delta)}</strong></div><div><span>Después</span><small>${escapeHtml(receiptBalanceLabel(after))}</small></div>`;
  $("uberCashboxPreview").innerHTML = "<p>"+(destination === "digital" ? "Dinero digital recibido por Explora." : "Dinero en poder del chofer.")+" Se integra al disponible del período. No modifica el saldo hasta confirmar.</p>";
}
async function uberPhotoAsJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const picture = new Image(); picture.src = url;
    await picture.decode();
    const scale = Math.min(1, 2200 / Math.max(picture.naturalWidth, picture.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(picture.naturalWidth * scale); canvas.height = Math.round(picture.naturalHeight * scale);
    const context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0,0,canvas.width,canvas.height); context.drawImage(picture,0,0,canvas.width,canvas.height);
    return canvas.toDataURL("image/jpeg",0.94).split(",")[1];
  } finally { URL.revokeObjectURL(url); }
}
async function verifyUberPhoto(file, week, amount) {
  uberScanBusy = true;
  $("saveUberBtn").disabled = true;
  $("uberStepBack").disabled = true;
  setPhotoPickerDisabled("uber",true);
  $("uberScanFeedback").textContent = "Leyendo la semana y el total de la captura…";
  $("uberScanExample").classList.add("hidden");
  try {
    const image = await uberPhotoAsJpeg(file);
    const {data} = await httpsCallable(functions,"verifyUberScreenshot",{timeout:90000})({image,amount,weekStartDate:week.weekStartDate,weekCloseDate:week.weekCloseDate});
    if (file !== selectedPhotoFile("uber") || amount !== parseUberAmount($("uberGrossAmount").value) || week.weekStartDate !== selectedPendingUberWeek()?.weekStartDate) return false;
    if (!data.valid) {
      uberProofCheck = null;
      $("uberScanFeedback").textContent = data.reason;
      $("uberScanExample").classList.remove("hidden");
      return false;
    }
    uberProofCheck = {...data,checkedAt:Date.now()};
    $("uberScanFeedback").textContent = "Semana y total coinciden.";
    return true;
  } catch (error) {
    uberProofCheck = null;
    $("uberScanFeedback").textContent = "No pudimos verificar la captura. Subí una imagen nítida de la semana indicada y volvé a intentarlo.";
    $("uberScanExample").classList.remove("hidden");
    return false;
  } finally {
    uberScanBusy = false;
    $("saveUberBtn").disabled = false;
    $("uberStepBack").disabled = false;
    setPhotoPickerDisabled("uber",false);
  }
}
$("uberReplacePhoto")?.addEventListener("click", () => $("uberProof").click());
$("uberGrossAmount")?.addEventListener("input", () => { uberProofCheck = null; });
$("uberStepBack")?.addEventListener("click", () => {
  if ($("saveUberBtn").disabled) return;
  if (uberStep) renderUberStep(uberStep - 1);
  else $("uberModal").classList.add("hidden");
});
function refreshUberProofPreview() {
  uberProofCheck = null;
  $("uberScanFeedback").textContent = "";
  if (uberProofPreviewUrl) URL.revokeObjectURL(uberProofPreviewUrl);
  const file = selectedPhotoFile("uber");
  uberProofPreviewUrl = file && file.type.startsWith("image/") ? URL.createObjectURL(file) : "";
  const preview = $("uberProofPreview");
  preview.classList.toggle("hidden", !uberProofPreviewUrl);
  if (uberProofPreviewUrl) preview.src = uberProofPreviewUrl;
  else preview.removeAttribute("src");
}
photoPicker("uber")?.addEventListener("change", refreshUberProofPreview);
$("uberForm")?.addEventListener("reset", () => setTimeout(refreshUberProofPreview, 0));

$("addUberBtn")?.addEventListener("click", () => {
  operationalNotice("Los viajes de Uber se registran como Cobro efectivo.");
  return;
  $("uberForm").reset();
  delete $("uberForm").dataset.previewConfirmed;
  $("uberStatus").textContent = "";
  $("uberStatus").className = "status";
  renderUberWeekSelector();
  if (!selectedPendingUberWeek() || dashboardLoad?.complete() !== true) return;
  renderUberStep(0);
  $("uberModal").classList.remove("hidden");
});

$("uberWeekSelect")?.addEventListener("change", updateUberWeekSummary);

$("openUberHelpBtn")?.addEventListener("click", () => {
  $("uberHelpModal")?.classList.remove("hidden");
});

$("closeUberHelpBtn")?.addEventListener("click", () => {
  $("uberHelpModal")?.classList.add("hidden");
});

$("uberForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;

  const week = selectedPendingUberWeek();
  const amount = parseUberAmount($("uberGrossAmount")?.value || "");
  const file = selectedPhotoFile("uber");
  if (uberScanBusy) return;
  if (dashboardLoad?.complete() !== true) return;
  if (!week) {
    $("uberStatus").textContent = "Elegí una semana cerrada pendiente.";
    $("uberStatus").className = "status error";
    renderUberWeekSelector();
    return;
  }
  if (!(amount > 0)) {
    $("uberStatus").textContent = "Ingresá las ganancias netas que muestra Uber.";
    $("uberStatus").className = "status error";
    return;
  }
  if (uberStep === 0) { renderUberStep(1); return; }
  if (!file) {
    $("uberStatus").textContent = "Adjuntá el comprobante semanal de Uber.";
    $("uberStatus").className = "status error";
    return;
  }
  if (!String(file.type || "").startsWith("image/")) {
    $("uberStatus").textContent = "El comprobante debe ser una imagen.";
    $("uberStatus").className = "status error";
    return;
  }
  if (Number(file.size || 0) > 15 * 1024 * 1024) {
    $("uberStatus").textContent = "La imagen es demasiado grande. Elegí una foto de hasta 15 MB.";
    $("uberStatus").className = "status error";
    return;
  }
  if (uberStep === 1) {
    if (await verifyUberPhoto(file, week, amount)) renderUberStep(2);
    return;
  }
  if (!uberProofCheck || uberProofCheck.amount !== amount || uberProofCheck.weekStartDate !== week.weekStartDate || Date.now() - uberProofCheck.checkedAt > 3500000) {
    renderUberStep(1);
    $("uberScanFeedback").textContent = "Volvé a verificar la captura antes de registrar.";
    return;
  }
  if (!acquireSubmissionLock("uber")) {
    $("uberStatus").textContent = "Este cierre ya se está enviando.";
    $("uberStatus").className = "status";
    return;
  }

  $("saveUberBtn").disabled = true;
  setPhotoPickerDisabled("uber", true);
  $("saveUberBtn").textContent = "Subiendo comprobante…";
  $("uberStatus").textContent = "";

  try {
    if (isUberWeekLoaded(week)) {
      $("uberStatus").textContent = `La semana ${week.label} ya está registrada.`;
      $("uberStatus").className = "status error";
      renderUberWeekSelector();
      return;
    }

    $("saveUberBtn").textContent = "Registrando liquidación…";
    const {data:result} = await httpsCallable(functions,"registerUberLiquidation",{timeout:90000})({
      verifiedProofId:uberProofCheck.id, amount, destination:$("uberMoneyHolder").value, weekStartDate:week.weekStartDate, weekCloseDate:week.weekCloseDate
    });
    const saved = normalizeUberRecord(result.id,result.record);
    uberClosures = [saved, ...uberClosures.filter(item => item.id !== result.id)];
    render();

    renderUberWeekSelector();
    const remaining = pendingUberWeeks().length;
    $("uberStatus").textContent = remaining
      ? `Liquidación registrada. Quedan ${remaining} ${remaining === 1 ? "semana pendiente" : "semanas pendientes"}.`
      : `Liquidación registrada. El total y la caja chica ya se aplicaron a tu saldo.`;
    $("uberStatus").className = "status success";
    $("saveUberBtn").textContent = "Registrado ✓";
    $("uberForm").reset();
    if (!remaining) closeModalAndGoTop("uberModal");
  } catch (err) {
    console.error(err);
    const code = firebaseErrorCode(err);
    if (code.includes("permission-denied") || code.includes("storage/unauthorized")) {
      $("uberStatus").textContent = "No pudimos registrar la liquidación. Verificá nuevamente la captura y volvé a intentar.";
    } else if (code.includes("already-exists")) {
      $("uberStatus").textContent = `La semana ${week.label} ya está registrada.`;
    } else if (code.includes("failed-precondition")) {
      renderUberStep(1);
      $("uberStatus").textContent = "La captura o la semana ya no están vigentes. Verificá nuevamente antes de registrar.";
    } else {
      $("uberStatus").textContent = "No se pudo registrar la liquidación de Uber. Podés reintentar sin duplicarla.";
    }
    $("uberStatus").className = "status error";
  } finally {
    releaseSubmissionLock("uber");
    setPhotoPickerDisabled("uber", false);
    $("saveUberBtn").disabled = pendingUberWeeks().length === 0;
    if (!$("saveUberBtn").disabled) $("saveUberBtn").textContent = uberStep === 2 ? "Registrar liquidación" : "Continuar";
  }
});

function resetDriverClose() {
  selectedCloseDirection = "";
  selectedDriverClosePaymentMethod = "cash";
  $("driverCloseForm").reset();
  $("driverCloseForm").classList.add("hidden");
  $("driverCloseAmountField").classList.add("hidden");
  $("driverClosePaymentPreview")?.classList.add("hidden");
  $("driverClosePaymentMethodField")?.classList.add("hidden");
  $("driverClosePaymentInstruction")?.classList.add("hidden");
  $("driverCloseProofField").classList.add("hidden");
  $("exploraTransferData")?.classList.add("hidden");
  $("driverCollectBankFields")?.classList.add("hidden");
  $("adminProofNotice").classList.add("hidden");
  $("driverCloseProof").required = false;
  $("driverCollectAlias").required = false;
  $("driverCollectCuit").required = false;
  $("closeStatus").textContent = "";
  $("closeStatus").className = "status";
  document.querySelectorAll("[data-driver-close-payment-method]").forEach(button => {
    const selected = button.dataset.driverClosePaymentMethod === "cash";
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function updateDriverClosePreview() {
  const model = settlementModel();
  const preview = $("driverClosePaymentPreview");
  if (!preview || !selectedCloseDirection) return;

  if (selectedCloseDirection === "explora_to_driver") {
    $("driverCloseCurrentBalanceLabel").textContent = "Total que tenés para cobrar";
    $("driverClosePaymentAmountLabel").textContent = "Explora te pagará";
    $("driverCloseNewBalanceLabel").textContent = "Nuevo saldo después de confirmar";
    $("driverCloseCurrentBalance").textContent = money(model.amount);
    $("driverClosePaymentAmountPreview").textContent = money(model.amount);
    $("driverCloseNewBalance").textContent = `${money(0)} · Equilibrado`;
    preview.classList.remove("hidden");
    return;
  }

  const amount = parseMoneyInput($("driverCloseAmount")?.value || "");
  const newBalance = Math.max(0, model.amount - Math.min(amount, model.amount));
  $("driverCloseCurrentBalanceLabel").textContent = "Deuda actual";
  $("driverClosePaymentAmountLabel").textContent = "Dinero que vas a entregar";
  $("driverCloseNewBalanceLabel").textContent = "Nuevo saldo después de confirmar";
  $("driverCloseCurrentBalance").textContent = money(model.amount);
  $("driverClosePaymentAmountPreview").textContent = money(amount);
  $("driverCloseNewBalance").textContent = newBalance <= 0.5 ? `${money(0)} · Equilibrado` : money(newBalance);
  preview.classList.remove("hidden");
}

function setDriverClosePaymentMethod(method) {
  if (selectedCloseDirection !== "driver_to_explora") return;
  selectedDriverClosePaymentMethod = method === "transfer" ? "transfer" : "cash";
  const transfer = selectedDriverClosePaymentMethod === "transfer";
  document.querySelectorAll("[data-driver-close-payment-method]").forEach(button => {
    const selected = button.dataset.driverClosePaymentMethod === selectedDriverClosePaymentMethod;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  const instruction = $("driverClosePaymentInstruction");
  instruction.textContent = transfer
    ? "Enviá primero el dinero por transferencia y después subí aquí el comprobante."
    : "Dale el efectivo en mano a David. El saldo cambiará cuando David confirme que lo recibió.";
  instruction.classList.remove("hidden");
  $("exploraTransferData")?.classList.toggle("hidden", !transfer);
  $("driverCloseProofField")?.classList.toggle("hidden", !transfer);
  $("driverCloseProof").required = transfer;
}

function prepareDriverClose() {
  resetDriverClose();
  const model = settlementModel();

  if (model.from === "balanced") {
    $("closeBalanceMessage").innerHTML = `<strong>Las cuentas ya están equilibradas.</strong><span>No hay ningún importe pendiente para pagar ni cobrar.</span>`;
    return;
  }

  if (model.from === "cash") {
    selectedCloseDirection = "driver_to_explora";
    $("closeBalanceMessage").innerHTML = `<strong>Actualmente debés ${money(model.amount)} a Explora.</strong><span>Ingresá cuánto dinero querés usar para achicar la deuda.</span>`;
    $("driverCloseSelected").innerHTML = `<small>Achicar deuda</small><strong>${money(model.amount)} pendientes</strong><span>Podés pagar una parte o usar el total. El movimiento impactará recién cuando el administrador lo confirme.</span>`;
    $("driverCloseForm").classList.remove("hidden");
    $("driverCloseAmountField").classList.remove("hidden");
    $("driverClosePaymentMethodField")?.classList.remove("hidden");
    $("driverCloseLimit").textContent = `Podés ingresar entre $1 y ${money(model.amount)}.`;
    $("adminProofNotice").classList.remove("hidden");
    $("confirmClose").textContent = "Aceptar pago";
    setDriverClosePaymentMethod("cash");
    updateDriverClosePreview();
  } else {
    selectedCloseDirection = "explora_to_driver";
    $("closeBalanceMessage").innerHTML = `<strong>Tenés ${money(model.amount)} para cobrar a Explora.</strong><span>Completá tu CUIT y alias. Se solicitará el total completo.</span>`;
    $("driverCloseSelected").innerHTML = `<small>Solicitar cobro</small><strong>${money(model.amount)} a cobrar</strong><span>Cuando el administrador realice y confirme el pago, el nuevo saldo quedará equilibrado en ${money(0)}.</span>`;
    $("driverCloseForm").classList.remove("hidden");
    $("driverCollectBankFields").classList.remove("hidden");
    $("driverCollectAlias").required = true;
    $("driverCollectCuit").required = true;
    $("adminProofNotice").classList.remove("hidden");
    $("confirmClose").textContent = "Enviar solicitud de cobro";
    updateDriverClosePreview();
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
  $("adminPaymentSummary").innerHTML = `<small>Explora paga a</small><strong>${escapeHtml(item.operatorName || "Chofer")} · ${money(remaining)}</strong><span>Alias: ${escapeHtml(item.recipientAlias || "No informado")} · CUIT: ${escapeHtml(formatCuit(item.recipientCuit || ""))}</span>`;
  $("adminPaymentStatus").textContent = "";
  $("adminPaymentStatus").className = "status";
  $("adminClosureList").classList.add("hidden");
  $("adminPaymentForm").classList.remove("hidden");
}

$("closeDayBtn")?.addEventListener("click", () => {
  if (!isAdminProfile()) { openClosureReport(); return; }
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

$("driverClosePaymentMethodField")?.addEventListener("click", event => {
  const button = event.target.closest("[data-driver-close-payment-method]");
  if (button) setDriverClosePaymentMethod(button.dataset.driverClosePaymentMethod);
});
$("driverCloseAmount")?.addEventListener("input", updateDriverClosePreview);
$("driverCollectCuit")?.addEventListener("input", event => {
  event.target.value = formatCuitInput(event.target.value);
});
$("driverUseFullAmount")?.addEventListener("click", () => {
  const model = settlementModel();
  setMoneyInput("driverCloseAmount", model.amount);
  updateDriverClosePreview();
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
  const driverPaymentMethod = selectedDriverClosePaymentMethod === "transfer" ? "transfer" : "cash";
  const amount = isDriverPayment ? parseMoneyInput($("driverCloseAmount").value) : model.amount;
  const file = $("driverCloseProof").files?.[0];
  const recipientAlias = !isDriverPayment ? String($("driverCollectAlias")?.value || "").trim() : "";
  const recipientCuitDigits = !isDriverPayment ? String($("driverCollectCuit")?.value || "").replace(/\D/g, "") : "";
  if (!amount || amount <= 0 || amount > model.amount + 0.5) {
    $("closeStatus").textContent = `Ingresá un importe entre $1 y ${money(model.amount)}.`;
    $("closeStatus").className = "status error";
    return;
  }
  if (isDriverPayment && driverPaymentMethod === "transfer" && !file) {
    $("closeStatus").textContent = "Primero transferí el dinero y después adjuntá el comprobante.";
    $("closeStatus").className = "status error";
    return;
  }
  if (!isDriverPayment && recipientAlias.length < 3) {
    $("closeStatus").textContent = "Ingresá el alias donde querés recibir el dinero.";
    $("closeStatus").className = "status error";
    return;
  }
  if (!isDriverPayment && recipientCuitDigits.length !== 11) {
    $("closeStatus").textContent = "Ingresá un CUIT válido de 11 dígitos.";
    $("closeStatus").className = "status error";
    return;
  }
  const alreadyPendingAnyClosure = closures.some(item =>
    item.operatorUid === user.uid && /awaiting_admin|pending_admin/.test(String(item.status || "").toLowerCase())
  );
  if (alreadyPendingAnyClosure) {
    $("closeStatus").textContent = "Ya tenés un cierre pendiente de resolución por Admin.";
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

    if (isDriverPayment) {
      if (driverPaymentMethod === "transfer") {
        const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
        proofPath = `cierres_semanales/${currentWeeklyPeriodId()}/${user.uid}/${closureRef.id}_${Date.now()}_${cleanName}`;
        const storageRef = ref(storage, proofPath);
        await uploadBytes(storageRef, file);
        proofUrl = await getDownloadURL(storageRef);
      }
      const closureNowMs = Date.now();
      const projectedRemainingAmount = Math.max(0, model.amount - amount);
      await setDoc(closureRef, {
        direction: "driver_pays_explora",
        paymentDirection: "driver_to_explora",
        paymentMethod: driverPaymentMethod,
        method: driverPaymentMethod,
        metodoPago: driverPaymentMethod,
        financialCategory: driverPaymentMethod,
        receiptRequired: driverPaymentMethod === "transfer",
        receiptStatus: driverPaymentMethod === "transfer" ? "uploaded" : "not_required",
        requestedAmount: model.amount,
        settlementAmount: model.amount,
        requestedPaymentAmount: amount,
        projectedRemainingAmount,
        projectedBalanceAfterApproval: projectedRemainingAmount,
        paidAmountTotal: 0,
        remainingAmount: model.amount,
        amountDueFromDriver: model.amount,
        amountFromDriver: model.amount,
        amountDueToDriver: 0,
        amountToDriver: 0,
        gross: model.grand, grossAmount: model.grand, expenseTotal: model.expense, cashboxTotal: model.cashBox,
        proofUrl, proofPath, receiptUrl: proofUrl, receiptPath: proofPath,
        proofUploadedByUid: proofUrl ? user.uid : "", proofUploadedByRole: proofUrl ? "driver" : "",
        transferAlias: EXPLORA_TRANSFER_ALIAS,
        transferCuit: EXPLORA_CUIT,
        detail: driverPaymentMethod === "transfer" ? "Pago de cierre por transferencia" : "Pago de cierre en efectivo",
        notes: projectedRemainingAmount <= 0.5 ? "Pago total pendiente de confirmación" : "Pago parcial pendiente de confirmación",
        status: "awaiting_admin_review",
        reviewStatus: "pending",
        dayKey: localDayKey(), weeklyPeriodId: currentWeeklyPeriodId(),
        closureKind: "facturacion", closureType: "facturacion", moduleKey: "facturacion", payTab: "facturacion", billingClosure: true,
        closureMode: "settlement_only", autoClosesCashbox: false, cashboxClosedWithBilling: false, affectsTabs: ["chofer", "explora"],
        cashTotal: model.cash, uberTotal: model.uber, debtTotal: model.adminDebt + model.advanceDebt, advanceDebtTotal: model.advanceDebt,
        cashBox5: model.cashBox, digitalTotal: model.digital, expensesTotal: model.expense, total: model.grand,
        driverUid: user.uid, choferUid: user.uid, uid: user.uid, driverName: currentDriverName(),
        operatorUid: user.uid, operatorName: currentProfile?.displayName || currentProfile?.username || "",
        requestedByUid: user.uid, requestedByRole: "driver", createdByUid: user.uid, createdByRole: "driver", businessId: BUSINESS_ID,
        cutoffAtMs: closureNowMs, requestedAtMs: closureNowMs, createdAtMs: closureNowMs, requestedAt: serverTimestamp(), createdAt: serverTimestamp()
      });
      $("closeStatus").textContent = driverPaymentMethod === "transfer"
        ? "Transferencia enviada a Admin con su comprobante. El saldo cambiará cuando sea confirmada."
        : "Entrega en efectivo enviada a Admin. El saldo cambiará cuando David confirme que la recibió.";
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
        projectedRemainingAmount: 0,
        projectedBalanceAfterApproval: 0,
        gross: model.grand,
        grossAmount: model.grand,
        expenseTotal: model.expense,
        cashboxTotal: model.cashBox,
        status: "awaiting_admin_payment",
        reviewStatus: "pending",
        recipientAlias,
        recipientCuit: recipientCuitDigits,
        detail: "El chofer solicita cobrar el total pendiente",
        notes: "Solicitud de cobro pendiente de confirmación del administrador",
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
      $("closeStatus").textContent = "Solicitud de cobro enviada a Telegram y al administrador. El saldo quedará equilibrado cuando se confirme el pago.";
    }
    $("closeStatus").className = "status success";
    setTimeout(() => $("closeModal").classList.add("hidden"), 1500);
  } catch (err) {
    console.error(err);
    $("closeStatus").textContent = "No se pudo registrar el cierre.";
    $("closeStatus").className = "status error";
  } finally {
    $("confirmClose").disabled = false;
    $("confirmClose").textContent = isDriverPayment ? "Aceptar pago" : "Enviar solicitud de cobro";
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
      reviewStatus: newRemaining <= 0.5 ? "completed" : "approved_partial",
      actionedByAdminUid: admin.uid,
      actionedByAdminName: currentProfile?.displayName || currentProfile?.username || "Administrador",
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
      adminDismissedPendingActionIds.add(`closure:${item.id}`);
      adminPendingAction = null;
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

// Si Admin cerró un pedido sin resolverlo y la PWA vuelve desde segundo plano,
// se vuelve a habilitar el aviso automático. Así el pedido no queda olvidado.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    adminDismissedPendingActionIds.clear();
    return;
  }
  if (isAdminProfile()) setTimeout(maybeShowAdminPendingAction, 120);
});
window.addEventListener("pageshow", () => {
  if (isAdminProfile()) setTimeout(maybeShowAdminPendingAction, 120);
});

const closePeriodCallable = httpsCallable(functions,"closeOperationalPeriodV319",{timeout:125000});
let closureReportSnapshot = null;
let closureReportFileUrl = "";
let closureRequestId = "";
function newClosureRequestId(){
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return "closure_"+[...bytes].map(v=>v.toString(16).padStart(2,"0")).join("");
}
function clearClosureReportFile(){
  if(closureReportFileUrl)URL.revokeObjectURL(closureReportFileUrl);
  closureReportFileUrl="";
  $("closureReportActions")?.replaceChildren();
}
function createClosureReportFile(snapshot){
  clearClosureReportFile();
  const bytes=createClosurePdf(snapshot);
  if(!(bytes instanceof Uint8Array)||new TextDecoder().decode(bytes.slice(0,5))!=="%PDF-")throw new Error("No se pudo preparar el PDF del cierre.");
  const file=new File([bytes],`${snapshot.documentNumber}.pdf`,{type:"application/pdf"});
  closureReportFileUrl=URL.createObjectURL(file);
  const actions=$("closureReportActions");
  const open=document.createElement("a");open.href=closureReportFileUrl;open.target="_blank";open.rel="noopener";open.className="primary";open.textContent="Abrir PDF";
  const save=document.createElement("a");save.href=closureReportFileUrl;save.download=file.name;save.className="secondary";save.textContent="Guardar PDF";
  actions.append(open,save);
  if(navigator.canShare?.({files:[file]})){const share=document.createElement("button");share.type="button";share.className="secondary";share.textContent="Compartir PDF";share.addEventListener("click",async()=>{try{await navigator.share({files:[file],title:file.name});}catch(error){if(error.name!=="AbortError")$("closureReportStatus").textContent="Usá Abrir PDF o Guardar PDF.";}});actions.append(share);}
  return file;
}
function closureProofReady(){
  const file=selectedPhotoFile("closure");
  return Boolean(file && String(file.type||"").startsWith("image/") && file.size>0 && file.size<=15*1024*1024);
}
function updateClosureProofState(){
  const button=$("generateClosureReport");
  const file=selectedPhotoFile("closure");
  if(!button)return;
  if(file && !closureProofReady()){
    $("closureReportStatus").textContent="El comprobante debe ser una foto JPG, PNG o WebP de hasta 15 MB.";
    $("closureReportStatus").className="status error";
    button.disabled=true;
    return;
  }
  button.disabled=!closureProofReady();
  if(closureProofReady() && !$("closureReportStatus")?.classList.contains("success")){
    const amount=Math.abs(Number(closureReportSnapshot?.reconciliation?.balanceBefore)||0);
    $("closureReportStatus").textContent=amount>0.005
      ? `Comprobante listo. Al confirmar se liquidarán ${money(amount)} y la cuenta quedará en $0.`
      : "Comprobante listo. Al confirmar se cerrará el período con saldo $0.";
    $("closureReportStatus").className="status";
  }
}
function openClosureReport(){
  const user=auth.currentUser;if(!user)return;
  clearClosureReportFile();
  clearPhotoPicker("closure");
  setPhotoPickerDisabled("closure",false);
  closureRequestId=newClosureRequestId();
  closureReportSnapshot=buildClosurePreview({model:settlementModel(),driverName:currentDriverName(),driverUid:user.uid,createdAtMs:Date.now()});
  $("closureReportContent").innerHTML=closureReportHtml(closureReportSnapshot);
  const amount=Math.abs(Number(closureReportSnapshot.reconciliation.balanceBefore)||0);
  const dir=closureReportSnapshot.reconciliation.settlementDirection;
  const directionLabel=dir==="driver_to_explora"?"Chofer → Explora":dir==="explora_to_driver"?"Explora → Chofer":"Cuenta equilibrada";
  $("closureProofInstruction").textContent=amount>0.005
    ? `${directionLabel} · ${money(amount)}. Adjuntá el comprobante real de esta liquidación.`
    : "Adjuntá el comprobante que respalda el cierre de la operación.";
  $("closureReportStatus").textContent="Adjuntá el comprobante obligatorio para habilitar el cierre.";
  $("closureReportStatus").className="status";
  $("generateClosureReport").disabled=true;
  $("generateClosureReport").textContent="Confirmar cierre y dejar cuenta en $0";
  $("closureReportModal").classList.remove("hidden");
}
async function confirmClosureAndZero(){
  const user=auth.currentUser;if(!user||!closureRequestId)return;
  const file=selectedPhotoFile("closure");
  if(!closureProofReady()){
    $("closureReportStatus").textContent="Adjuntá una foto legible del comprobante antes de cerrar.";
    $("closureReportStatus").className="status error";
    updateClosureProofState();
    return;
  }
  const button=$("generateClosureReport");button.disabled=true;setPhotoPickerDisabled("closure",true);
  let stage="comprobante";
  $("closureReportStatus").textContent="Subiendo comprobante de liquidación…";$("closureReportStatus").className="status";
  try{
    const receipt=await uploadOperationalReceipt(
      file,
      `cierres_semanales/${closureRequestId}/${user.uid}`,
      "closure",
      closureRequestId,
      true
    );
    stage="cierre";
    $("closureReportStatus").textContent="Confirmando cierre, liquidación y saldo $0…";
    const {data}=await closePeriodCallable({
      requestId:closureRequestId,
      liquidationProof:{
        proofPath:receipt.proofPath,proofUrl:receipt.proofUrl,
        receiptPath:receipt.receiptPath,receiptUrl:receipt.receiptUrl,
        telegramPhotoPath:receipt.telegramPhotoPath,telegramPhotoUrl:receipt.telegramPhotoUrl,
        notificationPhotoUrl:receipt.notificationPhotoUrl,
        proofMimeType:receipt.proofMimeType,receiptMimeType:receipt.receiptMimeType,
        telegramPhotoMimeType:receipt.telegramPhotoMimeType,
        proofFileName:receipt.proofFileName,receiptFileName:receipt.receiptFileName
      }
    });
    if(!data?.ok||!data.snapshot||Math.abs(Number(data.snapshot?.reconciliation?.balanceAfter)||0)>.005)throw Object.assign(new Error("Respuesta de cierre inválida."),{code:"closure-response-invalid"});
    closureReportSnapshot=data.snapshot;
    $("closureReportContent").innerHTML=closureReportHtml(closureReportSnapshot);
    createClosureReportFile(closureReportSnapshot);
    $("closureReportStatus").textContent=data.noNewMovements
      ? "La cuenta ya estaba cerrada. Se recuperó el último cierre."
      : "Cierre confirmado. Cuenta en $0 y comprobante enviado a la cola de Telegram.";
    $("closureReportStatus").className="status success";
    button.textContent="Cierre confirmado · Saldo $0";
    button.disabled=true;
    scheduleOperationalRecovery(300,true);
  }catch(error){
    console.warn("Cierre:",stage,firebaseErrorCode(error));
    const reason=error?.details?.reason||error?.customData?.details?.reason||"";
    $("closureReportStatus").textContent=/permission-denied/.test(firebaseErrorCode(error))
      ?"La cuenta no tiene permiso operativo para cerrar."
      :/unauthenticated/.test(firebaseErrorCode(error))
        ?"La sesión venció. Volvé a iniciar sesión."
        :stage==="comprobante"
          ?"No se pudo subir el comprobante. La cuenta no fue cerrada; reintentá."
          :"No se pudo confirmar el cierre. Reintentá el mismo cierre; no se duplicará.";
    if(reason)$("closureReportStatus").textContent+=` (${reason})`;
    $("closureReportStatus").className="status error";
    setPhotoPickerDisabled("closure",false);
    button.textContent="Reintentar cierre";
    updateClosureProofState();
  }
}
$("closureProofCamera")?.addEventListener("change",()=>window.setTimeout(updateClosureProofState,0));
$("closureProofGallery")?.addEventListener("change",()=>window.setTimeout(updateClosureProofState,0));
$("closureReportClose")?.addEventListener("click",()=>{clearClosureReportFile();clearPhotoPicker("closure");setPhotoPickerDisabled("closure",false);$("closureReportModal").classList.add("hidden");});
$("generateClosureReport")?.addEventListener("click",confirmClosureAndZero);

let managementDirection = "";
function openManagement() {
  managementDirection = "";
  delete $("managementModal").dataset.movementColor;
  $("managementForm").classList.add("hidden");
  $("managementChoices").classList.remove("hidden");
  $("managementTitle").textContent = "Gestión";
  $("managementModal").classList.remove("hidden");
}
function selectManagement(direction) {
  managementDirection = direction;
  $("managementForm").reset();
  $("managementStatus").textContent = "";
  $("managementStatus").className = "status";
  const paying = direction === "driver_to_explora";
  $("managementTitle").textContent = paying ? "Pagar a Explora" : "Cobrar a Explora";
  $("managementIntro").textContent = paying ? "Registrá el dinero que entregás a Explora." : "Registrá el dinero que recibís de Explora.";
  $("managementConfirm").textContent = paying ? "Confirmar pago" : "Confirmar cobro";
  $("managementConfirm").disabled = false;
  $("managementModal").dataset.tone = paying ? "digital" : "cash";
  $("managementModal").dataset.movementColor = paying ? "green" : "red";
  $("managementChoices").classList.add("hidden");
  $("managementForm").classList.remove("hidden");
  renderManagementPreview();
}
function renderManagementPreview() {
  if (!managementDirection) return;
  const amount = parseMoneyInput($("managementAmount").value) || 0;
  const before = previewSettlementBalance("management");
  const delta = amount * (managementDirection === "driver_to_explora" ? -1 : 1);
  const after = normalizedSettlementBalance(before + delta);
  $("managementPreview").dataset.movementColor = managementDirection === "driver_to_explora" ? "green" : "red";
  $("managementPreview").innerHTML = '<div><span>Antes</span><small>'+escapeHtml(receiptBalanceLabel(before))+'</small></div><div><span>Impacto</span><strong class="'+(delta < 0 ? 'negative' : 'positive')+'">'+signedMoney(delta)+'</strong></div><div><span>Después</span><small>'+escapeHtml(receiptBalanceLabel(after))+'</small></div>';
}
$("managementPay").addEventListener("click", () => selectManagement("driver_to_explora"));
$("managementCollect").addEventListener("click", () => selectManagement("explora_to_driver"));
$("managementBack").addEventListener("click", openManagement);
$("managementAmount").addEventListener("input", renderManagementPreview);
$("managementForm").addEventListener("submit", async event => {
  event.preventDefault();
  const user = auth.currentUser;
  const direction = managementDirection;
  const amount = parseMoneyInput($("managementAmount").value);
  if (!user || !["driver_to_explora","explora_to_driver"].includes(direction) || !(amount > 0)) return;
  const proof = selectedPhotoFile("management");
  if (!proof || proof.size <= 0 || proof.size > 15 * 1024 * 1024 || !proof.type.startsWith("image/")) {
    $("managementStatus").textContent = "Adjuntá una foto del comprobante de hasta 15 MB.";
    $("managementStatus").className = "status error";
    return;
  }
  if (!acquireSubmissionLock("management")) return;
  $("managementConfirm").disabled = true;
  $("managementBack").disabled = true;
  setPhotoPickerDisabled("management", true);
  $("managementStatus").textContent = "Guardando…";
  let operation, reference, fingerprint;
  try {
    const detail = $("managementNote").value.trim();
    fingerprint = await buildSubmissionFingerprint("management", {direction,amount,detail});
    operation = reservePendingOperation("management", user.uid, fingerprint);
    reference = doc(db, ROOT_COLLECTIONS.payments, operation.operationId);
    const proofPath = "billing_receipts/" + user.uid + "/" + localDayKey() + "/" + operation.operationId + "_" + proof.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const storageRef = ref(storage, proofPath);
    await retryFirebaseOperation(() => uploadBytes(storageRef, proof), 4);
    const proofUrl = await retryFirebaseOperation(() => getDownloadURL(storageRef), 4);
    await runTransactionWithRetry(async transaction => {
      const existing = await transaction.get(reference);
      if (existing.exists()) return;
      const before = captureSubmissionBalance("management");
      const after = normalizedSettlementBalance(before + amount * (direction === "driver_to_explora" ? -1 : 1));
      renderManagementPreview();
      transaction.set(reference, {
        type:"settlement_adjustment", operationType:"settlement_adjustment", internalManagement:true,
        proofUrl,proofPath,receiptUrl:proofUrl,receiptPath:proofPath,receiptRequired:true,
        adjustmentDirection:direction, affectsBillingSettlement:true, internalSettlementAdjustment:true,
        method:direction === "driver_to_explora" ? "digital" : "cash",
        paymentMethod:direction === "driver_to_explora" ? "digital" : "cash",
        amount,monto:amount,service:direction === "driver_to_explora" ? "Pago a Explora" : "Cobro a Explora",
        detail,notes:detail,sourceModule:"gestion",status:"completed",
        driverUid:user.uid,choferUid:user.uid,uid:user.uid,ownerUid:user.uid,driverId:user.uid,operatorUid:user.uid,
        operatorName:currentDriverName(),driverName:currentDriverName(),businessId:BUSINESS_ID,
        dayKey:localDayKey(),weeklyPeriodId:currentWeeklyPeriodId(),
        telegramSettlementBeforeBalance:before,telegramSettlementAfterBalance:after,
        idempotencyKey:operation.operationId,clientOperationId:operation.operationId,submissionFingerprint:fingerprint,idempotencyVersion:1,
        createdAtMs:operation.createdAtMs,createdAt:serverTimestamp()
      });
    });
    clearPendingOperation("management",user.uid,fingerprint,operation.operationId);
    $("managementStatus").textContent = "Movimiento registrado.";
    closeModalAndGoTop("managementModal");
  } catch (error) {
    const committed = reference && operation && await confirmCommittedOperation(reference,operation.operationId,fingerprint);
    if (committed) {
      clearPendingOperation("management",user.uid,fingerprint,operation.operationId);
      closeModalAndGoTop("managementModal");
    } else {
      $("managementStatus").textContent = "No pudimos confirmar el movimiento. Reintentá: no se duplicará.";
      $("managementStatus").className = "status error";
      $("managementConfirm").disabled = false;
    }
  } finally {
    releaseSubmissionLock("management");
    $("managementBack").disabled = false;
    setPhotoPickerDisabled("management", false);
  }
});

function renderExpenseTypes() {
  const selected = $("expenseEntryKind").value;
  const choices = ExploraExpensePolicy.entryGroups;
  const group = choices.find(item => item.id === selected);
  $("expenseTypeGroups").innerHTML = '<div class="expense-entry-choices" role="group" aria-label="Tipo de registro">'+choices.map(item =>
    '<button type="button" class="expense-entry-choice '+item.id+'" data-expense-kind="'+item.id+'" aria-pressed="'+String(selected === item.id)+'"><strong>'+escapeHtml(item.label)+'</strong><span>'+escapeHtml(item.description)+'</span></button>'
  ).join('')+'</div>'+(group ? '<section class="charge-panel expense-type-group"><h3>'+ (selected === 'debt' ? 'Motivo de la deuda' : 'Tipo de gasto')+'</h3><div class="expense-type-options">'+group.types.map(type =>
    '<button type="button" class="expense-type-option" data-expense-type="'+type.id+'" aria-pressed="'+String($("expenseType").value === type.id)+'"><svg viewBox="0 0 24 24" aria-hidden="true">'+ExploraExpensePolicy.icons[type.icon]+'</svg><span>'+escapeHtml(type.label)+'</span></button>'
  ).join('')+'</div></section>' : '<p class="expense-choice-hint">Elegí una de las dos opciones para continuar.</p>');
}
function showExpenseStep(step) {
  $("expenseForm").dataset.step = String(step);
  document.querySelectorAll("[data-expense-step]").forEach(panel => panel.classList.toggle("hidden", Number(panel.dataset.expenseStep) !== step));
  const debt = $("expenseEntryKind").value === "debt";
  const names = ["Tipo de registro", "Monto y detalle", "Comprobante y confirmación"];
  $("expenseStepLabel").textContent = "Paso " + (step + 1) + " de 3 · " + names[step];
  $("expenseStepTrack").innerHTML = names.map((_,index) => '<span class="'+(index <= step ? 'complete' : '')+'"></span>').join('');
  $("saveExpenseBtn").textContent = step === 2 ? (debt ? "Registrar deuda 100%" : "Confirmar gasto") : "Continuar";
  $("expenseStepBack").textContent = step === 0 ? "Cancelar" : "Atrás";
  $("expenseStatus").textContent = "";
  renderExpensePreview();
  $("expenseModal").scrollTop = 0;
}
function validateExpenseStep(step) {
  let message = "";
  const kind = $("expenseEntryKind").value;
  const type = $("expenseType").value;
  if (step === 0 && (!['shared','debt'].includes(kind) || ExploraExpensePolicy.entryKind(type) !== kind)) message = "Elegí gasto o deuda y su concepto.";
  const amount = parseMoneyInput($("expenseAmount").value);
  if (step === 1 && !(Number.isFinite(amount) && amount > 0 && amount <= 100000000)) message = "Ingresá un importe válido de hasta $100.000.000.";
  if (step === 2 && !selectedPhotoFile("expense")) message = "Adjuntá una foto del comprobante para continuar.";
  if (!message) return true;
  showExpenseStep(step);
  $("expenseStatus").textContent = message;
  $("expenseStatus").className = "status error";
  return false;
}
function renderExpensePreview() {
  const type = ExploraExpensePolicy.find($("expenseType").value);
  const amount = parseMoneyInput($("expenseAmount").value) || 0;
  const debt = $("expenseEntryKind").value === "debt";
  const note = debt
    ? "El chofer reconoce que debe este importe a Explora. No retira efectivo ni se descuenta de los gastos compartidos. Sin intereses automáticos."
    : "Pagado en efectivo por el chofer. Se descuenta del disponible antes de Caja Explora 10% y del reparto.";
  $("expenseModal").dataset.movementColor = debt ? "red" : "orange";
  $("expenseAmountLabel").textContent = debt ? "Importe de la deuda" : "Monto del gasto";
  $("expenseDetail").placeholder = debt ? "Ej. Multa pagada por Explora" : "Ej. Carga en YPF";
  $("expenseRegistrationSummary").innerHTML = '<div><span>'+(debt ? 'Deuda a registrar · 100%' : 'Gasto a registrar')+'</span><strong>'+money(amount)+'</strong></div><p>'+escapeHtml(note)+'</p><small>El saldo actualizado se verá en Inicio al guardar.</small>';
  document.querySelectorAll("[data-expense-selection]").forEach(item => {
    item.innerHTML = type ? '<div><strong>'+escapeHtml(type.label)+'</strong><span>'+(debt ? 'Deuda del chofer 100%' : 'Gasto compartido · pagado en efectivo')+'</span></div>' : '';
  });
}
$("expenseTypeGroups").addEventListener("click", event => {
  if ($("saveExpenseBtn").disabled) return;
  const choice = event.target.closest("[data-expense-kind]");
  if (choice) {
    $("expenseEntryKind").value = choice.dataset.expenseKind;
    $("expenseType").value = "";
    renderExpenseTypes();
    renderExpensePreview();
    return;
  }
  const button = event.target.closest("[data-expense-type]");
  if (!button) return;
  $("expenseType").value = button.dataset.expenseType;
  $("expenseTypeGroups").querySelectorAll("[data-expense-type]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  $("expenseStatus").textContent = "";
  renderExpensePreview();
});
$("expenseStepBack").addEventListener("click", () => {
  if ($("saveExpenseBtn").disabled) return;
  const step = Number($("expenseForm").dataset.step || 0);
  if (step === 0) $("expenseModal").classList.add("hidden");
  else showExpenseStep(step - 1);
});
$("expenseAmount").addEventListener("input", renderExpensePreview);

function chargeSteps() {
  return $("chargeMode").value === "digital" ? [0,1,2,3] : [0,1,3];
}
function showChargeStep(step) {
  $("chargeForm").dataset.step = String(step);
  document.querySelectorAll("[data-charge-step]").forEach(panel => panel.classList.toggle("hidden", Number(panel.dataset.chargeStep) !== step));
  const names = ["Monto", "Servicio realizado", "Foto del comprobante", "Factura de Explora"];
  const steps = chargeSteps();
  const position = steps.indexOf(step);
  $("chargeStepLabel").textContent = "Paso " + (position + 1) + " de " + steps.length + " · " + names[step];
  document.querySelector(".charge-step-track").innerHTML = steps.map((value,index) => index <= position ? '<span class="complete"></span>' : '<span></span>').join("");
  $("saveChargeBtn").textContent = step === steps.at(-1) ? "Confirmar cobro" : "Continuar";
  $("chargeStepBack").textContent = step === 0 ? "Cancelar" : "Atrás";
  $("chargeStatus").textContent = "";
  renderChargePreview();
  $("chargeModal").scrollTop = 0;
}
function validateChargeStep(step) {
  if (step === 3 && parseMoneyInput($("chargeAmount").value) >= 10000000 && !$("chargeNamedInvoice").checked) {
    $("chargeNamedInvoice").checked = true;
    syncChargeCustomerFields();
    showChargeStep(3);
    $("chargeStatus").textContent = "Por este importe, ARCA exige identificar al pasajero. Completá sus datos.";
    return false;
  }
  if (step === 1 && !tourismRoute($("tourismOrigin").value,$("tourismDestination").value)) {
    showChargeStep(1); $("chargeRouteStatus").textContent="Elegí dos lugares diferentes de la lista."; return false;
  }
  const panel = document.querySelector('[data-charge-step="' + step + '"]');
  for (const field of panel.querySelectorAll("input,select")) {
    if (!field.disabled && !field.checkValidity()) { showChargeStep(step); field.reportValidity(); return false; }
  }
  if (step === 0 && !(parseMoneyInput($("chargeAmount").value) > 0)) {
    showChargeStep(0); $("chargeStatus").textContent = "Ingresá un importe válido."; return false;
  }
  if (step === 1 && (!$("chargeOrigin").value.trim() || !$("chargeDestination").value.trim())) {
    showChargeStep(1); $("chargeStatus").textContent = "Elegí un recorrido de la lista."; return false;
  }
  if (step === 2 && $("chargeMode").value === "digital" && !selectedPhotoFile("digital")) {
    showChargeStep(2); $("chargeStatus").textContent = "Adjuntá la foto del comprobante digital."; return false;
  }
  return true;
}
$("chargeStepBack").addEventListener("click", () => {
  if ($("saveChargeBtn").disabled) return;
  const step = Number($("chargeForm").dataset.step || 0);
  if (step === 0) $("chargeModal").classList.add("hidden");
  else { const steps = chargeSteps(); showChargeStep(steps[steps.indexOf(step) - 1]); }
});

const chargeRouteState = { version:0, points:{}, searches:{}, automatic:false };
function resetChargeRoute() {
  renderTourismSelectors();
  chargeRouteState.version++;
  chargeRouteState.points = {};
  chargeRouteState.searches = {};
  chargeRouteState.automatic = false;
  for (const part of ["Origin","Destination"]) {
    $("route"+part+"Results").replaceChildren();
    document.querySelector('[data-route-search="'+part+'"]').disabled = false;
  }
  $("chargeRouteStatus").textContent = "";
}
function invalidateChargeRoute(part) {
  chargeRouteState.version++;
  delete chargeRouteState.points[part];
  chargeRouteState.searches[part] = (chargeRouteState.searches[part] || 0) + 1;
  $("route"+part+"Results").replaceChildren();
  $("chargeDistance").value = "";
  chargeRouteState.automatic = false;
  $("chargeRouteStatus").textContent = "Recorrido modificado. Elegí los lugares o ingresá los kilómetros nuevamente.";
}
function routeFailureMessage(error) {
  const code = String(error?.code || "");
  if (code.endsWith("failed-precondition") || code.endsWith("not-found")) return "La búsqueda todavía no está disponible. Podés completar el recorrido y los kilómetros manualmente.";
  if (code.endsWith("resource-exhausted")) return "Se alcanzó el límite de consultas. Podés completar el recorrido manualmente.";
  return "No pudimos consultar las direcciones. Reintentá o completá el recorrido manualmente.";
}
async function calculateChargeRoute() {
  const origin = chargeRouteState.points.Origin, destination = chargeRouteState.points.Destination;
  if (!origin || !destination) {
    $("chargeRouteStatus").textContent = "Elegí el otro punto para calcular los kilómetros.";
    return;
  }
  const version = ++chargeRouteState.version;
  $("chargeDistance").value = "";
  $("chargeRouteStatus").textContent = "Calculando recorrido…";
  try {
    const response = await exploraRouteCallable({action:"route",origin:origin.coordinates,destination:destination.coordinates});
    if (version !== chargeRouteState.version) return;
    const distance = response.data?.distanceKm;
    if (!Number.isFinite(distance) || distance <= 0) throw new Error("Invalid distance");
    $("chargeDistance").value = String(distance);
    chargeRouteState.automatic = true;
    $("chargeTripScope").value = [origin.country,destination.country].some(country => ["BRA","BR","PRY","PY"].includes(country)) ? "international" : "national";
    $("chargeRouteStatus").textContent = distance > 100 ? "El recorrido por carretera supera los 100 km, aunque los lugares estén dentro del radio de búsqueda. Revisá el servicio." : "Kilómetros calculados por carretera. Revisá que correspondan al servicio realizado; podés corregirlos.";
  } catch (error) {
    if (version === chargeRouteState.version) $("chargeRouteStatus").textContent = routeFailureMessage(error);
  }
}
for (const part of ["Origin","Destination"]) {
  $("charge"+part).addEventListener("input", () => invalidateChargeRoute(part));
  const button = document.querySelector('[data-route-search="'+part+'"]');
  button.addEventListener("click", async () => {
    const query = $("charge"+part).value.trim();
    if (query.length < 3) {
      $("chargeRouteStatus").textContent = "Escribí al menos 3 caracteres para buscar.";
      return;
    }
    const session = chargeRouteState.version;
    const token = (chargeRouteState.searches[part] || 0) + 1;
    chargeRouteState.searches[part] = token;
    button.disabled = true;
    $("route"+part+"Results").replaceChildren();
    $("chargeRouteStatus").textContent = "Buscando direcciones…";
    try {
      const response = await exploraRouteCallable({action:"search",query});
      if (session !== chargeRouteState.version || token !== chargeRouteState.searches[part]) return;
      const places = response.data?.places || [];
      $("chargeRouteStatus").textContent = places.length ? "Seleccioná la dirección que corresponde." : "No encontramos ese lugar dentro de los 100 km de Puerto Iguazú. Probá otro nombre o completá los datos manualmente.";
      for (const place of places) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "route-result";
        option.textContent = place.label;
        option.addEventListener("click", () => {
          $("charge"+part).value = place.label;
          chargeRouteState.points[part] = place;
          $("route"+part+"Results").replaceChildren();
          calculateChargeRoute();
        });
        $("route"+part+"Results").append(option);
      }
    } catch (error) {
      if (session === chargeRouteState.version && token === chargeRouteState.searches[part]) $("chargeRouteStatus").textContent = routeFailureMessage(error);
    } finally {
      button.disabled = false;
    }
  });
}
$("chargeDistance").addEventListener("input", () => {
  chargeRouteState.version++;
  chargeRouteState.automatic = false;
  $("chargeRouteStatus").textContent = "Kilómetros ingresados manualmente.";
});

function renderTourismSelectors() {
  for (const part of ["Origin","Destination"]) {
    $("tourism"+part).value="";$("tourism"+part+"Search").value="";
    $("tourism"+part+"Matches").replaceChildren();
    $("tourism"+part+"Search").setAttribute("aria-expanded","false");
    $("tourism"+part+"Clear").hidden=true;
  }
}
function selectTourismRoute() {
  chargeRouteState.version++;
  const originId=$("tourismOrigin").value, destinationId=$("tourismDestination").value;
  const route=tourismRoute(originId,destinationId);
  $("chargeOrigin").value="";$("chargeDestination").value="";$("chargeDistance").value="";
  $("chargeTripScope").value="national";
  chargeRouteState.automatic=false;
  chargeRouteState.points={};
  if (!route) {
    $("chargeRouteStatus").textContent=originId && destinationId ? "Elegí dos lugares diferentes con un recorrido disponible." : "";return;
  }
  chargeRouteState.points={Origin:route.origin,Destination:route.destination};
  $("chargeOrigin").value=route.origin.name+" · "+route.origin.city;
  $("chargeDestination").value=route.destination.name+" · "+route.destination.city;
  $("chargeDistance").value=String(route.distance);
  $("chargeTripScope").value=[route.origin.country,route.destination.country].some(c=>["BRA","BR","PRY","PY"].includes(c))?"international":"national";
  $("chargeRouteStatus").textContent=route.distance>100?"Este recorrido supera los 100 km por carretera.":"";
}

const tourismUsageKey = "explora-tourism-usage-v1";
let tourismUsage = {};
try { const saved = JSON.parse(localStorage.getItem(tourismUsageKey) || "{}"); if(saved && typeof saved === "object" && !Array.isArray(saved)) tourismUsage = saved; } catch {}
function initializeTourismSelector(part) {
  const input=$("tourism"+part+"Search"), matches=$("tourism"+part+"Matches");
  const selected=$("tourism"+part), clear=$("tourism"+part+"Clear");
  const closeMatches=()=>{
    matches.replaceChildren();
    input.setAttribute("aria-expanded","false");
  };
  const showMatches=()=>{
    // Un lugar ya elegido no debe actuar como filtro al buscar su reemplazo.
    const other=part==="Origin"?"Destination":"Origin";
    $("tourism"+other+"Matches").replaceChildren();
    $("tourism"+other+"Search").setAttribute("aria-expanded","false");
    matches.replaceChildren();
    const search=selected.value?"":input.value;
    const places=searchTourismPlaces(search,tourismUsage,true).filter(place=>place.id!==selected.value);
    for(const place of places){
      const button=document.createElement("button");
      button.type="button";button.className="route-result";
      button.setAttribute("role","option");
      button.setAttribute("aria-selected","false");
      button.textContent=place.name+" · "+place.city+" · "+tourismCountryNames[place.country];
      button.addEventListener("click",()=>{
        input.value=place.name+" · "+place.city;
        selected.value=place.id;
        clear.hidden=false;
        tourismUsage[place.id]=Math.max(0,Number(tourismUsage[place.id])||0)+1;
        try { localStorage.setItem(tourismUsageKey,JSON.stringify(tourismUsage)); } catch {}
        closeMatches();
        selectTourismRoute();
      });
      matches.append(button);
    }
    if(search.trim().length>=2&&!places.length)matches.textContent="No hay coincidencias en los lugares cargados.";
    input.setAttribute("aria-expanded",String(places.length>0));
  };
  const clearSelection=()=>{
    input.value="";
    selected.value="";
    clear.hidden=true;
    selectTourismRoute();
  };
  clear.addEventListener("click",()=>{
    clearSelection();
    input.focus();
    showMatches();
  });
  input.addEventListener("beforeinput",()=>{
    // Conserva la nueva tecla, pegado o composición: solo borra la selección previa.
    if(selected.value)clearSelection();
  });
  input.addEventListener("input",()=>{
    selected.value="";
    clear.hidden=!input.value;
    selectTourismRoute();
    showMatches();
  });
  input.addEventListener("focus",showMatches);
  input.addEventListener("click",showMatches);
  const field=input.closest(".tourism-location-field");
  const closeWhenOutside=event=>{if(!field.contains(event.target))closeMatches();};
  // Un desenfoque táctil puede llegar antes del click y sin relatedTarget.
  // Cerrar por la interacción exterior conserva la opción hasta seleccionarla.
  document.addEventListener("pointerdown",closeWhenOutside);
  document.addEventListener("focusin",closeWhenOutside);
  input.addEventListener("keydown",event=>{
    if(event.key==="ArrowDown"&&matches.querySelector("button")){event.preventDefault();matches.querySelector("button").focus();}
    if(event.key==="Escape")closeMatches();
  });
  matches.addEventListener("keydown",event=>{
    const options=[...matches.querySelectorAll("button")];
    const index=options.indexOf(event.target);
    if(index<0)return;
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){
      event.preventDefault();
      options[(index+(event.key==="ArrowDown"?1:options.length-1))%options.length].focus();
    }
    if(event.key==="Escape"){
      event.preventDefault();input.focus();closeMatches();
    }
  });
}
for(const part of ["Origin","Destination"])initializeTourismSelector(part);


let stopInvoiceSubscription = null;
let invoiceFileGeneration = 0;
const invoiceFileUrls = new Set();
function clearInvoiceFiles() {
  invoiceFileGeneration++;
  for (const url of invoiceFileUrls) URL.revokeObjectURL(url);
  invoiceFileUrls.clear();
}
async function prepareInvoiceDownload(id, button, panel) {
  const generation = invoiceFileGeneration, uid = auth.currentUser?.uid;
  if (!uid || button.disabled) return;
  button.disabled = true;
  button.textContent = "Preparando PDF…";
  const status = panel.querySelector(".invoice-file-status") || document.createElement("p");
  status.className = "invoice-file-status";
  status.textContent = "";
  status.setAttribute("role", "status");
  panel.append(status);
  try {
    const {data} = await httpsCallable(functions, "arcaInvoicePdf")({id});
    // A closed profile or account change must discard the pending response.
    if (generation !== invoiceFileGeneration || auth.currentUser?.uid !== uid) return;
    const decoded = atob(data.base64);
    if (!decoded.startsWith("%PDF-")) throw new Error("INVALID_PDF");
    const file = new File([Uint8Array.from(decoded, c => c.charCodeAt(0))], data.filename, {type:"application/pdf"});
    const url = URL.createObjectURL(file);
    invoiceFileUrls.add(url);
    const actions = document.createElement("div");
    actions.className = "invoice-file-actions";
    // Keep real links in the document: async synthetic clicks lose the user's
    // gesture in mobile and embedded browsers and can fail without feedback.
    const save = document.createElement("a");
    save.href = url; save.download = data.filename; save.className = "primary"; save.textContent = "Guardar PDF";
    const open = document.createElement("a");
    open.href = url; open.target = "_blank"; open.rel = "noopener"; open.className = "secondary"; open.textContent = "Abrir PDF";
    actions.append(save, open);
    if (navigator.canShare?.({files:[file]})) {
      const share = document.createElement("button");
      share.type = "button"; share.className = "secondary"; share.textContent = "Compartir PDF";
      share.addEventListener("click", async () => {
        try { await navigator.share({files:[file], title:"Factura de Explora"}); }
        catch (error) { if (error.name !== "AbortError") status.textContent = "Usá Guardar PDF o Abrir PDF para obtener la factura."; }
      });
      actions.append(share);
    }
    panel.append(actions);
    status.textContent = "PDF listo para guardar o compartir.";
    button.remove();
  } catch {
    if (generation !== invoiceFileGeneration || auth.currentUser?.uid !== uid) return;
    status.textContent = "No pudimos preparar el PDF. Volvé a intentarlo.";
    button.disabled = false;
    button.textContent = "Obtener PDF";
  }
}
async function refreshArcaBillingStatus() {
  const uid = auth.currentUser?.uid;
  const generation = authGeneration;
  if (!uid) return;
  try {
    const data = await cachedArcaStatus(uid);
    if (generation !== authGeneration || uid !== auth.currentUser?.uid) return;
    $("arcaModeLabel").textContent=data.enabled ? (data.environment === "production" ? "Automática" : "Pruebas") : "Sin activar";
    $("arcaModeNote").textContent=data.enabled ? (data.environment === "production" ? (data.internationalEnabled ? "Al confirmar se solicitará la Factura C del viaje." : "Al confirmar se solicitará la factura. Los viajes internacionales quedan para revisión.") : "Homologación: las facturas de prueba no tienen validez fiscal.") : "El viaje se guarda. La emisión fiscal todavía no está activada.";
  } catch {
    if (generation !== authGeneration || uid !== auth.currentUser?.uid) return;
    $("arcaModeLabel").textContent="Por verificar";
    $("arcaModeNote").textContent="Consultá el estado de la factura después de registrar el cobro.";
  }
}
let arcaStatusCache = null;
function cachedArcaStatus(uid) {
  const now = Date.now();
  if (arcaStatusCache?.uid === uid && arcaStatusCache.generation === authGeneration &&
      (arcaStatusCache.pending || arcaStatusCache.expires > now)) return arcaStatusCache.promise;
  const entry = { uid, generation:authGeneration, pending:true, expires:0 };
  entry.promise = httpsCallable(functions,"arcaBillingStatus")({}).then(({data}) => {
    entry.pending = false;
    entry.expires = Date.now() + 60000;
    return data;
  }, error => {
    if (arcaStatusCache === entry) arcaStatusCache = null;
    throw error;
  });
  arcaStatusCache = entry;
  return entry.promise;
}
const invoiceStatusLabels={queued:"En proceso",reserved:"En proceso",sent:"En proceso",uncertain:"Verificando",authorized:"Autorizada",rejected:"Rechazada",review:"Revisar",disabled:"Sin emitir"};
let invoiceRows = [], invoiceFilter = "all";
const invoiceViewCache = new Map();
let invoiceViewGeneration = 0;
function invoiceElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function invoiceDisplayDate(invoice) {
  const value = String(invoice.detail?.CbteFch || "");
  const date = /^\d{8}$/.test(value)
    ? new Date(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T12:00:00-03:00`)
    : new Date(Number(invoice.createdAtMs));
  return Number.isNaN(date.getTime()) ? null : date;
}
function createInvoiceCard(invoice) {
  const card = invoiceElement("article", "invoice-card");
  const authorized = invoice.status === "authorized";
  const tone = authorized ? "success" : ["review","rejected"].includes(invoice.status) ? "attention" : "pending";
  const top = invoiceElement("div", "invoice-card-top");
  const date = invoiceDisplayDate(invoice);
  const dateLabel = date ? date.toLocaleDateString("es-AR", {day:"numeric",month:"short",year:"numeric",timeZone:"America/Argentina/Buenos_Aires"}) : "Fecha pendiente";
  top.append(invoiceElement("span", "invoice-date", dateLabel), invoiceElement("span", `invoice-badge invoice-badge-${tone}`, invoiceStatusLabels[invoice.status] || "Pendiente"));
  const main = invoiceElement("div", "invoice-card-main");
  const amount = invoiceElement("div", "invoice-amount");
  amount.append(invoiceElement("span", "invoice-caption", "Importe facturado"), invoiceElement("strong", "", money(invoice.detail?.ImpTotal || 0)));
  if (!authorized) amount.firstChild.textContent = "Importe a facturar";
  const reference = invoiceElement("div", "invoice-number");
  reference.append(invoiceElement("span", "invoice-caption", "Factura C"), invoiceElement("strong", "", authorized ? `${String(invoice.issuer.pointOfSale).padStart(5,"0")}-${String(invoice.number).padStart(8,"0")}` : "Pendiente de emisión"));
  main.append(amount, reference);
  const route = String(invoice.description || "Servicio de traslado")
    .replace(/^Traslado de pasajeros con chofer\.\s*/, "")
    .replace(/\.\s*Servicio:\s*\d{4}-\d{2}-\d{2}\.\s*$/, "");
  const trip = invoiceElement("div", "invoice-trip");
  trip.append(invoiceElement("span", "invoice-caption", "Recorrido"), invoiceElement("p", "invoice-route", route));
  const method = invoice.paymentMethod === "cash" ? "Cobro en efectivo" : invoice.paymentMethod === "digital" ? "Cobro digital" : "Cobro registrado";
  trip.append(invoiceElement("span", "invoice-payment", method));
  card.append(top, main, trip);
  const reasons = {international_requires_review:"Viaje internacional: revisar el tipo de factura.",international_before_activation:"Cobro anterior a la activación internacional: requiere revisión.",invalid_service_scope:"Revisar el trayecto del servicio.",issuer_print_data_missing:"Faltan datos fiscales del emisor.",customer_identification_required:"Falta identificar al pasajero.",point_of_sale_unavailable:"Revisar el punto de venta.",number_conflict:"El número corresponde a otros datos. Requiere revisión.",awaiting_reconciliation:"Esperando confirmar la autorización en ARCA."};
  const notices = [...new Set([...(invoice.issues || []),invoice.issue].filter(Boolean).map(code => reasons[code] || "Revisar los datos de la solicitud."))];
  if (notices.length) card.append(invoiceElement("p", "invoice-notice", notices.join(" ")));
  if (invoice.environment === "homologation") card.append(invoiceElement("p", "invoice-notice", "PRUEBA · Sin validez fiscal"));
  const details = invoiceElement("details", "invoice-details");
  details.append(invoiceElement("summary", "", "Ver detalles"));
  const data = invoiceElement("dl", "invoice-data");
  function addData(label, value) { if (value) { const row = invoiceElement("div"); row.append(invoiceElement("dt", "", label), invoiceElement("dd", "", value)); data.append(row); } }
  addData("Pasajero", invoice.customer?.name || "Consumidor final");
  addData("Emisor", invoice.issuer?.legalName);
  addData("CUIT", invoice.issuer?.cuit);
  if (authorized) {
    addData("CAE", invoice.cae);
    const expires = String(invoice.caeExpires || "");
    if (/^\d{8}$/.test(expires)) addData("Vencimiento CAE", `${expires.slice(6,8)}/${expires.slice(4,6)}/${expires.slice(0,4)}`);
  }
  addData("Servicio", invoice.description);
  details.append(data); card.append(details);
  if (authorized) {
    const footer = invoiceElement("div", "invoice-card-footer");
    const button = invoiceElement("button", "invoice-pdf-button", "Obtener PDF"); button.type = "button";
    button.addEventListener("click", () => prepareInvoiceDownload(invoice.id,button,footer));
    footer.append(button); card.append(footer);
  }
  return card;
}
function renderInvoices() {
  clearInvoiceFiles();
  const list = $("invoicesList"); list.replaceChildren();
  const rows = invoiceRows.filter(invoice => invoiceFilter === "all" || (invoiceFilter === "authorized" ? invoice.status === "authorized" : invoice.status !== "authorized"));
  const counts = {all:invoiceRows.length, authorized:invoiceRows.filter(row=>row.status === "authorized").length};
  counts.pending = counts.all-counts.authorized;
  $("invoicesFilters").hidden = !invoiceRows.length;
  document.querySelectorAll("[data-invoice-filter]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.invoiceFilter === invoiceFilter)));
  document.querySelectorAll("[data-invoice-count]").forEach(label=>{label.textContent = counts[label.dataset.invoiceCount];});
  $("invoicesStatus").textContent = rows.length ? `${rows.length} ${rows.length === 1 ? "comprobante" : "comprobantes"} · Más recientes primero${invoiceRows.length === 30 ? " · Últimos 30" : ""}` : "";
  if (!rows.length) {
    const empty = invoiceElement("div", "invoices-empty");
    empty.append(invoiceElement("strong", "", !invoiceRows.length ? "Tus facturas aparecerán acá" : invoiceFilter === "pending" ? "Todo al día" : "Sin facturas emitidas"), invoiceElement("p", "", !invoiceRows.length ? "Después de registrar un viaje, podés consultar su factura en este espacio." : invoiceFilter === "pending" ? "No hay comprobantes por resolver en esta lista." : "Las facturas autorizadas por ARCA se mostrarán acá."));
    list.append(empty); return;
  }
  const groups = new Map();
  for (const invoice of rows) {
    const date = invoiceDisplayDate(invoice);
    const month = date ? date.toLocaleDateString("es-AR", {month:"long",year:"numeric",timeZone:"America/Argentina/Buenos_Aires"}) : "Sin fecha";
    if (!groups.has(month)) {
      const group = invoiceElement("section", "invoice-month");
      group.setAttribute("aria-label",month);
      group.append(invoiceElement("h3", "invoice-month-title", month));
      groups.set(month,group); list.append(group);
    }
    groups.get(month).append(createInvoiceCard(invoice));
  }
}
function showInvoices(allDrivers = false) {
  const user=auth.currentUser;if(!user)return;
  const generation = ++invoiceViewGeneration;
  const scope = allDrivers && isAdminProfile() ? "all" : user.uid;
  const cached = invoiceViewCache.get(scope);
  let receivedSnapshot = false;
  clearInvoiceFiles();
  invoiceRows=[]; invoiceFilter="all"; $("invoicesFilters").hidden=true;
  $("driverProfileModal").classList.add("hidden");$("invoicesModal").classList.remove("hidden");
  $("invoicesStatus").textContent="Buscando tus facturas…";$("invoicesList").replaceChildren();
  if (cached) {
    invoiceRows = cached;
    renderInvoices();
    $("invoicesStatus").textContent += " · Actualizando…";
  }
  document.querySelector('[data-close="invoicesModal"]').focus();
  stopInvoiceSubscription?.();
  const invoiceQuery = allDrivers && isAdminProfile()
    ? query(collection(db,"arca_invoices"),orderBy("createdAtMs","desc"),limit(30))
    : query(collection(db,"arca_invoices"),where("driverUid","==",user.uid),orderBy("createdAtMs","desc"),limit(30));
  stopInvoiceSubscription=onSnapshot(invoiceQuery,{includeMetadataChanges:true},snapshot=>{
    if (generation !== invoiceViewGeneration || auth.currentUser?.uid !== user.uid) return;
    if (cached && snapshot.empty && snapshot.metadata.fromCache) return;
    if (receivedSnapshot && snapshot.docChanges().length === 0) {
      if (!snapshot.metadata.fromCache) $("invoicesStatus").textContent = $("invoicesStatus").textContent.replace(" · Actualizando…", "");
      return;
    }
    receivedSnapshot = true;
    invoiceRows=snapshot.docs.map(row=>({...row.data(),id:row.id}));
    invoiceViewCache.set(scope, invoiceRows);
    renderInvoices();
  },()=>{if (generation === invoiceViewGeneration) $("invoicesStatus").textContent="No pudimos actualizar las facturas. Cerrá y volvé a intentar.";});
}
document.querySelectorAll("[data-invoice-filter]").forEach(button=>button.addEventListener("click",()=>{invoiceFilter=button.dataset.invoiceFilter;renderInvoices();$("invoicesList").scrollTop=0;}));
$("showInvoicesBtn").addEventListener("click",()=>showInvoices());
$("adminInvoicesBtn").addEventListener("click",()=>showInvoices(true));
// Do not retain another driver's fiscal data after sign-out or account switch.
onAuthStateChanged(auth,()=>{invoiceViewGeneration++;invoiceViewCache.clear();arcaStatusCache=null;stopInvoiceSubscription?.();stopInvoiceSubscription=null;clearInvoiceFiles();invoiceRows=[];$("invoicesList").replaceChildren();$("invoicesModal").classList.add("hidden");});
document.querySelector('[data-close="invoicesModal"]').addEventListener('click',()=>{invoiceViewGeneration++;stopInvoiceSubscription?.();stopInvoiceSubscription=null;clearInvoiceFiles();invoiceRows=[];$("invoicesList").replaceChildren();});
$("invoicesModal").addEventListener("keydown",event=>{
  if(event.key==="Escape"){event.preventDefault();document.querySelector('[data-close="invoicesModal"]').click();return;}
  if(event.key!=="Tab")return;
  const controls=[...$("invoicesModal").querySelectorAll('button:not(:disabled), a[href], summary')].filter(element=>element.getClientRects().length);
  const first=controls[0],last=controls[controls.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
});

// Fiscal and expense PDFs are prepared through authenticated functions, not public image links.
document.addEventListener("click", event => {
  const button = event.target.closest("[data-document-kind]");
  if (button) { event.preventDefault(); event.stopPropagation(); openStatementDocument(button.dataset.documentKind,button.dataset.documentId,button.dataset.documentCollection); return; }
  const legacy = event.target.closest("[data-proof-preview],a[href]");
  if (!legacy) return;
  const url=legacy.dataset.proofPreview || legacy.getAttribute("href");
  const reference=operationalReferenceForUrl(url);
  if (reference) { event.preventDefault(); event.stopImmediatePropagation(); openStatementDocument("receipt",reference.id,reference.collectionName); }
},true);
$("documentCloseBtn")?.addEventListener("click",()=>{clearDocumentFiles();$("documentModal").classList.add("hidden");});
$("documentModal")?.addEventListener("keydown",event=>{if(event.key==="Escape")$("documentCloseBtn").click();});
$("driverCalendarShortcut")?.addEventListener("click",event=>tripCalendar.open(event.currentTarget));
document.querySelectorAll("[data-statement-action]").forEach(button=>button.addEventListener("click",()=>{
  if(button.dataset.statementAction === "expense") $("addExpenseBtn").click();
  if(button.dataset.statementAction === "management") $("closeDayBtn").click();
}));
$("uberMoneyHolder")?.addEventListener("change",renderUberAccountPreview);

// 3.1.1: server-confirmed operational save, independent of a preview or dashboard readiness.
const operationalSaveCallable = httpsCallable(functions, "saveOperationalMovementV311", {timeout:125000});
let operationalDataEpoch = 0;
const operationalNativeReadyByLoad = new WeakMap();
let operationalRecoveryCacheGuard = null;
let operationalRecoveryTimer = null;
let operationalRecoveryPromise = null;
let operationalRecoveryLast = 0;
let operationalRequestGeneration = 0;
function operationalErrorMessage(error, stage = "guardar") {
  const code = firebaseErrorCode(error).replace(/^functions\//, "");
  const messages = {
    "permission-denied":"El servidor rechazó el permiso de esta sesión. Volvé a iniciar sesión; si persiste, informá este código.",
    "unauthenticated":"La sesión venció. Cerrá e iniciá sesión; no vuelvas a cargar un movimiento sin revisar si se guardó.",
    "storage/unauthorized":"No se pudo subir el comprobante por permisos de Storage.",
    "storage/unauthenticated":"La sesión no autoriza la subida del comprobante. Volvé a iniciar sesión.",
    "storage/bucket-not-found":"El almacenamiento de comprobantes no está disponible.",
    "storage/quota-exceeded":"El almacenamiento alcanzó su cuota. La operación no se confirmó.",
    "storage/retry-limit-exceeded":"La subida del comprobante agotó el tiempo. Conservá la imagen y reintentá.",
    "not-found":"Falta publicar la función de guardado. Ejecutá el SH de reparación completo.",
    "already-exists":"La operación ya existe con otros datos. No se sobrescribió ni duplicó.",
    "operational-response-invalid":"El servidor no confirmó el registro. Reintentá la misma operación.",
    "operational-session-changed":"Cambiaste de cuenta durante el guardado. Revisá el movimiento en la cuenta original."
  };
  const accessReasons = {
    explora_account_inactive:"La cuenta figura deshabilitada en Explora. El administrador debe revisar su estado.",
    explora_profile_missing:"La cuenta no tiene un perfil de Explora vinculado. El administrador debe asociarla; no necesitás permiso de administrador para cobrar.",
    explora_profile_conflict:"El perfil y la cuenta no coinciden. El administrador debe revisar el vínculo, sin volver a cargar el movimiento.",
    explora_other_owner:"No podés usar un movimiento o comprobante de otra cuenta.",
    explora_auth_lookup_failed:"El servidor no pudo verificar la cuenta. Es un problema de acceso del servidor, no una baja del chofer.",
    explora_profile_lookup_failed:"No se pudieron consultar los perfiles. Reintentá sin crear otra operación.",
    explora_session_revoked:"La sesión fue revocada. Cerrá e iniciá sesión nuevamente."
  };
  const reason = typeof error?.details?.reason === "string" ? error.details.reason : "";
  if (Object.hasOwn(accessReasons,reason)) return `${accessReasons[reason]} (${stage} · ${code} · ${reason})`;
  const safeDetail = ['invalid-argument','failed-precondition','resource-exhausted'].includes(code) && typeof error?.message === 'string'
    ? error.message.replace(/^Firebase:\s*/,'').slice(0,220) : '';
  return `${messages[code] || safeDetail || "No se pudo confirmar la operación. Revisá la conexión y reintentá; se conserva el mismo identificador."} (${stage} · ${code || "error"})`;
}
function operationalNotice(message, error = false) {
  let element = $("operationalSaveNotice");
  if (!element) {
    element = document.createElement("p");element.id="operationalSaveNotice";
    element.setAttribute("role","status");element.setAttribute("aria-live","polite");
    $("driverDashboard").prepend(element);
  }
  element.textContent=message;element.className=error ? "status error" : "status success";
}
async function callOperationalServer(data, user) {
  if (auth.currentUser?.uid !== user.uid) throw Object.assign(new Error("Cambió la sesión."), {code:"operational-session-changed"});
  let result;
  try { result = await operationalSaveCallable(data); }
  catch (error) {
    const retryCode = firebaseErrorCode(error).replace(/^functions\//, "");
    const permanentAccessDenial = ["explora_account_inactive","explora_profile_missing","explora_profile_conflict","explora_other_owner"].includes(error?.details?.reason);
    if (!["unauthenticated","permission-denied"].includes(retryCode) || permanentAccessDenial || auth.currentUser?.uid !== user.uid || typeof user.getIdToken !== "function") throw error;
    // Refresh stale claims only once. Do not change the operation ID or retry across accounts.
    await user.getIdToken(true);
    if (auth.currentUser?.uid !== user.uid) throw Object.assign(new Error("Cambió la sesión."), {code:"operational-session-changed"});
    result = await operationalSaveCallable(data);
  }
  if (auth.currentUser?.uid !== user.uid) throw Object.assign(new Error("Cambió la sesión."), {code:"operational-session-changed"});
  if (result?.data?.ok !== true) throw Object.assign(new Error("Respuesta inválida."),{code:"operational-response-invalid"});
  return result.data;
}
function validateOperationalAck(response, key, user) {
  const collection = key.kind === "expense" ? ROOT_COLLECTIONS.expenses : key.kind === "debt" ? ROOT_COLLECTIONS.debts : ROOT_COLLECTIONS.payments;
  if (response?.committed !== true || response.id !== key.operationId || response.collection !== collection ||
      response.row?.driverUid !== user.uid || response.row?.idempotencyKey !== key.operationId || response.row?.submissionFingerprint !== key.fingerprint) {
    throw Object.assign(new Error("Falta la confirmación del servidor."),{code:"operational-response-invalid"});
  }
  return response;
}
function applyOperationalAck(response) {
  const row=response.row,id=response.id;
  const insert = (rows,normalizer) => [...rows.filter(item=>item.id!==id),normalizer(id,row)].sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a));
  if(response.collection===ROOT_COLLECTIONS.payments)payments=insert(payments,normalizePaymentRecord);
  else if(response.collection===ROOT_COLLECTIONS.expenses)expenses=insert(expenses,normalizeExpenseRecord);
  else if(response.collection===ROOT_COLLECTIONS.debts)debts=insert(debts,normalizeDebtRecord).filter(item=>item.amount>0);
  operationalDataEpoch++;
  scheduleDashboardRender();flushDashboardRender();
}
async function submitOperationalMovement({kind,user,file,fields}) {
  const expense = kind === "expense" || kind === "debt";
  const lock = expense ? "expense" : "charge", modalId = expense ? "expenseModal" : "chargeModal";
  const form=$(expense ? "expenseForm" : "chargeForm"), status=$(expense ? "expenseStatus" : "chargeStatus"), button=$(expense ? "saveExpenseBtn" : "saveChargeBtn");
  if (!acquireSubmissionLock(lock,false)) { status.textContent="Esta operación ya se está guardando."; return; }
  const modal=$(modalId),controls=[...modal.querySelectorAll("button,input,select,textarea")].map(element=>({element,disabled:element.disabled}));
  const originalLabel=button.textContent;
  controls.forEach(({element})=>{element.disabled=true;});
  const pendingKind=kind==="debt"?"driver_debt":expense?"expense":"payment";
  let key=null,operation=null,stage="verificar",confirmed=false;
  const progress = (text) => {status.textContent=text;status.className="status";button.textContent=text;};
  const finish = (response) => {
    validateOperationalAck(response,key,user);
    // A display failure must never turn an acknowledged write into a false "not saved".
    confirmed=true;
    clearPendingOperation(pendingKind,user.uid,key.fingerprint,key.operationId);
    let rendered=true;
    try { applyOperationalAck(response); }
    catch(error) { rendered=false; console.warn("Movimiento guardado; falta actualizar Inicio:",firebaseErrorCode(error)); }
    form.reset();clearPhotoPicker(expense?"expense":"digital");
    if(!expense)syncChargeCustomerFields();
    try { closeModalAndGoTop(modalId); }
    catch(_) { rendered=false;modal.classList.add("hidden"); }
    const noun=kind==="debt"?"Deuda":expense?"Gasto":"Cobro";
    operationalNotice(`${noun} confirmado en el servidor${response.alreadyRegistered ? " (ya estaba registrado una sola vez)" : ""}. ${rendered && dashboardLoad?.complete() ? "Inicio actualizado." : "El registro ya está guardado; actualizando Inicio…"}`);
    try { if(kind!=="cash")prepareOperationalPdfInBackground(response); } catch(_) {}
    scheduleOperationalRecovery(800,true);
  };
  try {
    if (navigator.onLine === false) throw Object.assign(new Error("Sin conexión."),{code:"unavailable"});
    // Canonical fingerprint keeps the keys used by previous attempts in version 3.1.
    let fingerprint;
    if(!expense)fingerprint=await buildSubmissionFingerprint("charge",{mode:kind,amount:fields.amount,detail:fields.detail,invoiceRequest:fields.invoiceRequest});
    else if(kind==="debt")fingerprint=await buildSubmissionFingerprint("driver_debt",{amount:fields.amount,detail:fields.detail,debtCategory:fields.expenseType,debtRuleVersion:ExploraExpensePolicy.debtVersion});
    else fingerprint=await buildSubmissionFingerprint("expense",{amount:fields.amount,detail:fields.detail,expenseType:fields.expenseType,receiptFlowVersion:ExploraPeriodSettlement.VERSION});
    operation=reservePendingOperation(pendingKind,user.uid,fingerprint);
    key={kind,operationId:operation.operationId,fingerprint};
    progress("Verificando registro…");
    const prior=await callOperationalServer({action:"check",...key},user);
    if(prior.committed===true){finish(prior);return;}
    let receipt={};
    if(kind!=="cash") {
      stage="comprobante";progress("Subiendo comprobante…");
      const folder=kind==="digital"?"billing_receipts":kind==="debt"?"deudas":"gastos";
      receipt=await uploadOperationalReceipt(file,`${folder}/${user.uid}/${operation.operationId}`,kind==="digital"?"payment":kind==="debt"?"debt":"expense",operation.operationId,true);
    }
    stage="guardar";progress("Confirmando en servidor…");
    const request={action:"save",...key,...fields,createdAtMs:operation.createdAtMs};
    if(kind!=="cash")for(const field of ["proofPath","proofUrl","telegramPhotoPath","telegramPhotoUrl"])request[field]=receipt[field];
    const response=await callOperationalServer(request,user);
    finish(response);
  } catch(error) {
    // A timeout can happen AFTER commit. Read the same ID instead of creating another.
    if(key && auth.currentUser?.uid===user.uid && stage==="guardar") {
      try {const prior=await callOperationalServer({action:"check",...key},user);if(prior.committed===true){finish(prior);return;}}catch(_){}
    }
    if(auth.currentUser?.uid===user.uid) {
      status.textContent=operationalErrorMessage(error,stage);status.className="status error";
      operationalNotice(status.textContent,true);
    }
    console.warn("Explora guardado:",stage,firebaseErrorCode(error));
  } finally {
    controls.forEach(({element,disabled})=>{element.disabled=disabled;});
    button.disabled=false;button.textContent=originalLabel;
    releaseSubmissionLock(lock);
    // Never erase form values / selected photo unless a server acknowledgment was received.
    if(confirmed){status.textContent="";if(!expense)syncChargeCustomerFields();}
  }
}
function operationalLiveReady(load) {
  const ready=operationalNativeReadyByLoad.get(load);
  return Boolean(ready && Object.values(ROOT_COLLECTIONS).every(name=>ready.has(name)));
}
function scheduleOperationalRecovery(wait=1200,force=false) {
  if(operationalRecoveryTimer!==null)clearTimeout(operationalRecoveryTimer);
  operationalRecoveryTimer=setTimeout(()=>{
    operationalRecoveryTimer=null;
    recoverOperationalLedger(force).catch(error=>{
      if(auth.currentUser&&!isAdminProfile()) {
        operationalNotice(operationalErrorMessage(error,"sincronizar"),true);
        if(!document.hidden && !/permission-denied|unauthenticated|not-found/.test(firebaseErrorCode(error)))scheduleOperationalRecovery(15000);
      }
    });
  },wait);
}
async function recoverOperationalLedger(force=false) {
  const user=auth.currentUser,load=dashboardLoad;
  if(!user||isAdminProfile()||!load||navigator.onLine===false)return;
  if(!force&&load.complete()&&!load.errors.size&&operationalLiveReady(load))return;
  if(operationalRecoveryPromise)return operationalRecoveryPromise;
  if(!force&&Date.now()-operationalRecoveryLast<15000)return;
  operationalRecoveryLast=Date.now();const epoch=operationalDataEpoch,generation=++operationalRequestGeneration;
  operationalRecoveryPromise=(async()=>{
    const response=await callOperationalServer({action:"sync"},user);
    if(auth.currentUser?.uid!==user.uid||dashboardLoad!==load||generation!==operationalRequestGeneration)return;
    if(epoch!==operationalDataEpoch){scheduleOperationalRecovery(1000,true);return;}
    const ledger=response.ledger;
    if(response.uid!==user.uid||!ledger||Object.values(ROOT_COLLECTIONS).some(name=>!Array.isArray(ledger[name])))throw Object.assign(new Error("Historial incompleto."),{code:"operational-response-invalid"});
    const normalize=(name,fn)=>ledger[name].map(item=>fn(item.id,item)).sort((a,b)=>recordTimestampMs(b)-recordTimestampMs(a));
    // Assign only after validating every collection. Never display a fabricated zero balance.
    payments=normalize(ROOT_COLLECTIONS.payments,normalizePaymentRecord);
    expenses=normalize(ROOT_COLLECTIONS.expenses,normalizeExpenseRecord);
    debts=normalize(ROOT_COLLECTIONS.debts,normalizeDebtRecord).filter(item=>item.amount>0);
    debtPayments=normalize(ROOT_COLLECTIONS.debtPayments,normalizeDebtPaymentRecord);
    uberClosures=normalize(ROOT_COLLECTIONS.uber,normalizeUberRecord).filter(item=>item.noData!==true);
    closures=normalize(ROOT_COLLECTIONS.closures,normalizeClosureRecord);
    advances=normalize(ROOT_COLLECTIONS.advances,normalizeAdvanceRecord).filter(item=>item.type==="cash_advance"||item.loanType==="cash_advance");
    advancesLoaded=true;
    for(const name of Object.values(ROOT_COLLECTIONS))load.update(name,false,false,false);
    operationalRecoveryCacheGuard=load;operationalDataEpoch++;
    scheduleDashboardRender();flushDashboardRender();
    operationalNotice("Movimientos confirmados y saldo sincronizado con el servidor.");
    if(!operationalLiveReady(load)&&!document.hidden)scheduleOperationalRecovery(15000);
  })();
  try {return await operationalRecoveryPromise;} finally {operationalRecoveryPromise=null;}
}
