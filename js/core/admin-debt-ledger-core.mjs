export const ADMIN_DEBT_LEDGER_VERSION = "v4142-debt-transfer-receipt-fix";

const money = value => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed * 100) / 100);
};

const text = value => String(value ?? "").trim();

export function normalizeAdminDebtOperation(value = "debt") {
  return text(value).toLowerCase() === "payment" ? "payment" : "debt";
}

export function normalizeAdminDebtTender(value = "cash") {
  return text(value).toLowerCase() === "transfer" ? "transfer" : "cash";
}

export function adminDebtRowId(row = {}) {
  return text(row.id || row.debtId || row.documentId);
}

export function adminDebtRowDriverUid(row = {}) {
  return text(row.driverUid || row.choferUid || row.driverId || row.choferId || row.uid || row.ownerUid);
}

export function adminDebtRemaining(row = {}) {
  const stored = row.remainingAmount ?? row.saldoPendiente ?? row.remainingBalance ?? row.balance;
  if (stored !== undefined && stored !== null && stored !== "") return money(stored);
  const total = money(row.totalAmount ?? row.originalAmount ?? row.amount ?? row.monto ?? 0);
  const paid = money(row.paidAmount ?? row.amountPaid ?? row.importePagado ?? 0);
  return money(total - paid);
}

export function adminDebtPaid(row = {}) {
  return money(row.paidAmount ?? row.amountPaid ?? row.importePagado ?? 0);
}

export function adminDebtCreatedMs(row = {}) {
  const candidates = [
    row.createdAtMs,
    row.incidentAtMs,
    row.createdAt?.toMillis?.(),
    Number(row.createdAt?.seconds || 0) * 1000,
    Date.parse(row.incidentDate || row.fecha || "")
  ].map(Number).filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

export function isAdminDebtActive(row = {}) {
  const status = text(row.status || row.debtStatus || row.estado).toLowerCase();
  if (/paid|pagad|liquidad|cancel|anulad|closed|cerrad|rejected|rechazad/.test(status)) return false;
  return adminDebtRemaining(row) > 0;
}

export function adminDebtRowsForDriver(rows = [], driverUid = "") {
  const target = text(driverUid);
  return (Array.isArray(rows) ? rows : [])
    .filter(row => adminDebtRowId(row) && adminDebtRowDriverUid(row) === target && isAdminDebtActive(row))
    .sort((a, b) => adminDebtCreatedMs(a) - adminDebtCreatedMs(b));
}

export function adminDebtBalance(rows = [], driverUid = "") {
  return money(adminDebtRowsForDriver(rows, driverUid).reduce((sum, row) => sum + adminDebtRemaining(row), 0));
}

export function previewAdminDebtLedger({ operation = "debt", currentBalance = 0, amount = 0 } = {}) {
  const normalizedOperation = normalizeAdminDebtOperation(operation);
  const balanceBefore = money(currentBalance);
  const movementAmount = money(amount);
  const exceedsBalance = normalizedOperation === "payment" && movementAmount > balanceBefore;
  const valid = movementAmount > 0 && !exceedsBalance && (normalizedOperation === "debt" || balanceBefore > 0);
  const balanceAfter = valid
    ? money(normalizedOperation === "debt" ? balanceBefore + movementAmount : balanceBefore - movementAmount)
    : balanceBefore;
  const direction = balanceAfter > 0 ? "driver_to_explora" : "balanced";
  return Object.freeze({
    operation:normalizedOperation,
    balanceBefore,
    amount:movementAmount,
    balanceAfter,
    valid,
    exceedsBalance,
    direction,
    payerRole:direction === "driver_to_explora" ? "driver" : "balanced",
    payeeRole:direction === "driver_to_explora" ? "explora" : "balanced",
    resultLabel:direction === "driver_to_explora" ? "Chofer paga a Explora" : "Nadie debe liquidar"
  });
}

export function allocateAdminDebtPayment(rows = [], amountInput = 0) {
  const activeRows = (Array.isArray(rows) ? rows : [])
    .filter(row => adminDebtRowId(row) && isAdminDebtActive(row))
    .sort((a, b) => adminDebtCreatedMs(a) - adminDebtCreatedMs(b));
  const previousBalance = money(activeRows.reduce((sum, row) => sum + adminDebtRemaining(row), 0));
  const amount = money(amountInput);
  if (!(amount > 0)) throw new Error("PAYMENT_AMOUNT_REQUIRED");
  if (amount > previousBalance) throw new Error("PAYMENT_EXCEEDS_DEBT");

  let remainingToApply = amount;
  const allocations = [];
  for (const row of activeRows) {
    if (!(remainingToApply > 0)) break;
    const before = adminDebtRemaining(row);
    const applied = Math.min(before, remainingToApply);
    if (!(applied > 0)) continue;
    const after = money(before - applied);
    allocations.push(Object.freeze({
      debtId:adminDebtRowId(row),
      amount:applied,
      previousBalance:before,
      newBalance:after,
      paidAmount:money(adminDebtPaid(row) + applied),
      status:after <= 0.49 ? "paid" : text(row.status || row.debtStatus || "pending") || "pending"
    }));
    remainingToApply = money(remainingToApply - applied);
  }
  if (remainingToApply > 0) throw new Error("PAYMENT_ALLOCATION_INCOMPLETE");
  return Object.freeze({
    amount,
    previousBalance,
    newBalance:money(previousBalance - amount),
    allocations:Object.freeze(allocations)
  });
}
