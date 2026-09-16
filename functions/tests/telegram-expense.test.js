"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildExpenseTelegramAmountLines } = require("../telegram-expense");

test("informa gasto, 50% reconocido y quién debe liquidar después del gasto", () => {
  const lines = buildExpenseTelegramAmountLines({
    loadedAmount: 40000,
    recognizedAmount: 20000,
    settlementAfterBalance: 42498,
    formatMoney: value => `$ ${value}`
  });

  assert.deepEqual(lines, [
    "Gasto total: $ 40000",
    "Explora reconoce (50%): $ 20000",
    "El 50% ya se aplicó automáticamente a la facturación.",
    "Chofer debe liquidar a Explora: $ 42498"
  ]);
});

test("informa a Explora como pagador cuando el gasto deja saldo a favor del chofer", () => {
  const lines = buildExpenseTelegramAmountLines({
    loadedAmount: 40000,
    recognizedAmount: 20000,
    settlementAfterBalance: -12500,
    formatMoney: value => `$ ${value}`
  });

  assert.match(lines.at(-1), /Explora debe liquidar al chofer: \$ 12500/);
});

test("normaliza importes inválidos o negativos a cero", () => {
  const lines = buildExpenseTelegramAmountLines({
    loadedAmount: "sin monto",
    recognizedAmount: -500,
    settlementAfterBalance: 0,
    formatMoney: value => String(value)
  });

  assert.deepEqual(lines, [
    "Gasto total: 0",
    "Explora reconoce (50%): 0",
    "El 50% ya se aplicó automáticamente a la facturación.",
    "Quién paga a quién: cuentas equilibradas"
  ]);
});
