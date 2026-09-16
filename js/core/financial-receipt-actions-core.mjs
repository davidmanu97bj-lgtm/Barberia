export const FINANCIAL_RECEIPT_ACTIONS_VERSION = "v4145-activity-receipt-actions";

const text = value => String(value ?? "").trim();
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const rawOf = receipt => receipt?.raw && typeof receipt.raw === "object" ? receipt.raw : (receipt || {});

export function isBillingSettlementPayment(receipt = {}) {
  const raw = rawOf(receipt);
  const type = text(raw.type || raw.operationType || raw.movementType).toLowerCase();
  const source = text(raw.sourceModule || raw.category || raw.module).toLowerCase();
  return raw.affectsBillingSettlement === true ||
    type === "admin_billing_settlement_payment" ||
    (type === "driver_payment" && /factur|billing/.test(source));
}

export function financialReceiptKind(receipt = {}) {
  const raw = rawOf(receipt);
  const sourceCollection = text(raw.sourceCollection).toLowerCase();
  const relatedCollection = text(raw.relatedCollection).toLowerCase();
  const tokens = [
    receipt.category, receipt.categoryLabel, raw.category, raw.type, raw.receiptCategory,
    raw.module, raw.moduleKey, raw.sourceModule, raw.financialCategory, raw.expenseType,
    raw.tipo, raw.relatedCollection
  ].map(value => text(value).toLowerCase()).join(" ");
  const method = text(raw.paymentMethod || raw.metodoPago || raw.receiptPaymentMethod || raw.method).toLowerCase();

  if (sourceCollection === "gastos" || relatedCollection === "gastos") return "gasto";
  if (/(?:^|[_\s-])(?:debt|deuda|deudas|multa|multas|choque|choques)(?:$|[_\s-])/.test(tokens)) return "";
  if (/(^|\s)(expense|gasto|gastos)(\s|$)/.test(tokens)) return "gasto";

  const closureLike = /cierre|closure|caja[_\s-]*chica|cashbox|petty/.test(tokens) &&
    sourceCollection !== "billing_records" && relatedCollection !== "billing_records";
  if (closureLike) return "";

  if (sourceCollection === "billing_records" || relatedCollection === "billing_records") return "cobro";
  if (/(^|\s)(payment|billing|cobro|facturacion|facturación)(\s|$)/.test(tokens)) return "cobro";
  if (/cash|efectivo|qr|card|tarjeta|transfer|alias/.test(method)) return "cobro";
  return "";
}

export function financialReceiptDocumentId(receipt = {}) {
  const raw = rawOf(receipt);
  const kind = financialReceiptKind(receipt);
  const sourceCollection = text(raw.sourceCollection).toLowerCase();
  const direct = text(
    raw.relatedDocumentId || raw.recordId || raw.billingRecordId || raw.billingId ||
    raw.expenseId || raw.gastoId || raw.operationId || receipt.recordId ||
    receipt.billingRecordId || receipt.billingId || receipt.expenseId || receipt.operationId
  );
  if (direct) return direct;
  const sourceId = text(raw.id);
  if (!sourceId) return "";
  if (sourceCollection === "billing_records" || sourceCollection === "gastos") return sourceId;
  if (sourceCollection === "receipt_index") {
    const prefix = kind === "gasto" ? /^(?:expense|gasto)_/i : /^(?:payment|billing)_/i;
    return sourceId.replace(prefix, "");
  }
  return "";
}

export function expenseParts(receipt = {}, amountOverride = null) {
  const raw = rawOf(receipt);
  const amount = Math.max(0, number(amountOverride ?? raw.amount ?? raw.monto ?? raw.valor ?? raw.totalAmount));
  const configuredRate = Number(raw.sharedRate ?? raw.porcentajeCompartido ?? raw.driverShareRate ?? raw.porcentajeChofer);
  const driverRate = Number.isFinite(configuredRate)
    ? Math.min(1, Math.max(0, configuredRate > 1 ? configuredRate / 100 : configuredRate))
    : .5;
  const driverPart = amount * driverRate;
  return { amount, driverRate, driverPart, exploraPart:Math.max(0, amount - driverPart) };
}

export function expenseAmountCorrectionPatch({ closure = {}, movement = {}, documentId = "", previousAmount = 0, newAmount = 0 } = {}) {
  const id = text(documentId);
  const included = Array.isArray(closure.includedExpenseIds) && closure.includedExpenseIds.map(text).includes(id);
  if (!id || !included) return null;

  const previous = expenseParts(movement, previousAmount);
  const next = expenseParts(movement, newAmount);
  const delta = next.amount - previous.amount;
  if (!delta) return null;

  const total = Math.max(0, number(closure.expenseTotal ?? closure.mainTotal) + delta);
  const driverShare = Math.max(0, number(closure.driverExpenseShare) + next.driverPart - previous.driverPart);
  const exploraShare = Math.max(0, number(closure.exploraExpenseShare ?? closure.expenseAmountToDriverBeforeDebt ?? closure.amountDueToDriver) + next.exploraPart - previous.exploraPart);
  const previousDebtOffset = Math.max(0, number(closure.expenseDebtOffsetApplied));
  const debtOffset = Math.min(exploraShare, previousDebtOffset);
  const amountToDriver = Math.max(0, exploraShare - debtOffset);

  return {
    expenseTotal:total,
    mainTotal:total,
    driverExpenseShare:driverShare,
    exploraExpenseShare:exploraShare,
    expenseAmountToDriverBeforeDebt:exploraShare,
    expenseDebtOffsetApplied:debtOffset,
    expenseAmountToDriverAfterDebt:amountToDriver,
    amountDueFromDriver:0,
    amountFromDriver:0,
    amountDueToDriver:amountToDriver,
    amountToDriver,
    netSettlementToDriver:amountToDriver
  };
}
