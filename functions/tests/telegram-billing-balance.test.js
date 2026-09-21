"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateOpenBillingBalance,
  calculateTeamRealtimeSettlementBalance
} = require("../telegram-billing-balance");

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

test("Uber semanal separa efectivo y transferencia con un solo comprobante", () => {
  const balance = calculateOpenBillingBalance({
    uberWeeks: [{
      id:"uber-week-split",
      grossAmount:30000,
      totalAmount:30000,
      cashAmount:10000,
      uberCashAmount:10000,
      transferAmount:20000,
      uberTransferAmount:20000,
      cashboxAmount:500,
      reviewStatus:"pending",
      createdAtMs:1000
    }]
  });
  assert.equal(balance.uberGrossTotal, 30000);
  assert.equal(balance.uberCashTotal, 10000);
  assert.equal(balance.uberTransferTotal, 20000);
  assert.equal(balance.uberCashboxGenerated, 500);
  assert.equal(balance.amountFromDriver, 0);
  assert.equal(balance.amountToDriver, 4500);
});

test("Uber en efectivo aplica 50% más caja chica y Uber transferencia aplica 50% digital", () => {
  const cashOnly = calculateTeamRealtimeSettlementBalance({
    uberWeeks: [{ grossAmount:10000, cashAmount:10000, transferAmount:0, reviewStatus:"pending", createdAtMs:1000 }]
  });
  assert.equal(cashOnly.amountFromDriver, 5500);
  assert.equal(cashOnly.amountToDriver, 0);

  const transferOnly = calculateTeamRealtimeSettlementBalance({
    uberWeeks: [{ grossAmount:10000, cashAmount:0, transferAmount:10000, reviewStatus:"pending", createdAtMs:1000 }]
  });
  assert.equal(transferOnly.amountFromDriver, 0);
  assert.equal(transferOnly.amountToDriver, 5000);
});

test("el Uber v82 no modifica saldos hasta que el chofer lo confirma", () => {
  const prepared = {
    grossAmount:30000,
    cashAmount:10000,
    transferAmount:20000,
    cashboxAmount:500,
    settlementWorkflowVersion:"v82_admin_driver_confirmation",
    driverConfirmed:false,
    reviewStatus:"awaiting_driver_confirmation",
    createdAtMs:1000
  };
  const beforeConfirmation = calculateTeamRealtimeSettlementBalance({ uberWeeks:[prepared] });
  assert.equal(beforeConfirmation.balance, 0);

  const afterConfirmation = calculateTeamRealtimeSettlementBalance({
    uberWeeks:[{ ...prepared, driverConfirmed:true, reviewStatus:"approved" }]
  });
  assert.equal(afterConfirmation.balance, -4500);
  assert.equal(afterConfirmation.amountToDriver, 4500);
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

test("un cierre de facturación no reinicia los acumulados", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("cash-before", 100000, "cash", 1000),
      record("digital-after", 20000, "qr", 2000)
    ],
    closures: [billingClosure(1500)]
  });
  assert.equal(balance.cutoffMs, 0);
  assert.equal(balance.cashboxResetMs, 0);
  assert.equal(balance.cash, 100000);
  assert.equal(balance.digital, 20000);
  assert.equal(balance.cashboxTotal, 5000);
  assert.equal(balance.amountFromDriver, 45000);
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

test("un pago de Facturación anterior sigue compensando sin borrar el histórico", () => {
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
  assert.equal(balance.settlementPaymentTotal, 10000);
  assert.equal(balance.cashboxTotal, 1000);
  assert.equal(balance.amountFromDriver, 1000);
});

test("un pago de Explora al chofer también equilibra sin reiniciar facturación", () => {
  const balance = calculateOpenBillingBalance({
    records: [
      record("digital-1", 100000, "digital", 1000),
      record("explora-payment", 50000, "cash", 2000, {
        type:"settlement_adjustment",
        adjustmentDirection:"explora_to_driver",
        internalSettlementAdjustment:true,
        excludeFromBillingSettlement:true
      })
    ]
  });
  assert.equal(balance.digital, 100000);
  assert.equal(balance.exploraSettlementTotal, 50000);
  assert.equal(balance.amountFromDriver, 0);
  assert.equal(balance.amountToDriver, 0);
});

test("Uber suma su mitad y la caja chica 5% igual que el Home", () => {
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
  assert.equal(balance.uberGrossTotal, 200000);
  assert.equal(balance.cashboxTotal, 15000);
  assert.equal(balance.amountFromDriver, 165000);
});

test("caso Marcelo: Telegram incluye Uber completo y coincide con la calculadora central", () => {
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

  assert.equal(balance.gross, 5302311);
  assert.equal(balance.shareEach, 2651155.5);
  assert.equal(balance.regularCashboxGenerated, 157770);
  assert.equal(balance.uberCashboxGenerated, 19625);
  assert.equal(balance.cashboxTotal, 177395);
  assert.equal(balance.settlementPaymentTotal, 400000);
  assert.equal(balance.amountFromDriver, 674139.5);
  assert.equal(Math.round(balance.amountFromDriver), 674140);
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


test("un gasto reconocido al 50% afecta automáticamente quién paga a quién", () => {
  const balance = calculateOpenBillingBalance({
    records: [record("cash-1", 100000, "cash", 1000)],
    expenses: [{ id:"expense-1", amount:40000, createdAtMs:1500 }]
  });
  assert.equal(balance.expenseTotal, 40000);
  assert.equal(balance.expenseShare, 20000);
  assert.equal(balance.amountFromDriver, 35000);
  assert.equal(balance.amountToDriver, 0);
});

test("el 50% de un gasto puede convertir el saldo en pago de Explora al chofer", () => {
  const balance = calculateOpenBillingBalance({
    records: [record("cash-1", 20000, "cash", 1000)],
    expenses: [{ id:"expense-1", amount:40000, createdAtMs:1500 }]
  });
  assert.equal(balance.amountFromDriver, 0);
  assert.equal(balance.amountToDriver, 9000);
});

test("una deuda agregada por Explora incrementa quién paga a quién al 100%", () => {
  const balance = calculateOpenBillingBalance({
    records: [record("digital-1", 40000, "digital", 1000)],
    debts: [{
      id:"debt-1",
      type:"admin_debt",
      createdByRole:"admin",
      amount:50000,
      remainingAmount:50000,
      status:"active",
      createdAtMs:1500
    }]
  });
  assert.equal(balance.adminDebtTotal, 50000);
  assert.equal(balance.amountFromDriver, 30000);
  assert.equal(balance.amountToDriver, 0);
});

test("una deuda pagada usa solo el saldo restante y no duplica deudas antiguas de Uber", () => {
  const balance = calculateOpenBillingBalance({
    debts: [
      {
        id:"debt-admin",
        type:"admin_debt",
        createdByRole:"admin",
        amount:100000,
        remainingAmount:25000,
        status:"active"
      },
      {
        id:"debt-uber",
        type:"uber_weekly",
        sourceModule:"uber_weekly",
        amount:80000,
        remainingAmount:80000,
        status:"active"
      }
    ]
  });
  assert.equal(balance.adminDebtTotal, 25000);
  assert.equal(balance.amountFromDriver, 25000);
});

test("Tiempo real replica efectivo, digital y el gasto automático del Main", () => {
  const balance = calculateTeamRealtimeSettlementBalance({
    records: [
      record("cash", 100000, "cash", 1000),
      record("digital", 20000, "digital", 1100)
    ],
    expenses: [{
      id:"expense",
      amount:40000,
      createdAtMs:1200,
      autoApplyToBilling:true,
      billingImpactMode:"auto_50"
    }]
  });
  assert.equal(balance.balance, 25000);
  assert.equal(balance.amountFromDriver, 25000);
  assert.equal(balance.amountToDriver, 0);
  assert.equal(balance.direction, "driver_to_explora");
});

test("Tiempo real respeta la base histórica heredada de Santander", () => {
  const balance = calculateTeamRealtimeSettlementBalance({
    records: [
      record("old-cash", 100000, "cash", 1000),
      record("new-cash", 20000, "cash", 2000)
    ],
    closures:[billingClosure(1500)]
  });
  assert.equal(balance.baseline, 1500);
  assert.equal(balance.balance, 11000);
  assert.equal(balance.amountFromDriver, 11000);
});

test("Tiempo real continúa desde la última fotografía de compensación", () => {
  const balance = calculateTeamRealtimeSettlementBalance({
    records: [
      record("anchor", 5000, "cash", 2000, {
        type:"debt_compensation",
        settlementAfter:10000
      }),
      record("cash-after", 20000, "cash", 3000)
    ]
  });
  assert.equal(balance.balance, 21000);
  assert.equal(balance.amountFromDriver, 21000);
});
