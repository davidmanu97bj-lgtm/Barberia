import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  financialReceiptKind,
  financialReceiptDocumentId,
  isBillingSettlementPayment,
  expenseAmountCorrectionPatch
} from "../js/core/financial-receipt-actions-core.mjs";

assert.equal(financialReceiptKind({ category:"explora", raw:{ sourceCollection:"receipt_index", category:"payment", recordId:"bill_1", paymentMethod:"transfer" } }), "cobro");
assert.equal(financialReceiptKind({ category:"chofer", raw:{ sourceCollection:"billing_records", id:"bill_2", paymentMethod:"cash" } }), "cobro");
assert.equal(financialReceiptKind({ category:"gastos", raw:{ sourceCollection:"receipt_index", category:"expense", recordId:"expense_1" } }), "gasto");
assert.equal(financialReceiptKind({ category:"chofer", raw:{ sourceCollection:"cierres_semanales", closureKind:"caja_chica" } }), "");
assert.equal(financialReceiptKind({ category:"deudas", raw:{ sourceCollection:"receipt_index", category:"driver_debt", paymentMethod:"transfer" } }), "");

assert.equal(financialReceiptDocumentId({ raw:{ sourceCollection:"receipt_index", category:"payment", recordId:"bill_1" } }), "bill_1");
assert.equal(financialReceiptDocumentId({ raw:{ sourceCollection:"receipt_index", category:"expense", id:"expense_expense_1" } }), "expense_1");
assert.equal(isBillingSettlementPayment({ type:"admin_billing_settlement_payment", affectsBillingSettlement:true }), true);

const increased = expenseAmountCorrectionPatch({
  closure:{ includedExpenseIds:["expense_1"], expenseTotal:100, driverExpenseShare:50, exploraExpenseShare:50, expenseDebtOffsetApplied:20 },
  movement:{ sharedRate:.5 },
  documentId:"expense_1",
  previousAmount:100,
  newAmount:160
});
assert.deepEqual({
  total:increased.expenseTotal,
  driver:increased.driverExpenseShare,
  explora:increased.exploraExpenseShare,
  offset:increased.expenseDebtOffsetApplied,
  payable:increased.amountToDriver
}, { total:160, driver:80, explora:80, offset:20, payable:60 });

const reducedBelowOffset = expenseAmountCorrectionPatch({
  closure:{ includedExpenseIds:["expense_1"], expenseTotal:100, driverExpenseShare:50, exploraExpenseShare:50, expenseDebtOffsetApplied:40 },
  movement:{ sharedRate:.5 },
  documentId:"expense_1",
  previousAmount:100,
  newAmount:40
});
assert.equal(reducedBelowOffset.expenseDebtOffsetApplied, 20);
assert.equal(reducedBelowOffset.amountToDriver, 0);

const root = new URL("../", import.meta.url);
// Contratos del código segmentado conservado. frontend-runtime.test.mjs verifica la entrada vigente.
const [receiptsUi, receiptEngine, payHome, functions] = await Promise.all([
  readFile(new URL("js/segments/09-script.js", root), "utf8"),
  readFile(new URL("js/segments/13-script.mjs", root), "utf8"),
  readFile(new URL("js/segments/52-script.mjs", root), "utf8"),
  readFile(new URL("functions/index.js", root), "utf8")
]);

assert.match(receiptsUi, /data-receipt-edit-index/);
assert.match(receiptsUi, /data-receipt-delete-index/);
assert.match(receiptsUi, /modifyFinancialAmount/);
assert.match(receiptsUi, /deleteFinancialMovement/);
assert.match(receiptEngine, /async function modifyExpenseAmount/);
assert.match(receiptEngine, /includedBillingSettlementPaymentIds/);
assert.match(payHome, /deletedReceiptIndexes/);
assert.match(payHome, /admin_audit/);
assert.match(functions, /financialReceiptIndexDocuments/);

console.log("financial receipt actions: ok");
