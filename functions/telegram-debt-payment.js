"use strict";

function safeText(value) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

function finiteMoney(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(parsed * 100) / 100);
}

function firstMoney(data = {}, fields = []) {
  for (const field of fields) {
    const parsed = finiteMoney(data[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function defaultMoney(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function isAdminDebtPayment(data = {}) {
  const role = safeText(data.createdByRole || data.registeredByRole).toLowerCase();
  const origin = safeText(data.registrationOrigin || data.origin).toLowerCase();
  const reductionMethod = safeText(data.debtReductionMethod).toLowerCase();
  return data.registeredByAdmin === true ||
    role === "admin" || role === "administrador" ||
    origin === "admin_closure_board" || reductionMethod === "admin_payment";
}

function adminDebtPaymentMethodLabel(data = {}) {
  const method = safeText(data.paymentMethod || data.method || data.metodoPago || data.tipoPago).toLowerCase();
  return /transfer|transf|alias/.test(method) ? "Transferencia" : "Efectivo";
}

function adminDebtPaymentAmounts(data = {}) {
  const reduction = firstMoney(data, ["amount", "monto", "paidAmount", "importe"]) || 0;
  let previousBalance = firstMoney(data, ["previousBalance", "balanceBefore", "deudaAnterior", "saldoAnterior"]);
  let currentBalance = firstMoney(data, ["newBalance", "balanceAfter", "currentBalance", "deudaActual", "saldoActual"]);

  if (previousBalance === null && currentBalance !== null) previousBalance = currentBalance + reduction;
  if (currentBalance === null && previousBalance !== null) currentBalance = Math.max(0, previousBalance - reduction);
  if (previousBalance === null) previousBalance = reduction;
  if (currentBalance === null) currentBalance = Math.max(0, previousBalance - reduction);

  return Object.freeze({ reduction, previousBalance, currentBalance });
}

function buildAdminDebtPaymentTelegramText(data = {}, options = {}) {
  const formatMoney = typeof options.formatMoney === "function" ? options.formatMoney : defaultMoney;
  const formatDate = typeof options.formatDate === "function" ? options.formatDate : (() => "—");
  const { reduction, previousBalance, currentBalance } = adminDebtPaymentAmounts(data);
  const driverName = safeText(
    data.driverName || data.choferNombre || data.nombreChofer || data.displayName || "Chofer"
  );
  const registeredBy = safeText(data.createdByName || data.registeredByName || "Administrador");
  const reason = safeText(data.reason || data.description || data.notes || data.motivo || data.detalle);
  const status = currentBalance > 0.49
    ? `Chofer todavía debe a Explora ${formatMoney(currentBalance)}`
    : "Deuda saldada: nadie debe liquidar por esta deuda";

  return [
    "REDUCCIÓN DE DEUDA REGISTRADA",
    `Chofer: ${driverName}`,
    `Medio: ${adminDebtPaymentMethodLabel(data)}`,
    ...(reason ? [`Motivo: ${reason.slice(0, 300)}`] : []),
    `Deuda anterior: ${formatMoney(previousBalance)}`,
    `Reducción aplicada: ${formatMoney(reduction)}`,
    `Deuda actual: ${formatMoney(currentBalance)}`,
    `Estado: ${status}`,
    `Registrado por: ${registeredBy}`,
    `Fecha: ${formatDate(data)}`
  ].join("\n");
}

module.exports = {
  adminDebtPaymentAmounts,
  adminDebtPaymentMethodLabel,
  buildAdminDebtPaymentTelegramText,
  isAdminDebtPayment
};
