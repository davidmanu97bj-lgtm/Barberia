"use strict";
const expensePolicy = require('./expense-policy');
const periodSettlement = require('./period-settlement');

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

// Versioned per receipt: never reinterpret pre-existing digital payments.
function digitalCashboxAmount(records = []) {
  return records
    .filter(item => item && !movementIsDeleted(item) && !isSimulated(item))
    .filter(item => !billingSettlementDirection(item) && !teamIsReimbursementCompensation(item))
    .filter(item => ["card", "qr", "transfer", "digital"].includes(paymentMethodOf(item)) && !cashboxIsExcluded(item))
    .filter(item => item.settlementRuleVersion === "gross_cash_digital_cashbox_5_v1")
    .reduce((sum, item) => sum + amountOf(item) * 0.05, 0);
}
function grossFlowPrincipalDelta(records = []) {
  return records
    .filter(item => item && !movementIsDeleted(item) && !isSimulated(item))
    .filter(item => !billingSettlementDirection(item) && !teamIsReimbursementCompensation(item))
    .filter(item => item.settlementRuleVersion === "gross_cash_digital_cashbox_5_v1")
    .filter(item => ["cash", "card", "qr", "transfer", "digital"].includes(paymentMethodOf(item)))
    .reduce((sum, item) => sum + amountOf(item) * (paymentMethodOf(item) === "cash" ? 0.50 : -0.50), 0);
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

function uberHasSplitAmounts(data = {}) {
  return Object.prototype.hasOwnProperty.call(data, "cashAmount") ||
    Object.prototype.hasOwnProperty.call(data, "uberCashAmount") ||
    Object.prototype.hasOwnProperty.call(data, "transferAmount") ||
    Object.prototype.hasOwnProperty.call(data, "uberTransferAmount");
}

function uberCashAmount(data = {}) {
  return uberHasSplitAmounts(data)
    ? moneyNumber(data.cashAmount ?? data.uberCashAmount ?? 0)
    : uberGrossAmount(data);
}

function uberTransferAmount(data = {}) {
  return uberHasSplitAmounts(data)
    ? moneyNumber(data.transferAmount ?? data.uberTransferAmount ?? data.digitalAmount ?? 0)
    : 0;
}

function uberGrossPrincipalDelta(records = []) {
  return records.filter(item => item.settlementRuleVersion === "uber_gross_cash_cashbox_5_v1").reduce((sum, item) => sum + uberCashAmount(item) * 0.50, 0);
}
function uberCashboxAmount(data = {}) {
  const explicit = moneyNumber(data.cashboxAmount ?? data.uberCashboxAmount ?? 0);
  if (explicit > 0) return explicit;
  return uberCashAmount(data) * 0.05;
}

function uberImpactsSettlement(data = {}) {
  const workflow = safeText(data.settlementWorkflowVersion || data.workflowVersion).toLowerCase();
  const status = safeText(data.reviewStatus || data.status).toLowerCase();
  if (workflow === "v85_verified_direct") return data.verifiedAutomatically === true && status === "completed";
  if (workflow === "v84_driver_submission_admin_review") {
    return data.adminConfirmed === true && /approved|confirmed|completed/.test(status);
  }
  if (workflow === "v82_admin_driver_confirmation") {
    return data.driverConfirmed === true && /approved|confirmed|completed/.test(status);
  }
  return !/reject|rechaz|cancel|anulad/.test(status);
}

function isAdminSettlementDebt(data = {}) {
  const type = safeText(data.type || data.debtType).toLowerCase();
  const role = safeText(data.createdByRole || data.registeredByRole).toLowerCase();
  const source = safeText(data.sourceModule || data.registrationOrigin || data.origin).toLowerCase();
  if (source === "uber_weekly" || type === "uber_weekly") return false;
  return periodSettlement.isSelfDeclaredDebt(data) || type === "admin_debt" || role === "admin" || role === "administrador" ||
    data.registeredByAdmin === true || source === "admin_debt_menu";
}

function debtImpactsSettlement(data = {}) {
  if (!isAdminSettlementDebt(data)) return false;
  return data.driverConfirmationRequired !== true || data.acknowledgedByDriver === true;
}

function debtRemainingAmount(data = {}) {
  const status = safeText(data.status || data.debtStatus || data.estado).toLowerCase();
  if (/paid|pagad|closed|cerrad|cancel|anulad|deleted|eliminad/.test(status)) return 0;
  const remaining = moneyNumber(data.remainingAmount ?? data.saldoPendiente ?? data.amount ?? data.totalAmount ?? 0);
  return Math.max(0, remaining);
}

function calculateOpenBillingBalance(input = {}) {
  return periodSettlement.calculate(input);
}

function teamIsReimbursementCompensation(data = {}) {
  const type = safeText(data.type || data.operationType || data.movementType).toLowerCase();
  return type === "reimbursement_compensation" || type === "debt_compensation";
}

function teamExpenseUsesAutomaticBilling50(data = {}) {
  if (data.receiptFlowVersion === expensePolicy.version) return true;
  if (data.autoApplyToBilling === true || data.gastoAuto50 === true) return true;
  if (safeText(data.billingImpactMode).toLowerCase() === "auto_50") return true;
  return Object.prototype.hasOwnProperty.call(data, "telegramSettlementBeforeBalance") ||
    Object.prototype.hasOwnProperty.call(data, "telegramSettlementAfterBalance") ||
    Object.prototype.hasOwnProperty.call(data, "telegramExpenseRecognizedAmount");
}

function teamAutomaticExpenseImpact(expenses = [], cutoffMs = 0) {
  return roundMoney(expenses
    .filter(item => item && !movementIsDeleted(item) && !isSimulated(item))
    .filter(item => rowMs(item) > cutoffMs)
    .filter(teamExpenseUsesAutomaticBilling50)
    .reduce((sum, item) => sum - amountOf(item) * expensePolicy.netDriverRate(item), 0));
}

function latestTeamReimbursementAnchor(records = [], baseline = 0) {
  const anchors = records
    .filter(item => item && !movementIsDeleted(item) && !isSimulated(item))
    .filter(teamIsReimbursementCompensation)
    .map(item => ({
      timestamp:rowMs(item),
      settlementAfter:Number(item.settlementAfter)
    }))
    .filter(item => item.timestamp > baseline && Number.isFinite(item.settlementAfter))
    .sort((a, b) => b.timestamp - a.timestamp);
  if (!anchors.length) return null;
  return {
    timestamp:anchors[0].timestamp,
    balance:Math.abs(anchors[0].settlementAfter) > 0.5 ? anchors[0].settlementAfter : 0
  };
}

function teamSettlementDeltaSince(cutoffMs, records = [], uberWeeks = [], expenses = []) {
  const scopedRecords = records
    .filter(item => item && !movementIsDeleted(item) && !isSimulated(item))
    .filter(item => rowMs(item) > cutoffMs)
    .filter(item => !teamIsReimbursementCompensation(item));

  const cash = scopedRecords
    .filter(item => !billingSettlementDirection(item) && paymentMethodOf(item) === "cash")
    .reduce((sum, item) => sum + amountOf(item), 0);
  const cashboxEligibleCash = scopedRecords
    .filter(item => !billingSettlementDirection(item) && paymentMethodOf(item) === "cash")
    .filter(item => !cashboxIsExcluded(item))
    .reduce((sum, item) => sum + amountOf(item), 0);
  const digital = scopedRecords
    .filter(item => !billingSettlementDirection(item) && ["card", "qr", "transfer", "digital"].includes(paymentMethodOf(item)))
    .reduce((sum, item) => sum + amountOf(item), 0);
  const driverPaid = scopedRecords
    .filter(item => billingSettlementDirection(item) === "driver_to_explora")
    .reduce((sum, item) => sum + Math.max(0, amountOf(item) - moneyNumber(item.advanceRepaymentAmount || 0)), 0);
  const exploraPaid = scopedRecords
    .filter(item => billingSettlementDirection(item) === "explora_to_driver")
    .reduce((sum, item) => sum + amountOf(item), 0);
  const scopedUber = uberWeeks
    .filter(item => item && !movementIsDeleted(item) && !isSimulated(item) && rowMs(item) > cutoffMs)
    .filter(uberImpactsSettlement);
  const uberCash = scopedUber.reduce((sum, item) => sum + uberCashAmount(item), 0);
  const uberTransfer = scopedUber.reduce((sum, item) => sum + uberTransferAmount(item), 0);
  const cashbox = (cashboxEligibleCash + uberCash) * 0.05 + digitalCashboxAmount(scopedRecords);
  const automaticExpenseImpact = teamAutomaticExpenseImpact(expenses, cutoffMs);

  return roundMoney(
    (cash * 0.50) + (uberCash * 0.50 + uberGrossPrincipalDelta(scopedUber)) + cashbox -
    (digital * 0.50) - (uberTransfer * 0.50) -
    automaticExpenseImpact - driverPaid + exploraPaid + grossFlowPrincipalDelta(scopedRecords)
  );
}

// Replica la calculadora central que ve cada chofer en el Main. A diferencia del
// cálculo histórico de Telegram, respeta la base heredada de Santander y las
// fotografías de compensación usadas durante la migración.
function calculateTeamRealtimeSettlementBalance(input = {}) {
  return periodSettlement.calculate(input);
}

module.exports = {
  calculateOpenBillingBalance,
  calculateTeamRealtimeSettlementBalance,
  isDriverBillingSettlementPayment,
  latestBillingCutoffMs,
  latestCashboxResetMs
};
