import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activity = fs.readFileSync(path.join(root, "js/segments/52-script.mjs"), "utf8");
const css = fs.readFileSync(path.join(root, "css/segments/53-style.css"), "utf8");
// Contratos del código segmentado conservado. frontend-runtime.test.mjs verifica la entrada vigente.

assert.match(activity, /financialKind:"cobro", financialId/);
assert.match(activity, /financialKind:"gasto", financialId/);
assert.match(activity, /canManageFinancial = isAdmin\(\)/);
assert.match(activity, /data-pay-activity-financial-edit/);
assert.match(activity, /data-pay-activity-financial-delete/);
assert.match(activity, />EDITAR<\/button>/);
assert.match(activity, /ELIMINAR/);
assert.match(activity, /ExploraReceiptEngine\.modifyFinancialAmount/);
assert.match(activity, /ExploraReceiptEngine\.deleteFinancialMovement/);
assert.match(activity, /adminActivityFinancialReceipt/);
assert.match(activity, /stateKey = cleanKind === "gasto" \? "expenses" : "records"/);
assert.match(css, /\.pay-activity-financial-edit/);
assert.match(css, /\.pay-activity-financial-delete/);

console.log("admin activity financial actions: ok");
