export const VEHICLE_COMPLIANCE_VERSION = "v2.2.2-mi-auto";
export const DEFAULT_SERVICE_INTERVAL_KM = 10000;
export const DOCUMENT_WARNING_DAYS = 5;
export const SERVICE_WARNING_KM = 500;
export const OPERATIONAL_TIMEZONE = "America/Argentina/Cordoba";

const DAY_MS = 86400000;

export function finiteNonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "string" ? value.replace(/\./g, "").replace(",", ".").trim() : value;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function integerKm(value) {
  const number = finiteNonNegativeNumber(value);
  return number === null ? null : Math.round(number);
}

export function formatKm(value) {
  const number = integerKm(value);
  return number === null ? "—" : `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(number)} km`;
}

export function operationalDateKey(value = new Date(), timeZone = OPERATIONAL_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function normalizeDateKey(value, timeZone = OPERATIONAL_TIMEZONE) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") {
    const text = value.trim();
    const exact = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (exact) return isValidDateKey(text) ? text : "";
    const latin = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (latin) {
      const key = `${latin[3]}-${String(latin[2]).padStart(2, "0")}-${String(latin[1]).padStart(2, "0")}`;
      return isValidDateKey(key) ? key : "";
    }
  }
  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  return operationalDateKey(date, timeZone);
}

export function isValidDateKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function dateKeyToUtcMs(value) {
  if (!isValidDateKey(value)) return NaN;
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function formatDateKey(value) {
  if (!isValidDateKey(value)) return "—";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

export function documentComplianceStatus(expiryValue, operationalNow = new Date(), timeZone = OPERATIONAL_TIMEZONE) {
  const expiryDateKey = normalizeDateKey(expiryValue, timeZone);
  if (!expiryDateKey) return Object.freeze({ code: "missing", label: "Pendiente de completar", icon: "", daysRemaining: null, expiryDateKey: "" });
  const todayKey = operationalDateKey(operationalNow, timeZone);
  const daysRemaining = Math.round((dateKeyToUtcMs(expiryDateKey) - dateKeyToUtcMs(todayKey)) / DAY_MS);
  if (daysRemaining < 0) return Object.freeze({ code: "expired", label: "Vencido", icon: "🔴", daysRemaining, expiryDateKey });
  if (daysRemaining <= DOCUMENT_WARNING_DAYS) return Object.freeze({ code: "warning", label: "Por vencer", icon: "🟡", daysRemaining, expiryDateKey });
  return Object.freeze({ code: "ok", label: "Al día", icon: "🟢", daysRemaining, expiryDateKey });
}

export function serviceComplianceStatus({ currentKm, lastServiceKm, nextServiceKm, intervalKm = DEFAULT_SERVICE_INTERVAL_KM } = {}) {
  const current = integerKm(currentKm);
  const last = integerKm(lastServiceKm);
  const configuredInterval = integerKm(intervalKm) || DEFAULT_SERVICE_INTERVAL_KM;
  const explicitNext = integerKm(nextServiceKm);
  const next = explicitNext ?? (last === null ? null : last + configuredInterval);
  if (current === null || last === null || next === null) {
    return Object.freeze({ code: "missing", label: "Pendiente de completar", icon: "", currentKm: current, lastServiceKm: last, nextServiceKm: next, intervalKm: configuredInterval, remainingKm: null });
  }
  const remainingKm = next - current;
  if (remainingKm <= 0) return Object.freeze({ code: "expired", label: "Vencido", icon: "🔴", currentKm: current, lastServiceKm: last, nextServiceKm: next, intervalKm: configuredInterval, remainingKm });
  if (remainingKm <= SERVICE_WARNING_KM) return Object.freeze({ code: "warning", label: "Por vencer", icon: "🟡", currentKm: current, lastServiceKm: last, nextServiceKm: next, intervalKm: configuredInterval, remainingKm });
  return Object.freeze({ code: "ok", label: "Al día", icon: "🟢", currentKm: current, lastServiceKm: last, nextServiceKm: next, intervalKm: configuredInterval, remainingKm });
}

export function overallComplianceStatus(statuses = []) {
  const normalized = statuses.filter(Boolean);
  const expired = normalized.filter(item => item.code === "expired").length;
  const warning = normalized.filter(item => item.code === "warning").length;
  const missing = normalized.filter(item => item.code === "missing").length;
  if (expired > 0) return Object.freeze({ code: "expired", label: expired === 1 ? "1 vencido" : `${expired} vencidos`, fullLabel: "Hay elementos vencidos", count: expired, missing });
  if (warning > 0) return Object.freeze({ code: "warning", label: warning === 1 ? "1 por vencer" : `${warning} por vencer`, fullLabel: "Hay elementos por vencer", count: warning, missing });
  if (missing > 0 || normalized.length === 0) return Object.freeze({ code: "pending", label: "Estado pendiente de completar", fullLabel: "Estado pendiente de completar", count: missing, missing });
  return Object.freeze({ code: "ok", label: "Todo al día", fullLabel: "Todo al día", count: 0, missing: 0 });
}

export function sameStoredValue(type, currentValue, nextValue) {
  if (type === "number") return integerKm(currentValue) === integerKm(nextValue);
  if (type === "date") return normalizeDateKey(currentValue) === normalizeDateKey(nextValue);
  return String(currentValue ?? "") === String(nextValue ?? "");
}
