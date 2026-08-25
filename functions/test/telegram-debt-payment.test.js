"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  adminDebtPaymentAmounts,
  buildAdminDebtPaymentTelegramText,
  isAdminDebtPayment
} = require("../telegram-debt-payment");

const money = value => `$${Number(value).toLocaleString("es-AR")}`;
const date = () => "20/8/2026, 14:30";

test("identifica solo una entrega de deuda registrada por administrador", () => {
  assert.equal(isAdminDebtPayment({ registeredByAdmin:true }), true);
  assert.equal(isAdminDebtPayment({ debtReductionMethod:"admin_payment" }), true);
  assert.equal(isAdminDebtPayment({ createdByRole:"driver" }), false);
});

test("conserva deuda anterior, reducción y deuda actual exactas", () => {
  assert.deepEqual(
    adminDebtPaymentAmounts({ amount:40000, previousBalance:100000, newBalance:60000 }),
    { reduction:40000, previousBalance:100000, currentBalance:60000 }
  );
});

test("arma el aviso de reducción parcial en efectivo", () => {
  const message = buildAdminDebtPaymentTelegramText({
    driverName:"Juan Pérez",
    paymentMethod:"cash",
    amount:40000,
    previousBalance:100000,
    newBalance:60000,
    reason:"Entrega parcial",
    createdByName:"David"
  }, { formatMoney:money, formatDate:date });

  assert.match(message, /Chofer: Juan Pérez/);
  assert.match(message, /Medio: Efectivo/);
  assert.match(message, /Motivo: Entrega parcial/);
  assert.match(message, /Deuda anterior: \$100\.000/);
  assert.match(message, /Reducción aplicada: \$40\.000/);
  assert.match(message, /Deuda actual: \$60\.000/);
  assert.match(message, /Chofer todavía debe a Explora \$60\.000/);
});

test("informa deuda saldada y transferencia", () => {
  const message = buildAdminDebtPaymentTelegramText({
    driverName:"Ana",
    paymentMethod:"transfer",
    amount:100000,
    previousBalance:100000,
    newBalance:0
  }, { formatMoney:money, formatDate:date });

  assert.match(message, /Medio: Transferencia/);
  assert.match(message, /Deuda actual: \$0/);
  assert.match(message, /Deuda saldada: nadie debe liquidar por esta deuda/);
});
