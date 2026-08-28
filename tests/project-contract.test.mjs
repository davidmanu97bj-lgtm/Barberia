import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("la interfaz no expone módulos de Explora", () => {
  const html = read("index.html");
  assert.doesNotMatch(html, /Explora|pr[eé]stamo|adelanto|cargar gasto|Uber/i);
  assert.match(html, /Caja para publicidad/);
  assert.match(html, /Barberos activos/);
});

test("la app usa solamente el Firebase de la barbería", () => {
  const config = read("firebase-config.js");
  assert.match(config, /barberia-c25a1/);
  assert.doesNotMatch(config, /explora-control-operativo/);
});

test("cada cobro crea dos comprobantes del 5%", () => {
  const source = read("app.js");
  assert.match(source, /caja_publicidad/);
  assert.match(source, /\[advertisingCashRef, "cash"/);
  assert.match(source, /\[advertisingDigitalRef, "digital"/);
  assert.match(source, /item\.amount \* 0\.05/);
});

test("Telegram queda conectado solamente al grupo Barbería", () => {
  const appSource = read("app.js");
  const functionSource = read("functions/index.js");
  assert.match(appSource, /telegramEventType/);
  assert.match(functionSource, /TELEGRAM_CHAT_ID = "-5393018000"/);
  assert.match(functionSource, /defineSecret\("BARBERIA_TELEGRAM_BOT_TOKEN"\)/);
  assert.match(functionSource, /telegramBarberChargeCreated/);
  assert.match(functionSource, /telegramBarberClosureRequested/);
  assert.match(functionSource, /telegramBarberClosureCompleted/);
  assert.doesNotMatch(functionSource, /explora-control-operativo/i);
});
