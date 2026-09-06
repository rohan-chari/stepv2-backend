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
      ),
      podiums AS (
        SELECT
          COUNT(*) FILTER (WHERE effective_placement = 1)::bigint AS first_count,
          COUNT(*) FILTER (WHERE effective_placement = 2)::bigint AS second_count,
          COUNT(*) FILTER (WHERE effective_placement = 3)::bigint AS third_count
        FROM (
          SELECT CASE
            WHEN r.is_team_race = TRUE AND r.winner_team IS NULL THEN NULL
            WHEN r.is_team_race = TRUE AND rp.team = r.winner_team THEN 1
            WHEN r.is_team_race = TRUE THEN 2
            ELSE rp.placement
          END AS effective_placement
          FROM race_participants rp
          JOIN races r ON r.id = rp.race_id
          WHERE rp.user_id = ${userId}
            AND rp.forfeited_at IS NULL
            AND r.status = 'completed'::"RaceStatus"
        ) placements
      ),
      race_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE COALESCE(rp.raw_steps, 0) > 0)::bigint AS races_competed,
          COUNT(*) FILTER (
            WHERE COALESCE(rp.raw_steps, 0) > 0
              AND rp.forfeited_at IS NULL
              AND rp.placement = 1
              AND competitors.accepted_count >= 2
          )::bigint AS first_place_wins,
          COUNT(*) FILTER (
            WHERE COALESCE(rp.raw_steps, 0) > 0
              AND rp.forfeited_at IS NULL
              AND rp.placement BETWEEN 1 AND 3
              AND competitors.accepted_count >= 2
          )::bigint AS podium_finishes
        FROM race_participants rp
        JOIN races r ON r.id = rp.race_id
        JOIN LATERAL (
          SELECT COUNT(*)::integer AS accepted_count
          FROM race_participants competitor
          WHERE competitor.race_id = rp.race_id
            AND competitor.status = 'accepted'::"RaceParticipantStatus"
        ) competitors ON TRUE
        WHERE rp.user_id = ${userId}
          AND rp.status = 'accepted'::"RaceParticipantStatus"
          AND r.status = 'completed'::"RaceStatus"
          AND r.seed_id IS NULL
          AND r.seeded_bucket_id IS NULL
      )
      SELECT
        totals.*,
        (SELECT COALESCE(MAX(length), 0) FROM streak)::bigint AS prior_streak,
        podiums.first_count,
        podiums.second_count,
        podiums.third_count,
        race_stats.races_competed,
        race_stats.first_place_wins,
        race_stats.podium_finishes
      FROM totals
      CROSS JOIN podiums
      CROSS JOIN race_stats
    `;
    const row = rows[0] || {};
    const thisWeek = toSafeInteger(row.this_week);
    const thisMonth = toSafeInteger(row.this_month);
    const thisYear = toSafeInteger(row.this_year);
    const weekDays = toSafeInteger(row.week_days);
    const monthDays = toSafeInteger(row.month_days);
    const yearDays = toSafeInteger(row.year_days);
    const racesCompeted = Math.max(0, toSafeInteger(row.races_competed));
    const firstPlaceWins = Math.max(0, toSafeInteger(row.first_place_wins));
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
      racePodiums: {
        first: Math.max(0, toSafeInteger(row.first_count)),
        second: Math.max(0, toSafeInteger(row.second_count)),
        third: Math.max(0, toSafeInteger(row.third_count)),
      },
      racesCompeted,
      firstPlaceWins,
      podiumFinishes: Math.max(0, toSafeInteger(row.podium_finishes)),
      winRate:
        racesCompeted > 0
          ? Math.round((firstPlaceWins / racesCompeted) * 10_000) / 10_000
          : 0.0,
    };
  };
}

const getProfileStats = buildGetProfileStats();

module.exports = { buildGetProfileStats, getProfileStats, toSafeInteger };
