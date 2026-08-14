const { prisma: defaultPrisma } = require("../../../db");

function toSafeInteger(value) {
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function buildGetProfileStats(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;

  return async function getProfileStats({
    userId,
    today,
    weekStart,
    monthStart,
    yearStart,
  }) {
    const rows = await prisma.$queryRaw`
      WITH RECURSIVE
      bounds AS (
        SELECT
          ${today}::date AS today,
          ${weekStart}::date AS week_start,
          ${monthStart}::date AS month_start,
          ${yearStart}::date AS year_start
      ),
      totals AS (
        SELECT
          COALESCE(SUM(s.steps) FILTER (WHERE s.date >= b.week_start), 0)::bigint AS this_week,
          COALESCE(SUM(s.steps) FILTER (WHERE s.date >= b.month_start), 0)::bigint AS this_month,
          COALESCE(SUM(s.steps) FILTER (WHERE s.date >= b.year_start), 0)::bigint AS this_year,
          COALESCE(SUM(s.steps), 0)::bigint AS all_time,
          COUNT(*) FILTER (WHERE s.date >= b.week_start)::bigint AS week_days,
          COUNT(*) FILTER (WHERE s.date >= b.month_start)::bigint AS month_days,
          COUNT(*) FILTER (WHERE s.date >= b.year_start)::bigint AS year_days,
          COALESCE(MAX(s.steps) FILTER (WHERE s.date = b.today), 0)::bigint AS today_steps
        FROM bounds b
        LEFT JOIN steps s ON s.user_id = ${userId}
        GROUP BY b.today
      ),
      streak(day, length) AS (
        SELECT b.today - 1, 0::bigint
        FROM bounds b
        UNION ALL
        SELECT streak.day - 1, streak.length + 1
        FROM streak
        JOIN steps s
          ON s.user_id = ${userId}
         AND s.date = streak.day
         AND s.steps > 0
      )
      SELECT
        totals.*,
        (SELECT COALESCE(MAX(length), 0) FROM streak)::bigint AS prior_streak
      FROM totals
    `;
    const row = rows[0] || {};
    const thisWeek = toSafeInteger(row.this_week);
    const thisMonth = toSafeInteger(row.this_month);
    const thisYear = toSafeInteger(row.this_year);
    const weekDays = toSafeInteger(row.week_days);
    const monthDays = toSafeInteger(row.month_days);
    const yearDays = toSafeInteger(row.year_days);
    return {
      contract: "profile-stats-v1",
      thisWeek,
      thisMonth,
      thisYear,
      allTime: toSafeInteger(row.all_time),
      avgPerDayWeek: weekDays > 0 ? Math.round(thisWeek / weekDays) : 0,
      avgPerDayMonth: monthDays > 0 ? Math.round(thisMonth / monthDays) : 0,
      avgPerDayYear: yearDays > 0 ? Math.round(thisYear / yearDays) : 0,
      streak:
        toSafeInteger(row.prior_streak) +
        (toSafeInteger(row.today_steps) > 0 ? 1 : 0),
    };
  };
}

const getProfileStats = buildGetProfileStats();

module.exports = { buildGetProfileStats, getProfileStats, toSafeInteger };
