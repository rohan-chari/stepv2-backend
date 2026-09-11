const { addDaysToDateString, parseDateString, zonedDateTimeToUtc } = require('../../../shared/time/week');

function computeSummaryExpiresAt({ localDate, timezone }) {
  try {
    if (typeof localDate !== "string" || typeof timezone !== "string") return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null;
    const original = parseDateString(localDate);
    const probe = new Date(Date.UTC(original.year, original.month - 1, original.day));
    if (
      probe.getUTCFullYear() !== original.year ||
      probe.getUTCMonth() + 1 !== original.month ||
      probe.getUTCDate() !== original.day
    ) return null;
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    const nextDate = addDaysToDateString(localDate, 1);
    const parts = parseDateString(nextDate);
    if (!parts) return null;
    const result = zonedDateTimeToUtc({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      second: 0,
    }, timezone);
    return Number.isFinite(result?.getTime()) ? result : null;
  } catch {
    return null;
  }
}

module.exports = { computeSummaryExpiresAt };
