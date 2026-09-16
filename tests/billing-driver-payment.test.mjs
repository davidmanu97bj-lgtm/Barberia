import assert from "node:assert/strict";
import {
  applyDriverBillingPayments,
  driverBillingPaymentAmount,
  isDriverBillingSettlementPayment,
  previewDriverBillingPayment
} from "../js/core/billing-settlement-payment-core.mjs";

const payment = {
  type:"admin_billing_settlement_payment",
  sourceModule:"facturacion",
  affectsBillingSettlement:true,
  amount:10000,
  paymentMethod:"transfer",
  affectsDriverDebt:false,
  excludeFromBillingGross:true,
  excludeFromCashbox:true
};

assert.equal(isDriverBillingSettlementPayment(payment), true);
assert.equal(isDriverBillingSettlementPayment({ type:"service", amount:10000 }), false);
assert.equal(driverBillingPaymentAmount(payment), 10000);

assert.deepEqual(
  applyDriverBillingPayments({ netToDriver:-10000, paymentRows:[payment] }),
  {
    netBeforePayments:-10000,
    paymentTotal:10000,
    adjustedNetToDriver:0,
    amountFromDriver:0,
    amountToDriver:0
  }
);

assert.deepEqual(
  previewDriverBillingPayment({ amountFromDriver:10000, amount:10000 }),
  {
    currentBalance:10000,
    amount:10000,
    balanceAfter:0,
    exceedsBalance:false,
    valid:true,
    resultLabel:"Nadie debe liquidar en Facturación"
  }
);

const partial = previewDriverBillingPayment({ amountFromDriver:10000, amount:4000 });
assert.equal(partial.balanceAfter, 6000);
assert.equal(partial.valid, true);

const excess = previewDriverBillingPayment({ amountFromDriver:10000, amount:11000 });
assert.equal(excess.balanceAfter, 10000);
assert.equal(excess.valid, false);
assert.equal(excess.exceedsBalance, true);

console.log("billing-driver-payment: ok");
