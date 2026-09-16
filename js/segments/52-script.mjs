import { collection, query, where, limit, onSnapshot, getDocs, getDoc, addDoc, setDoc, doc, updateDoc, deleteDoc, runTransaction, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { normalizeAdminDebtPaymentMethod, previewAdminDebtPayment } from "../core/admin-debt-payment-core.mjs?v=4143-billing-driver-payment";
import {
  applyDriverBillingPayments,
  isDriverBillingSettlementPayment
} from "../core/billing-settlement-payment-core.mjs?v=4143-billing-driver-payment";

(() => {
  "use strict";

  window.EXPLORA_LEGACY_MODULES_DISABLED = window.EXPLORA_LEGACY_MODULES_DISABLED || Object.freeze({
    ranking:true, dailyRanking:true, derivationRanking:true, weeklyClosure:true, weeklyMileage:true
  });

  const VERSION = "explora-pago-home-v52-v4145-activity-receipt-actions";
    const AR_TZ = "America/Argentina/Cordoba";
  const EXPLORA_WHATSAPP = "5493757461564";
  const EXPLORA_WHATSAPP_DISPLAY = "+5493757461564";
  // v4137: WhatsApp operativo queda deshabilitado.
  // Cobros, gastos y cierres se notifican desde Cloud Functions al grupo de Telegram.
  const LEGACY_DIRECT_WHATSAPP_ENABLED = false;
  const EXPLORA_CUIT = "20-40411688-7";
  const EXPLORA_ALIAS = "mp.explora";
  const EXPLORA_ADMIN_UIDS = new Set(["2LziyTTdFcZzSOhK3hLbAKs2U4s2"]);
  const $ = id => document.getElementById(id);
  const PAY_TAB_ORDER = Object.freeze(["chofer", "explora", "gastos", "caja_chica", "pendientes"]);
  const PAY_TAB_LABELS = Object.freeze({ chofer:"Chofer", explora:"Explora", gastos:"Gastos", caja_chica:"Caja chica", pendientes:"Deudas" });
  const PAY_TAB_ALERT_ZERO = Object.freeze({ chofer:0, explora:0, gastos:0, caja_chica:0, pendientes:0 });
  const ADMIN_ACTIVITY_TYPES = Object.freeze([
    ["", "Todos los tipos"],
    ["digital", "Comprobante Explora · digital"],
    ["chofer", "Comprobante chofer"],
    ["gastos", "Gastos"],
    ["caja_chica", "Caja chica"],
    ["pendientes", "Deudas"],
    ["cierres", "Cierres"]
  ]);
  const HISTORY_SCOPES = Object.freeze([
    ["total", "Histórico total"],
    ["monthly", "Histórico mensual"],
    ["weekly", "Histórico semanal"],
    ["daily", "Histórico diario"]
  ]);
  const state = {
    tab:"chofer",
    view:"inicio",
    user:null,
    role:"driver",
    profile:{},
    selectedDriverUid:"",
    selectedDriverName:"",
    adminActivityType:"",
    historyDriverUid:"",
    historyDriverName:"",
    historyScope:"total",
    historyMonthId:"",
    historyLoading:false,
    historyError:"",
    historyData:{ uid:"", records:[], expenses:[], debtPayments:[] },
    db:null,
    auth:null,
    storage:null,
    drivers:[],
    records:[],
    expenses:[],
    closures:[],
    debts:[],
    debtPayments:[],
    extra:[],
    unsubscribers:[],
    latestSummary:null,
    pendingClosure:null,
    modalMode:"request",
    modalKind:"",
    modalClosure:null,
    modalFile:null,
    adminDebtPaymentMethod:"cash",
    debtPaymentBusy:false,
    previousDetailsOpen:{ chofer:false, explora:false, gastos:false, caja_chica:false, pendientes:false },
    tabAlerts:{ chofer:0, explora:0, gastos:0, caja_chica:0, pendientes:0 },
    tabAlertMovements:{},
    tabAlertScope:"",
    tabAlertLoadedAt:0,
    efficiency:{ loadedAt:0, loading:false, error:"" },
    uberWeeks:[],
    uberWeeklyBusy:false,
    uberWeeklyFile:null,
    adminDeleteOpen:false,
    adminDeleteMessage:"",
    adminDeleteBusy:false,
    adminDeleteBusyKey:"",
    adminAmountEditRow:null,
    adminAmountEditKind:"",
    adminAmountEditBusy:false,
    adminFinancialDeleteBusyKey:"",
    busy:false,
    refreshing:false,
    dataLoading:true,
    realtimeGeneration:0,
    realtimeReady:new Set()
  };

  let financialRenderRaf = 0;
  function scheduleFinancialRender() {
    if (financialRenderRaf) return;
    financialRenderRaf = requestAnimationFrame(() => {
      financialRenderRaf = 0;
      render();
    });
  }

  const currency = value => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Number(value) || 0).replace(/\s/g, "");
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const abs = value => Math.abs(number(value));
  const safe = value => String(value ?? "").trim();
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const isAdmin = () => EXPLORA_ADMIN_UIDS.has(String(state.user?.uid || window.ExploraSession?.authUser?.uid || ""));
  const driverRole = data => {
    const raw = safe(data.role || data.rol || data.tipo).toLowerCase();
    if (/admin|owner|superadmin|administrador/.test(raw)) return "admin";
    if (/chofer|driver|conductor/.test(raw)) return "chofer";
    return raw || "chofer";
  };
  const driverIsActive = data => {
    const estado = safe(data.estado || data.status || data.state).toLowerCase();
    const deletionStatus = safe(data.deletionStatus).toLowerCase();
    if (data.activo === false || data.active === false || data.habilitado === false) return false;
    if (data.isDeleted === true || data.deleted === true || data.eliminado === true) return false;
    if (["inactivo","bloqueado","suspendido","deleted","deleting","deletion_failed","borrado","eliminado"].includes(estado)) return false;
    if (["running","completed","failed"].includes(deletionStatus)) return false;
    return true;
  };

  function ms(value) {
    if (!value) return 0;
    if (typeof value?.toMillis === "function") return value.toMillis();
    if (typeof value?.toDate === "function") return value.toDate().getTime();
    if (typeof value === "number") return value > 100000000000 ? value : value * 1000;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof value?.seconds === "number") return value.seconds * 1000 + Math.round((value.nanoseconds || 0) / 1000000);
    return 0;
  }

  function rowMs(row = {}) {
    return Math.max(
      ms(row.createdAt), ms(row.completedAt), ms(row.updatedAt), ms(row.expenseDate), ms(row.fechaISO),
      Number(row.createdAtMs || 0), Number(row.timestampMs || 0), Number(row.completedAtMs || 0)
    );
  }

  function methodOf(row = {}) {
    const raw = safe(row.paymentMethod || row.metodoPago || row.financialCategory || row.receiptPaymentMethod || row.paymentProvider || row.method).toLowerCase();
    if (/cash|efectivo/.test(raw)) return "cash";
    if (/qr/.test(raw)) return "qr";
    if (/card|tarjeta|point/.test(raw)) return "card";
    if (/transfer|alias|transf/.test(raw)) return "transfer";
    return raw || "cash";
  }

  function moneyNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const text = safe(value).replace(/\s/g, "");
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

  function amountOf(row = {}) {
    const fields = [
      "amount", "monto", "valor", "finalPrice", "total", "importe",
      "price", "precio", "precioFinal", "montoFinal", "montoCobrado", "importeTotal",
      "finalAmount", "totalAmount", "billingAmount", "chargedAmount", "paidAmount",
      "fare", "tarifa", "value", "totalCobrado", "facturacion", "billingTotal"
    ];
    for (const field of fields) {
      const raw = row?.[field];
      if (raw === null || raw === undefined || raw === "") continue;
      const parsed = moneyNumber(raw);
      if (parsed > 0) return parsed;
    }
    return 0;
  }

  function expenseTypeLabel(row = {}) {
    const raw = safe(row.expenseType || row.tipo || row.category || row.categoria || "gasto").toLowerCase();
    const map = { combustible:"Combustible", peajes:"Peaje", peaje:"Peaje", estacionamiento:"Estacionamiento", lavado:"Lavado", mantenimiento:"Mantenimiento", compras:"Compras", gasto:"Gasto" };
    return map[raw] || raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function paymentLabel(method) {
    return ({ cash:"Cobro efectivo", transfer:"Cobro transferencia", card:"Cobro tarjeta", qr:"Cobro QR" })[method] || "Cobro";
  }

  function movementIsDeleted(row = {}) {
    const status = safe(row.status || row.estado || row.state || row.deletionStatus).toLowerCase();
    return row.deleted === true || row.isDeleted === true || row.eliminado === true || /deleted|eliminado|borrado|anulado/.test(status);
  }

  function cashboxIsExcluded(row = {}) {
    return row.excludeFromCashbox === true || row.cashboxExcluded === true || row.cajaChicaEliminada === true || row.ignoreCashbox === true || row.noCashbox === true;
  }

  function activeClosureKind(kind = state.tab) {
    const raw = safe(kind).toLowerCase();
    if (/pendiente|deuda|debt|multa|choque|prestamo|pr[eé]stamo|adelanto|loan|advance/.test(raw)) return "pendientes";
    if (/caja|chica|cashbox|bruto/.test(raw)) return "caja_chica";
    if (/gasto|expense/.test(raw)) return "gastos";
    if (/factur|billing|cobro/.test(raw)) return "facturacion";
    if (/explora|digital|transfer|qr|card|tarjeta/.test(raw)) return "explora";
    if (/chofer|driver|efectivo|cash/.test(raw)) return "chofer";
    return "";
  }

  function isBillingClosureKind(kind = state.tab) {
    const target = activeClosureKind(kind);
    return target === "chofer" || target === "explora" || target === "facturacion";
  }

  function mapModuleKey(kind = state.tab) {
    const target = activeClosureKind(kind);
    if (["chofer", "explora", "gastos", "caja_chica", "pendientes", "facturacion"].includes(target)) return target;
    return "";
  }

  function closureKindOf(row = {}) {
    const raw = row.closureKind || row.closureType || row.payTab || row.closeKind || row.kind || row.cierreTipo || row.type || row.category;
    return safe(raw) ? activeClosureKind(raw) : "";
  }

  function closureInvalidationText(row = {}) {
    return [
      row.status, row.estado, row.closureStatus, row.paymentStatus, row.receiptStatus,
      row.statusLabel, row.rejectionReason, row.rollbackStatus, row.closureMode, row.periodType
    ].map(value => safe(value).toLowerCase()).filter(Boolean).join(" | ");
  }

  function closureInvalidatesCutoff(row = {}) {
    const joined = closureInvalidationText(row);
    return row.rejected === true || row.rollbackRestored === true || row.invalidatesCutoff === true || row.cutoffActive === false ||
      /reject|rechaz|cancel|anulad|no aceptado|rejected_on_demand/.test(joined);
  }

  function closureUsesActiveCutoff(row = {}) {
    const mode = safe(row.closureMode || row.periodType).toLowerCase();
    return mode === "on_demand" && !closureInvalidatesCutoff(row);
  }

  function closureIsVisibleOnDemand(row = {}) {
    const mode = safe(row.closureMode || row.periodType).toLowerCase();
    return mode === "on_demand" || (mode === "rejected_on_demand" && closureInvalidatesCutoff(row));
  }

  function billingCashboxOffsetOf(row = {}) {
    return Math.max(0, number(
      row.billingCashboxOffsetApplied ??
      row.cashboxOffsetApplied ??
      row.cajaChicaDescontadaLiquidacion ??
      row.cajaChicaCompensada ??
      0
    ));
  }

  function billingCashboxOffsetsAfter(closures = [], resetCashboxMs = 0) {
    return closures
      .filter(closureUsesActiveCutoff)
      .filter(row => isBillingClosureKind(closureKindOf(row)))
      .filter(row => closureCutMs(row) > number(resetCashboxMs))
      .reduce((sum, row) => sum + billingCashboxOffsetOf(row), 0);
  }

  function billingClosureClosesCashbox(row = {}) {
    const affects = Array.isArray(row.affectsTabs) ? row.affectsTabs.map(activeClosureKind) : [];
    return row.autoClosesCashbox === true || row.cashboxClosedWithBilling === true || row.cashboxAutoClosed === true || affects.includes("caja_chica");
  }

  function lastCashboxResetMs(rows = []) {
    const automaticCuts = (rows || [])
      .filter(closureUsesActiveCutoff)
      .filter(row => isBillingClosureKind(closureKindOf(row)))
      .filter(billingClosureClosesCashbox)
      .map(closureCutMs)
      .filter(Boolean)
      .sort((a,b)=>b-a);
    if (automaticCuts[0]) return automaticCuts[0];
    // Migración segura: hasta el primer cierre de Facturación v4077 se conserva el período
    // de Caja chica que ya estaba abierto en versiones anteriores.
    return lastClosureMs(rows, "caja_chica");
  }

  function billingSettlementWithCashbox({ cash = 0, digital = 0, cashboxEligibleGross = 0, cashboxRate = .05, cashboxAmount = null } = {}) {
    const cashAmount = Math.max(0, number(cash));
    const digitalAmount = Math.max(0, number(digital));
    const eligibleGross = Math.max(0, number(cashboxEligibleGross));
    const rate = Math.max(0, number(cashboxRate));
    const gross = cashAmount + digitalAmount;
    const share = gross * .5;
    const netBeforeCashboxToDriver = share - cashAmount;
    const explicitCashbox = cashboxAmount !== null && cashboxAmount !== undefined;
    const cashboxGenerated = explicitCashbox ? Math.max(0, number(cashboxAmount)) : eligibleGross * rate;
    // v4077: el total pendiente de Caja chica entra completo en “quién paga a quién”,
    // tanto si paga Explora como si paga el chofer. En cierres históricos sin el campo
    // cashboxAmount se conserva la lógica anterior para no reescribir datos ya cerrados.
    const cashboxOffsetApplied = explicitCashbox
      ? cashboxGenerated
      : (netBeforeCashboxToDriver > 0 ? Math.min(netBeforeCashboxToDriver, cashboxGenerated) : 0);
    const netToDriver = netBeforeCashboxToDriver - cashboxOffsetApplied;
    return {
      gross,
      share,
      netBeforeCashboxToDriver,
      cashboxEligibleGross:eligibleGross,
      cashboxGenerated,
      cashboxOffsetApplied,
      cashboxRemainingInDriver:explicitCashbox ? 0 : Math.max(0, cashboxGenerated - cashboxOffsetApplied),
      netToDriver,
      amountToDriver:Math.max(0, netToDriver),
      amountFromDriver:Math.max(0, -netToDriver)
    };
  }

  function normalizeHomeModuleValue(value = "") {
    const raw = safe(value).toLowerCase();
    if (!raw) return "";
    if (/^(pendientes|pendiente|deudas|deuda|debt|debts)$/.test(raw)) return "pendientes";
    if (/^(caja_chica|cajachica|caja chica|cashbox|petty_cash|petty cash|bruto)$/.test(raw)) return "caja_chica";
    if (/^(gastos|gasto|expenses|expense)$/.test(raw)) return "gastos";
    if (/^(explora|digital|admin|david|transfer|transferencia|qr|card|tarjeta)$/.test(raw)) return "explora";
    if (/^(chofer|driver|efectivo|cash)$/.test(raw)) return "chofer";
    return "";
  }

  function firstHomeModuleFromFields(row = {}, fields = []) {
    for (const field of fields) {
      const value = row?.[field];
      if (Array.isArray(value)) {
        const normalized = value.map(normalizeHomeModuleValue).find(Boolean);
        if (normalized) return normalized;
        continue;
      }
      const normalized = normalizeHomeModuleValue(value);
      if (normalized) return normalized;
    }
    return "";
  }

  function closureHomeModuleOf(row = {}) {
    // Este valor es SOLO para el cartel amarillo del Home. No se usa para cálculos.
    // Debe ser estricto: si no sabemos la tarjeta exacta donde nació el pedido,
    // no mostramos cartel en Home para evitar falsos positivos.
    const explicit = firstHomeModuleFromFields(row, [
      "homeModule", "homeTab", "homeCard", "moduleKey", "closureModuleKey",
      "requestModule", "requestedModule", "requestedTab", "requestedFrom",
      "originModule", "originTab", "sourceModule", "sourceTab", "settlementType"
    ]);
    if (explicit) return explicit;

    // Compatibilidad con cierres creados antes de guardar homeModule:
    // si la propia clase del cierre ya era exacta, podemos usarla.
    const exactKind = firstHomeModuleFromFields(row, ["payTab", "closeKind", "kind", "closureKind", "closureType", "cierreTipo"]);
    if (exactKind) return exactKind;

    // Campos genéricos solo se aceptan si dicen literalmente una tarjeta del Home.
    const generic = firstHomeModuleFromFields(row, ["module", "modulo", "source", "origin", "tab", "type", "category"]);
    if (generic) return generic;

    // Si solo aparece "facturacion"/"billing", afecta cálculos de Chofer+Explora,
    // pero NO alcanza para mostrar cartel en ninguna tarjeta específica.
    return "";
  }

  function closureMatchesHomeModule(row = {}, kind = state.tab) {
    const target = activeClosureKind(kind);
    if (!["caja_chica", "gastos", "explora", "chofer"].includes(target)) return false;
    return closureHomeModuleOf(row) === target;
  }

  function closureMatchesIndependentModule(row = {}, kind = state.tab) {
    const target = mapModuleKey(kind);
    if (!target) return false;
    const rowKind = mapModuleKey(closureKindOf(row));
    const homeKind = mapModuleKey(closureHomeModuleOf(row));
    if (target === "caja_chica") return rowKind === "caja_chica" || homeKind === "caja_chica";
    if (target === "gastos") return rowKind === "gastos" || homeKind === "gastos";
    if (target === "pendientes") return rowKind === "pendientes" || homeKind === "pendientes";
    if (isBillingClosureKind(target)) return isBillingClosureKind(rowKind) || isBillingClosureKind(homeKind);
    return rowKind === target || homeKind === target;
  }

  function isClosureTab(kind = state.tab) {
    return ["caja_chica", "gastos", "explora", "chofer", "facturacion"].includes(activeClosureKind(kind));
  }

  function closureLabel(kind = state.tab) {
    return ({ caja_chica:"caja chica", gastos:"gastos", explora:"facturación", chofer:"facturación", facturacion:"facturación" })[activeClosureKind(kind)] || "";
  }

  function closureTitle(kind = state.tab) {
    return ({ caja_chica:"CIERRE DE CAJA CHICA", gastos:"CIERRE DE GASTOS", explora:"CIERRE DE FACTURACIÓN", chofer:"CIERRE DE FACTURACIÓN", facturacion:"CIERRE DE FACTURACIÓN" })[activeClosureKind(kind)] || "CIERRE";
  }

  function expensePayer(row = {}) {
    // En este modo operativo, los gastos abiertos se consideran cargados/pagados por el chofer.
    // Explora no paga gastos por Ualá/cuenta temporalmente; solo reintegra su 50% en el cierre de gastos.
    return "driver";
  }

  function expenseParts(row = {}) {
    const amount = amountOf(row);
    const rateRaw = Number(row.sharedRate ?? row.porcentajeCompartido ?? row.driverShareRate ?? row.porcentajeChofer);
    const rate = Number.isFinite(rateRaw) ? (rateRaw > 1 ? rateRaw / 100 : rateRaw) : .5;
    const driverPart = amount * Math.min(1, Math.max(0, rate || .5));
    const exploraPart = amount - driverPart;
    return { amount, driverPart, exploraPart, payer: expensePayer(row) };
  }


  const DEBT_ACTIVE_STATUSES = new Set(["", "active", "activo", "active_acknowledged", "acknowledged", "confirmado", "pending", "pendiente", "installment", "en_cuotas", "cuotas", "requested", "open", "abierta"]);
  const DEBT_TYPE_LABELS = Object.freeze({ fine:"Multa", crash:"Choque", personal_loan:"Préstamo", advance:"Adelanto", other:"Pendiente" });

  function debtTypeOf(row = {}) {
    const raw = safe(row.type || row.reason || row.reasonLabel || row.tipo || row.category || row.categoria).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (/personal_loan|prestamo|loan/.test(raw)) return "personal_loan";
    if (/advance|adelanto/.test(raw)) return "advance";
    if (/crash|choque|siniestro/.test(raw)) return "crash";
    if (/fine|multa|infraccion/.test(raw)) return "fine";
    return "other";
  }

  function debtTypeLabel(row = {}) {
    const type = debtTypeOf(row);
    return safe(row.reasonLabel || row.tipoLabel || row.typeLabel) || DEBT_TYPE_LABELS[type] || "Pendiente";
  }

  function debtTotalAmount(row = {}) {
    return Math.max(0, moneyNumber(row.totalAmount ?? row.originalAmount ?? row.amount ?? row.montoTotal ?? row.monto ?? row.valor ?? 0));
  }

  function debtPaidAmount(row = {}) {
    return Math.max(0, moneyNumber(row.paidAmount ?? row.amountPaid ?? row.importePagado ?? row.discountedAmount ?? 0));
  }

  function debtRemainingAmount(row = {}) {
    const stored = row.remainingAmount ?? row.saldoPendiente ?? row.remainingBalance ?? row.balance;
    if (stored !== undefined && stored !== null && stored !== "") return Math.max(0, moneyNumber(stored));
    return Math.max(0, debtTotalAmount(row) - debtPaidAmount(row));
  }

  function debtPenaltyAmount(row = {}) {
    return Math.max(0, moneyNumber(row.penaltyAccruedAmount ?? row.interestAccruedAmount ?? row.moraAcumulada ?? row.intereses ?? 0));
  }

  function debtIsActive(row = {}) {
    if (!row || movementIsDeleted(row)) return false;
    const status = safe(row.status || row.debtStatus || row.estado || "").toLowerCase();
    if (/paid|pagad|liquidad|cancel|anulad|closed|cerrad/.test(status)) return false;
    return debtRemainingAmount(row) > 0 && DEBT_ACTIVE_STATUSES.has(status);
  }

  function debtCreatedMs(row = {}) {
    return Math.max(ms(row.createdAt), ms(row.incidentDate), ms(row.fecha), Number(row.createdAtMs || 0), Number(row.incidentAtMs || 0), rowMs(row));
  }

  function debtActivityId(row = {}) {
    return safe(row.id || row.debtId || row.documentId || row.uid || "");
  }

  const PHOTO_DIRECT_FIELDS = Object.freeze([
    "receiptUrl", "comprobanteUrl", "attachmentUrl", "fileUrl", "downloadUrl", "url",
    "photoUrl", "fotoUrl", "imageUrl", "voucherUrl", "proofUrl", "proofImageUrl",
    "receiptDownloadUrl", "comprobanteDownloadUrl", "comprobantePagoUrl", "comprobanteTransferenciaUrl",
    "driverReceiptUrl", "adminReceiptUrl", "davidReceiptUrl"
  ]);
  const PHOTO_OBJECT_FIELDS = Object.freeze(["receipt", "comprobante", "attachment", "file", "photo", "foto", "image", "proof"]);
  const PHOTO_ARRAY_FIELDS = Object.freeze(["attachments", "files", "receipts", "comprobantes", "photos", "fotos", "images", "evidences"]);

  function rowPhotoAttachment(row = {}) {
    if (!row) return null;
    for (const field of PHOTO_DIRECT_FIELDS) {
      const url = safe(row[field]);
      if (url) {
        return {
          url,
          name:safe(row.receiptName || row.fileName || row.attachmentName || row.comprobanteName || row.photoName || row.name || "Comprobante"),
          mime:safe(row.receiptMime || row.mimeType || row.contentType || row.fileType || "")
        };
      }
    }
    for (const field of PHOTO_OBJECT_FIELDS) {
      const item = row[field];
      if (!item || typeof item !== "object") continue;
      const url = safe(item.url || item.receiptUrl || item.downloadUrl || item.fileUrl || item.photoUrl || item.imageUrl || item.comprobanteUrl);
      if (url) {
        return {
          url,
          name:safe(item.name || item.fileName || item.originalName || item.title || row.receiptName || "Comprobante"),
          mime:safe(item.mime || item.mimeType || item.contentType || row.receiptMime || "")
        };
      }
    }
    for (const field of PHOTO_ARRAY_FIELDS) {
      const arr = Array.isArray(row[field]) ? row[field] : [];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const url = safe(item.url || item.receiptUrl || item.downloadUrl || item.fileUrl || item.photoUrl || item.imageUrl || item.comprobanteUrl);
        if (url) {
          return {
            url,
            name:safe(item.name || item.fileName || item.originalName || item.title || row.receiptName || "Comprobante"),
            mime:safe(item.mime || item.mimeType || item.contentType || row.receiptMime || "")
          };
        }
      }
    }
    return null;
  }

  function rowHasAttachment(row = {}) {
    return !!rowPhotoAttachment(row);
  }

  function debtHasAttachment(row = {}) {
    return rowHasAttachment(row);
  }

  function activityPhotoKey(type = "activity", row = {}) {
    const raw = safe(row.id || row.paymentId || row.debtPaymentId || row.debtId || row.closureId || row.documentId || row.uid || row.createdAtMs || row.updatedAtMs || rowMs(row));
    return `${safe(type || "activity")}:${raw || rowMs(row) || Date.now()}`;
  }

  function activityPhotoRegistryRow(activity = {}) {
    const source = activity.source || {};
    return {
      ...source,
      __photoKey:activity.photoKey,
      photoKey:activity.photoKey,
      photoTitle:activity.photoTitle || activity.title || "Comprobante",
      photoMeta:activity.photoMeta || activity.meta || "Comprobante cargado",
      photoAmount:Number.isFinite(Number(activity.photoAmount)) ? Number(activity.photoAmount) : abs(activity.amount || 0),
      activityType:activity.type || "activity"
    };
  }

  function summarizePendingDebts(rows = state.debts) {
    const normalized = (Array.isArray(rows) ? rows : []).filter(debtIsActive).sort((a,b)=>debtCreatedMs(a)-debtCreatedMs(b));
    const totalOriginal = normalized.reduce((sum,row)=>sum + debtTotalAmount(row), 0);
    const totalPaid = normalized.reduce((sum,row)=>sum + debtPaidAmount(row), 0);
    const totalPenalty = normalized.reduce((sum,row)=>sum + debtPenaltyAmount(row), 0);
    const remaining = normalized.reduce((sum,row)=>sum + debtRemainingAmount(row), 0);
    const byType = normalized.reduce((acc,row)=>{ const type = debtTypeOf(row); acc[type] = (acc[type] || 0) + debtRemainingAmount(row); return acc; }, {});
    return { kind:"pendientes", debts:normalized, activeDebts:normalized, records:[], expenses:[], gross:remaining, mainTotal:remaining, totalOriginal, totalPaid, totalPenalty, remainingAmount:remaining, pendingTotal:remaining, byType, amountToDriver:0, amountFromDriver:remaining, netSettlementToDriver:-remaining, summaryLabel:"Deuda independiente" };
  }

  function debtPaymentRows(rows = state.debtPayments) {
    return (Array.isArray(rows) ? rows : []).filter(row => !movementIsDeleted(row)).sort((a,b)=>rowMs(b)-rowMs(a));
  }

  function debtPaymentMethodOf(row = {}) {
    const raw = safe(row.debtReductionMethod || row.paymentMethod || row.method || row.sourceModule || row.type || row.category).toLowerCase();
    if (/expense[_-]?offset|gastos?[_-]?deuda|saldo[_-]?gastos|compensaci[oó]n[_-]?gastos|expense[_-]?credit/.test(raw)) return "expense_offset";
    return "receipt";
  }

  function debtPaymentUsesExpenses(row = {}) {
    return row.expenseOffset === true || row.usedExpenseBalance === true || debtPaymentMethodOf(row) === "expense_offset";
  }

  function debtPaymentTenderOf(row = {}) {
    const raw = safe(row.paymentMethod || row.method || row.paymentChannel).toLowerCase();
    if (/transfer|alias|transf/.test(raw)) return "transfer";
    if (/cash|efectivo/.test(raw)) return "cash";
    return "";
  }

  function debtPaymentTenderLabel(row = {}) {
    const method = debtPaymentTenderOf(row);
    return method === "transfer" ? "Transferencia" : method === "cash" ? "Efectivo" : "Efectivo o transferencia";
  }

  function expenseDebtAdjustmentRows(rows = state.debtPayments, resetMs = 0) {
    const cutoff = Number(resetMs || 0);
    return debtPaymentRows(rows).filter(row => {
      if (!debtPaymentUsesExpenses(row)) return false;
      const paymentPeriodStartMs = Number(row.expensePeriodStartMs || row.gastosPeriodStartMs || 0);
      // Los ajustes nuevos quedan ligados al período exacto de Gastos. El fallback por fecha
      // conserva compatibilidad con movimientos anteriores que no tenían ese identificador.
      return paymentPeriodStartMs > 0 ? paymentPeriodStartMs === cutoff : rowMs(row) > cutoff;
    });
  }

  function expenseDebtAdjustmentTotal(rows = state.debtPayments, resetMs = 0) {
    return expenseDebtAdjustmentRows(rows, resetMs).reduce((sum, row) => sum + Math.max(0, amountOf(row)), 0);
  }

  function activeDebtTotal(rows = state.debts) {
    return Math.max(0, summarizePendingDebts(rows).remainingAmount || 0);
  }

  function pendingDebtOldestRow() {
    return summarizePendingDebts().activeDebts[0] || null;
  }

  function debtPaymentId(driverUid = getOwnDriverUid()) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `debtpay_${safe(driverUid || "driver").replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}_${rand}`;
  }

  function debtReceiptPath({ driverUid = getOwnDriverUid(), paymentId = debtPaymentId(driverUid), file = null } = {}) {
    const ext = extensionForFile(file || { name:"comprobante.jpg", type:"image/jpeg" });
    return `deudas/${safe(driverUid).replace(/[^a-zA-Z0-9_-]/g, "_")}/pagos/${safe(paymentId).replace(/[^a-zA-Z0-9_-]/g, "_")}/comprobante.${ext}`;
  }

  function dateShort(value) {
    const d = new Date(value || Date.now());
    return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit" }).format(d);
  }

  function timeShort(value) {
    const d = new Date(value || Date.now());
    return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, hour:"2-digit", minute:"2-digit", hour12:false }).format(d);
  }

  function dateTimeShort(value) {
    const d = new Date(value || Date.now());
    return `${dateShort(d.getTime())} · ${timeShort(d.getTime())}`;
  }

  function accountName() {
    return safe(state.profile?.nombre || state.profile?.nombreCompleto || state.profile?.displayName || state.user?.displayName || state.user?.email?.split("@")[0] || (isAdmin() ? "DAVID" : "CHOFER")).toUpperCase();
  }

  function displayName() {
    if (isAdmin()) {
      return safe(state.selectedDriverName || "SELECCIONAR CHOFER").toUpperCase();
    }
    return accountName();
  }

  function getOwnDriverUid() {
    return safe(state.profile?.uid || state.profile?.driverUid || state.profile?.choferUid || state.profileDocumentId || state.user?.uid);
  }

  function getDriverUid() {
    return isAdmin() ? safe(state.selectedDriverUid) : getOwnDriverUid();
  }

  function notificationDriverUid() {
    // La campana del administrador debe ser global: un cierre/comprobante nuevo
    // tiene que avisarse aunque David esté viendo actualmente a otro chofer.
    // Al abrir la notificación, openClosureFromNotification selecciona el chofer correcto.
    if (isAdmin()) return "";
    return getOwnDriverUid();
  }

  function closureDriverUids(row = {}) {
    return [
      row.driverUid, row.choferUid, row.uid, row.ownerUid,
      row.driverId, row.choferId, row.driver_id, row.chofer_id,
      row.userUid, row.userId, row.createdByUid, row.createdBy, row.ownerId,
      row.conductorUid, row.conductorId, row.assignedDriverUid
    ].map(safe).filter(Boolean);
  }

  function tabAlertScopeUid() {
    return safe(notificationDriverUid() || getDriverUid() || getOwnDriverUid() || state.user?.uid || "anon");
  }

  function tabAlertStorageKey(uid = tabAlertScopeUid()) {
    return `explora:pay-home:card-alerts:v4017:${uid || "anon"}`;
  }

  function normalizeTabAlertCounts(counts = {}) {
    return PAY_TAB_ORDER.reduce((acc, tab) => {
      acc[tab] = Math.max(0, Math.min(99, Math.trunc(number(counts?.[tab]))));
      return acc;
    }, { ...PAY_TAB_ALERT_ZERO });
  }

  function resetTabAlertScope() {
    state.tabAlertScope = "";
    state.tabAlertLoadedAt = 0;
    state.tabAlertMovements = {};
    state.tabAlerts = { ...PAY_TAB_ALERT_ZERO };
  }

  function ensureTabAlertState() {
    const uid = tabAlertScopeUid();
    if (state.tabAlertScope === uid) return;
    state.tabAlertScope = uid;
    state.tabAlertLoadedAt = Date.now();
    state.tabAlerts = { ...PAY_TAB_ALERT_ZERO };
    state.tabAlertMovements = {};
    try {
      const raw = localStorage.getItem(tabAlertStorageKey(uid));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      state.tabAlerts = normalizeTabAlertCounts(parsed?.counts || {});
      state.tabAlertMovements = parsed?.movements && typeof parsed.movements === "object" ? parsed.movements : {};
    } catch (_) {
      state.tabAlerts = { ...PAY_TAB_ALERT_ZERO };
      state.tabAlertMovements = {};
    }
  }

  function persistTabAlertState() {
    ensureTabAlertState();
    try {
      const entries = Object.entries(state.tabAlertMovements || {})
        .sort((a, b) => number(b[1]?.ms) - number(a[1]?.ms))
        .slice(0, 900);
      state.tabAlertMovements = Object.fromEntries(entries);
      localStorage.setItem(tabAlertStorageKey(), JSON.stringify({
        counts:normalizeTabAlertCounts(state.tabAlerts),
        movements:state.tabAlertMovements,
        updatedAt:Date.now()
      }));
    } catch (_) {}
  }

  function tabAlertRowKey(collectionName = "", row = {}) {
    const id = safe(row.id || row.recordId || row.billingRecordId || row.expenseId || row.gastoId || row.operationId || row.uid);
    if (id) return `${collectionName}:${id}`;
    return `${collectionName}:${rowMs(row)}:${amountOf(row)}:${methodOf(row)}:${safe(row.createdByUid || row.driverUid || row.choferUid)}`;
  }

  function tabAlertSignature(collectionName = "", row = {}) {
    if (collectionName === "gastos") {
      return [amountOf(row), expenseTypeLabel(row), rowMs(row), safe(row.updatedAtMs || row.estado || row.status || row.notes || row.descripcion)].join("|");
    }
    const method = methodOf(row);
    return [amountOf(row), method, rowMs(row), safe(row.updatedAtMs || row.estado || row.status || row.paymentProvider || row.metodoPago)].join("|");
  }

  function tabAlertTargetsForMovement(collectionName = "", row = {}) {
    if (collectionName === "gastos") return ["gastos"];
    if (collectionName === "deudas_choferes" || collectionName === "deuda_pagos") return ["pendientes"];
    if (collectionName !== "billing_records") return [];
    if (isDriverBillingSettlementPayment(row)) return ["chofer", "explora"];
    const method = methodOf(row);
    if (method === "cash") return ["chofer", "caja_chica"];
    return ["explora"];
  }

  function registerTabAlertMovements(collectionName = "", rows = []) {
    if (!collectionName || !Array.isArray(rows)) return;
    ensureTabAlertState();
    const currentUid = tabAlertScopeUid();
    if (!currentUid || currentUid === "anon") return;
    const hadStoredHistory = Object.keys(state.tabAlertMovements || {}).length > 0;
    const freshBootWindow = !hadStoredHistory && Date.now() - number(state.tabAlertLoadedAt) < 3500;
    let changed = false;
    for (const row of rows) {
      const tabs = tabAlertTargetsForMovement(collectionName, row);
      if (!tabs.length) continue;
      const key = tabAlertRowKey(collectionName, row);
      const sig = tabAlertSignature(collectionName, row);
      const previous = state.tabAlertMovements[key];
      const previousSig = safe(previous?.sig);
      const isNewOrChanged = !previous || previousSig !== sig;
      const shouldNotify = isNewOrChanged && !freshBootWindow;
      if (shouldNotify) {
        const targetTabs = Array.from(new Set([...(Array.isArray(previous?.tabs) ? previous.tabs : []), ...tabs])).filter(tab => PAY_TAB_ORDER.includes(tab));
        for (const tab of targetTabs) state.tabAlerts[tab] = Math.min(99, number(state.tabAlerts[tab]) + 1);
      }
      if (isNewOrChanged || !previous) {
        state.tabAlertMovements[key] = { sig, tabs, ms:rowMs(row) || Date.now(), collection:collectionName };
        changed = true;
      }
    }
    if (changed) persistTabAlertState();
  }

  function markTabAlertSeen(tab = state.tab) {
    const key = activeClosureKind(tab) || tab;
    if (!PAY_TAB_ORDER.includes(key)) return;
    ensureTabAlertState();
    if (!number(state.tabAlerts[key])) return;
    state.tabAlerts[key] = 0;
    persistTabAlertState();
  }

  function renderTabAlerts() {
    ensureTabAlertState();
    const debtAlarmActive = activeDebtTotal() > 0.49;
    document.querySelectorAll("[data-pay-tab]").forEach(button => {
      const tab = activeClosureKind(button.dataset.payTab) || button.dataset.payTab;
      let badge = button.querySelector(".pay-tab-alert-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "pay-tab-alert-badge";
        button.appendChild(badge);
      }
      const count = Math.max(0, Math.trunc(number(state.tabAlerts?.[tab])));
      const persistentDebtAlarm = tab === "pendientes" && debtAlarmActive;
      badge.hidden = !persistentDebtAlarm && count < 1;
      badge.textContent = persistentDebtAlarm ? "🚨" : `🛎️ ${count > 99 ? "99+" : count}`;
      badge.classList.toggle("is-debt-alarm", persistentDebtAlarm);
      button.classList.toggle("has-pay-alert", persistentDebtAlarm || count > 0);
      button.classList.toggle("has-persistent-debt-alarm", persistentDebtAlarm);
    });
  }

  function closureBelongsToDriver(row = {}, uid = "") {
    const targetUid = safe(uid);
    if (!targetUid) return false;
    return closureDriverUids(row).includes(targetUid);
  }

  function closureDriverName(row = {}) {
    return safe(
      row.driverName ||
      row.choferNombre ||
      row.nombreChofer ||
      row.selectedDriverName ||
      state.selectedDriverName ||
      "Chofer"
    );
  }

  function closureRequesterText(row = {}) {
    const requestedByRole = safe(row.requestedByRole || row.solicitadoPorRol || row.requestedRole).toLowerCase();
    if (requestedByRole === "driver" || requestedByRole === "chofer") return `${closureDriverName(row)} pidió el cierre`;
    if (requestedByRole === "admin" || requestedByRole === "explora") return "Explora pidió el cierre";
    return "Cierre solicitado";
  }

  function hasAdminDriverSelected() {
    return !isAdmin() || !!getDriverUid();
  }

  function clearListeners() {
    for (const unsub of state.unsubscribers.splice(0)) {
      try { unsub?.(); } catch (_) {}
    }
  }

  const REALTIME_COLLECTIONS = Object.freeze([
    "billing_records", "gastos", "cierres_semanales", "deudas_choferes", "uber_weekly_closures", "deuda_pagos"
  ]);

  function beginFinancialDataLoading({ clearValues = true } = {}) {
    state.dataLoading = true;
    state.realtimeGeneration += 1;
    state.realtimeReady = new Set();
    if (clearValues) {
      state.records = [];
      state.expenses = [];
      state.closures = [];
      state.debts = [];
      state.debtPayments = [];
      state.uberWeeks = [];
      state.latestSummary = null;
      state.pendingClosure = null;
    }
    render();
    return state.realtimeGeneration;
  }

  function markFinancialCollectionReady(collectionName, generation) {
    if (generation !== state.realtimeGeneration) return;
    state.realtimeReady.add(collectionName);
    if (REALTIME_COLLECTIONS.every(name => state.realtimeReady.has(name))) {
      state.dataLoading = false;
      render();
      try {
        window.dispatchEvent(new CustomEvent("explora:pago-home-ready", { detail:{ uid:state.user?.uid || "", generation } }));
      } catch (_) {}
    }
  }

  async function waitUntilFinancialReady({ uid = "", timeout = 15000 } = {}) {
    const targetUid = safe(uid || state.user?.uid || state.auth?.currentUser?.uid);
    const started = Date.now();
    while (Date.now() - started < Math.max(1000, Number(timeout || 15000))) {
      const activeUid = safe(state.user?.uid || state.auth?.currentUser?.uid);
      if (targetUid && activeUid && targetUid !== activeUid) throw new Error("PAGO_HOME_SESSION_REPLACED");
      if (activeUid && !state.dataLoading && REALTIME_COLLECTIONS.every(name => state.realtimeReady.has(name))) return true;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error("PAGO_HOME_READY_TIMEOUT");
  }

  async function waitFirebase(timeout = 14000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const fb = window.ExploraFirebase || {};
      if (fb.db && fb.auth) {
        state.db = fb.db; state.auth = fb.auth; state.storage = fb.storage || null;
        return fb;
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error("Firebase no está disponible para Explora Pago Home.");
  }

  function purgeLegacyClosureKmUi() {
    try {
      document.querySelectorAll("#payClosureKmField,.pay-closure-km-field,#payClosureKmInput,#payClosureKmHint").forEach(node => node.remove());
    } catch (_) {}
  }

  function installShell() {
    // Hard-off: aunque haya quedado DOM de una versión anterior, KM no forma parte del cierre.
    purgeLegacyClosureKmUi();
    if ($("exploraPagoDashboard")) return;
    const shell = document.querySelector(".dashboard-shell-real");
    if (!shell) return;
    const html = `
      <section aria-label="Inicio financiero Explora" class="explora-pay-home" id="exploraPagoDashboard">
        <header class="pay-topbar">
          <div class="pay-hello">
            <span class="pay-avatar" id="payAvatar"><svg viewBox="0 0 24 24"><path d="M7.5 12.5 10 15l6.5-6.5"></path><path d="M3.5 12c2.4-4.4 5.6-4.4 8 0 2.4 4.4 5.6 4.4 9 0"></path></svg></span>
            <strong class="pay-title" id="payGreeting">Hola, CHOFER</strong>
          </div>
          <div class="pay-icons">
            <button class="pay-icon-btn" id="paySearchBtn" type="button" aria-label="Buscar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg></button>
            <button class="pay-icon-btn pay-bell-btn" id="payBellBtn" type="button" aria-label="Notificaciones de cierres">
              <svg class="pay-bell-icon" viewBox="0 0 24 24"><path d="M18 9a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg>
              <svg class="pay-debt-alarm-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 15v-4a5 5 0 0 1 10 0v4"></path><path d="M5 18h14"></path><path d="M9 18v2h6v-2"></path><path d="M12 3V1"></path><path d="M4.9 5.2 3.5 3.8"></path><path d="m19.1 5.2 1.4-1.4"></path></svg>
              <span class="pay-bell-badge" id="payBellBadge" hidden>0</span>
            </button>
          </div>
        </header>
        <nav class="pay-tabs" aria-label="Resumen de caja Explora" role="tablist">
          <button class="pay-tab is-active" data-pay-tab="chofer" type="button" role="tab" aria-selected="true"><span class="pay-tab-label">Chofer</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
          <button class="pay-tab" data-pay-tab="explora" type="button" role="tab" aria-selected="false"><span class="pay-tab-label">Explora</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
          <button class="pay-tab" data-pay-tab="gastos" type="button" role="tab" aria-selected="false"><span class="pay-tab-label">Gastos</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
          <button class="pay-tab" data-pay-tab="caja_chica" type="button" role="tab" aria-selected="false"><span class="pay-tab-label">Caja chica</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
          <button class="pay-tab" data-pay-tab="pendientes" type="button" role="tab" aria-selected="false"><span class="pay-tab-label">Deudas</span><span class="pay-tab-alert-badge" hidden>🛎️ 0</span></button>
        </nav>
        <section class="pay-admin-driver-picker pay-admin-activity-filters" id="payAdminDriverPicker" hidden>
          <div class="pay-admin-filter-field">
            <label for="payAdminDriverSelect">Filtrar por chofer</label>
            <select id="payAdminDriverSelect"><option value="">Todos los choferes</option></select>
          </div>
          <div class="pay-admin-filter-field">
            <label for="payAdminTypeSelect">Filtrar por tipo</label>
            <select id="payAdminTypeSelect"><option value="">Todos los tipos</option></select>
          </div>
          <small id="payAdminDriverHint">Vista admin: últimas actividades de todos los choferes en tiempo real.</small>
        </section>
        <section class="pay-main-card" aria-live="polite">
          <div class="pay-main-row">
            <div class="pay-amount-wrap">
              <div class="pay-amount-line"><strong class="pay-amount" id="payMainAmount">—</strong></div>
              <span class="pay-subtitle" id="payMainSubtitle">Cargando caja operativa…</span>
            </div>
          </div>
          <div class="pay-actions">
            <button class="pay-action" data-pay-run="nuevo-servicio" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg><span>Registrar<br/>cobro</span></button>
            <button class="pay-action" data-pay-run="cargar-gastos" type="button"><svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg><span>Cargar<br/>gasto</span></button>
            <button class="pay-action" id="payClosureActionBtn" type="button" hidden disabled><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 14h6M9 17h4"></path></svg><span>Pedir<br/>cierre</span></button>
          </div>
          <div class="pay-debt-alias-hint" id="payDebtAliasHint" hidden>
            <span class="pay-debt-alias-copy">Pagá a Explora en efectivo o enviá dinero por alias para reducir tu deuda.</span>
            <button class="pay-debt-alias-btn" id="payDebtAliasCopyBtn" type="button" data-copy-alias="${esc(EXPLORA_ALIAS)}" aria-label="Copiar alias de Explora">
              <span>Alias</span><strong>${esc(EXPLORA_ALIAS)}</strong><em>Copiar</em>
            </button>
          </div>
          <div class="pay-liquid-pill"><span id="payPillLabel" class="closure-liquidation-label">Dinero a liquidar</span><strong id="payPillAmount">—</strong></div>
          <div class="pay-expense-debt-reconciliation" id="payExpenseDebtReconciliation" hidden></div>
          <div class="pay-extra-lines" id="payExtraLines"></div>
          <div class="pay-status-pill" id="payClosureStatus" hidden><span><b>—</b><br><small id="payClosureStatusText">—</small></span><button id="payClosureStatusBtn" type="button">Ver</button></div>
        </section>
        <section class="pay-section" aria-labelledby="payActivityTitle">
          <div class="pay-section-head"><h2 id="payActivityTitle">Última actividad</h2><button id="payRefreshBtn" type="button">Actualizar →</button></div>
          <div class="pay-activity-list" id="payActivityList"><div class="pay-activity-empty">Cargando movimientos…</div></div>
        </section>
      </section>
      <section class="explora-pay-more" id="payMoreScreen" hidden aria-label="Más opciones Explora">
        <header class="pay-more-head">
          <button class="pay-more-back" id="payMoreBack" type="button" aria-label="Volver al inicio"><svg viewBox="0 0 24 24"><path d="M15 6 9 12l6 6"></path></svg></button>
          <div class="pay-more-title-wrap">
            <span class="pay-more-kicker">EXPLORA</span>
            <h1>Más</h1>
            <p id="payMoreSubtitle">Accesos rápidos y configuración de la cuenta.</p>
          </div>
        </header>
        <section class="pay-more-profile">
          <span class="pay-more-avatar" id="payMoreAvatar"><svg viewBox="0 0 24 24"><path d="M7.5 12.5 10 15l6.5-6.5"></path><path d="M3.5 12c2.4-4.4 5.6-4.4 8 0 2.4 4.4 5.6 4.4 9 0"></path></svg></span>
          <div>
            <strong id="payMoreName">CHOFER</strong>
            <small id="payMoreRole">Cuenta Explora</small>
          </div>
        </section>
        <section class="pay-more-card" id="payMoreList" aria-label="Accesos de Más"></section>
        <section class="pay-more-card pay-more-admin" id="payMoreAdminList" aria-label="Accesos administrativos" hidden></section>
        <div class="pay-more-spacer"></div>
        <section class="pay-more-logout-zone">
          <button class="pay-more-logout" id="payMoreLogoutBtn" type="button">
            <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path></svg>
            <span>Salir</span>
          </button>
        </section>
      </section>
      <section class="explora-pay-notifications" id="payNotificationsScreen" hidden aria-label="Notificaciones Explora">
        <header class="pay-notification-head">
          <button class="pay-notification-back" id="payNotificationsBack" type="button" aria-label="Volver al inicio"><svg viewBox="0 0 24 24"><path d="M15 6 9 12l6 6"></path></svg></button>
          <button class="pay-notification-settings" id="payNotificationsSettings" type="button" aria-label="Configuración"><svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"></path><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.76l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.97 1.47V21a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-1.03-1.47 1.6 1.6 0 0 0-1.76.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-.97H3a2 2 0 1 1 0-4h.09A1.6 1.6 0 0 0 4.56 9a1.6 1.6 0 0 0-.32-1.76l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 8.83 4.7 1.6 1.6 0 0 0 9.8 3.23V3a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.76-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9c.63.23 1.05.83 1.05 1.5V12c0 .67-.42 1.27-1.05 1.5Z"></path></svg></button>
        </header>
        <h1 class="pay-notification-title">Notificaciones</h1>
        <div class="pay-notification-list" id="payNotificationList">
          <div class="pay-notification-empty">No tenés cierres abiertos.</div>
        </div>
      </section>
      <section class="explora-pay-admin-closures" id="payAdminClosuresScreen" hidden aria-label="Cierres admin por chofer">
        <header class="pay-admin-closures-head">
          <button class="pay-admin-closures-back" id="payAdminClosuresBack" type="button" aria-label="Volver al inicio"><svg viewBox="0 0 24 24"><path d="M15 6 9 12l6 6"></path></svg></button>
          <div>
            <span>ADMIN</span>
            <h1>Cierre contable</h1>
            <p>Vista por chofer, con tarjetas contables compactas.</p>
          </div>
        </header>
        <div class="pay-admin-closures-legend">
          <strong>Liquidaciones activas</strong>
          <small>Chofer, Explora, gastos, caja chica y deudas en una vista contable simple.</small>
        </div>
        <div class="pay-admin-closures-list" id="payAdminClosuresList">
          <div class="pay-admin-closures-empty">Cargando choferes…</div>
        </div>
      </section>
      <section class="explora-pay-history" id="payHistoryScreen" hidden aria-label="Histórico Explora por chofer">
        <header class="pay-history-head">
          <button class="pay-history-back" id="payHistoryBack" type="button" aria-label="Volver al inicio"><svg viewBox="0 0 24 24"><path d="M15 6 9 12l6 6"></path></svg></button>
          <div>
            <span>HISTÓRICO</span>
            <h1>Histórico Explora</h1>
            <p>Ganancia real de Explora por chofer y período, sin depender de cierres.</p>
          </div>
        </header>
        <section class="pay-history-controls">
          <label for="payHistoryDriverSelect"><span>Chofer</span><select id="payHistoryDriverSelect"><option value="">Cargando choferes…</option></select></label>
          <label for="payHistoryScopeSelect"><span>Vista</span><select id="payHistoryScopeSelect"><option value="total">Histórico total</option><option value="monthly">Histórico mensual</option><option value="weekly">Histórico semanal</option><option value="daily">Histórico diario</option></select></label>
          <label class="pay-history-month-field" for="payHistoryMonthSelect" id="payHistoryMonthField" hidden><span>Mes</span><select id="payHistoryMonthSelect"><option value="">Mes actual</option></select></label>
        </section>
        <div class="pay-history-content" id="payHistoryContent"><div class="pay-history-empty">Seleccioná un chofer para ver el histórico.</div></div>
      </section>
      <button class="pay-floating-spark pay-efficiency-btn pay-uber-weekly-btn" id="payEfficiencyBtn" type="button" aria-label="Cierre Uber semanal"><span class="pay-uber-weekly-icon" aria-hidden="true">U</span><span class="pay-uber-weekly-countdown" id="payUberWeeklyCountdown">Cierre Uber</span></button>
      <nav class="pay-bottom-nav" id="payBottomNav" aria-label="Navegación principal Explora">
        <button class="pay-nav-btn is-active" data-pay-nav="inicio" type="button"><svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"></path><path d="M5 10v10h14V10"></path></svg><span>Inicio</span></button>
        <button class="pay-nav-btn" data-pay-nav="actividad" type="button"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"></path></svg><span>Actividad</span></button>
        <button class="pay-nav-btn pay-nav-main" data-pay-run="nuevo-servicio" type="button" aria-label="Cobrar"><span class="pay-nav-plus-icon" aria-hidden="true">+</span><svg class="pay-nav-finance-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 13h6M9 16h3"></path><path d="M16.5 15.5 18 17l3-3"></path></svg><span>Cobrar</span></button>
        <button class="pay-nav-btn" id="payNavClosure" type="button"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 14h6M9 17h4"></path></svg><span>Cierre</span></button>
        <button class="pay-nav-btn" data-pay-nav="mas" type="button"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"></path><path d="M18 17h2M19 16v2"></path></svg><span>Más</span></button>
      </nav>
      <div class="pay-admin-delete-backdrop" id="payAdminDeleteBackdrop" aria-hidden="true">
        <section class="pay-admin-delete-modal" role="dialog" aria-modal="true" aria-labelledby="payAdminDeleteTitle">
          <header>
            <div><h2 id="payAdminDeleteTitle">Borrar movimientos</h2><p>Cobros, caja chica y gastos. El cierre se ajusta automáticamente.</p></div>
            <button class="pay-admin-delete-close" id="payAdminDeleteClose" type="button" aria-label="Cerrar">×</button>
          </header>
          <div class="pay-admin-delete-warning">Acción solo para administrador. Se modifica Firestore y se recalculan los cierres relacionados.</div>
          <div class="pay-admin-delete-message" id="payAdminDeleteMessage" role="status"></div>
          <div class="pay-admin-delete-list" id="payAdminDeleteList"></div>
          <div class="pay-admin-delete-actions"><button id="payAdminDeleteCancel" type="button">Volver</button></div>
        </section>
      </div>
      <div class="pay-efficiency-backdrop" id="payEfficiencyBackdrop" aria-hidden="true">
        <section class="pay-efficiency-modal" role="dialog" aria-modal="true" aria-labelledby="payEfficiencyTitle">
          <header><div><h2 id="payEfficiencyTitle">Cierre Uber semanal</h2><p>Declaración semanal de ganancias Uber.</p></div><button class="pay-efficiency-close" id="payEfficiencyClose" type="button" aria-label="Cerrar">×</button></header>
          <div class="pay-efficiency-body" id="payEfficiencyBody"><div class="pay-efficiency-loading">Cargando Uber…</div></div>
        </section>
      </div>
      <div class="pay-closure-backdrop" id="payClosureBackdrop" aria-hidden="true">
        <section class="pay-closure-modal" role="dialog" aria-modal="true" aria-labelledby="payClosureTitle">
          <header><div><h2 id="payClosureTitle">Cierre a demanda</h2><p id="payClosureSubtitle">Pedí o confirmá un cierre cuando sea necesario.</p></div><button class="pay-closure-close" id="payClosureClose" type="button" aria-label="Cerrar">×</button></header>
          <div class="pay-closure-field" id="payClosureDriverField" hidden><label for="payClosureDriverSelect">Chofer</label><select id="payClosureDriverSelect"><option value="">Cargando choferes…</option></select></div>
          <div class="pay-closure-summary" id="payClosureSummary"></div>
          <div class="pay-closure-field" id="payDebtPaymentField" hidden><label for="payDebtPaymentAmountInput">Monto a pagar</label><input id="payDebtPaymentAmountInput" type="text" inputmode="numeric" autocomplete="off" placeholder="$ 0" /><small id="payDebtPaymentHint">El pago reduce la deuda pendiente actual.</small></div>
          <div class="pay-closure-field pay-debt-tender-field" id="payDebtPaymentMethodField" hidden>
            <label>Medio de entrega</label>
            <div class="pay-debt-tender-methods" role="group" aria-label="Medio de entrega del chofer">
              <button class="pay-debt-tender-method is-selected" data-debt-payment-method="cash" type="button" aria-pressed="true">EFECTIVO</button>
              <button class="pay-debt-tender-method" data-debt-payment-method="transfer" type="button" aria-pressed="false">TRANSFERENCIA</button>
            </div>
            <small id="payDebtPaymentMethodHint">Confirmás que recibiste el efectivo del chofer.</small>
          </div>
          <div class="pay-closure-field" id="payClosureFileField" hidden><label for="payClosureReceiptInput">Comprobante de transferencia</label><input id="payClosureReceiptInput" type="file" accept="image/*,application/pdf" /></div>
          <div class="pay-closure-message" id="payClosureMessage"></div>
          <div class="pay-closure-actions"><button class="pay-closure-danger" id="payClosureReject" type="button" hidden>No aceptar cierre</button><button class="pay-closure-secondary" id="payClosureCancel" type="button">Cancelar</button><button class="pay-closure-primary" id="payClosureSubmit" type="button">Pedir cierre</button></div>
        </section>
      </div>
      <div class="pay-profile-backdrop" id="payProfileBackdrop" aria-hidden="true">
        <section class="pay-profile-modal" role="dialog" aria-modal="true" aria-labelledby="payProfileTitle">
          <header><div><h2 id="payProfileTitle">Mi perfil</h2><p>Datos necesarios para cobrar y pedir cierres.</p></div><button class="pay-profile-close" id="payProfileClose" type="button" aria-label="Volver">×</button></header>
          <div class="pay-profile-body" id="payProfileBody"></div>
          <div class="pay-profile-message" id="payProfileMessage" role="status"></div>
          <div class="pay-profile-actions"><button class="pay-profile-secondary" id="payProfileBack" type="button">Volver</button><button class="pay-profile-primary" id="payProfileSave" type="button">Guardar</button></div>
        </section>
      </div>
    `;
    shell.insertAdjacentHTML("afterbegin", html);
    document.body.classList.add("explora-pay-mode", "explora-legacy-clean");
  }

  function runExistingAction(action) {
    try {
      if (window.ExploraActions?.[action]) { window.ExploraActions[action](); return; }
      const oldButton = Array.from(document.querySelectorAll("[data-action]")).find(el => el.getAttribute("data-action") === action);
      if (oldButton && !oldButton.closest("#exploraPagoDashboard") && !oldButton.closest("#payBottomNav")) oldButton.click();
    } catch (error) { console.warn("EXPLORA_PAY_ACTION_FAILED", action, error); }
  }


  async function refreshOpenData(reason = "manual-refresh") {
    if (!state.db || !state.user || state.refreshing) return;
    state.refreshing = true;
    beginFinancialDataLoading({ clearValues:true });
    const refreshButton = $("payRefreshBtn");
    const originalText = refreshButton?.textContent || "Actualizar →";
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = "Actualizando…";
    }
    try {
      const activeTab = state.tab;
      const activeView = state.view;
      const selectedUid = state.selectedDriverUid;
      const selectedName = state.selectedDriverName;
      if (isAdmin()) {
        await fetchDrivers();
        if (selectedUid) {
          const driver = state.drivers.find(item => item.uid === selectedUid);
          state.selectedDriverUid = selectedUid;
          state.selectedDriverName = driver?.name || selectedName || "";
        }
      }
      const uid = getDriverUid();
      if (uid) {
        const [records, expenses, closures, debts, debtPayments, uberWeeks] = await Promise.all([
          getScopedDocs("billing_records", uid),
          getScopedDocs("gastos", uid),
          getScopedDocs("cierres_semanales", uid),
          getScopedDocs("deudas_choferes", uid),
          getScopedDocs("deuda_pagos", uid),
          getScopedDocs("uber_weekly_closures", uid)
        ]);
        state.records = records.sort((a,b)=>rowMs(b)-rowMs(a));
        state.expenses = expenses.sort((a,b)=>rowMs(b)-rowMs(a));
        state.closures = closures.sort((a,b)=>rowMs(b)-rowMs(a));
        state.debts = debts.sort((a,b)=>debtCreatedMs(b)-debtCreatedMs(a));
        state.debtPayments = debtPayments.sort((a,b)=>rowMs(b)-rowMs(a));
        state.uberWeeks = uberWeeks.sort((a,b)=>rowMs(b)-rowMs(a));
        registerTabAlertMovements("billing_records", state.records);
        registerTabAlertMovements("gastos", state.expenses);
        registerTabAlertMovements("deudas_choferes", state.debts);
        registerTabAlertMovements("deuda_pagos", state.debtPayments);
      } else if (isAdmin()) {
        const [records, expenses, closures, debts, debtPayments, uberWeeks] = await Promise.all([
          getGlobalDocs("billing_records"),
          getGlobalDocs("gastos"),
          getGlobalDocs("cierres_semanales"),
          getGlobalDocs("deudas_choferes"),
          getGlobalDocs("deuda_pagos"),
          getGlobalDocs("uber_weekly_closures")
        ]);
        state.records = records.sort((a,b)=>rowMs(b)-rowMs(a));
        state.expenses = expenses.sort((a,b)=>rowMs(b)-rowMs(a));
        state.closures = closures.sort((a,b)=>rowMs(b)-rowMs(a));
        state.debts = debts.sort((a,b)=>debtCreatedMs(b)-debtCreatedMs(a));
        state.debtPayments = debtPayments.sort((a,b)=>rowMs(b)-rowMs(a));
        state.uberWeeks = (uberWeeks || []).sort((a,b)=>rowMs(b)-rowMs(a));
        registerTabAlertMovements("billing_records", state.records);
        registerTabAlertMovements("gastos", state.expenses);
        registerTabAlertMovements("deudas_choferes", state.debts);
        registerTabAlertMovements("deuda_pagos", state.debtPayments);
        state.pendingClosure = null;
      }
      state.tab = activeTab;
      state.view = activeView;
      render();
      startRealtime(reason, { preserveConfirmed:true });
    } catch (error) {
      console.warn("EXPLORA_MANUAL_REFRESH", error?.code || error?.message || error);
      startRealtime(`${reason}-fallback`);
    } finally {
      state.refreshing = false;
      const updatedButton = $("payRefreshBtn");
      if (updatedButton) {
        updatedButton.disabled = false;
        updatedButton.textContent = originalText;
      }
    }
  }

  function setPendingActionMode(enabled = false) {
    const actions = $("payClosureActionBtn")?.closest(".pay-actions");
    actions?.classList.toggle("is-pending-mode", !!enabled);
    document.querySelectorAll("[data-pay-run]").forEach(button => {
      button.hidden = !!enabled;
      button.setAttribute("aria-hidden", enabled ? "true" : "false");
    });
  }

  function scrollActivePayTabIntoView() {
    // Las cinco pestañas ya entran simultáneamente. scrollIntoView con inline:center
    // desplazaba horizontalmente todo el documento en iPhone y rompía la simetría.
    const tabs = document.querySelector(".pay-tabs");
    if (tabs) tabs.scrollLeft = 0;
    const scrollingElement = document.scrollingElement || document.documentElement;
    if (scrollingElement && scrollingElement.scrollLeft) scrollingElement.scrollLeft = 0;
    if (document.body && document.body.scrollLeft) document.body.scrollLeft = 0;
  }


  async function copyExploraAlias(button) {
    const alias = button?.dataset?.copyAlias || EXPLORA_ALIAS;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(alias);
        copied = true;
      }
    } catch (_) { copied = false; }
    if (!copied) {
      const area = document.createElement("textarea");
      area.value = alias;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      area.style.top = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      try { copied = document.execCommand("copy"); } catch (_) { copied = false; }
      area.remove();
    }
    if (button) {
      const label = button.querySelector("em");
      const previous = label?.textContent || "Copiar";
      button.classList.toggle("is-copied", copied);
      if (label) label.textContent = copied ? "Copiado" : "Copiar";
      window.setTimeout(() => {
        button.classList.remove("is-copied");
        if (label) label.textContent = previous;
      }, 1400);
    }
    if (copied) window.showToast?.(`Alias ${alias} copiado.`);
    else window.alert?.(`Alias de Explora: ${alias}`);
  }

  function bindShell() {
    $("payDebtAliasCopyBtn")?.addEventListener("click", event => copyExploraAlias(event.currentTarget));
    document.querySelectorAll("[data-pay-tab]").forEach(button => button.addEventListener("click", () => {
      state.tab = button.dataset.payTab || "chofer";
      markTabAlertSeen(state.tab);
      render();
      scrollActivePayTabIntoView();
    }));
    document.querySelectorAll("[data-pay-run]").forEach(button => button.addEventListener("click", () => {
      if (isAdmin() && button.closest("#payBottomNav")) {
        showPayView("admin-cierres");
        return;
      }
      runExistingAction(button.dataset.payRun);
    }));
    $("payClosureActionBtn")?.addEventListener("click", () => {
      if (activeClosureKind(state.tab) === "pendientes") {
        openDebtPaymentModal();
        return;
      }
      const buttonState = closureButtonState(state.tab, state.latestSummary || computeSummary());
      if (buttonState.blockedByDebt) {
        openExpenseDebtBlockedModal();
        return;
      }
      // Pedir cierre SIEMPRE crea un cierre nuevo del período abierto actual.
      // No debe abrir un cierre viejo pendiente: eso queda para "Ver", notificaciones o actividad.
      if (!buttonState.enabled) return;
      openClosureModal("request", null, state.tab);
    });
    $("payEfficiencyBtn")?.addEventListener("click", openEfficiencyModal);
    $("payNavClosure")?.addEventListener("click", () => {
      if (isAdmin()) {
        openHistoryScreen();
        return;
      }
      // Botón inferior "Cierre" = ver/resolver cierres existentes abiertos o historial.
      // NO crea un cierre nuevo. Para crear uno nuevo, usar el botón "Pedir cierre" dentro de cada módulo.
      const pending = pendingClosureRows(notificationDriverUid());
      if (pending.length === 1) {
        // Un solo cierre abierto: abrir directo su detalle
        showPayView("inicio");
        const row = pending[0];
        const kind = closureKindOf(row) || state.tab;
        openClosureModal(isAdmin() ? "admin-review" : "confirm", row, kind);
      } else {
        // Sin pendientes o varios: ir a la pantalla de notificaciones/lista de cierres
        showPayView("notificaciones");
      }
    });
    $("payClosureStatusBtn")?.addEventListener("click", () => {
      const pending = state.pendingClosure || pendingHomeClosureFor(getDriverUid(), state.tab);
      if (!pending) return;
      const kind = closureHomeModuleOf(pending) || closureKindOf(pending) || state.tab;
      openClosureModal(pending && !isAdmin() ? "confirm" : "admin-review", pending, kind);
    });
    $("payBellBtn")?.addEventListener("click", () => {
      if (!isAdmin() && activeDebtTotal() > 0.49) {
        showPayView("inicio");
        state.tab = "pendientes";
        render();
        setTimeout(scrollActivePayTabIntoView, 0);
        return;
      }
      showPayView("notificaciones");
    });
    $("payMainSubtitle")?.addEventListener("click", event => {
      const button = event.target?.closest?.("[data-pay-previous-toggle]");
      if (!button) return;
      const key = activeClosureKind(button.dataset.payPreviousToggle || state.tab);
      if (!["caja_chica", "gastos", "explora", "chofer", "pendientes"].includes(key)) return;
      state.previousDetailsOpen[key] = !state.previousDetailsOpen[key];
      renderMainCard(state.latestSummary || computeSummary());
    });
    $("payRefreshBtn")?.addEventListener("click", () => refreshOpenData("manual-refresh"));
    $("payAdminDriverSelect")?.addEventListener("change", event => selectAdminDriver(event.target?.value || ""));
    $("payAdminTypeSelect")?.addEventListener("change", event => selectAdminActivityType(event.target?.value || ""));
    $("payClosureClose")?.addEventListener("click", closeClosureModal);
    $("payClosureCancel")?.addEventListener("click", handleDebtModalBackOrClose);
    $("payClosureReject")?.addEventListener("click", rejectClosureByAdmin);
    $("payClosureBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payClosureBackdrop") closeClosureModal(); });
    $("payEfficiencyClose")?.addEventListener("click", closeEfficiencyModal);
    $("payEfficiencyBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payEfficiencyBackdrop") closeEfficiencyModal(); });
    $("payEfficiencyBody")?.addEventListener("click", event => {
      const action = event.target?.closest?.("[data-pay-efficiency-action]")?.dataset?.payEfficiencyAction || "";
      if (action === "close") closeEfficiencyModal();
      if (action === "attach-uber-week") {
        const weekId = safe(event.target.closest("[data-uber-week-id]")?.dataset?.uberWeekId);
        const period = uberLastEightWeeks().find(item => safe(item.weekId) === weekId);
        if (period?.isClosed) {
          state.uberSelectedWeekId = weekId;
          state.uberWeeklyFile = null;
          renderEfficiencyModal();
        }
      }
      if (action === "back-uber-weeks") {
        state.uberSelectedWeekId = "";
        state.uberWeeklyFile = null;
        renderEfficiencyModal();
      }
      if (action === "submit-uber-week") submitUberWeeklyClosure().catch(error => setEfficiencyFormMessage(error?.message || "No se pudo registrar el cierre Uber.", "error"));
      if (action === "submit-uber-no-data") submitUberWeeklyNoData().catch(error => setEfficiencyFormMessage(error?.message || "No se pudo cerrar la semana sin datos.", "error"));
      if (action === "open-uber-review") {
        const button = event.target.closest("[data-uber-driver-uid]");
        const driverUid = safe(button?.dataset?.uberDriverUid);
        if (driverUid) {
          const closureId = safe(button?.dataset?.uberClosureId);
          state.selectedDriverUid = driverUid;
          state.selectedDriverName = (state.uberWeeks || []).find(row => safe(row.id || row.closureId) === closureId)?.driverName
            || (state.uberWeeks || []).find(row => safe(row.driverUid || row.choferUid || row.driverId) === driverUid)?.driverName
            || "";
          state.uberReviewClosureId = closureId;
          renderEfficiencyModal();
        }
      }
      if (action === "back-uber-list") {
        state.selectedDriverUid = "";
        state.selectedDriverName = "";
        state.uberReviewClosureId = "";
        renderEfficiencyModal();
      }
      if (action === "approve-uber-week") reviewUberWeeklyClosure("approved").catch(error => setEfficiencyFormMessage(error?.message || "No se pudo aprobar.", "error"));
      if (action === "reject-uber-week") reviewUberWeeklyClosure("rejected").catch(error => setEfficiencyFormMessage(error?.message || "No se pudo rechazar.", "error"));
      if (action === "view-uber-proof") { const url = event.target.closest("[data-uber-proof-url]")?.dataset?.uberProofUrl || ""; if (url) window.open(url, "_blank", "noopener,noreferrer"); }
    });
    $("payEfficiencyBody")?.addEventListener("change", event => { if (event.target?.id === "payUberWeeklyFile") state.uberWeeklyFile = event.target.files?.[0] || null; });
    $("payEfficiencyBody")?.addEventListener("input", event => {
      if (event.target?.id !== "payUberWeeklyAmount") return;
      const digits = String(event.target.value || "").replace(/\D/g, "").slice(0, 12);
      event.target.value = digits ? Number(digits).toLocaleString("es-AR") : "";
      renderUberWeeklyCalculation();
    });
    $("payClosureReceiptInput")?.addEventListener("change", event => { state.modalFile = event.target?.files?.[0] || null; renderClosureModal(); });
    $("payDebtPaymentAmountInput")?.addEventListener("input", event => {
      if (window.formatCurrencyInput) event.target.value = window.formatCurrencyInput(event.target.value);
      if (state.modalMode === "admin-debt-payment") updateAdminDebtPaymentPreview();
    });
    $("payDebtPaymentMethodField")?.addEventListener("click", event => {
      const button = event.target?.closest?.("[data-debt-payment-method]");
      if (!button || state.modalMode !== "admin-debt-payment") return;
      state.adminDebtPaymentMethod = normalizeAdminDebtPaymentMethod(button.dataset.debtPaymentMethod);
      state.modalFile = null;
      const fileInput = $("payClosureReceiptInput");
      if (fileInput) fileInput.value = "";
      setModalMessage("");
      renderClosureModal();
      updateAdminDebtPaymentPreview();
    });
    $("payClosureSummary")?.addEventListener("click", event => {
      const button = event.target?.closest?.("[data-debt-reduction-method]");
      if (!button) return;
      const method = safe(button.dataset.debtReductionMethod);
      if (method === "expenses") openDebtExpenseOffsetMode();
      if (method === "receipt") openDebtReceiptPaymentMode();
    });
    $("payClosureSubmit")?.addEventListener("click", submitClosureModal);
    $("payProfileClose")?.addEventListener("click", closeDriverProfileModal);
    $("payProfileBack")?.addEventListener("click", closeDriverProfileModal);
    $("payProfileBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payProfileBackdrop") closeDriverProfileModal(); });
    $("payProfileSave")?.addEventListener("click", saveDriverProfileModal);
    document.querySelector('[data-pay-nav="inicio"]')?.addEventListener("click", () => {
      if (isAdmin()) {
        // Admin: botón inferior "Actividades" = últimas actividades globales desde el inicio de la tabla.
        state.adminActivityType = "";
        showPayView("inicio");
        render();
        scrollAdminActivitiesToTop();
        return;
      }
      showPayView("inicio");
    });
    document.querySelector('[data-pay-nav="actividad"]')?.addEventListener("click", () => {
      if (isAdmin()) {
        // Admin: botón inferior "+ Chofer" = abrir directamente Crear chofer.
        showPayView("inicio");
        setBottomNavActive("actividad");
        runExistingAction("admin-agregar-chofer");
        return;
      }
      showPayView("inicio");
      setTimeout(() => resetPayViewScroll("inicio"), 40);
    });
    document.querySelector('[data-pay-nav="mas"]')?.addEventListener("click", () => showPayView("mas"));
    $("payMoreBack")?.addEventListener("click", () => showPayView("inicio"));
    $("payNotificationsBack")?.addEventListener("click", () => showPayView("inicio"));
    $("payNotificationsSettings")?.addEventListener("click", () => showPayView("mas"));
    $("payAdminClosuresBack")?.addEventListener("click", () => showPayView("inicio"));
    $("payHistoryBack")?.addEventListener("click", () => showPayView("inicio"));
    $("payHistoryDriverSelect")?.addEventListener("change", event => selectHistoryDriver(event.target?.value || ""));
    $("payHistoryScopeSelect")?.addEventListener("change", event => {
      state.historyScope = event.target?.value || "total";
      if (state.historyScope === "monthly") ensureHistoryMonthId();
      renderHistoryScreen();
    });
    $("payHistoryMonthSelect")?.addEventListener("change", event => {
      state.historyMonthId = event.target?.value || currentMonthId();
      renderHistoryScreen();
    });
    $("payAdminClosuresList")?.addEventListener("click", event => {
      const button = event.target?.closest?.("[data-pay-admin-closure-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      handleAdminClosuresAction(button).catch(error => window.alert(error?.message || "No se pudo completar la acción."));
    });
    // Respaldo iOS/PWA: si el contenedor se re-renderiza o el scroll-snap captura el toque,
    // el click igual llega por delegación global.
    document.addEventListener("click", event => {
      const button = event.target?.closest?.(".pay-admin-closures-open [data-pay-admin-closure-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      handleAdminClosuresAction(button).catch(error => window.alert(error?.message || "No se pudo completar la acción."));
    }, true);
    $("payAdminDeleteClose")?.addEventListener("click", closeAdminDeleteModal);
    $("payAdminDeleteCancel")?.addEventListener("click", closeAdminDeleteModal);
    $("payAdminDeleteBackdrop")?.addEventListener("click", event => { if (event.target?.id === "payAdminDeleteBackdrop") closeAdminDeleteModal(); });
    $("payAdminDeleteList")?.addEventListener("click", event => {
      const button = event.target?.closest?.("[data-pay-admin-delete]");
      if (!button) return;
      submitAdminDeleteMovement(button.dataset.payAdminDelete, button.dataset.payAdminDeleteType, button).catch(error => setAdminDeleteMessage(error?.message || "No se pudo borrar el movimiento.", "error"));
    });
    $("payNotificationList")?.addEventListener("click", event => {
      const button = event.target.closest("[data-pay-notification-closure]");
      if (!button) return;
      openClosureFromNotification(button.dataset.payNotificationClosure);
    });
    $("payActivityList")?.addEventListener("click", event => {
      const deleteButton = event.target.closest("[data-pay-activity-financial-delete]");
      if (deleteButton) {
        event.preventDefault();
        event.stopPropagation();
        deleteAdminActivityFinancial(
          deleteButton.dataset.payActivityFinancialKind || "",
          deleteButton.dataset.payActivityFinancialDelete || ""
        ).catch(error => window.alert(error?.message || "No se pudo eliminar el comprobante."));
        return;
      }
      const editButton = event.target.closest("[data-pay-activity-financial-edit]");
      if (editButton) {
        event.preventDefault();
        event.stopPropagation();
        openAdminActivityAmountEditor(
          editButton.dataset.payActivityFinancialKind || "",
          editButton.dataset.payActivityFinancialEdit || ""
        );
        return;
      }
      const row = event.target.closest("[data-pay-activity-closure]");
      if (!row) return;
      openClosureFromNotification(row.dataset.payActivityClosure);
    });
    $("payAdminAmountEditCancel")?.addEventListener("click", closeAdminActivityAmountEditor);
    $("payAdminAmountEditSave")?.addEventListener("click", () => {
      saveAdminActivityAmountEdit().catch(error => {
        console.error("EXPLORA_ADMIN_ACTIVITY_AMOUNT_EDIT", error);
        setAdminActivityAmountMessage(error?.message || "No se pudo modificar el valor.", "error");
      });
    });
    $("payAdminAmountEditBackdrop")?.addEventListener("click", event => {
      if (event.target?.id === "payAdminAmountEditBackdrop") closeAdminActivityAmountEditor();
    });
    $("payAdminAmountEditInput")?.addEventListener("input", event => {
      const digits = safe(event.target?.value).replace(/\D/g, "");
      event.target.value = digits ? new Intl.NumberFormat("es-AR", { maximumFractionDigits:0 }).format(Number(digits)) : "";
      setAdminActivityAmountMessage("");
    });
    $("payAdminAmountEditInput")?.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveAdminActivityAmountEdit().catch(error => setAdminActivityAmountMessage(error?.message || "No se pudo modificar el valor.", "error"));
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeAdminActivityAmountEditor();
      }
    });
    $("payMoreLogoutBtn")?.addEventListener("click", logoutFromMore);
    $("payMoreList")?.addEventListener("click", event => {
      const button = event.target.closest("[data-pay-more-action]");
      if (!button) return;
      const action = safe(button.dataset.payMoreAction);
      if (action === "salir") {
        logoutFromMore();
        return;
      }
      if (action === "abrir-perfil") {
        openDriverProfileModal();
        return;
      }
      if (action === "admin-delete-movements") {
        openAdminDeleteModal();
        return;
      }
      if (action === "admin-cierres") {
        showPayView("admin-cierres");
        return;
      }
      if (action === "admin-uber-closures") {
        state.selectedDriverUid = "";
        state.selectedDriverName = "";
        state.uberReviewClosureId = "";
        state.uberSelectedWeekId = "";
        showPayView("inicio");
        refreshOpenData("admin-uber-menu").finally(() => openEfficiencyModal());
        return;
      }
      showPayView("inicio");
      runExistingAction(action);
    });
    $("payMoreAdminList")?.addEventListener("click", event => {
      const button = event.target.closest("[data-pay-more-action]");
      if (!button) return;
      const action = safe(button.dataset.payMoreAction);
      if (action === "admin-delete-movements") {
        openAdminDeleteModal();
        return;
      }
      if (action === "admin-cierres") {
        showPayView("admin-cierres");
        return;
      }
      if (action === "admin-uber-closures") {
        state.selectedDriverUid = "";
        state.selectedDriverName = "";
        state.uberReviewClosureId = "";
        state.uberSelectedWeekId = "";
        showPayView("inicio");
        refreshOpenData("admin-uber-menu").finally(() => openEfficiencyModal());
        return;
      }
      showPayView("inicio");
      runExistingAction(action);
    });
  }

  function setBottomNavActive(target = "inicio") {
    document.querySelectorAll("#payBottomNav .pay-nav-btn").forEach(button => {
      const nav = button.dataset.payNav || (isAdmin() && button.dataset.payRun ? "admin-cierres" : "") || (button.id === "payNavClosure" ? (isAdmin() ? "historico" : "cierre") : "");
      button.classList.toggle("is-active", nav === target);
    });
  }

  function resetPayViewScroll(target = "inicio") {
    const screen = target === "mas"
      ? $("payMoreScreen")
      : target === "notificaciones"
        ? $("payNotificationsScreen")
        : target === "admin-cierres"
          ? $("payAdminClosuresList")
          : target === "historico"
            ? $("payHistoryScreen")
            : document.scrollingElement;
    const reset = () => {
      try {
        if (screen?.scrollTo) screen.scrollTo({ top:0, left:0, behavior:"auto" });
        else if (screen) screen.scrollTop = 0;
      } catch (_) {
        if (screen) screen.scrollTop = 0;
      }
      try { window.scrollTo({ top:0, left:0, behavior:"auto" }); } catch (_) { window.scrollTo(0, 0); }
    };
    reset();
    requestAnimationFrame(reset);
    setTimeout(reset, 80);
  }

  function scrollAdminActivitiesToTop() {
    const section = $("payActivityTitle")?.closest?.(".pay-section") || $("payActivityTitle") || $("payActivityList");
    const root = document.scrollingElement || document.documentElement || document.body;
    const apply = () => {
      try {
        showPayView("inicio");
        if (!section) {
          root?.scrollTo?.({ top:0, left:0, behavior:"auto" });
          window.scrollTo({ top:0, left:0, behavior:"auto" });
          return;
        }
        const dock = $("payBottomNav")?.getBoundingClientRect?.().height || 0;
        const topbar = document.querySelector(".pay-topbar")?.getBoundingClientRect?.().height || 0;
        const targetTop = Math.max(0, section.getBoundingClientRect().top + window.pageYOffset - Math.max(8, Math.round(topbar * 0.15)));
        root?.scrollTo?.({ top:targetTop, left:0, behavior:"auto" });
        window.scrollTo({ top:targetTop, left:0, behavior:"auto" });
        const list = $("payActivityList");
        if (list?.scrollTo) list.scrollTo({ top:0, left:0, behavior:"auto" });
        else if (list) list.scrollTop = 0;
        void dock;
      } catch (_) {
        try { section?.scrollIntoView?.({ behavior:"auto", block:"start" }); } catch (__) {}
      }
    };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 60);
    setTimeout(apply, 180);
  }

  function showPayView(view = "inicio") {
    const target = view === "mas" ? "mas" : view === "notificaciones" ? "notificaciones" : view === "admin-cierres" ? "admin-cierres" : view === "historico" ? "historico" : "inicio";
    state.view = target;
    const dashboard = $("exploraPagoDashboard");
    const more = $("payMoreScreen");
    const notifications = $("payNotificationsScreen");
    const adminClosures = $("payAdminClosuresScreen");
    const history = $("payHistoryScreen");
    const isMore = target === "mas";
    const isNotifications = target === "notificaciones";
    const isAdminClosures = target === "admin-cierres";
    const isHistory = target === "historico";
    const hideHome = isMore || isNotifications || isAdminClosures || isHistory;
    if (dashboard) {
      dashboard.hidden = hideHome;
      dashboard.style.display = hideHome ? "none" : "";
      dashboard.setAttribute("aria-hidden", hideHome ? "true" : "false");
    }
    if (more) {
      more.hidden = !isMore;
      more.style.display = isMore ? "block" : "none";
      more.setAttribute("aria-hidden", isMore ? "false" : "true");
    }
    if (notifications) {
      notifications.hidden = !isNotifications;
      notifications.style.display = isNotifications ? "block" : "none";
      notifications.setAttribute("aria-hidden", isNotifications ? "false" : "true");
    }
    if (adminClosures) {
      adminClosures.hidden = !isAdminClosures;
      adminClosures.style.display = isAdminClosures ? "block" : "none";
      adminClosures.setAttribute("aria-hidden", isAdminClosures ? "false" : "true");
    }
    if (history) {
      history.hidden = !isHistory;
      history.style.display = isHistory ? "block" : "none";
      history.setAttribute("aria-hidden", isHistory ? "false" : "true");
    }
    document.body.classList.toggle("pay-more-open", isMore);
    document.body.classList.toggle("pay-notifications-open", isNotifications);
    document.body.classList.toggle("pay-admin-closures-open", isAdminClosures);
    document.body.classList.toggle("pay-history-open", isHistory);
    setBottomNavActive(isAdminClosures ? "admin-cierres" : isHistory ? "historico" : isNotifications ? "" : target);
    if (isMore) renderMoreScreen();
    if (isNotifications) renderNotificationsScreen();
    if (isAdminClosures) renderAdminClosuresScreen();
    if (isHistory) renderHistoryScreen();
    if (isMore || isNotifications || isAdminClosures || isHistory) resetPayViewScroll(target);
  }

  function payOverlayIsOpen() {
    return !!document.querySelector(".pay-modal-backdrop.is-open, #payClosureBackdrop.is-open, #payEfficiencyBackdrop.is-open, #payProfileBackdrop.is-open, #payAdminDeleteBackdrop.is-open");
  }

  function forceHomeLanding() {
    state.view = "inicio";
    state.tab = "chofer";
    document.body.classList.remove("pay-more-open", "pay-notifications-open", "pay-admin-closures-open", "pay-history-open");
    const dashboard = $("exploraPagoDashboard");
    const more = $("payMoreScreen");
    const notifications = $("payNotificationsScreen");
    const adminClosures = $("payAdminClosuresScreen");
    const history = $("payHistoryScreen");
    if (dashboard) { dashboard.hidden = false; dashboard.style.display = ""; dashboard.setAttribute("aria-hidden", "false"); }
    if (more) { more.hidden = true; more.style.display = "none"; more.setAttribute("aria-hidden", "true"); }
    if (notifications) { notifications.hidden = true; notifications.style.display = "none"; notifications.setAttribute("aria-hidden", "true"); }
    if (adminClosures) { adminClosures.hidden = true; adminClosures.style.display = "none"; adminClosures.setAttribute("aria-hidden", "true"); }
    if (history) { history.hidden = true; history.style.display = "none"; history.setAttribute("aria-hidden", "true"); }
    setBottomNavActive("inicio");
  }

  function moreItems() {
    if (isAdmin()) {
      const pendingUber = (state.uberWeeks || []).filter(row => {
        const review = safe(row.reviewStatus).toLowerCase();
        const status = safe(row.status).toLowerCase();
        return review === "pending" || status === "pending_review";
      }).length;
      const overdueUberDrivers = uberAdminOverdueRows().length;
      return [
        { title:"Mi perfil", detail:"Alias, CUIT y celular", action:"abrir-perfil", icon:"user" },
        { title:"Comprobantes Uber", detail:overdueUberDrivers ? `${overdueUberDrivers} chofer${overdueUberDrivers === 1 ? "" : "es"} con semana vencida` : (pendingUber ? `${pendingUber} cierre${pendingUber === 1 ? "" : "s"} en revisión` : "Aceptar o rechazar cierres semanales"), action:"admin-uber-closures", icon:"receipt" },
        { title:"Deudas", detail:"Deuda o pago del chofer", action:"admin-multas", icon:"alert" },
        { title:"Salir", detail:"Cerrar sesión", action:"salir", icon:"logout", tone:"danger" }
      ];
    }
    return [
      { title:"Mi perfil", detail:"Alias, CUIT y celular", action:"abrir-perfil", icon:"user" },
      { title:"Salir", detail:"Cerrar sesión", action:"salir", icon:"logout", tone:"danger" }
    ];
  }

  function adminMoreItems() {
    return [];
  }

  function moreIcon(name = "user") {
    const icons = {
      user:'<path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="8" r="4"></circle>',
      car:'<path d="M6 17h12l1-5-2-5H7l-2 5 1 5Z"></path><path d="M7 17v2M17 17v2M5 12h14"></path>',
      alert:'<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"></path>',
      loan:'<path d="M4 7h16v12H4z"></path><path d="M4 10h16"></path><path d="M8 15h4"></path>',
      receipt:'<path d="M7 3h10v18l-2-1-2 1-2-1-2 1-2-1Z"></path><path d="M9 8h6M9 12h6M9 16h4"></path>',
      users:'<path d="M16 21a6 6 0 0 0-12 0"></path><circle cx="10" cy="8" r="4"></circle><path d="M22 21a5 5 0 0 0-5-5"></path><path d="M17 4a4 4 0 0 1 0 8"></path>',
      wallet:'<path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path>',
      trash:'<path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6 7l1 14h10l1-14"></path><path d="M9 7V4h6v3"></path>',
      logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path>'
    };
    return `<svg viewBox="0 0 24 24">${icons[name] || icons.user}</svg>`;
  }

  function adminDeleteRows(summary = state.latestSummary || computeSummary()) {
    if (!isAdmin()) return [];
    const rows = [];
    const billing = summary.billingRecords || summary.records || [];
    for (const row of billing) {
      const id = safe(row.id || row.recordId || row.billingRecordId);
      const amount = amountOf(row), method = methodOf(row), at = rowMs(row);
      if (!id || !(amount > 0)) continue;
      rows.push({
        id, type:"cobro", icon:"+", title:`${dateShort(at)} · Borrar cobro`,
        meta:paymentLabel(method), detail:`Elimina el cobro de Firestore y ajusta Chofer/Explora${method === "cash" ? " + caja chica" : ""}.`, amount
      });
      if (method === "cash" && !cashboxIsExcluded(row)) {
        rows.push({
          id, type:"caja_chica", icon:"🛎️", title:`${dateShort(at)} · Borrar caja chica`,
          meta:"Caja chica 5% generada por efectivo", detail:"Mantiene el cobro efectivo, pero lo excluye de caja chica y ajusta su cierre.", amount:amount * .05
        });
      }
    }
    for (const row of summary.expenses || []) {
      const id = safe(row.id || row.expenseId || row.gastoId);
      const amount = amountOf(row), at = rowMs(row);
      if (!id || !(amount > 0)) continue;
      rows.push({
        id, type:"gasto", icon:"−", title:`${dateShort(at)} · Borrar gasto`,
        meta:expenseTypeLabel(row), detail:"Elimina el gasto de Firestore y ajusta el cierre de gastos.", amount
      });
    }
    return rows.sort((a,b)=>b.id.localeCompare(a.id)).slice(0, 120);
  }

  function setAdminDeleteMessage(message = "", tone = "") {
    state.adminDeleteMessage = safe(message);
    const box = $("payAdminDeleteMessage");
    if (!box) return;
    box.textContent = state.adminDeleteMessage;
    box.classList.toggle("is-ok", tone === "ok");
    box.classList.toggle("is-error", tone === "error");
  }

  function renderAdminDeleteModal() {
    const list = $("payAdminDeleteList");
    if (!list) return;
    if (!isAdmin()) {
      list.innerHTML = `<div class="pay-admin-delete-empty">Esta opción es solo para administrador.</div>`;
      return;
    }
    if (!getDriverUid()) {
      list.innerHTML = `<div class="pay-admin-delete-empty">Primero seleccioná un chofer en el inicio.</div>`;
      return;
    }
    const rows = adminDeleteRows(state.latestSummary || computeSummary());
    if (!rows.length) {
      list.innerHTML = `<div class="pay-admin-delete-empty">No hay cobros, caja chica ni gastos abiertos para borrar en este chofer.</div>`;
      return;
    }
    list.innerHTML = rows.map(row => `
      <article class="pay-admin-delete-row">
        <span class="pay-admin-delete-icon">${esc(row.icon)}</span>
        <div class="pay-admin-delete-copy"><strong>${esc(row.title)}</strong><small>${esc(row.meta)} · ${currency(row.amount)}</small><em>${esc(row.detail)}</em></div>
        <button data-pay-admin-delete="${esc(row.id)}" data-pay-admin-delete-type="${esc(row.type)}" type="button" ${state.adminDeleteBusy ? "disabled" : ""}>Borrar</button>
      </article>
    `).join("");
  }

  function openAdminDeleteModal() {
    if (!isAdmin()) return;
    showPayView("inicio");
    state.adminDeleteOpen = true;
    state.adminDeleteMessage = "";
    $("payAdminDeleteBackdrop")?.classList.add("is-open");
    $("payAdminDeleteBackdrop")?.setAttribute("aria-hidden", "false");
    renderAdminDeleteModal();
    setAdminDeleteMessage(getDriverUid() ? `Chofer seleccionado: ${state.selectedDriverName || "sin nombre"}.` : "Seleccioná un chofer antes de borrar.", getDriverUid() ? "" : "error");
  }

  function closeAdminDeleteModal() {
    state.adminDeleteOpen = false;
    state.adminDeleteBusy = false;
    $("payAdminDeleteBackdrop")?.classList.remove("is-open");
    $("payAdminDeleteBackdrop")?.setAttribute("aria-hidden", "true");
  }

  function adminDeleteScrollTop() {
    const modal = document.querySelector(".pay-admin-delete-modal");
    try { modal?.scrollTo?.({ top:0, behavior:"smooth" }); } catch (_) { if (modal) modal.scrollTop = 0; }
  }

  function adminDeleteOwnerValues(row = {}) {
    return ["driverUid", "choferUid", "uid", "ownerUid", "driverId", "choferId", "userUid", "userId", "createdByUid", "ownerId", "conductorUid", "assignedDriverUid", "createdForUid", "profileId", "perfilId"]
      .map(field => safe(row[field])).filter(Boolean);
  }

  function adminDeleteMovementBelongsToSelected(row = {}, uid = getDriverUid(), documentId = "") {
    const target = safe(uid);
    const id = safe(documentId || row.id || row.recordId || row.expenseId || row.gastoId);
    if (!target || !id) return false;
    if (adminDeleteOwnerValues(row).includes(target)) return true;
    const loaded = [...(state.records || []), ...(state.expenses || [])].some(item => safe(item.id || item.recordId || item.expenseId || item.gastoId) === id);
    if (loaded) return true;
    const selectedName = safe(state.selectedDriverName || displayName()).toLowerCase();
    const rowName = safe(row.driverName || row.choferNombre || row.nombreChofer || row.conductorNombre || row.name || row.nombre).toLowerCase();
    return !!selectedName && !!rowName && selectedName === rowName;
  }

  function adminDeleteRemoveArrayItem(value, item) {
    const target = safe(item);
    return Array.isArray(value) ? value.map(safe).filter(v => v && v !== target) : [];
  }

  function adminDeleteExpenseParts(row = {}) {
    const amount = amountOf(row);
    const rawRate = Number(row.sharedRate ?? row.porcentajeCompartido ?? row.driverShareRate ?? row.porcentajeChofer);
    const rate = Number.isFinite(rawRate) ? (rawRate > 1 ? rawRate / 100 : rawRate) : .5;
    const driverPart = amount * Math.min(1, Math.max(0, rate || .5));
    const exploraPart = Math.max(0, amount - driverPart);
    return { amount, driverPart, exploraPart };
  }

  function adminDeleteBillingClosurePatch(closure = {}, movement = {}, { cashboxOnly = false } = {}) {
    const amount = amountOf(movement);
    const method = methodOf(movement);
    const oldCash = moneyNumber(closure.cashInDriver ?? closure.cashGrossInDriver ?? closure.driverActualCash);
    const oldDigital = moneyNumber(closure.exploraCash ?? closure.nonCashInExplora ?? closure.nonCashGrossInExplora);
    const cash = Math.max(0, oldCash - (!cashboxOnly && method === "cash" ? amount : 0));
    const digital = Math.max(0, oldDigital - (!cashboxOnly && method !== "cash" ? amount : 0));
    const cashboxGenerates = method === "cash" && !cashboxIsExcluded(movement);
    const oldCashboxGross = moneyNumber(closure.billingCashboxGross ?? closure.cashboxGross ?? oldCash);
    const oldEligibleGross = moneyNumber(closure.billingCashboxEligibleGross ?? closure.cashboxEligibleGross ?? oldCashboxGross);
    const cashboxGross = Math.max(0, oldCashboxGross - (cashboxGenerates ? amount : 0));
    const eligibleGross = Math.max(0, oldEligibleGross - (cashboxGenerates ? amount : 0));
    const cashboxRate = moneyNumber(closure.cashboxRate ?? .05) || .05;
    const autoClosesCashbox = billingClosureClosesCashbox(closure);
    const cashboxGenerated = cashboxGross * cashboxRate;
    const alreadyCompensated = autoClosesCashbox ? Math.max(0, moneyNumber(closure.cashboxAlreadyCompensated || 0)) : 0;
    const cashboxPending = autoClosesCashbox ? Math.max(0, cashboxGenerated - alreadyCompensated) : null;
    const settlement = billingSettlementWithCashbox({ cash, digital, cashboxEligibleGross:eligibleGross, cashboxRate, cashboxAmount:cashboxPending });
    const settlementPaymentTotal = Math.max(0, moneyNumber(closure.billingSettlementPaymentTotal));
    const netAfterDriverPayments = settlement.netToDriver + settlementPaymentTotal;
    const amountFromDriver = Math.max(0, -netAfterDriverPayments);
    const amountToDriver = Math.max(0, netAfterDriverPayments);
    const payerRole = amountFromDriver > .49 ? "driver" : amountToDriver > .49 ? "admin" : "balanced";
    return {
      gross:settlement.gross, grossBeforeCashbox:settlement.gross, cashInDriver:cash, cashGrossInDriver:cash,
      exploraCash:digital, nonCashInExplora:digital, nonCashGrossInExplora:digital,
      billingShareEach:settlement.share, driverShare:settlement.share, exploraShare:settlement.share, driverEntitlement:settlement.share, driverFinal:settlement.share,
      billingNetBeforeCashboxToDriver:settlement.netBeforeCashboxToDriver,
      billingAmountToDriverBeforeCashbox:Math.max(0, settlement.netBeforeCashboxToDriver),
      billingCashboxGross:cashboxGross,
      billingCashboxEligibleGross:settlement.cashboxEligibleGross,
      billingCashboxGenerated:autoClosesCashbox ? settlement.cashboxGenerated : cashboxGenerated,
      billingCashboxEligibleAmount:settlement.cashboxGenerated,
      billingCashboxOffsetApplied:settlement.cashboxOffsetApplied,
      cashboxGeneratedTotal:cashboxGenerated,
      cashboxTotal:autoClosesCashbox ? settlement.cashboxGenerated : cashboxGenerated,
      cashboxIncludedInSettlement:autoClosesCashbox ? settlement.cashboxGenerated : moneyNumber(closure.cashboxIncludedInSettlement || 0),
      cashboxInDriver:autoClosesCashbox ? settlement.cashboxGenerated : settlement.cashboxRemainingInDriver,
      cashboxInExplora:autoClosesCashbox ? 0 : settlement.cashboxOffsetApplied,
      billingNetBeforeDriverPayments:settlement.netToDriver,
      billingSettlementPaymentTotal:settlementPaymentTotal,
      netSettlementToDriver:netAfterDriverPayments,
      amountDueFromDriver:amountFromDriver, amountFromDriver,
      amountDueToDriver:amountToDriver, amountToDriver,
      pendingPayerRole:payerRole,
      receiptRequiredFrom:payerRole,
      paymentDirection:payerRole === "driver" ? "driver_to_explora" : payerRole === "admin" ? "explora_to_driver" : "balanced"
    };
  }

  function adminDeleteCashboxClosurePatch(closure = {}, movement = {}) {
    const amount = amountOf(movement);
    const reduction = amount * .05;
    const gross = Math.max(0, moneyNumber(closure.cashboxGross ?? closure.gross ?? closure.cashboxBase) - amount);
    const total = Math.max(0, moneyNumber(closure.cashboxTotal ?? closure.mainTotal ?? closure.amountDueFromDriver) - reduction);
    return {
      gross, cashboxGross:gross, mainTotal:total,
      cashboxTotal:total, cashboxInDriver:total, cashboxInExplora:0,
      amountDueFromDriver:total, amountFromDriver:total,
      amountDueToDriver:0, amountToDriver:0,
      netSettlementToDriver:-total
    };
  }

  function adminDeleteBillingSettlementClosurePatch(closure = {}, movement = {}) {
    const amount = amountOf(movement);
    const previousPaymentTotal = Math.max(0, moneyNumber(closure.billingSettlementPaymentTotal));
    const paymentTotal = Math.max(0, previousPaymentTotal - amount);
    const previousNet = moneyNumber(closure.netSettlementToDriver);
    const netBeforePayments = Number.isFinite(Number(closure.billingNetBeforeDriverPayments))
      ? moneyNumber(closure.billingNetBeforeDriverPayments)
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

  function adminDeleteExpenseClosurePatch(closure = {}, movement = {}) {
    const { amount, driverPart, exploraPart } = adminDeleteExpenseParts(movement);
    const total = Math.max(0, moneyNumber(closure.expenseTotal ?? closure.mainTotal ?? closure.gross) - amount);
    const oldDriver = moneyNumber(closure.driverExpenseShare);
    const oldExplora = moneyNumber(closure.exploraExpenseShare ?? closure.amountDueToDriver);
    const newDriver = Math.max(0, oldDriver - driverPart);
    const newExplora = Math.max(0, oldExplora - exploraPart);
    const debtOffset = Math.min(newExplora, Math.max(0, moneyNumber(closure.expenseDebtOffsetApplied)));
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

  async function adminDeleteRelatedClosures(driverUid = "", documentId = "", includeField = "includedBillingIds") {
    const result = new Map();
    const col = collection(state.db, "cierres_semanales");
    try {
      const direct = await getDocs(query(col, where(includeField, "array-contains", documentId), limit(250)));
      direct.forEach(item => result.set(item.id, item));
    } catch (error) {
      console.warn("EXPLORA_ADMIN_DELETE_DIRECT_CLOSURE_INCLUDED_SKIP", includeField, error?.code || error?.message);
    }
    for (const field of ["driverUid", "choferUid", "uid", "driverId", "choferId"]) {
      try {
        const snap = await getDocs(query(col, where(field, "==", driverUid), limit(300)));
        snap.forEach(item => {
          const data = item.data() || {};
          if (Array.isArray(data[includeField]) && data[includeField].map(safe).includes(documentId)) result.set(item.id, item);
        });
      } catch (_) {}
    }
    return [...result.values()];
  }

  async function adminDeleteAdjustClosuresDirect({ type, driverUid, documentId, movement }) {
    const settlementPayment = type === "cobro" && isDriverBillingSettlementPayment(movement);
    const includeField = type === "gasto" ? "includedExpenseIds" : settlementPayment ? "includedBillingSettlementPaymentIds" : "includedBillingIds";
    const docsMap = new Map();
    for (const field of (type === "gasto" || settlementPayment ? [includeField] : [includeField, "includedCashboxIds"])) {
      const found = await adminDeleteRelatedClosures(driverUid, documentId, field);
      found.forEach(snap => docsMap.set(snap.id, snap));
    }
    const docs = [...docsMap.values()];
    let adjusted = 0;
    for (const snap of docs) {
      const closure = snap.data() || {};
      const kind = activeClosureKind(closure.closureKind || closure.closureType || closure.payTab || closure.closeKind || closure.kind || closure.cierreTipo || closure.type || closure.category);
      let patch = null;
      const inBillingIds = Array.isArray(closure.includedBillingIds) && closure.includedBillingIds.map(safe).includes(safe(documentId));
      const inCashboxIds = Array.isArray(closure.includedCashboxIds) && closure.includedCashboxIds.map(safe).includes(safe(documentId));
      if (type === "gasto" && kind === "gastos") patch = adminDeleteExpenseClosurePatch(closure, movement);
      if (settlementPayment && (kind === "chofer" || kind === "explora" || kind === "facturacion")) patch = adminDeleteBillingSettlementClosurePatch(closure, movement);
      else if (type === "cobro" && (kind === "chofer" || kind === "explora" || kind === "facturacion")) patch = adminDeleteBillingClosurePatch(closure, movement, { cashboxOnly:!inBillingIds && inCashboxIds });
      if (type === "caja_chica" && (kind === "chofer" || kind === "explora" || kind === "facturacion") && methodOf(movement) === "cash") patch = adminDeleteBillingClosurePatch(closure, movement, { cashboxOnly:true });
      if ((type === "cobro" || type === "caja_chica") && kind === "caja_chica" && methodOf(movement) === "cash") patch = adminDeleteCashboxClosurePatch(closure, movement);
      if (!patch) continue;
      const primaryIds = Array.isArray(closure[includeField]) ? closure[includeField].map(safe) : [];
      const removesPrimaryMovement = (type !== "caja_chica" || kind === "caja_chica") && primaryIds.includes(safe(documentId));
      const decrementsIncludedCount = removesPrimaryMovement && !settlementPayment;
      const generatedIds = Array.isArray(closure.includedCashboxGeneratedBillingIds)
        ? adminDeleteRemoveArrayItem(closure.includedCashboxGeneratedBillingIds, documentId)
        : closure.includedCashboxGeneratedBillingIds;
      const eligibleIds = Array.isArray(closure.includedCashboxEligibleBillingIds)
        ? adminDeleteRemoveArrayItem(closure.includedCashboxEligibleBillingIds, documentId)
        : closure.includedCashboxEligibleBillingIds;
      const cashboxIds = Array.isArray(closure.includedCashboxIds)
        ? adminDeleteRemoveArrayItem(closure.includedCashboxIds, documentId)
        : closure.includedCashboxIds;
      await updateDoc(doc(state.db, "cierres_semanales", snap.id), {
        ...patch,
        [includeField]:removesPrimaryMovement ? adminDeleteRemoveArrayItem(closure[includeField], documentId) : closure[includeField],
        ...(generatedIds !== undefined ? { includedCashboxGeneratedBillingIds:generatedIds } : {}),
        ...(eligibleIds !== undefined ? { includedCashboxEligibleBillingIds:eligibleIds } : {}),
        ...(cashboxIds !== undefined ? { includedCashboxIds:cashboxIds } : {}),
        includedCount:decrementsIncludedCount ? Math.max(0, Number(closure.includedCount || 0) - 1) : Number(closure.includedCount || 0),
        adminAdjusted:true,
        adminAdjustedReason:type === "caja_chica" ? "Caja chica excluida manualmente" : "Movimiento eliminado manualmente",
        adminAdjustedAt:serverTimestamp(),
        adminAdjustedAtMs:Date.now(),
        adminAdjustedByUid:safe(state.user?.uid || window.ExploraSession?.authUser?.uid),
        updatedAt:serverTimestamp(),
        updatedAtMs:Date.now(),
        version:VERSION
      });
      adjusted += 1;
    }
    return adjusted;
  }

  async function adminDeleteReceiptIndexDocs(documentId = "", type = "") {
    const id = safe(documentId);
    if (!id || !state.db) return [];
    const found = new Map();
    const canonicalIds = type === "gasto" ? [`expense_${id}`, `gasto_${id}`] : [`payment_${id}`, `billing_${id}`];
    for (const receiptId of canonicalIds) {
      try {
        const snap = await getDoc(doc(state.db, "receipt_index", receiptId));
        if (snap.exists()) found.set(snap.id, snap);
      } catch (_) {}
    }
    for (const field of ["recordId", "relatedDocumentId", "operationId"]) {
      try {
        const snap = await getDocs(query(collection(state.db, "receipt_index"), where(field, "==", id), limit(30)));
        snap.forEach(item => found.set(item.id, item));
      } catch (error) {
        console.warn("EXPLORA_ADMIN_DELETE_RECEIPT_INDEX_QUERY", field, error?.code || error?.message || error);
      }
    }
    return [...found.values()];
  }

  async function adminDeleteStorageArtifacts(rows = []) {
    if (!state.storage) return 0;
    const paths = new Set();
    for (const row of rows) {
      const data = row?.data && typeof row.data === "function" ? row.data() || {} : row || {};
      ["receiptPath","storagePath","fullPath","filePath","comprobantePath","archivoPath","driverReceiptPath","adminReceiptPath","davidReceiptPath","receiptUrl","downloadURL","fileUrl","comprobanteUrl","archivoUrl","notificationPhotoUrl","telegramPhotoUrl"]
        .forEach(field => { const value=safe(data[field]);if(value)paths.add(value); });
    }
    let deleted = 0;
    for (const path of paths) {
      try { await deleteObject(storageRef(state.storage, path));deleted += 1; }
      catch (error) { if (!String(error?.code || "").includes("object-not-found")) console.warn("EXPLORA_ADMIN_DELETE_STORAGE_SKIP", path, error?.code || error?.message || error); }
    }
    return deleted;
  }

  async function adminDeleteFinancialDirect({ type = "", documentId = "", driverUid = "" } = {}) {
    if (!state.db) throw new Error("Firestore no está disponible.");
    const collectionName = type === "gasto" ? "gastos" : "billing_records";
    const movementRef = doc(state.db, collectionName, documentId);
    const snap = await getDoc(movementRef);
    const receiptIndexes = type === "caja_chica" ? [] : await adminDeleteReceiptIndexDocs(documentId, type);
    if (!snap.exists() && !receiptIndexes.length) throw new Error("El movimiento ya no existe en Firestore.");
    const fallbackIndexData = receiptIndexes[0]?.data?.() || {};
    const movement = snap.exists() ? { id:snap.id, ...snap.data() } : { id:documentId, ...fallbackIndexData };
    if (!adminDeleteMovementBelongsToSelected(movement, driverUid, documentId)) throw new Error("El movimiento no pertenece al chofer seleccionado.");
    if (type === "caja_chica" && methodOf(movement) !== "cash") throw new Error("Solo los cobros en efectivo generan caja chica.");
    const closuresAdjusted = await adminDeleteAdjustClosuresDirect({ type, driverUid, documentId, movement });
    const deletedFiles = type === "caja_chica" ? 0 : await adminDeleteStorageArtifacts([movement, ...receiptIndexes]);
    if (type === "caja_chica") {
      await updateDoc(movementRef, {
        excludeFromCashbox:true,
        cashboxExcluded:true,
        cajaChicaEliminada:true,
        cajaChicaEliminadaAt:serverTimestamp(),
        cajaChicaEliminadaAtMs:Date.now(),
        cajaChicaEliminadaByUid:safe(state.user?.uid || window.ExploraSession?.authUser?.uid),
        cajaChicaEliminadaReason:"Borrado manual desde panel administrador",
        updatedAt:serverTimestamp(),
        updatedAtMs:Date.now(),
        updatedByUid:safe(state.user?.uid || window.ExploraSession?.authUser?.uid)
      });
    } else {
      if (snap.exists()) await deleteDoc(movementRef);
      for (const receiptIndex of receiptIndexes) await deleteDoc(doc(state.db, "receipt_index", receiptIndex.id));
    }
    const adminUid = safe(state.user?.uid || window.ExploraSession?.authUser?.uid || window.ExploraFirebase?.auth?.currentUser?.uid);
    await setDoc(doc(state.db, "admin_audit", `financial_delete_${Date.now()}_${documentId}`), {
      action:"admin_delete_financial_movement",
      type,
      collectionName,
      documentId,
      driverUid,
      adminUid,
      reason:type === "caja_chica" ? "Caja chica excluida desde panel administrador" : "Eliminado desde Comprobantes por el administrador",
      amount:amountOf(movement),
      method:methodOf(movement),
      closuresAdjusted,
      deletedFiles,
      deletedReceiptIndexes:receiptIndexes.length,
      direct:true,
      createdAt:serverTimestamp(),
      createdAtMs:Date.now(),
      version:VERSION
    }, { merge:false }).catch(error => console.warn("EXPLORA_ADMIN_DELETE_AUDIT_SKIP", error?.code || error?.message || error));
    return { ok:true, direct:true, closuresAdjusted, deletedFiles, deletedReceiptIndexes:receiptIndexes.length };
  }

  function adminDeleteCallableShouldFallback(error) {
    const code = safe(error?.code || error?.details?.code).toLowerCase();
    const message = safe(error?.message).toLowerCase();
    return !code || code.includes("not-found") || code.includes("unavailable") || code.includes("deadline") || code.includes("internal") || code.includes("functions") || message.includes("not found") || message.includes("no está disponible") || message.includes("deadline") || message.includes("network");
  }

  function adminDeleteCanTryServerAfterDirect(error) {
    const code = safe(error?.code).toLowerCase();
    const message = safe(error?.message).toLowerCase();
    return code.includes("permission") || code.includes("denied") || message.includes("permission") || message.includes("permisos") || message.includes("insufficient");
  }

  async function adminDeleteCallServerOrDirect(payload) {
    try {
      return await adminDeleteFinancialDirect(payload);
    } catch (directError) {
      const fb = window.ExploraFirebase || {};
      if (!fb.functions || !fb.httpsCallable || !adminDeleteCanTryServerAfterDirect(directError)) throw directError;
      console.warn("EXPLORA_ADMIN_DELETE_DIRECT_FALLBACK_TO_CALLABLE", directError?.code || directError?.message || directError);
      const callable = fb.httpsCallable(fb.functions, "adminDeleteFinancialMovement", { timeout: 30000 });
      const response = await callable({ ...payload, reason:"Borrado manual desde panel administrador" });
      return { ...(response?.data || {}), direct:false };
    }
  }

  async function deleteFinancialMovementFromReceipts(payload = {}) {
    if (!isAdmin()) throw new Error("Solo el administrador puede eliminar comprobantes.");
    const type = safe(payload.type);
    const documentId = safe(payload.documentId);
    const driverUid = safe(payload.driverUid);
    if (!documentId || !driverUid || !["cobro","gasto"].includes(type)) throw new Error("No se pudo identificar el comprobante a eliminar.");
    const result = await adminDeleteCallServerOrDirect({ type, documentId, driverUid, reason:safe(payload.reason || "Eliminado desde Comprobantes por el administrador") });
    await refreshOpenData("receipt-financial-delete");
    return result;
  }

  window.ExploraAdminFinancialMovements = {
    ...(window.ExploraAdminFinancialMovements || {}),
    deleteMovement:deleteFinancialMovementFromReceipts
  };

  async function submitAdminDeleteMovement(documentId = "", type = "", sourceButton = null) {
    if (!isAdmin()) throw new Error("Solo el administrador puede borrar movimientos.");
    const uid = getDriverUid();
    if (!uid) throw new Error("Seleccioná un chofer antes de borrar.");
    const cleanType = safe(type);
    const cleanId = safe(documentId);
    if (!cleanId) throw new Error("No se encontró el ID del movimiento.");
    const label = cleanType === "caja_chica" ? "la caja chica" : cleanType === "gasto" ? "el gasto" : "el cobro";
    const ok = window.confirm(`¿Borrar ${label}?\n\nEsta acción modifica Firestore y recalcula los cierres relacionados.`);
    if (!ok) return;
    state.adminDeleteBusy = true;
    state.adminDeleteBusyKey = `${cleanType}:${cleanId}`;
    if (sourceButton) {
      sourceButton.disabled = true;
      sourceButton.textContent = "Borrando…";
    }
    setAdminDeleteMessage("Borrando y ajustando cierre… No cierres esta pantalla.");
    adminDeleteScrollTop();
    renderAdminDeleteModal();
    try {
      const result = await adminDeleteCallServerOrDirect({ type:cleanType, documentId:cleanId, driverUid:uid });
      await refreshOpenData("admin-delete-financial-movement");
      setAdminDeleteMessage(`Listo. Movimiento borrado. Cierres ajustados: ${number(result.closuresAdjusted || 0)}${result.direct ? " · modo Firestore directo" : ""}.`, "ok");
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(35);
      renderAdminDeleteModal();
      adminDeleteScrollTop();
    } catch (error) {
      const msg = error?.message || "No se pudo borrar el movimiento.";
      setAdminDeleteMessage(msg, "error");
      adminDeleteScrollTop();
      window.alert(msg);
      throw error;
    } finally {
      state.adminDeleteBusy = false;
      state.adminDeleteBusyKey = "";
      renderAdminDeleteModal();
    }
  }

  function renderMoreScreen() {
    const name = isAdmin() ? accountName() : displayName();
    const roleLabel = isAdmin() ? "Administrador" : "Chofer";
    const subtitle = $("payMoreSubtitle");
    const moreName = $("payMoreName");
    const moreRole = $("payMoreRole");
    if (subtitle) subtitle.textContent = isAdmin() ? "Panel blanco de accesos rápidos administrativos." : "Accesos rápidos de tu cuenta Explora.";
    if (moreName) moreName.textContent = name;
    if (moreRole) moreRole.textContent = roleLabel;
    const list = $("payMoreList");
    const items = moreItems();
    if (list) {
      list.dataset.moreRole = isAdmin() ? "admin" : "driver";
      list.dataset.moreCount = String(items.length);
      list.innerHTML = items.map(item => `
        <button class="pay-more-row ${item.tone === "danger" ? "pay-more-row--danger" : ""}" data-pay-more-action="${esc(item.action)}" type="button">
          <span class="pay-more-row-icon">${moreIcon(item.icon)}</span>
          <span class="pay-more-row-copy"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></span>
          <span class="pay-more-chevron">›</span>
        </button>
      `).join("");
    }
    const adminList = $("payMoreAdminList");
    if (adminList) {
      adminList.hidden = true;
      adminList.innerHTML = "";
    }
  }

  function renderAdminDriverPicker() {
    const picker = $("payAdminDriverPicker");
    const select = $("payAdminDriverSelect");
    const typeSelect = $("payAdminTypeSelect");
    const hint = $("payAdminDriverHint");
    if (!picker || !select) return;
    picker.hidden = !isAdmin();
    if (!isAdmin()) return;
    const current = safe(state.selectedDriverUid);
    const options = [`<option value="">Todos los choferes</option>`].concat(state.drivers.map(driver => `<option value="${esc(driver.uid)}">${esc(driver.name)}</option>`));
    select.innerHTML = options.join("");
    select.value = current;
    if (typeSelect) {
      typeSelect.innerHTML = ADMIN_ACTIVITY_TYPES.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
      typeSelect.value = safe(state.adminActivityType);
    }
    const typeLabel = ADMIN_ACTIVITY_TYPES.find(([value]) => value === safe(state.adminActivityType))?.[1] || "Todos los tipos";
    if (hint) hint.textContent = current
      ? `Vista admin: ${state.selectedDriverName || "chofer seleccionado"} · ${typeLabel}.`
      : `Vista admin: todos los choferes · ${typeLabel}.`;
  }

  function selectAdminActivityType(value = "") {
    const next = safe(value);
    state.adminActivityType = ADMIN_ACTIVITY_TYPES.some(([key]) => key === next) ? next : "";
    render();
  }

  function selectAdminDriver(uid = "") {
    const nextUid = safe(uid);
    const driver = state.drivers.find(item => item.uid === nextUid);
    state.selectedDriverUid = nextUid;
    state.selectedDriverName = driver?.name || "";
    state.records = [];
    state.expenses = [];
    state.closures = [];
    state.debts = [];
    state.debtPayments = [];
    state.pendingClosure = null;
    state.previousDetailsOpen = { chofer:false, explora:false, gastos:false, caja_chica:false, pendientes:false };
    resetTabAlertScope();
    render();
    startRealtime("admin-driver-selected");
  }

  function logoutFromMore() {
    if (window.ExploraActions?.salir) { window.ExploraActions.salir(); return; }
    const explicit = $("exploraRoleLogout");
    if (explicit) { explicit.click(); return; }
    const oldLogout = Array.from(document.querySelectorAll('[data-action="salir"], .logout-pill-real')).find(el => !el.closest("#payMoreScreen"));
    if (oldLogout) oldLogout.click();
  }

  function isPlaceholderDriverProfile(data = {}, id = "") {
    const tokens = new Set(["usuario", "user", "chofer usuario", "usuario chofer", "chofer-usuario"]);
    return [id, data.id, data.uid, data.authUid, data.firebaseUid, data.userId, data.usuario, data.username, data.nombre, data.nombreCompleto, data.displayName, data.name]
      .some(value => tokens.has(safe(value).toLowerCase()));
  }

  async function fetchDrivers() {
    if (!state.db) return [];
    const collections = ["choferes", "usuarios"];
    const map = new Map();
    for (const name of collections) {
      try {
        const snap = await getDocs(query(collection(state.db, name), limit(300)));
        snap.forEach(item => {
          const data = item.data() || {};
          const role = driverRole(data);
          const uid = safe(data.uid || data.authUid || data.driverUid || data.choferUid || data.userId || item.id);
          const driverName = safe(data.nombre || data.nombreCompleto || data.displayName || data.name);
          if (!uid || EXPLORA_ADMIN_UIDS.has(uid) || EXPLORA_ADMIN_UIDS.has(item.id)) return;
          if (role !== "chofer") return;
          if (isPlaceholderDriverProfile(data, item.id)) return;
          if (!driverIsActive(data)) return;
          if (!driverName) return;
          map.set(uid, { uid, id:item.id, collection:name, name:driverName, role, profile:data });
        });
      } catch (error) { console.warn("EXPLORA_PAY_DRIVERS_READ", name, error?.code || error?.message); }
    }
    state.drivers = Array.from(map.values()).sort((a,b)=>a.name.localeCompare(b.name, "es"));
    return state.drivers;
  }

  function scopedQuery(collectionName, uid, max = 180) {
    const col = collection(state.db, collectionName);
    if (isAdmin() && !uid) {
      // Los cierres deben escucharse completos. Un limit() sin orderBy puede dejar fuera
      // una solicitud nueva según el ID interno de Firestore, aunque el chofer la haya
      // creado correctamente. Eso hacía que el administrador no viera Aceptar/Rechazar.
      if (collectionName === "cierres_semanales") return query(col);
      return query(col, limit(max));
    }
    return query(col, where("driverUid", "==", uid || getDriverUid()));
  }

  async function getGlobalDocs(collectionName, max = 300) {
    try {
      const col = collection(state.db, collectionName);
      const globalQuery = collectionName === "cierres_semanales" ? query(col) : query(col, limit(max));
      const snap = await getDocs(globalQuery);
      return snap.docs.map(item => ({ id:item.id, ...item.data() }));
    } catch (error) {
      console.warn("EXPLORA_PAY_GLOBAL_READ", collectionName, error?.code || error?.message);
      return [];
    }
  }

  function promiseTimeout(promise, timeoutMs = 9000, label = "consulta") {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} demoró demasiado`)), timeoutMs))
    ]);
  }

  async function getScopedDocs(collectionName, uid) {
    const targetUid = safe(uid);
    if (!targetUid || !state.db) return [];
    const fields = ["driverUid", "choferUid", "uid", "ownerUid", "driverId", "choferId", "driver_id", "chofer_id", "userUid", "userId", "createdByUid", "ownerId", "conductorUid", "conductorId", "assignedDriverUid"];
    const map = new Map();
    const tasks = fields.map(async field => {
      try {
        const snap = await promiseTimeout(getDocs(query(collection(state.db, collectionName), where(field, "==", targetUid), limit(900))), 9000, `${collectionName}.${field}`);
        snap.forEach(docSnap => map.set(docSnap.id, { id:docSnap.id, ...docSnap.data() }));
      } catch (error) {
        console.warn("EXPLORA_PAY_HISTORY_QUERY", collectionName, field, error?.code || error?.message || error);
      }
    });
    await Promise.allSettled(tasks);
    return Array.from(map.values());
  }

  function listenCollection(collectionName, targetArray, uid, onReady = null) {
    try {
      const targetUid = safe(uid || getDriverUid());
      if (!targetUid) {
        return onSnapshot(scopedQuery(collectionName, targetUid), snap => {
          state[targetArray] = snap.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b)=>rowMs(b)-rowMs(a));
          if (["billing_records", "gastos", "deudas_choferes", "deuda_pagos"].includes(collectionName)) registerTabAlertMovements(collectionName, state[targetArray]);
          scheduleFinancialRender();
          onReady?.();
        }, error => {
          console.warn(`EXPLORA_PAY_LISTENER_${collectionName}`, error?.code || error?.message);
          onReady?.();
        });
      }

      // v4126: ruta crítica canónica. Todos los movimientos nuevos de EXPLORA
      // guardan driverUid; usar 14 alias-listeners por colección generaba hasta
      // 84 listeners simultáneos, múltiples renders y mucha latencia/jank en iPhone.
      // Un listener canónico por colección deja el arranque en solo 6 listeners.
      const canonicalQuery = query(collection(state.db, collectionName), where("driverUid", "==", targetUid), limit(300));
      let readySent = false;
      const unsub = onSnapshot(canonicalQuery, snap => {
        state[targetArray] = snap.docs.map(d => ({ id:d.id, ...d.data() })).sort((a,b)=>rowMs(b)-rowMs(a));
        if (["billing_records", "gastos", "deudas_choferes", "deuda_pagos"].includes(collectionName)) registerTabAlertMovements(collectionName, state[targetArray]);
        scheduleFinancialRender();
        if (!readySent) { readySent = true; onReady?.(); }
      }, error => {
        console.warn(`EXPLORA_PAY_LISTENER_${collectionName}_driverUid`, error?.code || error?.message);
        if (!readySent) { readySent = true; onReady?.(); }
      });
      return unsub;
    } catch (error) {
      console.warn(`EXPLORA_PAY_LISTENER_SETUP_${collectionName}`, error?.code || error?.message);
      onReady?.();
      return null;
    }
  }

  function startRealtime(reason = "start", options = {}) {
    if (!state.db || !state.user) return;
    clearListeners();
    const generation = options.preserveConfirmed === true
      ? (state.dataLoading = false, state.realtimeGeneration += 1, state.realtimeReady = new Set(REALTIME_COLLECTIONS), state.realtimeGeneration)
      : beginFinancialDataLoading({ clearValues:true });
    const ready = collectionName => markFinancialCollectionReady(collectionName, generation);
    const uid = getDriverUid();
    if (isAdmin()) {
      fetchDrivers().then(() => {
        if (state.selectedDriverUid && !state.drivers.some(driver => driver.uid === state.selectedDriverUid)) {
          state.selectedDriverUid = "";
          state.selectedDriverName = "";
        }
        render();
      }).catch(()=>{});
      if (!uid) {
        state.pendingClosure = null;
        const unsubs = [
          listenCollection("billing_records", "records", "", () => ready("billing_records")),
          listenCollection("gastos", "expenses", "", () => ready("gastos")),
          listenCollection("cierres_semanales", "closures", "", () => ready("cierres_semanales")),
          listenCollection("deudas_choferes", "debts", "", () => ready("deudas_choferes")),
          listenCollection("uber_weekly_closures", "uberWeeks", "", () => ready("uber_weekly_closures")),
          listenCollection("deuda_pagos", "debtPayments", "", () => ready("deuda_pagos"))
        ].filter(Boolean);
        state.unsubscribers.push(...unsubs);
        render();
        console.info("EXPLORA_PAY_REALTIME", VERSION, reason, "admin-global-activity");
        return;
      }
    }
    const unsubs = [
      listenCollection("billing_records", "records", uid, () => ready("billing_records")),
      listenCollection("gastos", "expenses", uid, () => ready("gastos")),
      listenCollection("cierres_semanales", "closures", uid, () => ready("cierres_semanales")),
      listenCollection("deudas_choferes", "debts", uid, () => ready("deudas_choferes")),
      listenCollection("uber_weekly_closures", "uberWeeks", uid, () => ready("uber_weekly_closures")),
      listenCollection("deuda_pagos", "debtPayments", uid, () => ready("deuda_pagos"))
    ].filter(Boolean);
    state.unsubscribers.push(...unsubs);
    console.info("EXPLORA_PAY_REALTIME", VERSION, reason, uid || "no-driver");
  }

  function closureCutMs(row = {}) {
    // El corte operativo queda fijado cuando se pide el cierre.
    // Subir el comprobante cierra el trámite, pero NO debe mover el corte ni borrar movimientos cargados después.
    const explicitCutoff = Number(row.cutoffAtMs || 0) || ms(row.cutoffAt);
    if (explicitCutoff > 0) return explicitCutoff;
    const requestedCutoff = Number(row.requestedAtMs || 0) || ms(row.requestedAt) || Number(row.createdAtMs || 0) || ms(row.createdAt);
    if (requestedCutoff > 0) return requestedCutoff;
    return Math.max(
      Number(row.driverUploadedAtMs || 0), Number(row.adminUploadedAtMs || 0), Number(row.receiptUploadedAtMs || 0),
      Number(row.confirmedAtMs || 0), Number(row.closedAtMs || 0),
      ms(row.driverUploadedAt), ms(row.adminUploadedAt), ms(row.receiptUploadedAt), ms(row.confirmedAt), ms(row.closedAt), rowMs(row)
    );
  }

  function lastClosureMs(rows, kind = state.tab) {
    const target = activeClosureKind(kind);
    if (!target) return 0;
    const cuts = rows
      .filter(closureUsesActiveCutoff)
      .filter(row => {
        // Cada módulo corta su propio período abierto.
        // Facturación agrupa Chofer+Explora; Caja chica se reinicia por su corte automático v4077 y Gastos sigue independiente.
        // v4079: un cierre rechazado nunca puede seguir actuando como corte, aunque algún campo legado conserve "requested".
        return closureMatchesIndependentModule(row, target);
      })
      .map(closureCutMs)
      .filter(Boolean)
      .sort((a,b)=>b-a);
    return cuts[0] || 0;
  }

  function lastBillingClosureMs(rows = []) {
    return lastClosureMs(rows, "facturacion");
  }

  function pendingClosureFor(uid = getDriverUid(), kind = state.tab) {
    const targetUid = safe(uid);
    const target = activeClosureKind(kind);
    if (!target) return null;
    if (isAdmin() && !targetUid) return null;
    const pending = state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => !closureInvalidatesCutoff(row))
      .filter(row => closureMatchesIndependentModule(row, target))
      .filter(row => !targetUid || closureBelongsToDriver(row, targetUid))
      .filter(row => !/confirmed|completed|closed|cerrado|al_dia|al día|pagado/i.test(closureInvalidationText(row)))
      .sort((a,b)=>rowMs(b)-rowMs(a));
    return pending[0] || null;
  }

  function pendingModuleClosureFor(uid = getDriverUid(), kind = state.tab) {
    const targetUid = safe(uid);
    const target = mapModuleKey(kind);
    if (!target) return null;
    if (isAdmin() && !targetUid) return null;
    return state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => !closureInvalidatesCutoff(row))
      .filter(row => closureMatchesIndependentModule(row, target))
      .filter(row => !targetUid || closureBelongsToDriver(row, targetUid))
      .filter(row => !/confirmed|completed|closed|cerrado|al_dia|al día|pagado/i.test(closureInvalidationText(row)))
      .sort((a,b)=>rowMs(b)-rowMs(a))[0] || null;
  }

  function pendingClosureRows(uid = notificationDriverUid()) {
    const targetUid = safe(uid);
    const rows = state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => !closureInvalidatesCutoff(row))
      .filter(row => !/confirmed|completed|closed|cerrado|al_dia|al día|pagado/i.test(closureInvalidationText(row)))
      .filter(row => targetUid ? closureBelongsToDriver(row, targetUid) : isAdmin())
      .filter(row => closureActionForViewer(row) !== "none")
      .sort((a,b)=>rowMs(b)-rowMs(a));
    const unique = new Map();
    for (const row of rows) unique.set(safe(row.id || `${closureHomeModuleOf(row) || closureKindOf(row)}_${rowMs(row)}`), row);
    return Array.from(unique.values());
  }

  function pendingHomeClosureFor(uid = getDriverUid(), kind = state.tab) {
    const targetUid = safe(uid);
    if (isAdmin() && !targetUid) return null;
    return state.closures
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => !closureInvalidatesCutoff(row))
      .filter(row => !/confirmed|completed|closed|cerrado|al_dia|al día|pagado/i.test(closureInvalidationText(row)))
      .filter(row => closureMatchesHomeModule(row, kind))
      .filter(row => !targetUid || closureBelongsToDriver(row, targetUid))
      .filter(row => closureActionForViewer(row) !== "none")
      .sort((a,b)=>rowMs(b)-rowMs(a))[0] || null;
  }

  function closureResultText(closure = {}) {
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    const kind = activeClosureKind(closureKindOf(closure));
    if (due > 0) return `Chofer debe liquidar a Explora ${currency(due)}`;
    if (toDriver > 0) return `Explora debe liquidar a chofer ${currency(toDriver)}`;
    return "Nadie debe liquidar";
  }

  function closureTimeLabel(row = {}) {
    const at = rowMs(row) || Date.now();
    const now = Date.now();
    const sameDay = new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit", year:"numeric" }).format(at) === new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit", year:"numeric" }).format(now);
    if (sameDay) return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, hour:"2-digit", minute:"2-digit" }).format(at);
    return new Intl.DateTimeFormat("es-AR", { timeZone:AR_TZ, day:"2-digit", month:"2-digit" }).format(at);
  }


  function closureHasProof(closure = {}) {
    return !!safe(closure.receiptUrl || closure.driverReceiptUrl || closure.adminReceiptUrl || closure.davidReceiptUrl || closure.comprobanteUrl || closure.receiptPath || closure.driverReceiptPath || closure.adminReceiptPath);
  }

  function closureProofUrl(closure = {}) {
    return safe(closure.receiptUrl || closure.driverReceiptUrl || closure.adminReceiptUrl || closure.davidReceiptUrl || closure.comprobanteUrl || "");
  }

  function closureStatusText(closure = {}) {
    const status = safe(closure.status || closure.estado || closure.statusLabel).toLowerCase();
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    const proof = closureHasProof(closure);
    if (closureIsRejected(closure)) return "Cierre no aceptado por Explora · período restaurado";
    if (/confirmed|confirmado|completed|closed|cerrado|al_dia|al día|pagado/.test(status)) return "Cierre completo";
    if (due > 0 && proof) return "El chofer ya liquidó, chequea el comprobante en tus notificaciones.";
    if (toDriver > 0 && proof) return "Explora ya liquidó, chequea el comprobante en tus notificaciones.";
    if (due > 0) return "Falta que el chofer liquide y envíe comprobante";
    if (toDriver > 0) return "Falta que Explora liquide y envíe comprobante";
    return "Cierre solicitado";
  }

  function closureIsRejected(closure = {}) {
    return closureInvalidatesCutoff(closure);
  }

  function closureIsCompleted(closure = {}) {
    const status = safe(closure.status || closure.estado || closure.statusLabel).toLowerCase();
    return !closureIsRejected(closure) && /confirmed|confirmado|completed|closed|cerrado|al_dia|al día|pagado/.test(status);
  }

  function canAdminRejectClosure(closure = {}) {
    if (!isAdmin() || !closure?.id) return false;
    if (safe(closure.closureMode || closure.periodType) !== "on_demand") return false;
    if (closureIsCompleted(closure) || closureIsRejected(closure) || closureHasProof(closure)) return false;
    return true;
  }

  function closureActivityStateText(closure = {}) {
    if (closureIsRejected(closure)) return "NO ACEPTADO";
    return closureIsCompleted(closure) ? "CERRADO" : "ABIERTO";
  }

  function closureActivityMeta(closure = {}) {
    if (closureIsRejected(closure)) return "NO ACEPTADO · Período restaurado";
    const stateText = closureActivityStateText(closure);
    const statusText = closureStatusText(closure);
    return stateText === "CERRADO" ? "CERRADO · Cierre completo" : `ABIERTO · ${statusText}`;
  }

  function closurePayerClass(closure = {}) {
    // v4078: abierto rojo, cerrado verde y cierre no aceptado en gris neutro.
    if (closureIsRejected(closure)) return "is-closure-rejected";
    return closureIsCompleted(closure) ? "is-closure-closed" : "is-closure-open";
  }

  function closureActionForViewer(closure = {}) {
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const proof = closureHasProof(closure);
    if (closureIsCompleted(closure) || closureIsRejected(closure)) return "none";
    if (isAdmin()) {
      const targetUid = notificationDriverUid();
      if (targetUid && !closureBelongsToDriver(closure, targetUid)) return "none";
      // Todo cierre con liquidación queda a cargo del administrador: cuando el pago
      // ya fue realizado o recibido, Explora carga la foto y cierra el período.
      if ((due > 0 || toDriver > 0) && !proof) return "admin_upload";
      if ((due > 0 || toDriver > 0) && proof) return "admin_review";
      return "view";
    }
    const driverUid = getOwnDriverUid();
    if (!driverUid || !closureBelongsToDriver(closure, driverUid)) return "none";
    if (due > 0 || toDriver > 0) return "driver_waiting_admin";
    return "view";
  }

  function closureYellowBannerMessage(closure = {}) {
    if (!closure || closureIsCompleted(closure)) return null;
    const action = closureActionForViewer(closure);
    if (action === "none" || action === "view") return null;
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    const proof = closureHasProof(closure);
    if (toDriver > 0) {
      return proof
        ? "Explora ya liquidó, chequea el comprobante en tus notificaciones."
        : "Falta que Explora liquide y envíe comprobante";
    }
    if (due > 0) {
      return proof
        ? "El chofer ya liquidó, chequea el comprobante en tus notificaciones."
        : "Falta que el chofer liquide y envíe comprobante";
    }
    return null;
  }

  function homePendingClosureCardData(closure = {}, kind = state.tab, uid = getDriverUid()) {
    const target = activeClosureKind(kind);
    const targetUid = safe(uid);
    if (!closure || !["caja_chica", "gastos", "explora", "chofer"].includes(target)) return null;
    if (isAdmin() && !targetUid) return null;
    if (closureIsCompleted(closure)) return null;
    if (safe(closure.closureMode || closure.periodType) !== "on_demand") return null;
    if (!closureMatchesHomeModule(closure, target)) return null;
    if (targetUid && !closureBelongsToDriver(closure, targetUid)) return null;
    const action = closureActionForViewer(closure);
    if (!action || action === "none" || action === "view") return null;
    const message = safe(closureYellowBannerMessage(closure));
    if (!message) return null;
    const due = number(closure.amountDueFromDriver || closure.amountFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || closure.amountToDriver || 0);
    const amount = Math.max(due, toDriver);
    const title = `${closureTitle(closureHomeModuleOf(closure) || closureKindOf(closure))}${amount > 0 ? ` · ${currency(amount)}` : ""}`;
    if (!safe(title)) return null;
    return { closure, message, title, action, amount };
  }


  function updateLocalDriverProfileState(uid = getDriverUid(), fields = {}) {
    const targetUid = safe(uid);
    if (!targetUid) return;
    if (targetUid === getOwnDriverUid()) state.profile = { ...(state.profile || {}), ...fields };
    const driver = state.drivers.find(item => item.uid === targetUid);
    if (driver) driver.profile = { ...(driver.profile || {}), ...fields };
  }

  function driverDocCandidates(uid = getDriverUid()) {
    const targetUid = safe(uid);
    const candidates = [];
    const add = (collectionName, id) => {
      const docId = safe(id);
      if (!collectionName || !docId) return;
      const key = `${collectionName}/${docId}`;
      if (!candidates.some(item => item.key === key)) candidates.push({ key, collectionName, id:docId });
    };
    const driver = state.drivers.find(item => item.uid === targetUid);
    if (driver?.collection && driver?.id) add(driver.collection, driver.id);
    if (driver?.id) { add("choferes", driver.id); add("usuarios", driver.id); }
    if (targetUid === getOwnDriverUid() && state.profileDocumentId) { add("choferes", state.profileDocumentId); add("usuarios", state.profileDocumentId); }
    add("choferes", targetUid);
    add("usuarios", targetUid);
    return candidates;
  }


  function firstProfileValue(profile = {}, fields = []) {
    for (const field of fields) {
      const value = profile?.[field];
      if (value === null || value === undefined || value === "") continue;
      if (typeof value === "object") continue;
      const text = safe(value);
      if (text) return text;
    }
    return "";
  }

  const WHATSAPP_COUNTRY_OPTIONS = [
    { value:"549", label:"🇦🇷 +549", placeholder:"3757461564" },
    { value:"595", label:"🇵🇾 +595", placeholder:"991123456" },
    { value:"55", label:"🇧🇷 +55", placeholder:"45912345678" },
    { value:"598", label:"🇺🇾 +598", placeholder:"99123456" }
  ];

  function rawWhatsappDigits(value = "") {
    let digits = safe(value).replace(/\D+/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    return digits.replace(/^0+/, "");
  }

  function whatsappCountryOptionsHtml(selected = "549") {
    const current = safe(selected) || "549";
    return WHATSAPP_COUNTRY_OPTIONS.map(option => `<option value="${esc(option.value)}" ${option.value === current ? "selected" : ""}>${esc(option.label)}</option>`).join("");
  }

  function whatsappCountryPlaceholder(country = "549") {
    return WHATSAPP_COUNTRY_OPTIONS.find(option => option.value === safe(country))?.placeholder || "3757461564";
  }

  function splitWhatsappPhone(value = "", profile = {}) {
    const storedCountry = rawWhatsappDigits(profile?.whatsappCountryCode || profile?.codigoPaisWhatsapp || profile?.telefonoPais || profile?.phoneCountryCode || "");
    const storedLocal = rawWhatsappDigits(profile?.whatsappLocalNumber || profile?.telefonoLocal || profile?.phoneLocal || "");
    if (storedCountry && storedLocal) return { country:storedCountry, local:storedLocal, full:`${storedCountry}${storedLocal}` };
    const digits = rawWhatsappDigits(value);
    if (/^(2|3)\d{9}$/.test(digits)) return { country:"549", local:digits, full:`549${digits}` };
    if (/^54(2|3)\d{9}$/.test(digits)) return { country:"549", local:digits.slice(2), full:`549${digits.slice(2)}` };
    if (/^549(2|3)\d{9}$/.test(digits)) return { country:"549", local:digits.slice(3), full:digits };
    for (const option of WHATSAPP_COUNTRY_OPTIONS) {
      if (digits.startsWith(option.value) && digits.length > option.value.length) {
        return { country:option.value, local:digits.slice(option.value.length), full:digits };
      }
    }
    return { country:"549", local:digits, full:digits ? `549${digits}` : "" };
  }

  function composeWhatsappPhone(country = "549", local = "") {
    const prefix = rawWhatsappDigits(country) || "549";
    const digits = rawWhatsappDigits(local);
    if (!digits) return "";
    if (prefix === "549") {
      if (/^549(2|3)\d{9}$/.test(digits)) return digits;
      if (/^54(2|3)\d{9}$/.test(digits)) return `549${digits.slice(2)}`;
      if (/^(2|3)\d{9}$/.test(digits)) return `549${digits}`;
    }
    if (digits.startsWith(prefix) && digits.length > prefix.length) return digits;
    return `${prefix}${digits.replace(/^0+/, "")}`;
  }

  function profileWhatsappParts(profile = {}) {
    const raw = firstProfileValue(profile, ["whatsappNormalized", "whatsappFull", "telefono", "teléfono", "phone", "celular", "mobile", "whatsapp", "numeroTelefono", "numeroDeTelefono"]);
    return splitWhatsappPhone(raw, profile);
  }

  function driverFullNameFromProfile(profile = state.profile) {
    return firstProfileValue(profile, ["nombreCompleto", "fullName", "nombre", "displayName", "name", "email"]) || displayName();
  }

  function driverCarLabel(profile = state.profile) {
    const model = firstProfileValue(profile, ["autoModelo", "modeloAuto", "vehicleModel", "carModel", "modelo", "auto", "vehiculo", "rodado"])
      || safe(profile?.auto?.modelo || profile?.vehiculo?.modelo || profile?.car?.model);
    const plate = firstProfileValue(profile, ["patente", "plate", "dominio", "licensePlate", "autoPatente", "vehiclePlate"])
      || safe(profile?.auto?.patente || profile?.vehiculo?.patente || profile?.car?.plate);
    const label = [model, plate].filter(Boolean).join(" · ");
    return label || "Sin auto asignado";
  }

  function driverPaymentProfile(profile = state.profile) {
    const phoneParts = profileWhatsappParts(profile);
    return {
      fullName:driverFullNameFromProfile(profile),
      car:driverCarLabel(profile),
      phone:phoneParts.full || firstProfileValue(profile, ["telefono", "teléfono", "phone", "celular", "mobile", "whatsapp", "numeroTelefono", "numeroDeTelefono"]),
      phoneCountry:phoneParts.country || "549",
      phoneLocal:phoneParts.local || "",
      cuit:firstProfileValue(profile, ["cuit", "CUIT", "cuil", "taxId", "dniFiscal"]),
      alias:firstProfileValue(profile, ["aliasCobro", "paymentAlias", "aliasParaCobrar", "alias", "mercadoPagoAlias", "aliasMp", "mpAlias"])
    };
  }

  function driverPaymentProfileForUid(uid = getDriverUid()) {
    const targetUid = safe(uid);
    const profile = targetUid && targetUid !== getOwnDriverUid()
      ? (state.drivers.find(driver => driver.uid === targetUid)?.profile || {})
      : (state.profile || {});
    return driverPaymentProfile(profile);
  }

  function paymentProfileMissingFields(data = driverPaymentProfile()) {
    const missing = [];
    if (!normalizeWhatsappPhone(data.phone)) missing.push("número de WhatsApp");
    if (!safe(data.cuit)) missing.push("CUIT");
    if (!safe(data.alias)) missing.push("alias para cobrar");
    return missing;
  }

  function displayPaymentPhone(value = "") {
    const raw = safe(value);
    if (!raw) return "Sin cargar";
    if (raw.startsWith("+")) return raw;
    const digits = normalizeWhatsappPhone(raw);
    return digits ? `+${digits}` : raw;
  }

  function driverPaymentFromClosure(closure = {}) {
    const uid = safe(closure.driverUid || closure.choferUid || closure.uid || getDriverUid());
    const fallback = driverPaymentProfileForUid(uid);
    return {
      alias:safe(closure.driverPaymentAlias || closure.choferAlias || closure.aliasChofer || fallback.alias),
      cuit:safe(closure.driverPaymentCuit || closure.choferCuit || closure.cuitChofer || fallback.cuit),
      phone:safe(closure.driverPaymentPhoneDisplay || closure.driverPaymentPhone || closure.choferTelefono || closure.telefonoChofer || fallback.phone)
    };
  }

  function exploraPaymentFromClosure(closure = {}) {
    return {
      alias:safe(closure.exploraPaymentAlias || EXPLORA_ALIAS),
      cuit:safe(closure.exploraPaymentCuit || EXPLORA_CUIT),
      phone:safe(closure.exploraPaymentPhone || closure.exploraPaymentWhatsapp || EXPLORA_WHATSAPP_DISPLAY)
    };
  }

  function closureContactCardHtml(title = "Datos", contact = {}) {
    return `<section class="pay-closure-contact-card"><h3>${esc(title)}</h3><div><span>Alias</span><strong>${esc(contact.alias || "Sin cargar")}</strong></div><div><span>CUIT</span><strong>${esc(contact.cuit || "Sin cargar")}</strong></div><div><span>Celular</span><strong>${esc(displayPaymentPhone(contact.phone || ""))}</strong></div></section>`;
  }

  function closureContactCardByDirection(direction = "balanced", { closure = {}, driverPayment = null } = {}) {
    if (direction === "explora_to_driver") return closureContactCardHtml("Datos del chofer", driverPayment || driverPaymentFromClosure(closure));
    if (direction === "driver_to_explora") return closureContactCardHtml("Datos de Explora", exploraPaymentFromClosure(closure));
    return "";
  }

  function requireOwnPaymentProfileComplete() {
    if (isAdmin()) return;
    const payment = driverPaymentProfile(state.profile || {});
    const missing = paymentProfileMissingFields(payment);
    if (missing.length) throw new Error(`Completá Mi perfil antes de pedir el cierre: ${missing.join(", ")}.`);
  }

  function closureAmountLine(summary = {}) {
    const fromDriver = number(summary.amountFromDriver || summary.amountDueFromDriver || 0);
    const toDriver = number(summary.amountToDriver || summary.amountDueToDriver || 0);
    if (toDriver > 0) return { direction:"explora_to_driver", label:"Explora debe liquidar al chofer", amount:toDriver };
    if (fromDriver > 0) return { direction:"driver_to_explora", label:"Chofer debe liquidar a Explora", amount:fromDriver };
    return { direction:"balanced", label:"Nadie debe liquidar", amount:0 };
  }

  function closurePaymentRowsHtml({ driverPayment = {}, direction = "balanced", closure = {} } = {}) {
    return closureContactCardByDirection(direction, { closure, driverPayment });
  }

  function closurePaymentDataForPayload(targetUid = getDriverUid(), summary = {}) {
    const driverPayment = driverPaymentProfileForUid(targetUid);
    const result = closureAmountLine(summary);
    return {
      driverPaymentPhone:safe(driverPayment.phone),
      driverPaymentPhoneDisplay:displayPaymentPhone(driverPayment.phone),
      driverPaymentCuit:safe(driverPayment.cuit),
      driverPaymentAlias:safe(driverPayment.alias),
      exploraPaymentAlias:EXPLORA_ALIAS,
      exploraPaymentCuit:EXPLORA_CUIT,
      exploraPaymentPhone:EXPLORA_WHATSAPP,
      exploraPaymentWhatsapp:EXPLORA_WHATSAPP_DISPLAY,
      paymentDirection:result.direction,
      paymentResultLabel:result.label,
      paymentResultAmount:Number(result.amount || 0)
    };
  }

  function paymentDataFromClosure(closure = {}) {
    const direction = safe(closure.paymentDirection) || (number(closure.amountDueToDriver || 0) > 0 ? "explora_to_driver" : number(closure.amountDueFromDriver || 0) > 0 ? "driver_to_explora" : "balanced");
    return {
      direction,
      driverPayment:{
        phone:safe(closure.driverPaymentPhoneDisplay || closure.driverPaymentPhone || closure.choferTelefono || closure.telefonoChofer),
        cuit:safe(closure.driverPaymentCuit || closure.choferCuit || closure.cuitChofer),
        alias:safe(closure.driverPaymentAlias || closure.choferAlias || closure.aliasChofer)
      }
    };
  }

  function closureTelegramNoticeText({ kind = state.tab, summary = {}, targetName = displayName(), targetUid = getDriverUid(), requestedBy = displayName() } = {}) {
    const result = closureAmountLine(summary);
    const driverPayment = driverPaymentProfileForUid(targetUid);
    const k = activeClosureKind(kind);
    const lines = [
      "*PEDIDO DE CIERRE EXPLORA*",
      `Chofer: ${targetName}`,
      `Pedido por: ${requestedBy}`,
      `Tipo: ${closureTitle(k)}`,
      `Resultado: *${result.label}${result.amount > 0 ? ` ${currency(result.amount)}` : ""}*`
    ];
    if (k === "gastos") {
      lines.push(`Gastos cargados: ${currency(summary.expenseTotal || 0)}`);
      lines.push(`Parte Explora: ${currency(summary.exploraExpenseShare || summary.amountToDriver || 0)}`);
    } else if (k === "caja_chica") {
      lines.push(`Efectivo base: ${currency(summary.gross || 0)}`);
      lines.push(`Caja chica 5%: ${currency(summary.cashboxTotal || summary.amountFromDriver || 0)}`);
    } else {
      lines.push(`Efectivo chofer: ${currency(summary.cashInDriver || 0)}`);
      lines.push(`Digital Explora: ${currency(summary.nonCashInExplora || 0)}`);
      lines.push(`Total facturado: ${currency(summary.gross || 0)}`);
      lines.push(`Parte de cada uno: ${currency(summary.billingShareEach || 0)}`);
      lines.push(`Caja chica acumulada incluida: ${currency(summary.billingCashboxGenerated || summary.cashboxTotal || 0)}`);
      if (number(summary.billingCashboxOffsetApplied || 0) > 0) {
        lines.push(`Caja chica descontada al chofer en el resultado final: −${currency(summary.billingCashboxOffsetApplied)}`);
      }
    }
    if (result.direction === "explora_to_driver") {
      lines.push("");
      lines.push("*Datos para pagar al chofer:* ");
      lines.push(`Alias: ${driverPayment.alias || "sin cargar"}`);
      lines.push(`CUIT: ${driverPayment.cuit || "sin cargar"}`);
      lines.push(`Celular: ${displayPaymentPhone(driverPayment.phone || "")}`);
    } else if (result.direction === "driver_to_explora") {
      lines.push("");
      lines.push("*Datos de Explora para recibir:* ");
      lines.push(`Alias: ${EXPLORA_ALIAS}`);
      lines.push(`CUIT David: ${EXPLORA_CUIT}`);
      lines.push(`Celular: ${displayPaymentPhone(EXPLORA_WHATSAPP_DISPLAY)}`);
    }
    lines.push("");
    lines.push("El comprobante se cargará por la app.");
    return lines.join("\n");
  }

  function normalizeWhatsappPhone(value = "") {
    const digits = rawWhatsappDigits(value);
    if (!digits) return "";
    if (/^(2|3)\d{9}$/.test(digits)) return `549${digits}`;
    if (/^54(2|3)\d{9}$/.test(digits)) return `549${digits.slice(2)}`;
    return digits;
  }

  function whatsappRuntimePlatform() {
    const ua = safe(navigator.userAgent || navigator.vendor || "").toLowerCase();
    const platform = safe(navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
    const isAndroid = /android/.test(ua) || /android/.test(platform);
    const isIOS = /iphone|ipad|ipod/.test(ua)
      || /iphone|ipad|ipod/.test(platform)
      || (platform === "macintel" && Number(navigator.maxTouchPoints || 0) > 1);
    return { isAndroid, isIOS };
  }

  function showAndroidWhatsappHandoff(phone = "", text = "") {
    const normalizedPhone = normalizeWhatsappPhone(phone);
    if (!normalizedPhone) return false;
    const message = String(text || "");
    const encodedText = encodeURIComponent(message);

    // Chrome para Android solo permite lanzar una app externa mediante intent:
    // cuando existe un gesto REAL del usuario. Los avisos de Explora ocurren
    // después de escrituras async en Firestore, por lo que el gesto original
    // ya se perdió. Mostramos un botón real para recuperar ese gesto.
    const intentUrl = `intent://send/?phone=${normalizedPhone}${encodedText ? `&text=${encodedText}` : ""}#Intent;scheme=whatsapp;package=com.whatsapp;end`;

    document.getElementById('exploraWhatsappAndroidHandoff')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'exploraWhatsappAndroidHandoff';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed','inset:0','z-index:2147483647','display:flex',
      'align-items:center','justify-content:center','padding:20px',
      'background:rgba(0,0,0,.62)','font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'width:min(92vw,420px)','background:#fff','border-radius:18px','padding:22px',
      'box-shadow:0 18px 55px rgba(0,0,0,.35)','color:#171717','text-align:center'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Mensaje listo';
    title.style.cssText = 'font-size:20px;font-weight:750;margin-bottom:8px';

    const body = document.createElement('div');
    body.textContent = `Tocá “Abrir WhatsApp” para enviarlo a +${normalizedPhone}.`;
    body.style.cssText = 'font-size:14px;line-height:1.4;color:#555;margin-bottom:18px';

    const open = document.createElement('a');
    open.href = intentUrl;
    open.target = '_blank';
    open.rel = 'noopener noreferrer external';
    open.textContent = 'Abrir WhatsApp';
    open.style.cssText = [
      'display:block','width:100%','box-sizing:border-box','padding:14px 16px',
      'border-radius:12px','background:#168a48','color:#fff','font-size:16px',
      'font-weight:750','text-decoration:none','margin-bottom:10px'
    ].join(';');
    open.addEventListener('click', () => {
      try { navigator.clipboard?.writeText?.(message); } catch (_) {}
      setTimeout(() => overlay.remove(), 1200);
    }, { once: true });

    const share = document.createElement('button');
    share.type = 'button';
    share.textContent = 'Compartir mensaje';
    share.style.cssText = [
      'display:block','width:100%','padding:12px 16px','border-radius:12px',
      'border:1px solid #d8d8d8','background:#fff','color:#222','font-size:15px',
      'font-weight:650','margin-bottom:8px'
    ].join(';');
    share.addEventListener('click', async () => {
      try {
        if (typeof navigator.share === 'function') {
          await navigator.share({ text: message });
          overlay.remove();
          return;
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
      try { await navigator.clipboard?.writeText?.(message); } catch (_) {}
      share.textContent = 'Mensaje copiado';
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cerrar';
    cancel.style.cssText = 'border:0;background:transparent;color:#666;padding:8px 12px;font-size:14px';
    cancel.addEventListener('click', () => overlay.remove());

    card.append(title, body, open, share, cancel);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    return true;
  }

  // V4135 · puente de WhatsApp para cierres iOS + Android.
  // El cierre escribe/sube datos de forma async. iOS Safari y algunos APK/WebView
  // bloquean una ventana externa creada recién DESPUÉS de esos await. Por eso el
  // botón de cierre reserva una ventana durante el gesto real del usuario y, una
  // vez confirmado Firebase, esa misma ventana se navega a wa.me.
  let preparedClosureWhatsappWindow = null;
  let preparedClosureWhatsappAtMs = 0;

  function clearPreparedClosureWhatsappWindow({ close = false } = {}) {
    const popup = preparedClosureWhatsappWindow;
    preparedClosureWhatsappWindow = null;
    preparedClosureWhatsappAtMs = 0;
    if (close && popup) {
      try { if (!popup.closed) popup.close(); } catch (_) {}
    }
  }

  function prepareClosureWhatsappWindowFromGesture() {
    if (!LEGACY_DIRECT_WHATSAPP_ENABLED) return false;
    clearPreparedClosureWhatsappWindow({ close:true });
    try {
      const popup = window.open("about:blank", "_blank");
      if (!popup || popup.closed) return false;
      preparedClosureWhatsappWindow = popup;
      preparedClosureWhatsappAtMs = Date.now();
      try {
        popup.document.title = "EXPLORA · WhatsApp";
        popup.document.body.innerHTML = '<main style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;text-align:center"><strong>EXPLORA</strong><p>Procesando cierre…</p></main>';
      } catch (_) {}
      return true;
    } catch (_) {
      clearPreparedClosureWhatsappWindow();
      return false;
    }
  }

  function usePreparedClosureWhatsappWindow(targetUrl = "") {
    const popup = preparedClosureWhatsappWindow;
    const age = Date.now() - Number(preparedClosureWhatsappAtMs || 0);
    clearPreparedClosureWhatsappWindow();
    if (!popup || age > 120000) {
      try { if (popup && !popup.closed) popup.close(); } catch (_) {}
      return false;
    }
    try {
      if (popup.closed) return false;
      popup.location.replace(targetUrl);
      try { popup.focus(); } catch (_) {}
      return true;
    } catch (_) {
      try {
        popup.location.href = targetUrl;
        return true;
      } catch (__) {
        try { popup.close(); } catch (___) {}
        return false;
      }
    }
  }

  function openWhatsappToPhone(phone = "", text = "") {
    if (!LEGACY_DIRECT_WHATSAPP_ENABLED) {
      clearPreparedClosureWhatsappWindow({ close:true });
      return false;
    }
    const normalizedPhone = normalizeWhatsappPhone(phone);
    if (!normalizedPhone) {
      clearPreparedClosureWhatsappWindow({ close:true });
      return false;
    }
    const message = String(text || "");
    const encodedText = encodeURIComponent(message);
    const targetUrl = `https://wa.me/${normalizedPhone}${encodedText ? `?text=${encodedText}` : ""}`;

    // Primer camino: ventana reservada directamente por el toque en PEDIR/CONFIRMAR
    // CIERRE. Funciona aunque después haya await de Firestore/Storage.
    if (usePreparedClosureWhatsappWindow(targetUrl)) return true;

    // Fallback universal iOS/Android/PWA/APK: navegación en la misma vista. No usa
    // popups tardíos ni api.whatsapp.com, que Safari puede bloquear tras un await.
    try {
      window.location.assign(targetUrl);
      return true;
    } catch (_) {
      try {
        window.location.href = targetUrl;
        return true;
      } catch (__) {
        // Último recurso para navegadores de escritorio.
        try {
          const link = document.createElement("a");
          link.href = targetUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer external";
          document.body.appendChild(link);
          link.click();
          link.remove();
          return true;
        } catch (___) {
          return false;
        }
      }
    }
  }

  function openWhatsappToExplora(text = "") {
    return openWhatsappToPhone(EXPLORA_WHATSAPP, text);
  }

  // Avisos operativos del chofer -> WhatsApp de Explora.
  // Se disparan únicamente después de que cobros/gastos confirman su escritura en Firestore.
  const operationalWhatsappSent = new Set();

  function operationalWhatsappReceiptUrl(row = {}) {
    return safe(
      row.whatsappPhotoUrl ||
      row.notificationPhotoUrl ||
      row.receiptUrl ||
      row.comprobanteUrl ||
      row.downloadURL ||
      row.fileUrl ||
      row.firebasePhotoUrl ||
      ""
    );
  }

  function operationalWhatsappDriverName(row = {}) {
    return safe(row.driverName || row.choferNombre || row.nombreChofer || displayName() || "Chofer");
  }

  function billingOperationalWhatsappText(row = {}) {
    const method = safe(row.paymentMethod || row.metodoPago || "cash").toLowerCase();
    const methodLabel = ({ cash:"Efectivo", transfer:"Transferencia", card:"Tarjeta", qr:"Código QR" })[method] || method || "Cobro";
    const amount = number(row.amount || row.monto || row.valor || row.finalPrice || 0);
    const receiptUrl = operationalWhatsappReceiptUrl(row);
    const lines = [
      "*NUEVO COBRO EXPLORA*",
      `Chofer: ${operationalWhatsappDriverName(row)}`,
      `Medio: *${methodLabel}*`,
      `Monto: *${currency(amount)}*`,
      `Fecha: ${safe(row.fecha || "—")}`,
      `Hora: ${safe(row.hora || "—")}`
    ];
    if (method !== "cash" && receiptUrl) {
      lines.push("");
      lines.push(`Ver comprobante: ${receiptUrl}`);
    }
    return lines.join("\n");
  }

  function expenseOperationalWhatsappText(row = {}) {
    const type = safe(row.expenseType || row.tipo || row.category || "gasto").toLowerCase();
    const typeLabel = ({
      combustible:"Combustible", fuel:"Combustible",
      lavado:"Lavado", wash:"Lavado",
      peaje:"Peaje", toll:"Peaje",
      estacionamiento:"Estacionamiento", parking:"Estacionamiento",
      mantenimiento:"Mantenimiento", maintenance:"Mantenimiento",
      otro:"Otro", otros:"Otros", other:"Otro"
    })[type] || safe(row.expenseType || row.tipo || row.category || "Gasto");
    const amount = number(row.amount || row.monto || row.valor || 0);
    const receiptUrl = operationalWhatsappReceiptUrl(row);
    const notes = safe(row.notes || row.nota || row.descripcion || "");
    const date = row.fechaISO ? new Date(row.fechaISO) : null;
    const dateText = date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString("es-AR", { timeZone:AR_TZ })
      : "—";
    const timeText = date && !Number.isNaN(date.getTime())
      ? date.toLocaleTimeString("es-AR", { timeZone:AR_TZ, hour:"2-digit", minute:"2-digit" })
      : "—";
    const lines = [
      "*NUEVO GASTO EXPLORA*",
      `Chofer: ${operationalWhatsappDriverName(row)}`,
      `Tipo: *${typeLabel}*`,
      `Monto: *${currency(amount)}*`,
      `Fecha: ${dateText}`,
      `Hora: ${timeText}`
    ];
    if (notes) lines.push(`Detalle: ${notes}`);
    if (receiptUrl) {
      lines.push("");
      lines.push(`Ver comprobante: ${receiptUrl}`);
    }
    return lines.join("\n");
  }

  function notifyOperationalWhatsapp(kind = "", row = {}, options = {}) {
    try {
      if (isAdmin()) return false;
      const normalizedKind = safe(kind).toLowerCase();
      const id = safe(row.operationId || row.billingId || row.expenseId || row.gastoId || row.id || "");
      const dedupeKey = `${normalizedKind}:${id || Date.now()}`;
      if (id && operationalWhatsappSent.has(dedupeKey)) return false;
      if (id) operationalWhatsappSent.add(dedupeKey);
      const text = normalizedKind === "expense"
        ? expenseOperationalWhatsappText(row)
        : billingOperationalWhatsappText(row);
      if (options?.immediate) return openWhatsappToExplora(text);
      window.setTimeout(() => openWhatsappToExplora(text), 180);
      return true;
    } catch (error) {
      console.warn("EXPLORA_OPERATIONAL_WHATSAPP", error?.message || error);
      return false;
    }
  }

  // API pública usada desde el botón ACEPTAR del modal de éxito.
  // Ejecutarlo dentro del toque del usuario mantiene la apertura vinculada al gesto del usuario.
  window.ExploraOperationalWhatsapp = Object.freeze({
    billing:(row = {}) => notifyOperationalWhatsapp("billing", row, { immediate:true }),
    expense:(row = {}) => notifyOperationalWhatsapp("expense", row, { immediate:true })
  });

  function closureDriverWhatsappPhone(closure = {}) {
    const uid = safe(closure.driverUid || closure.choferUid || closure.uid || getDriverUid());
    return safe(
      closure.driverPaymentPhone ||
      closure.choferTelefono ||
      closure.telefonoChofer ||
      closure.phone ||
      closure.whatsapp ||
      driverPaymentProfileForUid(uid).phone
    );
  }

  function closureReceiptLink(closure = {}, receipt = null) {
    return safe(
      receipt?.url ||
      closure.receiptUrl ||
      closure.adminReceiptUrl ||
      closure.driverReceiptUrl ||
      closure.comprobanteUrl ||
      closure.urlComprobante
    );
  }

  function closureNotifyAmount(closure = {}) {
    return Math.max(
      number(closure.paymentResultAmount || 0),
      number(closure.amountDueToDriver || 0),
      number(closure.amountDueFromDriver || 0),
      number(closure.amountToDriver || 0),
      number(closure.amountFromDriver || 0)
    );
  }

  function closureNotifyKindTitle(closure = {}) {
    const kind = closureKindOf(closure) || mapModuleKey(closure.moduleKey || closure.closureModuleKey || closure.requestModule || closure.homeModule || "") || "cierre";
    return closureTitle(kind).toLowerCase();
  }

  function adminPaidDriverWhatsappText({ closure = {}, receipt = null } = {}) {
    const driverName = closureDriverName(closure);
    const amount = closureNotifyAmount(closure);
    const link = closureReceiptLink(closure, receipt);
    const lines = [
      `Hola ${driverName}.`,
      `Explora informa que el pago al chofer por ${currency(amount)} ya fue enviado.`,
      `Tipo de cierre: ${closureNotifyKindTitle(closure)}.`,
      ""
    ];
    if (link) {
      lines.push("📎 Ver foto del comprobante:");
      lines.push(link);
      lines.push("");
    }
    lines.push("Por favor consultá tu cuenta.");
    lines.push("Muchas gracias por usar Explora.");
    return lines.join("\n");
  }

  function driverUploadedReceiptWhatsappText({ closure = {}, receipt = null } = {}) {
    const driverName = closureDriverName(closure);
    const amount = closureNotifyAmount(closure);
    const link = closureReceiptLink(closure, receipt);
    const lines = [
      "Hola David.",
      `El chofer ${driverName} ya subió el comprobante de ${closureNotifyKindTitle(closure)} por ${currency(amount)}.`,
      ""
    ];
    if (link) {
      lines.push("📎 Ver foto del comprobante:");
      lines.push(link);
      lines.push("");
    }
    lines.push("Por favor chequeá tu cuenta en Explora.");
    lines.push("Muchas gracias por usar Explora.");
    return lines.join("\n");
  }

  function debtExpenseOffsetWhatsappText({ driverName = "", amount = 0, expenseBefore = 0, expenseAfter = 0, debtBefore = 0, debtAfter = 0 } = {}) {
    return [
      "*AJUSTE DE DEUDA CON SALDO DE GASTOS*",
      `Chofer: ${safe(driverName) || "Chofer"}`,
      "",
      `Explora debía liquidar al chofer: *${currency(expenseBefore)}*`,
      `Monto utilizado para achicar la deuda: *${currency(amount)}*`,
      `Explora debe liquidar ahora: *${currency(expenseAfter)}*`,
      "",
      `Deuda anterior: ${currency(debtBefore)}`,
      `Deuda restante: *${currency(debtAfter)}*`,
      "",
      "El ajuste se realizó correctamente desde Gastos y no requiere comprobante.",
      "Revisá el movimiento en Explora."
    ].join("\n");
  }

  function notifyClosureReceiptWhatsapp({ closure = {}, receipt = null, uploadedBy = "admin" } = {}) {
    try {
      if (uploadedBy === "admin") {
        const phone = closureDriverWhatsappPhone(closure);
        if (!phone) return false;
        return openWhatsappToPhone(phone, adminPaidDriverWhatsappText({ closure, receipt }));
      }
      if (uploadedBy === "driver") {
        return openWhatsappToExplora(driverUploadedReceiptWhatsappText({ closure, receipt }));
      }
    } catch (error) {
      console.warn("EXPLORA_PAY_WHATSAPP_RECEIPT", error?.message || error);
    }
    return false;
  }

  function renderDriverProfileModal() {
    const body = $("payProfileBody");
    if (!body) return;
    const data = driverPaymentProfile(state.profile || {});
    body.innerHTML = `
      <label class="pay-profile-field pay-profile-phone-field" for="payProfilePhone"><span>Celular WhatsApp</span><div class="pay-profile-phone-row"><select id="payProfileCountry" aria-label="Código de país" required>${whatsappCountryOptionsHtml(data.phoneCountry || "549")}</select><input id="payProfilePhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="${esc(whatsappCountryPlaceholder(data.phoneCountry || "549"))}" value="${esc(data.phoneLocal || "")}" required /></div></label>
      <label class="pay-profile-field" for="payProfileCuit"><span>CUIT</span><input id="payProfileCuit" type="text" inputmode="numeric" autocomplete="off" placeholder="20-00000000-0" value="${esc(data.cuit)}" required /></label>
      <label class="pay-profile-field" for="payProfileAlias"><span>Alias</span><input id="payProfileAlias" type="text" autocomplete="off" placeholder="alias.mercadopago" value="${esc(data.alias)}" required /></label>
      <div class="pay-profile-note">Alias, CUIT y celular se usan en cierres y comprobantes.</div>`;
    const country = $("payProfileCountry");
    const phone = $("payProfilePhone");
    country?.addEventListener("change", () => {
      if (phone) phone.placeholder = whatsappCountryPlaceholder(country.value || "549");
    });
    const msg = $("payProfileMessage");
    if (msg) { msg.textContent = ""; msg.className = "pay-profile-message"; }
  }

  function openDriverProfileModal() {
    showPayView("inicio");
    renderDriverProfileModal();
    const backdrop = $("payProfileBackdrop");
    if (!backdrop) return;
    backdrop.classList.add("is-open");
    backdrop.setAttribute("aria-hidden", "false");
    setTimeout(() => $("payProfilePhone")?.focus?.(), 60);
  }

  function closeDriverProfileModal() {
    const backdrop = $("payProfileBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("is-open");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function setProfileMessage(message = "", type = "") {
    const msg = $("payProfileMessage");
    if (!msg) return;
    msg.textContent = message;
    msg.className = `pay-profile-message ${type ? `is-${type}` : ""}`.trim();
  }

  async function saveDriverProfileModal() {
    const phoneCountry = safe($("payProfileCountry")?.value || "549");
    const phoneLocal = safe($("payProfilePhone")?.value || "");
    const phone = composeWhatsappPhone(phoneCountry, phoneLocal);
    const cuit = safe($("payProfileCuit")?.value || "");
    const alias = safe($("payProfileAlias")?.value || "");
    const missing = paymentProfileMissingFields({ phone, cuit, alias });
    if (missing.length) { setProfileMessage(`Completá: ${missing.join(", ")}.`, "error"); return; }
    const fields = {
      telefono:phone,
      numeroTelefono:phone,
      whatsapp:phone,
      whatsappFull:phone,
      whatsappNormalized:normalizeWhatsappPhone(phone),
      whatsappCountryCode:phoneCountry,
      whatsappLocalNumber:rawWhatsappDigits(phoneLocal),
      codigoPaisWhatsapp:phoneCountry,
      telefonoLocal:rawWhatsappDigits(phoneLocal),
      cuit,
      aliasCobro:alias,
      aliasParaCobrar:alias,
      paymentAlias:alias,
      paymentProfileCompleted:true,
      paymentProfileUpdatedAt:serverTimestamp(),
      paymentProfileUpdatedAtMs:Date.now()
    };
    setProfileMessage("Guardando…");
    try {
      await updateDriverProfileState(getOwnDriverUid(), fields);
      state.profile = { ...(state.profile || {}), ...fields };
      setProfileMessage("Perfil guardado.", "ok");
      setTimeout(closeDriverProfileModal, 650);
    } catch (error) {
      setProfileMessage(error?.message || "No se pudo guardar el perfil.", "error");
    }
  }

  async function updateDriverProfileState(uid = getDriverUid(), rawFields = {}) {
    if (!state.db) throw new Error("No hay conexión con Firestore.");
    const targetUid = safe(uid);
    if (!targetUid) throw new Error("No se pudo identificar el chofer.");
    const candidates = driverDocCandidates(targetUid);
    let lastError = null;
    for (const candidate of candidates) {
      try {
        await updateDoc(doc(state.db, candidate.collectionName, candidate.id), rawFields);
        updateLocalDriverProfileState(targetUid, Object.fromEntries(Object.entries(rawFields).filter(([, value]) => typeof value !== "function")));
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("No se pudo guardar el perfil del chofer.");
  }

  function uberWeekWindow(now = new Date(), offset = 0) {
    const d = new Date(now);

    // Uber muestra semanas de lunes a lunes. El corte operativo es a las 04:00.
    const mondayDistance = (d.getDay() + 6) % 7;
    let activeStart = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() - mondayDistance,
      4, 0, 0, 0
    );

    // El lunes antes de las 04:00 todavía pertenece a la semana anterior.
    if (d.getTime() < activeStart.getTime()) {
      activeStart = new Date(
        activeStart.getFullYear(),
        activeStart.getMonth(),
        activeStart.getDate() - 7,
        4, 0, 0, 0
      );
    }

    const start = new Date(
      activeStart.getFullYear(),
      activeStart.getMonth(),
      activeStart.getDate() - (offset * 7),
      4, 0, 0, 0
    );
    const displayEnd = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + 7,
      4, 0, 0, 0
    );
    const end = new Date(displayEnd.getTime() - 1);
    const isCurrent = offset === 0;
    const isClosed = d.getTime() >= displayEnd.getTime();
    const weekId = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,"0")}-${String(start.getDate()).padStart(2,"0")}_0400`;

    return {
      start,
      end,
      displayEnd,
      activeStart,
      nextReset: displayEnd,
      weekId,
      offset,
      isCurrent,
      isClosed,
      enabled: isClosed
    };
  }

  function uberLastEightWeeks(now = new Date()) {
    return Array.from({ length: 8 }, (_, index) => uberWeekWindow(now, index));
  }

  function uberDriverCreatedMs(uid = getOwnDriverUid()) {
    const targetUid = safe(uid);
    const driver = (state.drivers || []).find(item => safe(item.uid || item.id) === targetUid) || {};
    const profile = targetUid === safe(getOwnDriverUid())
      ? { ...(driver.profile || {}), ...(state.profile || {}) }
      : (driver.profile || driver || {});
    const candidates = [
      profile.createdAt, profile.altaAt, profile.created, profile.fechaAlta,
      profile.createdDate, profile.creationDate, profile.registeredAt,
      profile.fechaIngreso, profile.ingresoAt, profile.joinedAt, profile.startDate, profile.hireDate,
      profile.createdAtMs, profile.altaAtMs, profile.creationMs, profile.registeredAtMs,
      profile.fechaIngresoMs, profile.ingresoAtMs, profile.joinedAtMs, profile.startDateMs, profile.hireDateMs,
      driver.createdAt, driver.createdAtMs, driver.altaAt, driver.altaAtMs, driver.fechaAlta, driver.fechaIngreso, driver.joinedAt, driver.startDate
    ].map(ms).filter(value => value > 0);
    return candidates.length ? Math.min(...candidates) : 0;
  }

  function uberNoDataAllowed(uid, period) {
    if (!period?.start) return false;
    const createdMs = uberDriverCreatedMs(uid);
    if (!(createdMs > 0)) return false;
    const createdWeek = uberWeekWindow(new Date(createdMs), 0);
    const createdWeekStartMs = createdWeek.start.getTime();
    const cutoffMs = createdWeekStartMs + (7 * 7 * 24 * 60 * 60 * 1000);
    const periodStartMs = period.start.getTime();
    // Solo semanas 1 a 7 desde el alta. Nunca habilitar semanas anteriores al ingreso.
    return periodStartMs >= createdWeekStartMs && periodStartMs < cutoffMs;
  }

  function uberWeekDisplayLabel(period = uberWeekWindow()) {
    const start = period?.start instanceof Date ? period.start : new Date(period?.weekStartMs || Date.now());
    const displayEnd = period?.displayEnd instanceof Date
      ? period.displayEnd
      : new Date(period?.weekDisplayEndMs || period?.weekEndBoundaryMs || period?.end?.getTime?.() || Date.now());
    const monthShort = value => ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"][value] || "";
    return `${start.getDate()} ${monthShort(start.getMonth())} – ${displayEnd.getDate()} ${monthShort(displayEnd.getMonth())}`;
  }

  function uberWeekRowForPeriod(uid, period) {
    const targetUid = safe(uid);
    const label = uberWeekDisplayLabel(period).toLowerCase();
    return (state.uberWeeks || []).find(row => {
      const rowUid = safe(row.driverUid || row.choferUid || row.driverId);
      if (rowUid !== targetUid) return false;
      if (safe(row.weekId) === safe(period.weekId)) return true;
      if (Math.abs(moneyNumber(row.weekStartMs) - period.start.getTime()) < 43200000) return true;
      return safe(row.weekLabel).toLowerCase() === label;
    }) || null;
  }

  function uberWeekFor(uid = getDriverUid(), weekId = uberWeekWindow().weekId) {
    const period = uberLastEightWeeks().find(item => safe(item.weekId) === safe(weekId));
    return period
      ? uberWeekRowForPeriod(uid, period)
      : (state.uberWeeks || []).find(row =>
          safe(row.driverUid || row.choferUid || row.driverId) === safe(uid)
          && safe(row.weekId) === safe(weekId)
        ) || null;
  }

  function uberWeeklyStatus(row, period) {
    const review = safe(row?.reviewStatus).toLowerCase();
    const status = safe(row?.status).toLowerCase();
    if (review === "no_data" || status === "no_data") {
      return { key:"no_data", label:"Sin datos", tone:"gray" };
    }
    if (review === "approved" || status === "approved") {
      return { key:"completed", label:"Completado", tone:"green" };
    }
    if (review === "pending" || status === "pending_review") {
      return { key:"review", label:"En revisión", tone:"yellow" };
    }
    if (review === "rejected" || status === "rejected") {
      return { key:"missing", label:"Falta cargar", tone:"red" };
    }
    if (!row) {
      return { key:"missing", label:"Falta cargar", tone:"red" };
    }
    return { key:"review", label:"En revisión", tone:"yellow" };
  }

  function uberMissingClosedWeeks(uid = getDriverUid()) {
    return uberLastEightWeeks()
      .filter(period => period.isClosed)
      .filter(period => {
        const row = uberWeekRowForPeriod(uid, period);
        return uberWeeklyStatus(row, period).key === "missing";
      });
  }

  function uberAdminOverdueRows() {
    if (!isAdmin()) return [];
    const drivers = (state.drivers || []).filter(driver => safe(driver.uid || driver.id));
    return drivers.map(driver => {
      const uid = safe(driver.uid || driver.id);
      const missing = uberMissingClosedWeeks(uid);
      return {
        driverUid: uid,
        driverName: safe(driver.name || driver.nombre || driver.displayName || "Chofer"),
        missing
      };
    }).filter(item => item.missing.length);
  }


  function renderEfficiencyButton() {
    const button = $("payEfficiencyBtn");
    const label = $("payUberWeeklyCountdown");
    if (!button) return;

    let text = "Uber";
    let alert = false;

    if (isAdmin()) {
      const pending = (state.uberWeeks || []).filter(item => {
        const review = safe(item.reviewStatus).toLowerCase();
        const status = safe(item.status).toLowerCase();
        return review === "pending" || status === "pending_review";
      }).length;
      const overdueDrivers = uberAdminOverdueRows().length;
      alert = pending > 0 || overdueDrivers > 0;
      if (overdueDrivers > 0) text = `${overdueDrivers} chofer${overdueDrivers === 1 ? "" : "es"} con semana vencida`;
      else if (pending > 0) text = `${pending} cierre${pending === 1 ? "" : "s"} Uber en revisión`;
      else text = "Uber al día";
    } else {
      const missing = uberMissingClosedWeeks(getOwnDriverUid());
      const pending = uberLastEightWeeks().some(period => {
        const status = uberWeeklyStatus(uberWeekRowForPeriod(getOwnDriverUid(), period), period);
        return status.key === "review";
      });
      alert = missing.length > 0;
      text = missing.length > 0 ? "Semana vencida" : (pending ? "Cierre Uber en revisión" : "Uber al día");
    }

    button.classList.remove("efficiency-good", "efficiency-mid", "efficiency-bad", "efficiency-missing");
    button.classList.toggle("is-uber-loaded", !alert);
    button.classList.toggle("is-uber-overdue", alert);
    if (label) label.textContent = text;
    button.setAttribute("aria-label", text);
    button.title = text;
  }

  function setEfficiencyFormMessage(message = "", type = "") {
    const box = $("payEfficiencyFormMessage");
    if (!box) return;
    box.textContent = message;
    box.className = `pay-efficiency-form-message ${type ? `is-${type}` : ""}`.trim();
  }

  function uberWeeklyStatusLabel(row = {}) {
    const review = safe(row.reviewStatus).toLowerCase();
    if (review === "no_data") return "Sin datos";
    if (review === "approved") return "Completado";
    if (review === "rejected") return "Rechazado: podés volver a cargar";
    return "En revisión";
  }

  function renderUberWeeklyCalculation() {
    const input = $("payUberWeeklyAmount");
    const box = $("payUberWeeklyCalculation");
    if (!box) return;
    const total = moneyNumber(input?.value || 0);
    const debtShare = Math.round(total * 50) / 100;
    const cashboxShare = Math.round(total * 5) / 100;
    box.innerHTML = total > 0
      ? `<strong>Resumen del cierre</strong><p class="pay-uber-summary-intro">Se generará automáticamente:</p><div><span>Deudas (50%)</span><b>${currency(debtShare)}</b></div><div><span>Caja chica Uber (5%)</span><b>${currency(cashboxShare)}</b></div>`
      : `<strong>Resumen del cierre</strong><p>Ingresá el monto total para calcular los importes.</p>`;
  }

  function renderUberDriverWeekList(body, uid) {
    const weeks = uberLastEightWeeks();
    const hasOverdue = uberMissingClosedWeeks(uid).length > 0;

    body.innerHTML = `<section class="pay-uber-weeks">
      <div class="pay-uber-weeks-head">
        <span class="pay-uber-eyebrow">ÚLTIMAS 8 SEMANAS</span>
        <strong>Comprobantes de Uber</strong>
        <p>Las semanas aparecen automáticamente, de la más actual a la más antigua.</p>
        ${hasOverdue ? `<div class="pay-uber-overdue-banner"><strong>Semana vencida</strong><span>Tenés una o más semanas cerradas sin cargar.</span></div>` : ""}
      </div>
      <div class="pay-uber-week-list">
        ${weeks.map(period => {
          const row = uberWeekRowForPeriod(uid, period);
          const status = uberWeeklyStatus(row, period);
          const canAttach = period.isClosed && status.key === "missing";
          const currentNote = period.isCurrent && !period.isClosed ? "Se habilita al cerrar la semana" : "";
          const proofButton = row?.receiptUrl
            ? `<button class="pay-uber-week-proof" data-pay-efficiency-action="view-uber-proof" data-uber-proof-url="${esc(row.receiptUrl)}" type="button">Ver foto</button>`
            : "";
          return `<article class="pay-uber-week-row is-${status.tone}">
            <div class="pay-uber-week-main">
              <strong>${esc(uberWeekDisplayLabel(period))}</strong>
              <span class="pay-uber-week-status">${esc(status.label)}</span>
              ${currentNote ? `<small>${esc(currentNote)}</small>` : ""}
            </div>
            <div class="pay-uber-week-actions">
              ${proofButton}
              ${status.key === "missing"
                ? `<button class="pay-uber-attach" data-pay-efficiency-action="attach-uber-week" data-uber-week-id="${esc(period.weekId)}" type="button" ${canAttach ? "" : "disabled"}>${canAttach ? "Adjuntar" : "Pendiente"}</button>`
                : ""}
            </div>
          </article>`;
        }).join("")}
      </div>
    </section>`;
  }

  function renderUberAdminInbox(body) {
    const pendingRows = (state.uberWeeks || [])
      .filter(item => {
        const review = safe(item.reviewStatus).toLowerCase();
        const status = safe(item.status).toLowerCase();
        return review === "pending" || status === "pending_review";
      })
      .sort((a,b) => rowMs(b) - rowMs(a));
    const overdueRows = uberAdminOverdueRows();

    body.innerHTML = `<section class="pay-uber-admin-inbox">
      <div class="pay-uber-inbox-head">
        <span class="pay-uber-eyebrow">ADMINISTRACIÓN</span>
        <strong>Control semanal de Uber</strong>
        <p>Comprobantes enviados y semanas vencidas de los choferes.</p>
      </div>

      ${overdueRows.length ? `<div class="pay-uber-admin-section">
        <h3>Semanas vencidas</h3>
        <div class="pay-uber-inbox-list">
          ${overdueRows.map(item => `<article class="pay-uber-inbox-card is-overdue">
            <div class="pay-uber-inbox-card-head">
              <div><span>CHOFER</span><strong>${esc(item.driverName)}</strong></div>
              <em>${item.missing.length} vencida${item.missing.length === 1 ? "" : "s"}</em>
            </div>
            <p>${item.missing.map(period => uberWeekDisplayLabel(period)).join(" · ")}</p>
          </article>`).join("")}
        </div>
      </div>` : ""}

      ${(() => {
        const noDataRows = (state.uberWeeks || [])
          .filter(item => safe(item.reviewStatus).toLowerCase() === "no_data" || safe(item.status).toLowerCase() === "no_data")
          .sort((a,b) => rowMs(b) - rowMs(a));
        return noDataRows.length ? `<div class="pay-uber-admin-section">
          <h3>Semanas sin datos</h3>
          <div class="pay-uber-inbox-list">
            ${noDataRows.map(row => `<article class="pay-uber-inbox-card is-no-data">
              <div class="pay-uber-inbox-card-head">
                <div><span>CHOFER</span><strong>${esc(row.driverName || "Chofer")}</strong></div>
                <em>Sin datos</em>
              </div>
              <p>${esc(row.weekLabel || row.weekId || "—")}</p>
            </article>`).join("")}
          </div>
        </div>` : "";
      })()}

      <div class="pay-uber-admin-section">
        <h3>Comprobantes en revisión</h3>
        ${pendingRows.length ? `<div class="pay-uber-inbox-list">
          ${pendingRows.map(row => {
            const total = moneyNumber(row.grossAmount || row.totalAmount || row.amount);
            const driverUid = safe(row.driverUid || row.choferUid || row.driverId);
            return `<article class="pay-uber-inbox-card">
              <div class="pay-uber-inbox-card-head">
                <div><span>CHOFER</span><strong>${esc(row.driverName || "Chofer")}</strong></div>
                <em>En revisión</em>
              </div>
              <div class="pay-uber-inbox-meta">
                <div><span>Semana</span><b>${esc(row.weekLabel || row.weekId || "—")}</b></div>
                <div><span>Total Uber</span><b>${currency(total)}</b></div>
              </div>
              <div class="pay-efficiency-form-actions">
                ${row.receiptUrl ? `<button class="pay-efficiency-secondary" data-pay-efficiency-action="view-uber-proof" data-uber-proof-url="${esc(row.receiptUrl)}" type="button">Ver comprobante</button>` : ""}
                <button class="pay-efficiency-primary" data-pay-efficiency-action="open-uber-review" data-uber-driver-uid="${esc(driverUid)}" data-uber-closure-id="${esc(safe(row.id || row.closureId))}" type="button">Revisar cierre</button>
              </div>
            </article>`;
          }).join("")}
        </div>` : `<div class="pay-efficiency-empty">No hay comprobantes esperando revisión.</div>`}
      </div>
    </section>`;
  }

  function renderEfficiencyModal() {
    const body = $("payEfficiencyBody");
    if (!body) return;
    const modalTitle = $("payEfficiencyTitle");
    if (modalTitle) modalTitle.textContent = isAdmin() ? "Comprobantes Uber" : "Uber";

    const uid = getDriverUid();

    if (isAdmin() && !safe(state.uberReviewClosureId)) {
      renderUberAdminInbox(body);
      return;
    }

    if (isAdmin() && safe(state.uberReviewClosureId)) {
      const row = (state.uberWeeks || []).find(item => safe(item.id || item.closureId) === safe(state.uberReviewClosureId));
      if (!row) {
        state.uberReviewClosureId = "";
        renderUberAdminInbox(body);
        return;
      }
      const total = moneyNumber(row.grossAmount || row.totalAmount || row.amount);
      const debtShare = moneyNumber(row.exploraShare || row.debtAmount || total/2);
      const cashboxShare = moneyNumber(row.cashboxAmount || row.uberCashboxAmount || total*.05);
      body.innerHTML = `<div class="pay-uber-success is-review">
        <strong>Semana ${esc(row.weekLabel || row.weekId)}</strong>
        <p>${esc(row.driverName || "Chofer")} · ${currency(total)}</p>
      </div>
      <div class="pay-uber-summary">
        <strong>Movimientos a confirmar</strong>
        <div><span>Deudas (50%)</span><b>${currency(debtShare)}</b></div>
        <div><span>Caja chica Uber (5%)</span><b>${currency(cashboxShare)}</b></div>
      </div>
      ${row.receiptUrl ? `<button class="pay-efficiency-secondary pay-uber-view-proof" data-pay-efficiency-action="view-uber-proof" data-uber-proof-url="${esc(row.receiptUrl)}" type="button">Ver foto del comprobante</button>` : ""}
      <div class="pay-uber-admin-review">
        <strong>Revisión de Explora</strong>
        <div class="pay-efficiency-form-actions">
          <button class="pay-efficiency-secondary" data-pay-efficiency-action="reject-uber-week" type="button">Rechazar</button>
          <button class="pay-efficiency-primary" data-pay-efficiency-action="approve-uber-week" type="button">Aceptar</button>
        </div>
        <button class="pay-uber-back-list" data-pay-efficiency-action="back-uber-list" type="button">Volver</button>
      </div>
      <div class="pay-efficiency-form-message" id="payEfficiencyFormMessage" role="status"></div>`;
      return;
    }

    const selectedWeekId = safe(state.uberSelectedWeekId);
    if (!selectedWeekId) {
      renderUberDriverWeekList(body, getOwnDriverUid());
      return;
    }

    const period = uberLastEightWeeks().find(item => safe(item.weekId) === selectedWeekId);
    if (!period || !period.isClosed) {
      state.uberSelectedWeekId = "";
      renderUberDriverWeekList(body, getOwnDriverUid());
      return;
    }

    const existing = uberWeekRowForPeriod(getOwnDriverUid(), period);
    const status = uberWeeklyStatus(existing, period);
    if (status.key !== "missing") {
      state.uberSelectedWeekId = "";
      renderUberDriverWeekList(body, getOwnDriverUid());
      return;
    }

    body.innerHTML = `<div class="pay-uber-week-head">
      <span class="pay-uber-eyebrow">ADJUNTAR COMPROBANTE</span>
      <strong>${esc(uberWeekDisplayLabel(period))}</strong>
      <p>Cargá manualmente el monto y la foto correspondiente a esta semana.</p>
    </div>
    <label class="pay-uber-field">
      <span>Monto total de ganancias Uber</span>
      <div class="pay-uber-money-wrap"><span class="pay-uber-money-prefix">$</span><input id="payUberWeeklyAmount" type="text" inputmode="numeric" autocomplete="off" placeholder="0"></div>
    </label>
    <label class="pay-uber-field">
      <span>Foto del comprobante semanal</span>
      <input id="payUberWeeklyFile" type="file" accept="image/*">
      <small>La foto debe mostrar el total de la semana seleccionada.</small>
    </label>
    <div class="pay-uber-calculation" id="payUberWeeklyCalculation"><strong>Resumen del cierre</strong><p>Ingresá el monto total para calcular los importes.</p></div>
    <div class="pay-efficiency-form-message" id="payEfficiencyFormMessage" role="status" aria-live="polite"></div>
    ${uberNoDataAllowed(getOwnDriverUid(), period) ? `<div class="pay-uber-no-data-box">
      <strong>¿Todavía no trabajabas esa semana?</strong>
      <p>Podés cerrarla como “Sin datos”. Esta opción está disponible únicamente durante tus primeras 7 semanas.</p>
      <button class="pay-uber-no-data-button" data-pay-efficiency-action="submit-uber-no-data" type="button">Sin datos</button>
    </div>` : ""}
    <div class="pay-efficiency-form-actions">
      <button class="pay-efficiency-secondary" data-pay-efficiency-action="back-uber-weeks" type="button">Volver</button>
      <button class="pay-efficiency-primary" data-pay-efficiency-action="submit-uber-week" type="button">Enviar a revisión</button>
    </div>`;
  }

  async function submitUberWeeklyNoData() {
    if (state.uberWeeklyBusy) return;
    if (isAdmin()) throw new Error("La semana debe cerrarla el chofer.");
    const selectedWeekId = safe(state.uberSelectedWeekId);
    const period = uberLastEightWeeks().find(item => safe(item.weekId) === selectedWeekId);
    if (!period) throw new Error("Seleccioná una semana.");
    if (!period.isClosed) throw new Error("Esta semana todavía no cerró.");
    const driverUid = getOwnDriverUid();
    if (!uberNoDataAllowed(driverUid, period)) throw new Error("La opción Sin datos solo está disponible durante las primeras 7 semanas del chofer.");
    const existing = uberWeekFor(driverUid, period.weekId);
    if (existing && safe(existing.reviewStatus).toLowerCase() !== "rejected") throw new Error("Esta semana ya fue cerrada.");
    state.uberWeeklyBusy = true;
    setEfficiencyFormMessage("Cerrando semana sin datos…");
    try {
      const nowMs = Date.now();
      const driverName = displayName();
      const closureId = `uber_${driverUid}_${period.weekId}`;
      const weekLabel = uberWeekDisplayLabel(period);
      const payload = {
        closureId, id:closureId, weekId:period.weekId, weekLabel,
        weekStartMs:period.start.getTime(), weekEndMs:period.end.getTime(),
        weekDisplayEndMs:period.displayEnd.getTime(), weekEndBoundaryMs:period.displayEnd.getTime(),
        driverUid, choferUid:driverUid, driverId:driverUid, driverName,
        grossAmount:0, totalAmount:0, driverShare:0, driverNetAmount:0,
        exploraShare:0, debtAmount:0, cashboxRate:.05, cashboxAmount:0, uberCashboxAmount:0,
        receiptUrl:"", receiptPath:"", notificationPhotoUrl:"", telegramPhotoUrl:"", firebasePhotoUrl:"",
        noData:true, noDataReason:"driver_not_working", reviewStatus:"no_data", status:"no_data", locked:true,
        createdByUid:driverUid, createdByRole:"driver", createdAt:serverTimestamp(), createdAtMs:nowMs,
        updatedAt:serverTimestamp(), updatedAtMs:nowMs, version:VERSION
      };
      await setDoc(doc(state.db, "uber_weekly_closures", closureId), payload, { merge:false });
      state.uberWeeks = [{ ...payload, createdAt:undefined, updatedAt:undefined }, ...(state.uberWeeks||[]).filter(x=>safe(x.id || x.closureId)!==closureId)];
      state.uberWeeklyFile = null;
      state.uberSelectedWeekId = "";
      renderEfficiencyButton();
      renderEfficiencyModal();
    } finally {
      state.uberWeeklyBusy = false;
    }
  }

  async function uploadUberWeeklyReceipt({ driverUid, weekId, file }) {
    if (!state.storage) throw new Error("Storage no está disponible.");
    if (!(file instanceof File) || !(file.size > 0)) throw new Error("Subí la captura de ganancias de Uber.");
    if (file.size > 15 * 1024 * 1024) throw new Error("La captura supera 15 MB.");
    const ext = extensionForFile(file);
    const path = `uber_weekly/${driverUid}/${weekId}/${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
    const ref = storageRef(state.storage, path);
    await uploadBytes(ref, file, { contentType:file.type || "image/jpeg", customMetadata:{ module:"uber_weekly", driverUid, weekId, uploadedByUid:state.auth?.currentUser?.uid || "" } });
    return { url:await getDownloadURL(ref), path };
  }

  async function submitUberWeeklyClosure() {
    if (state.uberWeeklyBusy) return;
    if (isAdmin()) throw new Error("La carga semanal debe realizarla el chofer.");
    const selectedWeekId = safe(state.uberSelectedWeekId);
    const period = uberLastEightWeeks().find(item => safe(item.weekId) === selectedWeekId);
    if (!period) throw new Error("Seleccioná una semana para cargar.");
    if (!period.isClosed) throw new Error("Esta semana todavía no cerró.");
    const driverUid = getOwnDriverUid();
    const total = moneyNumber($("payUberWeeklyAmount")?.value || 0);
    if (!(total > 0)) throw new Error("Ingresá el monto total de ganancias Uber.");
    if (uberWeekFor(driverUid, period.weekId) && safe(uberWeekFor(driverUid, period.weekId).reviewStatus) !== "rejected") throw new Error("Esta semana ya fue cargada.");
    const file = state.uberWeeklyFile || $("payUberWeeklyFile")?.files?.[0];
    if (!(file instanceof File)) throw new Error("La captura de ganancias es obligatoria.");
    state.uberWeeklyBusy = true; setEfficiencyFormMessage("Subiendo comprobante y generando deuda…");
    try {
      const proof = await uploadUberWeeklyReceipt({ driverUid, weekId:period.weekId, file });
      const nowMs = Date.now(); const share = Math.round(total * 50) / 100; const cashboxAmount = Math.round(total * 5) / 100; const driverNetAmount = Math.max(0, Math.round((total - share - cashboxAmount) * 100) / 100); const driverName = displayName();
      const closureId = `uber_${driverUid}_${period.weekId}`; const debtId = `debt_${closureId}`;
      const weekLabel = uberWeekDisplayLabel(period);
      await runTransaction(state.db, async tx => {
        const closureRef = doc(state.db, "uber_weekly_closures", closureId); const snap = await tx.get(closureRef);
        if (snap.exists() && safe(snap.data()?.reviewStatus) !== "rejected") throw new Error("Esta semana ya fue cargada.");
        tx.set(closureRef, { closureId, id:closureId, weekId:period.weekId, weekLabel, weekStartMs:period.start.getTime(), weekEndMs:period.end.getTime(), weekDisplayEndMs:period.displayEnd.getTime(), weekEndBoundaryMs:period.displayEnd.getTime(), driverUid, choferUid:driverUid, driverId:driverUid, driverName, grossAmount:total, totalAmount:total, driverShare:driverNetAmount, driverNetAmount, exploraShare:share, debtAmount:share, cashboxRate:.05, cashboxAmount, uberCashboxAmount:cashboxAmount, receiptUrl:proof.url, receiptPath:proof.path, notificationPhotoUrl:proof.url, telegramPhotoUrl:proof.url, firebasePhotoUrl:proof.url, reviewStatus:"pending", status:"pending_review", locked:true, createdByUid:driverUid, createdByRole:"driver", createdAt:serverTimestamp(), createdAtMs:nowMs, updatedAt:serverTimestamp(), updatedAtMs:nowMs, version:VERSION }, { merge:false });
        tx.set(doc(state.db, "deudas_choferes", debtId), { debtId, id:debtId, driverUid, choferUid:driverUid, driverId:driverUid, driverName, type:"uber_weekly", debtType:"uber_weekly", concept:`Uber semanal · ${weekLabel}`, description:`50% de ganancias Uber (${currency(total)}). Caja chica Uber 5%: ${currency(cashboxAmount)}`, totalAmount:share, amount:share, remainingAmount:share, saldoPendiente:share, paidAmount:0, amountPaid:0, status:"pending", debtStatus:"pending", reviewStatus:"pending", sourceModule:"uber_weekly", uberClosureId:closureId, uberGrossAmount:total, uberCashboxRate:.05, uberCashboxAmount:cashboxAmount, receiptUrl:proof.url, receiptPath:proof.path, createdByUid:driverUid, createdByRole:"driver", createdAt:serverTimestamp(), createdAtMs:nowMs, updatedAt:serverTimestamp(), updatedAtMs:nowMs, version:VERSION }, { merge:false });
        tx.set(doc(state.db, "notificaciones", `uber_review_${closureId}`), { notificationId:`uber_review_${closureId}`, type:"uber_weekly_review", category:"uber", driverUid, choferUid:driverUid, driverName, closureId, debtId, title:"CIERRE UBER PARA REVISIÓN", message:`${driverName} informó ${currency(total)}. ${currency(share)} irá a Deudas y ${currency(cashboxAmount)} a Caja chica Uber.`, amount:total, exploraShare:share, cashboxAmount, uberCashboxAmount:cashboxAmount, driverNetAmount, receiptUrl:proof.url, notificationPhotoUrl:proof.url, telegramPhotoUrl:proof.url, read:false, acknowledged:false, createdByUid:driverUid, createdByRole:"driver", createdAt:serverTimestamp(), createdAtMs:nowMs, version:VERSION }, { merge:false });
      });
      state.uberWeeks = [{ id:closureId, closureId, weekId:period.weekId, weekLabel, weekStartMs:period.start.getTime(), weekEndMs:period.end.getTime(), weekDisplayEndMs:period.displayEnd.getTime(), driverUid, driverName, grossAmount:total, exploraShare:share, debtAmount:share, cashboxAmount, uberCashboxAmount:cashboxAmount, driverNetAmount, receiptUrl:proof.url, reviewStatus:"pending", status:"pending_review", createdAtMs:nowMs }, ...(state.uberWeeks||[]).filter(x=>safe(x.id)!==closureId)];
      state.uberWeeklyFile = null;
      state.uberSelectedWeekId = "";
      renderEfficiencyButton();
      renderEfficiencyModal();
    } finally { state.uberWeeklyBusy=false; }
  }

  async function reviewUberWeeklyClosure(decision) {
    if (!isAdmin()) throw new Error("Solo Explora puede revisar este cierre.");
    const row = (state.uberWeeks || []).find(x => safe(x.id || x.closureId) === safe(state.uberReviewClosureId));
    if (!row?.id) throw new Error("No se encontró el cierre Uber seleccionado.");
    const nowMs=Date.now(); const approved=decision==="approved"; const debtId=safe(row.debtId || `debt_${row.id}`);
    await runTransaction(state.db, async tx=>{
      tx.update(doc(state.db,"uber_weekly_closures",row.id), { reviewStatus:decision, status:approved?"approved":"rejected", locked:approved, reviewedByUid:state.user?.uid||"", reviewedAt:serverTimestamp(), reviewedAtMs:nowMs, updatedAt:serverTimestamp(), updatedAtMs:nowMs });
      tx.update(doc(state.db,"deudas_choferes",debtId), { reviewStatus:decision, status:approved?"active":"rejected", debtStatus:approved?"active":"rejected", remainingAmount:approved?moneyNumber(row.exploraShare||row.debtAmount):0, saldoPendiente:approved?moneyNumber(row.exploraShare||row.debtAmount):0, updatedAt:serverTimestamp(), updatedAtMs:nowMs });
      tx.set(doc(state.db,"notificaciones",`uber_review_result_${row.id}`), { notificationId:`uber_review_result_${row.id}`, type:"uber_weekly_review_result", category:"uber", driverUid:row.driverUid, driverName:row.driverName, closureId:row.id, title:approved?"CIERRE UBER APROBADO":"CIERRE UBER RECHAZADO", message:approved?"Explora aprobó tu cierre semanal. La deuda quedó activa.":"Explora rechazó el cierre. Podés corregirlo y volver a cargar.", read:false, acknowledged:false, createdByUid:state.user?.uid||"", createdByRole:"admin", createdAt:serverTimestamp(), createdAtMs:nowMs, version:VERSION }, {merge:false});
    });
    state.uberWeeks=(state.uberWeeks||[]).map(x=>safe(x.id)===safe(row.id)?{...x,reviewStatus:decision,status:approved?"approved":"rejected"}:x);
    state.selectedDriverUid = "";
    state.selectedDriverName = "";
    state.uberReviewClosureId = "";
    renderEfficiencyButton();
    renderEfficiencyModal();
  }

  async function openEfficiencyModal() {
    const backdrop = $("payEfficiencyBackdrop"); if (!backdrop) return;
    backdrop.classList.add("is-open"); backdrop.setAttribute("aria-hidden", "false"); renderEfficiencyModal();
  }
  function closeEfficiencyModal() {
    const backdrop = $("payEfficiencyBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("is-open");
    backdrop.setAttribute("aria-hidden", "true");
    state.uberWeeklyFile = null;
    state.uberReviewClosureId = "";
    state.uberSelectedWeekId = "";
  }

  function renderBellBadge() {
    const badge = $("payBellBadge");
    if (!badge) return;
    const count = pendingClosureRows(notificationDriverUid()).length;
    const debtTotal = activeDebtTotal();
    const debtAlarm = debtTotal > 0.49;
    const bell = $("payBellBtn");
    if (bell) {
      bell.classList.toggle("is-debt-alarm", debtAlarm);
      bell.setAttribute("aria-label", debtAlarm
        ? `Alarma de deuda activa: ${currency(debtTotal)} pendiente`
        : (count ? `Notificaciones de cierres: ${count} abierto${count === 1 ? "" : "s"}` : "Notificaciones de cierres"));
    }
    badge.hidden = debtAlarm || count < 1;
    badge.textContent = count > 9 ? "9+" : String(count);
    const navClosure = $("payNavClosure");
    if (navClosure) navClosure.classList.toggle("is-pending-closure", count > 0);
  }

  function renderNotificationsScreen() {
    const list = $("payNotificationList");
    if (!list) return;
    const targetUid = notificationDriverUid();
    const rows = pendingClosureRows(targetUid);
    if (!rows.length) {
      list.innerHTML = `<div class="pay-notification-empty">No tenés cierres abiertos.</div>`;
      return;
    }
    list.innerHTML = rows.map(row => {
      const kind = closureKindOf(row) || "gastos";
      const action = closureActionForViewer(row);
      const driver = closureDriverName(row);
      const requestedByRole = safe(row.requestedByRole || row.solicitadoPorRol || row.requestedRole).toLowerCase();
      let title = isAdmin()
        ? (requestedByRole === "driver" || requestedByRole === "chofer" ? `${driver} pidió cierre` : `Cierre de ${driver}`)
        : (requestedByRole === "admin" || requestedByRole === "explora" ? "Explora pidió el cierre" : "Tu cierre solicitado");
      if (action === "admin_review") title = `${driver} envió comprobante`;
      if (action === "admin_waiting_driver") title = `Esperando comprobante de ${driver}`;
      if (action === "driver_review") title = "Explora envió comprobante";
      if (action === "driver_waiting_admin") title = "Esperando comprobante de Explora";
      const subtitle = `${closureTitle(kind)} · ${closureResultText(row)}`;
      const status = action === "driver_upload" || action === "admin_upload"
        ? "Cargar comprobante"
        : action === "admin_review"
          ? "Revisar comprobante"
          : action === "driver_review"
            ? "Ver comprobante"
            : action === "admin_waiting_driver" || action === "driver_waiting_admin"
              ? "Esperando comprobante"
              : "Ver detalle";
      const helper = action === "admin_upload" || action === "driver_upload" ? "Resolvé tu situación" : closureStatusText(row);
      return `<button class="pay-notification-row" data-pay-notification-closure="${esc(row.id)}" type="button">
        <span class="pay-notification-icon">${notificationIcon(kind)}</span>
        <span class="pay-notification-copy"><strong>${esc(title)}</strong><small>${esc(helper)}</small><em>${esc(subtitle)}</em></span>
        <span class="pay-notification-side"><time>${esc(closureTimeLabel(row))}</time><b>${esc(status)}</b></span>
      </button>`;
    }).join("");
  }

  function notificationIcon(kind = "gastos") {
    if (activeClosureKind(kind) === "gastos") return `<svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg>`;
    return `<svg viewBox="0 0 24 24"><path d="M7 3h10v18l-2-1-2 1-2-1-2 1-2-1Z"></path><path d="M9 8h6M9 12h6M9 16h4"></path></svg>`;
  }

  function dueNeedsReceipt(closure = {}) {
    const action = closureActionForViewer(closure);
    return action === "driver_upload" || action === "admin_upload";
  }

  function openClosureFromNotification(id) {
    const targetUid = notificationDriverUid();
    const closure = state.closures.find(row => {
      if (safe(row.id) !== safe(id)) return false;
      if (isAdmin()) return targetUid ? closureBelongsToDriver(row, targetUid) : true;
      return closureBelongsToDriver(row, getOwnDriverUid());
    });
    if (!closure) return;
    if (isAdmin()) {
      const closureUid = closureDriverUids(closure)[0] || "";
      if (closureUid && closureUid !== state.selectedDriverUid) {
        state.selectedDriverUid = closureUid;
        state.selectedDriverName = closureDriverName(closure);
        setTimeout(() => startRealtime("admin-open-closure-notification"), 50);
      }
    }
    showPayView("inicio");
    const kind = closureKindOf(closure) || state.tab;
    openClosureModal(isAdmin() ? "admin-review" : "confirm", closure, kind);
  }

  function computeSummary({ records = state.records, expenses = state.expenses, closures = state.closures, debts = state.debts, debtPayments = state.debtPayments, uberWeeks = state.uberWeeks } = {}) {
    // Nuevo modo: Chofer y Explora son dos vistas del mismo cierre de facturación.
    // El corte de cualquiera de los dos corta toda la facturación: efectivo + digital.
    const resetBillingMs = lastBillingClosureMs(closures);
    const resetExpensesMs = lastClosureMs(closures, "gastos");
    const resetCashboxMs = lastCashboxResetMs(closures);

    const openBillingRows = records.filter(row => !movementIsDeleted(row) && rowMs(row) > resetBillingMs).sort((a,b)=>rowMs(b)-rowMs(a));
    const billingSettlementPayments = openBillingRows.filter(isDriverBillingSettlementPayment);
    const billingRecords = openBillingRows.filter(row => !isDriverBillingSettlementPayment(row));
    const cashRecords = billingRecords.filter(row => methodOf(row) === "cash");
    const exploraRecords = billingRecords.filter(row => methodOf(row) !== "cash");
    // Caja chica es módulo independiente y SOLO se genera por cobros en efectivo.
    // Cobros digitales (transferencia/QR/tarjeta) no generan ni descuentan caja chica.
    const regularCashboxRecords = records.filter(row => !movementIsDeleted(row) && !cashboxIsExcluded(row) && rowMs(row) > resetCashboxMs && methodOf(row) === "cash");
    const uberCashboxRecords = (uberWeeks || []).filter(row => safe(row.reviewStatus || row.status) !== "rejected" && rowMs(row) > resetCashboxMs && moneyNumber(row.grossAmount || row.totalAmount) > 0).map(row => ({
      ...row,
      id:`uber_cashbox_${safe(row.id || row.closureId)}`,
      amount:moneyNumber(row.grossAmount || row.totalAmount),
      method:"cash",
      paymentMethod:"cash",
      sourceModule:"uber_weekly_cashbox",
      type:"uber_weekly_cashbox",
      concept:`Caja chica Uber 5% · ${safe(row.weekLabel || row.weekId)}`,
      cashboxAmount:moneyNumber(row.cashboxAmount || row.uberCashboxAmount || moneyNumber(row.grossAmount || row.totalAmount)*.05)
    }));
    const cashboxRecords = [...regularCashboxRecords, ...uberCashboxRecords].sort((a,b)=>rowMs(b)-rowMs(a));
    const cashboxCashRecords = cashboxRecords;
    const cashboxExploraRecords = [];
    const filteredExpenses = expenses.filter(row => !movementIsDeleted(row) && rowMs(row) > resetExpensesMs).sort((a,b)=>rowMs(b)-rowMs(a));

    const cashboxRate = .05;
    let cashGrossInDriver = 0, nonCashGrossInExplora = 0;
    for (const row of cashRecords) {
      const amount = amountOf(row);
      if (amount > 0) cashGrossInDriver += amount;
    }
    for (const row of exploraRecords) {
      const amount = amountOf(row);
      if (amount > 0) nonCashGrossInExplora += amount;
    }

    // Facturación conserva efectivo, digital, total y reparto 50/50 completos.
    // Caja chica mantiene su período vigente hasta que se pide un cierre de Facturación.
    // En ese pedido se suma TODO el 5% pendiente al resultado final y se reinicia automáticamente.
    const cashInDriver = cashGrossInDriver;
    const nonCashInExplora = nonCashGrossInExplora;
    const cashboxGeneratedBillingRecords = cashRecords.filter(row => !cashboxIsExcluded(row));
    const cashboxEligibleBillingRecords = cashboxRecords;
    const billingCurrentCashboxGross = cashboxGeneratedBillingRecords.reduce((sum, row) => sum + amountOf(row), 0);
    const billingCurrentCashboxGenerated = billingCurrentCashboxGross * cashboxRate;
    const cashboxGross = cashboxRecords.reduce((sum, row) => sum + amountOf(row), 0);
    const cashboxGeneratedTotal = cashboxGross * cashboxRate;
    const cashboxOffsetPreviouslyApplied = Math.min(cashboxGeneratedTotal, billingCashboxOffsetsAfter(closures, resetCashboxMs));
    const cashboxTotal = Math.max(0, cashboxGeneratedTotal - cashboxOffsetPreviouslyApplied);
    const billingCashboxGross = cashboxGross;
    const billingCashboxEligibleGross = cashboxGross;
    const billingSettlement = billingSettlementWithCashbox({
      cash:cashInDriver,
      digital:nonCashInExplora,
      cashboxEligibleGross:billingCashboxEligibleGross,
      cashboxRate,
      cashboxAmount:cashboxTotal
    });
    const cashboxFromBillingCash = billingCurrentCashboxGenerated;
    const billingCashboxEligibleAmount = cashboxTotal;
    const cashboxFromBillingExplora = 0;
    const billingCashboxOffsetApplied = cashboxTotal;
    const billingCashboxRemainingInDriver = 0;

    const gross = billingSettlement.gross;
    const grossBeforeCashbox = gross;
    const cashboxOffsetReservedOpen = cashboxOffsetPreviouslyApplied;
    const cashboxInDriver = cashboxTotal;
    const cashboxInExplora = cashboxOffsetPreviouslyApplied;
    const cashboxAmountFromDriver = cashboxInDriver;
    const cashboxAmountToDriver = 0;
    const billingShareEach = billingSettlement.share;
    const billingNetBeforeCashboxToDriver = billingSettlement.netBeforeCashboxToDriver;
    const billingPaymentAdjustment = applyDriverBillingPayments({
      netToDriver:billingSettlement.netToDriver,
      paymentRows:billingSettlementPayments
    });
    const billingNetBeforeDriverPayments = billingPaymentAdjustment.netBeforePayments;
    const billingSettlementPaymentTotal = billingPaymentAdjustment.paymentTotal;
    const billingNetToDriver = billingPaymentAdjustment.adjustedNetToDriver;
    const amountToDriverForBilling = billingPaymentAdjustment.amountToDriver;
    const amountFromDriverForBilling = billingPaymentAdjustment.amountFromDriver;

    let expenseTotal = 0, driverExpenseShare = 0, exploraExpenseShare = 0, expensesPaidByDriver = 0, expensesPaidByExplora = 0;
    let expenseAmountToDriverBeforeDebt = 0;
    for (const row of filteredExpenses) {
      const { amount, driverPart, exploraPart, payer } = expenseParts(row);
      if (!(amount > 0)) continue;
      expenseTotal += amount;
      driverExpenseShare += driverPart;
      exploraExpenseShare += exploraPart;
      if (payer === "explora") expensesPaidByExplora += amount;
      else expensesPaidByDriver += amount;
      // Nuevo modo de gastos: los gastos se cierran aparte y Explora reintegra siempre su mitad al chofer.
      expenseAmountToDriverBeforeDebt += exploraPart;
    }
    const expenseDebtAdjustmentRowsOpen = expenseDebtAdjustmentRows(debtPayments, resetExpensesMs);
    const expenseDebtOffsetRaw = expenseDebtAdjustmentRowsOpen.reduce((sum, row) => sum + Math.max(0, amountOf(row)), 0);
    const expenseDebtOffsetApplied = Math.min(expenseAmountToDriverBeforeDebt, expenseDebtOffsetRaw);
    const expenseAmountToDriver = Math.max(0, expenseAmountToDriverBeforeDebt - expenseDebtOffsetApplied);
    const expenseAmountFromDriver = 0;
    const netSettlementToDriver = billingNetToDriver + expenseAmountToDriver;

    const billingTab = {
      resetMs:resetBillingMs, records:openBillingRows, billingRecords, billingSettlementPayments, cashboxGeneratedRecords:cashboxGeneratedBillingRecords, cashboxEligibleRecords:cashboxEligibleBillingRecords, expenses:[], gross, grossBeforeCashbox, expenseTotal:0,
      cashGrossInDriver, nonCashGrossInExplora, cashInDriver, nonCashInExplora, billingShareEach,
      cashboxRate, cashboxTotal:cashboxFromBillingCash, cashboxInDriver:billingCashboxRemainingInDriver, cashboxInExplora:billingCashboxOffsetApplied,
      billingCashboxGross, billingCashboxEligibleGross, billingCashboxGenerated:cashboxTotal, billingCurrentCashboxGross, billingCurrentCashboxGenerated, billingCashboxEligibleAmount, billingCashboxOffsetApplied, billingCashboxRemainingInDriver,
      billingNetBeforeCashboxToDriver, billingAmountToDriverBeforeCashbox:Math.max(0, billingNetBeforeCashboxToDriver),
      billingNetBeforeDriverPayments, billingSettlementPaymentTotal,
      amountToDriver:amountToDriverForBilling, amountFromDriver:amountFromDriverForBilling,
      netSettlementToDriver:billingNetToDriver,
      summaryLabel:"Facturación abierta"
    };

    const pendientesTab = summarizePendingDebts(debts);

    const tabs = {
      pendientes:pendientesTab,
      caja_chica:{
        kind:"caja_chica", resetMs:resetCashboxMs, records:cashboxRecords, cashboxRecords, cashboxCashRecords, cashboxExploraRecords, expenses:[],
        gross:cashboxGross, cashboxGeneratedTotal, cashboxOffsetPreviouslyApplied, cashboxOffsetReservedOpen, expenseTotal:0, mainTotal:cashboxTotal,
        cashInDriver, nonCashInExplora, cashboxRate, cashboxTotal, cashboxInDriver, cashboxInExplora,
        amountToDriver:cashboxAmountToDriver, amountFromDriver:cashboxAmountFromDriver, netSettlementToDriver:-cashboxAmountFromDriver,
        summaryLabel:"Caja chica automática 5%"
      },
      gastos:{
        kind:"gastos", resetMs:resetExpensesMs, records:[], expenses:filteredExpenses, gross:0, expenseTotal,
        driverExpenseShare, exploraExpenseShare, expensesPaidByDriver, expensesPaidByExplora,
        expenseAmountToDriverBeforeDebt, expenseDebtOffsetApplied, expenseDebtOffsetRaw, expenseDebtAdjustmentRows:expenseDebtAdjustmentRowsOpen,
        amountToDriver:expenseAmountToDriver, amountFromDriver:expenseAmountFromDriver, netSettlementToDriver:expenseAmountToDriver,
        summaryLabel:"Gastos cargados por el chofer"
      },
      explora:{ kind:"explora", ...billingTab, summaryLabel:"Facturación cobrada por Chofer y Explora" },
      chofer:{ kind:"chofer", ...billingTab, summaryLabel:"Facturación cobrada por Chofer y Explora" },
      facturacion:{ kind:"facturacion", ...billingTab, summaryLabel:"Facturación cobrada por Chofer y Explora" }
    };

    return {
      resetMs:tabs[activeClosureKind(state.tab) || "caja_chica"]?.resetMs || 0,
      records:openBillingRows, billingRecords, billingSettlementPayments, cashRecords, exploraRecords, expenses:filteredExpenses, debts, debtPayments, tabs, pendientes:pendientesTab,
      cashboxRecords, cashboxCashRecords, cashboxExploraRecords,
      gross, grossBeforeCashbox, cashGrossInDriver, nonCashGrossInExplora, cashboxFromBillingCash, cashboxFromBillingExplora, cashInDriver, nonCashInExplora, billingShareEach,
      billingCashboxGross, billingCashboxEligibleGross, billingCashboxGenerated:cashboxTotal, billingCurrentCashboxGross, billingCurrentCashboxGenerated, billingCashboxEligibleAmount, billingCashboxOffsetApplied, billingCashboxRemainingInDriver,
      billingNetBeforeCashboxToDriver, billingAmountToDriverBeforeCashbox:Math.max(0, billingNetBeforeCashboxToDriver),
      billingNetBeforeDriverPayments, billingSettlementPaymentTotal,
      cashboxRate, cashboxGross, cashboxGeneratedTotal, cashboxOffsetPreviouslyApplied, cashboxOffsetReservedOpen, cashboxTotal, cashboxInDriver, cashboxInExplora, cashboxAmountFromDriver, cashboxAmountToDriver,
      driverShare:billingShareEach, exploraShare:billingShareEach,
      driverShareFromCash:cashInDriver * .5, exploraShareFromCash:cashInDriver * .5,
      driverShareFromExplora:nonCashInExplora * .5, exploraShareFromExplora:nonCashInExplora * .5,
      expenseTotal, driverExpenseShare, exploraExpenseShare, expensesPaidByDriver, expensesPaidByExplora,
      expenseAmountToDriverBeforeDebt, expenseDebtOffsetApplied, expenseDebtOffsetRaw, expenseDebtAdjustmentRows:expenseDebtAdjustmentRowsOpen,
      expenseAmountToDriver, expenseAmountFromDriver,
      driverActualCash:cashInDriver,
      exploraCash:nonCashInExplora,
      driverEntitlement:billingShareEach,
      netSettlementToDriver,
      driverFinal:billingShareEach,
      amountToDriver:Math.max(0, netSettlementToDriver), amountFromDriver:Math.max(0, -netSettlementToDriver),
      amountToDriverForBilling, amountFromDriverForBilling, billingNetToDriver,
      pendingDebtTotal:pendientesTab.remainingAmount, pendingDebtPaid:pendientesTab.totalPaid, pendingDebtPenalty:pendientesTab.totalPenalty
    };
  }

  function tabSummary(summary = computeSummary(), kind = state.tab) {
    return summary.tabs?.[activeClosureKind(kind)] || summary.tabs?.[safe(kind)] || summary.tabs?.caja_chica || summary;
  }

  function billingWinner(summary = state.latestSummary || computeSummary()) {
    const cash = number(summary.cashInDriver || 0);
    const digital = number(summary.nonCashInExplora || 0);
    const total = cash + digital;
    if (!(total > 0)) return "none";
    const share = total * .5;
    const delta = cash - share;
    if (delta > 0.49) return "chofer";
    if (delta < -0.49) return "explora";
    return "balanced";
  }

  function closureButtonState(kind = state.tab, summary = state.latestSummary || computeSummary()) {
    const target = activeClosureKind(kind);
    if (!isClosureTab(target) || !hasAdminDriverSelected()) return { visible:false, enabled:false };

    // Estado de cierre independiente por módulo: un pedido de facturación no bloquea caja chica/gastos.
    const pending = pendingModuleClosureFor(getDriverUid(), target);
    if (pending) {
      // Si existe un cierre anterior pendiente, NO debe bloquear un nuevo período abierto.
      // Facturación corta Chofer+Explora juntos; por eso, si después del corte Explora vuelve a
      // tener más dinero que el chofer, el botón de Explora debe habilitarse nuevamente.
      if (target === "explora" || target === "facturacion") {
        const t = tabSummary(summary, "explora");
        const amountToDriver = number(summary.amountToDriverForBilling || t.amountToDriver || 0);
        const amountFromDriver = number(summary.amountFromDriverForBilling || t.amountFromDriver || 0);
        const hasBilling = number(summary.gross || t.gross || 0) > 0.49;
        const beforeCashbox = number(summary.billingNetBeforeCashboxToDriver || t.billingNetBeforeCashboxToDriver || 0);
        return { visible:true, enabled:amountToDriver > 0.49 || (hasBilling && amountFromDriver <= 0.49 && amountToDriver <= 0.49 && beforeCashbox > 0), pending:true };
      }
      if (target === "chofer") {
        const tChofer = tabSummary(summary, "chofer");
        const amountFromDriver = number(summary.amountFromDriverForBilling || tChofer.amountFromDriver || 0);
        const amountToDriver = number(summary.amountToDriverForBilling || tChofer.amountToDriver || 0);
        const hasBilling = number(summary.gross || tChofer.gross || 0) > 0.49;
        const beforeCashbox = number(summary.billingNetBeforeCashboxToDriver || tChofer.billingNetBeforeCashboxToDriver || 0);
        return { visible:true, enabled:amountFromDriver > 0.49 || (hasBilling && amountFromDriver <= 0.49 && amountToDriver <= 0.49 && beforeCashbox <= 0), pending:true };
      }
      if (target === "caja_chica") return { visible:true, enabled:false, pending:true, automaticWithBilling:true };
      if (target === "gastos") return { visible:true, enabled:false, pending:true };
      return { visible:false, enabled:false, pending:true };
    }

    if (target === "caja_chica") {
      // Caja chica ya no tiene cierre manual: se incluye y reinicia al pedir cierre
      // desde Chofer o Explora, según el resultado final de Facturación.
      return { visible:true, enabled:false, automaticWithBilling:true };
    }

    if (target === "gastos") {
      const t = tabSummary(summary, "gastos");
      const debtTotal = number(summary.pendingDebtTotal || summary.pendientes?.remainingAmount || 0);
      const hasExpenseBalance = number(t.expenseAmountToDriverBeforeDebt || t.amountToDriver || 0) > 0.49;
      if (debtTotal > 0.49 && hasExpenseBalance) {
        return { visible:true, enabled:false, blockedByDebt:true, debtTotal, expenseAvailable:number(t.amountToDriver || 0) };
      }
      // Gastos: si Explora debe reintegrar, el admin carga comprobante; si entra el chofer, puede pedir el cierre.
      return { visible:true, enabled:number(t.expenseTotal || 0) > 0 && number(t.amountToDriver || 0) > 0 };
    }

    if (target === "chofer") {
      const tChofer = tabSummary(summary, "chofer");
      const amountFromDriver = number(summary.amountFromDriverForBilling || tChofer.amountFromDriver || 0);
      const amountToDriver = number(summary.amountToDriverForBilling || tChofer.amountToDriver || 0);
      const hasBilling = number(summary.gross || tChofer.gross || 0) > 0.49;
      const balancedAfterCashbox = amountFromDriver <= 0.49 && amountToDriver <= 0.49;
      const beforeCashbox = number(summary.billingNetBeforeCashboxToDriver || tChofer.billingNetBeforeCashboxToDriver || 0);
      // El botón corresponde al pagador FINAL luego de incluir toda la Caja chica acumulada.
      return { visible:true, enabled:amountFromDriver > 0.49 || (hasBilling && balancedAfterCashbox && beforeCashbox <= 0) };
    }

    if (target === "explora") {
      const t = tabSummary(summary, "explora");
      const amountToDriver = number(summary.amountToDriverForBilling || t.amountToDriver || 0);
      const amountFromDriver = number(summary.amountFromDriverForBilling || t.amountFromDriver || 0);
      const hasBilling = number(summary.gross || t.gross || 0) > 0.49;
      const balancedAfterCashbox = amountFromDriver <= 0.49 && amountToDriver <= 0.49;
      const beforeCashbox = number(summary.billingNetBeforeCashboxToDriver || t.billingNetBeforeCashboxToDriver || 0);
      // Explora solicita únicamente cuando el resultado final, Caja chica incluida, queda a su cargo.
      return { visible:true, enabled:amountToDriver > 0.49 || (hasBilling && balancedAfterCashbox && beforeCashbox > 0) };
    }

    return { visible:false, enabled:false };
  }

  function requireClosureAllowed(kind = state.tab, summary = state.latestSummary || computeSummary()) {
    const status = closureButtonState(kind, summary);
    if (!status.visible || !status.enabled) {
      const target = activeClosureKind(kind);
      if (status.blockedByDebt || (target === "gastos" && number(summary.pendingDebtTotal || summary.pendientes?.remainingAmount || 0) > 0.49)) {
        throw new Error("Debes dejar tu deuda en $0 antes de pedir un cierre. Utiliza el dinero que Explora debe liquidarte para saldar tu deuda y vuelve a intentar.");
      }
      if (target === "caja_chica") throw new Error("Caja chica se cierra automáticamente junto con Facturación y no admite cierre manual.");
      if (target === "gastos") throw new Error("No hay gastos abiertos para pedir cierre.");
      if (target === "chofer") throw new Error("No hay saldo pendiente para pedir cierre al chofer en este momento.");
      if (target === "explora") throw new Error("El cierre de facturación no corresponde a Explora en este momento.");
      throw new Error("Este módulo no tiene cierre disponible en este momento.");
    }
  }

  function driverUidOf(row = {}) {
    return closureDriverUids(row)[0] || safe(row.driverUid || row.choferUid || row.uid || row.userUid || row.ownerUid);
  }

  function driverNameForRow(row = {}) {
    const explicit = safe(row.driverName || row.choferNombre || row.nombreChofer || row.selectedDriverName || row.conductorNombre || row.driverDisplayName || row.nombre || row.name);
    if (explicit) return explicit;
    const uid = driverUidOf(row);
    return state.drivers.find(driver => driver.uid === uid || driver.id === uid)?.name || "Chofer";
  }

  function adminActivityKind(row = {}) {
    if (row.type === "expense") return "gastos";
    if (row.type === "cashbox") return "caja_chica";
    if (row.type === "debt" || row.type === "debt_payment") return "pendientes";
    if (row.type === "debt_expense_offset") return "gastos";
    if (row.type === "closure") return "cierres";
    if (row.type === "payment") return row.method === "cash" ? "chofer" : "digital";
    return "";
  }

  function activityMatchesSelectedModule(row = {}) {
    // En la vista del administrador mandan exclusivamente los selectores
    // “Filtrar por chofer” y “Filtrar por tipo”. No se debe volver a aplicar
    // el módulo que quedó activo antes de entrar a Actividades, porque eso
    // ocultaba especialmente los cierres solicitados por los choferes.
    if (isAdmin()) return adminActivityMatches(row);

    const tab = activeClosureKind(state.tab);
    let moduleMatch = false;

    // Para el chofer se mantiene el filtro operativo por módulo.
    // Chofer es la única excepción: reúne efectivo y caja chica.
    if (tab === "explora") moduleMatch = row.type === "payment" && row.method !== "cash";
    else if (tab === "chofer") moduleMatch = (row.type === "payment" && row.method === "cash") || row.type === "cashbox";
    else if (tab === "caja_chica") moduleMatch = row.type === "cashbox";
    else if (tab === "gastos") moduleMatch = row.type === "expense" || row.type === "debt_expense_offset";
    else if (tab === "pendientes") moduleMatch = row.type === "debt" || row.type === "debt_payment";

    return moduleMatch;
  }

  function adminActivityMatches(row = {}) {
    if (!isAdmin()) return true;
    const type = safe(state.adminActivityType);
    if (type && adminActivityKind(row) !== type) return false;
    const filterUid = safe(state.selectedDriverUid);
    if (!filterUid) return true;
    return closureDriverUids(row.source || row).includes(filterUid) || driverUidOf(row.source || row) === filterUid;
  }

  function renderAdminShellState() {
    const admin = isAdmin();
    const root = $("exploraPagoDashboard");
    root?.classList.toggle("is-admin-activity-home", admin);
    document.body?.classList.toggle("explora-admin-activity-home", admin);
    document.querySelectorAll("#payBottomNav .pay-nav-btn").forEach(button => {
      const span = button.querySelector("span:last-child");
      if (!span) return;
      if (button.dataset.payNav === "inicio") span.textContent = admin ? "Actividades" : "Inicio";
      else if (button.dataset.payNav === "actividad") span.textContent = admin ? "+ Chofer" : "Actividad";
      else if (button.dataset.payRun === "nuevo-servicio") span.textContent = admin ? "Cierre contable" : "Cobrar";
      else if (button.id === "payNavClosure") span.textContent = admin ? "Histórico" : "Cierre";
    });
    const navInicioIcon = document.querySelector('#payBottomNav [data-pay-nav="inicio"] svg');
    if (navInicioIcon) navInicioIcon.innerHTML = admin
      ? '<path d="M7 3h10v18l-2-1-2 1-2-1-2 1-2-1Z"></path><path d="M9 8h6M9 12h6M9 16h4"></path>'
      : '<path d="M3 10.5 12 3l9 7.5"></path><path d="M5 10v10h14V10"></path>';
    const navChoferIcon = document.querySelector('#payBottomNav [data-pay-nav="actividad"] svg');
    if (navChoferIcon) navChoferIcon.innerHTML = admin
      ? '<circle cx="9" cy="8" r="3"></circle><path d="M3 20c.5-4 2.6-6 6-6s5.5 2 6 6"></path><path d="M18 8v6M15 11h6"></path>'
      : '<path d="M4 6h16M4 12h16M4 18h10"></path>';
    const navClosureIcon = document.querySelector('#payBottomNav #payNavClosure svg');
    if (navClosureIcon) navClosureIcon.innerHTML = admin
      ? '<path d="M4 19V5"></path><path d="M4 19h16"></path><path d="M7 15l3-4 3 2 4-6"></path><path d="M16 7h3v3"></path>'
      : '<path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path><path d="M9 14h6M9 17h4"></path>';
    const navMain = document.querySelector('#payBottomNav .pay-nav-main');
    if (navMain) navMain.setAttribute('aria-label', admin ? 'Cierre contable' : 'Cobrar');
    const title = $("payActivityTitle");
    if (title) title.textContent = admin ? "Últimas actividades" : "Última actividad";
  }


  function driverRowsFor(rows = [], uid = "") {
    const targetUid = safe(uid);
    if (!targetUid) return [];
    return (rows || []).filter(row => closureBelongsToDriver(row, targetUid) || driverUidOf(row) === targetUid);
  }

  function adminDriverSummaryFromState(uid = "") {
    return computeSummary({
      records:driverRowsFor(state.records, uid),
      expenses:driverRowsFor(state.expenses, uid),
      closures:driverRowsFor(state.closures, uid),
      debts:driverRowsFor(state.debts, uid),
      debtPayments:driverRowsFor(state.debtPayments, uid),
      uberWeeks:driverRowsFor(state.uberWeeks, uid)
    });
  }

  function setAdminBoardDriver(uid = "") {
    const targetUid = safe(uid);
    const driver = state.drivers.find(item => item.uid === targetUid || item.id === targetUid);
    if (!targetUid || !driver) throw new Error("No se pudo identificar al chofer.");
    state.selectedDriverUid = driver.uid;
    state.selectedDriverName = driver.name;
  }

  function pendingAdminClosureForDriver(uid = "", kind = "") {
    const targetUid = safe(uid);
    const target = activeClosureKind(kind);
    if (!targetUid || !target) return null;
    return (state.closures || [])
      .filter(row => safe(row.closureMode || row.periodType) === "on_demand")
      .filter(row => !closureInvalidatesCutoff(row))
      .filter(row => !closureIsCompleted(row))
      .filter(row => closureBelongsToDriver(row, targetUid))
      .filter(row => closureMatchesIndependentModule(row, target))
      .sort((a,b)=>rowMs(b)-rowMs(a))[0] || null;
  }

  function adminClosureActionForDriver(closure = {}, uid = "") {
    if (!closure || closureIsCompleted(closure)) return "none";
    if (uid && !closureBelongsToDriver(closure, uid)) return "none";
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const proof = closureHasProof(closure);
    if (toDriver > 0 && !proof) return "admin_upload";
    if (due > 0 && proof) return "admin_review";
    if (due > 0 && !proof) return "admin_waiting_driver";
    return "view";
  }

  function adminDebtReductionForDriver(uid = "") {
    const targetUid = safe(uid);
    if (!targetUid) return null;
    return debtPaymentRows(driverRowsFor(state.debtPayments, targetUid))
      .filter(row => !(row.adminAcknowledged === true || row.acknowledged === true || row.adminAccepted === true || row.accepted === true || row.read === true))
      .sort((a,b)=>rowMs(b)-rowMs(a))[0] || null;
  }

  function latestDebtPaymentForDriver(uid = "") {
    const targetUid = safe(uid);
    if (!targetUid) return null;
    return debtPaymentRows(driverRowsFor(state.debtPayments, targetUid))
      .sort((a,b)=>rowMs(b)-rowMs(a))[0] || null;
  }

  function adminClosureMetricHtml(label = "", value = 0) {
    return `<div class="pay-admin-closure-metric"><span>${esc(label)}</span><strong>${esc(currency(value || 0))}</strong></div>`;
  }

  function adminClosureActionHtml({ uid = "", kind = "", action = "", label = "", tone = "", disabled = false, id = "" } = {}) {
    const cls = ["pay-admin-closure-action", tone ? `is-${tone}` : ""].filter(Boolean).join(" ");
    return `<button class="${cls}" data-pay-admin-closure-action="${esc(action)}" data-driver-uid="${esc(uid)}" data-kind="${esc(kind)}" data-row-id="${esc(id)}" type="button"${disabled ? " disabled" : ""}>${esc(label)}</button>`;
  }

  function adminBillingRequestAction(uid = "", kind = "chofer", summary = computeSummary()) {
    const pending = pendingAdminClosureForDriver(uid, kind);
    const pendingAction = pending ? adminClosureActionForDriver(pending, uid) : "";
    if (pending && (pendingAction === "admin_review" || pendingAction === "admin_upload")) {
      const label = pendingAction === "admin_upload" ? "Cargar comprobante" : "Chofer cargó comprobante";
      return adminClosureActionHtml({ uid, kind, action:"open-closure", id:safe(pending.id), label, tone:"red" });
    }
    if (pending) {
      const waiting = pendingAction === "admin_waiting_driver" ? "Esperando chofer · revisar" : "Revisar cierre abierto";
      return adminClosureActionHtml({ uid, kind, action:"open-closure", id:safe(pending.id), label:waiting, tone:"red", disabled:false });
    }
    const target = activeClosureKind(kind);
    const t = tabSummary(summary, target);
    let enabled = false;
    let label = "Pedir cierre";
    if (target === "chofer") {
      const amountFromDriver = number(summary.amountFromDriverForBilling || t.amountFromDriver || 0);
      const amountToDriver = number(summary.amountToDriverForBilling || tabSummary(summary, "explora").amountToDriver || 0);
      enabled = amountFromDriver > 0.49;
      if (!enabled) label = amountToDriver > 0.49 ? "Liquida Explora" : "Sin acción";
    } else if (target === "caja_chica") {
      return adminClosureActionHtml({ uid, kind, action:"none", label:"Se cierra con Facturación", tone:"locked", disabled:true });
    } else {
      enabled = !!closureButtonState(kind, summary).enabled;
    }
    return adminClosureActionHtml({ uid, kind, action:enabled ? "request-closure" : "none", label, tone:enabled ? "primary" : "locked", disabled:!enabled });
  }

  function adminIncomingClosureAction(uid = "", kind = "explora", summary = computeSummary()) {
    const pending = pendingAdminClosureForDriver(uid, kind);
    const action = pending ? adminClosureActionForDriver(pending, uid) : "";
    if (pending && (action === "admin_upload" || action === "admin_review")) {
      const label = action === "admin_upload" ? "Chofer pidió cierre · cargar comprobante" : "Chofer cargó comprobante · cerrar";
      return adminClosureActionHtml({ uid, kind, action:"open-closure", id:safe(pending.id), label, tone:"red" });
    }
    if (pending && action === "admin_waiting_driver") {
      return adminClosureActionHtml({ uid, kind, action:"open-closure", id:safe(pending.id), label:"Esperando chofer · revisar", tone:"red", disabled:false });
    }
    const target = activeClosureKind(kind);
    const t = tabSummary(summary, target);
    if (target === "gastos" && number(summary.pendingDebtTotal || summary.pendientes?.remainingAmount || 0) > 0.49 && number(t.expenseAmountToDriverBeforeDebt || t.amountToDriver || 0) > 0.49) {
      return adminClosureActionHtml({ uid, kind, action:"none", label:"Deuda activa · compensar primero", tone:"locked", disabled:true });
    }
    const amountFromDriver = target === "explora"
      ? number(summary.amountFromDriverForBilling || tabSummary(summary, "chofer").amountFromDriver || 0)
      : number(t.amountFromDriver || 0);
    // En el tablero admin, Explora y Gastos NO habilitan carga directa solo por tener saldo.
    // Deben quedar bloqueados hasta que exista un cierre/pedido iniciado por el chofer; recién ahí
    // aparece el botón rojo para que admin cargue comprobante o revise el comprobante recibido.
    const label = amountFromDriver > 0.49 ? "Paga chofer" : "Sin pedido activo";
    return adminClosureActionHtml({ uid, kind, action:"none", label, tone:"locked", disabled:true });
  }

  function adminDebtAction(uid = "", summary = adminDriverSummaryFromState(uid)) {
    const payment = adminDebtReductionForDriver(uid);
    if (payment) {
      const amount = amountOf(payment);
      return adminClosureActionHtml({ uid, kind:"pendientes", action:"accept-debt", id:safe(payment.id || payment.paymentId), label:`Chofer redujo deuda · aceptar${amount > 0 ? ` ${currency(amount)}` : ""}`, tone:"red" });
    }
    const pending = summary.pendientes || tabSummary(summary, "pendientes");
    const balance = Math.max(0, number(pending.remainingAmount || summary.pendingDebtTotal || 0));
    if (!(balance > 0.49)) return adminClosureActionHtml({ uid, kind:"pendientes", action:"none", label:"Sin deuda pendiente", tone:"locked", disabled:true });
    return adminClosureActionHtml({ uid, kind:"pendientes", action:"register-debt-payment", label:"Registrar pago", tone:"primary" });
  }

  function adminClosureModuleHtml({ kind = "", title = "", subtitle = "", metrics = [], actionHtml = "" } = {}) {
    return `
      <article class="pay-admin-closure-module pay-admin-closure-module-${esc(kind)}">
        <header><div><span>${esc(title)}</span><small>${esc(subtitle)}</small></div></header>
        <div class="pay-admin-closure-metrics">${metrics.join("")}</div>
        <div class="pay-admin-closure-action-wrap">${actionHtml}</div>
      </article>`;
  }

  function renderAdminDriverClosureCard(driver = {}, index = 0, total = 0) {
    const uid = safe(driver.uid || driver.id);
    const summary = adminDriverSummaryFromState(uid);
    const chofer = tabSummary(summary, "chofer");
    const explora = tabSummary(summary, "explora");
    const gastos = tabSummary(summary, "gastos");
    const caja = tabSummary(summary, "caja_chica");
    const pendientes = summary.pendientes || tabSummary(summary, "pendientes");
    const debtPayment = latestDebtPaymentForDriver(uid);
    const debtPaymentAmount = debtPayment ? amountOf(debtPayment) : 0;
    const modules = [
      adminClosureModuleHtml({
        kind:"chofer", title:"Chofer", subtitle:"Valor del chofer 50%",
        metrics:[
          adminClosureMetricHtml("Efectivo chofer", chofer.cashInDriver || 0),
          adminClosureMetricHtml("Parte chofer", chofer.billingShareEach || 0),
          adminClosureMetricHtml("Debe liquidar", chofer.amountFromDriver || 0)
        ],
        actionHtml:adminBillingRequestAction(uid, "chofer", summary)
      }),
      adminClosureModuleHtml({
        kind:"explora", title:"Explora", subtitle:"Valor de Explora 50%",
        metrics:[
          adminClosureMetricHtml("Digital Explora", explora.nonCashInExplora || 0),
          adminClosureMetricHtml("Parte Explora", explora.billingShareEach || 0),
          adminClosureMetricHtml("Caja chica descontada", explora.billingCashboxOffsetApplied || 0),
          adminClosureMetricHtml("Explora liquida", explora.amountToDriver || 0)
        ],
        actionHtml:adminIncomingClosureAction(uid, "explora", summary)
      }),
      adminClosureModuleHtml({
        kind:"gastos", title:"Gastos", subtitle:"Compartido 50/50 · liquida Explora",
        metrics:[
          adminClosureMetricHtml("Gastos cargados", gastos.expenseTotal || 0),
          adminClosureMetricHtml("Explora debía liquidar", gastos.expenseAmountToDriverBeforeDebt || gastos.exploraExpenseShare || 0),
          adminClosureMetricHtml("Ajuste de deuda", gastos.expenseDebtOffsetApplied || 0),
          adminClosureMetricHtml("Explora liquida", gastos.amountToDriver || 0)
        ],
        actionHtml:adminIncomingClosureAction(uid, "gastos", summary)
      }),
      adminClosureModuleHtml({
        kind:"caja_chica", title:"Caja chica", subtitle:"Cierra automáticamente con Facturación",
        metrics:[
          adminClosureMetricHtml("Efectivo base", caja.gross || 0),
          adminClosureMetricHtml("Caja chica 5%", caja.cashboxTotal || 0),
          adminClosureMetricHtml("Incluida en próximo cierre", caja.cashboxTotal || 0)
        ],
        actionHtml:adminClosureActionHtml({ uid, kind:"caja_chica", action:"none", label:"Se cierra con Facturación", tone:"locked", disabled:true })
      }),
      adminClosureModuleHtml({
        kind:"pendientes", title:"Deudas", subtitle:"100% a cargo del chofer",
        metrics:[
          adminClosureMetricHtml("Deuda actual", pendientes.remainingAmount || 0),
          adminClosureMetricHtml("Pagado", pendientes.totalPaid || 0),
          adminClosureMetricHtml("Última reducción", debtPaymentAmount || 0)
        ],
        actionHtml:adminDebtAction(uid, summary)
      })
    ];
    // Caja chica ya está incluida en el resultado final de Chofer/Explora; no volver a sumarla.
    const totalOpen = [chofer.amountFromDriver, explora.amountToDriver, gastos.amountToDriver, pendientes.remainingAmount].reduce((sum, value) => sum + Math.max(0, number(value)), 0);
    return `
      <article class="pay-admin-driver-closure-card" data-driver-uid="${esc(uid)}">
        <header class="pay-admin-driver-closure-head">
          <div><span>CHOFER ${esc(String(index + 1))} / ${esc(String(total || 1))}</span><h2>${esc(driver.name || "Chofer")}</h2></div>
          <strong>${esc(currency(totalOpen || 0))}</strong>
        </header>
        <div class="pay-admin-driver-closure-grid">${modules.join("")}</div>
      </article>`;
  }

  function renderAdminClosuresScreen() {
    const list = $("payAdminClosuresList");
    if (!list) return;
    if (!isAdmin()) {
      list.innerHTML = `<div class="pay-admin-closures-empty">Esta vista es solo para administrador.</div>`;
      return;
    }
    if (!state.drivers.length) {
      list.innerHTML = `<div class="pay-admin-closures-empty">No hay choferes activos para mostrar.</div>`;
      return;
    }
    const total = state.drivers.length;
    list.innerHTML = state.drivers.map((driver, index) => renderAdminDriverClosureCard(driver, index, total)).join("");
  }

  async function acceptAdminDebtReduction(rowId = "") {
    const id = safe(rowId);
    if (!id) throw new Error("No se pudo identificar la reducción de deuda.");
    const payment = (state.debtPayments || []).find(row => safe(row.id || row.paymentId) === id || safe(row.paymentId) === id);
    const docId = safe(payment?.id || payment?.paymentId || id);
    const nowMs = Date.now();
    await updateDoc(doc(state.db, "deuda_pagos", docId), {
      adminAcknowledged:true,
      acknowledged:true,
      adminAccepted:true,
      accepted:true,
      read:true,
      acknowledgedByUid:state.auth?.currentUser?.uid || "",
      acknowledgedByName:accountName(),
      acknowledgedAt:serverTimestamp(),
      acknowledgedAtMs:nowMs,
      updatedAt:serverTimestamp(),
      updatedAtMs:nowMs
    });
    if (payment?.paymentId) {
      updateDoc(doc(state.db, "notificaciones", `debt_payment_${payment.paymentId}`), {
        adminAcknowledged:true,
        acknowledged:true,
        read:true,
        acknowledgedByUid:state.auth?.currentUser?.uid || "",
        acknowledgedAt:serverTimestamp(),
        acknowledgedAtMs:nowMs,
        updatedAt:serverTimestamp(),
        updatedAtMs:nowMs
      }).catch(()=>{});
    }
    state.debtPayments = state.debtPayments.map(row => (safe(row.id || row.paymentId) === id || safe(row.paymentId) === id) ? { ...row, adminAcknowledged:true, acknowledged:true, adminAccepted:true, accepted:true, read:true, acknowledgedAtMs:nowMs } : row);
    render();
  }

  async function handleAdminClosuresAction(button) {
    if (!isAdmin()) throw new Error("Solo administrador.");
    const action = safe(button.dataset.payAdminClosureAction);
    const uid = safe(button.dataset.driverUid);
    const kind = activeClosureKind(button.dataset.kind || "");
    const rowId = safe(button.dataset.rowId);
    if (action === "none") return;
    if (action === "accept-debt") {
      await acceptAdminDebtReduction(rowId);
      return;
    }
    setAdminBoardDriver(uid);
    if (action === "register-debt-payment") {
      state.latestSummary = adminDriverSummaryFromState(uid);
      if (typeof window.ExploraAdminTools?.openDebt === "function") {
        showPayView("inicio");
        await window.ExploraAdminTools.openDebt({ mode:"payment", driverUid:uid });
      } else {
        openAdminDebtPaymentModal(uid);
      }
      return;
    }
    if (action === "admin-pay-now") {
      state.latestSummary = adminDriverSummaryFromState(uid);
      await openClosureModal("admin-pay-now", null, kind);
      const select = $("payClosureDriverSelect");
      if (select) select.value = uid;
      return;
    }
    if (action === "request-closure") {
      state.latestSummary = adminDriverSummaryFromState(uid);
      await openClosureModal("request", null, kind);
      // El modal se renderiza después de fetchDrivers(); reforzamos el chofer seleccionado
      // para que el submit trabaje sobre el chofer de esta pantalla y no sobre otro estado.
      const select = $("payClosureDriverSelect");
      if (select) select.value = uid;
      return;
    }
    if (action === "open-closure") {
      const closure = (state.closures || []).find(row => safe(row.id || row.closureId) === rowId) || pendingAdminClosureForDriver(uid, kind);
      if (!closure) throw new Error("No se encontró el cierre pendiente.");
      await openClosureModal("admin-review", closure, kind);
      return;
    }
  }

  function movementRows(summary = computeSummary()) {
    const rows = [];
    // Chofer: mantiene la lógica del ciclo abierto. Admin: auditoría global en bruto.
    const adminMode = isAdmin();
    const paymentRows = adminMode ? (state.records || []) : (summary.records || summary.billingRecords || []);
    const cashboxRows = adminMode ? (state.records || []).filter(row => methodOf(row) === "cash" && !cashboxIsExcluded(row) && !movementIsDeleted(row)) : (summary.cashboxRecords || []);
    const expenseRows = adminMode ? (state.expenses || []) : (summary.expenses || []);

    for (const row of paymentRows || []) {
      if (movementIsDeleted(row)) continue;
      const amount = amountOf(row), method = methodOf(row), at = rowMs(row);
      const financialId = safe(row.id || row.recordId || row.operationId || row.billingRecordId || row.billingId);
      if (!(amount > 0)) continue;
      if (isDriverBillingSettlementPayment(row)) {
        const paymentHasPhoto = rowHasAttachment(row);
        rows.push({
          at, type:"billing_payment", method, source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · Pago del chofer`,
          financialKind:"cobro", financialId,
          meta:safe(row.reason || row.description || row.detalle || row.notes || "Pago aplicado a Facturación"),
          detail:`Reduce únicamente el saldo de Facturación · Deudas independientes sin cambios`,
          amount, positive:true,
          hasPhoto:paymentHasPhoto,
          photoKey:paymentHasPhoto ? activityPhotoKey("billing_driver_payment", row) : "",
          photoTitle:"Pago del chofer a Explora",
          photoMeta:method === "transfer" ? "Comprobante de transferencia" : "Comprobante del pago",
          photoAmount:amount
        });
        continue;
      }
      const cashbox = method === "cash" ? amount * .05 : 0;
      const paymentHasPhoto = method !== "cash" && rowHasAttachment(row);
      rows.push({
        at, type:"payment", method, source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · ${paymentLabel(method)}`,
        financialKind:"cobro", financialId,
        meta:safe(row.description || row.detalle || row.notes || row.ruta || "Servicio registrado"),
        detail: method === "cash"
          ? `Cobró el chofer en efectivo: ${currency(amount)} · caja chica separada ${currency(cashbox)}`
          : `Cobró Explora: ${currency(amount)} · no genera caja chica`,
        amount, positive:true,
        hasPhoto:paymentHasPhoto,
        photoKey:paymentHasPhoto ? activityPhotoKey(`payment_${method}`, row) : "",
        photoTitle:paymentLabel(method),
        photoMeta:"Comprobante digital de Explora",
        photoAmount:amount
      });
    }

    for (const row of cashboxRows || []) {
      if (movementIsDeleted(row)) continue;
      const amount = amountOf(row), at = rowMs(row);
      if (!(amount > 0)) continue;
      const cashbox = amount * .05;
      rows.push({
        at: at + 1, type:"cashbox", source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · Caja chica 5%`,
        meta:safe(row.description || row.detalle || row.notes || row.ruta || "Generada automáticamente por cobro efectivo"),
        detail:`Caja chica generada solo por efectivo: la tiene el chofer y debe pasarla a Explora`,
        amount:-cashbox, negative:true
      });
    }

    for (const row of expenseRows || []) {
      if (movementIsDeleted(row)) continue;
      const at = rowMs(row);
      const { amount, driverPart, exploraPart } = expenseParts(row);
      const financialId = safe(row.id || row.expenseId || row.gastoId || row.recordId || row.operationId);
      if (!(amount > 0)) continue;
      const expenseHasPhoto = rowHasAttachment(row);
      rows.push({
        at, type:"expense", source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · ${expenseTypeLabel(row)}`,
        financialKind:"gasto", financialId,
        meta:safe(row.notes || row.descripcion || row.description || "Gasto operativo"),
        detail: `Gasto cargado por el chofer: ${currency(amount)} · Explora reintegra ${currency(exploraPart)} · Parte chofer ${currency(driverPart)}`,
        amount:-amount, negative:true,
        hasPhoto:expenseHasPhoto,
        photoKey:expenseHasPhoto ? activityPhotoKey("expense", row) : "",
        photoTitle:expenseTypeLabel(row),
        photoMeta:"Comprobante de gasto",
        photoAmount:amount
      });
    }

    const activeDebtRows = adminMode ? (state.debts || []).filter(row => !movementIsDeleted(row)) : (summarizePendingDebts(state.debts).activeDebts || []);
    try { window.ExploraPendingDebtRows = activeDebtRows; } catch (_) {}
    for (const row of activeDebtRows) {
      const at = debtCreatedMs(row) || rowMs(row);
      const remaining = debtRemainingAmount(row);
      const debtId = debtActivityId(row);
      const debtHasPhoto = debtHasAttachment(row);
      rows.push({
        at, type:"debt", source:row, driverName:driverNameForRow(row), title:`${dateTimeShort(at)} · ${debtTypeLabel(row)}`,
        meta:safe(row.description || row.descripcion || row.reasonDetail || row.notes || "Pendiente cargado por administrador"),
        detail:`Saldo actual independiente: ${currency(remaining)} · no afecta facturación`,
        amount:-remaining, negative:true,
        debtId, hasPhoto:debtHasPhoto,
        photoKey:debtHasPhoto ? activityPhotoKey("debt", row) : "",
        photoTitle:debtTypeLabel(row),
        photoMeta:"Comprobante de pendiente",
        photoAmount:debtTotalAmount(row) || remaining
      });
    }

    for (const row of debtPaymentRows(state.debtPayments)) {
      if (movementIsDeleted(row)) continue;
      const at = rowMs(row);
      const amount = amountOf(row);
      if (!(amount > 0)) continue;
      const debtPaymentHasPhoto = rowHasAttachment(row);
      const fromExpenses = debtPaymentUsesExpenses(row);
      const registeredByAdmin = row.registeredByAdmin === true || safe(row.createdByRole).toLowerCase() === "admin";
      const tenderLabel = debtPaymentTenderLabel(row);
      const originalExpenseDue = number(row.expenseAmountBeforeOffset || row.expenseBalanceBefore || 0);
      const finalExpenseDue = number(row.expenseAmountAfterOffset || row.expenseBalanceAfter || Math.max(0, originalExpenseDue - amount));
      rows.push({
        at, type:fromExpenses ? "debt_expense_offset" : "debt_payment", source:row, driverName:driverNameForRow(row),
        title:`${dateTimeShort(at)} · ${fromExpenses ? "Ajuste de deuda con saldo de Gastos" : registeredByAdmin ? "Entrega registrada por Explora" : "Reducción de deuda"}`,
        meta:fromExpenses ? "Compensación automática sin comprobante" : registeredByAdmin ? `${tenderLabel} · confirmado por administrador` : safe(row.driverName || row.choferNombre || "Comprobante cargado"),
        detail:fromExpenses
          ? `Explora debía liquidar ${currency(originalExpenseDue)} · chofer utilizó ${currency(amount)} para achicar deuda · Explora debe liquidar ${currency(finalExpenseDue)}`
          : `Pago aplicado: ${currency(amount)} · medio: ${tenderLabel.toLowerCase()} · saldo nuevo ${currency(row.newBalance || 0)}`,
        amount, positive:true,
        hasPhoto:!fromExpenses && debtPaymentHasPhoto,
        photoKey:!fromExpenses && debtPaymentHasPhoto ? activityPhotoKey("debt_payment", row) : "",
        photoTitle:fromExpenses ? "Ajuste de deuda con Gastos" : "Reducción de deuda",
        photoMeta:fromExpenses ? "Compensación con saldo de Gastos" : "Comprobante de pago",
        photoAmount:amount
      });
    }

    for (const row of state.closures.filter(closureIsVisibleOnDemand)) {
      const at = rowMs(row);
      const closureKind = closureKindOf(row);
      const stateText = closureActivityStateText(row);
      const closureHasPhoto = rowHasAttachment(row) || !!closureProofUrl(row);
      rows.push({
        at, type:"closure", source:row, driverName:driverNameForRow(row), closureId:safe(row.id || row.closureId), tone:closurePayerClass(row), title:`${dateTimeShort(at)} · ${closureTitle(closureKind)} · ${stateText}`,
        meta:closureActivityMeta(row),
        detail:`${closureStatusText(row)} · A rendir: ${currency(row.amountDueFromDriver || 0)} · A cobrar: ${currency(row.amountDueToDriver || 0)}`,
        amount:0,
        hasPhoto:closureHasPhoto,
        photoKey:closureHasPhoto ? activityPhotoKey("closure", row) : "",
        photoTitle:closureTitle(closureKind),
        photoMeta:"Comprobante de cierre",
        photoAmount:Math.max(number(row.amountDueFromDriver || 0), number(row.amountDueToDriver || 0), number(row.mainTotal || 0))
      });
    }
    return rows.filter(activityMatchesSelectedModule).sort((a,b)=>b.at-a.at).slice(0, adminMode ? 60 : 12);
  }

  function historyScopeLabel(scope = state.historyScope) {
    return HISTORY_SCOPES.find(([value]) => value === scope)?.[1] || "Histórico total";
  }

  function historyDefaultDriverUid() {
    if (!isAdmin()) return getOwnDriverUid();
    return safe(state.historyDriverUid || state.selectedDriverUid || state.drivers[0]?.uid || "");
  }

  function openHistoryScreen() {
    showPayView("historico");
    if (!isAdmin()) {
      const own = getOwnDriverUid();
      if (own && state.historyDriverUid !== own) {
        state.historyDriverUid = own;
        state.historyDriverName = displayName();
      }
      loadHistoryDataForDriver(own);
      return;
    }
    fetchDrivers().then(() => {
      const uid = historyDefaultDriverUid();
      if (uid && state.historyDriverUid !== uid) {
        const driver = state.drivers.find(item => item.uid === uid);
        state.historyDriverUid = uid;
        state.historyDriverName = driver?.name || state.selectedDriverName || "";
      }
      renderHistoryScreen();
      if (uid) loadHistoryDataForDriver(uid);
    }).catch(error => {
      state.historyError = error?.message || "No se pudieron cargar los choferes.";
      renderHistoryScreen();
    });
  }

  function selectHistoryDriver(uid = "") {
    const next = safe(uid);
    const driver = state.drivers.find(item => item.uid === next);
    state.historyDriverUid = next;
    state.historyDriverName = driver?.name || "";
    state.historyData = { uid:"", records:[], expenses:[], debtPayments:[] };
    state.historyMonthId = "";
    renderHistoryScreen();
    if (next) loadHistoryDataForDriver(next);
  }

  async function loadHistoryDataForDriver(uid = state.historyDriverUid) {
    const targetUid = safe(uid || historyDefaultDriverUid());
    if (!targetUid || !state.db) return;
    state.historyLoading = true;
    state.historyError = "";
    renderHistoryScreen();
    try {
      const [records, expenses, debtPayments] = await Promise.all([
        getScopedDocs("billing_records", targetUid),
        getScopedDocs("gastos", targetUid),
        getScopedDocs("deuda_pagos", targetUid)
      ]);
      state.historyData = {
        uid:targetUid,
        records:records.sort((a,b)=>rowMs(b)-rowMs(a)),
        expenses:expenses.sort((a,b)=>rowMs(b)-rowMs(a)),
        debtPayments:debtPayments.sort((a,b)=>rowMs(b)-rowMs(a))
      };
    } catch (error) {
      state.historyError = error?.message || "No se pudo cargar el histórico.";
    } finally {
      state.historyLoading = false;
      renderHistoryScreen();
    }
  }

  function currentMonthId(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthIdFromMs(value = Date.now()) {
    const d = new Date(value || Date.now());
    return currentMonthId(d);
  }

  function monthLabel(monthId = currentMonthId()) {
    const [year, month] = safe(monthId).split("-").map(Number);
    if (!year || !month) return "Mes actual";
    return new Intl.DateTimeFormat("es-AR", { month:"long", year:"numeric" }).format(new Date(year, month - 1, 1));
  }

  function monthRange(monthId = currentMonthId()) {
    const [year, month] = safe(monthId || currentMonthId()).split("-").map(Number);
    const y = year || new Date().getFullYear();
    const m = (month || (new Date().getMonth() + 1)) - 1;
    const start = new Date(y, m, 1, 0, 0, 0, 0);
    const end = new Date(y, m + 1, 0, 23, 59, 59, 999);
    return { startMs:start.getTime(), endMs:Math.min(end.getTime(), Date.now()), label:monthLabel(`${y}-${String(m + 1).padStart(2,"0")}`) };
  }

  function driverCreatedMs(driver = null) {
    const item = driver || state.drivers.find(row => row.uid === safe(state.historyDriverUid || historyDefaultDriverUid())) || {};
    const profile = item.profile || item || {};
    const candidates = [
      profile.createdAt, profile.altaAt, profile.created, profile.fechaAlta, profile.createdDate, profile.creationDate, profile.registeredAt,
      profile.createdAtMs, profile.altaAtMs, profile.creationMs, profile.registeredAtMs,
      item.createdAt, item.createdAtMs
    ];
    const values = candidates.map(ms).filter(value => value > 0);
    const data = state.historyData || {};
    for (const row of [...(data.records || []), ...(data.expenses || []), ...(data.debtPayments || [])]) {
      const at = rowMs(row) || debtCreatedMs(row);
      if (at > 0) values.push(at);
    }
    return values.length ? Math.min(...values) : 0;
  }

  function historyAvailableMonths() {
    const now = new Date();
    const created = driverCreatedMs();
    const start = created > 0 ? new Date(created) : new Date(now.getFullYear(), now.getMonth(), 1);
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 1);
    const months = [];
    while (cursor.getTime() <= last.getTime()) {
      months.push(currentMonthId(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return months.length ? months : [currentMonthId(now)];
  }

  function ensureHistoryMonthId() {
    const months = historyAvailableMonths();
    const current = safe(state.historyMonthId || currentMonthId());
    state.historyMonthId = months.includes(current) ? current : months[months.length - 1];
    return state.historyMonthId;
  }

  function historyRange(scope = state.historyScope) {
    const nowMs = Date.now();
    if (scope === "daily") return { startMs:nowMs - 24 * 60 * 60 * 1000, endMs:nowMs, label:"Últimas 24 horas" };
    if (scope === "weekly") return { startMs:nowMs - 7 * 24 * 60 * 60 * 1000, endMs:nowMs, label:"Últimos 7 días" };
    if (scope === "monthly") return monthRange(ensureHistoryMonthId());
    const created = driverCreatedMs();
    return { startMs:created || 0, endMs:nowMs, label:created ? `Desde ${dateShort(created)}` : "Desde la creación" };
  }

  function historyInRange(row = {}, range = historyRange()) {
    const at = rowMs(row) || debtCreatedMs(row);
    return at > 0 && at >= range.startMs && at <= range.endMs;
  }

  function computeHistoryReport(scope = state.historyScope) {
    const range = historyRange(scope);
    const data = state.historyData || {};
    const records = (data.records || []).filter(row => !movementIsDeleted(row) && !isDriverBillingSettlementPayment(row) && historyInRange(row, range));
    const expenses = (data.expenses || []).filter(row => !movementIsDeleted(row) && historyInRange(row, range));
    const debtPayments = (data.debtPayments || []).filter(row => !movementIsDeleted(row) && historyInRange(row, range));
    const totalFacturado = records.reduce((sum,row)=>sum + amountOf(row), 0);
    const chofer = totalFacturado * .5;
    const exploraBase = totalFacturado - chofer;
    const cajaChica = records.filter(row => methodOf(row) === "cash" && !cashboxIsExcluded(row)).reduce((sum,row)=>sum + amountOf(row), 0) * .05;
    const deudaCobrada = debtPayments.reduce((sum,row)=>sum + amountOf(row), 0);
    const gastos = expenses.reduce((sum,row)=>sum + expenseParts(row).amount, 0);
    const ganaExplora = exploraBase + cajaChica + deudaCobrada - gastos;
    return { scope, range, records, expenses, debtPayments, totalFacturado, chofer, exploraBase, cajaChica, deudaCobrada, gastos, ganaExplora };
  }

  function historyBarHtml(label = "", value = 0, max = 1, tone = "plus") {
    const amount = Math.abs(number(value || 0));
    const pct = Math.max(5, Math.min(100, Math.round((amount / Math.max(1, max)) * 100)));
    return `<article class="pay-history-bar is-${tone}"><div><span>${esc(label)}</span><strong>${currency(value)}</strong></div><i style="--w:${pct}%"></i></article>`;
  }

  function renderHistoryScreen() {
    const driverSelect = $("payHistoryDriverSelect");
    const scopeSelect = $("payHistoryScopeSelect");
    const monthField = $("payHistoryMonthField");
    const monthSelect = $("payHistoryMonthSelect");
    const content = $("payHistoryContent");
    if (!content) return;
    if (scopeSelect) scopeSelect.value = state.historyScope || "total";
    const isMonthlyScope = (state.historyScope || "total") === "monthly";
    if (monthField) monthField.hidden = !isMonthlyScope;
    if (monthSelect) {
      const months = historyAvailableMonths();
      const selectedMonth = isMonthlyScope ? ensureHistoryMonthId() : safe(state.historyMonthId || currentMonthId());
      monthSelect.disabled = state.historyLoading;
      monthSelect.innerHTML = months.map(month => `<option value="${esc(month)}" ${month === selectedMonth ? "selected" : ""}>${esc(monthLabel(month))}</option>`).join("");
    }
    if (driverSelect) {
      if (isAdmin()) {
        const selected = safe(state.historyDriverUid || historyDefaultDriverUid());
        driverSelect.disabled = state.historyLoading;
        driverSelect.innerHTML = state.drivers.length
          ? state.drivers.map(driver => `<option value="${esc(driver.uid)}" ${driver.uid === selected ? "selected" : ""}>${esc(driver.name)}</option>`).join("")
          : '<option value="">Sin choferes cargados</option>';
      } else {
        driverSelect.disabled = true;
        driverSelect.innerHTML = `<option value="${esc(getOwnDriverUid())}">${esc(displayName())}</option>`;
      }
    }
    if (state.historyLoading) {
      content.innerHTML = '<div class="pay-history-empty">Cargando datos del histórico…</div>';
      return;
    }
    if (state.historyError) {
      content.innerHTML = `<div class="pay-history-empty is-error">${esc(state.historyError)}</div>`;
      return;
    }
    const uid = safe(state.historyDriverUid || historyDefaultDriverUid());
    if (!uid) {
      content.innerHTML = '<div class="pay-history-empty">Seleccioná un chofer para ver el histórico.</div>';
      return;
    }
    const report = computeHistoryReport(state.historyScope || "total");
    const max = Math.max(Math.abs(report.exploraBase), Math.abs(report.cajaChica), Math.abs(report.deudaCobrada), Math.abs(report.gastos), 1);
    const driverName = state.historyDriverName || state.drivers.find(item => item.uid === uid)?.name || displayName();
    content.innerHTML = `
      <section class="pay-history-result ${report.ganaExplora < 0 ? "is-negative" : "is-positive"}">
        <div class="pay-history-result-head">
          <span>${esc(driverName)}</span>
          <small>${esc(historyScopeLabel(report.scope))} · ${esc(report.range.label)}</small>
        </div>
        <strong>${currency(report.ganaExplora)}</strong>
        <p>Gana Explora hasta este momento</p>
      </section>
      <section class="pay-history-chart" aria-label="Gráfico histórico Explora">
        ${historyBarHtml("Facturación Explora", report.exploraBase, max, "plus")}
        ${historyBarHtml("Caja chica", report.cajaChica, max, "plus")}
        ${historyBarHtml("Deuda cobrada", report.deudaCobrada, max, "plus")}
        ${historyBarHtml("Gastos", -report.gastos, max, "minus")}
      </section>
      <section class="pay-history-metrics">
        <div><span>Total facturado</span><strong>${currency(report.totalFacturado)}</strong></div>
        <div><span>Parte chofer 50%</span><strong>-${currency(report.chofer)}</strong></div>
        <div><span>Caja chica</span><strong>${currency(report.cajaChica)}</strong></div>
        <div><span>Deuda cobrada</span><strong>${currency(report.deudaCobrada)}</strong></div>
        <div><span>Gastos</span><strong>-${currency(report.gastos)}</strong></div>
      </section>`;
  }

  function render() {
    installShell();
    renderAdminShellState();
    const summary = computeSummary();
    state.latestSummary = summary;
    state.pendingClosure = pendingClosureFor(getDriverUid(), state.tab);
    if (!PAY_TAB_ORDER.includes(state.tab)) state.tab = "chofer";
    const dashboard = $("exploraPagoDashboard");
    if (dashboard) dashboard.dataset.activePayTab = state.tab;
    document.querySelectorAll("[data-pay-tab]").forEach(button => {
      const active = button.dataset.payTab === state.tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    renderTabAlerts();
    setTimeout(scrollActivePayTabIntoView, 0);
    const greeting = $("payGreeting");
    if (greeting) greeting.textContent = isAdmin() ? "Admin · últimas actividades" : `Hola, ${displayName()}`;
    renderAdminDriverPicker();
    renderMainCard(summary);
    renderClosureStatus(summary);
    renderEfficiencyButton();
    renderActivities(summary);
    renderBellBadge();
    if (state.view === "mas") {
      showPayView("mas");
    } else if (state.view === "notificaciones") {
      showPayView("notificaciones");
    } else if (state.view === "admin-cierres") {
      showPayView("admin-cierres");
    } else if (state.view === "historico") {
      showPayView("historico");
    } else {
      setBottomNavActive("inicio");
    }
    if ($("payClosureBackdrop")?.classList.contains("is-open")) renderClosureModal();
    if ($("payAdminDeleteBackdrop")?.classList.contains("is-open")) renderAdminDeleteModal();
  }

  function pendingValueForTab(closure = {}, kind = state.tab) {
    const target = activeClosureKind(kind);
    if (target === "caja_chica") return number(closure.cashboxTotal || closure.mainTotal || 0);
    if (target === "gastos") return number(closure.expenseTotal || 0);
    if (target === "chofer") return number(closure.cashInDriver || 0);
    if (target === "explora") return number(closure.exploraCash || closure.nonCashInExplora || 0);
    if (isBillingClosureKind(target)) return number(closure.gross || 0);
    return 0;
  }

  function pendingResultLine(closure = {}) {
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    if (due > 0) return `Chofer debe liquidar a Explora ${currency(due)}`;
    if (toDriver > 0) return `Explora debe liquidar a chofer ${currency(toDriver)}`;
    return "Nadie debe liquidar";
  }

  function closureMatchesSummaryKind(row = {}, kind = state.tab) {
    const target = mapModuleKey(kind);
    if (!target) return false;
    if (target === "caja_chica" && isBillingClosureKind(closureKindOf(row)) && billingClosureClosesCashbox(row)) return true;
    return closureMatchesIndependentModule(row, target);
  }

  function firstUsefulNumber(row = {}, fields = []) {
    let firstFinite = null;
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
      const value = number(row[field]);
      if (firstFinite === null) firstFinite = value;
      if (value > 0) return value;
    }
    return firstFinite;
  }

  function closureSnapshotAmount(row = {}, kind = state.tab) {
    const target = activeClosureKind(kind);
    if (target === "gastos") {
      const direct = firstUsefulNumber(row, ["expenseTotal", "mainTotal", "gross", "total", "amount", "monto"]);
      return direct ?? 0;
    }
    if (target === "caja_chica") {
      const direct = firstUsefulNumber(row, ["cashboxTotal", "mainTotal", "amountDueFromDriver", "amountFromDriver", "total", "amount", "monto"]);
      return direct ?? 0;
    }
    if (isBillingClosureKind(target)) {
      const direct = firstUsefulNumber(row, ["gross", "grossBeforeCashbox", "totalFacturado", "totalBilling", "billingTotal", "mainTotal", "total", "amount", "monto"]);
      if (direct !== null) return direct;
      return number(row.cashInDriver || 0) + number(row.nonCashInExplora || row.exploraCash || 0);
    }
    return 0;
  }

  function previousClosureRow(kind = state.tab, uid = getDriverUid()) {
    const targetUid = safe(uid);
    if (isAdmin() && !targetUid) return null;
    return state.closures
      .filter(closureUsesActiveCutoff)
      .filter(row => closureMatchesSummaryKind(row, kind))
      .filter(row => !targetUid || closureBelongsToDriver(row, targetUid))
      .sort((a,b)=>closureCutMs(b)-closureCutMs(a) || rowMs(b)-rowMs(a))[0] || null;
  }

  function previousBillingClosureParts(row = {}) {
    const cash = firstUsefulNumber(row, ["cashInDriver", "cashGrossInDriver", "driverActualCash", "efectivoChofer", "cash", "efectivo"]) ?? 0;
    const digital = firstUsefulNumber(row, ["exploraCash", "nonCashInExplora", "nonCashGrossInExplora", "digitalExplora", "digitalInExplora", "digital", "transferQrCardTotal"]) ?? 0;
    const gross = firstUsefulNumber(row, ["gross", "grossBeforeCashbox", "totalFacturado", "totalBilling", "billingTotal", "mainTotal", "total", "amount", "monto"]) ?? (cash + digital);
    const storedShare = firstUsefulNumber(row, ["billingShareEach", "shareEach", "parteCadaUno", "driverEntitlement", "driverFinal", "exploraFinal"]);
    const share = storedShare !== null ? storedShare : (gross * .5);
    const fromDriver = firstUsefulNumber(row, ["amountDueFromDriver", "amountFromDriver", "paidByDriver", "liquidadoPorChofer", "driverPaidExplora"]) ?? 0;
    const toDriver = firstUsefulNumber(row, ["amountDueToDriver", "amountToDriver", "paidByExplora", "liquidadoPorExplora", "exploraPaidDriver"]) ?? 0;
    return {
      cash:Math.max(0, cash),
      digital:Math.max(0, digital),
      gross:Math.max(0, gross),
      share:Math.max(0, share),
      cashboxGenerated:Math.max(0, firstUsefulNumber(row, ["billingCashboxGenerated", "cashboxTotal", "cajaChicaGenerada"]) ?? 0),
      cashboxOffset:Math.max(0, firstUsefulNumber(row, ["billingCashboxOffsetApplied", "cashboxOffsetApplied", "cajaChicaDescontadaLiquidacion"]) ?? 0),
      fromDriver:Math.max(0, fromDriver),
      toDriver:Math.max(0, toDriver)
    };
  }

  function previousExpenseClosureParts(row = {}) {
    const total = firstUsefulNumber(row, ["expenseTotal", "mainTotal", "totalGastos", "total", "amount", "monto"]) ?? 0;
    const beforeDebt = firstUsefulNumber(row, ["expenseAmountToDriverBeforeDebt", "exploraExpenseShare", "parteExploraAntesDeuda"]) ?? (total * .5);
    const debtOffset = firstUsefulNumber(row, ["expenseDebtOffsetApplied", "debtExpenseOffset", "ajusteDeudaGastos"]) ?? 0;
    const byExplora = firstUsefulNumber(row, ["amountDueToDriver", "amountToDriver", "expenseAmountToDriverAfterDebt", "paidByExplora", "liquidadoPorExplora", "exploraPaidDriver"]) ?? Math.max(0, beforeDebt - debtOffset);
    const rendered = firstUsefulNumber(row, ["settledTotal", "rendidoTotal", "expenseSettledTotal", "expenseTotal", "mainTotal", "total", "amount", "monto"]) ?? total;
    return {
      total:Math.max(0, total),
      beforeDebt:Math.max(0, beforeDebt),
      debtOffset:Math.max(0, debtOffset),
      byExplora:Math.max(0, byExplora),
      rendered:Math.max(0, rendered)
    };
  }

  function previousCashboxClosureParts(row = {}) {
    const automatic = isBillingClosureKind(closureKindOf(row)) && billingClosureClosesCashbox(row);
    const total = firstUsefulNumber(row, automatic
      ? ["cashboxIncludedInSettlement", "cashboxTotal", "billingCashboxGenerated", "totalCajaChica"]
      : ["cashboxTotal", "mainTotal", "totalCajaChica", "total", "amount", "monto"]) ?? 0;
    const fromDriver = automatic
      ? total
      : (firstUsefulNumber(row, ["amountDueFromDriver", "amountFromDriver", "paidByDriver", "liquidadoPorChofer", "driverPaidExplora", "cashboxInDriver"]) ?? total);
    return {
      automatic,
      total:Math.max(0, total),
      fromDriver:Math.max(0, fromDriver)
    };
  }

  function previousSummaryRows(kind = state.tab, uid = getDriverUid()) {
    const row = previousClosureRow(kind, uid);
    const target = activeClosureKind(kind);
    if (!row) {
      const empty = isBillingClosureKind(target) ? "Sin facturación anterior" : "Sin cierre anterior";
      return [[empty, ""]];
    }
    if (target === "gastos") {
      const p = previousExpenseClosureParts(row);
      return [
        ["Gastos anteriores", currency(p.total)],
        ["Explora debía liquidar", currency(p.beforeDebt)],
        ["Ajuste de deuda", p.debtOffset > 0 ? `−${currency(p.debtOffset)}` : currency(0)],
        ["Liquidado por Explora", currency(p.byExplora)],
        ["Total gastos anterior / rendido", currency(p.rendered)]
      ];
    }
    if (target === "caja_chica") {
      const p = previousCashboxClosureParts(row);
      return p.automatic
        ? [
            ["Caja chica del cierre anterior", currency(p.total)],
            ["Incluida en Facturación", currency(p.total)],
            ["Tipo de cierre", "Automático"]
          ]
        : [
            ["Caja chica anterior", currency(p.total)],
            ["Liquidado por chofer", currency(p.fromDriver)],
            ["Total caja chica anterior", currency(p.total)]
          ];
    }
    if (target === "explora") {
      const p = previousBillingClosureParts(row);
      return [
        ["Digital anterior", currency(p.digital)],
        ["Caja chica descontada", p.cashboxOffset > 0 ? `−${currency(p.cashboxOffset)}` : currency(0)],
        ["Liquidado por Explora", currency(p.toDriver)],
        ["Total Explora anterior 50%", currency(p.share)]
      ];
    }
    if (target === "chofer") {
      const p = previousBillingClosureParts(row);
      return [
        ["Efectivo anterior", currency(p.cash)],
        ["Caja chica 5%", currency(p.cashboxGenerated)],
        ["Liquidado por Explora", currency(p.toDriver)],
        ["Total chofer anterior 50%", currency(p.share)]
      ];
    }
    const amount = closureSnapshotAmount(row, kind);
    return [["Facturación anterior", currency(amount)]];
  }

  function previousClosureSummaryHtml(kind = state.tab, uid = getDriverUid()) {
    const target = activeClosureKind(kind) || "caja_chica";
    const key = ["caja_chica", "gastos", "explora", "chofer"].includes(target) ? target : "caja_chica";
    const open = !!state.previousDetailsOpen[key];
    const panelId = `payPreviousSummary-${key}`;
    const rows = previousSummaryRows(key, uid);
    const rowsHtml = rows.map(([label, value]) => `
        <span class="pay-previous-row">
          <span>${esc(label)}</span>
          ${value ? `<strong>${esc(value)}</strong>` : ""}
        </span>`).join("");
    return `<span class="pay-previous-details${open ? " is-open" : ""}">
      <button class="pay-previous-toggle" type="button" data-pay-previous-toggle="${esc(key)}" aria-expanded="${open ? "true" : "false"}" aria-controls="${esc(panelId)}">${open ? "Ocultar detalles" : "Ver detalles"}</button>
      <span class="pay-previous-panel" id="${esc(panelId)}"${open ? "" : " hidden"}>${rowsHtml}
      </span>
    </span>`;
  }

  function renderMainCard(summary) {
    const amount = $("payMainAmount"), subtitle = $("payMainSubtitle"), pillLabel = $("payPillLabel"), pillAmount = $("payPillAmount"), extra = $("payExtraLines"), debtAliasHint = $("payDebtAliasHint"), expenseDebtReconciliation = $("payExpenseDebtReconciliation");
    if (!amount || !subtitle || !pillLabel || !pillAmount || !extra) return;
    const mainCard = amount.closest(".pay-main-card");
    if (mainCard) mainCard.classList.toggle("is-firestore-loading", !!state.dataLoading);
    if (state.dataLoading) {
      /* v4123: nunca pintar el estado verde "Actualizando" dentro del dashboard.
         El arranque autoritativo queda cubierto por el splash; si hay una
         resincronización en caliente se conservan placeholders neutros. */
      amount.textContent = "—";
      subtitle.textContent = "Sincronizando información";
      pillLabel.textContent = "Datos en preparación";
      pillAmount.textContent = "—";
      extra.innerHTML = [
        "Saldo actual", "Total del período", "Parte correspondiente", "Cierre del módulo"
      ].map(label => `<div><span>${esc(label)}</span><strong>—</strong></div>`).join("");
      if (debtAliasHint) debtAliasHint.hidden = true;
      if (expenseDebtReconciliation) { expenseDebtReconciliation.hidden = true; expenseDebtReconciliation.innerHTML = ""; }
      return;
    }
    if (debtAliasHint) debtAliasHint.hidden = activeClosureKind(state.tab) !== "pendientes" || isAdmin();
    if (expenseDebtReconciliation) {
      expenseDebtReconciliation.hidden = true;
      expenseDebtReconciliation.innerHTML = "";
    }
    const lines = [];
    if (isAdmin() && !getDriverUid()) {
      amount.textContent = currency(0);
      subtitle.innerHTML = "Seleccioná un chofer para cargar sus datos abiertos.";
      pillLabel.textContent = "Sin chofer seleccionado";
      pillAmount.textContent = currency(0);
      extra.innerHTML = `<div><span>Administrador</span><strong>Seleccionar chofer</strong></div>`;
      return;
    }
    let main = summary.cashboxTotal, sub = "Caja chica actual del período abierto", pill = "Caja chica", pillValue = 0;
    if (activeClosureKind(state.tab) === "pendientes") {
      const t = tabSummary(summary, "pendientes");
      main = t.remainingAmount || 0;
      sub = "Deuda independiente. No modifica Explora ni Chofer.";
      pill = main > 0 ? "Saldo actual pendiente" : "Sin deuda pendiente";
      pillValue = main;
      lines.push(
        ["Total deuda", currency(t.totalOriginal || main || 0)],
        ["Pagado", currency(t.totalPaid || 0)],
        ["Intereses / mora", currency(t.totalPenalty || 0)],
        ["Deudas activas", String((t.activeDebts || []).length)]
      );
      const top = (t.activeDebts || []).slice(0, 3);
      for (const debt of top) lines.push([debtTypeLabel(debt), currency(debtRemainingAmount(debt))]);
    } else if (activeClosureKind(state.tab) === "caja_chica") {
      const t = tabSummary(summary, "caja_chica");
      main = t.cashboxTotal || 0;
      sub = "Se cierra automáticamente junto con Facturación";
      pill = t.cashboxTotal > 0 ? "Se incluirá en el próximo cierre" : "Sin caja chica pendiente";
      pillValue = t.cashboxTotal || 0;
      lines.push(
        ["Efectivo base acumulado", currency(t.gross || 0)],
        ["Caja chica generada 5%", currency(t.cashboxGeneratedTotal || 0)],
        ["Ya compensada anteriormente", t.cashboxOffsetPreviouslyApplied > 0 ? `−${currency(t.cashboxOffsetPreviouslyApplied)}` : currency(0)],
        ["Total a incluir en Facturación", currency(t.cashboxTotal || 0)]
      );
    } else if (state.tab === "gastos") {
      const t = tabSummary(summary, "gastos");
      main = t.expenseTotal;
      sub = "Gastos actuales del período abierto";
      pill = t.netSettlementToDriver > 0 ? "Explora debe liquidar a chofer" : t.netSettlementToDriver < 0 ? "Chofer debe liquidar a Explora" : "Nadie debe liquidar";
      pillValue = abs(t.netSettlementToDriver);
      const expenseBeforeDebt = Math.max(0, number(t.expenseAmountToDriverBeforeDebt || t.exploraExpenseShare || 0));
      const expenseDebtOffset = Math.max(0, number(t.expenseDebtOffsetApplied || 0));
      const expenseFinalSettlement = Math.max(0, number(t.amountToDriver || 0));
      lines.push(
        ["Gastos cargados por chofer", currency(summary.expenseTotal)],
        ["Parte chofer", currency(summary.driverExpenseShare)],
        ["Explora debía liquidar", currency(expenseBeforeDebt)],
        ["Ajuste de deuda con Gastos", expenseDebtOffset > 0 ? `−${currency(expenseDebtOffset)}` : currency(0)],
        ["Explora reintegra", currency(expenseFinalSettlement)]
      );
      if (expenseDebtReconciliation && expenseDebtOffset > 0.49) {
        expenseDebtReconciliation.hidden = false;
        expenseDebtReconciliation.innerHTML = `
          <div class="pay-expense-debt-reconciliation-head">
            <span aria-hidden="true">↔</span>
            <strong>Ajuste de deuda con Gastos aplicado</strong>
          </div>
          <div class="pay-expense-debt-reconciliation-grid">
            <span>Explora debía liquidar <strong>${esc(currency(expenseBeforeDebt))}</strong></span>
            <span>Aplicado a deuda <strong>−${esc(currency(expenseDebtOffset))}</strong></span>
          </div>
          <div class="pay-expense-debt-reconciliation-final">
            <span>Explora debe liquidar finalmente</span>
            <strong>${esc(currency(expenseFinalSettlement))}</strong>
          </div>`;
      }
    } else if (state.tab === "explora") {
      const t = tabSummary(summary, "explora");
      main = summary.nonCashInExplora;
      sub = "Digital actual del período abierto";
      pill = t.amountToDriver > 0 ? "Explora debe liquidar a chofer" : t.amountFromDriver > 0 ? "Chofer debe liquidar a Explora" : "Nadie debe liquidar";
      pillValue = Math.max(t.amountToDriver, t.amountFromDriver);
      lines.push(
        ["Digital cobrado", currency(summary.nonCashGrossInExplora || 0)],
        ["Efectivo del chofer", currency(summary.cashInDriver)],
        ["Total facturado", currency(summary.gross)],
        ["Parte de cada uno 50%", currency(summary.billingShareEach)]
      );
    } else if (state.tab === "chofer") {
      const t = tabSummary(summary, "chofer");
      main = summary.cashInDriver;
      sub = "Efectivo actual del período abierto";
      pill = t.amountToDriver > 0 ? "Explora debe liquidar a chofer" : t.amountFromDriver > 0 ? "Chofer debe liquidar a Explora" : "Nadie debe liquidar";
      pillValue = Math.max(t.amountToDriver, t.amountFromDriver);
      lines.push(
        ["Efectivo cobrado", currency(summary.cashGrossInDriver || 0)],
        ["Digital de Explora", currency(summary.nonCashInExplora)],
        ["Total facturado", currency(summary.gross)],
        ["Parte de cada uno 50%", currency(summary.billingShareEach)],
        ["Caja chica acumulada 5%", currency(t.billingCashboxGenerated || summary.cashboxTotal || 0)]
      );
    } else {
      main = summary.cashboxTotal || 0;
      sub = "Caja chica actual del período abierto";
      pill = summary.cashboxInDriver > 0 ? "Chofer debe liquidar a Explora" : "Nadie debe liquidar";
      pillValue = summary.cashboxInDriver || 0;
      lines.push(
        ["Efectivo base", currency(summary.cashboxGross || 0)],
        ["Caja chica 5% efectivo", currency(summary.cashboxInDriver || 0)]
      );
    }
    const previousHtml = activeClosureKind(state.tab) === "pendientes" ? "" : previousClosureSummaryHtml(state.tab, getDriverUid());
    amount.textContent = currency(main);
    subtitle.innerHTML = `${esc(sub)}${previousHtml}`;
    pillLabel.textContent = pill;
    pillAmount.textContent = currency(pillValue);
    extra.innerHTML = lines.map(([label,value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
  }

  function renderClosureStatus(summary) {
    const box = $("payClosureStatus"), text = $("payClosureStatusText"), action = $("payClosureActionBtn");
    const kind = activeClosureKind(state.tab);
    if (state.dataLoading) {
      if (action) {
        action.hidden = false;
        action.disabled = true;
        action.setAttribute("aria-disabled", "true");
        action.classList.remove("is-closure-ready", "is-debt-blocked");
        action.classList.add("is-closure-locked");
        const label = action.querySelector("span");
        if (label) label.innerHTML = "Preparando…";
      }
      if (box) { box.hidden = true; box.style.display = "none"; }
      return;
    }
    if (kind === "pendientes") {
      setPendingActionMode(true);
      const pending = tabSummary(summary, "pendientes");
      const canPay = !isAdmin() && number(pending.remainingAmount || 0) > 0;
      if (action) {
        action.hidden = false;
        action.disabled = !canPay;
        action.setAttribute("aria-disabled", canPay ? "false" : "true");
        action.classList.toggle("is-closure-ready", canPay);
        action.classList.toggle("is-closure-locked", !canPay);
        action.classList.remove("is-debt-blocked");
        action.querySelector("span").innerHTML = `Reducir<br/>deuda`;
      }
      if (box) { box.hidden = true; box.style.display = "none"; }
      return;
    }
    setPendingActionMode(false);
    const stateForButton = closureButtonState(kind, summary);
    if (action) {
      const debtBlocked = !!stateForButton.blockedByDebt;
      action.hidden = !stateForButton.visible;
      action.disabled = !stateForButton.enabled && !debtBlocked;
      action.setAttribute("aria-disabled", stateForButton.enabled ? "false" : "true");
      action.classList.toggle("is-closure-ready", !!stateForButton.enabled);
      action.classList.toggle("is-closure-locked", stateForButton.visible && !stateForButton.enabled && !debtBlocked);
      action.classList.toggle("is-debt-blocked", debtBlocked);
      const label = stateForButton.visible ? closureLabel(kind) : "";
      action.querySelector("span").innerHTML = debtBlocked
        ? `Deuda activa<br/>resolver`
        : stateForButton.automaticWithBilling
          ? `Cierre automático<br/>con facturación`
          : `Pedir cierre<br/>${esc(label)}`;
    }
    if (!box || !text) return;
    const pending = pendingHomeClosureFor(getDriverUid(), kind);
    const card = homePendingClosureCardData(pending, kind, getDriverUid());
    state.pendingClosure = card ? card.closure : null;
    const showPendingCard = !!card;
    box.hidden = !showPendingCard;
    box.classList.toggle("is-home-module-pending", showPendingCard);
    box.style.display = showPendingCard ? "" : "none";
    const labelEl = box.querySelector("b");
    const buttonEl = box.querySelector("button");
    if (!showPendingCard) {
      if (labelEl) labelEl.textContent = "";
      text.textContent = "";
      if (buttonEl) buttonEl.hidden = true;
      return;
    }
    if (buttonEl) buttonEl.hidden = false;
    if (labelEl) labelEl.textContent = card.message;
    text.textContent = card.title;
  }

  function setAdminActivityAmountMessage(message = "", tone = "") {
    const box = $("payAdminAmountEditMessage");
    if (!box) return;
    box.textContent = safe(message);
    box.className = `pay-admin-amount-edit-message${tone ? ` is-${tone}` : ""}`;
  }

  function adminActivityFinancialRows(kind = "") {
    return kind === "gasto" ? (state.expenses || []) : kind === "cobro" ? (state.records || []) : [];
  }

  function adminActivityFinancialDocumentId(row = {}, kind = "") {
    if (kind === "gasto") return safe(row.id || row.expenseId || row.gastoId || row.recordId || row.operationId);
    if (kind === "cobro") return safe(row.id || row.recordId || row.operationId || row.billingRecordId || row.billingId);
    return "";
  }

  function adminActivityFinancialById(kind = "", documentId = "") {
    const id = safe(documentId);
    if (!id || !["cobro", "gasto"].includes(kind)) return null;
    return adminActivityFinancialRows(kind).find(row => adminActivityFinancialDocumentId(row, kind) === id) || null;
  }

  function adminActivityFinancialReceipt(kind = "", row = {}, documentId = "") {
    const id = safe(documentId || adminActivityFinancialDocumentId(row, kind));
    const driverUid = driverUidOf(row);
    const driverName = driverNameForRow(row);
    const sourceCollection = kind === "gasto" ? "gastos" : "billing_records";
    return {
      ...row,
      category:kind === "gasto" ? "gastos" : "facturacion",
      categoryLabel:kind === "gasto" ? "GASTO" : "COBRO",
      amount:amountOf(row),
      driverUid,
      driverName,
      recordId:id,
      ...(kind === "gasto" ? { expenseId:id, gastoId:id } : { billingRecordId:id, operationId:id }),
      raw:{
        ...row,
        id,
        sourceCollection,
        relatedCollection:sourceCollection,
        relatedDocumentId:id,
        recordId:id,
        driverUid,
        driverName,
        ...(kind === "gasto" ? { expenseId:id, gastoId:id } : { billingRecordId:id, operationId:id })
      }
    };
  }

  function openAdminActivityAmountEditor(kind = "", documentId = "") {
    if (!isAdmin()) return;
    const cleanKind = ["cobro", "gasto"].includes(safe(kind)) ? safe(kind) : "";
    const row = adminActivityFinancialById(cleanKind, documentId);
    if (!row) {
      window.alert("No se encontró el comprobante en las actividades actuales.");
      return;
    }
    const currentAmount = Math.round(amountOf(row));
    if (!(currentAmount > 0)) {
      window.alert("Este comprobante no tiene un importe válido para editar.");
      return;
    }
    state.adminAmountEditRow = row;
    state.adminAmountEditKind = cleanKind;
    const backdrop = $("payAdminAmountEditBackdrop");
    const input = $("payAdminAmountEditInput");
    if (!backdrop || !input) return;
    const isExpense = cleanKind === "gasto";
    $("payAdminAmountEditTitle").textContent = isExpense ? "EDITAR GASTO" : "EDITAR COBRO";
    const contextLabel = $("payAdminAmountEditContextLabel");
    if (contextLabel) contextLabel.textContent = isExpense ? "GASTO" : "COBRO";
    $("payAdminAmountEditDriver").textContent = driverNameForRow(row);
    $("payAdminAmountEditDetail").textContent = isExpense
      ? safe(row.notes || row.descripcion || row.description || expenseTypeLabel(row))
      : safe(row.description || row.detalle || row.notes || row.ruta || paymentLabel(methodOf(row)));
    $("payAdminAmountEditPrevious").textContent = currency(currentAmount);
    input.value = new Intl.NumberFormat("es-AR", { maximumFractionDigits:0 }).format(currentAmount);
    input.disabled = false;
    $("payAdminAmountEditSave").disabled = false;
    $("payAdminAmountEditCancel").disabled = false;
    setAdminActivityAmountMessage("Ingresá el valor correcto y confirmá.");
    backdrop.classList.add("is-open");
    backdrop.setAttribute("aria-hidden", "false");
    window.lockPageScroll?.("pay-admin-amount-edit");
    setTimeout(() => {
      input.focus();
      input.select?.();
    }, 80);
  }

  function closeAdminActivityAmountEditor() {
    if (state.adminAmountEditBusy) return;
    const backdrop = $("payAdminAmountEditBackdrop");
    backdrop?.classList.remove("is-open");
    backdrop?.setAttribute("aria-hidden", "true");
    state.adminAmountEditRow = null;
    state.adminAmountEditKind = "";
    setAdminActivityAmountMessage("");
    window.unlockPageScroll?.("pay-admin-amount-edit");
  }

  function applyAdminActivityAmountLocally(kind = "", documentId = "", newAmount = 0, closureUpdates = []) {
    const id = safe(documentId);
    const amount = Math.round(number(newAmount));
    if (!id || !(amount > 0) || !["cobro", "gasto"].includes(kind)) return;
    const stateKey = kind === "gasto" ? "expenses" : "records";
    state[stateKey] = (state[stateKey] || []).map(row => {
      if (adminActivityFinancialDocumentId(row, kind) !== id) return row;
      return {
        ...row,
        amount,
        monto:amount,
        valor:amount,
        finalPrice:amount,
        totalAmount:Object.prototype.hasOwnProperty.call(row, "totalAmount") ? amount : row.totalAmount,
        importe:Object.prototype.hasOwnProperty.call(row, "importe") ? amount : row.importe,
        price:Object.prototype.hasOwnProperty.call(row, "price") ? amount : row.price,
        total:Object.prototype.hasOwnProperty.call(row, "total") ? amount : row.total,
        updatedAtMs:Date.now()
      };
    });
    if (Array.isArray(closureUpdates) && closureUpdates.length) {
      const patches = new Map(closureUpdates.map(item => [safe(item?.id), item?.patch || {}]).filter(([closureId]) => closureId));
      state.closures = (state.closures || []).map(row => patches.has(safe(row.id)) ? { ...row, ...patches.get(safe(row.id)), updatedAtMs:Date.now() } : row);
    }
    state.latestSummary = computeSummary();
    render();
  }

  async function saveAdminActivityAmountEdit() {
    if (state.adminAmountEditBusy || !isAdmin()) return;
    const row = state.adminAmountEditRow;
    const kind = state.adminAmountEditKind;
    const input = $("payAdminAmountEditInput");
    if (!row || !input || !["cobro", "gasto"].includes(kind)) return;
    const previousAmount = Math.round(amountOf(row));
    const newAmount = Math.round(moneyNumber(input.value));
    if (!(newAmount > 0)) {
      setAdminActivityAmountMessage("Ingresá un valor mayor a $0.", "error");
      input.focus();
      return;
    }
    if (newAmount === previousAmount) {
      setAdminActivityAmountMessage("El valor nuevo es igual al anterior.", "error");
      input.focus();
      return;
    }
    if (!window.ExploraReceiptEngine?.modifyFinancialAmount) {
      setAdminActivityAmountMessage("El módulo de edición no está disponible. Cerrá y volvé a abrir la app.", "error");
      return;
    }
    const documentId = adminActivityFinancialDocumentId(row, kind);
    if (!documentId) {
      setAdminActivityAmountMessage("No se pudo identificar el comprobante original.", "error");
      return;
    }
    state.adminAmountEditBusy = true;
    input.disabled = true;
    $("payAdminAmountEditSave").disabled = true;
    $("payAdminAmountEditCancel").disabled = true;
    setAdminActivityAmountMessage("Guardando y recalculando cierres…");
    try {
      const receipt = adminActivityFinancialReceipt(kind, row, documentId);
      const result = await window.ExploraReceiptEngine.modifyFinancialAmount(receipt, newAmount);
      applyAdminActivityAmountLocally(kind, documentId, newAmount, result?.closureUpdates || []);
      setAdminActivityAmountMessage(`${kind === "gasto" ? "Gasto" : "Cobro"} actualizado: ${currency(previousAmount)} → ${currency(newAmount)}.`, "success");
      window.ExploraAdminShared?.invalidate?.();
      (kind === "gasto" ? ["gastos"] : ["explora", "chofer", "caja_chica"]).forEach(category => window.invalidateReceiptCache?.(category));
      setTimeout(() => {
        state.adminAmountEditBusy = false;
        closeAdminActivityAmountEditor();
      }, 650);
      return;
    } catch (error) {
      console.error("EXPLORA_ADMIN_ACTIVITY_AMOUNT_EDIT_SAVE", error);
      const code = safe(error?.code || error?.message).toUpperCase();
      const message = code.includes("NOT_FOUND")
        ? `No se encontró ${kind === "gasto" ? "el gasto" : "el cobro"} original en Firestore.`
        : code.includes("PERMISSION") || code.includes("ADMIN") || code.includes("AUTH")
          ? "La sesión de administrador no tiene permiso para modificar este comprobante."
          : code.includes("INVALID")
            ? "Ingresá un valor válido."
            : "No se pudo modificar el comprobante ni recalcular los cierres. Revisá la conexión e intentá nuevamente.";
      setAdminActivityAmountMessage(message, "error");
    } finally {
      if (state.adminAmountEditBusy) {
        state.adminAmountEditBusy = false;
        input.disabled = false;
        $("payAdminAmountEditSave").disabled = false;
        $("payAdminAmountEditCancel").disabled = false;
      }
    }
  }

  async function deleteAdminActivityFinancial(kind = "", documentId = "") {
    if (!isAdmin()) throw new Error("Solo el administrador puede eliminar comprobantes.");
    const cleanKind = ["cobro", "gasto"].includes(safe(kind)) ? safe(kind) : "";
    const id = safe(documentId);
    const row = adminActivityFinancialById(cleanKind, id);
    if (!row || !id) throw new Error("No se encontró el comprobante en las actividades actuales.");
    const busyKey = `${cleanKind}:${id}`;
    if (state.adminFinancialDeleteBusyKey) return;
    const label = cleanKind === "gasto" ? "gasto" : "cobro";
    const confirmed = window.confirm(`¿Eliminar este ${label} de ${currency(amountOf(row))}?\n\nSe eliminará su comprobante y se recalcularán los cierres relacionados. Esta acción no se puede deshacer.`);
    if (!confirmed) return;
    if (!window.ExploraReceiptEngine?.deleteFinancialMovement) throw new Error("El módulo para eliminar comprobantes todavía no está disponible. Cerrá y volvé a abrir la app.");
    state.adminFinancialDeleteBusyKey = busyKey;
    render();
    try {
      await window.ExploraReceiptEngine.deleteFinancialMovement(adminActivityFinancialReceipt(cleanKind, row, id));
      const stateKey = cleanKind === "gasto" ? "expenses" : "records";
      state[stateKey] = (state[stateKey] || []).filter(item => adminActivityFinancialDocumentId(item, cleanKind) !== id);
      state.latestSummary = computeSummary();
      render();
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(35);
      window.alert(`${cleanKind === "gasto" ? "Gasto" : "Cobro"} eliminado correctamente. Los cierres fueron recalculados.`);
    } finally {
      state.adminFinancialDeleteBusyKey = "";
      render();
    }
  }

  function activityIcon(type) {
    if (type === "debt" || type === "debt_payment" || type === "debt_expense_offset") return `<svg viewBox="0 0 24 24"><path d="M12 2 2 20h20L12 2Z"></path><path d="M12 8v5"></path><path d="M12 17h.01"></path></svg>`;
    if (type === "expense" || type === "cashbox") return `<svg viewBox="0 0 24 24"><path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"></path><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"></path></svg>`;
    if (type === "closure") return `<svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"></path><path d="M14 3v5h5"></path></svg>`;
    return `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>`;
  }

  function renderActivities(summary) {
    const list = $("payActivityList");
    if (!list) return;
    const rows = movementRows(summary);
    try { window.ExploraActivityPhotoRows = rows.filter(row => row.hasPhoto && row.photoKey).map(activityPhotoRegistryRow); } catch (_) {}
    if (!rows.length) { list.innerHTML = `<div class="pay-activity-empty">${isAdmin() ? "No hay actividades con esos filtros." : "Todavía no hay cobros ni gastos en el ciclo abierto."}</div>`; return; }
    list.innerHTML = rows.map(row => {
      const closureAttr = row.type === "closure" && row.closureId ? ` data-pay-activity-closure="${esc(row.closureId)}" role="button" tabindex="0"` : "";
      const closureTone = row.type === "closure" ? ` ${esc(row.tone || "")}` : "";
      const photoButton = row.hasPhoto && row.photoKey
        ? `<button class="pay-activity-photo" type="button" data-notification-attachment="${esc(row.photoKey)}">ver foto</button>`
        : "";
      const photoClass = photoButton ? " has-photo-action" : "";
      const driverLine = isAdmin() ? `<div class="pay-activity-driver-name">${esc(row.driverName || "Chofer")}</div>` : "";
      const financialKind = safe(row.financialKind);
      const financialId = safe(row.financialId);
      const canManageFinancial = isAdmin() && ["cobro", "gasto"].includes(financialKind) && !!financialId;
      const deleteBusy = canManageFinancial && state.adminFinancialDeleteBusyKey === `${financialKind}:${financialId}`;
      const financialActions = canManageFinancial
        ? `<div class="pay-activity-financial-actions"><button class="pay-activity-financial-edit" type="button" data-pay-activity-financial-edit="${esc(financialId)}" data-pay-activity-financial-kind="${esc(financialKind)}" ${deleteBusy ? "disabled" : ""}>EDITAR</button><button class="pay-activity-financial-delete" type="button" data-pay-activity-financial-delete="${esc(financialId)}" data-pay-activity-financial-kind="${esc(financialKind)}" ${deleteBusy ? "disabled" : ""}>${deleteBusy ? "ELIMINANDO…" : "ELIMINAR"}</button></div>`
        : "";
      const financialClass = canManageFinancial ? " has-financial-actions" : "";
      return `<article class="pay-activity ${row.type === "closure" ? "is-clickable" : ""}${closureTone}${photoClass}${financialClass}"${closureAttr}>
        <span class="pay-activity-icon">${activityIcon(row.type)}</span>
        <div>${driverLine}<div class="pay-activity-title">${esc(row.title)}</div><div class="pay-activity-meta">${esc(row.meta)}</div><div class="pay-activity-detail">${esc(row.detail)}</div></div>
        <div class="pay-activity-side"><strong class="pay-activity-amount ${row.positive ? "is-positive" : row.negative ? "is-negative" : ""}">${row.amount ? (row.amount > 0 ? "+" : "") + currency(row.amount) : ""}</strong>${financialActions}</div>
        ${photoButton}
      </article>`;
    }).join("");
  }

  async function computeDriverSummary(uid) {
    const [records, expenses, closures, debts, debtPayments, uberWeeks] = await Promise.all([
      getScopedDocs("billing_records", uid),
      getScopedDocs("gastos", uid),
      getScopedDocs("cierres_semanales", uid),
      getScopedDocs("deudas_choferes", uid),
      getScopedDocs("deuda_pagos", uid),
      getScopedDocs("uber_weekly_closures", uid)
    ]);
    return computeSummary({ records, expenses, closures, debts, debtPayments, uberWeeks });
  }

  async function getDriverBillingBalance(uid = "") {
    const targetUid = safe(uid);
    if (!targetUid) throw new Error("Seleccioná un chofer para calcular Facturación.");
    const summary = await computeDriverSummary(targetUid);
    return {
      driverUid:targetUid,
      amountFromDriver:Number(summary.amountFromDriverForBilling || 0),
      amountToDriver:Number(summary.amountToDriverForBilling || 0),
      netToDriver:Number(summary.billingNetToDriver || 0),
      paymentTotal:Number(summary.billingSettlementPaymentTotal || 0),
      cutoffMs:Number(summary.tabs?.facturacion?.resetMs || 0),
      summary
    };
  }


  function debtPaymentSummaryHtml(pending = summarizePendingDebts()) {
    const top = (pending.activeDebts || []).slice(0, 6);
    const rows = [
      ["Saldo actual", currency(pending.remainingAmount || 0), "closure-payment-result settlement-result-green"],
      ["Total deuda", currency(pending.totalOriginal || pending.remainingAmount || 0)],
      ["Pagado", currency(pending.totalPaid || 0)],
      ["Intereses / mora", currency(pending.totalPenalty || 0)]
    ].concat(top.map(row => [debtTypeLabel(row), currency(debtRemainingAmount(row))]));
    return rows.map(([label, value, className]) => `<article${className ? ` class="${esc(className)}"` : ""}><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("");
  }

  function debtExpenseAvailability(summary = state.latestSummary || computeSummary()) {
    const gastos = tabSummary(summary, "gastos");
    const pending = summary.pendientes || tabSummary(summary, "pendientes");
    const before = Math.max(0, number(gastos.expenseAmountToDriverBeforeDebt || gastos.exploraExpenseShare || 0));
    const alreadyApplied = Math.max(0, number(gastos.expenseDebtOffsetApplied || 0));
    const available = Math.max(0, number(gastos.amountToDriver || before - alreadyApplied));
    const debt = Math.max(0, number(pending.remainingAmount || summary.pendingDebtTotal || 0));
    return { gastos, pending, before, alreadyApplied, available, debt, maxApplicable:Math.min(available, debt) };
  }

  function debtReductionChoiceHtml() {
    const availability = debtExpenseAvailability();
    return `${debtPaymentSummaryHtml(availability.pending)}
      <div class="pay-debt-method-explain">Elegí cómo querés reducir la deuda. El interés y la mora se mantienen; el descuento se aplica primero a la deuda más antigua.</div>
      <div class="pay-debt-method-grid">
        <button class="pay-debt-method-card pay-debt-method-card--expenses" type="button" data-debt-reduction-method="expenses"${availability.maxApplicable > 0 ? "" : " disabled"}>
          <span class="pay-debt-method-icon">↔</span>
          <strong>Usar saldo de Gastos</strong>
          <small>Explora debe liquidarte ${currency(availability.available)}. Podés usar hasta ${currency(availability.maxApplicable)} para achicar tu deuda, sin comprobante.</small>
          <em>${availability.maxApplicable > 0 ? "Compensar ahora" : "No hay saldo disponible"}</em>
        </button>
        <button class="pay-debt-method-card pay-debt-method-card--receipt" type="button" data-debt-reduction-method="receipt">
          <span class="pay-debt-method-icon">▣</span>
          <strong>Efectivo o transferencia</strong>
          <small>Pagá directamente a Explora y cargá el comprobante como hasta ahora.</small>
          <em>Continuar con comprobante</em>
        </button>
      </div>`;
  }

  function pendingDebtsForDriver(uid = getDriverUid()) {
    const targetUid = safe(uid);
    if (!targetUid) return summarizePendingDebts([]);
    return summarizePendingDebts(driverRowsFor(state.debts, targetUid));
  }

  function adminDebtPaymentPreviewHtml(pending = pendingDebtsForDriver(), amount = 0) {
    const preview = previewAdminDebtPayment(pending.remainingAmount || 0, amount);
    return `
      <article><span>Chofer</span><strong>${esc(state.selectedDriverName || "Chofer")}</strong></article>
      <article><span>Deuda antes</span><strong id="payAdminDebtBalanceBefore">${esc(currency(preview.balanceBefore))}</strong></article>
      <article><span>Entrega a registrar</span><strong id="payAdminDebtPaymentAmount">${esc(currency(preview.amount))}</strong></article>
      <article class="closure-payment-result settlement-result-green" id="payAdminDebtPaymentResult">
        <span id="payAdminDebtPaymentResultLabel">${esc(preview.resultLabel)}</span>
        <strong id="payAdminDebtBalanceAfter">${esc(currency(preview.balanceAfter))}</strong>
      </article>
      <div class="pay-closure-alert" id="payAdminDebtPaymentPreviewHint">El movimiento se descuenta primero de la deuda más antigua y queda guardado en el historial.</div>`;
  }

  function updateAdminDebtPaymentPreview() {
    if (state.modalMode !== "admin-debt-payment") return;
    const pending = pendingDebtsForDriver();
    const amount = moneyNumber($("payDebtPaymentAmountInput")?.value || 0);
    const preview = previewAdminDebtPayment(pending.remainingAmount || 0, amount);
    const method = normalizeAdminDebtPaymentMethod(state.adminDebtPaymentMethod);
    const receiptFile = state.modalFile || $("payClosureReceiptInput")?.files?.[0] || null;
    const hasReceipt = typeof File !== "undefined" && receiptFile instanceof File && receiptFile.size > 0;
    const beforeNode = $("payAdminDebtBalanceBefore");
    const amountNode = $("payAdminDebtPaymentAmount");
    const afterNode = $("payAdminDebtBalanceAfter");
    const labelNode = $("payAdminDebtPaymentResultLabel");
    const hintNode = $("payAdminDebtPaymentPreviewHint");
    const submit = $("payClosureSubmit");
    if (beforeNode) beforeNode.textContent = currency(preview.balanceBefore);
    if (amountNode) amountNode.textContent = currency(preview.amount);
    if (afterNode) afterNode.textContent = currency(preview.balanceAfter);
    if (labelNode) labelNode.textContent = preview.resultLabel;
    if (hintNode) {
      hintNode.textContent = preview.exceedsBalance
        ? `El monto supera la deuda actual de ${currency(preview.balanceBefore)}.`
        : method === "transfer"
          ? "La transferencia requiere comprobante. El pago se aplica primero a la deuda más antigua."
          : "Confirmás que Explora recibió este efectivo. El pago se aplica primero a la deuda más antigua.";
      hintNode.classList.toggle("is-error", preview.exceedsBalance);
    }
    if (submit) submit.disabled = !preview.valid || (method === "transfer" && !hasReceipt);
  }

  function openAdminDebtPaymentModal(uid = getDriverUid()) {
    if (state.busy || !isAdmin()) return;
    const targetUid = safe(uid || getDriverUid());
    const driver = state.drivers.find(item => safe(item.uid || item.id) === targetUid);
    if (!targetUid || !driver) throw new Error("No se pudo identificar al chofer.");
    state.selectedDriverUid = targetUid;
    state.selectedDriverName = driver.name || state.selectedDriverName || "Chofer";
    const pending = pendingDebtsForDriver(targetUid);
    if (!(pending.remainingAmount > 0.49)) throw new Error("El chofer no tiene deuda pendiente.");
    state.modalMode = "admin-debt-payment";
    state.modalKind = "pendientes";
    state.modalClosure = null;
    state.modalFile = null;
    state.adminDebtPaymentMethod = "cash";
    const amountInput = $("payDebtPaymentAmountInput");
    const fileInput = $("payClosureReceiptInput");
    if (amountInput) amountInput.value = "";
    if (fileInput) fileInput.value = "";
    document.body?.classList.add("pay-closure-modal-open");
    $("payClosureBackdrop")?.classList.add("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "false");
    setModalMessage("");
    renderClosureModal();
    window.setTimeout(() => amountInput?.focus?.(), 80);
  }

  function openDebtPaymentModal() {
    if (state.busy) return;
    const pending = summarizePendingDebts();
    if (isAdmin()) return;
    if (!(pending.remainingAmount > 0)) return;
    state.modalMode = "debt-choice";
    state.modalKind = "pendientes";
    state.modalClosure = null;
    state.modalFile = null;
    const amountInput = $("payDebtPaymentAmountInput");
    const fileInput = $("payClosureReceiptInput");
    if (amountInput) amountInput.value = "";
    if (fileInput) fileInput.value = "";
    document.body?.classList.add("pay-closure-modal-open");
    $("payClosureBackdrop")?.classList.add("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "false");
    renderClosureModal();
  }

  function openDebtExpenseOffsetMode() {
    const availability = debtExpenseAvailability();
    if (!(availability.maxApplicable > 0)) {
      setModalMessage("Explora no tiene saldo de Gastos disponible para compensar en este momento.", "error");
      return;
    }
    state.modalMode = "debt-expense-offset";
    state.modalFile = null;
    const amountInput = $("payDebtPaymentAmountInput");
    const fileInput = $("payClosureReceiptInput");
    if (amountInput) amountInput.value = currency(availability.maxApplicable);
    if (fileInput) fileInput.value = "";
    setModalMessage("");
    renderClosureModal();
  }

  function openDebtReceiptPaymentMode() {
    state.modalMode = "debt-payment";
    state.modalFile = null;
    const amountInput = $("payDebtPaymentAmountInput");
    const fileInput = $("payClosureReceiptInput");
    if (amountInput) amountInput.value = "";
    if (fileInput) fileInput.value = "";
    setModalMessage("");
    renderClosureModal();
  }

  function handleDebtModalBackOrClose() {
    if (["debt-payment", "debt-expense-offset", "expense-debt-blocked"].includes(state.modalMode)) {
      state.modalMode = "debt-choice";
      state.modalKind = "pendientes";
      state.modalFile = null;
      const amountInput = $("payDebtPaymentAmountInput");
      const fileInput = $("payClosureReceiptInput");
      if (amountInput) amountInput.value = "";
      if (fileInput) fileInput.value = "";
      setModalMessage("");
      renderClosureModal();
      return;
    }
    closeClosureModal();
  }

  function openExpenseDebtBlockedModal() {
    if (state.busy || isAdmin()) return;
    state.modalMode = "expense-debt-blocked";
    state.modalKind = "gastos";
    state.modalClosure = null;
    state.modalFile = null;
    document.body?.classList.add("pay-closure-modal-open");
    $("payClosureBackdrop")?.classList.add("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "false");
    renderClosureModal();
  }

  async function uploadDebtPaymentReceipt({ driverUid, paymentId, file, amount }) {
    if (!state.storage) throw new Error("Storage no está disponible.");
    if (!(file instanceof File) || !(file.size > 0)) throw new Error("Cargá la foto del comprobante.");
    if (file.size > 15 * 1024 * 1024) throw new Error("El comprobante supera 15 MB.");
    const path = debtReceiptPath({ driverUid, paymentId, file });
    const ext = extensionForFile(file);
    const ref = storageRef(state.storage, path);
    await uploadBytes(ref, file, {
      contentType:file.type || (ext === "pdf" ? "application/pdf" : "image/jpeg"),
      customMetadata:{ module:"pendientes_debt_payment", driverUid, paymentId, uploadedByUid:state.auth?.currentUser?.uid || "", amount:String(amount || 0) }
    });
    const url = await getDownloadURL(ref);
    return { url, path, ext };
  }

  async function submitDebtExpenseOffset() {
    const user = state.auth?.currentUser;
    if (!user?.uid) throw new Error("No hay sesión activa.");
    if (isAdmin()) throw new Error("Solo el chofer puede usar su saldo de Gastos para reducir deuda.");
    const driverUid = getOwnDriverUid();
    if (!driverUid) throw new Error("No se pudo identificar al chofer.");
    const summary = state.latestSummary || computeSummary();
    const availability = debtExpenseAvailability(summary);
    if (!(availability.debt > 0)) throw new Error("No tenés deuda pendiente para reducir.");
    if (!(availability.available > 0)) throw new Error("Explora no tiene saldo de Gastos disponible para compensar.");
    const amount = moneyNumber($("payDebtPaymentAmountInput")?.value || 0);
    if (!(amount > 0)) throw new Error("Ingresá el monto que querés usar desde Gastos.");
    if (amount > availability.maxApplicable + 0.49) throw new Error("El monto supera el saldo disponible entre Gastos y tu deuda.");

    const pending = summarizePendingDebts();
    const nowMs = Date.now();
    const driverName = displayName();
    const paymentId = debtPaymentId(driverUid);
    const periodStartMs = Number(availability.gastos.resetMs || 0);
    const expenseLedgerKey = `expense_debt_${driverUid.replace(/[^a-zA-Z0-9_-]/g, "_")}_${periodStartMs}`;
    const allocations = [];
    let transactionPreviousBalance = availability.debt;
    let transactionNewBalance = Math.max(0, availability.debt - amount);
    let expenseBalanceBefore = availability.available;
    let expenseBalanceAfter = Math.max(0, availability.available - amount);

    await runTransaction(state.db, async transaction => {
      // Usamos exclusivamente las colecciones de deuda ya habilitadas en producción.
      // El total previamente compensado se reconstruye desde deuda_pagos, que ya forma
      // parte del flujo existente y evita depender de una colección nueva sin reglas.
      const previouslyApplied = Math.max(0, number(availability.alreadyApplied || 0));
      const currentExpenseGross = Math.max(0, number(availability.before || 0));
      const availableInsideTransaction = Math.max(0, currentExpenseGross - previouslyApplied);
      if (amount > availableInsideTransaction + 0.49) throw new Error("El saldo de Gastos cambió. Actualizá y volvé a intentar.");

      let remainingToApply = amount;
      let previousBalance = 0;
      const debtRefs = (pending.activeDebts || [])
        .map(row => ({ row, id:safe(row.id || row.debtId) }))
        .filter(item => item.id)
        .map(item => ({ row:item.row, ref:doc(state.db, "deudas_choferes", item.id) }));
      const currentRows = [];
      for (const item of debtRefs) {
        const snap = await transaction.get(item.ref);
        if (!snap.exists()) continue;
        const data = { id:snap.id, ...snap.data() };
        if (!debtIsActive(data)) continue;
        currentRows.push({ ref:item.ref, row:data });
        previousBalance += debtRemainingAmount(data);
      }
      currentRows.sort((a,b)=>debtCreatedMs(a.row)-debtCreatedMs(b.row));
      if (!(previousBalance > 0)) throw new Error("La deuda ya no está activa.");
      if (amount > previousBalance + 0.49) throw new Error("El saldo de deuda cambió. Actualizá y volvé a intentar.");

      for (const item of currentRows) {
        if (!(remainingToApply > 0)) break;
        const before = debtRemainingAmount(item.row);
        if (!(before > 0)) continue;
        const applied = Math.min(before, remainingToApply);
        const after = Math.max(0, before - applied);
        const paid = debtPaidAmount(item.row) + applied;
        const status = after <= 0.49 ? "paid" : safe(item.row.status || item.row.debtStatus || "pending");
        allocations.push({ debtId:item.ref.id, type:debtTypeOf(item.row), typeLabel:debtTypeLabel(item.row), amount:applied, previousBalance:before, newBalance:after });
        transaction.update(item.ref, {
          remainingAmount:after,
          saldoPendiente:after,
          paidAmount:paid,
          amountPaid:paid,
          status,
          debtStatus:status,
          lastPaymentAt:serverTimestamp(),
          lastPaymentAtMs:nowMs,
          lastPaymentMethod:"expense_offset",
          updatedAt:serverTimestamp(),
          updatedAtMs:nowMs,
          sourceModule:"pendientes"
        });
        remainingToApply = Math.max(0, remainingToApply - applied);
      }

      const newBalance = Math.max(0, previousBalance - amount);
      expenseBalanceBefore = availableInsideTransaction;
      expenseBalanceAfter = Math.max(0, availableInsideTransaction - amount);
      transactionPreviousBalance = previousBalance;
      transactionNewBalance = newBalance;

      const paymentPayload = {
        paymentId,
        id:paymentId,
        driverUid,
        choferUid:driverUid,
        driverId:driverUid,
        driverName,
        debtId:safe(allocations[0]?.debtId || ""),
        allocations,
        amount,
        monto:amount,
        previousBalance,
        newBalance,
        debtReductionMethod:"expense_offset",
        paymentMethod:"expense_offset",
        method:"expense_offset",
        expenseOffset:true,
        usedExpenseBalance:true,
        sourceModule:"gastos_deuda",
        expensePeriodStartMs:periodStartMs,
        expenseLedgerKey,
        expenseAmountBeforeOffset:availableInsideTransaction,
        expenseAmountAfterOffset:expenseBalanceAfter,
        expenseGrossDueToDriver:currentExpenseGross,
        status:"applied",
        estado:"aplicado",
        receiptRequired:false,
        receiptStatus:"not_required",
        adminAcknowledged:true,
        acknowledged:true,
        adminAccepted:true,
        accepted:true,
        read:true,
        createdByUid:user.uid,
        createdByRole:"driver",
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        updatedAt:serverTimestamp(),
        updatedAtMs:nowMs,
        version:VERSION
      };
      transaction.set(doc(state.db, "deuda_pagos", paymentId), paymentPayload, { merge:false });
      transaction.set(doc(state.db, "deuda_movimientos", `movement_${paymentId}`), {
        movementId:`movement_${paymentId}`,
        type:"expense_offset",
        driverUid,
        driverName,
        debtId:paymentPayload.debtId,
        paymentId,
        amount,
        previousBalance,
        newBalance,
        expenseAmountBeforeOffset:availableInsideTransaction,
        expenseAmountAfterOffset:expenseBalanceAfter,
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        sourceModule:"gastos_deuda",
        version:VERSION
      }, { merge:false });
      transaction.set(doc(state.db, "notificaciones", `debt_payment_${paymentId}`), {
        notificationId:`debt_payment_${paymentId}`,
        type:"debt_expense_offset",
        category:"gastos",
        driverUid,
        driverName,
        paymentId,
        debtId:paymentPayload.debtId,
        title:"AJUSTE DE DEUDA CON GASTOS",
        message:`Explora debía liquidar ${currency(availableInsideTransaction)}. ${driverName} utilizó ${currency(amount)} para achicar deuda. Explora debe liquidar ${currency(expenseBalanceAfter)}.`,
        amount,
        previousBalance,
        newBalance,
        expenseAmountBeforeOffset:availableInsideTransaction,
        expenseAmountAfterOffset:expenseBalanceAfter,
        read:false,
        acknowledged:false,
        createdByUid:user.uid,
        createdByRole:"driver",
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        updatedAt:serverTimestamp(),
        updatedAtMs:nowMs,
        version:VERSION
      }, { merge:false });
    });

    state.debtPayments = [{
      id:paymentId, paymentId, driverUid, driverName, amount,
      previousBalance:transactionPreviousBalance, newBalance:transactionNewBalance,
      debtReductionMethod:"expense_offset", paymentMethod:"expense_offset", expenseOffset:true, usedExpenseBalance:true,
      sourceModule:"gastos_deuda", expensePeriodStartMs:periodStartMs,
      expenseAmountBeforeOffset:expenseBalanceBefore, expenseAmountAfterOffset:expenseBalanceAfter,
      createdAtMs:nowMs, updatedAtMs:nowMs, allocations,
      adminAcknowledged:true, acknowledged:true, adminAccepted:true, accepted:true, read:true
    }, ...state.debtPayments];
    state.debts = state.debts.map(row => {
      const allocation = allocations.find(item => item.debtId === safe(row.id || row.debtId));
      if (!allocation) return row;
      const paid = debtPaidAmount(row) + allocation.amount;
      const status = allocation.newBalance <= 0.49 ? "paid" : safe(row.status || row.debtStatus || "pending");
      return { ...row, remainingAmount:allocation.newBalance, saldoPendiente:allocation.newBalance, paidAmount:paid, amountPaid:paid, status, debtStatus:status, updatedAtMs:nowMs };
    });
    render();
    openWhatsappToExplora(debtExpenseOffsetWhatsappText({
      driverName,
      amount,
      expenseBefore:expenseBalanceBefore,
      expenseAfter:expenseBalanceAfter,
      debtBefore:transactionPreviousBalance,
      debtAfter:transactionNewBalance
    }));
  }

  async function submitDebtPayment() {
    const user = state.auth?.currentUser;
    if (!user?.uid) throw new Error("No hay sesión activa.");
    if (isAdmin()) throw new Error("Solo el chofer puede reducir su deuda desde esta tarjeta.");
    const driverUid = getOwnDriverUid();
    if (!driverUid) throw new Error("No se pudo identificar al chofer.");
    const pending = summarizePendingDebts();
    const currentBalance = moneyNumber(pending.remainingAmount || 0);
    if (!(currentBalance > 0)) throw new Error("No tenés deuda pendiente para reducir.");
    const amount = moneyNumber($("payDebtPaymentAmountInput")?.value || 0);
    if (!(amount > 0)) throw new Error("Ingresá el monto que vas a pagar.");
    if (amount > currentBalance + 0.49) throw new Error("El monto no puede ser mayor al saldo pendiente.");
    const file = state.modalFile || $("payClosureReceiptInput")?.files?.[0] || null;
    if (!(file instanceof File)) throw new Error("Cargá la foto del comprobante.");
    const paymentId = debtPaymentId(driverUid);
    const receipt = await uploadDebtPaymentReceipt({ driverUid, paymentId, file, amount });
    const nowMs = Date.now();
    const driverName = displayName();
    const oldestDebt = pendingDebtOldestRow();
    const allocations = [];
    await runTransaction(state.db, async transaction => {
      let remainingToApply = amount;
      let previousBalance = 0;
      const debtRefs = (pending.activeDebts || []).map(row => ({ row, id:safe(row.id || row.debtId) })).filter(item => item.id).map(item => ({ row:item.row, ref:doc(state.db, "deudas_choferes", item.id) }));
      const currentRows = [];
      for (const item of debtRefs) {
        const snap = await transaction.get(item.ref);
        if (!snap.exists()) continue;
        const data = { id:snap.id, ...snap.data() };
        if (!debtIsActive(data)) continue;
        currentRows.push({ ref:item.ref, row:data });
        previousBalance += debtRemainingAmount(data);
      }
      currentRows.sort((a,b)=>debtCreatedMs(a.row)-debtCreatedMs(b.row));
      if (!(previousBalance > 0)) throw new Error("La deuda ya no está activa.");
      if (amount > previousBalance + 0.49) throw new Error("El saldo cambió. Actualizá y volvé a intentar.");
      for (const item of currentRows) {
        if (!(remainingToApply > 0)) break;
        const before = debtRemainingAmount(item.row);
        if (!(before > 0)) continue;
        const applied = Math.min(before, remainingToApply);
        const after = Math.max(0, before - applied);
        const paid = debtPaidAmount(item.row) + applied;
        const status = after <= 0.49 ? "paid" : safe(item.row.status || item.row.debtStatus || "pending");
        allocations.push({ debtId:item.ref.id, type:debtTypeOf(item.row), typeLabel:debtTypeLabel(item.row), amount:applied, previousBalance:before, newBalance:after });
        transaction.update(item.ref, {
          remainingAmount:after,
          saldoPendiente:after,
          paidAmount:paid,
          amountPaid:paid,
          status,
          debtStatus:status,
          lastPaymentAt:serverTimestamp(),
          lastPaymentAtMs:nowMs,
          updatedAt:serverTimestamp(),
          updatedAtMs:nowMs,
          sourceModule:"pendientes"
        });
        remainingToApply = Math.max(0, remainingToApply - applied);
      }
      const newBalance = Math.max(0, previousBalance - amount);
      const uberDebtPaidAmount = allocations.filter(item => safe(item.type) === "uber_weekly").reduce((sum,item)=>sum+moneyNumber(item.amount),0);
      const uberCashboxReferenced = Math.round(uberDebtPaidAmount * 10) / 100;
      const paymentPayload = {
        paymentId,
        id:paymentId,
        driverUid,
        choferUid:driverUid,
        driverId:driverUid,
        driverName,
        debtId:safe(oldestDebt?.id || oldestDebt?.debtId || allocations[0]?.debtId || ""),
        allocations,
        amount,
        monto:amount,
        previousBalance,
        newBalance,
        receiptUrl:receipt.url,
        comprobanteUrl:receipt.url,
        receiptPath:receipt.path,
        uberDebtPaidAmount,
        uberCashboxReferenced,
        cashboxReceiptNote:uberCashboxReferenced > 0 ? `Este comprobante de deuda está asociado a ${currency(uberCashboxReferenced)} de Caja chica Uber.` : "",
        status:"applied",
        estado:"aplicado",
        sourceModule:"pendientes",
        createdByUid:user.uid,
        createdByRole:"driver",
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        updatedAt:serverTimestamp(),
        version:VERSION
      };
      transaction.set(doc(state.db, "deuda_pagos", paymentId), paymentPayload, { merge:false });
      transaction.set(doc(state.db, "deuda_movimientos", `movement_${paymentId}`), {
        movementId:`movement_${paymentId}`,
        type:"payment",
        driverUid,
        driverName,
        debtId:paymentPayload.debtId,
        paymentId,
        amount,
        previousBalance,
        newBalance,
        receiptUrl:receipt.url,
        receiptPath:receipt.path,
        uberDebtPaidAmount,
        uberCashboxReferenced,
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        sourceModule:"pendientes",
        version:VERSION
      }, { merge:false });
      transaction.set(doc(state.db, "notificaciones", `debt_payment_${paymentId}`), {
        notificationId:`debt_payment_${paymentId}`,
        type:"debt_payment",
        category:"pendientes",
        driverUid,
        driverName,
        paymentId,
        debtId:paymentPayload.debtId,
        title:"REDUCCIÓN DE DEUDA",
        message:`${driverName} pagó ${currency(amount)}. Saldo anterior ${currency(previousBalance)} · saldo nuevo ${currency(newBalance)}.${uberCashboxReferenced > 0 ? ` El comprobante también identifica ${currency(uberCashboxReferenced)} de Caja chica Uber.` : ""}`,
        receiptUrl:receipt.url,
        uberDebtPaidAmount,
        uberCashboxReferenced,
        receiptPath:receipt.path,
        amount,
        previousBalance,
        newBalance,
        read:false,
        acknowledged:false,
        createdByUid:user.uid,
        createdByRole:"driver",
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        updatedAt:serverTimestamp(),
        version:VERSION
      }, { merge:false });
    });
    state.debtPayments = [{ id:paymentId, paymentId, driverUid, driverName, amount, previousBalance:currentBalance, newBalance:Math.max(0, currentBalance - amount), receiptUrl:receipt.url, receiptPath:receipt.path, uberDebtPaidAmount, uberCashboxReferenced, createdAtMs:nowMs, allocations }, ...state.debtPayments];
    state.debts = state.debts.map(row => {
      const allocation = allocations.find(item => item.debtId === safe(row.id || row.debtId));
      if (!allocation) return row;
      const paid = debtPaidAmount(row) + allocation.amount;
      const status = allocation.newBalance <= 0.49 ? "paid" : safe(row.status || row.debtStatus || "pending");
      return { ...row, remainingAmount:allocation.newBalance, saldoPendiente:allocation.newBalance, paidAmount:paid, status, debtStatus:status, updatedAtMs:nowMs };
    });
    render();
  }

  async function submitAdminDebtPayment() {
    const user = state.auth?.currentUser;
    if (!user?.uid) throw new Error("No hay sesión activa.");
    if (!isAdmin()) throw new Error("Solo el administrador puede registrar una entrega recibida.");
    const driverUid = getDriverUid();
    if (!driverUid) throw new Error("No se pudo identificar al chofer.");
    const pending = pendingDebtsForDriver(driverUid);
    const currentBalance = moneyNumber(pending.remainingAmount || 0);
    if (!(currentBalance > 0)) throw new Error("El chofer no tiene deuda pendiente.");
    const amount = moneyNumber($("payDebtPaymentAmountInput")?.value || 0);
    if (!(amount > 0)) throw new Error("Ingresá el monto recibido.");
    if (amount > currentBalance) throw new Error(`El monto no puede superar la deuda actual de ${currency(currentBalance)}.`);
    const paymentMethod = normalizeAdminDebtPaymentMethod(state.adminDebtPaymentMethod);
    const file = state.modalFile || $("payClosureReceiptInput")?.files?.[0] || null;
    if (paymentMethod === "transfer" && (!(file instanceof File) || !(file.size > 0))) {
      throw new Error("Cargá el comprobante de la transferencia.");
    }

    const paymentId = debtPaymentId(driverUid);
    const receipt = paymentMethod === "transfer"
      ? await uploadDebtPaymentReceipt({ driverUid, paymentId, file, amount })
      : { url:"", path:"", ext:"" };
    const nowMs = Date.now();
    const driverName = state.selectedDriverName || driverNameForRow(pending.activeDebts?.[0] || {}) || "Chofer";
    const oldestDebt = pending.activeDebts?.[0] || null;
    const allocations = [];
    let transactionPreviousBalance = currentBalance;
    let transactionNewBalance = Math.max(0, currentBalance - amount);
    let uberDebtPaidAmount = 0;
    let uberCashboxReferenced = 0;

    await runTransaction(state.db, async transaction => {
      let remainingToApply = amount;
      let previousBalance = 0;
      const debtRefs = (pending.activeDebts || [])
        .map(row => ({ row, id:safe(row.id || row.debtId) }))
        .filter(item => item.id)
        .map(item => ({ row:item.row, ref:doc(state.db, "deudas_choferes", item.id) }));
      const currentRows = [];
      for (const item of debtRefs) {
        const snap = await transaction.get(item.ref);
        if (!snap.exists()) continue;
        const data = { id:snap.id, ...snap.data() };
        if (!debtIsActive(data)) continue;
        if (driverUidOf(data) !== driverUid && !closureBelongsToDriver(data, driverUid)) continue;
        currentRows.push({ ref:item.ref, row:data });
        previousBalance += debtRemainingAmount(data);
      }
      currentRows.sort((a,b)=>debtCreatedMs(a.row)-debtCreatedMs(b.row));
      if (!(previousBalance > 0)) throw new Error("La deuda ya no está activa.");
      if (amount > previousBalance) throw new Error("El saldo cambió. Actualizá y volvé a intentar.");

      for (const item of currentRows) {
        if (!(remainingToApply > 0)) break;
        const before = debtRemainingAmount(item.row);
        if (!(before > 0)) continue;
        const applied = Math.min(before, remainingToApply);
        const after = Math.max(0, before - applied);
        const paid = debtPaidAmount(item.row) + applied;
        const status = after <= 0.49 ? "paid" : safe(item.row.status || item.row.debtStatus || "pending");
        allocations.push({
          debtId:item.ref.id,
          type:debtTypeOf(item.row),
          typeLabel:debtTypeLabel(item.row),
          amount:applied,
          previousBalance:before,
          newBalance:after
        });
        transaction.update(item.ref, {
          remainingAmount:after,
          saldoPendiente:after,
          paidAmount:paid,
          amountPaid:paid,
          status,
          debtStatus:status,
          lastPaymentAt:serverTimestamp(),
          lastPaymentAtMs:nowMs,
          lastPaymentMethod:paymentMethod,
          lastPaymentRegisteredByRole:"admin",
          updatedAt:serverTimestamp(),
          updatedAtMs:nowMs,
          sourceModule:"pendientes"
        });
        remainingToApply = Math.max(0, remainingToApply - applied);
      }

      const newBalance = Math.max(0, previousBalance - amount);
      transactionPreviousBalance = previousBalance;
      transactionNewBalance = newBalance;
      uberDebtPaidAmount = allocations
        .filter(item => safe(item.type) === "uber_weekly")
        .reduce((sum,item)=>sum + moneyNumber(item.amount), 0);
      uberCashboxReferenced = Math.round(uberDebtPaidAmount * 10) / 100;
      const methodLabel = paymentMethod === "transfer" ? "transferencia" : "efectivo";
      const paymentPayload = {
        paymentId,
        id:paymentId,
        driverUid,
        choferUid:driverUid,
        driverId:driverUid,
        driverName,
        debtId:safe(oldestDebt?.id || oldestDebt?.debtId || allocations[0]?.debtId || ""),
        allocations,
        amount,
        monto:amount,
        previousBalance,
        newBalance,
        debtReductionMethod:"admin_payment",
        paymentMethod,
        method:paymentMethod,
        payerRole:"driver",
        payeeRole:"explora",
        paymentDirection:"driver_to_explora",
        registeredByAdmin:true,
        registrationOrigin:"admin_closure_board",
        receiptRequired:paymentMethod === "transfer",
        receiptStatus:paymentMethod === "transfer" ? "uploaded" : "not_required",
        receiptUrl:receipt.url,
        comprobanteUrl:receipt.url,
        receiptPath:receipt.path,
        uberDebtPaidAmount,
        uberCashboxReferenced,
        cashboxReceiptNote:uberCashboxReferenced > 0 ? `Este pago de deuda está asociado a ${currency(uberCashboxReferenced)} de Caja chica Uber.` : "",
        status:"applied",
        estado:"aplicado",
        sourceModule:"pendientes",
        adminAcknowledged:true,
        acknowledged:true,
        adminAccepted:true,
        accepted:true,
        read:true,
        createdByUid:user.uid,
        createdByRole:"admin",
        createdByName:accountName(),
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        updatedAt:serverTimestamp(),
        updatedAtMs:nowMs,
        version:VERSION
      };
      transaction.set(doc(state.db, "deuda_pagos", paymentId), paymentPayload, { merge:false });
      transaction.set(doc(state.db, "deuda_movimientos", `movement_${paymentId}`), {
        movementId:`movement_${paymentId}`,
        type:"payment",
        driverUid,
        driverName,
        debtId:paymentPayload.debtId,
        paymentId,
        amount,
        previousBalance,
        newBalance,
        paymentMethod,
        payerRole:"driver",
        payeeRole:"explora",
        registeredByAdmin:true,
        receiptUrl:receipt.url,
        receiptPath:receipt.path,
        uberDebtPaidAmount,
        uberCashboxReferenced,
        createdByUid:user.uid,
        createdByRole:"admin",
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        sourceModule:"pendientes",
        version:VERSION
      }, { merge:false });
      transaction.set(doc(state.db, "notificaciones", `debt_payment_${paymentId}`), {
        notificationId:`debt_payment_${paymentId}`,
        type:"admin_debt_payment",
        category:"pendientes",
        driverUid,
        driverName,
        paymentId,
        debtId:paymentPayload.debtId,
        title:"ENTREGA REGISTRADA POR EXPLORA",
        message:`Explora registró que entregaste ${currency(amount)} en ${methodLabel}. Saldo anterior ${currency(previousBalance)} · saldo nuevo ${currency(newBalance)}.`,
        receiptUrl:receipt.url,
        receiptPath:receipt.path,
        amount,
        previousBalance,
        newBalance,
        paymentMethod,
        read:false,
        acknowledged:false,
        createdByUid:user.uid,
        createdByRole:"admin",
        createdAt:serverTimestamp(),
        createdAtMs:nowMs,
        updatedAt:serverTimestamp(),
        updatedAtMs:nowMs,
        version:VERSION
      }, { merge:false });
    });

    state.debtPayments = [{
      id:paymentId,
      paymentId,
      driverUid,
      driverName,
      amount,
      previousBalance:transactionPreviousBalance,
      newBalance:transactionNewBalance,
      debtReductionMethod:"admin_payment",
      paymentMethod,
      method:paymentMethod,
      registeredByAdmin:true,
      adminAcknowledged:true,
      acknowledged:true,
      adminAccepted:true,
      accepted:true,
      read:true,
      receiptUrl:receipt.url,
      receiptPath:receipt.path,
      uberDebtPaidAmount,
      uberCashboxReferenced,
      createdByRole:"admin",
      createdAtMs:nowMs,
      allocations
    }, ...state.debtPayments];
    state.debts = state.debts.map(row => {
      const allocation = allocations.find(item => item.debtId === safe(row.id || row.debtId));
      if (!allocation) return row;
      const paid = debtPaidAmount(row) + allocation.amount;
      const status = allocation.newBalance <= 0.49 ? "paid" : safe(row.status || row.debtStatus || "pending");
      return {
        ...row,
        remainingAmount:allocation.newBalance,
        saldoPendiente:allocation.newBalance,
        paidAmount:paid,
        amountPaid:paid,
        status,
        debtStatus:status,
        lastPaymentMethod:paymentMethod,
        updatedAtMs:nowMs
      };
    });
    state.latestSummary = adminDriverSummaryFromState(driverUid);
    render();
  }

  function modalSummaryBase(kind = state.modalKind || state.tab) {
    if (isAdmin() && getDriverUid()) return adminDriverSummaryFromState(getDriverUid());
    return state.latestSummary || computeSummary();
  }

  async function openClosureModal(mode = "request", closure = null, kind = state.tab) {
    if (state.busy) return;
    const resolvedKind = closureKindOf(closure || {}) || activeClosureKind(kind);
    if (mode === "request" || mode === "admin-pay-now") {
      if (!isClosureTab(resolvedKind)) return;
      const status = closureButtonState(resolvedKind, modalSummaryBase(resolvedKind));
      if (!status.enabled) return;
    }
    state.modalMode = mode;
    state.modalKind = resolvedKind;
    // En modo request no pre-cargar cierres abiertos anteriores.
    // "Pedir cierre" debe trabajar únicamente con el período abierto actual.
    state.modalClosure = (mode === "request" || mode === "admin-pay-now") ? null : (closure || pendingClosureFor(getDriverUid(), resolvedKind) || null);
    state.modalFile = null;
    const input = $("payClosureReceiptInput");
    if (input) input.value = "";
    document.body?.classList.add("pay-closure-modal-open");
    $("payClosureBackdrop")?.classList.add("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "false");
    if (isAdmin()) await fetchDrivers();
    renderClosureModal();
  }

  function closeClosureModal() {
    document.body?.classList.remove("pay-closure-modal-open");
    $("payClosureBackdrop")?.classList.remove("is-open");
    $("payClosureBackdrop")?.setAttribute("aria-hidden", "true");
    state.modalFile = null;
    state.modalClosure = null;
    state.modalMode = "";
    state.modalKind = "";
    state.adminDebtPaymentMethod = "cash";
    const debtAmountInput = $("payDebtPaymentAmountInput");
    const receiptInput = $("payClosureReceiptInput");
    if (debtAmountInput) debtAmountInput.value = "";
    if (receiptInput) receiptInput.value = "";
    state.busy = false;
  }

  function setModalMessage(message = "", type = "") {
    const box = $("payClosureMessage");
    if (!box) return;
    box.textContent = message;
    box.className = `pay-closure-message ${type ? `is-${type}` : ""}`;
  }

  function renderDriverSelect() {
    const field = $("payClosureDriverField"), select = $("payClosureDriverSelect");
    if (!field || !select) return;
    field.hidden = !isAdmin() || state.modalMode !== "request";
    if (field.hidden) return;
    const options = [`<option value="">Elegir chofer…</option>`].concat(state.drivers.map(driver => `<option value="${esc(driver.uid)}">${esc(driver.name)}</option>`));
    select.innerHTML = options.join("");
    select.value = safe(state.selectedDriverUid);
  }

  function closureDetailSummary(closure = {}, kind = "gastos", adminView = false) {
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const gross = number(closure.gross || 0);
    const expenseTotal = number(closure.expenseTotal || 0);
    const cash = number(closure.cashInDriver || 0);
    const digital = number(closure.exploraCash || closure.nonCashInExplora || 0);
    const share = number(closure.billingShareEach || 0);
    const k = activeClosureKind(kind);
    const result = due > 0 ? "Chofer debe liquidar a Explora" : toDriver > 0 ? "Explora debe liquidar al chofer" : "Nadie debe liquidar";
    const amount = Math.max(due, toDriver);
    const detail = k === "caja_chica"
      ? [["Efectivo base", currency(closure.cashboxGross || gross)], ["Caja chica 5%", currency(closure.cashboxTotal || closure.mainTotal || amount)]]
      : k === "gastos"
        ? [["Gastos cargados", currency(expenseTotal)], ["Explora debía liquidar", currency(closure.expenseAmountToDriverBeforeDebt || expenseTotal * .5)], ["Ajuste de deuda con Gastos", currency(closure.expenseDebtOffsetApplied || 0)], ["Explora liquida finalmente", currency(toDriver || closure.expenseAmountToDriverAfterDebt || 0)]]
        : [["Efectivo chofer", currency(cash)], ["Digital Explora", currency(digital)], ["Total facturado", currency(gross)], ["Parte de cada uno", currency(share)], ["Caja chica acumulada incluida", currency(closure.cashboxIncludedInSettlement || closure.billingCashboxGenerated || closure.cashboxTotal || 0)], ["Caja chica descontada al chofer", currency(closure.billingCashboxOffsetApplied || 0)]];
    const receiptUrl = closureProofUrl(closure);
    const rows = [[result, amount > 0 ? currency(amount) : "Al día", "closure-payment-result settlement-result-green"]]
      .concat(detail)
      .concat(receiptUrl ? [["Comprobante", "cargado"]] : [])
      .map(([label,value,className]) => `<article${className ? ` class="${esc(className)}"` : ""}><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("");
    const receiptLink = receiptUrl ? `<a class="pay-closure-receipt-link" href="${esc(receiptUrl)}" target="_blank" rel="noopener">Ver foto del comprobante</a>` : "";
    const alert = !receiptUrl && !adminView && (due > 0 || toDriver > 0) ? `<div class="pay-closure-alert">El administrador cargará el comprobante cuando el pago haya sido realizado o recibido.</div>` : "";
    const direction = toDriver > 0 ? "explora_to_driver" : due > 0 ? "driver_to_explora" : "balanced";
    const contact = closureContactCardByDirection(direction, { closure });
    return rows + contact + receiptLink + alert;
  }

  function renderClosureModal() {
    // Hard-off adicional para instalaciones/PWA que conserven DOM legado.
    purgeLegacyClosureKmUi();
    renderDriverSelect();
    const title = $("payClosureTitle"), subtitle = $("payClosureSubtitle"), summary = $("payClosureSummary"), fileField = $("payClosureFileField"), debtField = $("payDebtPaymentField"), methodField = $("payDebtPaymentMethodField"), debtInput = $("payDebtPaymentAmountInput"), debtHint = $("payDebtPaymentHint"), submit = $("payClosureSubmit"), cancel = $("payClosureCancel"), reject = $("payClosureReject");
    const actions = submit?.closest(".pay-closure-actions");
    if (!title || !subtitle || !summary || !fileField || !submit || !cancel) return;
    const closure = state.modalClosure;
    const kind = closureKindOf(closure || {}) || activeClosureKind(state.modalKind || state.tab) || "gastos";
    const modalBase = modalSummaryBase(kind);
    const latest = tabSummary(modalBase, kind);
    fileField.hidden = true;
    if (debtField) debtField.hidden = true;
    if (methodField) methodField.hidden = true;
    cancel.textContent = "Cancelar";
    cancel.hidden = false;
    submit.hidden = false;
    if (reject) { reject.hidden = true; reject.disabled = true; reject.textContent = "No aceptar cierre"; }
    if (actions) { actions.hidden = false; actions.classList.remove("has-reject"); }
    submit.className = "pay-closure-primary";
    submit.disabled = false;

    if (state.modalMode === "debt-choice") {
      title.textContent = "Reducir deuda";
      subtitle.textContent = "Elegí entre compensar con lo que Explora te debe en Gastos o pagar directamente con comprobante.";
      summary.innerHTML = debtReductionChoiceHtml();
      if (actions) actions.hidden = false;
      submit.hidden = true;
      cancel.textContent = "Cerrar";
      return;
    }

    if (state.modalMode === "expense-debt-blocked") {
      const availability = debtExpenseAvailability();
      title.textContent = "Cierre bloqueado";
      subtitle.textContent = "Tenés una deuda activa y primero debés compensarla con el saldo disponible de Gastos.";
      summary.innerHTML = `<div class="pay-debt-blocked-notice">Debes dejar tu deuda en $0 antes de pedir un cierre. Utiliza el dinero que Explora debe liquidarte para saldar tu deuda y vuelve a intentar.</div>
        <article><span>Deuda pendiente</span><strong>${currency(availability.debt)}</strong></article>
        <article><span>Explora debe liquidarte en Gastos</span><strong>${currency(availability.available)}</strong></article>
        <article class="closure-payment-result settlement-result-green"><span>Podés aplicar ahora</span><strong>${currency(availability.maxApplicable)}</strong></article>`;
      submit.hidden = false;
      submit.disabled = !(availability.maxApplicable > 0);
      submit.textContent = availability.maxApplicable > 0 ? "Usar Gastos para deuda" : "Sin saldo disponible";
      submit.className = "pay-closure-danger";
      cancel.textContent = "Volver";
      return;
    }

    if (state.modalMode === "debt-expense-offset") {
      const availability = debtExpenseAvailability();
      title.textContent = "Usar saldo de Gastos";
      subtitle.textContent = "Al confirmar, la app tomará el monto disponible de la parte que Explora debe liquidarte y lo aplicará a tu deuda. No requiere comprobante.";
      summary.innerHTML = `${debtPaymentSummaryHtml(availability.pending)}
        <div class="pay-debt-offset-breakdown">
          <div><span>Explora debía liquidarte</span><strong>${currency(availability.available)}</strong></div>
          <div><span>Máximo aplicable a deuda</span><strong>${currency(availability.maxApplicable)}</strong></div>
          <p>Ejemplo: si Explora debía liquidarte $1.000 y usás $500, tu deuda baja $500 y Explora pasa a liquidarte $500.</p>
        </div>`;
      if (debtField) debtField.hidden = false;
      if (debtHint) debtHint.textContent = `Ingresá hasta ${currency(availability.maxApplicable)}. El ajuste quedará registrado dentro de Gastos.`;
      if (debtInput) debtInput.max = String(Math.floor(availability.maxApplicable || 0));
      fileField.hidden = true;
      submit.disabled = !(availability.maxApplicable > 0) || isAdmin();
      submit.textContent = "Aplicar saldo de Gastos";
      submit.className = "pay-closure-danger";
      cancel.textContent = "Volver";
      return;
    }

    if (state.modalMode === "debt-payment") {
      const pending = summarizePendingDebts();
      title.textContent = "Pagar con comprobante";
      subtitle.textContent = "Ingresá el monto que pagaste en efectivo o transferencia y adjuntá el comprobante.";
      summary.innerHTML = `${debtPaymentSummaryHtml(pending)}<div class="pay-closure-alert">El pago se aplica automáticamente primero a la deuda más antigua.</div>`;
      fileField.hidden = false;
      const fileLabel = fileField.querySelector("label");
      if (fileLabel) fileLabel.textContent = "Comprobante obligatorio";
      if (debtField) debtField.hidden = false;
      if (debtHint) debtHint.textContent = `Saldo actual: ${currency(pending.remainingAmount || 0)}. Se descuenta primero la deuda más antigua.`;
      if (debtInput) debtInput.max = String(Math.floor(pending.remainingAmount || 0));
      submit.disabled = !(pending.remainingAmount > 0) || isAdmin();
      submit.textContent = "Confirmar pago";
      cancel.textContent = "Volver";
      return;
    }

    if (state.modalMode === "admin-debt-payment") {
      const pending = pendingDebtsForDriver();
      const paymentMethod = normalizeAdminDebtPaymentMethod(state.adminDebtPaymentMethod);
      const enteredAmount = moneyNumber(debtInput?.value || 0);
      title.textContent = `Registrar entrega de ${state.selectedDriverName || "chofer"}`;
      subtitle.textContent = "Confirmá el dinero que el chofer entregó a Explora. Se descontará de su deuda en una operación auditable.";
      summary.innerHTML = adminDebtPaymentPreviewHtml(pending, enteredAmount);
      if (debtField) debtField.hidden = false;
      if (debtHint) debtHint.textContent = `Deuda actual: ${currency(pending.remainingAmount || 0)}. No se permite registrar más que el saldo pendiente.`;
      if (debtInput) debtInput.max = String(Math.floor(pending.remainingAmount || 0));
      if (methodField) {
        methodField.hidden = false;
        methodField.querySelectorAll("[data-debt-payment-method]").forEach(button => {
          const selected = normalizeAdminDebtPaymentMethod(button.dataset.debtPaymentMethod) === paymentMethod;
          button.classList.toggle("is-selected", selected);
          button.setAttribute("aria-pressed", selected ? "true" : "false");
        });
        const methodHint = $("payDebtPaymentMethodHint");
        if (methodHint) methodHint.textContent = paymentMethod === "transfer"
          ? "Adjuntá el comprobante para confirmar la transferencia."
          : "Confirmás que Explora recibió el efectivo del chofer.";
      }
      fileField.hidden = paymentMethod !== "transfer";
      const fileLabel = fileField.querySelector("label");
      if (fileLabel) fileLabel.textContent = "Comprobante de transferencia obligatorio";
      submit.textContent = "Registrar entrega";
      submit.className = "pay-closure-primary";
      cancel.textContent = "Cancelar";
      updateAdminDebtPaymentPreview();
      return;
    }

    const normalFileLabel = fileField.querySelector("label");
    if (normalFileLabel) normalFileLabel.textContent = "Comprobante de transferencia";

    if (closure) {
      const action = closureActionForViewer(closure);
      const due = number(closure.amountDueFromDriver || 0);
      const toDriver = number(closure.amountDueToDriver || 0);
      const proof = closureHasProof(closure);
      const completed = closureIsCompleted(closure);
      const rejectable = canAdminRejectClosure(closure);
      if (reject) {
        reject.hidden = !rejectable;
        reject.disabled = !rejectable;
        reject.textContent = safe(closure.requestedByRole).toLowerCase() === "driver" ? "No aceptar cierre" : "Anular cierre";
      }
      if (actions) actions.classList.toggle("has-reject", rejectable);
      const uploadNeeded = (action === "driver_upload" || action === "admin_upload") && !proof && !completed;
      fileField.hidden = !uploadNeeded;
      summary.innerHTML = closureDetailSummary(closure, kind, isAdmin());
      const noSubmitNeeded = (completed || proof) && !["admin_review", "driver_review"].includes(action);
      if (noSubmitNeeded) {
        submit.hidden = true;
        cancel.textContent = "Cerrar";
      }

      if (state.modalMode === "confirm") {
        title.textContent = closureRequesterText(closure);
        if (action === "driver_waiting_admin") {
          subtitle.textContent = "El cierre fue enviado al administrador. Cuando el pago se complete, Explora cargará la foto del comprobante y cerrará el período.";
          submit.disabled = true;
          submit.textContent = "Esperando administrador";
        } else {
          subtitle.textContent = completed ? "Cierre completo." : proof ? "Comprobante enviado. Esperando confirmación." : "Revisá el detalle del cierre solicitado.";
          submit.disabled = true;
          submit.textContent = proof ? "Comprobante enviado" : "Sin acción";
        }
        return;
      }

      if (state.modalMode === "admin-review" && isAdmin()) {
        title.textContent = `Revisar ${closureTitle(kind).toLowerCase()}`;
        if (action === "admin_upload") {
          subtitle.textContent = `${closureRequesterText(closure)}. Cuando el pago ya esté realizado o recibido, cargá la foto del comprobante para cerrar el período.`;
          submit.disabled = false;
          submit.textContent = "Cargar comprobante y cerrar";
        } else if (action === "admin_review") {
          subtitle.textContent = `El comprobante de ${closureDriverName(closure)} ya está cargado. Confirmá el cierre.`;
          submit.disabled = false;
          submit.textContent = "Confirmar cierre";
        } else {
          subtitle.textContent = completed ? "Cierre completo." : proof ? "Comprobante cargado. No corresponde subir otro comprobante." : "Esperando comprobante de quien debe liquidar.";
          submit.disabled = true;
          submit.textContent = proof ? "Comprobante recibido" : "Esperando";
        }
        return;
      }
    }

    const adminPayNow = state.modalMode === "admin-pay-now" && isAdmin();
    title.textContent = adminPayNow ? `Cargar comprobante de ${closureTitle(kind).toLowerCase()}` : (isAdmin() ? `Pedir cierre de ${closureTitle(kind).toLowerCase()}` : `Pedir ${closureTitle(kind).toLowerCase()}`);
    subtitle.textContent = adminPayNow
      ? (getDriverUid() ? `Explora liquida ahora a ${state.selectedDriverName || "chofer"}. Esta acción crea y cierra solamente la tarjeta ${closureTitle(kind).toLowerCase()}.` : "Seleccioná primero un chofer para cargar el comprobante.")
      : (isAdmin()
        ? (getDriverUid() ? `Chofer seleccionado: ${state.selectedDriverName || "chofer"}. Esta acción corta únicamente la tarjeta ${closureTitle(kind).toLowerCase()}.` : "Seleccioná primero un chofer para cargar sus datos y pedir el cierre.")
        : `Esta acción pide solamente el cierre de ${closureTitle(kind).toLowerCase()}. El administrador recibirá el cierre y cargará la foto cuando el pago esté completado.`);
    submit.textContent = adminPayNow ? "Subir comprobante y cerrar" : `Pedir cierre de ${closureTitle(kind).toLowerCase()}`;
    submit.disabled = isAdmin() && !getDriverUid();
    // En modo request el archivo está oculto. En admin-pay-now el comprobante de Explora es obligatorio.
    fileField.hidden = !adminPayNow;
    if (adminPayNow) {
      const fileLabel = fileField.querySelector("label");
      if (fileLabel) fileLabel.textContent = "Comprobante obligatorio";
    }
    if (kind === "caja_chica") {
      summary.innerHTML = `<article><span>Efectivo base</span><strong>${currency(latest.gross || 0)}</strong></article><article><span>Caja chica 5%</span><strong>${currency(latest.cashboxTotal || 0)}</strong></article><article><span>En poder del chofer</span><strong>${currency(latest.cashboxInDriver || 0)}</strong></article><article class="closure-payment-result settlement-result-green"><span class="closure-liquidation-label">Chofer debe liquidar a Explora</span><strong>${currency(latest.amountFromDriver || 0)}</strong></article>`;
    } else if (kind === "gastos") {
      summary.innerHTML = `<article><span>Gastos cargados</span><strong>${currency(latest.expenseTotal || 0)}</strong></article><article><span>Parte chofer</span><strong>${currency(latest.driverExpenseShare || 0)}</strong></article><article><span>Explora debía liquidar</span><strong>${currency(latest.expenseAmountToDriverBeforeDebt || latest.exploraExpenseShare || 0)}</strong></article><article><span>Ajuste de deuda con Gastos</span><strong>${latest.expenseDebtOffsetApplied > 0 ? `−${currency(latest.expenseDebtOffsetApplied)}` : currency(0)}</strong></article><article class="closure-payment-result settlement-result-green"><span class="closure-liquidation-label">Explora debe liquidar a chofer</span><strong>${currency(latest.amountToDriver || 0)}</strong></article>`;
    } else if (kind === "chofer") {
      summary.innerHTML = `<article><span>Efectivo chofer</span><strong>${currency(latest.cashInDriver || 0)}</strong></article><article><span>Parte chofer</span><strong>${currency(latest.billingShareEach || 0)}</strong></article><article><span>Caja chica 5% efectivo</span><strong>${currency(latest.billingCashboxGenerated || latest.cashboxTotal || 0)}</strong></article><article class="closure-payment-result settlement-result-green"><span class="closure-liquidation-label">Debe liquidar</span><strong>${currency(latest.amountFromDriver || 0)}</strong></article>`;
    } else if (kind === "explora") {
      summary.innerHTML = `<article><span>Digital Explora</span><strong>${currency(latest.nonCashInExplora || 0)}</strong></article><article><span>Parte Explora</span><strong>${currency(latest.billingShareEach || 0)}</strong></article><article><span>Caja chica descontada</span><strong>${latest.billingCashboxOffsetApplied > 0 ? `−${currency(latest.billingCashboxOffsetApplied)}` : currency(0)}</strong></article><article class="closure-payment-result settlement-result-green"><span class="closure-liquidation-label">Explora liquida</span><strong>${currency(latest.amountToDriver || 0)}</strong></article>`;
    } else {
      summary.innerHTML = `<article><span>Efectivo chofer</span><strong>${currency(latest.cashInDriver || 0)}</strong></article><article><span>Digital Explora</span><strong>${currency(latest.nonCashInExplora || 0)}</strong></article><article><span>Parte de cada uno</span><strong>${currency(latest.billingShareEach || 0)}</strong></article><article class="closure-payment-result settlement-result-green"><span class="closure-liquidation-label">Resultado</span><strong>${latest.amountFromDriver > 0 ? `Chofer debe liquidar a Explora ${currency(latest.amountFromDriver)}` : latest.amountToDriver > 0 ? `Explora debe liquidar a chofer ${currency(latest.amountToDriver)}` : "Nadie debe liquidar"}</strong></article>`;
    }
    const payData = closureAmountLine(latest);
    const driverPayment = driverPaymentProfileForUid(getDriverUid());
    summary.innerHTML += closurePaymentRowsHtml({ driverPayment, direction:payData.direction });
  }

  async function rejectClosureByAdmin() {
    const closure = state.modalClosure;
    if (state.busy) return;
    if (!canAdminRejectClosure(closure)) {
      setModalMessage("Este cierre ya no puede rechazarse porque fue cerrado o tiene comprobante.", "error");
      return;
    }
    const accepted = window.confirm("¿No aceptar este cierre? El corte se anulará y Facturación junto con Caja chica volverán automáticamente al período anterior.");
    if (!accepted) return;
    state.busy = true;
    const button = $("payClosureReject");
    const oldText = button?.textContent || "No aceptar cierre";
    if (button) { button.disabled = true; button.textContent = "Restaurando…"; }
    setModalMessage("Restaurando el período anterior…");
    try {
      const nowMs = Date.now();
      const patch = {
        originalClosureMode:safe(closure.originalClosureMode || closure.closureMode || closure.periodType || "on_demand"),
        originalCutoffAtMs:Number(closure.originalCutoffAtMs || closureCutMs(closure) || 0),
        closureMode:"rejected_on_demand",
        periodType:"rejected_on_demand",
        cutoffActive:false,
        invalidatesCutoff:true,
        status:"rejected",
        estado:"rechazado",
        statusLabel:"Cierre no aceptado por Explora · período restaurado",
        closureStatus:"rejected",
        paymentStatus:"cancelled",
        receiptStatus:"not_required",
        paid:false,
        completed:false,
        rejected:true,
        rejectionReason:"incorrect_closure_request",
        rejectedByUid:state.auth?.currentUser?.uid || "",
        rejectedByName:accountName(),
        rejectedByRole:"admin",
        rejectedAt:serverTimestamp(),
        rejectedAtMs:nowMs,
        rollbackRestored:true,
        rollbackRestoredAt:serverTimestamp(),
        rollbackRestoredAtMs:nowMs,
        updatedAt:serverTimestamp(),
        updatedAtMs:nowMs,
        version:VERSION
      };
      await updateDoc(doc(state.db, "cierres_semanales", closure.id), patch);
      state.closures = state.closures.map(row => safe(row.id || row.closureId) === safe(closure.id) ? { ...row, ...patch, rejectedAtMs:nowMs, rollbackRestoredAtMs:nowMs, updatedAtMs:nowMs } : row);
      state.pendingClosure = null;
      state.modalClosure = { ...closure, ...patch, rejectedAtMs:nowMs, rollbackRestoredAtMs:nowMs, updatedAtMs:nowMs };
      state.latestSummary = computeSummary();
      render();
      setModalMessage("Cierre no aceptado. Facturación y Caja chica fueron restauradas también en el panel del chofer.", "ok");
      setTimeout(closeClosureModal, 900);
    } catch (error) {
      console.error("EXPLORA_PAY_REJECT_CLOSURE", error);
      setModalMessage(error?.message || "No se pudo restaurar el cierre.", "error");
      if (button) { button.disabled = false; button.textContent = oldText; }
    } finally {
      state.busy = false;
    }
  }

  async function submitClosureModal() {
    if (state.busy) return;
    if (state.modalMode === "expense-debt-blocked") {
      openDebtExpenseOffsetMode();
      return;
    }

    // Debe ejecutarse ANTES del primer await y dentro del click real. De esta
    // manera iOS Safari y Android APK/PWA permiten que el cierre termine abriendo
    // WhatsApp aun cuando Firebase tarde en confirmar la operación.
    const closureSubmitMode = safe(state.modalMode);
    const adminReviewNeedsWhatsapp = closureSubmitMode === "admin-review"
      && isAdmin()
      && state.modalClosure
      && (number(state.modalClosure.amountDueFromDriver || 0) > 0 || number(state.modalClosure.amountDueToDriver || 0) > 0)
      && !closureHasProof(state.modalClosure);
    const closureModeMayNotifyWhatsapp = closureSubmitMode === "admin-pay-now"
      || adminReviewNeedsWhatsapp
      || !["debt-expense-offset", "debt-payment", "admin-debt-payment", "confirm", "admin-review"].includes(closureSubmitMode);
    if (closureModeMayNotifyWhatsapp) prepareClosureWhatsappWindowFromGesture();
    else clearPreparedClosureWhatsappWindow({ close:true });

    state.busy = true;
    setModalMessage("Procesando…");
    const submit = $("payClosureSubmit");
    const oldText = submit?.textContent || "Aceptar";
    if (submit) submit.textContent = "Procesando…";
    try {
      if (state.modalMode === "debt-expense-offset") await submitDebtExpenseOffset();
      else if (state.modalMode === "debt-payment") await submitDebtPayment();
      else if (state.modalMode === "admin-debt-payment" && isAdmin()) await submitAdminDebtPayment();
      else if (state.modalMode === "confirm" && state.modalClosure) await driverConfirmClosure(state.modalClosure);
      else if (state.modalMode === "admin-review" && state.modalClosure && isAdmin()) await adminSubmitClosure(state.modalClosure);
      else if (state.modalMode === "admin-pay-now" && isAdmin()) await adminCreateAndCloseClosure();
      else await requestClosure();
      setModalMessage("Listo.", "ok");
      setTimeout(closeClosureModal, 700);
    } catch (error) {
      // Si el cierre falla, nunca dejamos la ventana puente abierta en blanco.
      clearPreparedClosureWhatsappWindow({ close:true });
      console.error("EXPLORA_PAY_CLOSURE", error);
      const rawMessage = safe(error?.message || "");
      const friendlyMessage = /missing or insufficient permissions|permission-denied/i.test(rawMessage)
        ? "Firebase rechazó el registro. Cerrá y abrí la app para cargar la versión corregida y volvé a intentar."
        : (rawMessage || "No se pudo completar el cierre.");
      setModalMessage(friendlyMessage, "error");
    } finally {
      state.busy = false;
      if (submit) submit.textContent = oldText;
    }
  }


  async function requestClosure() {
    const user = state.auth?.currentUser;
    if (!user?.uid) throw new Error("No hay sesión activa.");
    const kind = activeClosureKind(state.modalKind || state.tab);
    if (!isClosureTab(kind)) throw new Error("Elegí Chofer, Explora o Gastos para pedir un cierre.");
    let targetUid = getDriverUid();
    let targetName = displayName();
    if (isAdmin()) {
      targetUid = safe($("payClosureDriverSelect")?.value || state.selectedDriverUid);
      const driver = state.drivers.find(d => d.uid === targetUid);
      if (!targetUid || !driver) throw new Error("Elegí un chofer para pedir el cierre.");
      state.selectedDriverUid = targetUid;
      state.selectedDriverName = driver.name;
      targetName = driver.name;
    }
    // Puede existir un cierre anterior pendiente; eso no debe impedir cortar un nuevo período
    // si ya hay movimientos nuevos después del último corte.
    if (!isAdmin()) requireOwnPaymentProfileComplete();
    const fullSummary = isAdmin() ? await computeDriverSummary(targetUid) : (state.latestSummary || computeSummary());
    requireClosureAllowed(kind, fullSummary);
    const summary = tabSummary(fullSummary, kind);
    const paymentPayload = closurePaymentDataForPayload(targetUid, summary);
    const telegramText = closureTelegramNoticeText({ kind, summary, targetName, targetUid, requestedBy:isAdmin() ? accountName() : displayName() });
    const cutoffAtMs = Date.now();
    const moduleKey = mapModuleKey(kind) || kind;
    const periodId = `${targetUid}_${moduleKey}_${Number(summary.resetMs || 0)}_${cutoffAtMs}`;
    console.log("[CIERRE] pedir cierre", { driverUid:targetUid, moduleKey, periodId });
    const isBillingRequest = isBillingClosureKind(kind);
    const recordIds = (summary.records || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const settlementPaymentIds = (summary.billingSettlementPayments || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const cashboxGeneratedBillingIds = (summary.cashboxGeneratedRecords || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const cashboxEligibleBillingIds = (summary.cashboxEligibleRecords || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const cashboxRecordIds = (fullSummary.cashboxRecords || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const expenseIds = (summary.expenses || []).map(row => safe(row.id)).filter(Boolean).slice(0, 200);
    const amountFromDriver = Number(summary.amountFromDriver || 0);
    const amountToDriver = Number(summary.amountToDriver || 0);
    const payerRole = amountFromDriver > 0.49 ? "driver" : amountToDriver > 0.49 ? "admin" : "balanced";
    const autoClosed = payerRole === "balanced";
    const payload = {
      closureMode:"on_demand",
      periodType:"on_demand",
      closureKind:kind,
      closureType:kind,
      moduleKey,
      closureModuleKey:moduleKey,
      periodId,
      payTab:kind,
      billingClosure:isBillingClosureKind(kind),
      billingResetGroup:isBillingClosureKind(kind) ? "facturacion" : "",
      autoClosesCashbox:isBillingClosureKind(kind),
      cashboxClosedWithBilling:isBillingClosureKind(kind),
      cashboxAutoClosed:isBillingClosureKind(kind),
      cashboxResetGroup:isBillingClosureKind(kind) ? "facturacion" : "",
      affectsTabs:isBillingClosureKind(kind) ? ["chofer", "explora", "facturacion", "caja_chica"] : [kind],
      homeModule:kind,
      requestModule:kind,
      originModule:kind,
      status:autoClosed ? "closed" : "requested",
      estado:autoClosed ? "cerrado" : "solicitado",
      statusLabel:autoClosed ? "Cierre equilibrado · cerrado automáticamente" : `${closureTitle(kind)} solicitado`,
      closureStatus:autoClosed ? "closed" : "requested",
      paymentStatus:autoClosed ? "paid" : "pending",
      receiptStatus:autoClosed ? "not_required" : "pending",
      paid:autoClosed,
      completed:autoClosed,
      financialPayerRole:payerRole,
      pendingPayerRole:"admin",
      receiptRequiredFrom:"admin",
      adminActionRequired:!autoClosed,
      adminReceiptRequired:!autoClosed,
      driverUid:targetUid,
      choferUid:targetUid,
      uid:targetUid,
      driverName:targetName,
      requestedByUid:user.uid,
      requestedByName:isAdmin() ? accountName() : displayName(),
      requestedByRole:isAdmin() ? "admin" : "driver",
      ...paymentPayload,
      telegramNoticeText:telegramText,
      gross:Number(summary.gross || 0),
      expenseTotal:Number(summary.expenseTotal || 0),
      expenseAmountToDriverBeforeDebt:Number(summary.expenseAmountToDriverBeforeDebt || 0),
      expenseDebtOffsetApplied:Number(summary.expenseDebtOffsetApplied || 0),
      expenseAmountToDriverAfterDebt:Number(summary.amountToDriver || 0),
      includedDebtExpenseOffsetIds:(summary.expenseDebtAdjustmentRows || []).map(row => safe(row.id || row.paymentId)).filter(Boolean).slice(0,200),
      cashInDriver:Number(summary.cashInDriver || 0),
      exploraCash:Number(summary.nonCashInExplora || 0),
      cashboxRate:Number(summary.cashboxRate || 0),
      cashboxGross:isBillingRequest ? Number(fullSummary.cashboxGross || 0) : Number(summary.cashboxGross || 0),
      cashboxTotal:isBillingRequest ? Number(fullSummary.cashboxTotal || 0) : Number(summary.cashboxTotal || 0),
      cashboxGeneratedTotal:isBillingRequest ? Number(fullSummary.cashboxGeneratedTotal || 0) : Number(summary.cashboxGeneratedTotal || 0),
      cashboxAlreadyCompensated:isBillingRequest ? Number(fullSummary.cashboxOffsetPreviouslyApplied || 0) : 0,
      cashboxIncludedInSettlement:isBillingRequest ? Number(fullSummary.cashboxTotal || 0) : 0,
      cashboxInDriver:isBillingRequest ? Number(fullSummary.cashboxTotal || 0) : Number(summary.cashboxInDriver || 0),
      cashboxInExplora:isBillingRequest ? 0 : Number(summary.cashboxInExplora || 0),
      cashboxPeriodStartMs:isBillingRequest ? Number(fullSummary.tabs?.caja_chica?.resetMs || 0) : 0,
      cashboxCutoffAtMs:isBillingRequest ? cutoffAtMs : 0,
      billingCashboxGross:Number(summary.billingCashboxGross || 0),
      billingCashboxEligibleGross:Number(summary.billingCashboxEligibleGross || 0),
      billingCashboxGenerated:Number(summary.billingCashboxGenerated || 0),
      billingCurrentCashboxGenerated:Number(summary.billingCurrentCashboxGenerated || 0),
      billingCashboxEligibleAmount:Number(summary.billingCashboxEligibleAmount || 0),
      billingCashboxOffsetApplied:Number(summary.billingCashboxOffsetApplied || 0),
      billingCashboxRemainingInDriver:Number(summary.billingCashboxRemainingInDriver || 0),
      billingNetBeforeCashboxToDriver:Number(summary.billingNetBeforeCashboxToDriver || 0),
      billingAmountToDriverBeforeCashbox:Number(summary.billingAmountToDriverBeforeCashbox || 0),
      billingNetBeforeDriverPayments:Number(summary.billingNetBeforeDriverPayments || 0),
      billingSettlementPaymentTotal:Number(summary.billingSettlementPaymentTotal || 0),
      billingShareEach:Number(summary.billingShareEach || 0),
      netSettlementToDriver:Number(summary.netSettlementToDriver || 0),
      amountDueFromDriver:amountFromDriver,
      amountDueToDriver:amountToDriver,
      includedBillingIds:recordIds,
      includedBillingSettlementPaymentIds:settlementPaymentIds,
      includedCashboxGeneratedBillingIds:cashboxGeneratedBillingIds,
      includedCashboxEligibleBillingIds:cashboxEligibleBillingIds,
      includedCashboxIds:isBillingRequest ? cashboxRecordIds : [],
      includedExpenseIds:expenseIds,
      includedCount:Number(recordIds.length + expenseIds.length),
      cycleStartedAtMs:Number(summary.resetMs || 0),
      cutoffAtMs,
      requestedAtMs:cutoffAtMs,
      requestedAt:serverTimestamp(),
      ...(autoClosed ? { closedAt:serverTimestamp(), closedAtMs:cutoffAtMs, completedAt:serverTimestamp(), completedAtMs:cutoffAtMs } : {}),
      createdAt:serverTimestamp(),
      updatedAt:serverTimestamp(),
      version:VERSION
    };
    const created = await addDoc(collection(state.db, "cierres_semanales"), payload);
    state.closures = [{ ...payload, id:created.id, createdAtMs:cutoffAtMs, updatedAtMs:cutoffAtMs }, ...state.closures.filter(row => row.id !== created.id)];
    // V4137: el aviso operativo se envía exclusivamente por Telegram desde Cloud Functions.
    render();
    return { ...payload, id:created.id, createdAtMs:cutoffAtMs, updatedAtMs:cutoffAtMs };
  }

  async function adminCreateAndCloseClosure() {
    if (!isAdmin()) throw new Error("Solo administrador.");
    if (!(state.modalFile instanceof File) || !(state.modalFile.size > 0)) throw new Error("Seleccioná el comprobante de Explora.");
    const closure = await requestClosure();
    if (!closure?.id) throw new Error("No se pudo crear el cierre para cargar comprobante.");
    const receipt = await uploadClosureReceipt(closure, state.modalFile);
    const closed = closureClosedPayload({ closure, receipt, uploadedBy:"admin" });
    await updateDoc(doc(state.db, "cierres_semanales", closure.id), closed);
    const completedClosure = { ...closure, ...closed, receiptUrl:receipt?.url || null, receiptPath:receipt?.path || null };
    state.closures = state.closures.map(row => safe(row.id || row.closureId) === safe(closure.id) ? { ...row, ...closed, receiptUrl:receipt?.url || row.receiptUrl || null, receiptPath:receipt?.path || row.receiptPath || null } : row);
    render();
    notifyClosureReceiptWhatsapp({ closure:completedClosure, receipt, uploadedBy:"admin" });
    return completedClosure;
  }

  function extensionForFile(file) {
    const byName = safe(file?.name).match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
    if (byName) return byName === "jpeg" ? "jpg" : byName;
    const mime = safe(file?.type).toLowerCase();
    if (mime.includes("png")) return "png";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("pdf")) return "pdf";
    return "jpg";
  }

  async function uploadClosureReceipt(closure, file) {
    if (!state.storage) throw new Error("Storage no está disponible.");
    if (!(file instanceof File) || !(file.size > 0)) throw new Error("Seleccioná una foto o PDF del comprobante.");
    if (file.size > 15 * 1024 * 1024) throw new Error("El comprobante supera 15 MB.");
    const ext = extensionForFile(file);
    const closureId = safe(closure.id || closure.closureId || `cierre_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
    const driverUid = safe(closure.driverUid || closure.uid || getDriverUid());
    const path = `gastos/${driverUid}/${closureId}/cierre-a-demanda.${ext}`;
    const ref = storageRef(state.storage, path);
    await uploadBytes(ref, file, { contentType:file.type || (ext === "pdf" ? "application/pdf" : "image/jpeg"), customMetadata:{ module:"on_demand_closure", driverUid, closureId, uploadedByUid:state.auth?.currentUser?.uid || "" } });
    const url = await getDownloadURL(ref);
    return { url, path, ext };
  }

  function closureClosedPayload({ closure = {}, receipt = null, uploadedBy = "admin" } = {}) {
    const nowMs = Date.now();
    const isDriver = uploadedBy === "driver";
    const directReceiptUrl = receipt?.url || closureProofUrl(closure) || null;
    const actorName = isDriver ? displayName() : accountName();
    const actorRole = isDriver ? "driver" : "admin";
    const label = isDriver
      ? "Cierre cerrado automáticamente con comprobante del chofer"
      : "Cierre cerrado automáticamente con comprobante de Explora";
    return {
      status:"closed",
      estado:"cerrado",
      statusLabel:label,
      closureStatus:"closed",
      paymentStatus:"paid",
      receiptStatus:"confirmed",
      paid:true,
      completed:true,
      closedByUid:state.auth?.currentUser?.uid || "",
      closedByName:actorName,
      closedByRole:actorRole,
      closedReason:"receipt_uploaded_by_payer",
      closedAt:serverTimestamp(),
      closedAtMs:nowMs,
      completedAt:serverTimestamp(),
      completedAtMs:nowMs,
      confirmedByUid:state.auth?.currentUser?.uid || "",
      confirmedByName:actorName,
      confirmedAt:serverTimestamp(),
      confirmedAtMs:nowMs,
      receiptUrl:directReceiptUrl,
      receiptPath:receipt?.path || safe(closure.receiptPath || closure.driverReceiptPath || closure.adminReceiptPath) || null,
      // Enlace directo reutilizable por WhatsApp y por el puente hacia Telegram.
      notificationPhotoUrl:directReceiptUrl,
      telegramPhotoUrl:directReceiptUrl,
      whatsappPhotoUrl:directReceiptUrl,
      firebasePhotoUrl:directReceiptUrl,
      receiptUploadedBy:actorRole,
      receiptUploadedAt:serverTimestamp(),
      receiptUploadedAtMs:nowMs,
      updatedAt:serverTimestamp(),
      updatedAtMs:nowMs,
      ...(isDriver ? { driverUploadedAt:serverTimestamp(), driverUploadedAtMs:nowMs, driverReceiptUrl:receipt?.url || closure.driverReceiptUrl || closure.receiptUrl || null, driverReceiptPath:receipt?.path || closure.driverReceiptPath || closure.receiptPath || null } : {}),
      ...(!isDriver ? { adminUploadedAt:serverTimestamp(), adminUploadedAtMs:nowMs, adminReceiptUrl:receipt?.url || closure.adminReceiptUrl || closure.receiptUrl || null, adminReceiptPath:receipt?.path || closure.adminReceiptPath || closure.receiptPath || null } : {})
    };
  }

  async function driverConfirmClosure(closure) {
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const ref = doc(state.db, "cierres_semanales", closure.id);
    if (!(due > 0) && !(toDriver > 0)) {
      await updateDoc(ref, {
        status:"closed",
        estado:"cerrado",
        statusLabel:"Cierre equilibrado · cerrado automáticamente",
        closureStatus:"closed",
        paymentStatus:"paid",
        receiptStatus:"not_required",
        paid:true,
        completed:true,
        closedByUid:state.auth?.currentUser?.uid || "",
        closedByName:displayName(),
        closedByRole:"driver",
        closedReason:"balanced_no_receipt_required",
        closedAt:serverTimestamp(),
        closedAtMs:Date.now(),
        updatedAt:serverTimestamp()
      });
      return;
    }
    throw new Error("El cierre ya fue enviado al administrador. Explora cargará el comprobante cuando el pago se complete.");
  }

  async function adminSubmitClosure(closure) {
    if (!closure?.id) throw new Error("No se pudo identificar el cierre.");
    const due = number(closure.amountDueFromDriver || 0);
    const toDriver = number(closure.amountDueToDriver || 0);
    const ref = doc(state.db, "cierres_semanales", closure.id);
    if ((due > 0 || toDriver > 0) && !closureHasProof(closure)) {
      if (!(state.modalFile instanceof File) || !(state.modalFile.size > 0)) {
        throw new Error("Seleccioná la foto del comprobante después de completar o recibir el pago.");
      }
      const receipt = await uploadClosureReceipt(closure, state.modalFile);
      const closed = { ...closureClosedPayload({ closure, receipt, uploadedBy:"admin" }), adminActionRequired:false, adminReceiptRequired:false };
      await updateDoc(ref, closed);
      notifyClosureReceiptWhatsapp({ closure:{ ...closure, ...closed }, receipt, uploadedBy:"admin" });
      return;
    }
    if ((due > 0 || toDriver > 0) && closureHasProof(closure)) {
      await updateDoc(ref, { ...closureClosedPayload({ closure, uploadedBy:"admin" }), adminActionRequired:false, adminReceiptRequired:false });
      return;
    }
    if (!(due > 0) && !(toDriver > 0)) {
      await updateDoc(ref, {
        status:"closed",
        estado:"cerrado",
        statusLabel:"Cierre equilibrado · cerrado automáticamente",
        closureStatus:"closed",
        paymentStatus:"paid",
        receiptStatus:"not_required",
        paid:true,
        completed:true,
        closedByUid:state.auth?.currentUser?.uid || "",
        closedByName:accountName(),
        closedByRole:"admin",
        closedReason:"balanced_no_receipt_required",
        closedAt:serverTimestamp(),
        closedAtMs:Date.now(),
        updatedAt:serverTimestamp()
      });
      return;
    }
    throw new Error("Todavía falta el comprobante correspondiente.");
  }

  async function refreshSession(user) {
    const nextUser = user || state.auth?.currentUser || null;
    const nextUid = safe(nextUser?.uid);
    const currentUid = safe(state.user?.uid);
    const alreadyListeningSameSession = Boolean(
      nextUid && currentUid === nextUid && state.unsubscribers.length > 0
    );
    state.user = nextUser;
    const session = window.ExploraSession || {};
    state.role = safe(session.role || session.profile?.role || session.profile?.rol || "driver").toLowerCase() || "driver";
    state.profile = session.profile || {};
    state.profileDocumentId = session.profileDocumentId || session.driverId || state.user?.uid || "";
    if (!isAdmin()) {
      state.selectedDriverUid = "";
      state.selectedDriverName = "";
    }
    state.previousDetailsOpen = { caja_chica:false, gastos:false, explora:false, chofer:false };
    forceHomeLanding();
    render();
    // v4125: onAuthStateChanged + session-opened + fallback podían arrancar
    // tres veces los mismos listeners. Eso reiniciaba dataLoading y mostraba
    // "Preparando…" después del splash. Para el mismo UID conservamos la
    // sincronización ya confirmada y solo actualizamos perfil/rol.
    if (!alreadyListeningSameSession) startRealtime("session");
  }

  async function boot() {
    try {
      installShell(); bindShell();
      forceHomeLanding();
      await waitFirebase();
      onAuthStateChanged(state.auth, user => refreshSession(user));
      window.addEventListener("explora:session-opened", () => refreshSession(state.auth?.currentUser));
      window.addEventListener("explora:auth-cleared", () => { clearListeners(); state.user = null; });
      setTimeout(() => refreshSession(state.auth?.currentUser), 1200);
    } catch (error) {
      console.warn("EXPLORA_PAY_BOOT", error?.message || error);
    }
  }

  window.addEventListener("pageshow", event => {
    if (!event.persisted && document.readyState !== "complete") return;
    if (payOverlayIsOpen()) return;
    forceHomeLanding();
    render();
  });
  let payHiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { payHiddenAt = Date.now(); return; }
    if (document.visibilityState !== "visible") return;
    if (payOverlayIsOpen()) return;
    if (payHiddenAt && Date.now() - payHiddenAt > 45000) {
      forceHomeLanding();
      render();
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once:true });
  else boot();
  window.ExploraActions = window.ExploraActions || {};
  window.ExploraActions["admin-cierres"] = () => showPayView("admin-cierres");
  window.ExploraPagoHome = Object.freeze({ version:VERSION, render, openClosureModal, computeSummary, getDriverBillingBalance, refreshOpenData, openEfficiencyModal, renderAdminClosuresScreen, waitUntilReady:waitUntilFinancialReady, isReady:()=>!state.dataLoading && REALTIME_COLLECTIONS.every(name=>state.realtimeReady.has(name)) });
})();

/* v4052: Histórico con rangos correctos, selector mensual, consultas paralelas con timeout. */
