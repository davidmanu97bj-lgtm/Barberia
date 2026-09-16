
import {
  collection, query, orderBy, documentId, limit, startAfter, where,
  getDocs, getCountFromServer, doc, getDoc, setDoc, writeBatch,
  serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  ref as storageRef, list as listStorage, deleteObject, getMetadata
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

const F = window.ExploraFirebase || {};
const db = F.db;
const auth = F.auth;
const storage = F.storage;
const $ = id => document.getElementById(id);

const VERSION = "v259-storage-list-permission-diagnostic";
const FULL_RESET_PHRASE = "LANZAR EXPLORA";
const STORAGE_RETRY_PHRASE = "REINTENTAR STORAGE";
const LEGACY_RESET_ID = "reset_1781403245159_2LziyTTd";
const ADMIN_UIDS = new Set(["2LziyTTdFcZzSOhK3hLbAKs2U4s2"]);
const ADMIN_ROLES = new Set(["admin", "administrador", "owner", "superadmin"]);
const BATCH_SIZE = 400;
const STORAGE_PAGE_SIZE = 500;
const STORAGE_WORKERS = 4;

const MASTER_COLLECTIONS = new Set([
  "choferes", "vehiculos", "usuarios", "users", "admins", "administradores",
  "login_aliases", "configuracion", "explora_config", "tarifas", "settings", "system",
  "app_reset_audit", "app_operational_state", "app_reset_storage_manifests",
  "app_reset_storage_manifest_items"
]);

const OPERATIONAL = Object.freeze([
  "billing_records", "gastos", "facturacion_semanal", "gastos_semanales", "servicios_facturados", "cobros", "ingresos", "payment_operations", "receipt_index",
  "derivaciones", "derivaciones_pendientes", "historial_derivaciones", "derivation_audit", "colaboraciones", "retenciones", "bonos_derivaciones",
  "cierres_semanales", "cierres_mensuales", "pagos_semanales", "acumulados_semanales", "historial_cierres",
  "prestamos_operativos", "prestamos_explora", "prestamos_explora_ventanas_8s", "prestamos_explora_ventanas_publicas_8s", "prestamos_explora_historial", "deudas_choferes",
  "performance_awards", "performance_cycles", "performance_derivation_winners", "performance_public", "derivation_ranking_public", "ranking_metas_public", "ranking_derivaciones_public",
  "derivation_ranking", "derivation_rankings", "derivation_stats", "derivation_monthly_stats", "derivation_summary", "derivation_summaries", "derivation_winners", "derivation_bonus", "derivation_bonuses", "ranking_derivaciones", "ranking_derivador", "ranking_derivadores", "ranking_derivaciones_historial", "ranking_derivaciones_estadisticas",
  "ranking_facturador", "ranking_semanal", "ranking_mensual", "performance_mensual", "performance_semanal", "historial_rendimiento_temporal", "historial_metricas", "historial_rendimiento", "historial_financiero", "metricas_ciclo", "beneficios_ciclo", "ventanas_metas", "metas_temporales", "beneficios_temporales",
  "simulaciones_choferes", "simulation_operations", "novedades", "novedades_temporales", "notificaciones", "notificaciones_temporales", "estados_temporales",
  "cache_rankings", "cache_metas", "cache_dashboard", "cache_derivaciones", "cache_novedades", "cache_performance", "snapshots_semanales", "snapshots_mensuales", "snapshots_financieros"
]);

const STORAGE_REFERENCE_COLLECTIONS = Object.freeze([
  "receipt_index", "billing_records", "gastos", "cierres_semanales", "pagos_semanales",
  "deudas_choferes", "prestamos_operativos", "payment_operations"
]);

// Rutas operativas reales detectadas en el HTML v257.
const STORAGE_OPERATIONAL_ROOTS = Object.freeze(["gastos", "prestamos", "deudas", "cierres_semanales"]);
const PROTECTED_STORAGE_PREFIXES = Object.freeze([
  "profiles/", "profile_photos/", "avatars/", "driver_photos/", "vehicle_photos/",
  "vehicles/", "vehiculos/", "logos/", "branding/", "assets/", "config/",
  "permanent/", "master_data/"
]);
const STORAGE_PATH_FIELDS = new Set([
  "storagepath", "fullpath", "receiptpath", "comprobantepath", "adminreceiptpath",
  "driverreceiptpath", "expensereceiptpath", "billingreceiptpath", "closurereceiptpath",
  "debtreceiptpath", "loanreceiptpath", "filepath", "archivopath", "davidreceiptpath"
]);
const STORAGE_URL_FIELDS = new Set([
  "downloadurl", "receipturl", "comprobanteurl", "adminreceipturl", "driverreceipturl",
  "expensereceipturl", "billingreceipturl", "closurereceipturl", "debtreceipturl",
  "loanreceipturl", "fileurl", "archivourl", "davidreceipturl"
]);
const DRIVER_OPERATIONAL_FIELDS = Object.freeze([
  "deuda", "deudaActual", "deudaTotal", "saldoDeuda", "prestamo", "prestamoActual", "prestamoActivo", "loanBalance",
  "facturacionSemanal", "gastosSemanales", "rankingSemanal", "rankingMensual", "performanceMensual", "performanceSemanal",
  "cierreSemanal", "cierreMensual", "simulacionActiva", "simulationActive", "simulationConfigId", "totalFacturado",
  "totalGastos", "weeklyRevenue", "monthlyRevenue", "currentGoal", "goalPercent", "benefitAmount", "derivationAmount",
  "rankingPosition", "derivationRankingPosition", "derivationRank", "derivedMoney", "totalDerivedMoney", "completedDerivations", "sentCompletedDerivations", "derivationCount", "derivationBonus", "bonusAmount", "currentWinner", "previousWinner", "derivationStats", "monthlyDerivationStats", "derivationSummary", "closureStatus", "debtBalance", "currentWeekSnapshot", "lastClosure", "pendingReceipt",
  "pendingNotification", "performanceHistory", "operationalStats"
]);

const state = {
  busy:false,
  preview:null,
  resetId:"",
  operationId:"",
  targetResetId:"",
  confirmPhrase:FULL_RESET_PHRASE,
  startedAt:0,
  startedAtMs:0,
  failures:[],
  warnings:[],
  deletedByCollection:{},
  profilesReviewed:0,
  profilesModified:0,
  cacheEntries:0,
  manifest:new Map(),
  storageResults:[],
  storageStats:{discovered:0,indexed:0,listed:0,deleted:0,notFound:0,listDenied:0,deleteDenied:0,protected:0,unknown:0,failed:0,skippedNewer:0},
  retryCandidate:null,
  storagePermissionTestPassed:false,
  storagePermissionTest:null,
  adminIdentityDiagnostic:null
};

const role = value => String(value || "").trim().toLowerCase();
const toMs = value => {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

function resetStorageStats() {
  state.storageResults = [];
  state.storageStats = {discovered:0,indexed:0,listed:0,deleted:0,notFound:0,listDenied:0,deleteDenied:0,protected:0,unknown:0,failed:0,skippedNewer:0};
}

function resetError(stage, code, message, cause = null, detail = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.internalCode = code;
  error.resetStage = stage;
  error.resetDetail = detail;
  if (cause) {
    error.cause = cause;
    error.firebaseCode = String(cause.code || "");
    error.firebaseMessage = String(cause.message || cause || "");
  }
  return error;
}

function hashPath(value) {
  let a = 2166136261;
  let b = 2246822519;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 3266489917);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

function manifestItemId(resetId, path) {
  return `${String(resetId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 90)}_${hashPath(path)}`;
}

function normalizeStoragePath(value) {
  let path = String(value || "").trim();
  if (!path || /^(?:data|blob):/i.test(path)) return "";
  if (/^gs:\/\//i.test(path)) {
    const withoutScheme = path.replace(/^gs:\/\//i, "");
    path = withoutScheme.includes("/") ? withoutScheme.slice(withoutScheme.indexOf("/") + 1) : "";
  } else if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      const marker = "/o/";
      const index = url.pathname.indexOf(marker);
      if (index < 0) return "";
      path = decodeURIComponent(url.pathname.slice(index + marker.length));
    } catch (_) {
      return "";
    }
  }
  path = path.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!path || path.length > 1024 || /(?:^|\/)\.\.(?:\/|$)/.test(path) || /undefined|null|\[object Object\]/i.test(path)) return "";
  return path;
}

function isProtectedStoragePath(value) {
  const path = normalizeStoragePath(value).toLowerCase();
  if (!path) return false;
  if (PROTECTED_STORAGE_PREFIXES.some(prefix => path.startsWith(prefix))) return true;
  return /(?:^|\/)(?:avatar|avatars|profile_photo|profile_photos|vehicle_photo|vehicle_photos|logo|logos|branding|assets|master_data|permanent)(?:\/|$)/i.test(path);
}

function isOperationalStoragePath(value) {
  const path = normalizeStoragePath(value);
  return Boolean(path && STORAGE_OPERATIONAL_ROOTS.some(root => path === root || path.startsWith(`${root}/`)));
}

function rootForPath(value) {
  const path = normalizeStoragePath(value);
  return path.split("/")[0] || "";
}

function extractOwnerUid(data = {}, path = "") {
  const candidates = [
    data.ownerUid, data.driverUid, data.choferUid, data.uid, data.uploadedByUid,
    data.createdByUid, data.receptorUid, data.receiverUid
  ].map(value => String(value || "").trim()).filter(Boolean);
  if (candidates.length) return candidates[0];
  const parts = normalizeStoragePath(path).split("/");
  if (["gastos", "prestamos", "deudas"].includes(parts[0])) return parts[1] || "";
  if (parts[0] === "cierres_semanales") return parts[2] || "";
  return "";
}

function addManifestItem(map, input = {}) {
  const rawPath = input.storagePath || input.fullPath || input.path || input.downloadURL || input.receiptUrl || "";
  const path = normalizeStoragePath(rawPath);
  if (!path) {
    if (rawPath) state.storageStats.unknown += 1;
    return null;
  }
  const protectedPath = isProtectedStoragePath(path);
  const operational = isOperationalStoragePath(path);
  if (!protectedPath && !operational) {
    state.storageStats.unknown += 1;
    return null;
  }
  const previous = map.get(path);
  const item = previous || {
    storagePath:path,
    fullPath:path,
    module:String(input.module || input.category || rootForPath(path) || "operational"),
    firestoreCollection:String(input.firestoreCollection || input.relatedCollection || ""),
    firestoreDocumentId:String(input.firestoreDocumentId || input.relatedDocumentId || ""),
    ownerUid:String(input.ownerUid || ""),
    category:String(input.category || rootForPath(path) || "operational"),
    operational:Boolean(operational),
    protected:Boolean(protectedPath),
    source:String(input.source || "firestore"),
    sources:[],
    createdAtMs:Number(input.createdAtMs || 0),
    status:protectedPath ? "PROTECTED" : "PENDING"
  };
  const sourceKey = `${String(input.firestoreCollection || input.relatedCollection || "")}/${String(input.firestoreDocumentId || input.relatedDocumentId || "")}`;
  if (sourceKey !== "/" && !item.sources.includes(sourceKey)) item.sources.push(sourceKey);
  if (!item.ownerUid && input.ownerUid) item.ownerUid = String(input.ownerUid);
  if (!item.createdAtMs && input.createdAtMs) item.createdAtMs = Number(input.createdAtMs);
  map.set(path, item);
  return item;
}

function extractPathsFromValue(value, context, map, trail = "", depth = 0, seen = new WeakSet()) {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") return;
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = String(key).toLowerCase();
    const nextTrail = trail ? `${trail}.${key}` : key;
    if (typeof child === "string" && (STORAGE_PATH_FIELDS.has(normalizedKey) || STORAGE_URL_FIELDS.has(normalizedKey))) {
      addManifestItem(map, {
        storagePath:child,
        module:context.module,
        firestoreCollection:context.collectionName,
        firestoreDocumentId:context.documentId,
        ownerUid:context.ownerUid,
        category:context.category,
        createdAtMs:context.createdAtMs,
        source:`firestore:${nextTrail}`
      });
    } else if (child && typeof child === "object") {
      extractPathsFromValue(child, context, map, nextTrail, depth + 1, seen);
    }
  }
}

async function getClaims(user) {
  try {
    return (await user.getIdTokenResult(true))?.claims || {};
  } catch (_) {
    return {};
  }
}

async function readProtectedAdminRecord(uid) {
  const session = window.ExploraSession || {};
  const candidates = [];
  const add = (collectionName, documentId, source) => {
    const collection = String(collectionName || "").trim();
    const id = String(documentId || "").trim();
    if (!collection || !id) return;
    const key = `${collection}/${id}`;
    if (!candidates.some(item => item.key === key)) candidates.push({key, collectionName:collection, documentId:id, source});
  };
  add(session.profileCollection || session.profileRef?.parent?.id, session.profileDocumentId || session.driverId, "ExploraSession");
  for (const name of ["administradores", "admins", "usuarios", "choferes"]) add(name, uid, "uid-direct");

  const inspected = [];
  for (const candidate of candidates) {
    try {
      const snap = await getDoc(doc(db, candidate.collectionName, candidate.documentId));
      if (!snap.exists()) { inspected.push({...candidate, exists:false}); continue; }
      const data = snap.data() || {};
      const detectedRole = role(data.role || data.rol || data.tipo || data.tipoUsuario || data.userRole || data.profileType);
      const active = !(data.active === false || data.activo === false || role(data.estado) === "inactivo" || data.enabled === false || data.disabled === true || data.deleted === true);
      const adminFlag = data.isAdmin === true || data.admin === true;
      const valid = active && (ADMIN_ROLES.has(detectedRole) || adminFlag);
      inspected.push({...candidate, exists:true, detectedRole, active, adminFlag, valid, fields:Object.keys(data).filter(k => ["role","rol","tipo","tipoUsuario","userRole","profileType","isAdmin","admin","active","activo","enabled","disabled","estado"].includes(k))});
      if (valid) return {collectionName:candidate.collectionName, documentId:candidate.documentId, data, role:detectedRole || (adminFlag ? "admin" : ""), source:candidate.source, inspected};
    } catch (error) {
      inspected.push({...candidate, exists:null, errorCode:String(error?.code || "READ_FAILED")});
    }
  }
  return {valid:false, inspected};
}

async function readVerifiedAdmin() {
  const user = auth?.currentUser;
  if (!user?.uid) throw resetError("VALIDATE_ADMIN", "AUTH_REQUIRED", "No hay una sesión Firebase autenticada.");
  const claims = await getClaims(user);
  const claimRole = role(claims.role || claims.rol || claims.tipo);
  const claimAdmin = claims.admin === true || ADMIN_ROLES.has(claimRole);
  const protectedRecord = await readProtectedAdminRecord(user.uid);
  const sessionRole = role(window.ExploraSession?.role || window.ExploraSession?.profile?.role || window.ExploraSession?.profile?.rol || window.ExploraSession?.profile?.tipoUsuario);
  const uidAllowed = ADMIN_UIDS.has(user.uid);
  const protectedRecordValid = Boolean(protectedRecord && protectedRecord.valid !== false && protectedRecord.collectionName);
  if (!uidAllowed || !(claimAdmin || protectedRecordValid || ADMIN_ROLES.has(sessionRole))) {
    throw resetError("VALIDATE_ADMIN", "ADMIN_REQUIRED", "El rol Admin no pudo confirmarse con UID, token o documento protegido.", null, {
      uid:user.uid,
      uidAllowed,
      sessionRole,
      claimKeys:Object.keys(claims).filter(key => ["admin", "role", "rol", "tipo"].includes(key)),
      protectedRecord:protectedRecordValid ? `${protectedRecord.collectionName}/${protectedRecord.documentId || user.uid}` : "",
      inspectedAdminPaths:protectedRecord?.inspected || []
    });
  }
  return {uid:user.uid, email:user.email || "", claims, claimAdmin, protectedRecord, protectedRecordValid, sessionRole, uidAllowed};
}


function firebaseProjectDiagnostic() {
  const appOptions = storage?.app?.options || auth?.app?.options || {};
  const configured = window.ExploraFirebase?.app?.options || appOptions;
  return {
    projectId:String(configured?.projectId || appOptions?.projectId || ""),
    storageBucket:String(configured?.storageBucket || appOptions?.storageBucket || ""),
    appId:String(configured?.appId || appOptions?.appId || "")
  };
}

function safeClaimSummary(claims = {}) {
  const allowed = ["admin", "role", "rol", "tipo", "isAdmin"];
  const out = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(claims, key)) out[key] = claims[key];
  return out;
}

function renderStoragePermissionDiagnostic(report) {
  state.storagePermissionTest = report || null;
  state.storagePermissionTestPassed = Boolean(report?.allAuthorized);
  const box = $("storagePermissionDiagnostic");
  const textNode = $("storagePermissionDiagnosticText");
  const routesNode = $("storagePermissionRouteResults");
  if (box) box.hidden = false;
  if (textNode) textNode.textContent = report?.text || "Sin diagnóstico.";
  if (routesNode) routesNode.innerHTML = (report?.routes || []).map(item => `<div class="storage-permission-route" data-state="${item.state}"><span>${item.path}</span><b>${item.state}</b></div>`).join("");
  const retry = $("launchStorageRetryBtn");
  if (retry) retry.disabled = !state.storagePermissionTestPassed || state.busy;
  if ($("launchConfirmMessage")) {
    $("launchConfirmMessage").textContent = state.storagePermissionTestPassed
      ? "Las cuatro raíces permiten list. Ya podés reintentar exclusivamente Storage."
      : "El reintento permanece bloqueado hasta que las cuatro raíces autoricen list.";
  }
}

async function runStoragePermissionDiagnostic() {
  const button = $("storagePermissionTestBtn");
  if (button) { button.disabled = true; button.textContent = "PROBANDO…"; }
  state.storagePermissionTestPassed = false;
  try {
    const admin = await readVerifiedAdmin();
    const project = firebaseProjectDiagnostic();
    const session = window.ExploraSession || {};
    const expectedUid = [...ADMIN_UIDS][0] || "";
    const routes = [];
    for (const root of STORAGE_OPERATIONAL_ROOTS) {
      try {
        const result = await listStorage(storageRef(storage, root), {maxResults:1});
        routes.push({path:root, state:(result.items.length || result.prefixes.length) ? "AUTHORIZED" : "EMPTY", items:result.items.length, prefixes:result.prefixes.length});
      } catch (error) {
        const code = String(error?.code || "");
        routes.push({path:root, state:code === "storage/unauthorized" ? "LIST_PERMISSION_DENIED" : "ERROR", code:code || "UNKNOWN", message:String(error?.message || error)});
      }
    }
    const direct = admin.protectedRecord;
    const claims = safeClaimSummary(admin.claims);
    const allAuthorized = routes.every(item => item.state === "AUTHORIZED" || item.state === "EMPTY");
    const uidMatches = admin.uid === expectedUid;
    const expectedProjectId = "explora-control-operativo";
    const expectedBucket = "explora-control-operativo.firebasestorage.app";
    const projectMatches = project.projectId === expectedProjectId;
    const bucketMatches = project.storageBucket === expectedBucket;
    const lines = [
      "EXPLORA · STORAGE LIST PERMISSION DIAGNOSTIC v259",
      `Timestamp: ${new Date().toISOString()}`,
      `Auth UID: ${admin.uid || "—"}`,
      `UID esperado: ${expectedUid || "—"}`,
      `UID coincide: ${uidMatches ? "SÍ" : "NO"}`,
      `Email autenticado: ${admin.email || "—"}`,
      `Frontend role: ${admin.sessionRole || "—"}`,
      `Custom Claims visibles: ${JSON.stringify(claims)}`,
      `Documento Admin válido: ${admin.protectedRecordValid ? "SÍ" : "NO"}`,
      `Documento Admin encontrado: ${direct?.collectionName ? `${direct.collectionName}/${direct.documentId || admin.uid}` : "—"}`,
      `Origen documento: ${direct?.source || "—"}`,
      `Campos Admin detectados: ${(direct?.inspected || []).map(x => `${x.collectionName}/${x.documentId}:${x.exists === true ? `exists role=${x.detectedRole || "—"} active=${x.active}` : x.exists === false ? "not-found" : x.errorCode || "unknown"}`).join(" | ") || "—"}`,
      `projectId: ${project.projectId || "—"}`,
      `projectId esperado: ${expectedProjectId}`,
      `projectId coincide: ${projectMatches ? "SÍ" : "NO"}`,
      `storageBucket: ${project.storageBucket || "—"}`,
      `storageBucket esperado: ${expectedBucket}`,
      `storageBucket coincide: ${bucketMatches ? "SÍ" : "NO"}`,
      `appId: ${project.appId || "—"}`,
      "",
      ...routes.map(item => `${item.path}: ${item.state}${item.code ? ` · ${item.code}` : ""}`),
      "",
      `Resultado general: ${allAuthorized ? "AUTORIZADO" : "BLOQUEADO"}`,
      !uidMatches ? "DIAGNÓSTICO: UID autenticado diferente del Admin esperado." : "",
      !projectMatches || !bucketMatches ? "DIAGNÓSTICO: BUCKET INCORRECTO o proyecto distinto al esperado." : "",
      uidMatches && projectMatches && bucketMatches && !allAuthorized ? "DIAGNÓSTICO: identidad/proyecto coinciden; revisar reglas publicadas, claim o documento Admin consultado por Storage Rules." : ""
    ].filter(Boolean);
    const report = {admin, project, routes, allAuthorized, uidMatches, projectMatches, bucketMatches, text:lines.join("\n")};
    state.adminIdentityDiagnostic = report;
    renderStoragePermissionDiagnostic(report);
    return report;
  } catch (error) {
    const report = {routes:[], allAuthorized:false, text:`DIAGNÓSTICO FALLIDO\nCódigo: ${error?.code || "DIAGNOSTIC_FAILED"}\nMensaje: ${error?.message || error}\nUID: ${auth?.currentUser?.uid || "—"}\nTimestamp: ${new Date().toISOString()}`};
    renderStoragePermissionDiagnostic(report);
    return report;
  } finally {
    if (button) { button.disabled = false; button.textContent = "PROBAR PERMISOS STORAGE"; }
  }
}

function copyStoragePermissionDiagnostic() {
  const text = $("storagePermissionDiagnosticText")?.textContent || "Sin diagnóstico.";
  navigator.clipboard?.writeText(text).then(() => window.showToast?.("Informe Storage copiado.")).catch(() => window.showToast?.("No se pudo copiar el informe."));
}

function renderPanel({
  status="confirm", title="REINICIO OPERATIVO TOTAL", badge="REINICIO OPERATIVO TOTAL",
  copy="", details="", message="", button="CONFIRMAR REINICIO TOTAL", mode="execute",
  showCancel=true, showInputs=true, showRetry=false, retryLabel="REINTENTAR LIMPIEZA DE STORAGE"
} = {}) {
  const card = $("launchConfirmCard");
  if (card) card.dataset.status = status;
  if ($("launchConfirmTitle")) $("launchConfirmTitle").textContent = title;
  if ($("launchStatusBadge")) $("launchStatusBadge").textContent = badge;
  if ($("launchConfirmCopy")) $("launchConfirmCopy").innerHTML = copy;
  const detailsNode = $("launchResetDetails");
  if (detailsNode) { detailsNode.hidden = !details; detailsNode.textContent = details || ""; }
  const messageNode = $("launchConfirmMessage");
  if (messageNode) {
    messageNode.textContent = message || "";
    messageNode.className = `admin-shared-status${status === "error" ? " is-error" : status === "success" ? " is-ok" : ""}`;
  }
  const executeButton = $("launchExecuteBtn");
  if (executeButton) { executeButton.textContent = button; executeButton.dataset.mode = mode; }
  const retryButton = $("launchStorageRetryBtn");
  if (retryButton) { retryButton.hidden = !showRetry; retryButton.textContent = retryLabel; retryButton.disabled = state.busy || !state.storagePermissionTestPassed; }
  const diagnostic = $("storagePermissionDiagnostic");
  if (diagnostic) diagnostic.hidden = !(showRetry || mode === "retry-storage");
  if ($("launchCancelBtn")) $("launchCancelBtn").hidden = !showCancel;
  $("launchConfirmActions")?.classList.toggle("is-single", !showCancel);
  for (const id of ["launchPhraseLabel", "launchConfirmPhrase", "launchSecondConfirmWrap"]) {
    const element = $(id);
    if (element) element.hidden = !showInputs;
  }
  validateConfirm();
}

function setConfirmationPhrase(phrase, checkboxText) {
  state.confirmPhrase = phrase;
  const label = $("launchPhraseLabel");
  if (label) label.innerHTML = `Escribí exactamente <strong>${phrase}</strong>`;
  const input = $("launchConfirmPhrase");
  if (input) { input.value = ""; input.placeholder = phrase; }
  const checkboxLabel = $("launchSecondConfirmWrap")?.querySelector("span");
  if (checkboxLabel) checkboxLabel.textContent = checkboxText;
  if ($("launchSecondConfirm")) $("launchSecondConfirm").checked = false;
}

function introMarkup() {
  return `<p>Esta acción eliminará todos los datos operativos generados por EXPLORA y conservará los datos maestros necesarios para seguir trabajando.</p>
  <div class="launch-confirm-list launch-confirm-list--delete"><strong>SE ELIMINARÁ:</strong><br>Cobros, gastos, comprobantes, derivaciones, rankings, cierres, deudas, préstamos, novedades, simulaciones, snapshots e historial operativo.</div>
  <div class="launch-confirm-list launch-confirm-list--keep"><strong>SE CONSERVARÁ:</strong><br>Admin, choferes, nombres, UID, cuentas, perfiles, fotos, vehículos, asignaciones actuales, configuración, tarifas y reglas de funcionamiento.</div>
  <p><strong>Storage se elimina primero mediante rutas exactas. La acción no se puede deshacer.</strong></p>`;
}

function storageRetryMarkup(resetId) {
  return `<p>Este reintento procesa únicamente archivos operativos pendientes de Firebase Storage.</p>
  <div class="launch-confirm-list"><strong>RESET OBJETIVO:</strong><br>${String(resetId || LEGACY_RESET_ID)}</div>
  <div class="launch-confirm-list launch-confirm-list--keep"><strong>NO SE MODIFICARÁ:</strong><br>Firestore operativo ya reiniciado, perfiles, choferes, vehículos, Authentication, rankings ni configuraciones maestras.</div>`;
}

async function countCollection(name) {
  try { return (await getCountFromServer(collection(db, name))).data().count; }
  catch (_) { return null; }
}

async function loadResetAudit(resetId) {
  if (!resetId) return null;
  try {
    const snap = await getDoc(doc(db, "app_reset_audit", resetId));
    return snap.exists() ? {id:snap.id, ...(snap.data() || {})} : null;
  } catch (_) {
    return null;
  }
}

function storageFailureCount(data = {}) {
  const failures = Array.isArray(data.failures) ? data.failures : [];
  return failures.filter(item => String(item?.stage || "").includes("STORAGE") || String(item?.code || "").includes("storage/")).length;
}

async function findRetryCandidate() {
  let current = null;
  try {
    const snap = await getDoc(doc(db, "app_operational_state", "current"));
    if (snap.exists()) current = snap.data() || {};
  } catch (_) {}
  const currentId = String(current?.resetId || "");
  if (currentId && (current.storageCleanupComplete === false || Number(current.storagePermissionDenied || 0) > 0 || storageFailureCount(current) > 0)) {
    return {resetId:currentId, data:current};
  }
  const legacy = await loadResetAudit(LEGACY_RESET_ID);
  if (legacy && (legacy.storageCleanupComplete === false || Number(legacy.storageFilesDeleted || 0) === 0 || storageFailureCount(legacy) > 0)) {
    return {resetId:LEGACY_RESET_ID, data:legacy};
  }
  return null;
}

async function buildPreview() {
  const admin = await readVerifiedAdmin();
  const preview = {adminUid:admin.uid, operational:{}, master:{}, storageIndexed:null};
  for (const name of OPERATIONAL) preview.operational[name] = await countCollection(name);
  for (const name of ["choferes", "vehiculos"]) preview.master[name] = await countCollection(name);
  preview.storageIndexed = preview.operational.receipt_index;
  state.retryCandidate = await findRetryCandidate();
  state.preview = preview;
  return preview;
}

function previewText(preview) {
  const groups = {
    Cobros:["billing_records", "cobros", "payment_operations"],
    Gastos:["gastos", "gastos_semanales"],
    Derivaciones:["derivaciones", "derivaciones_pendientes", "historial_derivaciones"],
    Cierres:["cierres_semanales", "cierres_mensuales", "pagos_semanales"],
    Deudas:["deudas_choferes"],
    Préstamos:["prestamos_operativos", "prestamos_explora"],
    Rankings:["ranking_facturador", "ranking_derivador", "ranking_semanal", "ranking_mensual", "performance_public"],
    Snapshots:["snapshots_semanales", "snapshots_mensuales", "snapshots_financieros"],
    Notificaciones:["novedades", "notificaciones"]
  };
  const sum = keys => {
    let known = 0;
    let unknown = false;
    for (const key of keys) {
      const value = preview.operational[key];
      if (value == null) unknown = true;
      else known += value;
    }
    return unknown ? `${known} + cantidad no disponible` : String(known);
  };
  return `SE ELIMINARÁ\n${Object.entries(groups).map(([name, keys]) => `• ${name}: ${sum(keys)}`).join("\n")}\n• Rutas Storage indexadas: ${preview.storageIndexed ?? "Cantidad no disponible"}\n\nSE CONSERVARÁ\n• Usuarios/choferes: ${preview.master.choferes ?? "Cantidad no disponible"}\n• Vehículos: ${preview.master.vehiculos ?? "Cantidad no disponible"}\n• Admin, Authentication y configuración`;
}

function validateConfirm() {
  const button = $("launchExecuteBtn");
  if (!button || !["execute", "retry-storage"].includes(button.dataset.mode)) return;
  const valid = $("launchConfirmPhrase")?.value === state.confirmPhrase && $("launchSecondConfirm")?.checked === true && !state.busy;
  button.disabled = !valid;
}

function setProgress(phase, current, total) {
  const box = $("launchResetProgress");
  if (box) box.hidden = false;
  const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  if ($("launchResetPhase")) $("launchResetPhase").textContent = phase;
  if ($("launchResetPercent")) $("launchResetPercent").textContent = `${percent}%`;
  if ($("launchResetProgressBar")) $("launchResetProgressBar").style.width = `${percent}%`;
}

async function acquireLock(adminUid, {mode="full-reset", targetResetId=""} = {}) {
  const lockRef = doc(db, "system", "operational_reset");
  const snap = await getDoc(lockRef);
  const data = snap.exists() ? snap.data() || {} : {};
  if (data.inProgress === true) throw resetError("LOCK_OPERATION", "RESET_ALREADY_RUNNING", "Ya existe un reinicio operativo en curso.", null, {resetId:data.resetId || ""});
  state.operationId = mode === "full-reset" ? `reset_${Date.now()}_${adminUid.slice(0, 8)}` : `storage_retry_${Date.now()}_${adminUid.slice(0, 8)}`;
  state.resetId = mode === "full-reset" ? state.operationId : String(targetResetId || LEGACY_RESET_ID);
  state.targetResetId = String(targetResetId || state.resetId);
  await setDoc(lockRef, {
    inProgress:true,
    resetId:state.operationId,
    targetResetId:state.targetResetId,
    mode,
    startedAt:serverTimestamp(),
    startedAtMs:Date.now(),
    startedBy:adminUid,
    schemaVersion:VERSION,
    phase:"LOCK_OPERATION",
    processed:0,
    total:OPERATIONAL.length,
    errorCount:0
  }, {merge:true});
  window.__exploraOperationalResetInProgress = true;
  window.dispatchEvent(new CustomEvent("explora:operational-reset-lock", {detail:{inProgress:true, resetId:state.operationId, targetResetId:state.targetResetId, mode}}));
}

async function updateLock(patch) {
  try {
    await setDoc(doc(db, "system", "operational_reset"), {...patch, resetId:state.operationId || state.resetId, targetResetId:state.targetResetId || state.resetId, updatedAt:serverTimestamp()}, {merge:true});
  } catch (_) {}
}

async function pageCollection(name, visitor) {
  let last = null;
  for (;;) {
    let reference = query(collection(db, name), orderBy(documentId()), limit(BATCH_SIZE));
    if (last) reference = query(collection(db, name), orderBy(documentId()), startAfter(last), limit(BATCH_SIZE));
    const snapshot = await getDocs(reference);
    if (snapshot.empty) break;
    await visitor(snapshot.docs);
    last = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < BATCH_SIZE) break;
  }
}

async function buildStorageManifest(resetId, {cutoffMs=Date.now(), includeFirestore=true} = {}) {
  const manifest = new Map();
  if (includeFirestore) {
    for (const collectionName of STORAGE_REFERENCE_COLLECTIONS) {
      try {
        await pageCollection(collectionName, async docs => {
          for (const documentSnapshot of docs) {
            const data = documentSnapshot.data() || {};
            const context = {
              collectionName,
              documentId:documentSnapshot.id,
              module:String(data.module || data.category || data.type || collectionName),
              category:String(data.category || data.receiptCategory || data.type || collectionName),
              ownerUid:extractOwnerUid(data),
              createdAtMs:toMs(data.createdAt || data.receiptUploadedAt || data.uploadedAt || data.updatedAt)
            };
            extractPathsFromValue(data, context, manifest);
          }
        });
      } catch (error) {
        state.warnings.push({stage:"BUILD_STORAGE_MANIFEST", collection:collectionName, code:String(error.code || "MANIFEST_READ_FAILED"), message:String(error.message || error)});
      }
    }
  }
  for (const item of manifest.values()) {
    if (item.createdAtMs && item.createdAtMs > cutoffMs) {
      item.status = "SKIPPED_NEWER";
      state.storageStats.skippedNewer += 1;
    }
  }
  state.storageStats.indexed = [...manifest.values()].filter(item => !item.protected).length;
  state.manifest = manifest;
  await persistManifest(resetId, manifest, {cutoffMs, source:"firestore"});
  return manifest;
}

async function persistManifest(resetId, manifest, extra = {}) {
  await setDoc(doc(db, "app_reset_storage_manifests", resetId), {
    resetId,
    schemaVersion:VERSION,
    createdAt:serverTimestamp(),
    createdAtMs:Date.now(),
    fileCount:manifest.size,
    roots:[...STORAGE_OPERATIONAL_ROOTS],
    ...extra
  }, {merge:true});
  const items = [...manifest.values()];
  for (let index = 0; index < items.length; index += BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const item of items.slice(index, index + BATCH_SIZE)) {
      const id = manifestItemId(resetId, item.storagePath);
      batch.set(doc(db, "app_reset_storage_manifest_items", id), {
        resetId,
        manifestItemId:id,
        storagePath:item.storagePath,
        fullPath:item.storagePath,
        module:item.module,
        firestoreCollection:item.firestoreCollection,
        firestoreDocumentId:item.firestoreDocumentId,
        ownerUid:item.ownerUid,
        category:item.category,
        operational:item.operational,
        protected:item.protected,
        source:item.source,
        sources:item.sources,
        createdAtMs:item.createdAtMs || 0,
        status:item.status || "PENDING",
        schemaVersion:VERSION,
        updatedAt:serverTimestamp()
      }, {merge:true});
    }
    await batch.commit();
  }
}

async function loadPersistedManifest(resetId) {
  const map = new Map();
  try {
    const snapshot = await getDocs(query(collection(db, "app_reset_storage_manifest_items"), where("resetId", "==", resetId), limit(5000)));
    snapshot.forEach(documentSnapshot => addManifestItem(map, {...documentSnapshot.data(), source:"persisted-manifest"}));
  } catch (error) {
    state.warnings.push({stage:"LOAD_STORAGE_MANIFEST", collection:"app_reset_storage_manifest_items", code:String(error.code || "MANIFEST_LOAD_FAILED"), message:String(error.message || error)});
  }
  return map;
}

async function metadataCreatedAtMs(reference) {
  try {
    const metadata = await getMetadata(reference);
    return {createdAtMs:Date.parse(metadata.timeCreated || metadata.updated || "") || 0, metadata};
  } catch (error) {
    return {createdAtMs:0, metadata:null, error};
  }
}

async function scanStorageRoot(root, map, {cutoffMs=Date.now()} = {}) {
  const queue = [storageRef(storage, root)];
  while (queue.length) {
    const current = queue.shift();
    let pageToken = undefined;
    do {
      let result;
      try {
        result = await listStorage(current, {maxResults:STORAGE_PAGE_SIZE, pageToken});
      } catch (error) {
        const code = String(error?.code || "");
        if (code === "storage/unauthorized") {
          state.storageStats.listDenied += 1;
          state.warnings.push({stage:"DELETE_OPERATIONAL_STORAGE", collection:root, path:current.fullPath || root, operation:"list", code:"LIST_PERMISSION_DENIED", firebaseCode:code, message:String(error.message || error)});
          return;
        }
        state.storageStats.failed += 1;
        state.warnings.push({stage:"DELETE_OPERATIONAL_STORAGE", collection:root, path:current.fullPath || root, operation:"list", code:code || "STORAGE_LIST_FAILED", message:String(error.message || error)});
        return;
      }
      for (const prefix of result.prefixes || []) queue.push(prefix);
      for (const itemRef of result.items || []) {
        const path = normalizeStoragePath(itemRef.fullPath);
        if (!path) continue;
        const metaResult = await metadataCreatedAtMs(itemRef);
        if (metaResult.createdAtMs && metaResult.createdAtMs > cutoffMs) {
          state.storageStats.skippedNewer += 1;
          continue;
        }
        const added = addManifestItem(map, {
          storagePath:path,
          module:root,
          firestoreCollection:"",
          firestoreDocumentId:"",
          ownerUid:String(metaResult.metadata?.customMetadata?.ownerUid || metaResult.metadata?.customMetadata?.driverUid || ""),
          category:root,
          createdAtMs:metaResult.createdAtMs,
          source:"storage-list"
        });
        if (added) state.storageStats.listed += 1;
      }
      pageToken = result.nextPageToken || undefined;
    } while (pageToken);
  }
}

async function discoverLegacyStorageObjects(map, {cutoffMs=Date.now()} = {}) {
  for (const root of STORAGE_OPERATIONAL_ROOTS) await scanStorageRoot(root, map, {cutoffMs});
  state.storageStats.discovered = map.size;
  return map;
}

function classifyStorageError(error, operation) {
  const firebaseCode = String(error?.code || "storage/unknown");
  if (firebaseCode === "storage/object-not-found") return {status:"NOT_FOUND", retry:false};
  if (firebaseCode === "storage/unauthorized") return {status:operation === "list" ? "LIST_PERMISSION_DENIED" : "DELETE_PERMISSION_DENIED", retry:false};
  if (firebaseCode === "storage/retry-limit-exceeded") return {status:"FAILED", retry:true};
  if (firebaseCode === "storage/invalid-url" || firebaseCode === "storage/invalid-argument") return {status:"UNKNOWN_PATH", retry:false};
  return {status:"FAILED", retry:false};
}

async function deleteOperationalStorageObject(item, {admin, maxRetries=1} = {}) {
  const path = normalizeStoragePath(item?.storagePath || item?.fullPath || "");
  const base = {path, module:item?.module || rootForPath(path), ownerUid:item?.ownerUid || "", resetId:state.targetResetId || state.resetId, operation:"delete"};
  if (!path) return {...base, status:"UNKNOWN_PATH", code:"STORAGE_PATH_EMPTY"};
  if (isProtectedStoragePath(path) || item?.protected) return {...base, status:"PROTECTED", code:"PROTECTED_STORAGE_PATH"};
  if (!isOperationalStoragePath(path)) return {...base, status:"UNKNOWN_PATH", code:"NON_OPERATIONAL_STORAGE_PATH"};
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      await deleteObject(storageRef(storage, path));
      return {...base, status:"DELETED", code:"OK", attempts:attempt + 1};
    } catch (error) {
      const classified = classifyStorageError(error, "delete");
      if (classified.status === "NOT_FOUND") return {...base, status:"NOT_FOUND", code:String(error.code || "storage/object-not-found"), attempts:attempt + 1};
      if (!classified.retry || attempt >= maxRetries) {
        return {
          ...base,
          status:classified.status,
          code:String(error.code || "storage/unknown"),
          message:String(error.message || error),
          attempts:attempt + 1,
          uid:admin?.uid || "",
          role:admin?.sessionRole || (admin?.claimAdmin ? "admin-claim" : "admin"),
          claimKeys:Object.keys(admin?.claims || {}).filter(key => ["admin", "role", "rol", "tipo"].includes(key))
        };
      }
      attempt += 1;
    }
  }
  return {...base, status:"FAILED", code:"STORAGE_DELETE_FAILED"};
}

function updateStorageStats(result) {
  if (result.status === "DELETED") state.storageStats.deleted += 1;
  else if (result.status === "NOT_FOUND") state.storageStats.notFound += 1;
  else if (result.status === "DELETE_PERMISSION_DENIED") state.storageStats.deleteDenied += 1;
  else if (result.status === "PROTECTED") state.storageStats.protected += 1;
  else if (result.status === "UNKNOWN_PATH") state.storageStats.unknown += 1;
  else if (result.status === "FAILED") state.storageStats.failed += 1;
}

async function persistStorageResults(resetId, results) {
  for (let index = 0; index < results.length; index += BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const result of results.slice(index, index + BATCH_SIZE)) {
      if (!result.path) continue;
      const id = manifestItemId(resetId, result.path);
      batch.set(doc(db, "app_reset_storage_manifest_items", id), {
        resetId,
        manifestItemId:id,
        storagePath:result.path,
        fullPath:result.path,
        module:result.module || rootForPath(result.path),
        ownerUid:result.ownerUid || "",
        operational:isOperationalStoragePath(result.path),
        protected:isProtectedStoragePath(result.path),
        status:result.status,
        code:result.code || "",
        message:result.message || "",
        operation:result.operation || "delete",
        attempts:Number(result.attempts || 0),
        updatedAt:serverTimestamp(),
        deletedAt:result.status === "DELETED" || result.status === "NOT_FOUND" ? serverTimestamp() : null,
        schemaVersion:VERSION
      }, {merge:true});
    }
    await batch.commit();
  }
}

async function deleteManifestFiles(map, admin, resetId) {
  const queue = [...map.values()].filter(item => item.status !== "SKIPPED_NEWER");
  let cursor = 0;
  const results = [];
  const worker = async () => {
    while (cursor < queue.length) {
      const index = cursor++;
      const item = queue[index];
      const result = await deleteOperationalStorageObject(item, {admin, maxRetries:1});
      results.push(result);
      updateStorageStats(result);
      setProgress(`Storage: ${result.status}`, index + 1, Math.max(queue.length, 1));
    }
  };
  await Promise.all(Array.from({length:Math.min(STORAGE_WORKERS, Math.max(queue.length, 1))}, worker));
  state.storageResults.push(...results);
  await persistStorageResults(resetId, results);
  return results;
}

async function deleteCollectionPaged(name) {
  if (MASTER_COLLECTIONS.has(name)) throw resetError("DELETE_OPERATIONAL_FIRESTORE", "PROTECTED_COLLECTION", `La colección ${name} está protegida.`);
  let deleted = 0;
  await pageCollection(name, async docs => {
    const batch = writeBatch(db);
    docs.forEach(snapshot => batch.delete(snapshot.ref));
    await batch.commit();
    deleted += docs.length;
  });
  state.deletedByCollection[name] = deleted;
  return deleted;
}

async function cleanDriverFields() {
  const snapshot = await getDocs(query(collection(db, "choferes"), limit(1000)));
  state.profilesReviewed = snapshot.size;
  let modified = 0;
  for (let index = 0; index < snapshot.docs.length; index += BATCH_SIZE) {
    const batch = writeBatch(db);
    let batchUpdates = 0;
    for (const documentSnapshot of snapshot.docs.slice(index, index + BATCH_SIZE)) {
      const data = documentSnapshot.data() || {};
      if (ADMIN_ROLES.has(role(data.role || data.rol || data.tipoUsuario))) continue;
      const patch = {};
      for (const field of DRIVER_OPERATIONAL_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(data, field)) patch[field] = deleteField();
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = serverTimestamp();
        batch.update(documentSnapshot.ref, patch);
        batchUpdates += 1;
        modified += 1;
      }
    }
    if (batchUpdates) await batch.commit();
  }
  state.profilesModified = modified;
  return {reviewed:state.profilesReviewed, modified};
}

function clearCaches() {
  let count = 0;
  const shouldDelete = key => /weekly|ranking|performance|derivation|closure|receipt|billing|gasto|deuda|prestamo|snapshot|simulation|novedad|operational|cycle/i.test(key) && !/theme|appearance|login|auth|profile|vehicle|config/i.test(key);
  for (const store of [localStorage, sessionStorage]) {
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const key = store.key(index);
      if (key && shouldDelete(key)) { store.removeItem(key); count += 1; }
    }
  }
  for (const key of ["weeklySnapshotCache", "rankingCache", "performanceCache", "derivationCache", "closureCache", "receiptCache"]) {
    try {
      const value = window[key];
      if (value?.clear) { value.clear(); count += 1; }
      else if (value !== undefined) { window[key] = value instanceof Map ? new Map() : null; count += 1; }
    } catch (_) {}
  }
  state.cacheEntries = count;
  return count;
}

async function verifyMasterData() {
  const [drivers, vehicles] = await Promise.all([
    getCountFromServer(collection(db, "choferes")),
    getCountFromServer(collection(db, "vehiculos"))
  ]);
  return {drivers:drivers.data().count, vehicles:vehicles.data().count};
}

function storageCleanupComplete() {
  return state.storageStats.listDenied === 0 && state.storageStats.deleteDenied === 0 && state.storageStats.failed === 0 && state.storageStats.unknown === 0;
}

function storageSummaryMessage() {
  if (storageCleanupComplete()) return "Limpieza Storage: COMPLETADA";
  return "Limpieza Storage: NO COMPLETADA";
}

function appendStorageFailures() {
  for (const result of state.storageResults) {
    if (["DELETE_PERMISSION_DENIED", "FAILED", "UNKNOWN_PATH"].includes(result.status)) {
      state.failures.push({
        stage:"DELETE_OPERATIONAL_STORAGE",
        collection:result.module || rootForPath(result.path),
        path:result.path,
        operation:"delete",
        code:result.status,
        firebaseCode:result.code,
        message:result.message || result.status
      });
    }
  }
}

async function finalizeAudit({admin, master, result, durationMs, mode}) {
  const docsDeleted = Object.values(state.deletedByCollection).reduce((sum, value) => sum + Number(value || 0), 0);
  const auditPayload = {
    resetId:state.targetResetId || state.resetId,
    lastOperationId:state.operationId,
    mode,
    status:result,
    adminUid:admin.uid,
    deletedByCollection:state.deletedByCollection,
    documentsDeleted:docsDeleted,
    storageFilesDeleted:state.storageStats.deleted,
    storageFilesNotFound:state.storageStats.notFound,
    storageListPermissionDenied:state.storageStats.listDenied,
    storageDeletePermissionDenied:state.storageStats.deleteDenied,
    storageProtected:state.storageStats.protected,
    storageUnknownPaths:state.storageStats.unknown,
    storageFailed:state.storageStats.failed,
    storageCleanupComplete:storageCleanupComplete(),
    storageRoots:[...STORAGE_OPERATIONAL_ROOTS],
    profilesReviewed:state.profilesReviewed,
    profilesModified:state.profilesModified,
    masterPreserved:master,
    cacheEntriesCleared:state.cacheEntries,
    failures:[...state.failures, ...state.warnings],
    durationMs,
    schemaVersion:VERSION,
    updatedAt:serverTimestamp()
  };
  await setDoc(doc(db, "app_reset_audit", state.targetResetId || state.resetId), {...auditPayload, createdAt:serverTimestamp()}, {merge:true});
  await setDoc(doc(db, "app_operational_state", "current"), {...auditPayload, completedAt:serverTimestamp()}, {merge:true});
  return auditPayload;
}


async function deleteDerivationRankingTrees() {
  const parents = ["derivation_ranking_public", "ranking_derivaciones_public", "performance_public", "derivation_ranking", "derivation_rankings", "ranking_derivaciones"];
  const childCollections = ["drivers", "events", "stats", "statistics", "summaries", "summary", "positions", "winners", "bonuses", "history", "historical", "cycles"];
  const discovered = new Map();
  const remember = (parent, id) => {
    const clean = String(id || "").trim();
    if (!clean) return;
    if (!discovered.has(parent)) discovered.set(parent, new Set());
    discovered.get(parent).add(clean);
  };
  const active = window.ExploraPerformanceEngine?.getState?.()?.weekScope || window.ExploraWeeklyPeriods?.active?.() || {};
  for (const candidate of [active.id, active.weeklyPeriodId]) {
    for (const parent of parents) remember(parent, candidate);
  }
  for (const parent of parents) {
    try {
      const snap = await getDocs(collection(db, parent));
      snap.forEach(item => {
        const data = item.data() || {};
        remember(parent, item.id);
        for (const value of [data.cycleId, data.cicloId, data.periodId, data.monthlyPeriodId, data.currentCycle, data.previousCycle]) remember(parent, value);
      });
    } catch (error) {
      if (!/permission-denied|not-found/i.test(String(error?.code || error?.message || ""))) throw error;
      state.warnings.push({stage:"DELETE_DERIVATION_RANKING", collection:parent, code:String(error.code || "READ_FAILED"), message:String(error.message || error)});
    }
  }
  let total = 0;
  for (const [parent, ids] of discovered) {
    for (const id of ids) {
      for (const child of childCollections) {
        try {
          const key = `${parent}/${id}/${child}`;
          const before = Number(state.deletedByCollection[key] || 0);
          await deleteCollectionPaged(key);
          const after = Number(state.deletedByCollection[key] || 0);
          total += Math.max(0, after - before);
        } catch (error) {
          if (/permission-denied|not-found/i.test(String(error?.code || error?.message || ""))) {
            state.warnings.push({stage:"DELETE_DERIVATION_RANKING", collection:`${parent}/${id}/${child}`, code:String(error.code || "DELETE_FAILED"), message:String(error.message || error)});
          } else throw error;
        }
      }
    }
  }
  return total;
}

async function runFullReset() {
  state.startedAt = performance.now();
  state.startedAtMs = Date.now();
  state.failures = [];
  state.warnings = [];
  state.deletedByCollection = {};
  state.profilesReviewed = 0;
  state.profilesModified = 0;
  state.manifest = new Map();
  resetStorageStats();
  const admin = await readVerifiedAdmin();
  await acquireLock(admin.uid, {mode:"full-reset"});
  let released = false;
  try {
    document.body.classList.add("explora-operational-reset-running");
    await updateLock({phase:"BUILD_STORAGE_MANIFEST"});
    setProgress("Construyendo manifiesto Storage", 0, 6);
    const manifest = await buildStorageManifest(state.resetId, {cutoffMs:state.startedAtMs, includeFirestore:true});
    await discoverLegacyStorageObjects(manifest, {cutoffMs:state.startedAtMs});
    await persistManifest(state.resetId, manifest, {cutoffMs:state.startedAtMs, source:"firestore+controlled-list"});

    await updateLock({phase:"DELETE_OPERATIONAL_STORAGE", storageManifestCount:manifest.size});
    setProgress("Eliminando Storage por ruta exacta", 1, 6);
    await deleteManifestFiles(manifest, admin, state.resetId);
    appendStorageFailures();

    await updateLock({phase:"DELETE_DERIVATION_RANKING"});
    setProgress("Reiniciando datos y ranking de derivaciones", 2, 7);
    try {
      state.deletedByCollection["derivation-ranking-subcollections"] = await deleteDerivationRankingTrees();
    } catch (error) {
      const wrapped = Object.assign(new Error(error?.message || "No se pudo eliminar completamente el ranking de derivaciones."), {code:"DERIVATION_RANKING_LAUNCH_CLEANUP_FAILED", resetStage:"DELETE_DERIVATION_RANKING", cause:error});
      state.failures.push({stage:"DELETE_DERIVATION_RANKING", collection:"ranking de derivaciones", code:wrapped.code, firebaseCode:String(error?.code || "—"), message:wrapped.message, stack:String(error?.stack || "—")});
    }

    await updateLock({phase:"DELETE_OPERATIONAL_FIRESTORE"});
    setProgress("Eliminando Firestore", 3, 7);
    for (let index = 0; index < OPERATIONAL.length; index += 1) {
      const name = OPERATIONAL[index];
      try { await deleteCollectionPaged(name); }
      catch (error) {
        state.failures.push({stage:"DELETE_OPERATIONAL_FIRESTORE", collection:name, code:String(error.code || "DELETE_FAILED"), message:String(error.message || error)});
      }
      setProgress(`Firestore: ${name}`, index + 1, OPERATIONAL.length);
    }

    await updateLock({phase:"CLEAN_MIXED_DOCUMENT_FIELDS"});
    setProgress("Revisando perfiles", 4, 7);
    try { await cleanDriverFields(); }
    catch (error) {
      state.failures.push({stage:"CLEAN_MIXED_DOCUMENT_FIELDS", collection:"choferes", code:String(error.code || "CLEAN_FAILED"), message:String(error.message || error)});
    }

    await updateLock({phase:"CLEAR_LOCAL_CACHES"});
    setProgress("Limpiando cachés y estado del ranking", 5, 7);
    clearCaches();

    await updateLock({phase:"VERIFY_MASTER_DATA"});
    setProgress("Verificando datos maestros", 6, 7);
    const master = await verifyMasterData();
    const result = state.failures.length || state.warnings.length || !storageCleanupComplete() ? "COMPLETADO CON ADVERTENCIAS" : "COMPLETADO";
    const durationMs = Math.round(performance.now() - state.startedAt);
    await finalizeAudit({admin, master, result, durationMs, mode:"full-reset"});
    await updateLock({inProgress:false, phase:"COMPLETED", completedAt:serverTimestamp(), result, errorCount:state.failures.length + state.warnings.length});
    released = true;
    window.__exploraOperationalResetInProgress = false;
    window.dispatchEvent(new CustomEvent("explora:operational-reset-lock", {detail:{inProgress:false, resetId:state.resetId}}));
    window.dispatchEvent(new CustomEvent("explora:app-reset", {detail:{resetId:state.resetId, result}}));
    window.invalidateWeeklyFinancialEngine?.("operational-reset");
    window.ExploraWeeklyEngine?.refresh?.({force:true, reason:"operational-reset", allowAuthoritativeZero:true});
    window.ExploraPerformanceEngine?.refresh?.({force:true, reason:"operational-reset"});
    window.ExploraAdminShared?.invalidate?.("operational-reset");
    setProgress("Reinicio completado", 7, 7);
    return {result, master, durationMs, mode:"full-reset"};
  } finally {
    document.body.classList.remove("explora-operational-reset-running");
    if (!released) {
      await updateLock({inProgress:false, phase:"FAILED_REANUDABLE", failedAt:serverTimestamp(), result:"REANUDABLE", errorCount:state.failures.length + state.warnings.length || 1});
      window.__exploraOperationalResetInProgress = false;
      window.dispatchEvent(new CustomEvent("explora:operational-reset-lock", {detail:{inProgress:false, resetId:state.operationId, result:"REANUDABLE"}}));
    }
  }
}

function parseResetTimestamp(resetId) {
  const match = String(resetId || "").match(/^reset_(\d{10,})_/);
  return match ? Number(match[1]) : 0;
}

async function runStorageRetry(targetResetId) {
  state.startedAt = performance.now();
  state.startedAtMs = Date.now();
  state.failures = [];
  state.warnings = [];
  state.deletedByCollection = {};
  state.profilesReviewed = 0;
  state.profilesModified = 0;
  state.manifest = new Map();
  resetStorageStats();
  const admin = await readVerifiedAdmin();
  await acquireLock(admin.uid, {mode:"storage-retry", targetResetId});
  let released = false;
  try {
    document.body.classList.add("explora-operational-reset-running");
    const resetCutoff = parseResetTimestamp(targetResetId) || Date.now();
    await updateLock({phase:"LOAD_STORAGE_MANIFEST"});
    setProgress("Recuperando manifiesto del reset", 0, 4);
    const persisted = await loadPersistedManifest(targetResetId);
    const manifest = persisted.size ? persisted : await buildStorageManifest(targetResetId, {cutoffMs:resetCutoff, includeFirestore:true});
    await discoverLegacyStorageObjects(manifest, {cutoffMs:resetCutoff});
    await persistManifest(targetResetId, manifest, {cutoffMs:resetCutoff, source:persisted.size ? "persisted+controlled-list" : "reconstructed+controlled-list", retryOperationId:state.operationId});

    await updateLock({phase:"DELETE_OPERATIONAL_STORAGE_ONLY", storageManifestCount:manifest.size});
    setProgress("Reintentando Storage", 1, 4);
    await deleteManifestFiles(manifest, admin, targetResetId);
    appendStorageFailures();

    setProgress("Verificando maestros sin modificarlos", 2, 4);
    const master = await verifyMasterData();
    const result = storageCleanupComplete() ? "COMPLETADO" : "COMPLETADO CON ADVERTENCIAS";
    const durationMs = Math.round(performance.now() - state.startedAt);
    await finalizeAudit({admin, master, result, durationMs, mode:"storage-retry"});
    await updateLock({inProgress:false, phase:"COMPLETED", completedAt:serverTimestamp(), result, errorCount:state.failures.length + state.warnings.length});
    released = true;
    window.__exploraOperationalResetInProgress = false;
    window.dispatchEvent(new CustomEvent("explora:operational-reset-lock", {detail:{inProgress:false, resetId:state.operationId, targetResetId}}));
    setProgress("Reintento Storage completado", 4, 4);
    return {result, master, durationMs, mode:"storage-retry"};
  } finally {
    document.body.classList.remove("explora-operational-reset-running");
    if (!released) {
      await updateLock({inProgress:false, phase:"STORAGE_RETRY_FAILED", failedAt:serverTimestamp(), result:"REANUDABLE", errorCount:state.failures.length + state.warnings.length || 1});
      window.__exploraOperationalResetInProgress = false;
      window.dispatchEvent(new CustomEvent("explora:operational-reset-lock", {detail:{inProgress:false, resetId:state.operationId, targetResetId, result:"REANUDABLE"}}));
    }
  }
}

function resultText(result) {
  const docs = Object.values(state.deletedByCollection).reduce((sum, value) => sum + Number(value || 0), 0);
  const denied = state.storageStats.listDenied + state.storageStats.deleteDenied;
  const warningRows = [...state.failures, ...state.warnings];
  return `resetId: ${state.targetResetId || state.resetId}\nModo: ${result.mode === "storage-retry" ? "REINTENTO EXCLUSIVO DE STORAGE" : "REINICIO OPERATIVO TOTAL"}\nEstado: ${result.result}\nDocumentos Firestore eliminados: ${docs}\nArchivos Storage eliminados: ${state.storageStats.deleted}\nArchivos Storage ya inexistentes: ${state.storageStats.notFound}\nRutas sin permiso: ${denied}\nPermisos de listado denegados: ${state.storageStats.listDenied}\nPermisos de borrado denegados: ${state.storageStats.deleteDenied}\nRutas protegidas omitidas: ${state.storageStats.protected}\nRutas desconocidas omitidas: ${state.storageStats.unknown}\n${storageSummaryMessage()}\nPerfiles revisados: ${state.profilesReviewed}\nPerfiles modificados: ${state.profilesModified}\nChoferes conservados: ${result.master.drivers}\nVehículos conservados: ${result.master.vehicles}\nCachés eliminadas: ${state.cacheEntries}\nErrores/advertencias: ${warningRows.length}\nDuración: ${result.durationMs} ms${warningRows.length ? `\n\nADVERTENCIAS\n${warningRows.map(item => `${item.stage} · ${item.operation || "—"} · ${item.path || item.collection || "—"} · ${item.code}: ${item.message}`).join("\n")}` : ""}${!storageCleanupComplete() ? "\n\nLos datos Firestore fueron reiniciados, pero la limpieza Storage no quedó completa. Publicá storage-v259.rules y ejecutá REINTENTAR LIMPIEZA DE STORAGE." : ""}`;
}

async function openLaunch() {
  if (state.busy) return;
  const backdrop = $("launchConfirmBackdrop");
  if (!backdrop) return;
  backdrop.classList.add("is-open");
  backdrop.setAttribute("aria-hidden", "false");
  window.lockPageScroll?.("launch-app");
  setConfirmationPhrase(FULL_RESET_PHRASE, "CONFIRMAR REINICIO TOTAL");
  if ($("launchResetProgress")) $("launchResetProgress").hidden = true;
  renderPanel({copy:introMarkup(), message:"Preparando vista previa segura…", showInputs:true, showRetry:false});
  try {
    const preview = await buildPreview();
    const previewNode = $("launchResetPreview");
    if (previewNode) { previewNode.hidden = false; previewNode.textContent = previewText(preview); }
    if ($("launchConfirmMessage")) $("launchConfirmMessage").textContent = "Vista previa cargada. Revisá y confirmá.";
    renderPanel({
      copy:introMarkup(),
      details:previewText(preview),
      message:"Vista previa cargada. Revisá y confirmá.",
      showInputs:true,
      showRetry:Boolean(state.retryCandidate),
      retryLabel:state.retryCandidate ? `REINTENTAR STORAGE · ${state.retryCandidate.resetId}` : "REINTENTAR LIMPIEZA DE STORAGE"
    });
  } catch (error) {
    renderPanel({status:"error", title:"NO SE PUDO PREPARAR EL REINICIO", badge:"ERROR", copy:introMarkup(), message:`${error.code || "PREVIEW_FAILED"} · ${error.message}`, button:"CERRAR", mode:"close", showCancel:false, showInputs:false});
  }
}

function prepareStorageRetry(resetId) {
  if (state.busy) return;
  if (!state.storagePermissionTestPassed) {
    const diagnostic = $("storagePermissionDiagnostic");
    if (diagnostic) diagnostic.hidden = false;
    if ($("launchConfirmMessage")) $("launchConfirmMessage").textContent = "Primero ejecutá PROBAR PERMISOS STORAGE. Las cuatro raíces deben quedar AUTORIZADO o VACÍA.";
    return;
  }
  state.targetResetId = String(resetId || state.retryCandidate?.resetId || LEGACY_RESET_ID);
  setConfirmationPhrase(STORAGE_RETRY_PHRASE, "CONFIRMAR REINTENTO DE STORAGE");
  renderPanel({
    status:"warning",
    title:"REINTENTAR LIMPIEZA DE STORAGE",
    badge:"SÓLO STORAGE",
    copy:storageRetryMarkup(state.targetResetId),
    message:"Este proceso no volverá a borrar Firestore.",
    button:"CONFIRMAR REINTENTO DE STORAGE",
    mode:"retry-storage",
    showCancel:true,
    showInputs:true,
    showRetry:false
  });
}

function closeLaunch() {
  if (state.busy) return;
  $("launchConfirmBackdrop")?.classList.remove("is-open");
  $("launchConfirmBackdrop")?.setAttribute("aria-hidden", "true");
  window.unlockPageScroll?.("launch-app");
}

async function execute() {
  const button = $("launchExecuteBtn");
  const mode = button?.dataset.mode || "execute";
  if (mode === "close") { closeLaunch(); return; }
  if (state.busy || button?.disabled) return;
  state.busy = true;
  if (button) button.disabled = true;
  if ($("launchCancelBtn")) $("launchCancelBtn").hidden = true;
  if ($("launchStorageRetryBtn")) $("launchStorageRetryBtn").hidden = true;
  const retryMode = mode === "retry-storage";
  if (retryMode && !state.storagePermissionTestPassed) {
    state.busy = false;
    if (button) button.disabled = true;
    if ($("launchConfirmMessage")) $("launchConfirmMessage").textContent = "Reintento bloqueado: primero autorizá y probá las cuatro raíces Storage.";
    return;
  }
  renderPanel({
    status:"warning",
    title:retryMode ? "LIMPIEZA STORAGE EN CURSO" : "REINICIO OPERATIVO EN CURSO",
    badge:"PROCESANDO",
    copy:`<p>${retryMode ? "Procesando únicamente archivos operativos pendientes de Firebase Storage." : "Creando el manifiesto y eliminando Storage antes de Firestore."}</p>`,
    message:"Operación protegida por lock global.",
    button:retryMode ? "REINTENTANDO…" : "REINICIANDO…",
    mode,
    showCancel:false,
    showInputs:false
  });
  try {
    const result = retryMode ? await runStorageRetry(state.targetResetId || LEGACY_RESET_ID) : await runFullReset();
    const complete = result.result === "COMPLETADO";
    renderPanel({
      status:complete ? "success" : "warning",
      title:complete ? (retryMode ? "STORAGE LIMPIO" : "REINICIO COMPLETADO") : "COMPLETADO CON ADVERTENCIAS",
      badge:result.result,
      copy:`<p>${complete ? (retryMode ? "La limpieza de Storage finalizó correctamente." : "App lanzada correctamente. Los datos y estadísticas del ranking de derivaciones fueron reiniciados.") : "La operación finalizó, pero todavía requiere revisión."}</p>`,
      details:resultText(result),
      message:storageSummaryMessage(),
      button:"CONTINUAR A EXPLORA",
      mode:"close",
      showCancel:false,
      showInputs:false,
      showRetry:!storageCleanupComplete(),
      retryLabel:`REINTENTAR STORAGE · ${state.targetResetId || state.resetId}`
    });
  } catch (error) {
    const report = `ETAPA: ${error.resetStage || "UNKNOWN"}\nCÓDIGO: ${error.code || "RESET_FAILED"}\nMENSAJE: ${error.message}\nUID: ${auth?.currentUser?.uid || "—"}\nRESET ID: ${state.targetResetId || state.resetId || "—"}\nTIMESTAMP: ${new Date().toISOString()}\nSTACK: ${error.stack || "—"}`;
    renderPanel({status:"error", title:"OPERACIÓN FALLIDA O REANUDABLE", badge:"ERROR", copy:"<p>No se declaró éxito. Los datos maestros permanecen protegidos.</p>", details:report, message:`${error.code || "RESET_FAILED"} · ${error.message}`, button:"CERRAR", mode:"close", showCancel:false, showInputs:false, showRetry:Boolean(state.targetResetId || state.retryCandidate)});
    window.ExploraPerformanceEngine?.showDiagnostic?.(error.resetStage || "OPERATIONAL_RESET", error.code || "RESET_FAILED", error, {eventType:"ERROR", functionName:"ExploraOperationalResetV259", resetId:state.targetResetId || state.resetId, uid:auth?.currentUser?.uid || "—"});
  } finally {
    state.busy = false;
    if (button) button.disabled = false;
    if ($("launchStorageRetryBtn")) $("launchStorageRetryBtn").disabled = false;
  }
}

function blockOperationalWrites(event) {
  if (!window.__exploraOperationalResetInProgress) return;
  const target = event.target?.closest?.('[data-action="registrar-cobro"],[data-action="cargar-gasto"],[data-action="derivar-servicio"],#billingPrimaryBtn,#expenseSubmitBtn,.derivation-primary');
  if (target) {
    event.preventDefault();
    event.stopImmediatePropagation();
    window.showToast?.("EXPLORA está en mantenimiento por reinicio operativo.");
  }
}

document.addEventListener("click", blockOperationalWrites, true);
document.addEventListener("DOMContentLoaded", () => {
  $("launchCancelBtn")?.addEventListener("click", closeLaunch);
  $("launchExecuteBtn")?.addEventListener("click", execute);
  $("launchStorageRetryBtn")?.addEventListener("click", () => prepareStorageRetry(state.retryCandidate?.resetId || state.targetResetId || LEGACY_RESET_ID));
  $("storagePermissionTestBtn")?.addEventListener("click", runStoragePermissionDiagnostic);
  $("storagePermissionCopyBtn")?.addEventListener("click", copyStoragePermissionDiagnostic);
  $("launchConfirmPhrase")?.addEventListener("input", validateConfirm);
  $("launchSecondConfirm")?.addEventListener("change", validateConfirm);
  $("launchConfirmBackdrop")?.addEventListener("click", event => {
    if (event.target?.id === "launchConfirmBackdrop" && !state.busy) closeLaunch();
  });
});

window.ExploraStorageResetV259 = Object.freeze({
  isProtectedStoragePath,
  isOperationalStoragePath,
  normalizeStoragePath,
  deleteOperationalStorageObject,
  buildStorageManifest,
  retryStorageOnly:runStorageRetry,
  testListPermissions:runStoragePermissionDiagnostic,
  getState:() => ({
    resetId:state.resetId,
    operationId:state.operationId,
    targetResetId:state.targetResetId,
    storageStats:{...state.storageStats},
    profilesReviewed:state.profilesReviewed,
    profilesModified:state.profilesModified,
    failures:[...state.failures],
    warnings:[...state.warnings],
    storagePermissionTestPassed:state.storagePermissionTestPassed,
    storagePermissionTest:state.storagePermissionTest
  })
});
window.ExploraStorageResetV258 = window.ExploraStorageResetV259;
window.ExploraAdminTools = {...(window.ExploraAdminTools || {}), openLaunch, closeLaunch, retryStorageCleanup:prepareStorageRetry, testStoragePermissions:runStoragePermissionDiagnostic};
window.ExploraActions = window.ExploraActions || {};
window.ExploraActions["admin-launch"] = openLaunch;
