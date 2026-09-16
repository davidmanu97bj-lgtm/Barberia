"use strict";

function safeAmount(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function safeSignedAmount(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function expenseSettlementLine(balance = 0, formatMoney = value => String(value)) {
  const signed = safeSignedAmount(balance);
  if (signed > 0.5) return `Chofer debe liquidar a Explora: ${formatMoney(signed)}`;
  if (signed < -0.5) return `Explora debe liquidar al chofer: ${formatMoney(Math.abs(signed))}`;
  return "Quién paga a quién: cuentas equilibradas";
}

function buildExpenseTelegramAmountLines({
  loadedAmount = 0,
  recognizedAmount = 0,
  settlementAfterBalance = 0,
  formatMoney = value => String(value)
} = {}) {
  return [
    `Gasto total: ${formatMoney(safeAmount(loadedAmount))}`,
    `Explora reconoce (50%): ${formatMoney(safeAmount(recognizedAmount))}`,
    "El 50% ya se aplicó automáticamente a la facturación.",
    expenseSettlementLine(settlementAfterBalance, formatMoney)
  ];
}

module.exports = { buildExpenseTelegramAmountLines, expenseSettlementLine };
