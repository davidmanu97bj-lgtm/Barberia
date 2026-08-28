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
  assert.match(html, /teamBarberList/);
  assert.match(html, /receiptList/);
  assert.doesNotMatch(html, /cashReceiptList|advertisingReceiptList|digitalReceiptList/);
});

test("la app usa solamente el Firebase de la barbería", () => {
  const config = read("firebase-config.js");
  assert.match(config, /barberia-c25a1/);
  assert.doesNotMatch(config, /explora-control-operativo/);
});

test("cada cobro crea un único comprobante de publicidad del 5% en su medio", () => {
  const source = read("app.js");
  assert.match(source, /caja_publicidad/);
  assert.match(source, /const advertisingRef/);
  assert.match(source, /amount: item\.amount \* 0\.05/);
  assert.match(source, /rate: 0\.05/);
  assert.doesNotMatch(source, /advertisingCashRef|advertisingDigitalRef/);
});

test("el tablero compartido usa saldos públicos sin exponer comprobantes ajenos", () => {
  const source = read("app.js");
  const rules = read("firestore.rules");
  assert.match(source, /saldos_barberos/);
  assert.match(source, /syncPublicBarberBoard/);
  assert.match(rules, /match \/saldos_barberos\/\{barberUid\}/);
  assert.match(rules, /allow read: if signedIn\(\)/);
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


test("los comprobantes aparecen en una sola lista y la cabecera duplicada del barbero fue quitada", () => {
  const html = read("index.html");
  const source = read("app.js");
  assert.match(html, /id="receiptList"/);
  assert.doesNotMatch(html, /id="currentBarberName"|class="avatar-dot"|id="syncStatus"/);
  assert.match(source, /unifiedReceipts/);
  assert.match(source, /Caja para publicidad/);
});


test("la caja de publicidad detalla 5% efectivo y 5% digital", () => {
  const html = read("index.html");
  const source = read("app.js");
  assert.match(html, /Efectivo 5%/);
  assert.match(html, /Digital 5%/);
  assert.match(html, /cashAdvertisingFund/);
  assert.match(html, /digitalAdvertisingFund/);
  assert.match(source, /cashAdvertisingFund/);
  assert.match(source, /digitalAdvertisingFund/);
  assert.doesNotMatch(html + source, /Publicidad 10%|Efectivo 10%|Digital 10%|publicidad del 10%/i);
});

test("efectivo usa rojo y digital verde con comprobantes suaves", () => {
  const css = read("styles.css");
  assert.match(css, /cash-summary-card[^}]*var\(--red\)/s);
  assert.match(css, /digital-summary-card[^}]*var\(--green\)/s);
  assert.match(css, /charge-button\.cash[^}]*rgba\(200, 54, 54/s);
  assert.match(css, /charge-button\.digital[^}]*rgba\(22, 138, 85/s);
  assert.match(css, /receipt\.cash[^}]*rgba\(200, 54, 54/s);
  assert.match(css, /receipt\.digital[^}]*rgba\(22, 138, 85/s);
});

test("el comprobante digital guarda metadatos para enviarse a Telegram", () => {
  const source = read("app.js");
  assert.match(source, /proofContentType: proof\.contentType/);
  assert.match(source, /proofFileName: proof\.fileName/);
});
