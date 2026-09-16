export const DAILY_RANKING_VERSION = "v2.4.40-weekly-closure-cash-record-recovery";
export const DAILY_RANKING_BONUS_AMOUNT = 5000;
export const DAILY_RANKING_BONUS_CURRENCY = "ARS";
export const DAILY_RANKING_BONUS_DIRECTION = "DRIVER_CREDIT";
export const DAILY_RANKING_TIE_BREAK_RULE = "gross_billing_desc>service_count_desc>first_reached_at_asc>driver_id_asc";
export const DAILY_RANKING_TIMEZONE = "America/Argentina/Cordoba";

const DAY_MS = 24 * 60 * 60 * 1000;
const text = value => String(value ?? "").trim();
export function normalizeDailyMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const raw = value.trim().replace(/\s/g, "").replace(/\$/g, "");
  if (!raw) return 0;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : /^-?\d{1,3}(?:\.\d{3})+$/.test(raw)
      ? raw.replace(/\./g, "")
      : raw;
  const parsed = Number(normalized.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
const finite = value => normalizeDailyMoney(value);
const nonNegative = value => Math.max(0, finite(value));
const roundMoney = value => Math.round(finite(value) * 100) / 100;
const uidOf = row => text(row?.driverId || row?.driverUid || row?.choferUid || row?.uid || row?.id);
const nameOf = row => text(row?.driverName || row?.choferName || row?.name || row?.nombre || row?.nombreChofer || "Chofer");
const avatarOf = row => text(row?.driverAvatar || row?.avatar || row?.photoURL || row?.avatarUrl || row?.fotoPerfil);
const amountOf = row => nonNegative(row?.dailyAmount ?? row?.grossBilling ?? row?.totalFacturado ?? row?.facturacion ?? row?.amount ?? row?.monto ?? row?.valor ?? row?.finalPrice);
const countOf = row => Math.max(0, Math.trunc(finite(row?.serviceCount ?? row?.cantidadServicios ?? row?.billingCount ?? row?.services)));
const timestampMs = value => {
  if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  const ms = value?.toMillis?.() ?? value?.toDate?.()?.getTime?.() ?? value?.seconds * 1000 ?? (value ? new Date(value).getTime() : NaN);
  return Number.isFinite(ms) && ms > 0 ? ms : Number.MAX_SAFE_INTEGER;
};
const reachedAtOf = row => {
  for (const candidate of [row?.reachedAtMs,row?.firstReachedAtMs,row?.lastServiceAtMs,row?.updatedAtMs,row?.createdAtMs,row?.reachedAt,row?.lastServiceAt,row?.updatedAt,row?.createdAt]) {
    const ms = timestampMs(candidate);
    if (ms !== Number.MAX_SAFE_INTEGER) return ms;
  }
  return Number.MAX_SAFE_INTEGER;
};

function argentinaDateParts(date, timeZone = DAILY_RANKING_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(date instanceof Date ? date : new Date(date));
  const read = type => parts.find(part => part.type === type)?.value || "";
  return { year:read("year"), month:read("month"), day:read("day") };
}

export function operationalDayIdFromDate(value = new Date(), timeZone = DAILY_RANKING_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error("Fecha operativa inválida."), { code:"DAILY_RANKING_INVALID_DATE" });
  const { year, month, day } = argentinaDateParts(date,timeZone);
  if (!year || !month || !day) throw Object.assign(new Error("No se pudo construir el día operativo."), { code:"DAILY_RANKING_DAY_ID_FAILED" });
  return `${year}-${month}-${day}`;
}

export function addOperationalDays(dayId, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(dayId));
  if (!match) throw Object.assign(new Error("Día operativo inválido."), { code:"DAILY_RANKING_INVALID_DAY_ID" });
  const date = new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])) + Math.trunc(finite(days)) * DAY_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}-${String(date.getUTCDate()).padStart(2,"0")}`;
}

export function compareDailyRankingRows(a = {}, b = {}) {
  const amountDifference = amountOf(b) - amountOf(a);
  if (amountDifference) return amountDifference;
  const serviceDifference = countOf(b) - countOf(a);
  if (serviceDifference) return serviceDifference;
  const reachedDifference = reachedAtOf(a) - reachedAtOf(b);
  if (reachedDifference) return reachedDifference;
  return uidOf(a).localeCompare(uidOf(b), "es", { sensitivity:"base", numeric:true });
}

export function dailyLeadPercentage(firstAmount, secondAmount) {
  const first = nonNegative(firstAmount);
  const second = nonNegative(secondAmount);
  if (!(first > 0) || !(second > 0)) return null;
  const percentage = ((first - second) / second) * 100;
  return Number.isFinite(percentage) ? Math.max(0,Math.round(percentage * 10) / 10) : null;
}

export function formatDailyLeadPercentage(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return "";
  return new Intl.NumberFormat("es-AR", { minimumFractionDigits:0, maximumFractionDigits:1 }).format(Number(value));
}

export function dailyLeaderCurrentMessage(result = {}) {
  if (!result?.hasLeader) return "Calculando ranking actual...";
  const runnerUpAmount = nonNegative(result.runnerUpDailyAmount);
  const lead = result.winnerLeadPercentage !== null && result.winnerLeadPercentage !== undefined
    ? Number(result.winnerLeadPercentage)
    : dailyLeadPercentage(result.winnerDailyAmount,runnerUpAmount);
  if (runnerUpAmount > 0 && Number.isFinite(lead)) return `LÍDER ACTUAL · +${formatDailyLeadPercentage(lead)}% SOBRE EL 2.º`;
  return "LÍDER ACTUAL · SIN 2.º AÚN";
}

export function determineDailyLeaderReason(winner = {}, runnerUp = null) {
  if (!runnerUp) return "single_activity";
  if (Math.abs(amountOf(winner)-amountOf(runnerUp)) > 0.005) return "gross_billing";
  if (countOf(winner) !== countOf(runnerUp)) return "service_count_tiebreak";
  if (reachedAtOf(winner) !== reachedAtOf(runnerUp)) return "first_reached_tiebreak";
  return "driver_id_tiebreak";
}

export function buildDailyLeaderResult(rows = [], operationalDayId = "", weeklyPeriodId = "") {
  const eligible = (Array.isArray(rows) ? rows : [])
    .filter(row => uidOf(row) && amountOf(row) > 0 && countOf(row) > 0)
    .slice()
    .sort(compareDailyRankingRows);
  const winner = eligible[0] || null;
  const runnerUp = eligible[1] || null;
  if (!winner) {
    return Object.freeze({
      operationalDayId:text(operationalDayId), weeklyPeriodId:text(weeklyPeriodId), hasLeader:false, status:"empty",
      message:"TODAVÍA NO HAY ACTIVIDAD VÁLIDA HOY", winner:null, runnerUp:null,
      winnerDriverId:"", winnerDriverName:"", winnerDriverAvatar:"", winnerDailyAmount:0,
      runnerUpDailyAmount:0, winnerServiceCount:0, winnerReachedAtMs:0, winnerLeadPercentage:null,
      leaderReason:"no_activity", tieBreakApplied:false, tieBreakRule:DAILY_RANKING_TIE_BREAK_RULE,
      activeDriverCount:0, bonusAmount:0
    });
  }
  const reason = determineDailyLeaderReason(winner,runnerUp);
  const tieBreakApplied = reason.endsWith("_tiebreak");
  const lead = runnerUp ? dailyLeadPercentage(amountOf(winner),amountOf(runnerUp)) : null;
  const message = runnerUp
    ? `LÍDER ACTUAL · +${formatDailyLeadPercentage(lead ?? 0)}% SOBRE EL 2.º`
    : "LÍDER ACTUAL · SIN 2.º AÚN";
  return Object.freeze({
    operationalDayId:text(operationalDayId), weeklyPeriodId:text(weeklyPeriodId), hasLeader:true,
    status:tieBreakApplied ? "tiebreak" : !runnerUp ? "single" : "lead", message,
    winner, runnerUp, winnerDriverId:uidOf(winner), winnerDriverName:nameOf(winner), winnerDriverAvatar:avatarOf(winner),
    winnerDailyAmount:amountOf(winner), runnerUpDailyAmount:amountOf(runnerUp), winnerServiceCount:countOf(winner),
    winnerReachedAtMs:reachedAtOf(winner) === Number.MAX_SAFE_INTEGER ? 0 : reachedAtOf(winner),
    winnerLeadPercentage:lead, leaderReason:reason, tieBreakApplied, tieBreakRule:DAILY_RANKING_TIE_BREAK_RULE,
    activeDriverCount:eligible.length, bonusAmount:DAILY_RANKING_BONUS_AMOUNT
  });
}

export function dailyRankingBonusId(operationalDayId) {
  const day = text(operationalDayId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  return day;
}

export function dailyRankingBonusIdempotencyKey(operationalDayId) {
  const id = dailyRankingBonusId(operationalDayId);
  return id ? `daily-ranking-bonus:${id}` : "";
}

export function dailyRankingBonusDocument(result = {}) {
  const dayId = dailyRankingBonusId(result.operationalDayId);
  if (!dayId) throw Object.assign(new Error("Falta operationalDayId."), { code:"DAILY_RANKING_DAY_REQUIRED" });
  const hasLeader = Boolean(result.hasLeader && result.winnerDriverId);
  return Object.freeze({
    bonusId:dayId, idempotencyKey:dailyRankingBonusIdempotencyKey(dayId), operationalDayId:dayId,
    weeklyPeriodId:text(result.weeklyPeriodId), status:hasLeader ? "finalized" : "no_activity",
    winnerDriverId:hasLeader ? text(result.winnerDriverId) : "", winnerDriverName:hasLeader ? text(result.winnerDriverName) : "",
    winnerDriverAvatar:hasLeader ? text(result.winnerDriverAvatar) : "", bonusAmount:hasLeader ? DAILY_RANKING_BONUS_AMOUNT : 0,
    bonusCurrency:DAILY_RANKING_BONUS_CURRENCY, bonusDirection:DAILY_RANKING_BONUS_DIRECTION,
    leaderReason:text(result.leaderReason || (hasLeader ? "gross_billing" : "no_activity")),
    winnerDailyAmount:hasLeader ? nonNegative(result.winnerDailyAmount) : 0,
    runnerUpDailyAmount:hasLeader ? nonNegative(result.runnerUpDailyAmount) : 0,
    winnerServiceCount:hasLeader ? Math.max(0,Math.trunc(finite(result.winnerServiceCount))) : 0,
    winnerReachedAtMs:hasLeader ? Math.max(0,finite(result.winnerReachedAtMs)) : 0,
    winnerLeadPercentage:result.winnerLeadPercentage !== null && result.winnerLeadPercentage !== undefined && Number.isFinite(Number(result.winnerLeadPercentage)) ? Number(result.winnerLeadPercentage) : null,
    tieBreakApplied:Boolean(result.tieBreakApplied), tieBreakRule:text(result.tieBreakRule || DAILY_RANKING_TIE_BREAK_RULE),
    calculationVersion:DAILY_RANKING_VERSION
  });
}

export function normalizeDailyBonusRow(row = {}) {
  const amount = nonNegative(row.bonusAmount ?? row.amount ?? row.monto);
  return Object.freeze({
    bonusId:text(row.bonusId || row.id || row.operationalDayId), operationalDayId:text(row.operationalDayId || row.dayId),
    weeklyPeriodId:text(row.weeklyPeriodId || row.periodId), winnerDriverId:text(row.winnerDriverId || row.driverId || row.driverUid),
    winnerDriverName:text(row.winnerDriverName || row.driverName || row.name || "Chofer"), winnerDriverAvatar:text(row.winnerDriverAvatar || row.driverAvatar || row.avatar),
    bonusAmount:amount, bonusCurrency:text(row.bonusCurrency || DAILY_RANKING_BONUS_CURRENCY), bonusDirection:text(row.bonusDirection || DAILY_RANKING_BONUS_DIRECTION),
    leaderReason:text(row.leaderReason || "gross_billing"), winnerDailyAmount:nonNegative(row.winnerDailyAmount ?? row.grossBilling),
    runnerUpDailyAmount:nonNegative(row.runnerUpDailyAmount), winnerServiceCount:Math.max(0,Math.trunc(finite(row.winnerServiceCount ?? row.serviceCount))),
    winnerReachedAtMs:Math.max(0,finite(row.winnerReachedAtMs ?? row.reachedAtMs)), winnerLeadPercentage:row.winnerLeadPercentage !== null && row.winnerLeadPercentage !== undefined && Number.isFinite(Number(row.winnerLeadPercentage)) ? Number(row.winnerLeadPercentage) : null,
    tieBreakApplied:Boolean(row.tieBreakApplied), tieBreakRule:text(row.tieBreakRule || DAILY_RANKING_TIE_BREAK_RULE), status:text(row.status || (amount > 0 ? "finalized" : "no_activity")),
    calculationVersion:text(row.calculationVersion || DAILY_RANKING_VERSION)
  });
}

export function dailyBonusesForDriver(rows = [], driverId = "") {
  const uid = text(driverId);
  return (Array.isArray(rows) ? rows : []).map(normalizeDailyBonusRow).filter(row => row.status === "finalized" && row.bonusAmount > 0 && row.winnerDriverId === uid).sort((a,b)=>a.operationalDayId.localeCompare(b.operationalDayId));
}

export function totalDailyBonuses(rows = []) {
  return roundMoney((Array.isArray(rows) ? rows : []).reduce((sum,row)=>sum+nonNegative(row?.bonusAmount),0));
}

export function applyDailyBonusesToNet(netSettlementBeforeBonuses, dailyBonusAmount) {
  return roundMoney(finite(netSettlementBeforeBonuses) + nonNegative(dailyBonusAmount));
}
