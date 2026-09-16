export const ADMIN_DEBT_PAYMENT_VERSION = "v4142-debt-transfer-receipt-fix";

const money = value => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed * 100) / 100);
};

export function normalizeAdminDebtPaymentMethod(value = "cash") {
  return String(value || "").trim().toLowerCase() === "transfer" ? "transfer" : "cash";
}

export function previewAdminDebtPayment(balanceInput = 0, amountInput = 0) {
  const balanceBefore = money(balanceInput);
  const amount = money(amountInput);
  const valid = balanceBefore > 0 && amount > 0 && amount <= balanceBefore;
  const balanceAfter = valid ? money(balanceBefore - amount) : balanceBefore;
  return Object.freeze({
    balanceBefore,
    amount,
    balanceAfter,
    valid,
    exceedsBalance:amount > balanceBefore,
    direction:balanceAfter > 0 ? "driver_to_explora" : "balanced",
    resultLabel:balanceAfter > 0 ? "Chofer sigue debiendo a Explora" : "Nadie debe liquidar"
  });
}
