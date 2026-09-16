export const DRIVER_DEBT_VERSION = "v2.3.0-pendientes";

const text = value => String(value ?? "").trim();
const token = value => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s-]+/g, "_");
export const moneyValue = value => {
  if (value === null || value === undefined || value === "") return 0;
  const normalized = typeof value === "string"
    ? value.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".").replace(/[^\d.-]/g, "")
    : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 100) / 100) : 0;
};

export function installmentPlan(totalInput, countInput, weeklyInput, periodIds = []) {
  const total = moneyValue(totalInput);
  const count = Math.max(1, Math.min(52, Math.trunc(Number(countInput) || 1)));
  const defaultWeekly = Math.ceil(total / count);
  const weekly = moneyValue(weeklyInput) || defaultWeekly;
  if (!(total > 0) || !(weekly > 0)) return [];
  const rows = [];
  let remaining = total;
  for (let index = 0; index < count && remaining > 0; index += 1) {
    const amount = Math.min(remaining, weekly);
    rows.push({
      number:index + 1,
      total:count,
      amount,
      weeklyPeriodId:text(periodIds[index]),
      status:"pending"
    });
    remaining = moneyValue(remaining - amount);
  }
  if (remaining > 0) {
    const last = rows.at(-1);
    if (last) {
      last.amount = moneyValue(last.amount + remaining);
      remaining = 0;
    }
  }
  return rows;
}

export function attachmentList(row = {}) {
  const list = [];
  const seen = new Set();
  const push = input => {
    if (!input) return;
    const item = typeof input === "string" ? { url:input } : { ...input };
    const url = text(item.url || item.receiptUrl || item.downloadURL || item.fileUrl || item.comprobanteUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    list.push(Object.freeze({
      url,
      path:text(item.path || item.receiptPath || item.storagePath || item.fullPath),
      name:text(item.name || item.fileName || item.receiptFileName || "Archivo adjunto"),
      mimeType:text(item.mimeType || item.type || item.receiptMimeType || "application/octet-stream"),
      size:moneyValue(item.size || item.fileSize || item.receiptSize),
      uploadedAt:item.uploadedAt || item.uploadedAtClient || item.receiptUploadedAt || item.createdAt || row.receiptUploadedAt || row.createdAt || null,
      uploadedByUid:text(item.uploadedByUid || item.receiptUploadedByUid || row.receiptUploadedByUid || row.createdByUid),
      uploadedByRole:text(item.uploadedByRole || item.receiptUploadedByRole || row.receiptUploadedByRole || row.createdByRole || "admin")
    }));
  };
  (Array.isArray(row.attachments) ? row.attachments : []).forEach(push);
  (Array.isArray(row.archivos) ? row.archivos : []).forEach(push);
  (Array.isArray(row.photos) ? row.photos : []).forEach(push);
  (Array.isArray(row.fotos) ? row.fotos : []).forEach(push);
  push({
    url:row.receiptUrl || row.comprobanteUrl || row.photoUrl || row.fotoUrl,
    path:row.receiptPath || row.storagePath,
    name:row.receiptFileName,
    mimeType:row.receiptMimeType,
    size:row.receiptSize,
    uploadedAt:row.receiptUploadedAt,
    uploadedByUid:row.receiptUploadedByUid,
    uploadedByRole:row.receiptUploadedByRole
  });
  return Object.freeze(list);
}

function rawInstallments(row = {}) {
  return (Array.isArray(row.installments) ? row.installments : []).map((item, index) => ({
    ...item,
    number:Number(item.number || item.numero || index + 1),
    total:Number(item.total || item.cantidad || row.installmentCount || row.cantidadCuotas || 1),
    amount:moneyValue(item.amount ?? item.monto),
    weeklyPeriodId:text(item.weeklyPeriodId || item.periodoSemanalId),
    status:token(item.status || item.estado || "pending")
  }));
}

function statusFlags(row, installments, activeWeeklyPeriodId) {
  const raw = token(row.debtStatus || row.status || row.estado || "");
  const cancelled = row.cancelled === true || row.cancelado === true || raw.includes("cancel");
  const total = moneyValue(row.totalAmount ?? row.originalAmount ?? row.amount ?? row.montoTotal ?? row.monto);
  const paidAmountStored = moneyValue(row.paidAmount ?? row.amountPaid ?? row.importePagado ?? row.discountedAmount);
  const remainingStored = row.remainingAmount ?? row.saldoPendiente ?? row.remainingBalance ?? row.balance;
  const remaining = remainingStored === undefined || remainingStored === null || remainingStored === ""
    ? moneyValue(total - paidAmountStored)
    : moneyValue(remainingStored);
  const paid = !cancelled && (remaining <= 0 || raw === "paid" || raw.includes("pagad") || raw.includes("liquidad"));
  const pendingInstallments = installments.filter(item => !["paid","settled","cancelled","canceled","anulada","cancelado"].includes(item.status));
  const overdue = pendingInstallments.some(item => item.weeklyPeriodId && activeWeeklyPeriodId && item.weeklyPeriodId < activeWeeklyPeriodId);
  const rejected = raw.includes("reject") || raw.includes("rechaz") || installments.some(item => item.status.includes("reject") || item.status.includes("rechaz"));
  const hasPlan = Number(row.installmentCount || row.cantidadCuotas || installments.length || 0) > 1 || raw === "installment" || raw.includes("cuota") || raw.includes("active_acknowledged");
  if (cancelled) return { code:"cancelled", label:"Cancelado", tone:"neutral", remaining:0, paid:false, cancelled:true, overdue:false, rejected:false, hasPlan };
  if (paid) return { code:"paid", label:"Pagado", tone:"ok", remaining:0, paid:true, cancelled:false, overdue:false, rejected:false, hasPlan };
  if (overdue || rejected || !hasPlan) return { code:"pending", label:"Pendiente", tone:"danger", remaining, paid:false, cancelled:false, overdue, rejected, hasPlan };
  return { code:"installment", label:"En cuotas", tone:"warning", remaining, paid:false, cancelled:false, overdue:false, rejected:false, hasPlan:true };
}

export function normalizeDebt(row = {}, activeWeeklyPeriodId = "") {
  const installments = rawInstallments(row);
  const totalAmount = moneyValue(row.totalAmount ?? row.originalAmount ?? row.importeOriginal ?? row.amount ?? row.montoTotal ?? row.monto);
  const flags = statusFlags(row, installments, activeWeeklyPeriodId);
  const paidAmount = moneyValue(row.paidAmount ?? row.amountPaid ?? row.importePagado ?? (totalAmount - flags.remaining));
  const paidInstallments = Math.max(0, Number(row.paidInstallments ?? row.cuotasPagadas ?? installments.filter(item => ["paid","settled"].includes(item.status)).length) || 0);
  const installmentCount = Math.max(1, Number((row.installmentCount ?? row.cantidadCuotas ?? installments.length) || 1) || 1);
  const next = installments.find(item => !["paid","settled","cancelled","canceled","anulada","cancelado"].includes(item.status));
  const weeklyInstallmentAmount = moneyValue(next?.amount ?? row.weeklyInstallmentAmount ?? row.firstInstallmentAmount ?? row.cuotaSemanal);
  const typeToken = token(row.reason || row.reasonLabel || row.tipo || row.category || row.type || "fine");
  const type = typeToken.includes("crash") || typeToken.includes("choque") ? "crash"
    : typeToken.includes("personal_loan") || typeToken.includes("prestamo") || typeToken.includes("loan") ? "personal_loan"
    : typeToken.includes("advance") || typeToken.includes("adelanto") ? "advance"
    : typeToken.includes("other") || typeToken.includes("otro") ? "other"
    : "fine";
  const typeLabel = type === "crash" ? "CHOQUE" : type === "personal_loan" ? "PRÉSTAMO" : type === "advance" ? "ADELANTO" : type === "other" ? "OTRO CARGO" : "MULTA";
  return Object.freeze({
    ...row,
    id:text(row.id || row.debtId || row.documentId),
    debtId:text(row.debtId || row.id || row.documentId),
    driverUid:text(row.driverUid || row.choferUid || row.uid || row.driverId),
    vehicleId:text(row.vehicleId || row.vehiculoId || row.originalVehicleId),
    vehiclePlate:text(row.vehiclePlate || row.patente || row.originalVehiclePlate),
    type,
    typeLabel,
    description:text(row.description || row.descripcion || row.reasonDetail || row.notes || row.observaciones || "Sin descripción"),
    adminNotes:text(row.adminNotes || row.observacionesAdministrador || row.notes || row.observaciones),
    incidentDate:row.incidentDate || row.fechaIncidente || row.date || row.fecha || row.createdAt || null,
    totalAmount,
    paidAmount:Math.min(totalAmount, paidAmount),
    remainingAmount:flags.remaining,
    weeklyInstallmentAmount,
    installmentCount,
    paidInstallments:Math.min(installmentCount, paidInstallments),
    nextWeeklyPeriodId:text(next?.weeklyPeriodId || row.nextWeeklyPeriodId),
    installments:Object.freeze(installments),
    attachments:attachmentList(row),
    status:flags.code,
    statusLabel:flags.label,
    tone:flags.tone,
    overdue:flags.overdue,
    rejected:flags.rejected,
    active:!flags.cancelled && !flags.paid && flags.remaining > 0
  });
}

export function summarizeDebts(rows = [], activeWeeklyPeriodId = "") {
  const normalized = rows.map(row => normalizeDebt(row, activeWeeklyPeriodId));
  const active = normalized.filter(row => row.active);
  const pending = active.filter(row => row.status === "pending");
  const installment = active.filter(row => row.status === "installment");
  const totalPending = active.reduce((sum, row) => sum + row.remainingAmount, 0);
  const weeklyTotal = active.reduce((sum, row) => sum + Math.min(row.remainingAmount, row.weeklyInstallmentAmount || 0), 0);
  const interestTotal = active.reduce((sum, row) => sum + moneyValue(row.penaltyAccruedAmount ?? row.interestAccruedAmount ?? row.intereses ?? row.mora ?? 0), 0);
  const fines = active.filter(row => row.type === "fine").length;
  const crashes = active.filter(row => row.type === "crash").length;
  const personalLoans = active.filter(row => row.type === "personal_loan").length;
  const advances = active.filter(row => row.type === "advance").length;
  const dashboard = pending.length
    ? { code:"pending", label:"Pago pendiente", fullLabel:`${pending.length} pago${pending.length === 1 ? "" : "s"} pendiente${pending.length === 1 ? "" : "s"}`, amount:totalPending }
    : installment.length
      ? { code:"installment", label:`${formatCompactMoney(totalPending)} en cuotas`, fullLabel:`${formatCompactMoney(totalPending)} en cuotas`, amount:totalPending }
      : { code:"ok", label:"Sin deudas", fullLabel:"Sin deudas", amount:0 };
  return Object.freeze({ normalized:Object.freeze(normalized), active:Object.freeze(active), totalPending:moneyValue(totalPending), weeklyTotal:moneyValue(weeklyTotal), interestTotal:moneyValue(interestTotal), fines, crashes, personalLoans, advances, pendingCount:pending.length, installmentCount:installment.length, dashboard:Object.freeze(dashboard) });
}

export function formatCompactMoney(value) {
  return new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(moneyValue(value)).replace(/\s/g, "");
}

export function previewInstallmentApplication(row = {}, weeklyPeriodId, requestedAmount = 0) {
  const debt = normalizeDebt(row, weeklyPeriodId);
  if (!weeklyPeriodId || !debt.id) return Object.freeze({ applied:false, duplicate:false, reason:"invalid", amount:0, previousBalance:debt.remainingAmount, newBalance:debt.remainingAmount });
  if (!debt.active) return Object.freeze({ applied:false, duplicate:false, reason:debt.status, amount:0, previousBalance:debt.remainingAmount, newBalance:debt.remainingAmount });
  const installment = debt.installments.find(item => item.weeklyPeriodId === weeklyPeriodId);
  if (!installment) return Object.freeze({ applied:false, duplicate:false, reason:"not_scheduled", amount:0, previousBalance:debt.remainingAmount, newBalance:debt.remainingAmount });
  if (["paid","settled"].includes(installment.status)) return Object.freeze({ applied:false, duplicate:true, reason:"already_paid", amount:0, previousBalance:debt.remainingAmount, newBalance:debt.remainingAmount });
  const requested = moneyValue(requestedAmount) || installment.amount;
  const amount = Math.min(debt.remainingAmount, requested, installment.amount || requested);
  const newBalance = moneyValue(debt.remainingAmount - amount);
  return Object.freeze({ applied:amount > 0, duplicate:false, reason:amount > 0 ? "applied" : "zero", amount, previousBalance:debt.remainingAmount, newBalance, paid:newBalance === 0, installmentNumber:installment.number, installmentCount:installment.total || debt.installmentCount });
}
