import assert from "node:assert/strict";
import {
  normalizeAdminDebtPaymentMethod,
  previewAdminDebtPayment
} from "../js/core/admin-debt-payment-core.mjs";

assert.equal(normalizeAdminDebtPaymentMethod("transfer"), "transfer");
assert.equal(normalizeAdminDebtPaymentMethod("efectivo"), "cash");

assert.deepEqual(
  previewAdminDebtPayment(100000, 40000),
  {
    balanceBefore:100000,
    amount:40000,
    balanceAfter:60000,
    valid:true,
    exceedsBalance:false,
    direction:"driver_to_explora",
    resultLabel:"Chofer sigue debiendo a Explora"
  }
);

assert.deepEqual(
  previewAdminDebtPayment(100000, 100000),
  {
    balanceBefore:100000,
    amount:100000,
    balanceAfter:0,
    valid:true,
    exceedsBalance:false,
    direction:"balanced",
    resultLabel:"Nadie debe liquidar"
  }
);

const excess = previewAdminDebtPayment(100000, 120000);
assert.equal(excess.valid, false);
assert.equal(excess.exceedsBalance, true);
assert.equal(excess.balanceAfter, 100000);

console.log("admin-debt-payment: ok");
