
import { collection, doc, getDocs, query, where, setDoc, runTransaction, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { ref as storageRef, uploadBytes, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { installmentPlan } from "../core/driver-debt-core.mjs";

const fb = window.ExploraFirebase || {};
const auth = fb.auth;
const db = fb.db;
const storage = fb.storage;
const $ = id => document.getElementById(id);
const AR_TZ = "America/Argentina/Cordoba";
const UPLOAD_CONTEXTS = Object.freeze({
  alias_payment:"aliasPayment",
  client_alias_payment:"aliasPayment",
  operational_loan:"operationalLoan",
  driver_debt:"driverDebt",
  weekly_closure_driver:"weeklyClosureDriver",
  weekly_closure_admin:"weeklyClosureAdmin",
  weekly_closure:"weeklyClosureDriver"
});
const createReceiptState = () => ({ file:null, previewUrl:null, processedFile:null, uploading:false, lastError:null });
const receiptUploadStates = {
  aliasPayment:createReceiptState(),
  operationalLoan:createReceiptState(),
  driverDebt:createReceiptState(),
  weeklyClosureDriver:createReceiptState(),
  weeklyClosureAdmin:createReceiptState()
};
const uploadStates = receiptUploadStates;
const receiptUploadTasks = new Map();
window.receiptUploadStates = receiptUploadStates;

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const money = value => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Number(value) || 0).replace(/\s/g, "");
function parseCurrencyInput(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const cleaned = String(value ?? "").replace(/\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(/,/g, ".").replace(/[^\d.-]/g, "");
  const amount = Number(cleaned);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
}
function formatCurrencyInput(value) {
  const digits = String(value ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return digits ? Number(digits).toLocaleString("es-AR") : "";
}
window.parseCurrencyInput = window.parseCurrencyInput || parseCurrencyInput;
window.formatCurrencyInput = window.formatCurrencyInput || formatCurrencyInput;
window.parseBillingAmount = window.parseBillingAmount || parseCurrencyInput;

function activePeriods() {
  const clock = window.ExploraFirestoreClock;
  if (clock && !clock.isTrusted()) throw Object.assign(new Error("El reloj operativo de Firestore no está sincronizado."), { code:"FIRESTORE_CLOCK_UNAVAILABLE" });
  const now = clock?.getNow?.() || new Date();
  const weekly = clock?.getWeeklyPeriod?.() || window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.() || {};
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone:AR_TZ, year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    weeklyPeriodId: weekly.id || weekly.weeklyPeriodId || "",
    monthlyPeriodId: `${parts.year}-${parts.month}`,
    yearlyPeriodId: String(parts.year),
    year: Number(parts.year),
    month: Number(parts.month),
    timezone:"America/Argentina/Cordoba"
  };
}

async function getSession() {
  const user = auth?.currentUser;
  if (!user?.uid) throw new Error("AUTH_REQUIRED");
  const state = window.ExploraSession || {};
  return {
    user,
    uid:user.uid,
    role:String(state.role || "").toLowerCase(),
    profile:state.profile || {},
    profileDocumentId:state.profileDocumentId || state.driverId || user.uid
  };
}
function getDriverName(session) {
  return String(session.profile?.nombre || session.profile?.nombreCompleto || session.profile?.displayName || session.user?.displayName || "Chofer").trim();
}
function stableId(prefix, uid) {
  return `${prefix}_${String(uid).slice(0,10)}_${Date.now()}_${globalThis.crypto?.randomUUID?.().slice(0,8) || Math.random().toString(36).slice(2,10)}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0,110);
}
function normalizeUploadContext(context) {
  const key = String(context || "").trim();
  if (uploadStates[key]) return key;
  return UPLOAD_CONTEXTS[key] || "";
}
function getUploadState(context) {
  const key = normalizeUploadContext(context);
  if (!key) throw new Error("RECEIPT_CONTEXT_INVALID");
  return uploadStates[key];
}
function isPdf(file) {
  return String(file?.type || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(String(file?.name || ""));
}
function isImage(file) {
  const mimeRaw=String(file?.type||"").toLowerCase().split(";")[0].trim();
  const mime=mimeRaw==="image/jpg"?"image/jpeg":mimeRaw;
  const extension=String(file?.name||"").match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase()||"";
  const allowed={"image/jpeg":["jpg","jpeg"],"image/png":["png"],"image/webp":["webp"]};
  return Boolean(allowed[mime]?.includes(extension));
}
function withFileStageTimeout(promise, milliseconds, code) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error(code)); } }, milliseconds);
    Promise.resolve(promise).then(value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } }, error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}
function logUploadStage(stage, context, error = null, detail = {}) {
  const safe = { stage, context:normalizeUploadContext(context) || context, code:String(error?.code || error?.message || ""), ...detail };
  console[error ? "error" : "info"]("[EXPLORA receipt]", safe);
}
function resetUploadState(context) {
  const key = normalizeUploadContext(context);
  if (!key) throw new Error("RECEIPT_CONTEXT_INVALID");
  const current = uploadStates[key];
  if (current?.previewUrl) { try { URL.revokeObjectURL(current.previewUrl); } catch (_) {} }
  const task = receiptUploadTasks.get(key);
  if (task && current?.uploading) { try { task.cancel?.(); } catch (_) {} }
  receiptUploadTasks.delete(key);
  uploadStates[key] = createReceiptState();
  return uploadStates[key];
}
function selectUploadFile(input, context, options = {}) {
  const key = normalizeUploadContext(context);
  if (!key) throw new Error("RECEIPT_CONTEXT_INVALID");
  const file = input?.files?.[0] || (input instanceof File ? input : null);
  if (!file) return resetUploadState(key);
  const allowPdf = options.allowPdf !== false;
  if (!isImage(file) && !(allowPdf && isPdf(file))) throw new Error("RECEIPT_FORMAT_INVALID");
  if (!(file.size > 0)) throw new Error("RECEIPT_FILE_EMPTY");
  if (file.size > Number(options.maxSourceBytes || 15 * 1024 * 1024)) throw new Error("RECEIPT_FILE_TOO_LARGE");
  const state = resetUploadState(key);
  state.file = file;
  state.previewUrl = isImage(file) ? URL.createObjectURL(file) : "";
  uploadStates[key] = state;
  return state;
}
async function readUploadFileBuffer(file) {
  if (!(file instanceof File || file instanceof Blob)) throw new Error("RECEIPT_FILE_INVALID");
  if (!(file.size > 0)) throw new Error("RECEIPT_FILE_EMPTY");
  try { return await withFileStageTimeout(file.arrayBuffer(), 15000, "RECEIPT_FILE_READ_TIMEOUT"); }
  catch (error) { throw error?.message === "RECEIPT_FILE_READ_TIMEOUT" ? error : new Error("RECEIPT_FILE_READ_FAILED"); }
}
function loadUploadImageElement(source, { revokeUrl=false, timeoutMs=15000 } = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (error) { if (revokeUrl) { try { URL.revokeObjectURL(source); } catch (_) {} } reject(error); return; }
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!(width > 0 && height > 0)) { if (revokeUrl) { try { URL.revokeObjectURL(source); } catch (_) {} } reject(new Error("RECEIPT_DIMENSIONS_INVALID")); return; }
      resolve({ source:image, width, height, cleanup:() => { if (revokeUrl) { try { URL.revokeObjectURL(source); } catch (_) {} } } });
    };
    const timer = setTimeout(() => finish(new Error("RECEIPT_DECODE_TIMEOUT")), timeoutMs);
    image.onload = () => finish();
    image.onerror = () => finish(new Error("RECEIPT_DECODE_FAILED"));
    image.src = source;
  });
}
async function decodeImageWithObjectUrl(file) {
  const objectUrl = URL.createObjectURL(file);
  return loadUploadImageElement(objectUrl, { revokeUrl:true, timeoutMs:15000 });
}
async function decodeImageWithDataUrl(file) {
  const dataUrl = await withFileStageTimeout(new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("RECEIPT_FILE_READER_FAILED"));
    reader.onabort = () => reject(new Error("RECEIPT_FILE_READER_FAILED"));
    reader.readAsDataURL(file);
  }), 15000, "RECEIPT_FILE_READ_TIMEOUT");
  if (!dataUrl.startsWith("data:image/")) throw new Error("RECEIPT_DECODE_FAILED");
  return loadUploadImageElement(dataUrl, { revokeUrl:false, timeoutMs:15000 });
}
async function decodeImageWithBitmap(file) {
  if (typeof createImageBitmap !== "function") throw new Error("RECEIPT_BITMAP_UNAVAILABLE");
  const bitmap = await withFileStageTimeout(createImageBitmap(file, { imageOrientation:"from-image" }), 15000, "RECEIPT_DECODE_TIMEOUT");
  if (!(bitmap.width > 0 && bitmap.height > 0)) { bitmap.close?.(); throw new Error("RECEIPT_DIMENSIONS_INVALID"); }
  return { source:bitmap, width:bitmap.width, height:bitmap.height, cleanup:() => bitmap.close?.() };
}
async function decodeImageFile(file) {
  await readUploadFileBuffer(file);
  const safari = /Safari/i.test(navigator.userAgent) && !/Chrome|CriOS|Android/i.test(navigator.userAgent);
  const attempts = safari ? [decodeImageWithObjectUrl, decodeImageWithDataUrl, decodeImageWithBitmap] : [decodeImageWithBitmap, decodeImageWithObjectUrl, decodeImageWithDataUrl];
  let lastError = null;
  for (const decoder of attempts) {
    try { return await decoder(file); } catch (error) { lastError = error; }
  }
  const heic = /\.(heic|heif)$/i.test(file.name || "") || /image\/(heic|heif)/i.test(file.type || "");
  throw new Error(heic ? "RECEIPT_HEIC_UNSUPPORTED" : String(lastError?.message || "RECEIPT_DECODE_FAILED"));
}
function canvasToBlobSafe(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("RECEIPT_ENCODE_TIMEOUT")); } }, 12000);
    try {
      canvas.toBlob(blob => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!blob?.size) { reject(new Error("RECEIPT_ENCODE_EMPTY")); return; }
        resolve(blob);
      }, type, quality);
    } catch (error) {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    }
  });
}
function fileFromBlob(blob, name, type) {
  try { return new File([blob], name, { type, lastModified:Date.now() }); }
  catch (_) { blob.name = name; return blob; }
}
let processExpenseReceiptUsingProfileFlow = null;

async function compressReceiptImage(file, options = {}) {
  if (typeof processExpenseReceiptUsingProfileFlow !== "function") {
    throw new Error("EXPENSE_RECEIPT_MASTER_UNAVAILABLE");
  }
  const processed = await processExpenseReceiptUsingProfileFlow(file);
  const mimeType = String(processed.mimeType || processed.blob?.type || "image/jpeg");
  const extension = String(processed.extension || (mimeType.includes("webp") ? "webp" : "jpg"));
  const blob = processed.blob;
  if (!(blob instanceof Blob) || !(blob.size > 0)) throw new Error("RECEIPT_ENCODE_EMPTY");
  return {
    file:fileFromBlob(blob, `comprobante.${extension}`, mimeType),
    blob,
    mimeType,
    extension,
    size:Number(processed.byteSize || blob.size),
    width:Number(processed.width || 0),
    height:Number(processed.height || 0),
    originalName:file.name || `comprobante.${extension}`,
    sourceEngine:"EXPENSE_RECEIPT_ENGINE",
    expenseProcessed:processed
  };
}

async function prepareUploadFile(file, options = {}) {
  if (!(file instanceof File || file instanceof Blob)) throw new Error("RECEIPT_REQUIRED");
  if (isPdf(file)) {
    if (options.allowPdf === false) throw new Error("RECEIPT_PDF_NOT_ALLOWED");
    if (file.size > Number(options.maxPdfBytes || 10 * 1024 * 1024)) throw new Error("RECEIPT_PDF_TOO_LARGE");
    return { file, blob:file, mimeType:"application/pdf", extension:"pdf", size:file.size, originalName:file.name || "comprobante.pdf" };
  }
  return compressReceiptImage(file, options);
}
async function uploadProcessedFile(processedFile, destination, options = {}) {
  if (!storage) throw new Error("STORAGE_NOT_INITIALIZED");
  if (!destination || /(?:undefined|null|\[object Object\])/i.test(destination)) throw new Error("RECEIPT_PATH_INVALID");
  const reference = storageRef(storage, destination);
  const key = options.context ? normalizeUploadContext(options.context) : "";
  const state = key ? getUploadState(key) : null;
  const data = processedFile.file || processedFile.blob;
  const metadata = { contentType:processedFile.mimeType, customMetadata:options.metadata || {} };
  if (!(data instanceof Blob) || !(data.size > 0)) throw new Error("RECEIPT_UPLOAD_DATA_INVALID");
  if (state) { state.uploading = true; state.lastError = null; }
  try {
    if (!["weeklyClosureDriver","driverDebt","operationalLoan"].includes(key)) {
      const snapshot = await uploadBytes(reference, data, metadata);
      const fileUrl = await getDownloadURL(snapshot.ref);
      return { fileUrl, filePath:destination, receiptUrl:fileUrl, receiptPath:destination, reference:snapshot.ref };
    }

    const timeoutMs = Math.max(10000, Number(options.timeoutMs || 45000));
    let task = null;
    const snapshot = await new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        try { unsubscribe?.(); } catch (_) {}
        if (key) receiptUploadTasks.delete(key);
        callback(value);
      };
      const timeoutId = setTimeout(() => {
        if (settled) return;
        try { task?.cancel?.(); } catch (_) {}
        const timeoutError = new Error(`Firebase Storage no respondió dentro de ${timeoutMs} ms.`);
        timeoutError.code = "storage/retry-limit-exceeded";
        timeoutError.internalCode = key === "driverDebt" ? "STORAGE_UPLOAD_TIMEOUT" : "CLOSURE_STORAGE_UPLOAD_TIMEOUT";
        timeoutError.cancelAttempted = true;
        timeoutError.uploadContext = key;
        timeoutError.storagePath = destination;
        options.onTaskState?.("failed", task?.snapshot || null);
        finish(reject, timeoutError);
      }, timeoutMs);

      try {
        task = uploadBytesResumable(reference, data, metadata);
        if (!task || typeof task.on !== "function") throw new Error("RECEIPT_UPLOAD_TASK_INVALID");
        if (key) receiptUploadTasks.set(key, task);
        options.onTaskState?.("running", task.snapshot || null);
        options.onProgress?.(0, task.snapshot || null);
        unsubscribe = task.on(
          "state_changed",
          currentSnapshot => {
            if (settled) return;
            const transferred = Number(currentSnapshot?.bytesTransferred || 0);
            const total = Number(currentSnapshot?.totalBytes || data.size || 0);
            const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((transferred / total) * 100))) : 0;
            options.onTaskState?.(String(currentSnapshot?.state || "running"), currentSnapshot);
            options.onProgress?.(percent, currentSnapshot);
          },
          uploadError => {
            options.onTaskState?.("failed", task?.snapshot || null);
            finish(reject, uploadError);
          },
          () => {
            options.onProgress?.(100, task?.snapshot || null);
            options.onTaskState?.("success", task?.snapshot || null);
            finish(resolve, task.snapshot);
          }
        );
      } catch (startError) {
        options.onTaskState?.("failed", task?.snapshot || null);
        finish(reject, startError);
      }
    });

    if (!snapshot?.ref) throw new Error("RECEIPT_UPLOAD_SNAPSHOT_INVALID");
    const fileUrl = await getDownloadURL(snapshot.ref);
    if (!fileUrl || !/^https?:\/\//i.test(String(fileUrl))) throw new Error("RECEIPT_DOWNLOAD_URL_INVALID");
    return { fileUrl, filePath:destination, receiptUrl:fileUrl, receiptPath:destination, reference:snapshot.ref };
  } catch (error) {
    if (state) state.lastError = error;
    throw error;
  } finally {
    if (state) state.uploading = false;
    if (key) receiptUploadTasks.delete(key);
  }
}
function contextPath({ context, contextType, ownerUid, driverUid, recordId, weeklyPeriodId, extension }) {
  const raw = String(contextType || context || "");
  const key = normalizeUploadContext(raw);
  const uid = String(driverUid || ownerUid || "").trim();
  const id = String(recordId || "").trim();
  const period = String(weeklyPeriodId || "").trim();
  if (!uid || !id) throw new Error("RECEIPT_PATH_INVALID");
  const weeklyBase = window.ExploraCanonicalWeeklyClosure?.storageBasePath?.() || "cierres_semanales";
  const paths = {
    aliasPayment:`gastos/${uid}/${id}/comprobante.${extension}`,
    operationalLoan:`prestamos/${uid}/${id}/comprobante.${extension}`,
    driverDebt:`deudas/${uid}/${id}/comprobante.${extension}`,
    weeklyClosureDriver:`${weeklyBase}/${period}/${uid}/${id}/comprobante.${extension}`,
    weeklyClosureAdmin:`${weeklyBase}/${period}/${uid}/${id}/comprobante.${extension}`
  };
  if (!paths[key] || ((key === "weeklyClosureDriver" || key === "weeklyClosureAdmin") && !period)) throw new Error("RECEIPT_PATH_INVALID");
  return paths[key];
}
function saveReceiptMetadata(result = {}, input = {}) {
  return {
    receiptUrl:result.receiptUrl || result.fileUrl || null,
    receiptPath:result.receiptPath || result.filePath || null,
    storagePath:result.receiptPath || result.filePath || null,
    fullPath:result.receiptPath || result.filePath || null,
    downloadURL:result.receiptUrl || result.fileUrl || null,
    module:String(input.module || input.category || "receipt"),
    relatedCollection:String(input.relatedCollection || ({payment:"billing_records",expense:"gastos",weekly_closure:"cierres_semanales",driver_debt:"deudas_choferes",operational_loan:"prestamos_operativos"}[String(input.category || "")] || "")),
    relatedDocumentId:String(input.relatedDocumentId || input.recordId || ""),
    operational:true,
    receiptMimeType:result.receiptMimeType || result.mimeType || null,
    receiptFileName:result.receiptFileName || result.fileName || null,
    receiptSize:Number(result.receiptSize || result.fileSize || 0),
    receiptUploadedAt:result.receiptUploadedAt || serverTimestamp(),
    receiptUploadedByUid:input.uploadedByUid || input.ownerUid || null,
    receiptUploadedByRole:input.uploadedByRole || "driver"
  };
}
async function uploadExploraReceipt({
  file,
  context,
  ownerUid,
  driverUid,
  recordId,
  weeklyPeriodId,
  destinationPath,
  allowPdf = false,
  uploadedByUid,
  uploadedByRole,
  category,
  metadata = {},
  onStage
} = {}) {
  const key = normalizeUploadContext(context);
  if (!key) throw new Error("RECEIPT_CONTEXT_INVALID");
  if (!(file instanceof File || file instanceof Blob)) throw new Error("RECEIPT_REQUIRED");
  const state = getUploadState(key);
  if (state.uploading) throw new Error("RECEIPT_UPLOAD_IN_PROGRESS");
  const effectiveDriverUid = String(driverUid || ownerUid || auth?.currentUser?.uid || "").trim();
  const effectiveOwnerUid = String(ownerUid || effectiveDriverUid).trim();
  const uploaderUid = String(uploadedByUid || auth?.currentUser?.uid || effectiveOwnerUid).trim();
  const uploaderRoleRaw = String(uploadedByRole || window.ExploraSession?.role || "driver").toLowerCase();
  const uploaderRole = ["admin","administrador","owner"].includes(uploaderRoleRaw) ? "admin" : "driver";
  const officialCategory = String(category || ({aliasPayment:"payment",operationalLoan:"operational_loan",driverDebt:"driver_debt",weeklyClosureDriver:"weekly_closure",weeklyClosureAdmin:"weekly_closure"}[key]) || key);
  const emit = (stage, detail = {}) => { try { onStage?.(stage, detail); } catch (_) {} };
  logUploadStage("PREPARE_START", key, null, { size:Number(file.size || 0), type:String(file.type || "") });
  try {
    emit("PROCESS_FILE", { context:key });
    const prepared = state.file === file && state.processedFile ? state.processedFile : await prepareUploadFile(file, {
      allowPdf,
      maxDimension:1400,
      quality:.75,
      targetBytes:600 * 1024,
      maxPdfBytes:10 * 1024 * 1024
    });
    state.processedFile = prepared;
    let path = String(destinationPath || "").trim();
    if (key === "aliasPayment") {
      path = contextPath({ context:key, ownerUid:effectiveOwnerUid, driverUid:effectiveDriverUid, recordId, weeklyPeriodId, extension:prepared.extension });
    } else if (path) {
      path = path.replace(/\{extension\}/g, prepared.extension);
    } else {
      path = contextPath({ context:key, ownerUid:effectiveOwnerUid, driverUid:effectiveDriverUid, recordId, weeklyPeriodId, extension:prepared.extension });
    }
    emit("UPLOAD_START", { path, size:prepared.size, mimeType:prepared.mimeType, percent:0, taskState:"starting" });
    const uploaded = await uploadProcessedFile(prepared, path, {
      context:key,
      timeoutMs:(key === "weeklyClosureDriver" || key === "driverDebt" || key === "operationalLoan") ? 45000 : undefined,
      onProgress:(percent, snapshot)=>emit("UPLOAD_PROGRESS", {
        percent,
        snapshot,
        path,
        size:prepared.size,
        mimeType:prepared.mimeType,
        taskState:String(snapshot?.state || (percent >= 100 ? "success" : "running"))
      }),
      onTaskState:(taskState, snapshot)=>emit("UPLOAD_STATE", {
        taskState,
        snapshot,
        path,
        size:prepared.size,
        mimeType:prepared.mimeType
      }),
      metadata:{
        ownerUid:effectiveOwnerUid,
        driverUid:effectiveDriverUid,
        uploadedByUid:uploaderUid,
        uploadedByRole:uploaderRole,
        role:uploaderRole,
        recordId:String(recordId || ""),
        weeklyPeriodId:String(weeklyPeriodId || ""),
        category:officialCategory,
        module:officialCategory,
        relatedDocumentId:String(recordId || ""),
        operational:"true",
        createdAtMs:String(Date.now()),
        ...Object.fromEntries(Object.entries(metadata || {}).map(([name,value])=>[String(name),String(value ?? "")]))
      }
    });
    emit("UPLOAD_COMPLETE", { path, size:prepared.size, mimeType:prepared.mimeType, percent:100, taskState:"success" });
    return {
      receiptUrl:uploaded.fileUrl,
      receiptPath:uploaded.filePath,
      receiptMimeType:prepared.mimeType,
      receiptFileName:prepared.originalName || prepared.file?.name || file.name || `comprobante.${prepared.extension}`,
      receiptSize:prepared.size,
      receiptUploadedAt:serverTimestamp()
    };
  } catch (error) {
    state.lastError = error;
    emit("ERROR", { error });
    logUploadStage("UPLOAD_ERROR", key, error, { ownerUid:effectiveOwnerUid, recordId:String(recordId || "") });
    throw error;
  }
}
async function processAndUploadFile(input = {}) {
  const context = normalizeUploadContext(input.context || input.contextType);
  if (!context) throw new Error("RECEIPT_CONTEXT_INVALID");
  const result = await uploadExploraReceipt({
    file:input.file,
    context,
    ownerUid:input.ownerUid,
    driverUid:input.driverUid || input.ownerUid,
    recordId:input.recordId,
    weeklyPeriodId:input.weeklyPeriodId,
    destinationPath:input.destinationPath,
    allowPdf:input.allowPdf !== false,
    uploadedByUid:input.uploadedByUid,
    uploadedByRole:input.uploadedByRole,
    category:input.category,
    metadata:input.metadata,
    onStage:(stage, detail)=>{
      input.onStage?.(stage, detail);
      if(stage === "UPLOAD_PROGRESS") input.onProgress?.(detail.percent, detail.snapshot);
    }
  });
  return {
    storageMode:"storage",
    fileUrl:result.receiptUrl,
    filePath:result.receiptPath,
    mimeType:result.receiptMimeType,
    fileName:result.receiptFileName,
    fileSize:result.receiptSize,
    uploadedAt:Date.now(),
    ...result
  };
}
const processAndUploadReceipt = processAndUploadFile;
async function deleteUploadedFile(path) {
  if (!path || !storage) return;
  await deleteObject(storageRef(storage, path));
}
function resolveReceiptSource(record = {}) {
  const payer = String(record.payerRole || record.payer || record.sentido || "").toLowerCase();
  const adminFirst = payer.includes("admin") || payer.includes("david") || payer.includes("david_a_chofer");
  const driverUrls = [record.driverReceiptUrl, record.receiptUrl, record.comprobanteUrl, record.archivoUrl, record.photoUrl, record.imageUrl, record.fileUrl, record.downloadURL, record.receiptDataUrl, record.receiptData, record.comprobante];
  const adminUrls = [record.adminReceiptUrl, record.davidReceiptUrl, record.receiptUrl, record.comprobanteUrl, record.archivoUrl];
  const driverPaths = [record.driverReceiptPath, record.receiptPath, record.comprobantePath, record.archivoPath];
  const adminPaths = [record.adminReceiptPath, record.davidReceiptPath, record.receiptPath, record.comprobantePath];
  const urls = adminFirst ? adminUrls.concat(driverUrls) : driverUrls.concat(adminUrls);
  const paths = adminFirst ? adminPaths.concat(driverPaths) : driverPaths.concat(adminPaths);
  const url = String(urls.find(value => typeof value === "string" && value.trim()) || "").trim();
  const path = String(paths.find(value => typeof value === "string" && value.trim()) || "").trim();
  const mimeType = String((adminFirst ? record.adminReceiptMimeType || record.davidReceiptMimeType : record.driverReceiptMimeType) || record.receiptMimeType || record.comprobanteMime || record.mimeType || "").trim();
  const fileName = String((adminFirst ? record.adminReceiptFileName : record.driverReceiptFileName) || record.receiptFileName || record.comprobanteNombre || record.fileName || "").trim();
  const fileSize = Number((adminFirst ? record.adminReceiptSize : record.driverReceiptSize) || record.receiptSize || record.comprobanteTamano || 0);
  return { url, path, mimeType, fileName, fileSize };
}
function receiptIndexId(category, recordId, suffix = "") {
  return `${String(category || "receipt").replace(/[^a-z0-9_-]/gi, "_")}_${String(recordId || "record").replace(/[^a-z0-9_-]/gi, "_")}${suffix ? `_${suffix}` : ""}`.slice(0, 180);
}
function buildReceiptIndexPayload(input = {}) {
  const result = input.receipt || input;
  return {
    receiptId:input.receiptId || receiptIndexId(input.category, input.recordId, input.suffix),
    category:input.category,
    recordId:input.recordId,
    driverUid:input.driverUid || input.ownerUid,
    ownerUid:input.ownerUid || input.driverUid,
    uploadedByUid:input.uploadedByUid || input.ownerUid || input.driverUid,
    uploadedByRole:input.uploadedByRole || "driver",
    weeklyPeriodId:input.weeklyPeriodId || "",
    amount:Number(input.amount || 0),
    receiptUrl:result.receiptUrl || result.fileUrl || null,
    receiptPath:result.receiptPath || result.filePath || null,
    receiptMimeType:result.receiptMimeType || result.mimeType || null,
    receiptFileName:result.receiptFileName || result.fileName || null,
    receiptSize:Number(result.receiptSize || result.fileSize || 0),
    status:input.status || "uploaded",
    createdAt:serverTimestamp(),
    uploadedAt:serverTimestamp()
  };
}
function openReceiptViewer(receipt = {}) {
  const backdrop = $("receiptDetailBackdrop");
  const preview = $("receiptDetailPreview");
  const lines = $("receiptDetailLines");
  const link = $("receiptDetailOpenLink");
  if (!backdrop || !preview || !lines || !link) return;
  const source = resolveReceiptSource(receipt.raw || receipt);
  const url = receipt.url || source.url || "";
  const mime = String(receipt.mime || source.mimeType || "").toLowerCase();
  $("receiptDetailTitle").textContent = receipt.title || source.fileName || "Detalle del comprobante";
  const raw=receipt.raw||receipt;const uploadedRole=String(raw.uploadedByRole||raw.receiptUploadedByRole||"").toLowerCase();const uploadedBy=uploadedRole==="admin"||uploadedRole==="administrador"?"David":uploadedRole?"Chofer":"";lines.innerHTML = [["Chofer",receipt.driverName],["Categoría",receipt.categoryLabel||receipt.category],["Monto",receipt.amount?money(receipt.amount):""],["Fecha",receipt.date],["Semana",receipt.weeklyPeriodId],["Subido por",uploadedBy],["Saldo final",raw.resultLabel||raw.resultadoFinal||""],["Estado",receipt.state||receipt.status],["Operación",receipt.operationId||receipt.recordId]].filter(([,value])=>value!==undefined&&value!==null&&value!=="").map(([label,value])=>`<div class="receipt-detail-line"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("");
  preview.innerHTML = "";
  if (!url) { preview.innerHTML='<div class="receipts-empty is-visible">Sin archivo asociado.</div>';link.hidden=true;link.removeAttribute("href"); }
  else { preview.innerHTML='<div class="receipts-empty is-visible">El comprobante está disponible para abrir bajo demanda.</div>';link.hidden=false;link.href=url;link.textContent=mime.includes("pdf")||/\.pdf(?:$|\?)/i.test(url)?"VER ARCHIVO":"VER FOTO"; }
  backdrop.classList.add("is-open");backdrop.setAttribute("aria-hidden","false");window.lockPageScroll?.("receipt-viewer");
}
function closeReceiptViewer() {
  const backdrop = $("receiptDetailBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("is-open");backdrop.setAttribute("aria-hidden","true");
  if ($("receiptDetailPreview")) $("receiptDetailPreview").innerHTML="";
  const link=$("receiptDetailOpenLink");if(link){link.removeAttribute("href");link.hidden=true;}
  window.unlockPageScroll?.("receipt-viewer");
}
window.uploadExploraReceipt = uploadExploraReceipt;
window.motorCargaComprobanteGasto = uploadExploraReceipt;
window.ExploraReceiptEngine = {
  receiptUploadStates,
  uploadStates,
  createReceiptState,
  uploadExploraReceipt,
  selectUploadFile,
  prepareUploadFile,
  compressReceiptImage,
  compressUploadImage:compressReceiptImage,
  uploadProcessedFile,
  saveReceiptMetadata,
  processAndUploadFile,
  processAndUploadReceipt:processAndUploadFile,
  resolveReceiptSource,
  buildReceiptIndexPayload,
  receiptIndexId,
  openReceiptViewer,
  closeReceiptViewer,
  resetUploadState,
  deleteUploadedFile,
  getState:getUploadState
};
window.compressReceiptImage = compressReceiptImage;
window.ExploraCompressReceiptImage = async file => {
  const prepared = await compressReceiptImage(file, { maxDimension:1400, quality:.75, targetBytes:600*1024 });
  return { blob:prepared.file, mimeType:prepared.mimeType, extension:prepared.extension, size:prepared.size, fileName:prepared.file.name || prepared.originalName };
};

async function rollbackReceipt(receipt) {
  if (receipt?.receiptPath) await deleteUploadedFile(receipt.receiptPath).catch(() => {});
}
function refreshAfter(reason, category) {
  try { window.ExploraWeeklyEngine?.invalidate?.(reason || "operation-changed", { refresh:true }); } catch (_) {}
  window.invalidateWeeklyFinancialEngine?.(reason);
  window.ExploraInvalidateWeeklyClosure?.(reason, { refresh:false });
  window.invalidateReceiptCache?.(category);
  window.ExploraReceipts?.refresh?.(category);
}

function makeAliasBillingError(code, message, cause = null) {
  const error = new Error(message || code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}
function annotateAliasBillingError(error, detail = {}) {
  const target = error instanceof Error ? error : makeAliasBillingError("ALIAS_UNKNOWN_ERROR", String(error || "Error desconocido"));
  target.aliasStage = detail.stage || target.aliasStage || "VALIDATION";
  target.aliasPath = detail.path || target.aliasPath || "";
  target.aliasOriginalSize = Number(detail.originalSize || target.aliasOriginalSize || 0);
  target.aliasProcessedSize = Number(detail.processedSize || target.aliasProcessedSize || 0);
  target.aliasStorageUploaded = Boolean(detail.storageUploaded || target.aliasStorageUploaded);
  if (detail.bucket) target.aliasBucket = detail.bucket;
  if (detail.uid) target.aliasUid = detail.uid;
  if (detail.authUid) target.aliasAuthUid = detail.authUid;
  if (detail.routeUid) target.aliasRouteUid = detail.routeUid;
  if (detail.uidMatch !== undefined) target.aliasUidMatch = Boolean(detail.uidMatch);
  if (detail.mimeType) target.aliasMimeType = detail.mimeType;
  if (detail.category) target.aliasCategory = detail.category;
  if (detail.storageRuleScope) target.aliasStorageRuleScope = detail.storageRuleScope;
  if (detail.cleanupAttempted !== undefined) target.aliasCleanupAttempted = Boolean(detail.cleanupAttempted);
  if (detail.cleanupSucceeded !== undefined) target.aliasCleanupSucceeded = Boolean(detail.cleanupSucceeded);
  if (detail.cleanupError) target.aliasCleanupError = detail.cleanupError;
  return target;
}
window.ExploraRegisterBillingRecord = async function(input = {}) {
  let aliasStage = "SESSION";
  let aliasPath = "";
  let aliasProcessed = null;
  let aliasUploadReference = null;
  let aliasStorageUploaded = false;
  let session = null;
  let authUid = "";
  let paymentMethod = "";
  let receiptRequired = false;
  let receiptMethodLabel = "";
  let amount = 0;
  let operationId = "";
  let billingRef = null;
  let receipt = null;
  let created = false;

  const emitStage = (stage, detail = {}) => {
    aliasStage = stage;
    try { input.onStage?.(stage, detail); } catch (_) {}
  };

  try {
    emitStage("SESSION");
    session = await getSession();
    authUid = String(auth?.currentUser?.uid || "").trim();
    if (!authUid) throw makeAliasBillingError("auth/unauthenticated", "No se pudo verificar la sesión del chofer.");
    if (String(session.uid || "").trim() !== authUid) throw makeAliasBillingError("BILLING_AUTH_UID_MISMATCH", "El UID de la sesión no coincide con Firebase Authentication.");

    emitStage("VALIDATION");
    paymentMethod = String(input.paymentMethod || "").toLowerCase();
    if (!["cash","card","transfer","qr"].includes(paymentMethod)) throw makeAliasBillingError("BILLING_METHOD_INVALID", "El método de cobro no es válido.");
    receiptRequired = ["card","transfer","qr"].includes(paymentMethod);
    receiptMethodLabel = ({card:"tarjeta",transfer:"transferencia",qr:"qr",cash:"efectivo"})[paymentMethod] || paymentMethod;
    amount = parseCurrencyInput(input.amount);
    if (!(amount > 0)) throw makeAliasBillingError("BILLING_AMOUNT_INVALID", "Ingresa un monto válido.");
    operationId = String(input.operationId || stableId("bill", session.uid)).replace(/[^a-zA-Z0-9_-]/g, "").slice(0,110);
    if (!operationId) throw makeAliasBillingError("BILLING_ID_INVALID", "No se pudo generar el identificador del cobro.");
    if (!session.uid || /(?:undefined|null)/i.test(session.uid)) throw makeAliasBillingError("BILLING_DRIVER_UID_INVALID", "No se pudo identificar al chofer.");
    billingRef = doc(db, "billing_records", operationId);
    const periods = activePeriods();

    if (receiptRequired) {
      if (!(input.receiptFile instanceof File)) throw makeAliasBillingError("PAYMENT_RECEIPT_REQUIRED", "Selecciona un comprobante válido.");
      if (!(input.receiptFile.size > 0)) throw makeAliasBillingError("PAYMENT_RECEIPT_EMPTY", "El comprobante seleccionado está vacío.");
      if (!storage) throw makeAliasBillingError("storage/not-initialized", "Firebase Storage no está inicializado.");
      if (!authUid || authUid !== String(session.uid || "").trim()) throw makeAliasBillingError("auth/unauthenticated", "No se pudo verificar la sesión del chofer.");

      receipt = await window.motorCargaComprobanteGasto({
        file:input.receiptFile,
        context:"aliasPayment",
        ownerUid:authUid,
        driverUid:authUid,
        recordId:operationId,
        weeklyPeriodId:periods.weeklyPeriodId,
        destinationPath:`gastos/${authUid}/${operationId}/comprobante.{extension}`,
        allowPdf:false,
        uploadedByUid:authUid,
        uploadedByRole:"driver",
        category:"payment",
        metadata:{ type:"payment", paymentMethod:receiptMethodLabel, receiptCategory:"cliente", amount },
        onStage:(stage,detail={})=>{
          if(stage==="PROCESS_FILE")emitStage("PROCESS_IMAGE",{originalSize:input.receiptFile.size});
          else if(stage==="UPLOAD_START"){aliasPath=String(detail.path||"");emitStage("STORAGE_UPLOAD",detail);}
          else if(stage==="UPLOAD_COMPLETE")emitStage("GET_URL",detail);
          else if(stage==="ERROR")emitStage("STORAGE_UPLOAD",detail);
        }
      });
      aliasPath=receipt.receiptPath||aliasPath;
      aliasStorageUploaded=true;
      aliasProcessed=getUploadState("aliasPayment")?.processedFile?.expenseProcessed||getUploadState("aliasPayment")?.processedFile||null;
      try { input.onProcessed?.(aliasProcessed); } catch (_) {}
    }

    const now = new Date();
    const payload = {
      billingId:operationId, id:operationId, operationId, driverUid:session.uid, uid:session.uid, choferUid:session.uid,
      choferId:session.profileDocumentId, profileDocumentId:session.profileDocumentId, driverName:getDriverName(session), amount, monto:amount, valor:amount, finalPrice:amount,
      paymentMethod, metodoPago:paymentMethod, financialCategory:paymentMethod === "transfer" ? "alias" : paymentMethod,
      type:receiptRequired ? "payment" : "billing", receiptCategory:receiptRequired ? "cliente" : null, receiptPaymentMethod:receiptRequired ? receiptMethodLabel : paymentMethod,
      manualTransfer:paymentMethod === "transfer", manualPointPayment:paymentMethod === "card" || paymentMethod === "qr", receiptRequired,
      verificationMode:receiptRequired ? "manual_receipt" : "manual",
      paymentProvider:paymentMethod === "card" ? "manual_point_card" : paymentMethod === "qr" ? "manual_point_qr" : paymentMethod === "transfer" ? "manual_transfer" : "manual_cash",
      paymentStatus:receiptRequired ? "receipt_uploaded" : "manually_confirmed",
      status:"completed", estado:"completado", source:"manual_billing", weeklyPeriodId:periods.weeklyPeriodId, periodoSemanalId:periods.weeklyPeriodId,
      monthlyPeriodId:periods.monthlyPeriodId, yearlyPeriodId:periods.yearlyPeriodId, year:periods.year, month:periods.month,
      fecha:now.toLocaleDateString("es-AR", { timeZone:AR_TZ }), hora:now.toLocaleTimeString("es-AR", { timeZone:AR_TZ, hour:"2-digit", minute:"2-digit" }),
      ...saveReceiptMetadata(receipt || {}, { ownerUid:session.uid, uploadedByUid:session.uid, uploadedByRole:"driver" }),
      createdAt:serverTimestamp(), completedAt:serverTimestamp(), updatedAt:serverTimestamp()
    };

    emitStage("FIRESTORE_WRITE", { path:aliasPath, storageUploaded:aliasStorageUploaded });
    await runTransaction(db, async transaction => {
      const existing = await transaction.get(billingRef);
      if (existing.exists()) {
        if (String(existing.data()?.driverUid || existing.data()?.uid || "") !== session.uid) throw makeAliasBillingError("BILLING_OPERATION_CONFLICT", "El identificador del cobro pertenece a otra operación.");
        return;
      }
      transaction.set(billingRef, payload);
      if (receipt) {
        const indexPayload = buildReceiptIndexPayload({ category:"payment", recordId:operationId, driverUid:session.uid, ownerUid:session.uid, uploadedByUid:session.uid, uploadedByRole:"driver", weeklyPeriodId:periods.weeklyPeriodId, amount, receipt, status:"uploaded" });
        const detailLabel = paymentMethod === "card" ? "Tarjeta del cliente" : paymentMethod === "qr" ? "Código QR del cliente" : "Transferencia del cliente";
        Object.assign(indexPayload,{type:"payment",paymentMethod:receiptMethodLabel,receiptCategory:"cliente",detail:detailLabel});
        transaction.set(doc(db, "receipt_index", indexPayload.receiptId), indexPayload);
      }
      created = true;
    });

    if (created) {
      try { await Promise.resolve(window.ExploraWeeklyEngine?.applyBilling?.(payload)); }
      catch (refreshError) { console.warn("PAYMENT_WEEKLY_REFRESH_WARNING", refreshError?.code || refreshError?.message); }
      refreshAfter("billing-created", "payments");
    }
    return { id:operationId, ...payload };
  } catch (error) {
    let cleanupAttempted = false;
    let cleanupSucceeded = false;
    let cleanupError = null;
    if (!aliasProcessed) {
      const failedState = getUploadState("aliasPayment");
      aliasProcessed = failedState?.processedFile?.expenseProcessed || failedState?.processedFile || null;
    }
    if (receiptRequired && aliasStorageUploaded && (receipt?.receiptPath || aliasPath)) {
      cleanupAttempted = true;
      try { await deleteUploadedFile(receipt?.receiptPath || aliasPath); cleanupSucceeded = true; }
      catch (orphanError) { cleanupError = orphanError; console.warn("ALIAS_ORPHAN_CLEANUP", orphanError?.code || orphanError?.message); }
    }
    throw annotateAliasBillingError(error, {
      stage:aliasStage,
      path:aliasPath,
      originalSize:input.receiptFile?.size,
      processedSize:aliasProcessed?.blob?.size || aliasProcessed?.byteSize,
      storageUploaded:aliasStorageUploaded,
      cleanupAttempted,
      cleanupSucceeded,
      cleanupError,
      bucket:String(storage?.app?.options?.storageBucket || ""),
      uid:String(authUid || session?.uid || auth?.currentUser?.uid || ""),
      authUid:String(authUid || auth?.currentUser?.uid || ""),
      routeUid:String(aliasPath || "").split("/")[1] || "",
      uidMatch:Boolean((authUid || auth?.currentUser?.uid) && String(aliasPath || "").split("/")[1] === String(authUid || auth?.currentUser?.uid)),
      mimeType:String(aliasProcessed?.mimeType || input.receiptFile?.type || ""),
      category:"pago_cliente",
      storageRuleScope:"gastos/{uid}/{recordId}/{archivo}"
    });
  }
};
window.ExploraRegisterSoldService = window.ExploraRegisterBillingRecord;

const ExploraExpenseV202 = (() => {
  "use strict";

  const screen = $("expenseScreen");
  if (!screen) return null;

  const TYPE_LABELS = Object.freeze({
    combustible:"Combustible",
    peajes:"Peajes",
    estacionamiento:"Estacionamiento",
    lavado:"Lavado",
    mantenimiento:"Mantenimiento",
    compras:"Compras"
  });
  const ALLOWED_STAGES = new Set([
    "IDLE",
    "FILE_SELECTED",
    "SESSION",
    "TYPE_VALIDATION",
    "AMOUNT_VALIDATION",
    "FILE_VALIDATION",
    "IMAGE_PROCESS",
    "FIREBASE_FLOW_VALIDATION",
    "STORAGE_PATH",
    "STORAGE_UPLOAD",
    "STORAGE_UPLOAD_TIMEOUT",
    "GET_DOWNLOAD_URL",
    "FIRESTORE_WRITE",
    "WEEKLY_REFRESH",
    "RECEIPT_INDEX",
    "COMPLETED",
    "ERROR",
    "ROLLBACK"
  ]);

  const expenseUploadState = {
    file:null,
    lastSelectedFile:null,
    previewUrl:null,
    processedFile:null,
    saving:false,
    stage:"IDLE",
    errorStage:"",
    lastError:null,
    expenseType:"",
    expenseId:"",
    weeklyPeriodId:"",
    receiptPath:"",
    committedResult:null,
    previousScrollY:0,
    diagnosticText:"",
    cleanupMessage:"",
    uploadTask:null,
    uploadPercent:0,
    taskState:"idle",
    sourceExtension:"",
    processedExtension:"",
    detectedExtension:"",
    detectedMimeType:"",
    formatMutation:"",
    networkState:"idle",
    httpStatus:"—",
    serverResponse:"",
    lastProgressAt:0,
    startedAt:0,
    timeoutMs:45000,
    timeoutActive:false,
    realError:"",
    cancelAttempted:false,
    storageConfirmed:false,
    urlObtained:false,
    firestoreConfirmed:false
  };

  const makeError = (code, message, cause = null) => {
    const error = new Error(message || code || "Error desconocido");
    error.code = String(code || "EXPENSE_UNKNOWN_ERROR");
    if (cause) error.cause = cause;
    return error;
  };
  const errorCode = error => String(error?.code || error?.cause?.code || error?.name || "EXPENSE_UNKNOWN_ERROR");
  const errorMessage = error => String(error?.message || error?.cause?.message || "Error desconocido").slice(0, 600);
  const setText = (id, value) => { const node = $(id); if (node) node.textContent = String(value ?? "—"); };
  const bytes = value => {
    const size = Number(value || 0);
    if (!(size > 0)) return "—";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
    return `${(size / 1024 / 1024).toFixed(2)} MB`;
  };
  const sourceExtension = file => {
    const name = String(file?.name || "");
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  };
  const extensionForMime = mime => {
    const value = String(mime || "").toLowerCase();
    if (value === "image/webp") return "webp";
    if (value === "image/jpeg" || value === "image/jpg") return "jpg";
    if (value === "image/png") return "png";
    return "";
  };
  const normalizeImageMime = mime => {
    const value = String(mime || "").trim().toLowerCase();
    return value === "image/jpg" ? "image/jpeg" : value;
  };
  async function inspectImageBlob(blob) {
    if (!(blob instanceof Blob) || !(blob.size > 0)) {
      throw makeError("EXPENSE_FORMAT_BLOB_INVALID", "No se pudo validar el formato real del comprobante.");
    }
    const headerBuffer = await blob.slice(0, 16).arrayBuffer();
    const header = new Uint8Array(headerBuffer);
    const isJpeg = header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const isPng = header.length >= 8 && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47 && header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a;
    const isWebp = header.length >= 12 && String.fromCharCode(...header.slice(0, 4)) === "RIFF" && String.fromCharCode(...header.slice(8, 12)) === "WEBP";
    if (isJpeg) return { mimeType:"image/jpeg", extension:"jpg", signature:"JPEG FF D8 FF" };
    if (isPng) return { mimeType:"image/png", extension:"png", signature:"PNG 89 50 4E 47" };
    if (isWebp) return { mimeType:"image/webp", extension:"webp", signature:"WEBP RIFF" };
    throw makeError("EXPENSE_FORMAT_SIGNATURE_UNKNOWN", "Los bytes procesados no corresponden a JPG, PNG ni WebP.");
  }
  function extractStorageNetworkDetails(error) {
    const code = String(error?.code || error?.cause?.code || "");
    const message = String(error?.message || error?.cause?.message || "");
    const serverResponse = String(error?.serverResponse || error?.cause?.serverResponse || error?.customData?.serverResponse || error?.cause?.customData?.serverResponse || "").slice(0, 500);
    const combined = `${code} ${message} ${serverResponse}`;
    let httpStatus = "—";
    const explicit = combined.match(/(?:HTTP(?:\s+status)?|status(?:Code)?)\s*[:=]?\s*(\d{3})/i) || combined.match(/\b([45]\d{2})\b/);
    if (explicit) httpStatus = explicit[1];
    else if (code === "storage/unauthorized") httpStatus = "403";
    else if (code === "storage/unauthenticated") httpStatus = "401";
    else if (code === "storage/invalid-argument") httpStatus = "400";
    else if (code === "storage/object-not-found" || code === "storage/bucket-not-found") httpStatus = "404";
    return { httpStatus, serverResponse:serverResponse || message.slice(0, 500) || "—" };
  }
  function logExpenseUpload(level, event, detail = {}) {
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "info";
    console[method]("[EXPLORA CARGAR GASTO]", { event, timestamp:new Date().toISOString(), ...detail });
  }
  const sanitizePath = value => String(value || "—").replace(/https?:\/\/\S+/gi, "[URL OCULTA]").slice(0, 320);

  const EXPENSE_TIMEOUTS = Object.freeze({ image:45000, upload:45000, downloadUrl:45000, firestore:45000, rollback:12000 });
  function withTimeout(promise, ms, code, message, onTimeout) {
    let timer;
    let settled = false;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { onTimeout?.(); } catch (_) {}
        reject(makeError(code, message));
      }, ms);
      Promise.resolve(promise).then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  function markBusy(value) {
    expenseUploadState.saving = Boolean(value);
    const form = $("expenseForm");
    if (form) {
      if (value) form.setAttribute("aria-busy", "true");
      else form.removeAttribute("aria-busy");
    }
  }

  function setStage(stage) {
    expenseUploadState.stage = ALLOWED_STAGES.has(stage) ? stage : "FIREBASE_FLOW_VALIDATION";
  }
  function setMessage(text = "", isError = false) {
    const node = $("expenseMessage");
    if (!node) return;
    node.textContent = text;
    node.className = `expense-message${isError ? " err" : ""}`;
  }
  function setProgress(text = "") {
    const node = $("expenseUploadProgress");
    if (!node) return;
    node.textContent = String(text || "").trim();
    node.hidden = true;
    node.setAttribute("aria-hidden", "true");
  }
  function setButton(label = "CARGAR GASTO") {
    const button = $("expenseSubmitBtn");
    if (!button) return;
    const labelNode = button.querySelector("span");
    if (labelNode) labelNode.textContent = label;
    button.disabled = Boolean(expenseUploadState.saving);
    button.setAttribute("aria-disabled", button.disabled ? "true" : "false");
    button.setAttribute("aria-busy", expenseUploadState.saving ? "true" : "false");
  }
  function updateAmountState() {
    const input = $("expenseAmountInput");
    const amount = parseCurrencyInput(input?.value || "");
    const box = input?.closest(".expense-amount-box");
    box?.classList.toggle("is-valid", amount > 0);
    box?.classList.toggle("is-invalid", !(amount > 0));
    return amount;
  }
  function restoreInteraction() {
    screen.style.removeProperty("pointer-events");
    screen.style.overflowY = "auto";
    screen.style.touchAction = "pan-y";
    const form = $("expenseForm");
    if (form) {
      form.style.removeProperty("pointer-events");
      form.removeAttribute("aria-busy");
    }
    document.body.style.removeProperty("pointer-events");
    document.documentElement.style.removeProperty("pointer-events");
  }
  function hideDiagnostic() {
    const panel = $("expenseDiagnosticPanel");
    if (panel) panel.hidden = true;
    expenseUploadState.diagnosticText = "";
  }

  function normalizeExpenseType(value) {
    return String(value || "").trim().toLowerCase();
  }

  function readElementsExpenseType(form) {
    if (!form?.elements) return "";
    const field = form.elements.namedItem("expenseType");
    if (!field) return "";
    if (typeof RadioNodeList !== "undefined" && field instanceof RadioNodeList) {
      return normalizeExpenseType(field.value);
    }
    if (field instanceof HTMLInputElement) {
      return field.checked ? normalizeExpenseType(field.value) : "";
    }
    return normalizeExpenseType(field.value);
  }

  function captureExpenseTypeDiagnostics() {
    const form = $("expenseForm");
    const grid = $("expenseTypeGrid");
    const radios = grid ? Array.from(grid.querySelectorAll('input[type="radio"][name="expenseType"]')) : [];
    const checkedRadios = radios.filter(radio => radio.checked);
    const checkedRadio = checkedRadios[0] || null;
    const visualCards = grid ? Array.from(grid.querySelectorAll(".expense-type-card.is-selected")) : [];
    let formDataType = "";
    if (form) {
      try { formDataType = normalizeExpenseType(new FormData(form).get("expenseType")); }
      catch (_) { formDataType = ""; }
    }
    const elementsType = readElementsExpenseType(form);
    const visualValues = visualCards.map(card => normalizeExpenseType(card.control?.value || "")).filter(Boolean);
    const checkedValue = normalizeExpenseType(checkedRadio?.value || "");
    return {
      formFound:Boolean(form),
      gridFound:Boolean(grid),
      formDataType,
      elementsType,
      stateType:normalizeExpenseType(expenseUploadState.expenseType),
      radioCount:radios.length,
      checkedCount:checkedRadios.length,
      checkedId:checkedRadio?.id || "",
      checkedValue,
      visualCard:visualValues.length ? visualValues.join(", ") : "",
      visualCount:visualCards.length,
      typeValid:Boolean(checkedValue && TYPE_LABELS[checkedValue]),
      filePreserved:expenseUploadState.file instanceof File || expenseUploadState.lastSelectedFile instanceof File
    };
  }

  function clearExpenseTypeError() {
    const section = $("expenseTypeSection");
    const grid = $("expenseTypeGrid");
    const errorNode = $("expenseTypeError");
    section?.classList.remove("is-invalid");
    grid?.setAttribute("aria-invalid", "false");
    if (errorNode) errorNode.hidden = true;
  }

  function showExpenseTypeError(message = "Selecciona el tipo de gasto antes de cargar el comprobante.") {
    const section = $("expenseTypeSection");
    const grid = $("expenseTypeGrid");
    const errorNode = $("expenseTypeError");
    section?.classList.add("is-invalid");
    grid?.setAttribute("aria-invalid", "true");
    if (errorNode) {
      errorNode.textContent = message;
      errorNode.hidden = false;
    }
    requestAnimationFrame(() => {
      section?.scrollIntoView({ behavior:"smooth", block:"start" });
      const firstRadio = grid?.querySelector('input[type="radio"][name="expenseType"]');
      try { firstRadio?.focus({ preventScroll:true }); }
      catch (_) { firstRadio?.focus(); }
    });
  }

  function syncExpenseTypeUI({ clearValidationError = true } = {}) {
    const grid = $("expenseTypeGrid");
    const radios = grid ? Array.from(grid.querySelectorAll('input[type="radio"][name="expenseType"]')) : [];
    const selectedRadio = radios.find(radio => radio.checked) || null;
    const expenseType = normalizeExpenseType(selectedRadio?.value || "");

    radios.forEach(radio => {
      const card = document.querySelector(`label[for="${radio.id}"]`);
      const selected = radio === selectedRadio;
      card?.classList.toggle("is-selected", selected);
      card?.setAttribute("aria-checked", selected ? "true" : "false");
    });

    expenseUploadState.expenseType = expenseType;
    if (expenseType && TYPE_LABELS[expenseType] && clearValidationError) {
      clearExpenseTypeError();
      if (expenseUploadState.errorStage === "TYPE_VALIDATION") {
        hideDiagnostic();
        expenseUploadState.errorStage = "";
        expenseUploadState.lastError = null;
      }
      setMessage("");
    }
    return expenseType;
  }

  function validateExpenseTypeFromForm() {
    const details = captureExpenseTypeDiagnostics();
    const fail = (code, message) => {
      const error = makeError(code, message);
      error.expenseTypeDiagnostics = details;
      throw error;
    };

    if (!details.formFound) fail("EXPENSE_FORM_MISSING", "No se encontró el formulario de Cargar gasto.");
    if (!details.gridFound) fail("EXPENSE_TYPE_GRID_MISSING", "No se encontró el selector del tipo de gasto.");
    if (details.radioCount === 0) fail("EXPENSE_TYPE_RADIOS_MISSING", "No se encontraron las categorías de gasto.");
    if (details.checkedCount === 0) {
      if (details.visualCount > 0) fail("EXPENSE_TYPE_VISUAL_DESYNC", "La categoría aparece seleccionada, pero el control real no está marcado.");
      fail("EXPENSE_TYPE_REQUIRED", "Selecciona el tipo de gasto.");
    }
    if (details.checkedCount > 1) fail("EXPENSE_TYPE_MULTIPLE_SELECTION", "Hay más de un tipo de gasto marcado.");
    if (!details.checkedValue) fail("EXPENSE_TYPE_VALUE_MISSING", "La categoría marcada no contiene un valor válido.");
    if (!TYPE_LABELS[details.checkedValue]) fail("EXPENSE_TYPE_INVALID", "El tipo de gasto seleccionado no es válido.");
    if (details.formDataType !== details.checkedValue || details.elementsType !== details.checkedValue) {
      fail("EXPENSE_TYPE_FORM_DESYNC", "El tipo de gasto está desincronizado dentro del formulario.");
    }

    expenseUploadState.expenseType = details.checkedValue;
    syncExpenseTypeUI({ clearValidationError:true });
    return details.checkedValue;
  }

  function validateFile(file) {
    if (!(file instanceof File)) throw makeError("EXPENSE_FILE_REQUIRED", "Selecciona un comprobante.");
    if (!(file.size > 0)) throw makeError("EXPENSE_FILE_EMPTY", "El archivo seleccionado está vacío.");
    if (file.size > 20 * 1024 * 1024) throw makeError("EXPENSE_FILE_TOO_LARGE", "El archivo seleccionado supera 20 MB.");
    const mime = String(file.type || "").toLowerCase();
    const extension = sourceExtension(file);
    const mimeToExt = { "image/jpeg":["jpg","jpeg"], "image/jpg":["jpg","jpeg"], "image/png":["png"], "image/webp":["webp"] };
    if (!mimeToExt[mime]) throw makeError("EXPENSE_FILE_TYPE_UNSUPPORTED", "El comprobante debe ser una imagen JPG, PNG o WebP.");
    if (!extension || !mimeToExt[mime].includes(extension)) throw makeError("EXPENSE_FILE_EXTENSION_MISMATCH", "La extensión del archivo no coincide con el tipo de imagen permitido.");
    return file;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      let completed = false;
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        cleanup();
        reject(makeError("EXPENSE_IMAGE_DECODE_TIMEOUT", "La imagen tardó demasiado en prepararse."));
      }, EXPENSE_TIMEOUTS.image);
      const cleanup = () => {
        clearTimeout(timer);
        try { URL.revokeObjectURL(objectUrl); } catch (_) {}
        image.onload = null;
        image.onerror = null;
      };
      image.decoding = "async";
      image.onload = () => {
        if (completed) return;
        completed = true;
        const width = Number(image.naturalWidth || image.width || 0);
        const height = Number(image.naturalHeight || image.height || 0);
        if (!(width > 0 && height > 0)) {
          cleanup();
          reject(makeError("EXPENSE_IMAGE_DIMENSIONS_INVALID", "La imagen no tiene dimensiones válidas."));
          return;
        }
        resolve({ image, width, height, cleanup });
      };
      image.onerror = nativeError => {
        if (completed) return;
        completed = true;
        cleanup();
        reject(makeError("EXPENSE_IMAGE_DECODE_FAILED", "No se pudo leer la imagen seleccionada.", nativeError));
      };
      image.src = objectUrl;
    });
  }

  function canvasBlob(canvas, mimeType, quality) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(makeError("EXPENSE_IMAGE_ENCODE_TIMEOUT", "La compresión de la imagen excedió el tiempo máximo."));
      }, 15000);
      const finishError = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      try {
        canvas.toBlob(async blob => {
          if (settled) return;
          if (!(blob instanceof Blob) || !(blob.size > 0)) {
            finishError(makeError("EXPENSE_IMAGE_ENCODE_EMPTY", "La compresión produjo un archivo vacío."));
            return;
          }
          try {
            // Safari iOS puede conservar un Blob respaldado de forma diferida por el canvas.
            // Materializar los bytes antes de liberar el canvas evita tareas de Storage en 0 %.
            const buffer = await withTimeout(
              blob.arrayBuffer(),
              12000,
              "EXPENSE_IMAGE_BYTES_TIMEOUT",
              "No se pudieron materializar los bytes del comprobante."
            );
            if (!(buffer instanceof ArrayBuffer) || !(buffer.byteLength > 0)) {
              finishError(makeError("EXPENSE_IMAGE_BYTES_EMPTY", "La imagen procesada no contiene bytes válidos."));
              return;
            }
            const stableType = String(blob.type || mimeType || "image/jpeg").toLowerCase();
            const stableBlob = new Blob([buffer.slice(0)], { type:stableType });
            if (!(stableBlob.size > 0)) {
              finishError(makeError("EXPENSE_IMAGE_STABLE_BLOB_EMPTY", "No se pudo estabilizar la imagen procesada."));
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(stableBlob);
          } catch (error) {
            finishError(error?.code ? error : makeError("EXPENSE_IMAGE_BYTES_FAILED", "No se pudieron preparar los bytes del comprobante.", error));
          }
        }, mimeType, quality);
      } catch (error) {
        finishError(makeError("EXPENSE_IMAGE_ENCODE_FAILED", "No se pudo comprimir la imagen.", error));
      }
    });
  }

  async function processImage(file) {
    validateFile(file);
    const decoded = await withTimeout(loadImage(file), EXPENSE_TIMEOUTS.image, "EXPENSE_IMAGE_PROCESS_TIMEOUT", "El procesamiento de la imagen excedió el tiempo máximo.");
    const canvas = document.createElement("canvas");
    let best = null;
    try {
      const maxDimension = 1400;
      const targetBytes = 500 * 1024;
      const sizeLimits = [1400, 1200, 1000, 850, 700, 560];
      const encodings = [
        ["image/webp", .78], ["image/webp", .72], ["image/webp", .66], ["image/webp", .60], ["image/webp", .54],
        ["image/jpeg", .78], ["image/jpeg", .72], ["image/jpeg", .66], ["image/jpeg", .60], ["image/jpeg", .54]
      ];

      for (const limit of sizeLimits) {
        const scale = Math.min(1, Math.min(maxDimension, limit) / Math.max(decoded.width, decoded.height));
        const width = Math.max(1, Math.round(decoded.width * scale));
        const height = Math.max(1, Math.round(decoded.height * scale));
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha:false });
        if (!context) throw makeError("EXPENSE_CANVAS_UNAVAILABLE", "El navegador no pudo preparar el comprobante.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(decoded.image, 0, 0, decoded.width, decoded.height, 0, 0, width, height);

        for (const [requestedMime, quality] of encodings) {
          let blob;
          try { blob = await canvasBlob(canvas, requestedMime, quality); }
          catch (_) { continue; }
          const mimeType = String(blob.type || "").toLowerCase();
          const extension = extensionForMime(mimeType);
          if (!extension) continue;
          if (requestedMime === "image/webp" && mimeType !== "image/webp") continue;
          const candidate = {
            blob,
            mimeType,
            extension,
            size:blob.size,
            width,
            height,
            originalName:String(file.name || "comprobante"),
            originalMimeType:String(file.type || ""),
            originalSize:Number(file.size || 0)
          };
          if (!best || candidate.size < best.size) best = candidate;
          if (candidate.size <= targetBytes) return candidate;
        }
      }
      if (!best) throw makeError("EXPENSE_IMAGE_PROCESS_FAILED", "No se pudo procesar la imagen seleccionada.");
      return best;
    } finally {
      try { decoded.cleanup(); } catch (_) {}
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  processExpenseReceiptUsingProfileFlow = processImage;

  function validateFirebaseFlow() {
    if (!auth?.currentUser?.uid) throw makeError("auth/unauthenticated", "No se encontró una sesión autenticada.");
    if (!storage) throw makeError("storage/not-initialized", "Firebase Storage no está inicializado.");
    if (!db) throw makeError("firestore/not-initialized", "Firestore no está inicializado.");
    if (typeof storageRef !== "function") throw makeError("EXPENSE_REF_UNAVAILABLE", "La función ref de Firebase Storage no está disponible.");
    if (typeof uploadBytesResumable !== "function") throw makeError("EXPENSE_UPLOAD_RESUMABLE_UNAVAILABLE", "La función uploadBytesResumable de Firebase Storage no está disponible.");
    if (typeof getDownloadURL !== "function") throw makeError("EXPENSE_GET_DOWNLOAD_URL_UNAVAILABLE", "La función getDownloadURL de Firebase Storage no está disponible.");
    if (!fb.app || auth.app !== fb.app || db.app !== fb.app || storage.app !== fb.app) {
      throw makeError("EXPENSE_FIREBASE_APP_MISMATCH", "Auth, Firestore y Storage no usan la misma Firebase App.");
    }
  }

  function createExpenseId() {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    return `exp_${Date.now()}_${String(random).slice(0, 16)}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 110);
  }

  function diagnostic(stage,code,error,context={}){
  const normalizedStage=normalizeGoalDiagnosticStage(stage),weekScope=window.ExploraPerformanceEngine?.getState?.()?.weekScope||{},periodId=context.weeklyPeriodId||activePeriods().weeklyPeriodId||weekScope.id||"—";
  const incentive=context.incentive||getSettlementIncentive(auth?.currentUser?.uid||state.uid||"",periodId),leader=state.currentDerivationLeader||{};
  const jsMessage=String(error?.message||context.message||code||"Error sin mensaje"),firebaseCode=String(context.firebaseCode||error?.code||"—"),firebaseMessage=String(context.firebaseMessage||((error?.code||context.firestorePath)?jsMessage:"—")),stack=String(error?.stack||"—");
  const payload=["EXPLORA - ERROR DERIVATION_MONEY_RANKING","MÓDULO: DERIVATION_MONEY_RANKING",`ETAPA: ${normalizedStage}`,`CÓDIGO INTERNO: ${code||"DERIVATION_MONEY_RANKING_ERROR"}`,`MENSAJE REAL FIREBASE: ${firebaseCode}${firebaseMessage!=="—"?` · ${firebaseMessage}`:""}`,`MENSAJE REAL JAVASCRIPT: ${jsMessage}`,`STACK: ${stack}`,`FUNCIÓN: ${inferFunctionName(error,context,stage)}`,`UID AUTH: ${auth?.currentUser?.uid||"—"}`,`ROL: ${state.role||role()||"—"}`,`EMISOR UID: ${context.emisorUid||context.senderUid||"—"}`,`RECEPTOR UID: ${context.receptorUid||context.receiverUid||"—"}`,`DERIVATION ID: ${context.derivationId||"—"}`,`STATUS: ${context.status||context.derivationState||"—"}`,`WEEKLY PERIOD ID: ${periodId}`,`WEEKLY PERIOD ID CONFIRMADO: ${periodId}`,`MONTO SUGERIDO: ${money(context.suggestedAmount||0)}`,`MONTO FINAL: ${money(context.finalAmount||0)}`,`FORMA DE PAGO: ${context.paymentMethod||"—"}`,`DINERO DERIVADO: ${money(context.derivedAmount??leader.derivedAmount??0)}`,`COLABORACIÓN PARA BONO: ${money(context.collaborationAmount||0)}`,`BONO LÍDER: ${money(context.leaderBonus??incentive.derivationBonusAmount??0)}`,`RUTA FIRESTORE: ${context.firestorePath||context.firestore||"—"}`,`FIRESTORE CONFIRMADO: ${context.firestoreConfirmed===true?"SÍ":"NO"}`,`TIMESTAMP: ${new Date().toISOString()}`].join("\n");
  state.error={stage:normalizedStage,code,message:jsMessage,payload};
  if(window.ExploraProductionPolicy&&!window.ExploraProductionPolicy.handle("ranking",error,{eventType:String(context.eventType||"ERROR"),silent:Boolean(context.silent),message:"No pudimos actualizar el ranking. Se mostrará la última información disponible.",context:{stage:normalizedStage,code,...context}}))return state.error;
  const backdrop=$("performanceDiagnosticBackdrop"),text=$("performanceDiagnosticText");if(text)text.textContent=payload;backdrop?.classList.add("is-open");backdrop?.setAttribute("aria-hidden","false");window.lockPageScroll?.("performance-diagnostic");return state.error;
}

  function renderDiagnostic(error, { scroll = true } = {}) {
    const snapshot = diagnosticSnapshot(error);
    if(window.ExploraProductionPolicy&&!window.ExploraProductionPolicy.handle("gasto",error,{message:"No pudimos registrar el gasto. Revisa los datos e intenta nuevamente.",context:snapshot})){
      const message=$("expenseMessage");if(message){message.textContent="No pudimos registrar el gasto. Revisa los datos e intenta nuevamente.";message.className="expense-message err";}
      return snapshot;
    }
    setText("expenseDiagnosticStage", snapshot.stage);
    setText("expenseDiagnosticCode", snapshot.code);
    setText("expenseDiagnosticMessage", snapshot.message);
    setText("expenseDiagnosticFormDataType", snapshot.formDataType);
    setText("expenseDiagnosticElementsType", snapshot.elementsType);
    setText("expenseDiagnosticStateType", snapshot.stateType);
    setText("expenseDiagnosticRadioCount", snapshot.radioCount);
    setText("expenseDiagnosticCheckedCount", snapshot.checkedCount);
    setText("expenseDiagnosticCheckedId", snapshot.checkedId);
    setText("expenseDiagnosticCheckedValue", snapshot.checkedValue);
    setText("expenseDiagnosticVisualCard", snapshot.visualCard);
    setText("expenseDiagnosticTypeValid", snapshot.typeValid);
    setText("expenseDiagnosticFormFound", snapshot.formFound);
    setText("expenseDiagnosticGridFound", snapshot.gridFound);
    setText("expenseDiagnosticFilePreserved", snapshot.filePreserved);
    setText("expenseDiagnosticFile", snapshot.file);
    setText("expenseDiagnosticOriginalMime", snapshot.originalMime);
    setText("expenseDiagnosticProcessedMime", snapshot.processedMime);
    setText("expenseDiagnosticSourceExtension", snapshot.sourceExtension);
    setText("expenseDiagnosticProcessedExtension", snapshot.processedExtension);
    setText("expenseDiagnosticDetectedFormat", snapshot.detectedFormat);
    setText("expenseDiagnosticFormatMutation", snapshot.formatMutation);
    setText("expenseDiagnosticOriginalSize", snapshot.originalSize);
    setText("expenseDiagnosticProcessedSize", snapshot.processedSize);
    setText("expenseDiagnosticSession", snapshot.session);
    setText("expenseDiagnosticUid", snapshot.uid);
    setText("expenseDiagnosticExpenseId", snapshot.expenseId);
    setText("expenseDiagnosticWeeklyPeriodId", snapshot.weeklyPeriodId);
    setText("expenseDiagnosticStorage", snapshot.storage);
    setText("expenseDiagnosticFirestore", snapshot.firestore);
    setText("expenseDiagnosticPath", snapshot.path);
    setText("expenseDiagnosticProgress", snapshot.progress);
    setText("expenseDiagnosticTaskState", snapshot.taskState);
    setText("expenseDiagnosticNetworkState", snapshot.networkState);
    setText("expenseDiagnosticHttpStatus", snapshot.httpStatus);
    setText("expenseDiagnosticServerResponse", snapshot.serverResponse);
    setText("expenseDiagnosticTimeout", snapshot.timeout);
    setText("expenseDiagnosticElapsed", snapshot.elapsed);
    setText("expenseDiagnosticRealError", snapshot.realError);
    setText("expenseDiagnosticCancelAttempted", snapshot.cancelAttempted);
    setText("expenseDiagnosticStorageConfirmed", snapshot.storageConfirmed);
    setText("expenseDiagnosticUrlObtained", snapshot.urlObtained);
    setText("expenseDiagnosticFirestoreConfirmed", snapshot.firestoreConfirmed);
    expenseUploadState.diagnosticText = [
      "EXPLORA - ERROR CARGAR GASTO",
      `Etapa: ${snapshot.stage}`,
      `Código: ${snapshot.code}`,
      `Mensaje: ${snapshot.message}`,
      `FormData expenseType: ${snapshot.formDataType}`,
      `Form elements expenseType: ${snapshot.elementsType}`,
      `Estado expenseType: ${snapshot.stateType}`,
      `Radios encontrados: ${snapshot.radioCount}`,
      `Radios marcados: ${snapshot.checkedCount}`,
      `Radio marcado ID: ${snapshot.checkedId}`,
      `Radio marcado value: ${snapshot.checkedValue}`,
      `Tarjeta visual seleccionada: ${snapshot.visualCard}`,
      `TYPE_LABELS válido: ${snapshot.typeValid}`,
      `Formulario encontrado: ${snapshot.formFound}`,
      `Grid encontrado: ${snapshot.gridFound}`,
      `Archivo conservado: ${snapshot.filePreserved}`,
      `Archivo: ${snapshot.file}`,
      `MIME original: ${snapshot.originalMime}`,
      `MIME procesado: ${snapshot.processedMime}`,
      `Extensión original: ${snapshot.sourceExtension}`,
      `Extensión procesada: ${snapshot.processedExtension}`,
      `Firma real: ${snapshot.detectedFormat}`,
      `Mutación de formato: ${snapshot.formatMutation}`,
      `Peso original: ${snapshot.originalSize}`,
      `Peso procesado: ${snapshot.processedSize}`,
      `Sesión: ${snapshot.session}`,
      `UID: ${snapshot.uid}`,
      `expenseId: ${snapshot.expenseId}`,
      `weeklyPeriodId: ${snapshot.weeklyPeriodId}`,
      `Storage: ${snapshot.storage}`,
      `Firestore: ${snapshot.firestore}`,
      `Ruta: ${snapshot.path}`,
      `Porcentaje: ${snapshot.progress}`,
      `Estado tarea: ${snapshot.taskState}`,
      `Estado de red: ${snapshot.networkState}`,
      `HTTP status: ${snapshot.httpStatus}`,
      `Respuesta servidor: ${snapshot.serverResponse}`,
      `Timeout: ${snapshot.timeout}`,
      `Tiempo transcurrido: ${snapshot.elapsed}`,
      `Error real: ${snapshot.realError}`,
      `Cancelación intentada: ${snapshot.cancelAttempted}`,
      `Storage confirmó: ${snapshot.storageConfirmed}`,
      `URL obtenida: ${snapshot.urlObtained}`,
      `Firestore confirmó: ${snapshot.firestoreConfirmed}`
    ].join("\n");
    const panel = $("expenseDiagnosticPanel");
    if (panel) {
      panel.hidden = false;
      if (scroll) requestAnimationFrame(() => panel.scrollIntoView({ behavior:"smooth", block:"nearest" }));
    }
  }

  async function copyDiagnostic() {
    const text = expenseUploadState.diagnosticText || "EXPLORA - ERROR CARGAR GASTO";
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const area = document.createElement("textarea");
      area.value = text;
      area.readOnly = true;
      area.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  function revokePreview() {
    if (expenseUploadState.previewUrl) {
      try { URL.revokeObjectURL(expenseUploadState.previewUrl); } catch (_) {}
    }
    expenseUploadState.previewUrl = null;
  }

  function updateUploadPrompt(replacing = false) {
    const title = $("expenseUploadBtn")?.querySelector(".receipt-upload-title");
    const subtitle = $("expenseUploadBtn")?.querySelector(".receipt-upload-subtitle");
    if (title) title.textContent = replacing ? "Reemplazar comprobante" : "Subir comprobante";
    if (subtitle) subtitle.textContent = replacing ? "Toca para seleccionar otra foto" : "Toca para seleccionar o tomar foto";
  }

  function clearFile({ showError = false } = {}) {
    revokePreview();
    expenseUploadState.file = null;
    expenseUploadState.lastSelectedFile = null;
    expenseUploadState.processedFile = null;
    if (!expenseUploadState.committedResult) {
      expenseUploadState.expenseId = "";
      expenseUploadState.receiptPath = "";
    }
    const input = $("expenseReceiptInput");
    if (input) input.value = "";
    const preview = $("expenseFilePreview");
    if (preview) { preview.hidden = true; preview.classList.remove("is-visible"); }
    const thumb = $("expensePreviewThumb");
    if (thumb) thumb.innerHTML = "";
    setText("expensePreviewName", "");
    setText("expensePreviewSize", "");
    updateUploadPrompt(false);
    hideDiagnostic();
    setMessage(showError ? "Selecciona un comprobante." : "", showError);
  }

  function renderFile(file) {
    revokePreview();
    expenseUploadState.file = file;
    expenseUploadState.lastSelectedFile = file;
    expenseUploadState.processedFile = null;
    expenseUploadState.committedResult = null;
    expenseUploadState.expenseId = "";
    expenseUploadState.receiptPath = "";
    expenseUploadState.previewUrl = URL.createObjectURL(file);

    const thumb = $("expensePreviewThumb");
    if (thumb) {
      thumb.innerHTML = "";
      const image = document.createElement("img");
      image.alt = "Vista previa del comprobante";
      image.src = expenseUploadState.previewUrl;
      image.addEventListener("error", () => { thumb.textContent = "IMG"; }, { once:true });
      thumb.appendChild(image);
    }
    setText("expensePreviewName", file.name || "Comprobante");
    setText("expensePreviewSize", `${file.type || "Sin MIME declarado"} · ${bytes(file.size)}`);
    const preview = $("expenseFilePreview");
    if (preview) { preview.hidden = false; preview.classList.add("is-visible"); }
    updateUploadPrompt(true);
    hideDiagnostic();
    setMessage("");
    requestAnimationFrame(() => $("expenseSubmitBtn")?.scrollIntoView({ behavior:"smooth", block:"center", inline:"nearest" }));
  }

  function handleFileSelection(event) {
    const file = event.target.files?.[0];
    expenseUploadState.lastSelectedFile = file || null;
    setStage("FILE_VALIDATION");
    try {
      validateFile(file);
      expenseUploadState.file = file;
      renderFile(file);
      setStage("FILE_SELECTED");
    } catch (error) {
      expenseUploadState.file = null;
      expenseUploadState.processedFile = null;
      event.target.value = "";
      expenseUploadState.errorStage = "FILE_VALIDATION";
      expenseUploadState.lastError = error;
      setMessage(errorMessage(error), true);
      renderDiagnostic(error);
    }
  }

  function assertExpenseStorageReference(reference) {
    const fullPath = String(reference?.fullPath || reference?._location?.path_ || "").trim();
    const bucket = String(reference?.bucket || reference?._location?.bucket || reference?.storage?.app?.options?.storageBucket || "").trim();
    if (!reference || !reference.storage) throw makeError("EXPENSE_STORAGE_REFERENCE_INVALID", "La referencia de Storage no es válida.");
    if (!fullPath || /undefined|null|\[object Object\]/i.test(fullPath)) throw makeError("EXPENSE_STORAGE_PATH_INVALID", "La ruta de Storage del comprobante no es válida.");
    if (!bucket || /undefined|null|\[object Object\]/i.test(bucket)) throw makeError("EXPENSE_STORAGE_BUCKET_INVALID", "El bucket efectivo de Storage no es válido.");
    return { fullPath, bucket };
  }

  function assertExpenseUploadPayload(blob, metadata = {}) {
    if (!(blob instanceof Blob)) throw makeError("EXPENSE_UPLOAD_BLOB_INVALID", "El comprobante procesado no es un Blob válido.");
    if (!(Number(blob.size) > 0)) throw makeError("EXPENSE_UPLOAD_BLOB_EMPTY", "El comprobante procesado quedó vacío.");
    const contentType = normalizeImageMime(metadata?.contentType || blob.type || "");
    const blobType = normalizeImageMime(blob.type || "");
    if (!contentType || !contentType.startsWith("image/")) throw makeError("EXPENSE_UPLOAD_CONTENT_TYPE_INVALID", "El contentType del comprobante no es válido.");
    if (!extensionForMime(contentType)) throw makeError("EXPENSE_UPLOAD_CONTENT_TYPE_UNSUPPORTED", "El contentType procesado no corresponde a JPG, PNG ni WebP.");
    if (blobType && blobType !== contentType) throw makeError("EXPENSE_UPLOAD_MIME_MISMATCH", "El MIME del Blob no coincide con el contentType de la subida.");
    const customMetadata = metadata?.customMetadata || {};
    for (const [key, value] of Object.entries(customMetadata)) {
      if (value === undefined || value === null || /\[object Object\]/i.test(String(value))) {
        throw makeError("EXPENSE_UPLOAD_METADATA_INVALID", `Metadata inválida en ${key}.`);
      }
    }
    return { contentType, customMetadata };
  }

  async function uploadExpenseReceiptResumable(reference, file, metadata = {}) {
    const refInfo = assertExpenseStorageReference(reference);

    if (!(file instanceof File || file instanceof Blob)) {
      throw makeError("EXPENSE_UPLOAD_FILE_INVALID", "El comprobante no es un File o Blob válido.");
    }
    if (!(Number(file.size) > 0)) {
      throw makeError("EXPENSE_UPLOAD_FILE_EMPTY", "El comprobante no contiene bytes para subir.");
    }

    const fileName = String(file.name || "").trim();
    const extensionFromName = String(fileName.match(/\.([a-zA-Z0-9]+)$/)?.[1] || "").toLowerCase();
    const contentType = normalizeImageMime(file.type || metadata?.contentType || "");
    const extensionFromMime = extensionForMime(contentType);
    const fileExtension = extensionFromName || extensionFromMime;

    if (!contentType || !extensionFromMime) {
      throw makeError("EXPENSE_UPLOAD_CONTENT_TYPE_UNSUPPORTED", "El MIME real del comprobante debe ser image/png, image/jpeg o image/webp.");
    }
    if (!fileExtension || !["png", "jpg", "jpeg", "webp"].includes(fileExtension)) {
      throw makeError("EXPENSE_UPLOAD_EXTENSION_UNSUPPORTED", "La extensión real del comprobante debe ser PNG, JPG, JPEG o WebP.");
    }

    const normalizedFileExtension = fileExtension === "jpeg" ? "jpg" : fileExtension;
    if (normalizedFileExtension !== extensionFromMime) {
      throw makeError(
        "EXPENSE_UPLOAD_FILE_FORMAT_MISMATCH",
        `La extensión .${fileExtension} no coincide con el MIME real ${contentType} (.${extensionFromMime}).`
      );
    }

    const uploadMetadata = assertExpenseUploadPayload(file, {
      ...metadata,
      contentType
    });
    const expectedExtension = normalizedFileExtension;
    const pathExtensionRaw = String(refInfo.fullPath.split(".").pop() || "").toLowerCase();
    const pathExtension = pathExtensionRaw === "jpeg" ? "jpg" : pathExtensionRaw;
    if (!expectedExtension || pathExtension !== expectedExtension) {
      throw makeError("EXPENSE_STORAGE_EXTENSION_MISMATCH", `La ruta .${pathExtensionRaw || "sin extensión"} no coincide con ${uploadMetadata.contentType} (.${expectedExtension || "—"}).`);
    }

    setStage("STORAGE_UPLOAD");
    expenseUploadState.receiptPath = refInfo.fullPath;
    expenseUploadState.realError = "";
    expenseUploadState.timeoutMs = EXPENSE_TIMEOUTS.upload;
    expenseUploadState.timeoutActive = true;
    expenseUploadState.taskState = "preparing-bytes";
    expenseUploadState.networkState = navigator.onLine ? "online-preparing" : "offline";
    expenseUploadState.httpStatus = "—";
    expenseUploadState.serverResponse = "";
    expenseUploadState.uploadPercent = 0;
    expenseUploadState.lastProgressAt = Date.now();
    setProgress(`ETAPA ACTUAL: UPLOADING_STORAGE · PORCENTAJE: 0 % · STORAGE PATH: ${refInfo.fullPath} · FORMATO: ${uploadMetadata.contentType} / .${expectedExtension} · UPLOAD TASK STATE: preparing-bytes · RED: ${expenseUploadState.networkState} · TIMEOUT: ${EXPENSE_TIMEOUTS.upload} ms`);

    // Se sube exactamente el File/Blob validado. La ruta y metadata se derivan
    // de este mismo objeto para evitar extensiones o MIME hardcodeados.

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      let watchdogId = null;
      let pollId = null;
      let unsubscribe = null;
      let task = null;
      let lastSnapshot = null;
      let lastBytes = 0;
      let lastLoggedPercent = -1;
      let observerEventSeen = false;

      const clearResources = () => {
        clearTimeout(timeoutId);
        clearTimeout(watchdogId);
        clearInterval(pollId);
        window.removeEventListener("offline", offlineHandler);
        try { unsubscribe?.(); } catch (_) {}
        expenseUploadState.timeoutActive = false;
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearResources();
        expenseUploadState.uploadTask = null;
        fn(value);
      };

      const updateFromSnapshot = snapshot => {
        if (!snapshot || settled) return;
        lastSnapshot = snapshot;
        const total = Number(snapshot.totalBytes || file.size || 0);
        const transferred = Number(snapshot.bytesTransferred || 0);
        lastBytes = Math.max(lastBytes, transferred);
        const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((transferred / total) * 100))) : 0;
        expenseUploadState.uploadPercent = percent;
        expenseUploadState.taskState = snapshot.state || "running";
        expenseUploadState.networkState = transferred > 0 ? "transferring" : (navigator.onLine ? "pending" : "offline");
        if (transferred > 0) expenseUploadState.lastProgressAt = Date.now();
        setButton(`SUBIENDO COMPROBANTE ${percent} %`);
        setProgress(`ETAPA ACTUAL: UPLOADING_STORAGE · PORCENTAJE: ${percent} % · STORAGE PATH: ${refInfo.fullPath} · FORMATO: ${uploadMetadata.contentType} / .${expectedExtension} · UPLOAD TASK STATE: ${expenseUploadState.taskState} · RED: ${expenseUploadState.networkState} · TIMEOUT: activo ${EXPENSE_TIMEOUTS.upload} ms`);
        if (snapshot.state === "paused") setMessage("La subida fue pausada por el navegador o la conexión.", true);
        else setMessage("");
        if (percent !== lastLoggedPercent && (percent === 0 || percent === 100 || percent - lastLoggedPercent >= 10)) {
          lastLoggedPercent = percent;
          logExpenseUpload("info", "storage-progress", { percent, bytesTransferred:transferred, totalBytes:total, state:snapshot.state, path:refInfo.fullPath });
        }
      };

      const completeUpload = snapshot => {
        const finalSnapshot = snapshot || task?.snapshot || lastSnapshot;
        if (!finalSnapshot?.ref) {
          finish(reject, makeError("EXPENSE_UPLOAD_SNAPSHOT_INVALID", "Firebase Storage no confirmó la subida."));
          return;
        }
        expenseUploadState.uploadPercent = 100;
        expenseUploadState.taskState = "success";
        expenseUploadState.networkState = "completed";
        expenseUploadState.httpStatus = "200";
        expenseUploadState.serverResponse = "Firebase Storage confirmó la carga";
        setButton("SUBIENDO COMPROBANTE 100 %");
        setProgress(`ETAPA ACTUAL: UPLOADING_STORAGE · PORCENTAJE: 100 % · STORAGE PATH: ${refInfo.fullPath} · FORMATO: ${uploadMetadata.contentType} / .${expectedExtension} · UPLOAD TASK STATE: success · RED: completed · HTTP: 200 · TIMEOUT: cancelado`);
        logExpenseUpload("info", "storage-success", { path:refInfo.fullPath, bytes:Number(finalSnapshot.totalBytes || file.size), state:finalSnapshot.state || "success" });
        finish(resolve, finalSnapshot);
      };

      const failUpload = error => {
        if (settled) return;
        if (expenseUploadState.cancelAttempted) {
          const timeoutError = makeError("EXPENSE_STORAGE_UPLOAD_TIMEOUT", "La conexión con Firebase Storage no respondió en 45 segundos. Verifica Internet e inténtalo nuevamente.", error);
          expenseUploadState.taskState = "failed";
          expenseUploadState.networkState = navigator.onLine ? "pending-timeout" : "offline-timeout";
          expenseUploadState.httpStatus = "PENDING";
          expenseUploadState.serverResponse = "La petición no finalizó antes del límite de 45000 ms";
          expenseUploadState.realError = `${timeoutError.code}: ${timeoutError.message}`;
          logExpenseUpload("error", "storage-timeout", { path:refInfo.fullPath, percent:expenseUploadState.uploadPercent, networkState:expenseUploadState.networkState });
          finish(reject, timeoutError);
          return;
        }
        const code = String(error?.code || "EXPENSE_STORAGE_UPLOAD_FAILED");
        const network = extractStorageNetworkDetails(error);
        expenseUploadState.taskState = "failed";
        expenseUploadState.networkState = navigator.onLine ? "failed" : "offline";
        expenseUploadState.httpStatus = network.httpStatus;
        expenseUploadState.serverResponse = network.serverResponse;
        expenseUploadState.realError = `${code}: ${error?.message || "No se pudo subir el comprobante."}`;
        setProgress(`ETAPA ACTUAL: ERROR · PORCENTAJE: ${Number(expenseUploadState.uploadPercent || 0)} % · STORAGE PATH: ${refInfo.fullPath} · UPLOAD TASK STATE: failed · RED: ${expenseUploadState.networkState} · HTTP: ${expenseUploadState.httpStatus} · TIMEOUT: cancelado · ERROR REAL: ${expenseUploadState.realError}`);
        logExpenseUpload("error", "storage-error", { code, message:error?.message || "", httpStatus:network.httpStatus, serverResponse:network.serverResponse, path:refInfo.fullPath });
        finish(reject, makeError(code, error?.message || "No se pudo subir el comprobante.", error));
      };

      const offlineHandler = () => {
        if (settled) return;
        expenseUploadState.networkState = "offline";
        const offlineError = makeError("EXPENSE_NETWORK_OFFLINE", "Se perdió la conexión a Internet durante la subida del comprobante.");
        failUpload(offlineError);
        try { task?.cancel?.(); } catch (_) {}
      };

      try {
        if (!navigator.onLine) throw makeError("EXPENSE_NETWORK_OFFLINE", "No hay conexión a Internet para subir el comprobante.");
        expenseUploadState.taskState = "starting";
        expenseUploadState.networkState = "request-starting";
        task = uploadBytesResumable(reference, file, uploadMetadata);
        if (!task || typeof task.on !== "function") {
          throw makeError("EXPENSE_UPLOAD_TASK_INVALID", "Firebase no devolvió una tarea de subida válida.");
        }
        expenseUploadState.uploadTask = task;
        expenseUploadState.taskState = "running";
        expenseUploadState.networkState = "pending";
        window.addEventListener("offline", offlineHandler);
        logExpenseUpload("info", "storage-request-start", { path:refInfo.fullPath, bucket:refInfo.bucket, size:file.size, contentType:uploadMetadata.contentType, online:navigator.onLine });

        unsubscribe = task.on(
          "state_changed",
          snapshot => {
            observerEventSeen = true;
            updateFromSnapshot(snapshot);
          },
          failUpload,
          () => completeUpload(task.snapshot || lastSnapshot)
        );

        Promise.resolve(task).then(completeUpload, failUpload);

        pollId = setInterval(() => {
          if (settled || !task) return;
          const snapshot = task.snapshot;
          if (snapshot) updateFromSnapshot(snapshot);
          if (snapshot?.state === "success") completeUpload(snapshot);
        }, 350);

        watchdogId = setTimeout(() => {
          if (settled || lastBytes > 0) return;
          expenseUploadState.networkState = navigator.onLine ? "pending-no-progress" : "offline";
          setMessage("Firebase Storage todavía no inició la transferencia. Se cancelará automáticamente al llegar a 45 segundos.", true);
          setProgress(`ETAPA ACTUAL: UPLOADING_STORAGE · PORCENTAJE: 0 % · STORAGE PATH: ${refInfo.fullPath} · FORMATO: ${uploadMetadata.contentType} / .${expectedExtension} · UPLOAD TASK STATE: running · RED: ${expenseUploadState.networkState} · HTTP: PENDING · TIMEOUT: activo ${EXPENSE_TIMEOUTS.upload} ms`);
          logExpenseUpload("warn", "storage-pending", { path:refInfo.fullPath, observerEventSeen, online:navigator.onLine, elapsedMs:Date.now() - expenseUploadState.lastProgressAt });
        }, 8000);

        timeoutId = setTimeout(() => {
          if (settled) return;
          expenseUploadState.cancelAttempted = true;
          expenseUploadState.taskState = "failed";
          expenseUploadState.networkState = navigator.onLine ? "pending-timeout" : "offline-timeout";
          expenseUploadState.httpStatus = "PENDING";
          expenseUploadState.serverResponse = "La petición permaneció sin finalizar durante 45000 ms";
          expenseUploadState.realError = "EXPENSE_STORAGE_UPLOAD_TIMEOUT: La conexión con Firebase Storage no respondió en 45 segundos.";
          setStage("STORAGE_UPLOAD_TIMEOUT");
          setProgress(`ETAPA ACTUAL: STORAGE_UPLOAD_TIMEOUT · PORCENTAJE: ${Number(expenseUploadState.uploadPercent || 0)} % · STORAGE PATH: ${refInfo.fullPath} · UPLOAD TASK STATE: failed · RED: ${expenseUploadState.networkState} · HTTP: PENDING · TIMEOUT: vencido · ERROR REAL: EXPENSE_STORAGE_UPLOAD_TIMEOUT`);
          const timeoutError = makeError("EXPENSE_STORAGE_UPLOAD_TIMEOUT", "La conexión con Firebase Storage no respondió en 45 segundos. Verifica Internet e inténtalo nuevamente.");
          try { task?.cancel?.(); } catch (_) {}
          failUpload(timeoutError);
        }, EXPENSE_TIMEOUTS.upload);
      } catch (error) {
        const network = extractStorageNetworkDetails(error);
        expenseUploadState.taskState = "failed";
        expenseUploadState.networkState = navigator.onLine ? "failed-before-request" : "offline";
        expenseUploadState.httpStatus = network.httpStatus;
        expenseUploadState.serverResponse = network.serverResponse;
        expenseUploadState.realError = `${errorCode(error)}: ${errorMessage(error)}`;
        finish(reject, makeError(error?.code || "EXPENSE_STORAGE_UPLOAD_START_FAILED", error?.message || "No se pudo iniciar la subida del comprobante.", error));
      }
    });
  }

  async function persistExpense() {
    let uploadedReference = null;
    let firestoreCommitted = false;
    let processed = null;

    try {
      setStage("TYPE_VALIDATION");
      const expenseType = validateExpenseTypeFromForm();

      setStage("SESSION");
      const user = auth?.currentUser || null;
      if (!user?.uid) throw makeError("auth/unauthenticated", "No se encontró una sesión autenticada.");
      expenseUploadState.weeklyPeriodId = String(activePeriods().weeklyPeriodId || "").trim();
      if (!expenseUploadState.weeklyPeriodId) throw makeError("EXPENSE_WEEKLY_PERIOD_MISSING", "No se pudo determinar la semana activa.");

      setStage("AMOUNT_VALIDATION");
      const amount = updateAmountState();
      if (!(amount > 0)) throw makeError("EXPENSE_AMOUNT_INVALID", "Ingresa un monto válido.");

      setStage("FILE_VALIDATION");
      const file = expenseUploadState.file;
      validateFile(file);
      if (!(expenseUploadState.file instanceof File)) throw makeError("EXPENSE_FILE_NOT_REAL", "El comprobante seleccionado no es un File válido.");

      setStage("FIREBASE_FLOW_VALIDATION");
      validateFirebaseFlow();

      expenseUploadState.expenseId = expenseUploadState.expenseId || createExpenseId();

      setStage("IMAGE_PROCESS");
      setButton("PREPARANDO COMPROBANTE…");
      setProgress("PREPARANDO COMPROBANTE…");
      processed = await processImage(file);
      expenseUploadState.processedFile = processed;
      if (!(processed?.blob instanceof Blob) || !(processed.blob.size > 0)) {
        throw makeError("EXPENSE_PROCESSED_BLOB_INVALID", "La imagen procesada no es válida.");
      }

      const verifiedFormat = await withTimeout(
        inspectImageBlob(processed.blob),
        12000,
        "EXPENSE_FORMAT_VERIFICATION_TIMEOUT",
        "La validación del formato procesado excedió el tiempo máximo."
      );
      const declaredMime = normalizeImageMime(processed.mimeType || processed.blob.type);
      if (declaredMime !== verifiedFormat.mimeType) {
        throw makeError("EXPENSE_PROCESSED_FORMAT_MISMATCH", `El MIME declarado (${declaredMime || "vacío"}) no coincide con los bytes reales (${verifiedFormat.mimeType}).`);
      }
      const extension = verifiedFormat.extension;
      processed.mimeType = verifiedFormat.mimeType;
      processed.extension = verifiedFormat.extension;

      // El objeto que realmente recibe uploadBytesResumable posee nombre,
      // extensión y MIME coherentes con los bytes procesados.
      const fileToUpload = fileFromBlob(
        processed.blob,
        `comprobante.${extension}`,
        processed.mimeType
      );
      const uploadContentType = normalizeImageMime(fileToUpload.type || processed.mimeType);
      const extensionFromFileName = String(fileToUpload.name || "")
        .match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || "";
      const uploadExtension = extensionFromFileName === "jpeg" ? "jpg" : extensionFromFileName;

      if (!uploadExtension || !["png", "jpg", "webp"].includes(uploadExtension)) {
        throw makeError("EXPENSE_UPLOAD_EXTENSION_UNSUPPORTED", "No se pudo obtener una extensión válida del archivo preparado.");
      }
      if (!uploadContentType || extensionForMime(uploadContentType) !== uploadExtension) {
        throw makeError("EXPENSE_UPLOAD_FILE_FORMAT_MISMATCH", "La extensión y el MIME del archivo preparado no coinciden.");
      }

      expenseUploadState.sourceExtension = sourceExtension(file);
      expenseUploadState.processedExtension = uploadExtension;
      expenseUploadState.detectedExtension = uploadExtension;
      expenseUploadState.detectedMimeType = uploadContentType;
      expenseUploadState.formatMutation = expenseUploadState.sourceExtension === uploadExtension
        ? `Sin conversión: .${uploadExtension}`
        : `Conversión real verificada: .${expenseUploadState.sourceExtension || "—"} → .${uploadExtension} (${verifiedFormat.signature})`;

      setStage("STORAGE_PATH");
      const path = `gastos/${user.uid}/${expenseUploadState.expenseId}/comprobante.${uploadExtension}`;
      if (/undefined|null|\[object Object\]/i.test(path)) throw makeError("EXPENSE_STORAGE_PATH_INVALID", "La ruta del comprobante contiene un valor inválido.");
      expenseUploadState.receiptPath = path;
      const reference = storageRef(storage, path);
      if (!reference) throw makeError("EXPENSE_STORAGE_REFERENCE_INVALID", "No se pudo crear la referencia del comprobante.");

      setStage("STORAGE_UPLOAD");
      setButton("SUBIENDO COMPROBANTE 0 %");
      setProgress(`ETAPA ACTUAL: UPLOADING_STORAGE · PORCENTAJE: 0 % · STORAGE PATH: ${path} · FORMATO REAL: ${uploadContentType} / .${uploadExtension} · MUTACIÓN: ${expenseUploadState.formatMutation} · UPLOAD TASK STATE: queued · RED: ${navigator.onLine ? "online" : "offline"} · TIMEOUT: ${EXPENSE_TIMEOUTS.upload} ms`);
      let snapshot;
      try {
        snapshot = await uploadExpenseReceiptResumable(reference, fileToUpload, {
          contentType:uploadContentType,
          customMetadata:{
            ownerUid:String(user.uid),
            driverUid:String(user.uid),
            expenseId:String(expenseUploadState.expenseId),
            weeklyPeriodId:String(expenseUploadState.weeklyPeriodId),
            uploadedByUid:String(user.uid),
            uploadedByRole:"driver",
            expenseType,
            module:"expense",
            relatedDocumentId:String(expenseUploadState.expenseId),
            operational:"true",
            createdAtMs:String(Date.now())
          }
        });
      } catch (error) {
        if (errorCode(error) === "EXPENSE_STORAGE_UPLOAD_TIMEOUT") setStage("STORAGE_UPLOAD_TIMEOUT");
        throw error;
      }
      if (!snapshot?.ref) throw makeError("EXPENSE_UPLOAD_SNAPSHOT_INVALID", "Firebase Storage no confirmó la subida.");
      uploadedReference = snapshot.ref;
      expenseUploadState.storageConfirmed = true;

      setStage("GET_DOWNLOAD_URL");
      setButton("SUBIENDO COMPROBANTE…");
      let receiptUrl;
      try { receiptUrl = await withTimeout(getDownloadURL(snapshot.ref), EXPENSE_TIMEOUTS.downloadUrl, "EXPENSE_GET_DOWNLOAD_URL_TIMEOUT", "Firebase tardó demasiado en devolver la URL final."); }
      catch (error) { throw makeError(error?.code || "EXPENSE_GET_DOWNLOAD_URL_FAILED", error?.message || "No se pudo obtener la URL del comprobante.", error); }
      expenseUploadState.urlObtained = true;
      if (!receiptUrl || /^blob:|^data:/i.test(receiptUrl)) throw makeError("EXPENSE_DOWNLOAD_URL_INVALID", "Firebase no devolvió una URL final válida.");

      const uploadedAt = serverTimestamp();
      const originalFileName = String(file.name || `comprobante.${uploadExtension}`).slice(0, 180);
      const nowMs = Date.now();
      const profileId = String(window.ExploraSession?.profileDocumentId || window.ExploraSession?.driverId || user.uid || "").trim();
      const profileName = String(window.ExploraSession?.profile?.nombre || window.ExploraSession?.profile?.nombreCompleto || window.ExploraSession?.profile?.displayName || user.displayName || "Chofer").trim();
      const expensePayload = {
        id:expenseUploadState.expenseId,
        gastoId:expenseUploadState.expenseId,
        operationId:expenseUploadState.expenseId,
        expenseId:expenseUploadState.expenseId,
        driverUid:user.uid,
        choferUid:user.uid,
        uid:user.uid,
        ownerUid:user.uid,
        driverId:profileId,
        choferId:profileId,
        driverName:profileName,
        choferNombre:profileName,
        expenseType,
        tipo:expenseType,
        category:expenseType,
        amount,
        monto:amount,
        notes:String($("expenseNotesInput")?.value || "").trim().slice(0, 150),
        weeklyPeriodId:expenseUploadState.weeklyPeriodId,
        periodoSemanalId:expenseUploadState.weeklyPeriodId,
        periodoId:expenseUploadState.weeklyPeriodId,
        expenseDate:new Date(nowMs),
        fechaISO:new Date(nowMs).toISOString(),
        createdAtMs:nowMs,
        payerRole:"driver",
        pagadoPorRol:"driver",
        sharedRate:.5,
        porcentajeCompartido:50,
        receiptUrl,
        receiptPath:path,
        receiptMimeType:uploadContentType,
        receiptOriginalExtension:expenseUploadState.sourceExtension || null,
        receiptProcessedExtension:expenseUploadState.processedExtension || extension,
        receiptFileName:originalFileName,
        receiptSize:Number(processed.blob.size),
        receiptUploadedAt:uploadedAt,
        receiptUploadedByUid:user.uid,
        receiptUploadedByRole:"driver",
        createdAt:serverTimestamp(),
        updatedAt:serverTimestamp(),
        status:"active"
      };
      const receiptId = `expense_${expenseUploadState.expenseId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);
      const profile = window.ExploraSession?.profile || {};
      const receiptIndexPayload = {
        receiptId,
        category:"expense",
        categoryLabel:TYPE_LABELS[expenseType],
        recordId:expenseUploadState.expenseId,
        driverUid:user.uid,
        driverName:String(profile.nombre || profile.nombreCompleto || profile.displayName || user.displayName || "Chofer"),
        ownerUid:user.uid,
        uploadedByUid:user.uid,
        uploadedByRole:"driver",
        weeklyPeriodId:expenseUploadState.weeklyPeriodId,
        amount,
        notes:expensePayload.notes,
        expenseType,
        receiptUrl,
        receiptPath:path,
        storagePath:path,
        fullPath:path,
        downloadURL:receiptUrl,
        module:"expense",
        relatedCollection:"gastos",
        relatedDocumentId:expenseUploadState.expenseId,
        operational:true,
        receiptMimeType:processed.mimeType,
        receiptOriginalExtension:expenseUploadState.sourceExtension || null,
        receiptProcessedExtension:expenseUploadState.processedExtension || extension,
        receiptFileName:originalFileName,
        receiptSize:Number(processed.blob.size),
        receiptUploadedAt:uploadedAt,
        status:"uploaded",
        createdAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      };

      setStage("FIRESTORE_WRITE");
      setButton("REGISTRANDO GASTO…");
      setProgress("REGISTRANDO GASTO…");
      try {
        const batch = writeBatch(db);
        batch.set(doc(db, "gastos", expenseUploadState.expenseId), expensePayload, { merge:false });
        batch.set(doc(db, "receipt_index", receiptId), receiptIndexPayload, { merge:false });
        await withTimeout(batch.commit(), EXPENSE_TIMEOUTS.firestore, "EXPENSE_FIRESTORE_WRITE_TIMEOUT", "Firestore tardó demasiado en registrar el gasto.");
        firestoreCommitted = true;
        expenseUploadState.firestoreConfirmed = true;
      } catch (error) {
        throw makeError(error?.code || "EXPENSE_FIRESTORE_WRITE_FAILED", error?.message || "El comprobante se subió, pero el gasto no pudo registrarse.", error);
      }

      return { payload:expensePayload, receiptIndexPayload, processedFile:processed };
    } catch (error) {
      if (uploadedReference && !firestoreCommitted) {
        setStage("ROLLBACK");
        expenseUploadState.cancelAttempted = true;
        try {
          await withTimeout(deleteObject(uploadedReference), EXPENSE_TIMEOUTS.rollback, "EXPENSE_ROLLBACK_TIMEOUT", "No se pudo confirmar la eliminación del archivo huérfano a tiempo.");
          expenseUploadState.cleanupMessage = "Archivo huérfano eliminado";
        } catch (cleanupError) {
          expenseUploadState.cleanupMessage = String(cleanupError?.code || cleanupError?.message || "No se pudo eliminar el archivo huérfano");
        }
      }
      throw error;
    }
  }

  function resolveExpenseSnapshotTotal(snapshot = {}) {
    try {
      const resolved = window.ExploraResolveWeeklyExpenseTotals?.(snapshot);
      if (resolved && Number.isFinite(Number(resolved.total))) return Math.max(0, Number(resolved.total));
    } catch (_) {}
    const direct = [snapshot?.totalExpenses, snapshot?.gastos, snapshot?.expenseTotal, snapshot?.totalGastos]
      .map(value => Number(value || 0)).filter(Number.isFinite);
    const rows = Array.isArray(snapshot?.expenses) ? snapshot.expenses : Array.isArray(snapshot?.expenseRows) ? snapshot.expenseRows : [];
    const rowsTotal = rows.reduce((sum,row) => sum + Math.max(0, Number(row?.amount ?? row?.monto ?? row?.valor ?? 0) || 0), 0);
    return Math.max(0, rowsTotal, ...direct);
  }

  async function refreshExpenseViews(payload) {
    setStage("WEEKLY_REFRESH");
    setButton("ACTUALIZANDO…");
    setProgress("ACTUALIZANDO…");
    try {
      let snapshot = null;
      let incrementalError = null;
      if (typeof window.ExploraWeeklyEngine?.applyExpense === "function") {
        try { snapshot = await window.ExploraWeeklyEngine.applyExpense(payload); }
        catch (error) { incrementalError = error; }
      }
      if (!snapshot && typeof window.refreshWeeklyFinancialEngine === "function") {
        snapshot = await window.refreshWeeklyFinancialEngine({ force:true, reason:"expense-created-source-reconcile" });
      }
      const expenseId=String(payload?.expenseId||payload?.gastoId||payload?.id||"").trim();
      const processed=new Set((snapshot?.processedOperationIds||snapshot?.operacionesProcesadas||snapshot?.operationLedger?.map?.(row=>row?.id)||[]).map(value=>String(value||"").trim()).filter(Boolean));
      const snapshotTotal=resolveExpenseSnapshotTotal(snapshot||{});
      if(!snapshot || (expenseId && processed.size && !processed.has(expenseId)) || snapshotTotal+0.01<Number(payload?.amount||0)) {
        const mismatch=makeError("EXPENSE_WEEKLY_SNAPSHOT_INCONSISTENT","El gasto fue guardado, pero el resumen semanal todavía no confirmó el nuevo importe.",incrementalError||null);
        mismatch.expenseId=expenseId;mismatch.snapshotTotal=snapshotTotal;mismatch.expenseAmount=Number(payload?.amount||0);
        try{window.ExploraWeeklyEngine?.showDiagnostic?.("EXPENSE_REALTIME_RECONCILE",mismatch.code,mismatch,{expenseId,weeklyPeriodId:payload?.weeklyPeriodId,firestorePath:"gastos + acumulados_semanales",snapshotTotal,expenseAmount:Number(payload?.amount||0)});}catch(_){}
        window.dispatchEvent(new CustomEvent("explora:weekly-expense-inconsistency",{detail:{error:mismatch,payload,snapshot}}));
      }
      window.ExploraFastCache?.invalidate?.("dashboard_weekly_expenses");
      window.ExploraInvalidateWeeklyClosure?.("expense-created",{refresh:false});
      // La conciliación autoritativa se difiere para no reemplazar el incremento nuevo por una consulta anterior.
      setTimeout(()=>{
        window.ExploraWeeklyEngine?.refresh?.({force:true,reason:"expense-created-reconcile"}).catch(error=>{
          try{window.ExploraWeeklyEngine?.showDiagnostic?.("EXPENSE_REALTIME_RECONCILE",error?.code||"EXPENSE_WEEKLY_REFRESH_FAILED",error,{expenseId,weeklyPeriodId:payload?.weeklyPeriodId,firestorePath:"gastos + acumulados_semanales"});}catch(_){}
        });
      },900);
    } catch (error) {
      throw makeError(error?.code || "EXPENSE_WEEKLY_REFRESH_FAILED", error?.message || "El gasto se registró, pero no se pudo actualizar Gastos semanales.", error);
    }

    setStage("RECEIPT_INDEX");
    try {
      window.invalidateReceiptCache?.("gastos");
      window.ExploraReceipts?.invalidate?.("gastos");
      if (typeof window.ExploraReceipts?.refresh === "function") {
        await window.ExploraReceipts.refresh("gastos");
      }
    } catch (error) {
      throw makeError(error?.code || "EXPENSE_RECEIPT_INDEX_FAILED", error?.message || "El gasto se registró, pero no se pudo actualizar Comprobantes → Gastos.", error);
    }
  }

  async function submitExpense(event) {
    event.preventDefault();
    if (expenseUploadState.saving) return;

    markBusy(true);
    expenseUploadState.startedAt = Date.now();
    expenseUploadState.uploadPercent = 0;
    expenseUploadState.taskState = "idle";
    expenseUploadState.sourceExtension = "";
    expenseUploadState.processedExtension = "";
    expenseUploadState.detectedExtension = "";
    expenseUploadState.detectedMimeType = "";
    expenseUploadState.formatMutation = "";
    expenseUploadState.networkState = navigator.onLine ? "online" : "offline";
    expenseUploadState.httpStatus = "—";
    expenseUploadState.serverResponse = "";
    expenseUploadState.lastProgressAt = Date.now();
    expenseUploadState.timeoutMs = EXPENSE_TIMEOUTS.upload;
    expenseUploadState.timeoutActive = false;
    expenseUploadState.realError = "";
    expenseUploadState.cancelAttempted = false;
    expenseUploadState.storageConfirmed = false;
    expenseUploadState.urlObtained = false;
    expenseUploadState.firestoreConfirmed = false;
    expenseUploadState.errorStage = "";
    expenseUploadState.lastError = null;
    expenseUploadState.cleanupMessage = "";
    hideDiagnostic();
    setMessage("");
    setButton("VALIDANDO…");
    setProgress("");

    try {
      if (!expenseUploadState.committedResult) {
        expenseUploadState.committedResult = await persistExpense();
      }
      window.dispatchEvent(new CustomEvent("explora:gasto-registrado", { detail:expenseUploadState.committedResult.payload }));
      await refreshExpenseViews(expenseUploadState.committedResult.payload);
      setStage("COMPLETED");
      setMessage("");
      setProgress("");
      if (typeof window.showExploraSuccess !== "function") throw makeError("EXPENSE_SUCCESS_MODAL_UNAVAILABLE", "No se pudo mostrar el resultado final.");
      window.showExploraSuccess({
        title:"¡EXITOSO!",
        message:"Gasto y comprobante registrados correctamente.",
        onAccept:() => {
          resetForm();
          close();
          window.ExploraMainNav?.navigate?.("inicio");
          window.ExploraMainNav?.setActive?.("inicio");
          window.scrollTo({ top:0, behavior:"auto" });
        }
      });
    } catch (error) {
      expenseUploadState.errorStage = ALLOWED_STAGES.has(expenseUploadState.stage) ? expenseUploadState.stage : "FIREBASE_FLOW_VALIDATION";
      expenseUploadState.lastError = error;
      expenseUploadState.realError = `${errorCode(error)}: ${errorMessage(error)}`;
      setMessage(errorMessage(error), true);
      if (expenseUploadState.errorStage === "TYPE_VALIDATION") {
        syncExpenseTypeUI({ clearValidationError:false });
        const typeMessage = errorCode(error) === "EXPENSE_TYPE_REQUIRED"
          ? "Selecciona el tipo de gasto antes de cargar el comprobante."
          : errorMessage(error);
        showExpenseTypeError(typeMessage);
        renderDiagnostic(error, { scroll:false });
      } else {
        renderDiagnostic(error);
      }
      console.error("EXPLORA_ERROR_CARGAR_GASTO", {
        stage:expenseUploadState.errorStage,
        code:errorCode(error),
        message:errorMessage(error),
        expenseId:expenseUploadState.expenseId || null,
        weeklyPeriodId:expenseUploadState.weeklyPeriodId || null,
        path:sanitizePath(expenseUploadState.receiptPath),
        networkState:expenseUploadState.networkState,
        httpStatus:expenseUploadState.httpStatus,
        serverResponse:expenseUploadState.serverResponse,
        error
      });
    } finally {
      markBusy(false);
      expenseUploadState.uploadTask = null;
      setButton("CARGAR GASTO");
      setProgress("");
      restoreInteraction();
    }
  }

  function resetForm() {
    const amount = $("expenseAmountInput");
    const notes = $("expenseNotesInput");
    if (amount) amount.value = "";
    if (notes) notes.value = "";
    setText("expenseNotesCounter", "0/150");
    expenseUploadState.expenseType = "";
    expenseUploadState.expenseId = "";
    expenseUploadState.weeklyPeriodId = "";
    expenseUploadState.receiptPath = "";
    expenseUploadState.processedFile = null;
    expenseUploadState.committedResult = null;
    expenseUploadState.errorStage = "";
    expenseUploadState.lastError = null;
    expenseUploadState.uploadTask = null;
    expenseUploadState.uploadPercent = 0;
    expenseUploadState.taskState = "idle";
    expenseUploadState.sourceExtension = "";
    expenseUploadState.processedExtension = "";
    expenseUploadState.detectedExtension = "";
    expenseUploadState.detectedMimeType = "";
    expenseUploadState.formatMutation = "";
    expenseUploadState.networkState = "idle";
    expenseUploadState.httpStatus = "—";
    expenseUploadState.serverResponse = "";
    expenseUploadState.lastProgressAt = 0;
    expenseUploadState.startedAt = 0;
    expenseUploadState.timeoutMs = EXPENSE_TIMEOUTS.upload;
    expenseUploadState.timeoutActive = false;
    expenseUploadState.realError = "";
    expenseUploadState.cancelAttempted = false;
    expenseUploadState.storageConfirmed = false;
    expenseUploadState.urlObtained = false;
    expenseUploadState.firestoreConfirmed = false;
    setStage("IDLE");
    document.querySelectorAll('#expenseTypeGrid input[type="radio"][name="expenseType"]').forEach(radio => { radio.checked = false; });
    syncExpenseTypeUI({ clearValidationError:false });
    clearExpenseTypeError();
    clearFile();
    updateAmountState();
    hideDiagnostic();
    setMessage("");
    setProgress("");
  }

  function open() {
    expenseUploadState.previousScrollY = window.scrollY || 0;
    screen.classList.add("is-open");
    screen.setAttribute("aria-hidden", "false");
    screen.scrollTop = 0;
    screen.style.overflowY = "auto";
    screen.style.touchAction = "pan-y";
    document.body.classList.add("expense-open");
    window.lockPageScroll?.("expense");
    window.ExploraMainNav?.setActive?.("finanzas");
    const amount = $("expenseAmountInput");
    if (amount) {
      amount.disabled = false;
      amount.readOnly = false;
      amount.removeAttribute("disabled");
      amount.removeAttribute("readonly");
      amount.style.pointerEvents = "auto";
      amount.style.touchAction = "manipulation";
    }
    updateAmountState();
    syncExpenseTypeUI({ clearValidationError:false });
    restoreInteraction();
    setButton("CARGAR GASTO");
  }

  function close() {
    if (expenseUploadState.saving) return;
    screen.classList.remove("is-open");
    screen.setAttribute("aria-hidden", "true");
    document.body.classList.remove("expense-open");
    window.unlockPageScroll?.("expense");
    window.ExploraMainNav?.setActive?.("inicio");
    restoreInteraction();
    requestAnimationFrame(() => window.scrollTo(0, expenseUploadState.previousScrollY || 0));
  }

  function bindEvents() {
    const amount = $("expenseAmountInput");
    const fileInput = $("expenseReceiptInput");

    if (amount) {
      amount.disabled = false;
      amount.readOnly = false;
      amount.removeAttribute("disabled");
      amount.removeAttribute("readonly");
      amount.addEventListener("input", event => {
        if (expenseUploadState.saving || expenseUploadState.committedResult) return;
        event.target.value = formatCurrencyInput(event.target.value);
        expenseUploadState.expenseId = "";
        expenseUploadState.processedFile = null;
        updateAmountState();
        hideDiagnostic();
        setMessage("");
      });
    }

    $("expenseClearAmountBtn")?.addEventListener("click", () => {
      if (expenseUploadState.saving || expenseUploadState.committedResult) return;
      if (amount) {
        amount.value = "";
        amount.focus({ preventScroll:false });
      }
      expenseUploadState.expenseId = "";
      expenseUploadState.processedFile = null;
      updateAmountState();
      hideDiagnostic();
      setMessage("");
    });

    document.querySelectorAll('#expenseTypeGrid input[type="radio"][name="expenseType"]').forEach(radio => {
      radio.addEventListener("change", () => {
        if (expenseUploadState.saving || expenseUploadState.committedResult) return;
        expenseUploadState.expenseId = "";
        expenseUploadState.processedFile = null;
        syncExpenseTypeUI({ clearValidationError:true });
      });
    });

    $("expenseUploadBtn")?.addEventListener("click", event => {
      event.preventDefault();
      if (expenseUploadState.saving || expenseUploadState.committedResult || !fileInput) return;
      fileInput.value = "";
      fileInput.click();
    });

    fileInput?.addEventListener("change", handleFileSelection);

    $("expenseRemoveFileBtn")?.addEventListener("click", () => {
      if (expenseUploadState.saving || expenseUploadState.committedResult) return;
      clearFile();
    });

    $("expenseNotesInput")?.addEventListener("input", event => {
      setText("expenseNotesCounter", `${event.target.value.length}/150`);
      if (!expenseUploadState.committedResult) hideDiagnostic();
    });

    $("expenseForm")?.addEventListener("submit", submitExpense);
    $("expenseBackBtn")?.addEventListener("click", close);
    $("expenseDiagnosticCopyBtn")?.addEventListener("click", copyDiagnostic);
    const dismissDiagnostic = () => hideDiagnostic();
    $("expenseDiagnosticCloseBtn")?.addEventListener("click", dismissDiagnostic);
    $("expenseDiagnosticDismissBtn")?.addEventListener("click", dismissDiagnostic);

    updateAmountState();
    syncExpenseTypeUI({ clearValidationError:false });
    setButton("CARGAR GASTO");
  }

  bindEvents();

  window.ExploraActions = window.ExploraActions || {};
  window.ExploraActions["cargar-gastos"] = open;
  const api = Object.freeze({
    open,
    close,
    reset:resetForm,
    getState:() => ({
      expenseType:expenseUploadState.expenseType,
      amount:parseCurrencyInput($("expenseAmountInput")?.value || ""),
      hasFile:expenseUploadState.file instanceof File,
      saving:expenseUploadState.saving,
      stage:expenseUploadState.stage,
      expenseId:expenseUploadState.expenseId,
      weeklyPeriodId:expenseUploadState.weeklyPeriodId
    })
  });
  window.ExploraExpense = api;
  return api;
})();

function weeklyIds(count) {
  const engine = window.ExploraWeeklyEngine;
  const active = engine?.getActiveWeeklyPeriod?.() || {};
  const start = Number(active.startMs || Date.now());
  return Array.from({ length:count }, (_, index) => engine?.getActiveWeeklyPeriod?.(new Date(start + index * 7 * 86400000 + 3600000))?.id || `${active.id}_${index + 1}`);
}
window.ExploraCreateDriverDebt = async function(input = {}) {
  const session = input.validatedAdminSession?.uid
    ? input.validatedAdminSession
    : (typeof window.ExploraValidateDebtAdminSession === "function"
        ? await window.ExploraValidateDebtAdminSession({ source:"ExploraCreateDriverDebt" })
        : await getSession());
  const normalizedRole = String(session.role || "").trim().toLowerCase();
  if (!["admin","administrador","owner","superadmin"].includes(normalizedRole)) {
    const error = new Error("El usuario autenticado no tiene permisos de administrador para registrar deudas.");
    error.code = "ADMIN_ROLE_REQUIRED"; error.internalCode = "ADMIN_ROLE_REQUIRED"; error.debtStage = "ADMIN_ROLE_CHECK"; throw error;
  }
  input.onStage?.("ADMIN_VALIDATED", { uid:session.uid, role:normalizedRole });
  const driverUid = String(input.driverUid || "").trim();
  const totalAmount = parseCurrencyInput(input.totalAmount);
  const installmentCount = Math.max(1, Math.min(52, Math.trunc(Number(input.installmentCount) || 1)));
  const weeklyInstallmentAmount = parseCurrencyInput(input.weeklyInstallmentAmount) || Math.ceil(totalAmount / installmentCount);
  if (!driverUid) throw Object.assign(new Error("Selecciona un chofer."), { code:"DRIVER_REQUIRED", internalCode:"DRIVER_REQUIRED", debtStage:"FORM_VALIDATION" });
  if (!["fine","crash"].includes(String(input.reason || ""))) throw Object.assign(new Error("Selecciona Multa o Choque."), { code:"DEBT_REASON_REQUIRED", internalCode:"DEBT_REASON_REQUIRED", debtStage:"FORM_VALIDATION" });
  if (!(totalAmount > 0)) throw Object.assign(new Error("Ingresa un monto válido."), { code:"AMOUNT_REQUIRED", internalCode:"AMOUNT_REQUIRED", debtStage:"FORM_VALIDATION" });
  if (!(weeklyInstallmentAmount > 0)) throw Object.assign(new Error("Ingresa una cuota semanal válida."), { code:"INSTALLMENT_AMOUNT_REQUIRED", internalCode:"INSTALLMENT_AMOUNT_REQUIRED", debtStage:"FORM_VALIDATION" });
  if (weeklyInstallmentAmount * installmentCount < totalAmount) throw Object.assign(new Error("La cantidad de cuotas y el importe semanal no cubren la deuda total."), { code:"INSTALLMENT_PLAN_INCOMPLETE", internalCode:"INSTALLMENT_PLAN_INCOMPLETE", debtStage:"FORM_VALIDATION" });
  const debtId = String(input.debtId || stableId("debt", driverUid));
  const periods = weeklyIds(installmentCount);
  const installments = installmentPlan(totalAmount, installmentCount, weeklyInstallmentAmount, periods);
  if (!installments.length) throw Object.assign(new Error("No se pudo construir el plan de cuotas."), { code:"INSTALLMENT_PLAN_INVALID", internalCode:"INSTALLMENT_PLAN_INVALID", debtStage:"FORM_VALIDATION" });
  const storageOwnerUid = String(session.uid || "").trim();
  if (!storageOwnerUid) throw Object.assign(new Error("No hay usuario autenticado en Firebase Auth."), { code:"AUTH_USER_MISSING", internalCode:"AUTH_USER_MISSING", debtStage:"VALIDATING_ADMIN_SESSION" });
  const hasAttachment = input.receiptFile instanceof File || input.receiptFile instanceof Blob;
  const destinationPath = `deudas/${driverUid}/${debtId}/adjunto.{extension}`;
  let receipt = null;
  try {
    if (hasAttachment) {
      receipt = await window.motorCargaComprobanteGasto({
        file:input.receiptFile, context:"driverDebt", ownerUid:storageOwnerUid, driverUid, recordId:debtId,
        weeklyPeriodId:periods[0], destinationPath, allowPdf:true, uploadedByUid:session.uid, uploadedByRole:normalizedRole,
        category:"driver_debt", metadata:{
          contentType:String(input.receiptFile.type || ""), debtId, driverUid, vehicleId:String(input.vehicleId || ""),
          createdByUid:session.uid, createdByRole:normalizedRole, amount:totalAmount, installments:installmentCount,
          reason:String(input.reason || ""), uploadedFrom:"admin_debt_form", module:"MULTAS_Y_CHOQUES",
          type:String(input.reason || "debt"), receiptCategory:"deuda"
        }, onStage:(stage,detail)=>input.onStage?.(stage,detail)
      });
      input.onStage?.("DOWNLOAD_URL_CONFIRMED", { path:receipt.receiptPath, urlObtained:Boolean(receipt.receiptUrl) });
    }
    const receiptMetadata = receipt ? saveReceiptMetadata(receipt, { ownerUid:driverUid, uploadedByUid:session.uid, uploadedByRole:normalizedRole, category:"driver_debt", relatedDocumentId:debtId }) : {};
    const attachments = receipt ? [{
      url:receipt.receiptUrl || receipt.fileUrl, path:receipt.receiptPath || receipt.filePath,
      name:receipt.receiptFileName || receipt.fileName || input.receiptFile?.name || "Archivo adjunto",
      mimeType:receipt.receiptMimeType || receipt.mimeType || input.receiptFile?.type || "application/octet-stream",
      size:Number(receipt.receiptSize || receipt.fileSize || input.receiptFile?.size || 0),
      uploadedByUid:session.uid, uploadedByRole:normalizedRole, uploadedAtClient:new Date().toISOString()
    }] : [];
    const debtStatus = installmentCount > 1 ? "installment" : "pending";
    const payload = {
      debtId, id:debtId, driverUid, driverId:driverUid, choferUid:driverUid, driverName:String(input.driverName || "Chofer"),
      vehicleId:String(input.vehicleId || ""), originalVehicleId:String(input.vehicleId || ""), vehiclePlate:String(input.vehiclePlate || "").toUpperCase(), originalVehiclePlate:String(input.vehiclePlate || "").toUpperCase(),
      type:String(input.reason), receiptCategory:"deuda", reason:input.reason, reasonLabel:input.reasonLabel || (input.reason === "crash" ? "Choque" : "Multa"),
      incidentDate:String(input.incidentDate || new Date().toISOString().slice(0,10)), description:String(input.description || input.notes || "").trim(),
      adminNotes:String(input.adminNotes || input.notes || "").trim(), notes:String(input.notes || input.description || "").trim(),
      amount:totalAmount, totalAmount, originalAmount:totalAmount, installmentCount, installments:installmentCount,
      firstInstallmentAmount:installments[0].amount, weeklyInstallmentAmount:installments[0].amount, remainingAmount:totalAmount, saldoPendiente:totalAmount,
      paidAmount:0, paidInstallments:0, pendingInstallments:installments.length,
      firstWeeklyPeriodId:periods[0], nextWeeklyPeriodId:periods[0], weeklyPeriodId:periods[0], installments,
      ...receiptMetadata, attachments,
      status:debtStatus, debtStatus, acknowledgedByDriver:false, acknowledgedAt:null,
      createdByUid:session.uid, createdByRole:normalizedRole, createdAt:serverTimestamp(), updatedAt:serverTimestamp(), schemaVersion:2
    };
    input.onStage?.("FIRESTORE_WRITE", { debtId, driverUid, path:receipt?.receiptPath || "" });
    const batch = writeBatch(db);
    batch.set(doc(db, "deudas_choferes", debtId), payload, { merge:false });
    if (receipt) {
      const indexPayload = buildReceiptIndexPayload({ category:"driver_debt", recordId:debtId, driverUid, ownerUid:driverUid, uploadedByUid:session.uid, uploadedByRole:normalizedRole, weeklyPeriodId:periods[0], amount:totalAmount, receipt, status:"uploaded" });
      Object.assign(indexPayload,{type:String(input.reason),reason:input.reason,driverId:driverUid,vehicleId:String(input.vehicleId||""),receiptCategory:"deuda",detail:payload.reasonLabel,driverName:String(input.driverName||"Chofer")});
      batch.set(doc(db, "receipt_index", indexPayload.receiptId), indexPayload, { merge:false });
    }
    batch.set(doc(db, "notificaciones", `debt_${debtId}`), { notificationId:`debt_${debtId}`, type:"driver_debt", driverUid, debtId, title:"NUEVA DEUDA REGISTRADA", message:`${payload.reasonLabel}: ${money(totalAmount)} en ${installmentCount} cuota(s).`, read:false, acknowledged:false, createdByUid:session.uid, createdAt:serverTimestamp(), updatedAt:serverTimestamp() }, { merge:false });
    await batch.commit();
    input.onStage?.("COMPLETED", { debtId, driverUid, firestoreConfirmed:true, receipt });
    refreshAfter("debt-created", "deudas");
    return { id:debtId, ...payload };
  } catch (error) {
    if (receipt?.receiptPath) {
      error.debtRollbackAttempted = true; input.onStage?.("ROLLBACK_START", { path:receipt.receiptPath });
      try { await deleteUploadedFile(receipt.receiptPath); error.debtRollbackSucceeded = true; input.onStage?.("ROLLBACK_COMPLETE", { path:receipt.receiptPath, success:true }); }
      catch (rollbackError) { error.debtRollbackSucceeded = false; error.debtRollbackError = rollbackError; input.onStage?.("ROLLBACK_COMPLETE", { path:receipt.receiptPath, success:false, error:rollbackError }); }
    }
    throw error;
  }
};


window.ExploraUpdateDriverDebt = async function(input = {}) {
  const session = input.validatedAdminSession?.uid
    ? input.validatedAdminSession
    : (typeof window.ExploraValidateDebtAdminSession === "function"
        ? await window.ExploraValidateDebtAdminSession({ source:"ExploraUpdateDriverDebt" })
        : await getSession());
  const normalizedRole = String(session.role || "").trim().toLowerCase();
  if (!["admin","administrador","owner","superadmin"].includes(normalizedRole)) {
    throw Object.assign(new Error("Se requieren permisos de administrador para editar la deuda."), { code:"ADMIN_ROLE_REQUIRED", internalCode:"ADMIN_ROLE_REQUIRED", debtStage:"ADMIN_ROLE_CHECK" });
  }
  const debtId = String(input.debtId || "").trim();
  const driverUid = String(input.driverUid || "").trim();
  const totalAmount = parseCurrencyInput(input.totalAmount);
  const requestedCount = Math.max(1, Math.min(52, Math.trunc(Number(input.installmentCount) || 1)));
  const weeklyInstallmentAmount = parseCurrencyInput(input.weeklyInstallmentAmount) || Math.ceil(totalAmount / requestedCount);
  if (!debtId) throw Object.assign(new Error("No se identificó la multa o choque a editar."), { code:"DEBT_ID_REQUIRED", internalCode:"DEBT_ID_REQUIRED", debtStage:"FORM_VALIDATION" });
  if (!driverUid) throw Object.assign(new Error("No se identificó el chofer de la deuda."), { code:"DRIVER_REQUIRED", internalCode:"DRIVER_REQUIRED", debtStage:"FORM_VALIDATION" });
  if (!["fine","crash"].includes(String(input.reason || ""))) throw Object.assign(new Error("Selecciona Multa o Choque."), { code:"DEBT_REASON_REQUIRED", internalCode:"DEBT_REASON_REQUIRED", debtStage:"FORM_VALIDATION" });
  if (!(totalAmount > 0) || !(weeklyInstallmentAmount > 0)) throw Object.assign(new Error("Ingresa importes válidos."), { code:"AMOUNT_REQUIRED", internalCode:"AMOUNT_REQUIRED", debtStage:"FORM_VALIDATION" });

  const hasAttachment = input.receiptFile instanceof File || input.receiptFile instanceof Blob;
  let receipt = null;
  try {
    if (hasAttachment) {
      receipt = await window.motorCargaComprobanteGasto({
        file:input.receiptFile, context:"driverDebt", ownerUid:String(session.uid || ""), driverUid, recordId:`${debtId}_${Date.now()}`,
        weeklyPeriodId:window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id || "", destinationPath:`deudas/${driverUid}/${debtId}/adjunto_${Date.now()}.{extension}`,
        allowPdf:true, uploadedByUid:session.uid, uploadedByRole:normalizedRole, category:"driver_debt",
        metadata:{ debtId, driverUid, vehicleId:String(input.vehicleId || ""), updatedByUid:session.uid, updatedByRole:normalizedRole, module:"MULTAS_Y_CHOQUES", type:String(input.reason || "debt"), receiptCategory:"deuda" },
        onStage:(stage,detail)=>input.onStage?.(stage,detail)
      });
    }
    const attachment = receipt ? {
      url:receipt.receiptUrl || receipt.fileUrl,
      path:receipt.receiptPath || receipt.filePath,
      name:receipt.receiptFileName || receipt.fileName || input.receiptFile?.name || "Archivo adjunto",
      mimeType:receipt.receiptMimeType || receipt.mimeType || input.receiptFile?.type || "application/octet-stream",
      size:Number(receipt.receiptSize || receipt.fileSize || input.receiptFile?.size || 0),
      uploadedByUid:session.uid, uploadedByRole:normalizedRole, uploadedAtClient:new Date().toISOString()
    } : null;
    const debtRef = doc(db, "deudas_choferes", debtId);
    const result = await runTransaction(db, async transaction => {
      const snap = await transaction.get(debtRef);
      if (!snap.exists()) throw Object.assign(new Error("La deuda ya no existe."), { code:"DEBT_NOT_FOUND", internalCode:"DEBT_NOT_FOUND", debtStage:"FIRESTORE_WRITE" });
      const existing = snap.data() || {};
      const existingDriverUid = String(existing.driverUid || existing.choferUid || existing.uid || "").trim();
      if (existingDriverUid && existingDriverUid !== driverUid) throw Object.assign(new Error("No se puede transferir una deuda a otro chofer."), { code:"DEBT_DRIVER_IMMUTABLE", internalCode:"DEBT_DRIVER_IMMUTABLE", debtStage:"FORM_VALIDATION" });
      const paidAmount = Math.max(0, Number(existing.paidAmount || existing.importePagado || 0));
      if (totalAmount < paidAmount) throw Object.assign(new Error("El importe total no puede ser menor a lo ya pagado."), { code:"TOTAL_BELOW_PAID", internalCode:"TOTAL_BELOW_PAID", debtStage:"FORM_VALIDATION" });
      const remainingAmount = Math.max(0, totalAmount - paidAmount);
      const paidInstallments = (Array.isArray(existing.installments) ? existing.installments : []).filter(item => ["paid","settled"].includes(String(item?.status || "").toLowerCase()));
      const paidPeriods = new Set(paidInstallments.map(item => String(item.weeklyPeriodId || item.periodoSemanalId || "")).filter(Boolean));
      const futureCount = remainingAmount > 0 ? Math.max(1, requestedCount - paidInstallments.length) : 0;
      const futurePeriods = weeklyIds(Math.max(1, futureCount + paidPeriods.size + 2)).filter(id => !paidPeriods.has(id)).slice(0, futureCount);
      const futureInstallments = futureCount ? installmentPlan(remainingAmount, futureCount, weeklyInstallmentAmount, futurePeriods) : [];
      const installments = [...paidInstallments, ...futureInstallments];
      const next = futureInstallments[0] || null;
      const status = remainingAmount <= 0 ? "paid" : futureCount > 1 ? "installment" : "pending";
      const attachments = [...(Array.isArray(existing.attachments) ? existing.attachments : []), ...(attachment ? [attachment] : [])];
      const patch = {
        type:String(input.reason), reason:String(input.reason), reasonLabel:input.reasonLabel || (input.reason === "crash" ? "Choque" : "Multa"),
        incidentDate:String(input.incidentDate || existing.incidentDate || new Date().toISOString().slice(0,10)),
        description:String(input.description || "").trim(), adminNotes:String(input.adminNotes || input.notes || "").trim(), notes:String(input.notes || input.description || "").trim(),
        amount:totalAmount, totalAmount, remainingAmount, saldoPendiente:remainingAmount, paidAmount,
        installmentCount:installments.length, installments:installments.length, weeklyInstallmentAmount:next?.amount || 0,
        paidInstallments:paidInstallments.length, pendingInstallments:futureInstallments.length,
        nextWeeklyPeriodId:next?.weeklyPeriodId || null, installments,
        status, debtStatus:status, attachments,
        updatedByUid:session.uid, updatedByRole:normalizedRole, updatedAt:serverTimestamp(), schemaVersion:3
      };
      if (attachment) Object.assign(patch, saveReceiptMetadata(receipt, { ownerUid:driverUid, uploadedByUid:session.uid, uploadedByRole:normalizedRole, category:"driver_debt", relatedDocumentId:debtId }));
      transaction.set(debtRef, patch, { merge:true });
      if (receipt) {
        const indexPayload = buildReceiptIndexPayload({ category:"driver_debt", recordId:`${debtId}_${Date.now()}`, driverUid, ownerUid:driverUid, uploadedByUid:session.uid, uploadedByRole:normalizedRole, weeklyPeriodId:next?.weeklyPeriodId || "", amount:totalAmount, receipt, status:"uploaded" });
        Object.assign(indexPayload, { debtId, type:String(input.reason), reason:input.reason, driverId:driverUid, vehicleId:String(existing.vehicleId || input.vehicleId || ""), receiptCategory:"deuda", detail:patch.reasonLabel, driverName:String(input.driverName || existing.driverName || "Chofer") });
        transaction.set(doc(db, "receipt_index", indexPayload.receiptId), indexPayload, { merge:false });
      }
      return { id:debtId, ...existing, ...patch };
    });
    input.onStage?.("COMPLETED", { debtId, driverUid, firestoreConfirmed:true, receipt });
    refreshAfter("debt-updated", "deudas");
    return result;
  } catch (error) {
    if (receipt?.receiptPath) {
      error.debtRollbackAttempted = true;
      try { await deleteUploadedFile(receipt.receiptPath); error.debtRollbackSucceeded = true; }
      catch (rollbackError) { error.debtRollbackSucceeded = false; error.debtRollbackError = rollbackError; }
    }
    throw error;
  }
};


window.ExploraDebtData = { load:() => readOwned("deudas_choferes") };

window.ExploraResetOperationalData = async function(){throw Object.assign(new Error("Use el reinicio semanal controlado desde el panel Admin."),{code:"LEGACY_RESET_DISABLED"});};

function ensureFinanceScreen() {
  if ($("financeHistoryScreenV188")) return;
  document.body.insertAdjacentHTML("beforeend", `<section id="financeHistoryScreenV188" class="finance-history-screen" aria-hidden="true"><header class="finance-history-header"><button id="financeHistoryBackV188" class="finance-history-back" type="button">‹</button><div class="finance-history-title"><h1 id="financeHistoryTitleV188">FACTURASTE</h1><p>Semana activa</p></div><div class="finance-history-icon">$</div></header><div id="financeHistoryStatusV188" class="finance-status"></div><section class="finance-period-summary"><small>SEMANA ACTIVA</small><div id="financeHistoryTotalV188" class="finance-period-total">$0</div><div class="finance-period-meta"><span id="financeHistoryCountV188">0 registros</span></div></section><div id="financeHistoryListV188" class="finance-list"></div></section>`);
  $("financeHistoryBackV188").addEventListener("click", () => {
    const screen = $("financeHistoryScreenV188");
    screen.classList.remove("is-open"); screen.setAttribute("aria-hidden", "true");
    window.unlockPageScroll?.("finance-v190"); window.ExploraMainNav?.setActive?.("inicio");
  });
}
function financeRows(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}
function financeMethodLabel(row = {}, type = "billing") {
  if (type === "expenses") return row.categoryLabel || row.category || row.tipo || row.typeLabel || "Gasto";
  const raw = String(row.paymentMethod || row.metodoPago || row.financialCategory || row.receiptPaymentMethod || "").toLowerCase();
  const labels = { cash:"Efectivo", efectivo:"Efectivo", transfer:"Transferencia", transferencia:"Transferencia", alias:"Transferencia", card:"Tarjeta", tarjeta:"Tarjeta", qr:"QR" };
  return labels[raw] || row.paymentMethodLabel || row.paymentLabel || "Cobro";
}
function financeAmount(row = {}) {
  return Number(row.amount ?? row.monto ?? row.valor ?? row.finalPrice ?? row.total ?? row.importe ?? 0) || 0;
}
function financeDateValue(row = {}) {
  const candidates = [row.completedAt, row.createdAt, row.updatedAt, row.fechaISO, row.date, row.fecha, row.timestamp, row.receiptUploadedAt];
  for (const value of candidates) {
    if (!value) continue;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value?.toDate === "function") {
      const date = value.toDate();
      if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
    }
    if (typeof value === "number") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date;
    }
    const text = String(value).trim();
    if (!text) continue;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)) return text;
  }
  return "";
}
function financeDateText(row = {}) {
  const dateValue = financeDateValue(row);
  const explicitTime = String(row.hora || row.time || row.hour || "").trim();
  if (dateValue instanceof Date) {
    const date = dateValue.toLocaleDateString("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit", year:"2-digit" });
    const time = explicitTime || dateValue.toLocaleTimeString("es-AR", { timeZone:AR_TZ, hour:"2-digit", minute:"2-digit" });
    return `${date}${time ? ` · ${time}` : ""}`;
  }
  if (typeof dateValue === "string" && dateValue) return `${dateValue}${explicitTime ? ` · ${explicitTime}` : ""}`;
  return explicitTime || "Sin fecha registrada";
}
function financeReceiptText(row = {}, type = "billing") {
  if (type === "expenses") return row.receiptUrl || row.comprobanteUrl || row.fileUrl ? "Comprobante cargado" : "Sin comprobante";
  if (row.receiptRequired === false || String(row.paymentMethod || row.metodoPago || "").toLowerCase() === "cash") return "Efectivo sin comprobante";
  return row.receiptUrl || row.comprobanteUrl || row.fileUrl || row.downloadURL ? "Comprobante cargado" : "Comprobante pendiente";
}
function renderFinanceRow(row = {}, type = "billing") {
  const label = financeMethodLabel(row, type);
  const amount = financeAmount(row);
  const driver = row.driverName || row.choferNombre || row.chofer || row.createdByName || "";
  const source = row.uploadedByRole || row.createdByRole || row.sourceRole || "";
  const meta = [financeDateText(row), financeReceiptText(row, type), driver, source ? `Cargado por ${source === "admin" ? "David" : source}` : ""].filter(Boolean).join(" · ");
  return `<article class="finance-row"><span><b>${escapeHtml(label)}</b><small>${escapeHtml(meta)}</small></span><strong>${money(amount)}</strong></article>`;
}
async function openFinance(type) {
  ensureFinanceScreen();
  const screen = $("financeHistoryScreenV188");
  screen.classList.add("is-open"); screen.setAttribute("aria-hidden", "false"); window.lockPageScroll?.("finance-v190");
  $("financeHistoryTitleV188").textContent = type === "expenses" ? "GASTASTE" : "FACTURASTE";
  $("financeHistoryStatusV188").classList.remove("err");
  $("financeHistoryStatusV188").textContent = "Cargando…";
  try {
    await window.ExploraWeeklyEngine?.loadOnce?.();
    const snapshot = window.ExploraWeeklyEngine?.getSnapshot?.() || {};
    const rows = financeRows(type === "expenses" ? snapshot.expenses : (snapshot.billingRecords || snapshot.services));
    const total = type === "expenses" ? snapshot.totalExpenses : snapshot.grossBilling;
    $("financeHistoryTotalV188").textContent = money(total);
    $("financeHistoryCountV188").textContent = `${rows.length} ${rows.length === 1 ? "registro" : "registros"}`;
    $("financeHistoryListV188").innerHTML = rows.length ? rows.map(row => {
      try { return renderFinanceRow(row, type); }
      catch (rowError) { console.warn("FINANCE_ROW_RENDER_WARNING", rowError?.code || rowError?.message || rowError); return ""; }
    }).filter(Boolean).join("") : '<div class="finance-empty">Sin registros esta semana.</div>';
    $("financeHistoryStatusV188").textContent = "";
  } catch (error) {
    console.warn("FINANCE_HISTORY_LOAD_ERROR", error?.code || error?.message || error);
    $("financeHistoryStatusV188").classList.add("err");
    $("financeHistoryStatusV188").textContent = "No se pudieron cargar los datos semanales.";
    $("financeHistoryListV188").innerHTML = '<div class="finance-empty">No se pudo mostrar el detalle. Probá actualizar información.</div>';
  }
}
window.ExploraActions = window.ExploraActions || {};
window.ExploraActions["facturacion-semanal"] = () => openFinance("billing");
window.ExploraActions["gastos-semanales"] = () => openFinance("expenses");
window.ExploraActions["resumen-servicios"] = () => openFinance("billing");
window.ExploraActions["resumen-gastos"] = () => openFinance("expenses");

document.addEventListener("DOMContentLoaded", () => {
  $("receiptDetailCloseBtn")?.addEventListener("click", closeReceiptViewer);
  $("receiptDetailBackdrop")?.addEventListener("click", event => { if (event.target?.id === "receiptDetailBackdrop") closeReceiptViewer(); });
});
