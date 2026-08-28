const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("expone solamente los callables administrativos de barbería", () => {
  const exported = [...source.matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)].map(match => match[1]).sort();
  assert.deepEqual(exported, ["adminCreateBarber", "adminUpdateBarber"]);
});

test("no conserva funciones ni grupos de Telegram de Explora", () => {
  assert.doesNotMatch(source, /TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|notify.*Telegram/i);
  assert.doesNotMatch(source, /adminCreateDriver|adminUpdateDriver/);
});

test("fija el proyecto lógico de la barbería", () => {
  assert.match(source, /barberia-c25a1/);
  assert.match(source, /barberia\.local/);
});

