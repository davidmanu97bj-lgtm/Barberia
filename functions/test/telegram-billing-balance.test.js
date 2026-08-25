"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateOpenBillingBalance } = require("../telegram-billing-balance");

function record(id, amount, paymentMethod, createdAtMs, extra = {}) {
  return { id, amount, paymentMethod, createdAtMs, ...extra };
}

function billingClosure(cutoffAtMs, extra = {}) {
  return {
    closureMode:"on_demand",
    closureKind:"facturacion",
    cutoffAtMs,
    status:"closed",
    autoClosesCashbox:true,
    cashboxClosedWithBilling:true,
    affectsTabs:["chofer", "explora", "caja_chica"],
    ...extra
  };
}

test("un cobro en efectivo suma mitad del cobro + caja chica 5% al saldo del chofer", () => {
  const balance = calculateOpenBillingBalance({
    records: [record("cash-1", 100000, "cash", 1000)]
  });
  assert.equal(balance.cash, 100000);
  assert.equal(balance.digital, 0);
  assert.equal(balance.cashboxTotal, 5000);
  assert.equal(balance.amountFromDriver, 55000);
  assert.equal(balance.amountToDriver, 0);
});

test("un cobro digital compensa la mitad, sin generar caja chica", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-1", 100000, "cash", 1000),
      record("digital-1", 20000, "card", 2000)
    ]
  });
  assert.equal(balance.cashboxTotal, 5000);
  assert.equal(balance.amountFromDriver, 45000);
  assert.equal(balance.amountToDriver, 0);
});

test("cambia a Explora como pagador cuando el digital supera efectivo + caja chica", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-1", 100000, "cash", 1000),
      record("digital-1", 120000, "transfer", 2000)
    ]
  });
  assert.equal(balance.cashboxTotal, 5000);
  assert.equal(balance.amountFromDriver, 0);
  assert.equal(balance.amountToDriver, 5000);
});

test("solo suma facturación y caja chica posteriores al último cierre de facturación", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-before", 100000, "cash", 1000),
      record("digital-after", 20000, "qr", 2000)
    ],
    closures: [billingClosure(1500)]
  });
  assert.equal(balance.cutoffMs, 1500);
  assert.equal(balance.cashboxResetMs, 1500);
  assert.equal(balance.cash, 0);
  assert.equal(balance.digital, 20000);
  assert.equal(balance.cashboxTotal, 0);
  assert.equal(balance.amountToDriver, 10000);
});

test("un cierre rechazado no corta el período", () => {
  const balance = calculateOpenBillingBalance({
    records: [record("cash-1", 100000, "cash", 1000)],
    closures: [{
      closureMode: "rejected_on_demand",
      closureKind: "chofer",
      cutoffAtMs: 1500,
      status: "rejected",
      rejected: true,
      autoClosesCashbox:true
    }]
  });
  assert.equal(balance.cutoffMs, 0);
  assert.equal(balance.cashboxResetMs, 0);
  assert.equal(balance.amountFromDriver, 55000);
});

test("ignora cobros borrados y simulados", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-real", 100000, "cash", 1000),
      record("cash-deleted", 80000, "cash", 2000, { deleted: true }),
      record("digital-sim", 300000, "card", 3000, { isSimulated: true })
    ]
  });
  assert.equal(balance.includedCount, 1);
  assert.equal(balance.cashboxTotal, 5000);
  assert.equal(balance.amountFromDriver, 55000);
});

test("el pago del chofer reduce Facturación sin contarse como cobro ni generar caja chica", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-1", 20000, "cash", 1000),
      record("billing-payment-1", 11000, "transfer", 2000, {
        type:"admin_billing_settlement_payment",
        sourceModule:"facturacion",
        affectsBillingSettlement:true,
        excludeFromBillingGross:true,
        excludeFromCashbox:true
      })
    ]
  });
  assert.equal(balance.cash, 20000);
  assert.equal(balance.digital, 0);
  assert.equal(balance.gross, 20000);
  assert.equal(balance.cashboxTotal, 1000);
  assert.equal(balance.settlementPaymentCount, 1);
  assert.equal(balance.settlementPaymentTotal, 11000);
  assert.equal(balance.netBeforePayments, -11000);
  assert.equal(balance.amountFromDriver, 0);
  assert.equal(balance.amountToDriver, 0);
});

test("un pago de Facturación anterior al corte no afecta el período nuevo", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("old-payment", 10000, "cash", 1000, {
        type:"admin_billing_settlement_payment",
        affectsBillingSettlement:true,
        excludeFromCashbox:true
      }),
      record("new-cash", 20000, "cash", 2000)
    ],
    closures:[billingClosure(1500)]
  });
  assert.equal(balance.settlementPaymentTotal, 0);
  assert.equal(balance.cashboxTotal, 1000);
  assert.equal(balance.amountFromDriver, 11000);
});

test("incluye caja chica de Uber igual que el Home", () => {
  const balance = calculateOpenBillingBalance({
    records:[record("cash-1", 100000, "cash", 1000)],
    uberWeeks:[{
      id:"uber-1",
      driverUid:"driver-1",
      grossAmount:200000,
      cashboxAmount:10000,
      reviewStatus:"pending",
      createdAtMs:1500
    }]
  });
  assert.equal(balance.regularCashboxGenerated, 5000);
  assert.equal(balance.uberCashboxGenerated, 10000);
  assert.equal(balance.cashboxTotal, 15000);
  assert.equal(balance.amountFromDriver, 65000);
});

test("caso Marcelo de las capturas: Telegram debe coincidir con Home en $477.890", () => {
  const balance = calculateOpenBillingBalance({
    records:[
      record("cash-total", 3155400, "cash", 1000),
      record("digital-total", 1754411, "card", 1100),
      record("payment", 400000, "cash", 1200, {
        type:"admin_billing_settlement_payment",
        sourceModule:"facturacion",
        affectsBillingSettlement:true,
        excludeFromBillingGross:true,
        excludeFromCashbox:true
      })
    ],
    uberWeeks:[{
      id:"uber-cashbox",
      grossAmount:392500,
      cashboxAmount:19625,
      reviewStatus:"pending",
      createdAtMs:1150
    }]
  });

  assert.equal(balance.gross, 4909811);
  assert.equal(balance.shareEach, 2454905.5);
  assert.equal(balance.regularCashboxGenerated, 157770);
  assert.equal(balance.uberCashboxGenerated, 19625);
  assert.equal(balance.cashboxTotal, 177395);
  assert.equal(balance.settlementPaymentTotal, 400000);
  assert.equal(balance.amountFromDriver, 477889.5);
  assert.equal(Math.round(balance.amountFromDriver), 477890);
});

test("acepta el método digital genérico usado por Barbería Main", () => {
  const balance = calculateOpenBillingBalance({
    records: [record("digital-generic", 40000, "digital", 1000)]
  });
  assert.equal(balance.cash, 0);
  assert.equal(balance.digital, 40000);
  assert.equal(balance.amountFromDriver, 0);
  assert.equal(balance.amountToDriver, 20000);
});

test("ignora ajustes internos de Explora para no contabilizarlos dos veces", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-real", 100000, "cash", 1000),
      record("admin-adjustment", 55000, "cash", 2000, {
        internalSettlementAdjustment: true,
        excludeFromBillingSettlement: true
      })
    ]
  });
  assert.equal(balance.includedCount, 1);
  assert.equal(balance.cash, 100000);
  assert.equal(balance.cashboxTotal, 5000);
  assert.equal(balance.amountFromDriver, 55000);
});
