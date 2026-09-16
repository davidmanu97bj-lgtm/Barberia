import {
  DEFAULT_TIMEZONE,
  WEEK_MS,
  weeklyPeriodFromDate,
  weeklyPeriodFromId,
  weeklyScopeFromPeriod
} from "../core/weekly-core.mjs?v2442-weekly-payment-production";

(() => {
  "use strict";
  if (window.ExploraWeeklyPeriods) return;
  const text = value => String(value ?? "").trim();
  const fromDate = date => weeklyPeriodFromDate(date || window.ExploraFirestoreClock?.getNow?.() || new Date(), DEFAULT_TIMEZONE);
  const fromId = id => {
    try { return weeklyPeriodFromId(id, DEFAULT_TIMEZONE); }
    catch (_) { return null; }
  };
  const scopeFor = input => weeklyScopeFromPeriod(input || fromDate(), DEFAULT_TIMEZONE);
  const contains = (scope, row, dateMs = 0) => {
    const target = scopeFor(scope);
    const periodId = text(row?.weeklyPeriodIdCompleted || row?.weeklyPeriodId || row?.periodoSemanalId || row?.periodoId);
    if (periodId) return periodId === target.weeklyPeriodId;
    const ms = Number(dateMs || 0);
    return ms > 0 && ms >= target.startMs && ms <= target.endMs;
  };
  /* Solo lectura de documentos heredados. No participa en cálculos ni escrituras nuevas. */
  const legacyFourWeekIdsForRead = periodId => {
    const period = fromId(periodId);
    if (!period) return [];
    const epoch = weeklyPeriodFromId("2026-01-03", DEFAULT_TIMEZONE);
    const index = Math.floor((period.startMs - epoch.startMs) / (4 * WEEK_MS));
    const start = weeklyPeriodFromDate(new Date(epoch.startMs + index * 4 * WEEK_MS), DEFAULT_TIMEZONE);
    const end = weeklyPeriodFromDate(new Date(start.startMs + 3 * WEEK_MS), DEFAULT_TIMEZONE);
    return [`cycle_${start.id}_${end.id}`, `week_${period.id}`];
  };
  window.ExploraWeeklyPeriods = Object.freeze({
    TZ:DEFAULT_TIMEZONE, WEEK_MS, fromDate, fromId, active:fromDate, scopeFor, contains,
    legacyFourWeekIdsForRead
  });
})();
