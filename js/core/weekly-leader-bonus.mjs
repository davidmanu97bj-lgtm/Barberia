export const WEEKLY_LEADER_BONUS_VERSION = "v2.3.0-weekly-leader-bonus";
export const WEEKLY_LEADER_BONUS_AMOUNT = 100000;
export const WEEKLY_LEADER_BONUS_CURRENCY = "ARS";
export const WEEKLY_LEADER_BONUS_DIRECTION = "DRIVER_CREDIT";
export const WEEKLY_LEADER_TIE_BREAK_RULE = "gross_billing_desc>service_count_desc>first_reached_at_asc>driver_id_asc";
export const WEEKLY_LEADER_ERROR_CODES = Object.freeze({
  read:"WEEKLY_LEADER_READ_FAILED",
  advantage:"WEEKLY_LEADER_ADVANTAGE_CALCULATION_FAILED",
  creation:"WEEKLY_LEADER_BONUS_CREATION_FAILED",
  idempotency:"WEEKLY_LEADER_BONUS_IDEMPOTENCY_FAILED",
  settlement:"WEEKLY_LEADER_BONUS_SETTLEMENT_FAILED",
  snapshot:"WEEKLY_LEADER_SNAPSHOT_FAILED"
});

const text = value => String(value ?? "").trim();
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const nonNegative = value => Math.max(0, finite(value));
const uidOf = row => text(row?.uid || row?.driverUid || row?.choferUid || row?.id);
const nameOf = row => text(row?.name || row?.driverName || row?.choferName || row?.nombre || row?.nombreChofer || "Chofer");
const grossOf = row => nonNegative(row?.grossBilling ?? row?.totalFacturado ?? row?.facturacion ?? row?.amount);
const serviceCountOf = row => Math.max(0, Math.trunc(finite(row?.serviceCount ?? row?.cantidadServicios ?? row?.billingCount ?? row?.services)));
const reachedAtOf = row => {
  const candidates = [row?.reachedAtMs,row?.updatedAtMs,row?.lastBillingAtMs,row?.firstReachedAtMs,row?.createdAtMs];
  for (const candidate of candidates) if (Number.isFinite(Number(candidate)) && Number(candidate) > 0) return Number(candidate);
  const raw = row?.reachedAt || row?.updatedAt || row?.lastBillingAt || row?.createdAt;
  const ms = raw?.toMillis?.() ?? raw?.toDate?.()?.getTime?.() ?? (raw ? new Date(raw).getTime() : NaN);
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
};

export function compareWeeklyLeaderRows(a = {}, b = {}) {
  const grossDifference = grossOf(b) - grossOf(a);
  if (grossDifference) return grossDifference;
  const serviceDifference = serviceCountOf(b) - serviceCountOf(a);
  if (serviceDifference) return serviceDifference;
  const reachedDifference = reachedAtOf(a) - reachedAtOf(b);
  if (reachedDifference) return reachedDifference;
  return uidOf(a).localeCompare(uidOf(b), "es", { sensitivity:"base", numeric:true });
}

export function calculateWeeklyLeadPercentage(firstAmount, secondAmount) {
  const first = nonNegative(firstAmount);
  const second = nonNegative(secondAmount);
  if (!(first > 0) || !(second > 0) || first < second) return null;
  const percentage = ((first - second) / second) * 100;
  if (!Number.isFinite(percentage) || percentage < 0) return null;
  return Math.round(percentage * 10) / 10;
}

export function formatWeeklyLeadPercentage(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return "";
  return new Intl.NumberFormat("es-AR", { minimumFractionDigits:0, maximumFractionDigits:1 }).format(Number(value));
}

export function buildWeeklyLeaderResult(rows = [], weeklyPeriodId = "") {
  const eligible = (Array.isArray(rows) ? rows : [])
    .filter(row => uidOf(row) && grossOf(row) > 0)
    .slice()
    .sort(compareWeeklyLeaderRows);
  const winner = eligible[0] || null;
  const runnerUp = eligible[1] || null;
  if (!winner) {
    return Object.freeze({
      weeklyPeriodId:text(weeklyPeriodId), hasLeader:false, status:"empty", message:"AÚN NO HAY LÍDER ESTA SEMANA",
      winner:null, runnerUp:null, winnerDriverId:"", winnerDriverName:"", winnerDriverAvatar:"",
      winnerWeeklyAmount:0, runnerUpWeeklyAmount:0, winnerLeadPercentage:null,
      tieBreakRule:WEEKLY_LEADER_TIE_BREAK_RULE, activeDriverCount:0
    });
  }
  const winnerAmount = grossOf(winner);
  const runnerAmount = grossOf(runnerUp);
  const tied = Boolean(runnerUp && Math.abs(winnerAmount - runnerAmount) < 0.005);
  const status = !runnerUp ? "single" : tied ? "tie" : !(runnerAmount > 0) ? "leading" : "lead";
  const lead = status === "lead" ? calculateWeeklyLeadPercentage(winnerAmount, runnerAmount) : null;
  const message = status === "single"
    ? "ÚNICO CHOFER CON ACTIVIDAD ESTA SEMANA"
    : status === "tie"
      ? "EMPATE PROVISIONAL EN EL PRIMER LUGAR"
      : status === "leading"
        ? "LIDERA LA SEMANA"
        : `${formatWeeklyLeadPercentage(lead)}% POR DELANTE DEL 2.º`;
  return Object.freeze({
    weeklyPeriodId:text(weeklyPeriodId), hasLeader:true, status, message,
    winner, runnerUp,
    winnerDriverId:uidOf(winner), winnerDriverName:nameOf(winner),
    winnerDriverAvatar:text(winner?.avatar || winner?.photoURL || winner?.avatarUrl || winner?.fotoPerfil),
    winnerWeeklyAmount:winnerAmount, runnerUpWeeklyAmount:runnerAmount,
    winnerLeadPercentage:lead, tieBreakRule:WEEKLY_LEADER_TIE_BREAK_RULE,
    activeDriverCount:eligible.length
  });
}

export function weeklyLeaderBonusIdempotencyKey(weeklyPeriodId, winnerDriverId) {
  const period = text(weeklyPeriodId).replace(/[^0-9A-Za-z_-]/g, "_");
  const uid = text(winnerDriverId).replace(/[^0-9A-Za-z_-]/g, "_");
  if (!period || !uid) return "";
  return `weekly-leader-bonus:${period}:${uid}`;
}

export function weeklyLeaderBonusForDriver(result = {}, driverUid = "", { closed = false } = {}) {
  const uid = text(driverUid);
  const winnerUid = text(result?.winnerDriverId);
  const isWinner = Boolean(result?.hasLeader && uid && winnerUid && uid === winnerUid);
  const confirmed = Boolean(closed && isWinner);
  return Object.freeze({
    weeklyPeriodId:text(result?.weeklyPeriodId), winnerDriverId:winnerUid,
    winnerDriverName:text(result?.winnerDriverName), winnerDriverAvatar:text(result?.winnerDriverAvatar),
    winnerRankingPosition:result?.hasLeader ? 1 : 0,
    winnerWeeklyAmount:nonNegative(result?.winnerWeeklyAmount), runnerUpWeeklyAmount:nonNegative(result?.runnerUpWeeklyAmount),
    winnerLeadPercentage:Number.isFinite(Number(result?.winnerLeadPercentage)) ? Number(result.winnerLeadPercentage) : null,
    weeklyLeaderBonusAmount:confirmed ? WEEKLY_LEADER_BONUS_AMOUNT : 0,
    weeklyLeaderBonusCurrency:WEEKLY_LEADER_BONUS_CURRENCY,
    weeklyLeaderBonusDirection:WEEKLY_LEADER_BONUS_DIRECTION,
    weeklyLeaderBonusStatus:confirmed ? "confirmed" : isWinner ? "pending" : result?.hasLeader ? "not_applicable" : "no_activity",
    weeklyLeaderBonusIdempotencyKey:confirmed ? weeklyLeaderBonusIdempotencyKey(result.weeklyPeriodId,winnerUid) : "",
    tieBreakRule:text(result?.tieBreakRule || WEEKLY_LEADER_TIE_BREAK_RULE),
    calculationVersion:WEEKLY_LEADER_BONUS_VERSION
  });
}

export function applyWeeklyLeaderBonusToNet(netSettlementToDriver, bonusAmount = WEEKLY_LEADER_BONUS_AMOUNT) {
  const net = finite(netSettlementToDriver);
  const bonus = nonNegative(bonusAmount);
  return Math.round((net + bonus) * 100) / 100;
}
