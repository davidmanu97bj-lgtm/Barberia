"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const functions = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");

test("el nuevo panel conserva los saldos en tiempo real de todo el equipo", () => {
  assert.match(html, /id="adminWorkspaceTitle">Resumen del equipo<\/h1>/);
  assert.match(html, /id="adminDriverList"/);
  assert.doesNotMatch(html, /id="summaryBilledAmount"/);
  assert.doesNotMatch(html, /id="summaryExpenseTotal"/);
  assert.match(app, /TEAM_REALTIME_BALANCES_COLLECTION = "team_realtime_balances"/);
  assert.match(app, /Chofer debe/);
  assert.match(app, /Explora debe/);
});

test("el listado de choferes está visible en Admin y la gestión permite borrar", () => {
  assert.match(html, /id="adminDashboard"/);
  assert.match(html, /id="adminDriversBtn"/);
  assert.match(html, /data-driver-manager-mode="delete">Borrar chofer</);
  assert.match(html, /id="deleteDriverSelect"/);
  assert.match(app, /deleteDriver:true/);
  assert.match(app, /Borrar chofer/);
  assert.match(app, /function renderAdminDriverList\(\)/);
  assert.match(app, /filter\(driver => !adminDriverIsAdministrator\(driver\) && adminDriverIsActive\(driver\)\)/);
  assert.match(functions, /admin_delete_driver/);
});

test("los saldos compartidos son sanitizados y mantenidos por backend", () => {
  assert.match(functions, /exports\.ensureTeamRealtimeBalances/);
  assert.match(functions, /exports\.onTeamRealtimeBillingWriteV1/);
  assert.match(functions, /exports\.onTeamRealtimeExpenseWriteV1/);
  assert.match(functions, /exports\.onTeamRealtimeDriverWriteV1/);
  assert.match(functions, /driverName:teamRealtimeDriverName\(profile\)/);
  assert.match(functions, /settlementBalance:result\.balance/);
  assert.match(rules, /match \/team_realtime_balances\/\{driverId\}/);
  assert.match(rules, /allow create, update, delete: if false/);
});
