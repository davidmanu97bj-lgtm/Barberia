export const WEEKLY_CORE_VERSION = "v2.4.42-weekly-payment-production";
export const WEEKLY_SNAPSHOT_SCHEMA = 243;
export const EXPLORE_LOAN_LOOKBACK_WEEKS = 8;
export const EXPLORE_LOAN_MAX_INSTALLMENTS = 8;
export const EXPLORE_LOAN_MAX_AMOUNT_RATE = 0.10;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MONEY_EPSILON = 0.01;
export const REPAIR_FUND_RATE = 0.05;
export const DRIVER_BASE_PERCENTAGE = 50;
export const DRIVER_BASE_RATE = 0.50;
export const DERIVATION_BONUS_RATE = 0.10;
export const DERIVATION_COLLABORATION_RATE = 0.10;
export const SHARED_EXPENSE_RATE = 0.50;
export const DEFAULT_TIMEZONE = "America/Argentina/Cordoba";
export const CLOSURE_STATES = Object.freeze([
  "pending", "proof_required", "proof_uploading", "proof_uploaded",
  "under_review", "paid", "balanced", "error"
]);

const text = value => String(value ?? "").trim();
const token = value => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s-]+/g, "_");
export function roundMoney(value) {
  if (value === null || value === undefined || value === "") return 0;
  const normalized = typeof value === "string"
    ? value.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".").replace(/[^\d.-]/g, "")
    : value;
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw Object.assign(new Error("Monto financiero inválido."), { code:"WEEKLY_INVALID_MONEY", value });
  return Math.round(number * 100) / 100;
}
export const positiveMoney = value => Math.max(0, roundMoney(value));

export function zonedParts(date, timeZone = DEFAULT_TIMEZONE) {
  const input = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(input.getTime())) throw Object.assign(new Error("Fecha inválida."), { code:"WEEKLY_INVALID_DATE" });
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false
  }).formatToParts(input).reduce((out, part) => {
    if (part.type !== "literal") out[part.type] = Number(part.value);
    return out;
  }, {});
}

export function zonedDateTimeToUtcMs(parts, timeZone = DEFAULT_TIMEZONE) {
  const target = { year:+parts.year, month:+parts.month, day:+parts.day, hour:+(parts.hour||0), minute:+(parts.minute||0), second:+(parts.second||0) };
  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second, 0);
  let guess = targetAsUtc;
  for (let index = 0; index < 4; index += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, 0);
    const delta = targetAsUtc - actualAsUtc;
    guess += delta;
    if (delta === 0) break;
  }
  return guess;
}

export function dateIdFromLocalParts(parts) {
  return `${String(parts.year).padStart(4,"0")}-${String(parts.month).padStart(2,"0")}-${String(parts.day).padStart(2,"0")}`;
}

export function weeklyPeriodFromDate(reference = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(reference, timeZone);
  const localDayKey = Date.UTC(parts.year, parts.month - 1, parts.day);
  const dayOfWeek = new Date(localDayKey).getUTCDay();
  const daysSinceSaturday = (dayOfWeek - 6 + 7) % 7;
  const saturdayKey = localDayKey - daysSinceSaturday * DAY_MS;
  const saturday = new Date(saturdayKey);
  const localStart = { year:saturday.getUTCFullYear(), month:saturday.getUTCMonth()+1, day:saturday.getUTCDate(), hour:0, minute:0, second:0 };
  const startMs = zonedDateTimeToUtcMs(localStart, timeZone);
  const endMs = startMs + WEEK_MS - 1;
  const id = dateIdFromLocalParts(localStart);
  return Object.freeze({ id, weeklyPeriodId:id, startMs, endMs, startAt:new Date(startMs), endAt:new Date(endMs), timezone:timeZone });
}

export function weeklyPeriodFromId(periodId, timeZone = DEFAULT_TIMEZONE) {
  const match = text(periodId).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw Object.assign(new Error("weeklyPeriodId inválido."), { code:"WEEKLY_INVALID_PERIOD", weeklyPeriodId:periodId });
  const localStart = { year:+match[1], month:+match[2], day:+match[3], hour:0, minute:0, second:0 };
  const date = new Date(Date.UTC(localStart.year, localStart.month-1, localStart.day));
  if (date.getUTCDay() !== 6) throw Object.assign(new Error("weeklyPeriodId debe representar un sábado."), { code:"WEEKLY_PERIOD_NOT_SATURDAY", weeklyPeriodId:periodId });
  const startMs = zonedDateTimeToUtcMs(localStart, timeZone);
  return Object.freeze({ id:text(periodId), weeklyPeriodId:text(periodId), startMs, endMs:startMs + WEEK_MS - 1, startAt:new Date(startMs), endAt:new Date(startMs + WEEK_MS - 1), timezone:timeZone });
}


export function weeklyScopeFromPeriod(periodInput, timeZone = DEFAULT_TIMEZONE) {
  const period = typeof periodInput === "string"
    ? weeklyPeriodFromId(periodInput, timeZone)
    : periodInput?.weeklyPeriodId || periodInput?.id
      ? weeklyPeriodFromId(periodInput.weeklyPeriodId || periodInput.id, timeZone)
      : weeklyPeriodFromDate(new Date(), timeZone);
  return Object.freeze({
    id:period.id, weeklyPeriodId:period.id, startPeriodId:period.id, endPeriodId:period.id,
    periods:Object.freeze([period]), startMs:period.startMs, endMs:period.endMs,
    startAt:period.startAt, endAt:period.endAt, timezone:period.timezone, scope:"weekly"
  });
}

export function exploreLoanLookbackFromPeriod(periodInput, timeZone = DEFAULT_TIMEZONE) {
  const period = typeof periodInput === "string"
    ? weeklyPeriodFromId(periodInput, timeZone)
    : periodInput?.weeklyPeriodId || periodInput?.id
      ? weeklyPeriodFromId(periodInput.weeklyPeriodId || periodInput.id, timeZone)
      : weeklyPeriodFromDate(new Date(), timeZone);
  const periods = Array.from({ length:EXPLORE_LOAN_LOOKBACK_WEEKS }, (_, index) =>
    weeklyPeriodFromDate(new Date(period.startMs - (EXPLORE_LOAN_LOOKBACK_WEEKS - 1 - index) * WEEK_MS), timeZone).id
  );
  const start = weeklyPeriodFromId(periods[0], timeZone);
  return Object.freeze({
    id:`explora_loan_8w_${periods[0]}_${periods.at(-1)}`, exploraLoanLookbackId:`explora_loan_8w_${periods[0]}_${periods.at(-1)}`,
    startPeriodId:periods[0], endPeriodId:periods.at(-1), periods:Object.freeze(periods),
    weekIndex:EXPLORE_LOAN_LOOKBACK_WEEKS, weeks:EXPLORE_LOAN_LOOKBACK_WEEKS,
    startMs:start.startMs, endMs:period.endMs, startAt:start.startAt, endAt:period.endAt,
    weeklyPeriodId:period.id, timezone:timeZone, scope:"explora-loan-8-weeks"
  });
}

export function loanInstallmentKey(driverUid, weeklyPeriodId) {
  const uid = text(driverUid).replace(/[^a-zA-Z0-9_-]/g, "_");
  const period = weeklyPeriodFromId(weeklyPeriodId).id;
  if (!uid) throw Object.assign(new Error("driverUid requerido."), { code:"EXPLORA_LOAN_DRIVER_UID_REQUIRED" });
  return `${uid}_${period}`;
}

export function shouldApplyLoanInstallment(paidWeeklyPeriodIds = [], weeklyPeriodId) {
  const period = weeklyPeriodFromId(weeklyPeriodId).id;
  return !(Array.isArray(paidWeeklyPeriodIds) ? paidWeeklyPeriodIds : []).map(text).includes(period);
}

export function previewLoanInstallment({ balance = 0, weeklyDiscount = 0, paidWeeklyPeriodIds = [] } = {}, weeklyPeriodId) {
  const period = weeklyPeriodFromId(weeklyPeriodId).id;
  const currentBalance = positiveMoney(balance);
  if (!shouldApplyLoanInstallment(paidWeeklyPeriodIds, period) || currentBalance === 0) {
    return Object.freeze({ applied:false, duplicate:true, weeklyPeriodId:period, amount:0, previousBalance:currentBalance, newBalance:currentBalance });
  }
  const amount = Math.min(currentBalance, positiveMoney(weeklyDiscount));
  return Object.freeze({ applied:amount > 0, duplicate:false, weeklyPeriodId:period, amount, previousBalance:currentBalance, newBalance:roundMoney(currentBalance - amount) });
}

export function previousWeeklyPeriod(period, timeZone = DEFAULT_TIMEZONE) {
  const current = typeof period === "string" ? weeklyPeriodFromId(period, timeZone) : period;
  return weeklyPeriodFromDate(new Date(current.startMs - 1), timeZone);
}

export function buildClosureId(driverUid, weeklyPeriodId) {
  const uid = text(driverUid).replace(/[^a-zA-Z0-9_-]/g, "_");
  const period = weeklyPeriodFromId(weeklyPeriodId).id;
  if (!uid) throw Object.assign(new Error("driverUid requerido."), { code:"WEEKLY_DRIVER_UID_REQUIRED" });
  return `${uid}_${period}`;
}

export function normalizePaymentMethod(value) {
  const normalized = token(value);
  if (["cash","efectivo","contado","en_efectivo"].includes(normalized)) return "cash";
  if (["transfer","transferencia","bank_transfer","transferencia_bancaria","cbu","cvu","cuenta_bancaria","banco"].includes(normalized)) return "transfer";
  if (["alias","transfer_alias","alias_transfer","transferencia_alias","alias_bancario"].includes(normalized)) return "alias";
  // v2.4.40: si un método combina Mercado Pago + POSNET, debe auditarse como tarjeta/POSNET.
  if (["card","tarjeta","credit_card","debit_card","credito","debito","tarjeta_credito","tarjeta_debito","posnet","posnet_debito","posnet_credito","mp_posnet","mercado_pago_posnet","mercadopago_posnet"].includes(normalized) || normalized.includes("posnet")) return "card";
  if (["qr","mercadopago_qr","mp_qr","pago_qr","mercado_pago","mercadopago","mp","wallet","billetera","billetera_virtual","link_pago","link_de_pago"].includes(normalized)) return "qr";
  return normalized ? "unknown" : "unknown";
}

export function dedupeRows(rows = [], idResolver = row => row?.operationId || row?.id) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = text(idResolver(row));
    if (!id || map.has(id)) continue;
    map.set(id, row);
  }
  return [...map.values()];
}

export function settlementFields(netValue) {
  const net = Math.abs(roundMoney(netValue)) <= MONEY_EPSILON ? 0 : roundMoney(netValue);
  const amount = Math.abs(net);
  if (net > 0) return Object.freeze({ netSettlementToDriver:net, settlementAmount:amount, settlementToDriver:amount, settlementToAdmin:0, payerRole:"admin", payeeRole:"driver", direction:"admin_to_driver", davidDebe:amount, choferDebe:0, balanced:false });
  if (net < 0) return Object.freeze({ netSettlementToDriver:net, settlementAmount:amount, settlementToDriver:0, settlementToAdmin:amount, payerRole:"driver", payeeRole:"admin", direction:"driver_to_admin", davidDebe:0, choferDebe:amount, balanced:false });
  return Object.freeze({ netSettlementToDriver:0, settlementAmount:0, settlementToDriver:0, settlementToAdmin:0, payerRole:null, payeeRole:null, direction:"balanced", davidDebe:0, choferDebe:0, balanced:true });
}

export function calculateSettlement(source = {}) {
  const grossBilling = positiveMoney(source.grossBilling ?? source.totalFacturado ?? source.facturacion);
  // La participación base es canónica e inmutable. Se ignoran porcentajes, metas y
  // derechos históricos que pudieran haber sido guardados por versiones anteriores.
  const driverBasePercentage = DRIVER_BASE_PERCENTAGE;
  const driverBaseShare = roundMoney(grossBilling * DRIVER_BASE_RATE);
  const derivationBonusAmount = positiveMoney(source.derivationBonusAmount ?? source.bonoDerivacionEstimado);
  const collaborationAmount = positiveMoney(source.collaborationAmount ?? source.aporteAlBono);
  const repairFundRate = REPAIR_FUND_RATE;
  const repairFundAmount = source.repairFundAmount !== undefined || source.cajaChicaReparaciones !== undefined
    ? positiveMoney(source.repairFundAmount ?? source.cajaChicaReparaciones)
    : roundMoney(grossBilling * repairFundRate);
  const operationalLoanDriverShare = positiveMoney(source.operationalLoanDriverShare ?? source.prestamos);

  // Los gastos no son un reintegro. Se descuenta del efectivo lo que el chofer ya pagó
  // y luego se divide el gasto total al 50/50 para calcular el derecho económico real.
  const declaredExpenses = positiveMoney(source.totalExpenses ?? source.gastos ?? source.expenseTotal ?? source.totalGastos);
  const legacyDriverPaid = source.driverExpenseCredit !== undefined ? roundMoney(positiveMoney(source.driverExpenseCredit) / SHARED_EXPENSE_RATE) : 0;
  const legacyAdminShare = source.adminExpenseCredit !== undefined
    ? Math.max(0, roundMoney(positiveMoney(source.adminExpenseCredit) - operationalLoanDriverShare))
    : 0;
  const legacyAdminPaid = roundMoney(legacyAdminShare / SHARED_EXPENSE_RATE);
  let driverPaidSharedExpenses = Math.max(
    positiveMoney(source.driverPaidSharedExpenses ?? source.driverPaidExpenses),
    legacyDriverPaid
  );
  let adminPaidSharedExpenses = Math.max(
    positiveMoney(source.adminPaidSharedExpenses ?? source.adminPaidExpenses),
    legacyAdminPaid
  );
  const knownExpenses = roundMoney(driverPaidSharedExpenses + adminPaidSharedExpenses);
  if (declaredExpenses > knownExpenses) driverPaidSharedExpenses = roundMoney(driverPaidSharedExpenses + declaredExpenses - knownExpenses);
  const totalSharedExpenses = roundMoney(Math.max(declaredExpenses, driverPaidSharedExpenses + adminPaidSharedExpenses));
  const driverSharedExpenseShare = roundMoney(totalSharedExpenses * SHARED_EXPENSE_RATE);
  const cashCollectedByDriver = positiveMoney(source.cashCollectedByDriver ?? source.efectivo);
  const driverFundsAfterExpenses = roundMoney(cashCollectedByDriver - driverPaidSharedExpenses);
  const driverEntitlementBeforeExpenses = roundMoney(driverBaseShare + derivationBonusAmount - collaborationAmount);
  const profitAfterSharedExpenses = roundMoney(grossBilling - totalSharedExpenses);
  const driverProfitShare = Math.ceil(profitAfterSharedExpenses / 2);
  const exploraProfitShare = roundMoney(profitAfterSharedExpenses - driverProfitShare);
  const driverEntitlementAfterSharedExpenses = roundMoney(driverProfitShare + derivationBonusAmount - collaborationAmount);

  // Se conservan estos campos sólo por compatibilidad con snapshots anteriores. Ya no
  // representan créditos ni reintegros visibles en la interfaz.
  const driverExpenseCredit = roundMoney(driverPaidSharedExpenses * SHARED_EXPENSE_RATE);
  const adminExpenseCredit = roundMoney(adminPaidSharedExpenses * SHARED_EXPENSE_RATE + operationalLoanDriverShare);
  const directDebtInstallmentTotal = positiveMoney(source.directDebtInstallmentTotal ?? source.multas ?? source.driverDebtTotal);
  const exploreLoanDiscount = positiveMoney(source.exploreLoanDiscount ?? source.prestamoExplora);
  const otherSignedAdjustments = roundMoney(source.otherSignedAdjustments ?? source.otrosAjustesFirmados ?? 0);
  const dailyRankingBonusAmount = positiveMoney(source.dailyRankingBonusAmount ?? source.dailyBonusAmount ?? source.bonosDiarios);
  const netSettlementBeforeDailyBonuses = roundMoney(
    driverEntitlementAfterSharedExpenses - driverFundsAfterExpenses
    - operationalLoanDriverShare - directDebtInstallmentTotal - exploreLoanDiscount
    - repairFundAmount + otherSignedAdjustments
  );
  const net = roundMoney(netSettlementBeforeDailyBonuses + dailyRankingBonusAmount);
  return Object.freeze({
    grossBilling, driverBasePercentage, driverBaseShare, derivationBonusAmount,
    collaborationAmount, repairFundRate, repairFundAmount,
    driverFinalEntitlement:driverEntitlementBeforeExpenses,
    profitAfterSharedExpenses, driverProfitShare, exploraProfitShare,
    driverEntitlementBeforeExpenses, driverEntitlementAfterSharedExpenses,
    cashCollectedByDriver, driverPaidSharedExpenses, adminPaidSharedExpenses,
    totalSharedExpenses, driverSharedExpenseShare, driverFundsAfterExpenses,
    driverExpenseCredit, adminExpenseCredit, operationalLoanDriverShare,
    directDebtInstallmentTotal, exploreLoanDiscount, otherSignedAdjustments,
    dailyRankingBonusAmount, netSettlementBeforeDailyBonuses, ...settlementFields(net)
  });
}

export function settlementPresentation(snapshot = {}) {
  const settlement = snapshot.netSettlementToDriver === undefined ? calculateSettlement(snapshot) : settlementFields(snapshot.netSettlementToDriver);
  if (settlement.balanced) return Object.freeze({ status:"balanced", title:"AL DÍA", detail:"La cuenta está equilibrada.", amount:0, payerRole:null, payeeRole:null, requiresProof:false });
  if (settlement.payerRole === "driver") return Object.freeze({ status:"proof_required", title:"EL CHOFER PAGA A DAVID", detail:`El chofer debe pagar $${Math.round(settlement.settlementAmount).toLocaleString("es-AR")} a David.`, amount:settlement.settlementAmount, payerRole:"driver", payeeRole:"admin", requiresProof:true });
  return Object.freeze({ status:"proof_required", title:"DAVID PAGA AL CHOFER", detail:`David debe pagar $${Math.round(settlement.settlementAmount).toLocaleString("es-AR")} al chofer.`, amount:settlement.settlementAmount, payerRole:"admin", payeeRole:"driver", requiresProof:true });
}

export function resolveClosureState({ snapshot = {}, record = {} } = {}) {
  const settlement = snapshot.netSettlementToDriver === undefined ? calculateSettlement(snapshot) : settlementFields(snapshot.netSettlementToDriver);
  if (record.error === true || token(record.status) === "error") return "error";
  if (settlement.balanced) return "balanced";
  const receiptUrl = text(record.receiptUrl || record.comprobanteUrl || record.driverReceiptUrl || record.adminReceiptUrl || record.davidReceiptUrl);
  const status = token(record.status || record.closureStatus || record.paymentStatus || record.receiptStatus || record.estadoComprobante);
  if (record.paid === true || record.pagado === true || status === "paid") return receiptUrl ? "paid" : "proof_required";
  if (["under_review","en_revision"].includes(status)) return receiptUrl ? "under_review" : "proof_required";
  if (["proof_uploaded","uploaded","cargado","accepted","approved"].includes(status)) return receiptUrl ? "proof_uploaded" : "proof_required";
  if (["proof_uploading","uploading","subiendo"].includes(status)) return "proof_uploading";
  return "proof_required";
}

export function validateSnapshot(snapshot = {}) {
  const errors = [];
  const add = (code, field, message) => errors.push({ code, field, message });
  if (!text(snapshot.driverUid)) add("WEEKLY_DRIVER_UID_REQUIRED", "driverUid", "Falta driverUid.");
  try { weeklyPeriodFromId(snapshot.weeklyPeriodId || snapshot.periodId); } catch (error) { add(error.code || "WEEKLY_INVALID_PERIOD", "weeklyPeriodId", error.message); }
  const moneyFields = ["grossBilling","cashCollectedByDriver","transferCollectedByAdmin","aliasCollectedByAdmin","cardCollectedByAdmin","qrCollectedByAdmin","repairFundAmount","dailyRankingBonusAmount","netSettlementBeforeDailyBonuses","netSettlementToDriver","settlementAmount"];
  for (const field of moneyFields) if (!Number.isFinite(Number(snapshot[field]))) add("WEEKLY_INVALID_MONEY", field, "Monto no finito.");
  const unknownPaymentMethodTotal = positiveMoney(snapshot.unknownPaymentMethodTotal);
  const methods = positiveMoney(snapshot.cashCollectedByDriver) + positiveMoney(snapshot.transferCollectedByAdmin) + positiveMoney(snapshot.aliasCollectedByAdmin) + positiveMoney(snapshot.cardCollectedByAdmin) + positiveMoney(snapshot.qrCollectedByAdmin) + positiveMoney(snapshot.otherCollectedByDriver) + positiveMoney(snapshot.otherCollectedByAdmin) + unknownPaymentMethodTotal;
  if (unknownPaymentMethodTotal > MONEY_EPSILON) add("WEEKLY_UNKNOWN_PAYMENT_METHOD", "paymentMethods", "Hay cobros con medio de pago desconocido. Revisar antes de cerrar.");
  if (Math.abs(methods - positiveMoney(snapshot.grossBilling)) > MONEY_EPSILON) add("WEEKLY_PAYMENT_METHOD_MISMATCH", "paymentMethods", "La suma de medios de pago no coincide con la facturación.");
  const expected = settlementFields(snapshot.netSettlementToDriver);
  for (const field of ["settlementAmount","payerRole","payeeRole","direction","balanced"]) if (snapshot[field] !== expected[field]) add("WEEKLY_SETTLEMENT_MISMATCH", field, "El resultado no coincide con el saldo firmado.");
  const ids = Array.isArray(snapshot.sourceOperationIds) ? snapshot.sourceOperationIds : [];
  if (ids.length !== new Set(ids).size) add("WEEKLY_DUPLICATE_OPERATION", "sourceOperationIds", "Hay operaciones duplicadas.");
  if (snapshot.snapshotComplete !== true) add("WEEKLY_INCOMPLETE_SNAPSHOT", "snapshotComplete", "Las fuentes no terminaron de reconstruirse.");
  return Object.freeze({ valid:errors.length === 0, errors });
}

export function isFalseZeroClosure(existing = {}, rebuilt = {}) {
  const existingGross = positiveMoney(existing.grossBilling ?? existing.weeklySnapshot?.grossBilling);
  const existingMethods = positiveMoney(existing.cashCollectedByDriver ?? existing.weeklySnapshot?.cashCollectedByDriver)
    + positiveMoney(existing.transferCollectedByAdmin ?? existing.weeklySnapshot?.transferCollectedByAdmin)
    + positiveMoney(existing.aliasCollectedByAdmin ?? existing.weeklySnapshot?.aliasCollectedByAdmin)
    + positiveMoney(existing.cardCollectedByAdmin ?? existing.weeklySnapshot?.cardCollectedByAdmin)
    + positiveMoney(existing.qrCollectedByAdmin ?? existing.weeklySnapshot?.qrCollectedByAdmin);
  const rebuiltGross = positiveMoney(rebuilt.grossBilling);
  const existingMismatch = Math.abs(existingMethods - existingGross) > MONEY_EPSILON;
  return rebuiltGross > 0 && (existingGross === 0 || existingMethods === 0 || existingMismatch);
}

export function shouldAcceptAsyncResult(request, current) {
  return Boolean(request && current && request.driverUid === current.driverUid && request.weeklyPeriodId === current.weeklyPeriodId && request.generation === current.generation);
}

export function anchoredNow({ serverMs, clientMs }, currentClientMs) {
  if (!Number.isFinite(Number(serverMs)) || !Number.isFinite(Number(clientMs)) || !Number.isFinite(Number(currentClientMs))) throw Object.assign(new Error("Ancla de servidor inválida."), { code:"WEEKLY_CLOCK_ANCHOR_INVALID" });
  return new Date(Number(serverMs) + (Number(currentClientMs) - Number(clientMs)));
}

export function stableStringify(value) {
  const seen = new WeakSet();
  const walk = input => {
    if (input === null || typeof input !== "object") return input;
    if (input instanceof Date) return input.toISOString();
    if (typeof input.toMillis === "function") return input.toMillis();
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(walk);
    return Object.keys(input).sort().reduce((out, key) => { if (input[key] !== undefined) out[key] = walk(input[key]); return out; }, {});
  };
  return JSON.stringify(walk(value));
}
