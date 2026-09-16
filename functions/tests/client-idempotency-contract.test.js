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

test("los cobros usan la clave estable y una confirmación autenticada del servidor", () => {
  const section = sourceSection('$("chargeForm")?.addEventListener("submit"', '$("addExpenseBtn")?.addEventListener("click"');
  assert.match(section, /submitOperationalMovement/);
  assert.doesNotMatch(section, /addDoc|setDoc|transaction\.set/);
  assert.match(appSource, /reservePendingOperation\(pendingKind,user\.uid,fingerprint\)/);
  assert.match(appSource, /action:"check",\.\.\.key/);
  assert.match(appSource, /validateOperationalAck\(response,key,user\)/);
  const server = fs.readFileSync(path.join(projectRoot,'functions/operational-save.js'),'utf8');
  assert.match(server, /await tx\.get\(ref\)/);
  assert.match(server, /tx\.create\(ref/);
  assert.match(server, /same\(current\.data\(\),key,uid\)/);
});

test("gastos y deuda no leen un documento inexistente con permisos del cliente", () => {
  const section = sourceSection('$("expenseForm")?.addEventListener("submit"', 'function parseUberAmount');
  assert.match(section, /submitOperationalMovement/);
  assert.doesNotMatch(section, /addDoc|setDoc|transaction\.get|getDocFromServer/);
  assert.match(appSource, /clearPendingOperation\(pendingKind,user\.uid,key\.fingerprint,key\.operationId\)/);
  assert.match(appSource, /stage==="guardar"/);
});

test("Telegram deduplica por operación tanto cobros como gastos", () => {
  assert.match(functionsSource, /function telegramOperationNotificationKey/);
  const uses = functionsSource.match(/notificationKey:\s*telegramOperationNotificationKey\(data, docId\)/g) || [];
  assert.ok(uses.length >= 3, "Falta aplicar la clave idempotente a algún aviso de cobro o gasto");
});
