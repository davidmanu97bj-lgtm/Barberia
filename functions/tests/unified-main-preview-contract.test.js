"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.resolve(__dirname, "../../app.js"), "utf8");
const htmlSource = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");

test("el Main usa una sola tarjeta de facturación y una lista unificada", () => {
  assert.match(htmlSource, /id="settlementDirection"/);
  assert.match(htmlSource, /id="settlementTotal"/);
  assert.match(htmlSource, /id="receiptList"/);
  assert.doesNotMatch(htmlSource, /id="cashWalletStatus"/);
  assert.doesNotMatch(htmlSource, /id="digitalWalletStatus"/);
  assert.doesNotMatch(htmlSource, /<span>Explora<\/span>/);
});

test("se conserva el detalle histórico de caja chica 5%, solo para registros antiguos", () => {
  assert.match(appSource, /type: "cashbox_receipt"/);
  assert.match(appSource, /amount: Number\(item\.amount \|\| 0\) \* 0\.05/);
  assert.match(appSource, /service: "Caja chica 5%"/);
});

test("cobro y gasto guardan con bloqueo sin depender de una vista previa o abrir otra confirmación", () => {
  assert.doesNotMatch(appSource, /openOperationPreview\(\{ kind:(?:mode|"expense"), amount, formId:/);
  assert.match(appSource, /acquireSubmissionLock\(lock,false\)/);
  assert.match(appSource, /releaseSubmissionLock\(lock\)/);
  assert.match(appSource, /controls\.forEach/);
  assert.match(appSource, /applyOperationalAck\(response\)/);
});

test("la vista previa usa las reglas de efectivo, digital y gasto", () => {
  const { previewDefinition, uberSettlementDelta, uberDriverSubmissionDelta } = require('../../tests/support/frontend-functions.cjs')();
  assert.equal(previewDefinition('cash', 10000).delta, 5500);
  assert.equal(previewDefinition('digital', 10000).delta, -4500);
  assert.equal(previewDefinition('expense', 10000).delta, -5000);
  assert.equal(previewDefinition('cash', -100).delta, 0);
  assert.equal(uberSettlementDelta(10000, 20000), -4500);
  assert.equal(uberSettlementDelta(-100, 10000), -5000);
  assert.equal(uberDriverSubmissionDelta(10000), 10500);
  assert.equal(uberDriverSubmissionDelta(10000, {}), 5500);
});
