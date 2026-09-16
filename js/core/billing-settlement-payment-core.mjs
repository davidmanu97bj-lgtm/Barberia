const clean = value => String(value ?? "").trim();
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export const DRIVER_BILLING_PAYMENT_TYPE = "admin_billing_settlement_payment";

export function isDriverBillingSettlementPayment(row = {}) {
  const type = clean(row.type || row.operationType || row.movementType).toLowerCase();
  const source = clean(row.sourceModule || row.category || row.module).toLowerCase();
  return row.affectsBillingSettlement === true ||
    type === DRIVER_BILLING_PAYMENT_TYPE ||
    (type === "driver_payment" && /factur|billing/.test(source));
}

export function driverBillingPaymentAmount(row = {}) {
  if (!isDriverBillingSettlementPayment(row)) return 0;
  const candidates = [
    row.recognizedAmount,
    row.settlementAmount,
    row.amount,
    row.monto,
    row.totalAmount,
    row.paidAmount
  ];
  for (const candidate of candidates) {
    const amount = number(candidate);
    if (amount > 0) return Math.round(amount * 100) / 100;
  }
  return 0;
}

export function applyDriverBillingPayments({ netToDriver = 0, paymentRows = [] } = {}) {
  const netBeforePayments = Math.round(number(netToDriver) * 100) / 100;
  const paymentTotal = Math.round((paymentRows || []).reduce((sum, row) => sum + driverBillingPaymentAmount(row), 0) * 100) / 100;
  const adjustedNetToDriver = Math.round((netBeforePayments + paymentTotal) * 100) / 100;
  return {
    netBeforePayments,
    paymentTotal,
    adjustedNetToDriver,
    amountFromDriver:Math.round(Math.max(0, -adjustedNetToDriver) * 100) / 100,
    amountToDriver:Math.round(Math.max(0, adjustedNetToDriver) * 100) / 100
  };
}

export function previewDriverBillingPayment({ amountFromDriver = 0, amount = 0 } = {}) {
  const currentBalance = Math.max(0, Math.round(number(amountFromDriver) * 100) / 100);
  const paymentAmount = Math.max(0, Math.round(number(amount) * 100) / 100);
  const exceedsBalance = paymentAmount > currentBalance;
  const valid = currentBalance > 0 && paymentAmount > 0 && !exceedsBalance;
  const balanceAfter = valid ? Math.round((currentBalance - paymentAmount) * 100) / 100 : currentBalance;
  return {
    currentBalance,
    amount:paymentAmount,
    balanceAfter,
    exceedsBalance,
    valid,
    resultLabel:balanceAfter > 0
      ? `Chofer debe liquidar a Explora el saldo restante`
      : `Nadie debe liquidar en Facturación`
  };
}
