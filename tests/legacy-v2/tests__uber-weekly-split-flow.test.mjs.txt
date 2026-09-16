import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const rules = fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const storageRules = fs.readFileSync(new URL("../storage.rules", import.meta.url), "utf8");
const telegram = fs.readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
const balance = fs.readFileSync(new URL("../functions/telegram-billing-balance.js", import.meta.url), "utf8");
const submission = fs.readFileSync(new URL("../functions/uber-submission.js", import.meta.url), "utf8");

// El chofer carga un único total semanal y la evidencia desde cámara o galería.
assert.match(html, /id="uberGrossAmount"/);
assert.match(html, /data-photo-picker="uber"/);
assert.match(html, /id="uberProofCamera"[^>]*capture="environment"/);
assert.match(html, /id="uberProof"[^>]*data-photo-source="gallery"/);
assert.match(html, /¿Dónde encuentro este monto\?/);
assert.match(html, /No uses saldo, retiros ni tarifa bruta/);
assert.doesNotMatch(html, /id="uberCashAmount"/);
assert.doesNotMatch(html, /id="uberTransferAmount"/);
assert.doesNotMatch(html, /id="adminUberCashAmount"/);
assert.doesNotMatch(html, /id="adminUberTransferAmount"/);

// La vista previa deja sólo las dos cifras necesarias: total semanal y 50% + 5%.
assert.match(app, /function uberDriverSubmissionDelta\(grossAmount = 0, item/);
assert.match(app, /uberUsesGrossCashRule\(item\) \? 1\.05 : 0\.55/);
assert.match(app, /impactLabel: "Importe completo \+ 5% de caja chica"/);
assert.doesNotMatch(html, /operationPreviewUberGross|operationPreviewUberExplora|operationPreviewUberCashbox|operationPreviewUberDriver/);
assert.match(app, /httpsCallable\(functions,"registerUberLiquidation"/);
assert.match(submission, /v85_verified_direct/);
assert.match(submission, /reviewStatus:'completed'/);
assert.match(app, /selectedPhotoFile\("uber"\)/);
assert.match(app, /verifyUberPhoto\(file, week, amount\)/);
assert.match(html, /Al registrar, el total y el 5% de caja chica se aplican a tu saldo/);
assert.match(html, /Liquidación UBER · 100%/);

// Se conservan los controles para pedidos históricos que aún esperan revisión.
assert.match(app, /id="adminUberVerifiedAmount"/);
assert.match(app, /Comprobante y semana verificados/);
assert.match(app, /async function approveUberClosureFromAdmin/);
assert.match(app, /adminConfirmed:true/);
assert.match(app, /reviewStatus:"approved"/);
assert.match(app, /Cierre confirmado\. El saldo ya fue actualizado\./);

// Las reglas validan propiedad, monto, foto y estado pendiente sin depender de
// cálculos derivados del cliente; además la app consulta el ID determinístico
// antes de subir para separar duplicados de verdaderos problemas de permisos.
assert.match(rules, /data\.settlementWorkflowVersion == 'v84_driver_submission_admin_review'/);
assert.match(rules, /data\.grossAmount > 0/);
assert.match(rules, /data\.reviewStatus == 'pending_admin_review'/);
assert.match(rules, /data\.proofUrl\.size\(\) > 0/);
assert.match(rules, /resource\.data\.driverUid == uid\(\)/);
assert.doesNotMatch(rules, /data\.exploraShare \* 2 == data\.grossAmount/);
assert.match(app, /async function resolveUberSubmissionTarget/);
assert.match(app, /Registrando liquidación/);
assert.match(storageRules, /allow update: if \(isAuthorizedAdmin\(\) \|\| isOwner\(driverUid\)\)/);

// Telegram cubre el envío con foto y la aprobación/rechazo de David.
assert.match(telegram, /CHOFER ENVIÓ SU CIERRE SEMANAL DE UBER/);
assert.match(telegram, /DAVID CONFIRMÓ EL CIERRE SEMANAL DE UBER/);
assert.match(telegram, /DAVID RECHAZÓ EL CIERRE SEMANAL DE UBER/);
assert.match(telegram, /Comprobante: Adjunto/);
assert.match(telegram, /Total para Explora:/);
assert.match(telegram, /review === "pending_admin_review"/);
assert.match(telegram, /El adjunto falló; se enviará el aviso como texto/);

// Los pedidos históricos pendientes conservan su regla de aprobación.
assert.match(app, /item\.adminConfirmed === true && \/approved\|confirmed\|completed\/\.test\(status\)/);
assert.match(balance, /data\.adminConfirmed === true && \/approved\|confirmed\|completed\/\.test\(status\)/);

console.log("uber-weekly-driver-proof-admin-review: ok");

// v84.3: el Admin no puede calcular ni confirmar Uber con snapshots parciales.
assert.match(app, /function adminDashboardFinancialReady\(\)/);
assert.match(app, /if \(!isAdminProfile\(\) \|\| !adminDashboardFinancialReady\(\)\) return;/);
assert.match(app, /Los saldos todavía se están sincronizando/);
assert.match(app, /refreshOpenAdminUberCalculation\(\)/);
