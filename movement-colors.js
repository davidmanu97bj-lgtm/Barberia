// Presentation only. These colors NEVER choose an amount, sign, rate or writer.
// Green/red describe the operation requested by Explora, not the arithmetic sign.
export function movementColor(record = {}, {expensePolicy} = {}) {
  if (["green", "red"].includes(record.visualMovementColor)) return record.visualMovementColor;
  const type = String(record.type || "");
  const method = String(record.method || "");
  if (type === "expense_reimbursement_receipt") return "green";
  if (type === "cashbox_receipt") return ["cash", "digital"].includes(method) ? "red" : "";
  if (type === "expense_receipt" || type === "gasto" || method === "expense") {
    // The existing catalogue decides responsibility. Historical rules stay historical.
    const rate = expensePolicy?.refundRate(record);
    return rate === 1 ? "green" : "red";
  }
  const direction = record.adjustmentDirection || record.direction;
  if (["driver_to_explora", "driver_pays_explora"].includes(direction)) return "green";
  if (["explora_to_driver", "explora_pays_driver"].includes(direction)) return "red";
  if (["settlement_adjustment", "cash_advance", "admin_debt", "reimbursement_compensation", "debt_compensation", "uber_receipt", "uber"].includes(type)) return "";
  return method === "cash" ? "red" : method === "digital" ? "green" : "";
}
