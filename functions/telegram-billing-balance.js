"use strict";

const AMOUNT_FIELDS = [
  "amount", "monto", "valor", "finalPrice", "total", "importe", "price", "precio",
  "precioFinal", "montoFinal", "montoCobrado", "importeTotal", "finalAmount", "totalAmount",
  "billingAmount", "chargedAmount", "paidAmount", "fare", "tarifa", "value", "totalCobrado",
  "facturacion", "billingTotal"
];

function safeText(value) {
  return String(value ?? "").trim();
}

function moneyNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = safeText(value).replace(/\s/g, "");
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9,.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "," || cleaned === ".") return 0;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot
      ? cleaned.replace(/\./g, "").replace(/,/g, ".")
      : cleaned.replace(/,/g, "");
  } else if (lastDot >= 0) {
    normalized = cleaned.slice(lastDot + 1).length === 3 ? cleaned.replace(/\./g, "") : cleaned;
  } else if (lastComma >= 0) {
    normalized = cleaned.slice(lastComma + 1).length === 3
      ? cleaned.replace(/,/g, "")
      : cleaned.replace(/,/g, ".");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function amountOf(data = {}) {
  for (const field of AMOUNT_FIELDS) {
    if (data[field] === undefined || data[field] === null || data[field] === "") continue;
    const amount = moneyNumber(data[field]);
    if (amount > 0) return amount;
  }
  return 0;
}

function paymentMethodOf(data = {}) {
  const raw = safeText(
    data.paymentMethod || data.metodoPago || data.financialCategory ||
    data.receiptPaymentMethod || data.paymentProvider || data.method || data.tipoPago
  ).toLowerCase();
  if (/cash|efectivo/.test(raw)) return "cash";
  if (/qr/.test(raw)) return "qr";
  if (/card|tarjeta|point|posnet/.test(raw)) return "card";
  if (/transfer|alias|transf/.test(raw)) return "transfer";
  if (/digital|online|electr[oó]nic/.test(raw)) return "digital";
  return raw;
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value === "number") return value > 100000000000 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value._seconds === "number") {
    return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1000000);
  }
  if (typeof value.seconds === "number") {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
  }
  return 0;
}

function rowMs(data = {}) {
  return Math.max(
    timestampMs(data.createdAt), timestampMs(data.completedAt), timestampMs(data.updatedAt),
    timestampMs(data.expenseDate), timestampMs(data.fechaISO),
    Number(data.createdAtMs || 0), Number(data.timestampMs || 0), Number(data.completedAtMs || 0)
  );
}

function movementIsDeleted(data = {}) {
  const status = safeText(data.status || data.estado || data.state || data.deletionStatus).toLowerCase();
  return data.deleted === true || data.isDeleted === true || data.eliminado === true ||
    /deleted|eliminado|borrado|anulado/.test(status);
}

function isSimulated(data = {}) {
  return data.isSimulated === true || data.createdBySimulation === true || data.verificationMode === "simulation";
}

function cashboxIsExcluded(data = {}) {
  return data.excludeFromCashbox === true || data.cashboxExcluded === true ||
    data.cajaChicaEliminada === true || data.ignoreCashbox === true || data.noCashbox === true;
}

function isDriverBillingSettlementPayment(data = {}) {
  const type = safeText(data.type || data.operationType || data.movementType).toLowerCase();
  const source = safeText(data.sourceModule || data.category || data.module).toLowerCase();
  return data.affectsBillingSettlement === true ||
    type === "admin_billing_settlement_payment" ||
    (type === "driver_payment" && /factur|billing/.test(source));
}

function billingSettlementDirection(data = {}) {
  let direction = safeText(data.adjustmentDirection || data.settlementDirection || data.paymentDirection).toLowerCase();
  if (["driver_pays_explora", "chofer_a_explora", "chofer_a_david"].includes(direction)) direction = "driver_to_explora";
  if (["explora_pays_driver", "explora_a_chofer", "david_a_chofer"].includes(direction)) direction = "explora_to_driver";
  if (direction === "driver_to_explora" || direction === "explora_to_driver") return direction;
  if (isDriverBillingSettlementPayment(data)) return "driver_to_explora";
  return "";
}

function activeClosureKind(value = "") {
  const raw = safeText(value).toLowerCase();
  if (/pendiente|deuda|debt|multa|choque|prestamo|pr[eé]stamo|adelanto|loan|advance/.test(raw)) return "pendientes";
  if (/caja|chica|cashbox|bruto/.test(raw)) return "caja_chica";
  if (/gasto|expense/.test(raw)) return "gastos";
  if (/factur|billing|cobro/.test(raw)) return "facturacion";
  if (/explora|digital|transfer|qr|card|tarjeta/.test(raw)) return "explora";
  if (/chofer|driver|efectivo|cash/.test(raw)) return "chofer";
  return "";
}

function isBillingClosureKind(value = "") {
  const kind = activeClosureKind(value);
  return kind === "chofer" || kind === "explora" || kind === "facturacion";
}

function closureKindOf(data = {}) {
  const raw = data.closureKind || data.closureType || data.payTab || data.closeKind ||
    data.kind || data.cierreTipo || data.type || data.category;
  return activeClosureKind(raw);
}

function closureHomeModuleOf(data = {}) {
  const fields = [
    "homeModule", "homeTab", "homeCard", "moduleKey", "closureModuleKey",
    "requestModule", "requestedModule", "requestedTab", "requestedFrom",
    "originModule", "originTab", "sourceModule", "sourceTab", "settlementType",
    "payTab", "closeKind", "kind", "closureKind", "closureType", "cierreTipo",
    "module", "modulo", "source", "origin", "tab", "type", "category"
  ];
  for (const field of fields) {
    const kind = activeClosureKind(data[field]);
    if (kind) return kind;
  }
  return "";
}

function closureInvalidatesCutoff(data = {}) {
  const fields = [
    data.status, data.estado, data.closureStatus, data.paymentStatus, data.receiptStatus,
    data.statusLabel, data.rejectionReason, data.rollbackStatus, data.closureMode, data.periodType
  ];
  const joined = fields.map(value => safeText(value).toLowerCase()).filter(Boolean).join(" | ");
  return data.rejected === true || data.rollbackRestored === true || data.invalidatesCutoff === true ||
    data.cutoffActive === false || /reject|rechaz|cancel|anulad|no aceptado|rejected_on_demand/.test(joined);
}

function closureUsesActiveCutoff(data = {}) {
  const mode = safeText(data.closureMode || data.periodType).toLowerCase();
  return mode === "on_demand" && !closureInvalidatesCutoff(data);
}

function closureMatchesIndependentModule(data = {}, target = "") {
  const targetKind = activeClosureKind(target);
  if (!targetKind) return false;
  const rowKind = closureKindOf(data);
  const homeKind = closureHomeModuleOf(data);
  if (targetKind === "caja_chica") return rowKind === "caja_chica" || homeKind === "caja_chica";
  if (targetKind === "gastos") return rowKind === "gastos" || homeKind === "gastos";
  if (targetKind === "pendientes") return rowKind === "pendientes" || homeKind === "pendientes";
  if (isBillingClosureKind(targetKind)) return isBillingClosureKind(rowKind) || isBillingClosureKind(homeKind);
  return rowKind === targetKind || homeKind === targetKind;
}

function closureCutMs(data = {}) {
  const explicit = Number(data.cutoffAtMs || 0) || timestampMs(data.cutoffAt);
  if (explicit > 0) return explicit;
  const requested = Number(data.requestedAtMs || 0) || timestampMs(data.requestedAt) ||
    Number(data.createdAtMs || 0) || timestampMs(data.createdAt);
  if (requested > 0) return requested;
  return Math.max(
    Number(data.driverUploadedAtMs || 0), Number(data.adminUploadedAtMs || 0),
    Number(data.receiptUploadedAtMs || 0), Number(data.confirmedAtMs || 0), Number(data.closedAtMs || 0),
    timestampMs(data.driverUploadedAt), timestampMs(data.adminUploadedAt),
    timestampMs(data.receiptUploadedAt), timestampMs(data.confirmedAt),
    timestampMs(data.closedAt), rowMs(data)
  );
}

function latestCutoffMsFor(closures = [], kind = "facturacion") {
  return closures
    .filter(closureUsesActiveCutoff)
    .filter(row => closureMatchesIndependentModule(row, kind))
    .map(closureCutMs)
    .filter(value => value > 0)
    .reduce((latest, value) => Math.max(latest, value), 0);
}

function latestBillingCutoffMs(closures = []) {
  return latestCutoffMsFor(closures, "facturacion");
}

function billingClosureClosesCashbox(data = {}) {
  const affects = Array.isArray(data.affectsTabs) ? data.affectsTabs.map(activeClosureKind) : [];
  return data.autoClosesCashbox === true || data.cashboxClosedWithBilling === true ||
    data.cashboxAutoClosed === true || affects.includes("caja_chica");
}

function latestCashboxResetMs(closures = []) {
  // Facturación es acumulativa: un cierre de facturación no reinicia caja chica.
  // Solo un cierre explícito del módulo caja chica puede cortar ese módulo.
  return latestCutoffMsFor(closures, "caja_chica");
}

function billingCashboxOffsetOf(data = {}) {
  return Math.max(0, moneyNumber(
    data.billingCashboxOffsetApplied ?? data.cashboxOffsetApplied ??
    data.cajaChicaDescontadaLiquidacion ?? data.cajaChicaCompensada ?? 0
  ));
}

function billingCashboxOffsetsAfter(closures = [], resetCashboxMs = 0) {
  return roundMoney(closures
    .filter(closureUsesActiveCutoff)
    .filter(row => isBillingClosureKind(closureKindOf(row)) || isBillingClosureKind(closureHomeModuleOf(row)))
    .filter(row => closureCutMs(row) > Number(resetCashboxMs || 0))
    .reduce((sum, row) => sum + billingCashboxOffsetOf(row), 0));
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function uberGrossAmount(data = {}) {
  return moneyNumber(data.grossAmount ?? data.totalAmount ?? data.amount ?? data.monto ?? 0);
}

function uberCashboxAmount(data = {}) {
  const explicit = moneyNumber(data.cashboxAmount ?? data.uberCashboxAmount ?? 0);
  if (explicit > 0) return explicit;
  return uberGrossAmount(data) * 0.05;
}

function calculateOpenBillingBalance({ records = [], closures = [], uberWeeks = [] } = {}) {
  // La facturación nunca se corta por un cierre: efectivo y digital son históricos
  // acumulados. Los pagos de cierre quedan como ajustes y son los que llevan el
  // saldo a cero sin borrar la facturación.
  const cutoffMs = 0;
  const cashboxResetMs = latestCashboxResetMs(closures);
  let cash = 0;
  let digital = 0;
  let includedCount = 0;
  let driverSettlementTotal = 0;
  let exploraSettlementTotal = 0;
  let settlementPaymentCount = 0;

  for (const record of records) {
    if (!record || movementIsDeleted(record) || isSimulated(record)) continue;
    const amount = amountOf(record);
    const settlementDirection = billingSettlementDirection(record);
    if (settlementDirection) {
      const paidToAdvance = settlementDirection === "driver_to_explora"
        ? moneyNumber(record.advanceRepaymentAmount || 0)
        : 0;
      const settlementAmount = Math.max(0, amount - paidToAdvance);
      if (settlementAmount > 0) {
        if (settlementDirection === "driver_to_explora") driverSettlementTotal += settlementAmount;
        else exploraSettlementTotal += settlementAmount;
        settlementPaymentCount += 1;
      }
      continue;
    }
    if (record.excludeFromBillingSettlement === true || record.internalSettlementAdjustment === true) continue;
    const method = paymentMethodOf(record);
    if (!(amount > 0) || !["cash", "card", "qr", "transfer", "digital"].includes(method)) continue;
    if (method === "cash") cash += amount;
    else digital += amount;
    includedCount += 1;
  }

  let regularCashboxGenerated = 0;
  for (const record of records) {
    if (!record || movementIsDeleted(record) || isSimulated(record) || rowMs(record) <= cashboxResetMs) continue;
    if (billingSettlementDirection(record)) continue;
    if (record.excludeFromBillingSettlement === true || record.internalSettlementAdjustment === true) continue;
    if (cashboxIsExcluded(record) || paymentMethodOf(record) !== "cash") continue;
    const amount = amountOf(record);
    if (amount > 0) regularCashboxGenerated += amount * 0.05;
  }

  let uberCashboxGenerated = 0;
  for (const week of uberWeeks || []) {
    if (!week || movementIsDeleted(week) || isSimulated(week) || rowMs(week) <= cashboxResetMs) continue;
    const review = safeText(week.reviewStatus || week.status).toLowerCase();
    if (review === "rejected") continue;
    const grossAmount = uberGrossAmount(week);
    if (!(grossAmount > 0)) continue;
    uberCashboxGenerated += uberCashboxAmount(week);
  }

  cash = roundMoney(cash);
  digital = roundMoney(digital);
  const gross = roundMoney(cash + digital);
  const shareEach = roundMoney(gross * 0.5);
  const netBeforeCashboxToDriver = roundMoney(shareEach - cash);

  const cashboxGeneratedTotal = roundMoney(regularCashboxGenerated + uberCashboxGenerated);
  const cashboxOffsetPreviouslyApplied = Math.min(
    cashboxGeneratedTotal,
    billingCashboxOffsetsAfter(closures, cashboxResetMs)
  );
  const cashboxTotal = roundMoney(Math.max(0, cashboxGeneratedTotal - cashboxOffsetPreviouslyApplied));
  const netBeforePayments = roundMoney(netBeforeCashboxToDriver - cashboxTotal);

  driverSettlementTotal = roundMoney(driverSettlementTotal);
  exploraSettlementTotal = roundMoney(exploraSettlementTotal);
  const settlementPaymentTotal = roundMoney(driverSettlementTotal - exploraSettlementTotal);
  const netToDriver = roundMoney(netBeforePayments + driverSettlementTotal - exploraSettlementTotal);

  return {
    cutoffMs,
    cashboxResetMs,
    includedCount,
    cash,
    digital,
    gross,
    shareEach,
    settlementPaymentCount,
    settlementPaymentTotal,
    driverSettlementTotal,
    exploraSettlementTotal,
    regularCashboxGenerated:roundMoney(regularCashboxGenerated),
    uberCashboxGenerated:roundMoney(uberCashboxGenerated),
    cashboxGeneratedTotal,
    cashboxOffsetPreviouslyApplied:roundMoney(cashboxOffsetPreviouslyApplied),
    cashboxTotal,
    netBeforeCashboxToDriver,
    netBeforePayments,
    netToDriver,
    amountFromDriver:roundMoney(Math.max(0, -netToDriver)),
    amountToDriver:roundMoney(Math.max(0, netToDriver))
  };
}

module.exports = {
  calculateOpenBillingBalance,
  isDriverBillingSettlementPayment,
  latestBillingCutoffMs,
  latestCashboxResetMs
};
