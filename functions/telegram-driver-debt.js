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

function isAdminDriverDebt(data = {}) {
  const role = safeText(data.createdByRole || data.registeredByRole).toLowerCase();
  const origin = safeText(data.registrationOrigin || data.origin).toLowerCase();
  const amount = firstMoney(data, ["totalAmount", "amount", "monto", "importe"]);
  const isAdmin = data.registeredByAdmin === true || role === "admin" || role === "administrador" ||
    origin === "admin_debt_menu";
  return isAdmin && Number(amount) > 0;
}

function adminDriverDebtAmounts(data = {}) {
  const amount = firstMoney(data, ["totalAmount", "amount", "monto", "importe"]) || 0;
  let previousBalance = firstMoney(data, ["driverDebtBalanceBefore", "previousBalance", "balanceBefore", "deudaAnterior"]);
  let currentBalance = firstMoney(data, ["driverDebtBalanceAfter", "newBalance", "balanceAfter", "deudaActual"]);
  if (previousBalance === null && currentBalance !== null) previousBalance = Math.max(0, currentBalance - amount);
  if (currentBalance === null && previousBalance !== null) currentBalance = previousBalance + amount;
  if (previousBalance === null) previousBalance = 0;
  if (currentBalance === null) currentBalance = previousBalance + amount;
  return Object.freeze({ amount, previousBalance, currentBalance });
}

function buildAdminDriverDebtTelegramText(data = {}, options = {}) {
  const formatMoney = typeof options.formatMoney === "function" ? options.formatMoney : defaultMoney;
  const formatDate = typeof options.formatDate === "function" ? options.formatDate : (() => "—");
  const { amount, previousBalance, currentBalance } = adminDriverDebtAmounts(data);
  const driverName = safeText(data.driverName || data.choferNombre || data.nombreChofer || "Chofer");
  const reason = safeText(data.description || data.reasonDescription || data.notes || data.motivo || data.detalle || data.reasonLabel || "Deuda del chofer");
  const registeredBy = safeText(data.createdByName || data.registeredByName || "Administrador");
  const pendingDriverAcceptance = data.driverConfirmationRequired === true && data.acknowledgedByDriver !== true;
  const settlementAfter = Number(data.telegramSettlementAfterBalance);
  const settlementLine = Number.isFinite(settlementAfter)
    ? settlementAfter > 0.49
      ? `${pendingDriverAcceptance ? "Si acepta" : "Quién paga a quién"}: Chofer debe liquidar a Explora ${formatMoney(settlementAfter)}`
      : settlementAfter < -0.49
        ? `${pendingDriverAcceptance ? "Si acepta" : "Quién paga a quién"}: Explora debe liquidar al chofer ${formatMoney(Math.abs(settlementAfter))}`
        : `${pendingDriverAcceptance ? "Si acepta" : "Quién paga a quién"}: cuentas equilibradas`
    : "";
  return [
    "DEUDA DEL CHOFER REGISTRADA",
    ...(pendingDriverAcceptance ? ["Estado: Pendiente de aceptación del chofer"] : []),
    `Chofer: ${driverName}`,
    `Motivo: ${reason.slice(0, 300)}`,
    `${pendingDriverAcceptance ? "Importe pendiente" : "Importe agregado"}: ${formatMoney(amount)}`,
    `${pendingDriverAcceptance ? "Deuda actual sin aceptar" : "Deuda anterior"}: ${formatMoney(previousBalance)}`,
    `${pendingDriverAcceptance ? "Deuda si acepta" : "Deuda actual"}: ${formatMoney(currentBalance)}`,
    `Quién paga: Chofer paga a Explora el 100 %`,
    ...(settlementLine ? [settlementLine] : []),
    `Registrado por: ${registeredBy}`,
    `Fecha: ${formatDate(data)}`
  ].join("\n");
}

module.exports = {
  adminDriverDebtAmounts,
  buildAdminDriverDebtTelegramText,
  isAdminDriverDebt
};
