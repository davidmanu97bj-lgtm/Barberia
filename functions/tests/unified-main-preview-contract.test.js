"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.resolve(__dirname, "../../app.js"), "utf8");
const htmlSource = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");

test("Principal institucional y Billeteras conservan una lista unificada", () => {
  assert.match(htmlSource, /id="settlementDirection"/);
  assert.match(htmlSource, /id="settlementTotal"/);
  assert.match(htmlSource, /id="receiptList"/);
  assert.doesNotMatch(htmlSource, /id="cashWalletStatus"/);
  assert.doesNotMatch(htmlSource, /id="digitalWalletStatus"/);
  assert.doesNotMatch(htmlSource, /<span>Explora<\/span>/);
});

test("efectivo genera comprobante y caja chica según su versión", () => {
  assert.match(appSource, /type: "cashbox_receipt"/);
  assert.match(appSource, /item.settlementRuleVersion === "net_wallets_cashbox_10_v1"/);
  assert.match(appSource, /Caja chica/);
});

test("cobro y gasto guardan con bloqueo sin abrir una segunda confirmación", () => {
  const chargePreview = appSource.indexOf('openOperationPreview({ kind:mode, amount, formId:"chargeForm" })');
  const chargeWrite = appSource.indexOf('acquireSubmissionLock("charge")');
  const expensePreview = appSource.indexOf('openOperationPreview({ kind:"expense", amount, formId:"expenseForm" })');
  const expenseWrite = appSource.indexOf('acquireSubmissionLock("expense")');
  assert.equal(chargePreview, -1);
  assert.ok(chargeWrite > -1);
  assert.equal(expensePreview, -1);
  assert.ok(expenseWrite > -1);
});

test("la vista previa usa las reglas de efectivo, digital y gasto", () => {
  const { previewDefinition, uberSettlementDelta, uberDriverSubmissionDelta } = require('../../tests/support/frontend-functions.cjs')();
  assert.equal(previewDefinition('cash', 10000).delta, 6000);
  assert.equal(previewDefinition('digital', 10000).delta, -4000);
  assert.equal(previewDefinition('expense', 10000).delta, -5000);
  assert.equal(previewDefinition('cash', -100).delta, 0);
  assert.equal(uberSettlementDelta(10000, 20000), -4500);
  assert.equal(uberSettlementDelta(-100, 10000), -5000);
  assert.equal(uberDriverSubmissionDelta(10000), 10500);
  assert.equal(uberDriverSubmissionDelta(10000, {}), 5500);
});
