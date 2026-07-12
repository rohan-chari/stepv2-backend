const { prisma: defaultPrisma } = require("../db");

// One-shot product-health snapshot for the admin Statistics card. Read-only,
// admin-gated, and computed entirely in SQL so the numbers are timezone-safe
// (prod datetimes are `timestamp without time zone`; doing date math in JS
// shifts them by the server's tz). "A day" is anchored to America/New_York,
// matching the product's ET anchoring (seeded races, cron jobs).
//
// Definitions:
//   * DAU today  — distinct users with a steps row for today's ET date (a step
//     sync happened; the closest thing we have to "opened the app today").
//   * D1/D7      — signup cohorts by ET date; retained = has a steps row
//     exactly 1 (resp. 7) ET days after the signup date. Split by whether the
//     user has any ACCEPTED friendship today (directional caveat: friendship
//     may postdate the retention window; good enough for the diagnostic).
//   * Funnel     — link_opens (top), referrals attached at signup, referees
//     who joined any race, referees whose referral qualified/was rewarded
//     (i.e. finished their first qualifying race).
function buildGetAdminStats(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;

  const n = (v) => Number(v ?? 0);

  return async function getAdminStats() {
    const [userRows] = await prisma.$queryRaw`
      SELECT
        COUNT(*)::bigint                                                            AS total,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::bigint     AS new_7d,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint    AS new_30d
      FROM users`;

    const [dauRows] = await prisma.$queryRaw`
      WITH today AS (
        SELECT DISTINCT user_id
        FROM steps
        WHERE date = (now() AT TIME ZONE 'America/New_York')::date
      )
      SELECT
        (SELECT COUNT(*) FROM today)::bigint AS dau,
        (SELECT COUNT(*) FROM today t
          WHERE EXISTS (
            SELECT 1
            FROM race_participants rp
            JOIN races r ON r.id = rp.race_id
            WHERE rp.user_id = t.user_id
              AND rp.status = 'accepted'
              AND r.status = 'active'
          ))::bigint AS dau_in_active_race`;

    const friendsDist = await prisma.$queryRaw`
      WITH counts AS (
        SELECT u.id,
               (SELECT COUNT(*)
                FROM friendships f
                WHERE f.status = 'ACCEPTED'
                  AND (f.requester_id = u.id OR f.addressee_id = u.id)) AS friends
        FROM users u
      )
      SELECT
        CASE
          WHEN friends = 0 THEN '0'
          WHEN friends = 1 THEN '1'
          WHEN friends = 2 THEN '2'
          WHEN friends BETWEEN 3 AND 5 THEN '3-5'
          ELSE '6+'
        END AS bucket,
        COUNT(*)::bigint AS users
      FROM counts
      GROUP BY 1`;

    // Retention. Cohort windows exclude the last 1 (resp. 7) full days so every
    // cohort member has had the whole window to come back.
    const retention = await prisma.$queryRaw`
      WITH cohort AS (
        SELECT u.id,
               (u.created_at AT TIME ZONE 'America/New_York')::date AS signup_date,
               EXISTS (
                 SELECT 1 FROM friendships f
                 WHERE f.status = 'ACCEPTED'
                   AND (f.requester_id = u.id OR f.addressee_id = u.id)
               ) AS has_friend
        FROM users u
        WHERE u.created_at >= now() - interval '32 days'
      )
      SELECT
        has_friend,
        COUNT(*) FILTER (WHERE signup_date <= (now() AT TIME ZONE 'America/New_York')::date - 2)::bigint AS d1_cohort,
        COUNT(*) FILTER (
          WHERE signup_date <= (now() AT TIME ZONE 'America/New_York')::date - 2
            AND EXISTS (SELECT 1 FROM steps s
                        WHERE s.user_id = cohort.id AND s.date = cohort.signup_date + 1)
        )::bigint AS d1_retained,
        COUNT(*) FILTER (WHERE signup_date <= (now() AT TIME ZONE 'America/New_York')::date - 8)::bigint AS d7_cohort,
        COUNT(*) FILTER (
          WHERE signup_date <= (now() AT TIME ZONE 'America/New_York')::date - 8
            AND EXISTS (SELECT 1 FROM steps s
                        WHERE s.user_id = cohort.id AND s.date = cohort.signup_date + 7)
        )::bigint AS d7_retained
      FROM cohort
      GROUP BY has_friend`;

    const [funnelRows] = await prisma.$queryRaw`
      SELECT
        (SELECT COUNT(*) FROM link_opens WHERE kind = 'referral')::bigint                                            AS link_opens_total,
        (SELECT COUNT(*) FROM link_opens WHERE kind = 'referral' AND created_at >= now() - interval '7 days')::bigint AS link_opens_7d,
        (SELECT COUNT(*) FROM referrals)::bigint                                                                     AS referrals_total,
        (SELECT COUNT(*) FROM referrals WHERE created_at >= now() - interval '7 days')::bigint                       AS referrals_7d,
        (SELECT COUNT(*) FROM referrals rf
          WHERE EXISTS (SELECT 1 FROM race_participants rp
                        WHERE rp.user_id = rf.referee_id AND rp.status = 'accepted'))::bigint                        AS referees_joined_race,
        (SELECT COUNT(*) FROM referrals WHERE status IN ('QUALIFIED', 'REWARDED'))::bigint                           AS referees_finished_race,
        (SELECT COUNT(*) FROM referrals WHERE status = 'REWARDED')::bigint                                           AS referrals_rewarded`;

    const distribution = { "0": 0, "1": 0, "2": 0, "3-5": 0, "6+": 0 };
    for (const row of friendsDist) distribution[row.bucket] = n(row.users);

    const ret = {
      withFriend: { d1Cohort: 0, d1Retained: 0, d7Cohort: 0, d7Retained: 0 },
      withoutFriend: { d1Cohort: 0, d1Retained: 0, d7Cohort: 0, d7Retained: 0 },
    };
    for (const row of retention) {
      const side = row.has_friend ? ret.withFriend : ret.withoutFriend;
      side.d1Cohort = n(row.d1_cohort);
      side.d1Retained = n(row.d1_retained);
      side.d7Cohort = n(row.d7_cohort);
      side.d7Retained = n(row.d7_retained);
    }

    const dau = n(dauRows?.dau);
    const dauInActiveRace = n(dauRows?.dau_in_active_race);

    return {
      generatedAt: new Date().toISOString(),
      users: {
        total: n(userRows?.total),
        newLast7Days: n(userRows?.new_7d),
        newLast30Days: n(userRows?.new_30d),
      },
      activity: {
        dauToday: dau,
        dauInActiveRace,
        pctDauInActiveRace: dau > 0 ? Math.round((dauInActiveRace / dau) * 100) : 0,
      },
      friends: { distribution },
      retention: ret,
      referralFunnel: {
        linkOpensTotal: n(funnelRows?.link_opens_total),
        linkOpensLast7Days: n(funnelRows?.link_opens_7d),
        signups: n(funnelRows?.referrals_total),
        signupsLast7Days: n(funnelRows?.referrals_7d),
        joinedRace: n(funnelRows?.referees_joined_race),
        finishedRace: n(funnelRows?.referees_finished_race),
        rewarded: n(funnelRows?.referrals_rewarded),
      },
    };
  };
}

const getAdminStats = buildGetAdminStats();

module.exports = { buildGetAdminStats, getAdminStats };
