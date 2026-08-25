"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  adminDriverDebtAmounts,
  buildAdminDriverDebtTelegramText,
  isAdminDriverDebt
} = require("../telegram-driver-debt");

const money = value => `$${Number(value).toLocaleString("es-AR")}`;
const date = () => "20/8/2026, 15:30";

test("identifica una deuda cargada por administrador", () => {
  assert.equal(isAdminDriverDebt({ registeredByAdmin:true, totalAmount:50000 }), true);
  assert.equal(isAdminDriverDebt({ createdByRole:"driver", totalAmount:50000 }), false);
  assert.equal(isAdminDriverDebt({ registeredByAdmin:true, totalAmount:0 }), false);
});

test("conserva deuda anterior, importe agregado y deuda actual", () => {
  assert.deepEqual(adminDriverDebtAmounts({
    totalAmount:50000,
    driverDebtBalanceBefore:100000,
    driverDebtBalanceAfter:150000
  }), { amount:50000, previousBalance:100000, currentBalance:150000 });
});

test("arma el aviso con responsabilidad completa del chofer", () => {
  const message = buildAdminDriverDebtTelegramText({
    driverName:"Daniela",
    description:"Daño del vehículo",
    totalAmount:50000,
    driverDebtBalanceBefore:100000,
    driverDebtBalanceAfter:150000,
    createdByName:"David"
  }, { formatMoney:money, formatDate:date });

  assert.match(message, /DEUDA DEL CHOFER REGISTRADA/);
  assert.match(message, /Chofer: Daniela/);
  assert.match(message, /Motivo: Daño del vehículo/);
  assert.match(message, /Importe agregado: \$50\.000/);
  assert.match(message, /Deuda actual: \$150\.000/);
  assert.match(message, /Chofer paga a Explora el 100 %/);
});
