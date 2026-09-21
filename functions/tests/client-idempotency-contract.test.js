const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../..");
const appSource = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
const functionsSource = fs.readFileSync(path.join(projectRoot, "functions/index.js"), "utf8");

function sourceSection(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `No se encontró ${startMarker}`);
  assert.notEqual(end, -1, `No se encontró ${endMarker}`);
  return appSource.slice(start, end);
}

test("los cobros reutilizan un documento determinístico y verifican si ya existe", () => {
  const section = sourceSection(
    '$("chargeForm")?.addEventListener("submit"',
    '$("addExpenseBtn")?.addEventListener("click"'
  );
  assert.match(section, /reservePendingOperation\("payment"/);
  assert.match(section, /doc\(db, ROOT_COLLECTIONS\.payments, operation\.operationId\)/);
  assert.match(section, /transaction\.get\(paymentRef\)/);
  assert.match(section, /assertSameCommittedOperation\(existingPayment/);
  assert.match(section, /idempotencyKey:\s*operation\.operationId/);
  assert.match(section, /confirmCommittedOperation\(paymentRef/);
  assert.doesNotMatch(section, /addDoc\s*\(/);
});

test("los gastos reutilizan un documento determinístico sin leer un documento todavía inexistente", () => {
  const section = sourceSection(
    '$("expenseForm")?.addEventListener("submit"',
    '$("addUberBtn")?.addEventListener("click"'
  );
  assert.match(section, /reservePendingOperation\("expense"/);
  assert.match(section, /doc\(db, ROOT_COLLECTIONS\.expenses, operation\.operationId\)/);
  assert.match(section, /setDoc\(expenseRef, expensePayload\)/);
  assert.doesNotMatch(section, /await\s+[^;\n]*transaction\.get\(expenseRef\)/);
  assert.match(section, /idempotencyKey:\s*operation\.operationId/);
  assert.match(section, /confirmCommittedOperation\(expenseRef/);
  assert.doesNotMatch(section, /addDoc\s*\(/);
});

test("Telegram deduplica por operación tanto cobros como gastos", () => {
  assert.match(functionsSource, /function telegramOperationNotificationKey/);
  const uses = functionsSource.match(/notificationKey:\s*telegramOperationNotificationKey\(data, docId\)/g) || [];
  assert.ok(uses.length >= 3, "Falta aplicar la clave idempotente a algún aviso de cobro o gasto");
});
