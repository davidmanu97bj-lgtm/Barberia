"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("Telegram reconoce proofUrl de cierres Uber", () => {
  assert.match(source, /data\.proofUrl/);
  assert.match(source, /notifyUberClosureTelegramGroupV1/);
  assert.match(source, /document: "uber_weekly_closures\/{docId}"/);
});


test("Telegram Uber no pierde el aviso si falla la foto", () => {
  assert.match(source, /El adjunto falló; se enviará el aviso como texto/);
  assert.ok(source.includes("Comprobante: cargado en Explora; el adjunto no pudo enviarse a Telegram."));
  assert.match(source, /review === "pending_admin_review"/);
});
