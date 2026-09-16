import assert from "node:assert/strict";
import {
  adminDebtBalance,
  allocateAdminDebtPayment,
  normalizeAdminDebtOperation,
  normalizeAdminDebtTender,
  previewAdminDebtLedger
} from "../js/core/admin-debt-ledger-core.mjs";

const rows = [
  { id:"oldest", driverUid:"driver-1", totalAmount:70000, remainingAmount:70000, paidAmount:0, status:"pending", createdAtMs:100 },
  { id:"newest", driverUid:"driver-1", totalAmount:50000, remainingAmount:50000, paidAmount:0, status:"pending", createdAtMs:200 },
  { id:"other-driver", driverUid:"driver-2", totalAmount:90000, remainingAmount:90000, status:"pending", createdAtMs:50 }
];

assert.equal(normalizeAdminDebtOperation("payment"), "payment");
assert.equal(normalizeAdminDebtOperation("anything"), "debt");
assert.equal(normalizeAdminDebtTender("transfer"), "transfer");
assert.equal(normalizeAdminDebtTender("efectivo"), "cash");
assert.equal(adminDebtBalance(rows, "driver-1"), 120000);

assert.deepEqual(
  previewAdminDebtLedger({ operation:"debt", currentBalance:120000, amount:30000 }),
  {
    operation:"debt",
    balanceBefore:120000,
    amount:30000,
    balanceAfter:150000,
    valid:true,
    exceedsBalance:false,
    direction:"driver_to_explora",
    payerRole:"driver",
    payeeRole:"explora",
    resultLabel:"Chofer paga a Explora"
  }
);

assert.deepEqual(
  previewAdminDebtLedger({ operation:"payment", currentBalance:120000, amount:120000 }),
  {
    operation:"payment",
    balanceBefore:120000,
    amount:120000,
    balanceAfter:0,
    valid:true,
    exceedsBalance:false,
    direction:"balanced",
    payerRole:"balanced",
    payeeRole:"balanced",
    resultLabel:"Nadie debe liquidar"
  }
);

const plan = allocateAdminDebtPayment(rows.filter(row => row.driverUid === "driver-1"), 100000);
assert.equal(plan.previousBalance, 120000);
assert.equal(plan.newBalance, 20000);
assert.deepEqual(plan.allocations.map(item => ({ id:item.debtId, amount:item.amount, balance:item.newBalance })), [
  { id:"oldest", amount:70000, balance:0 },
  { id:"newest", amount:30000, balance:20000 }
]);

assert.throws(
  () => allocateAdminDebtPayment(rows.filter(row => row.driverUid === "driver-1"), 120001),
  /PAYMENT_EXCEEDS_DEBT/
);

console.log("admin-debt-ledger: ok");
