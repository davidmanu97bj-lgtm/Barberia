const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("expone los callables administrativos y los avisos de Telegram de barbería", () => {
  const exported = [...source.matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)].map(match => match[1]).sort();
  assert.deepEqual(exported, [
    "adminCreateBarber",
    "adminUpdateBarber",
    "telegramBarberChargeCreated",
    "telegramBarberClosureCompleted",
    "telegramBarberClosureRequested"
  ]);
});

test("Telegram apunta al grupo Barbería y mantiene el token fuera del código", () => {
  assert.match(source, /TELEGRAM_CHAT_ID = "-5393018000"/);
  assert.match(source, /defineSecret\("BARBERIA_TELEGRAM_BOT_TOKEN"\)/);
  assert.match(source, /_telegram_delivery/);
  assert.doesNotMatch(source, /8952546800:/);
  assert.doesNotMatch(source, /adminCreateDriver|adminUpdateDriver|explora-control-operativo/i);
});

test("fija el proyecto lógico de la barbería", () => {
  assert.match(source, /barberia-c25a1/);
  assert.match(source, /barberia\.local/);
});

