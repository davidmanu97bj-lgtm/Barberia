import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const functions = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

// El chofer ya no debe elegir manualmente quién paga a quién.
assert.doesNotMatch(html, /id="choosePayExplora"/);
assert.doesNotMatch(html, /id="chooseCollectExplora"/);
assert.doesNotMatch(app, /selectDriverClose\(/);
assert.match(app, /model\.from === "cash"/);
assert.match(app, /selectedCloseDirection = "driver_to_explora"/);
assert.match(app, /selectedCloseDirection = "explora_to_driver"/);

// Pago parcial: importe con formato, proyección del saldo y medio de pago.
assert.match(html, /id="driverClosePaymentPreview"/);
assert.match(html, /data-driver-close-payment-method="cash"/);
assert.match(html, /data-driver-close-payment-method="transfer"/);
assert.match(html, /MP\.explora/);
assert.match(html, /20-40411688-7/);
assert.match(app, /newBalance <= 0\.5 \? `\$\{money\(0\)\} · Equilibrado`/);
assert.match(app, /driverPaymentMethod === "transfer" && !file/);
assert.match(app, /receiptRequired: driverPaymentMethod === "transfer"/);
assert.match(styles, /\.close-payment-methods button\.selected/);

// Cobro del chofer: total fijo, alias, CUIT y saldo proyectado en cero.
assert.match(html, /id="driverCollectAlias"/);
assert.match(html, /id="driverCollectCuit"/);
assert.match(app, /\$\("driverCloseNewBalance"\)\.textContent = `\$\{money\(0\)\} · Equilibrado`/);
assert.match(app, /recipientAlias,/);
assert.match(app, /recipientCuit: recipientCuitDigits/);
assert.match(app, /status: "awaiting_admin_payment"/);

// Ninguna solicitud impacta antes de la confirmación del administrador.
assert.match(app, /status: "awaiting_admin_review"/);
assert.match(app, /approveDriverClosurePayment/);
assert.match(app, /transaction\.set\(paymentRef/);
assert.match(app, /paymentMethod, metodoPago:paymentMethod/);
assert.match(app, /advanceRepaymentAmount:0/);

// Telegram recibe pago/cobro, alias, CUIT y foto cuando existe comprobante.
assert.match(functions, /SOLICITUD DE COBRO DEL CHOFER/);
assert.match(functions, /PAGO DE CIERRE SOLICITADO/);
assert.match(functions, /Alias para cobrar:/);
assert.match(functions, /CUIT del titular:/);
assert.match(functions, /requirePhoto:Boolean\(telegramDirectPhotoUrl\(after\)\)/);

console.log("closure-direct-flow: ok");
