import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateSettlement,
  impactForCharge,
  modelForPeriod,
  openCharges
} from "../barberia-core.mjs";

test("efectivo: 5% publicidad, 47,5/47,5 y el barbero entrega 52,5%", () => {
  const model = calculateSettlement({ cashTotal: 10000, digitalTotal: 0 });
  assert.equal(model.advertisingFund, 500);
  assert.equal(model.advertisingCashReceipt, 500);
  assert.equal(model.advertisingDigitalReceipt, 0);
  assert.equal(model.barberShare, 4750);
  assert.equal(model.businessShare, 4750);
  assert.equal(model.balance, 5250);
  assert.equal(model.direction, "barber_pays_business");
});

test("digital: la barbería conserva publicidad y entrega 47,5% al barbero", () => {
  const model = calculateSettlement({ cashTotal: 0, digitalTotal: 10000 });
  assert.equal(model.advertisingFund, 500);
  assert.equal(model.advertisingCashReceipt, 0);
  assert.equal(model.advertisingDigitalReceipt, 500);
  assert.equal(model.barberShare, 4750);
  assert.equal(model.businessShare, 4750);
  assert.equal(model.balance, -4750);
  assert.equal(model.direction, "business_pays_barber");
});

test("saldo neto respeta dónde está físicamente cada medio", () => {
  const model = calculateSettlement({ cashTotal: 10000, digitalTotal: 10000 });
  assert.equal(model.total, 20000);
  assert.equal(model.advertisingFund, 1000);
  assert.equal(model.balance, 500);
  assert.equal(impactForCharge("cash", 10000), 5250);
  assert.equal(impactForCharge("digital", 10000), -4750);
});

test("pedir cierre corta el período y vuelve los totales a cero", () => {
  const charges = [
    { id: "old", amount: 10000, method: "cash", createdAtMs: 1000 },
    { id: "new", amount: 12000, method: "digital", createdAtMs: 3000 }
  ];
  const closures = [{ id: "cierre", cutoffAtMs: 2000, status: "pending", cutoffActive: true }];
  assert.deepEqual(openCharges(charges, closures).map(item => item.id), ["new"]);
  const model = modelForPeriod(charges, closures);
  assert.equal(model.cash, 0);
  assert.equal(model.digital, 12000);
  assert.equal(model.balance, -5700);
});
