import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = relative => readFile(new URL(relative, root), "utf8");

const [debtMenu, payHome, telegramFunctions, storageRules] = await Promise.all([
  read("js/segments/15-script.mjs"),
  read("js/segments/52-script.mjs"),
  read("functions/index.js"),
  read("storage.rules")
]);

// Contratos del código segmentado conservado; la entrada publicada se prueba en frontend-runtime.test.mjs.

const start = debtMenu.indexOf("async function openDebt(options={})");
const end = debtMenu.indexOf("function setDebtReason", start);
const markup = debtMenu.slice(start, end);
assert.ok(start >= 0 && end > start, "No se encontró el nuevo formulario de deuda");
assert.match(markup, /DEUDA DEL CHOFER/);
assert.match(markup, /PAGO DEL CHOFER/);
assert.match(markup, /EFECTIVO O TRANSFERENCIA/);
assert.match(markup, /AGREGAR COMPROBANTE/);
assert.match(markup, /id="driverDebtReceiptInput"/);
assert.match(markup, /accept="image\/jpeg,image\/png,image\/webp,application\/pdf"/);
assert.doesNotMatch(markup, /VEHÍCULO RELACIONADO/);
assert.doesNotMatch(markup, /data-debt-reason/);
assert.doesNotMatch(markup, /REGISTROS EXISTENTES/);

assert.match(debtMenu, /#adminDebtPaymentMethodField button\[data-debt-payment-method\]/);
assert.match(debtMenu, /\.admin-debt-operation-picker button\[data-debt-operation\]/);
assert.doesNotMatch(debtMenu, /const operation=event\.target\.closest\?\.\("\[data-debt-operation\]"\)/);
assert.match(debtMenu, /input\.showPicker\(\)/);
assert.match(debtMenu, /billing_receipts\/\$\{driverUid\}\/pagos-chofer\/\$\{paymentId\}\/pago-chofer\.\{extension\}/);
assert.doesNotMatch(debtMenu, /destinationPath:`facturacion\//);
assert.match(storageRules, /match \/billing_receipts\/\{ownerUid\}\/\{allPaths=\*\*\}/);

const paymentStart = debtMenu.indexOf("async function submitDriverDebtPayment");
const paymentEnd = debtMenu.indexOf("async function submitDriverDebt(event)", paymentStart);
const paymentFlow = debtMenu.slice(paymentStart, paymentEnd);
assert.ok(paymentStart >= 0 && paymentEnd > paymentStart, "No se encontró el flujo Pago del chofer");
assert.match(paymentFlow, /"billing_records"/);
assert.match(paymentFlow, /type:"admin_billing_settlement_payment"/);
assert.match(paymentFlow, /affectsBillingSettlement:true/);
assert.match(paymentFlow, /affectsDriverDebt:false/);
assert.match(paymentFlow, /excludeFromBillingGross:true/);
assert.match(paymentFlow, /excludeFromCashbox:true/);
assert.doesNotMatch(paymentFlow, /"deudas_choferes"/);
assert.doesNotMatch(paymentFlow, /"deuda_pagos"/);
assert.doesNotMatch(paymentFlow, /"deuda_movimientos"/);
assert.doesNotMatch(paymentFlow, /runTransaction/);
assert.match(debtMenu, /Reduce el saldo de Facturación/);
assert.match(debtMenu, /Las deudas se mantienen sin cambios/);
assert.match(payHome, /const billingSettlementPayments = openBillingRows\.filter\(isDriverBillingSettlementPayment\)/);
assert.match(payHome, /const billingRecords = openBillingRows\.filter\(row => !isDriverBillingSettlementPayment\(row\)\)/);
assert.match(payHome, /applyDriverBillingPayments/);
assert.match(payHome, /getDriverBillingBalance/);
assert.match(payHome, /!isDriverBillingSettlementPayment\(row\) && historyInRange/);

assert.match(telegramFunctions, /notifyAdminDebtPaymentTelegramV1/);
assert.match(telegramFunctions, /notifyAdminDriverDebtTelegramV1/);

console.log("admin-debt-menu-release: ok");
