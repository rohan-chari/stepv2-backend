const { prisma: defaultPrisma } = require("../../db");

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

    // Verified watches among the exact stepped-today DAU set. created_at is the
    // trusted SSV verification time; client-supplied granted_date is not used.
    const [rewardedAdRows] = await prisma.$queryRaw`
      WITH today_dau AS (
        SELECT DISTINCT user_id
        FROM steps
        WHERE date = (now() AT TIME ZONE 'America/New_York')::date
      )
      SELECT
        COUNT(DISTINCT g.user_id) FILTER (
          WHERE g.reward_kind = 'coin_reward'
        )::bigint AS coin_watchers,
        COUNT(DISTINCT g.user_id) FILTER (
          WHERE g.reward_kind = 'extra_daily_spin'
        )::bigint AS extra_spin_watchers
      FROM ad_reward_grants g
      JOIN today_dau d ON d.user_id = g.user_id
      WHERE (g.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date =
            (now() AT TIME ZONE 'America/New_York')::date`;

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

    // Team-race adoption counters (Team Race Mode ships with an organic cold
    // start — no seeded lobbies, no campaign — so these are how we watch it).
    const [teamRows] = await prisma.$queryRaw`
      SELECT
        (SELECT COUNT(*) FROM races WHERE is_team_race)::bigint                                                            AS team_created_total,
        (SELECT COUNT(*) FROM races WHERE is_team_race AND created_at >= now() - interval '7 days')::bigint                AS team_created_7d,
        (SELECT COUNT(*) FROM races WHERE is_team_race AND status = 'completed')::bigint                                   AS team_completed_total,
        (SELECT COUNT(*) FROM races WHERE is_team_race AND status = 'completed'
           AND completed_at >= now() - interval '7 days')::bigint                                                          AS team_completed_7d,
        (SELECT COUNT(*) FROM races WHERE is_team_race AND status = 'active')::bigint                                      AS team_active_now`;

    // Item 9: average number of DISTINCT users who open an in-race mystery box
    // per ET day, over the days we have data (MYSTERY_BOX_OPENED events are
    // written from the box-open deploy forward — no history before that). ET-day
    // anchored like every other metric here. Days with zero opens don't appear
    // (no rows), so the average is over active days only.
    const [boxOpenerRows] = await prisma.$queryRaw`
      SELECT AVG(daily_users)::float AS avg_box_openers
      FROM (
        SELECT (created_at AT TIME ZONE 'America/New_York')::date AS d,
               COUNT(DISTINCT actor_user_id) AS daily_users
        FROM race_powerup_events
        WHERE event_type = 'MYSTERY_BOX_OPENED'
        GROUP BY d
      ) t`;

    // Privacy-safe activation funnel: only allowlisted event names plus the
    // bounded appVersion/platform dimensions stored by the ingestion endpoint.
    // One grouped query supplies all rollout windows.
    const activationRows = await prisma.$queryRaw`
      SELECT app_version, platform, name,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::bigint AS count_7d,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::bigint AS count_30d,
        COUNT(*)::bigint AS count_90d
      FROM activation_events
      WHERE created_at >= now() - interval '90 days'
      GROUP BY app_version, platform, name
      ORDER BY app_version, platform, name`;

    // Onboarding activation funnel (§6.5). Counts are DISTINCT
    // onboarding_session_id per stage, not raw event counts, so one session
    // that retries the health prompt three times still counts once. Rows with a
    // NULL session id are excluded — they cannot be attributed to a funnel run.
    //
    // `health_granted` is not an event name: it is a health_result event whose
    // context says the OS granted access. Stage naming follows §6.5 exactly.
    //
    // ANCHORING. Each stage is a DISTINCT-session count computed independently,
    // so without an anchor nothing ties a stage back to a session that actually
    // began onboarding: any orphan session contributed +1 to whatever stages it
    // emitted. The `anchor` join restricts every stage to sessions that have an
    // `onboarding_started` event, which is what makes this a funnel rather than
    // a pile of independent event counts.
    //
    // WINDOW SEMANTICS, chosen deliberately:
    //   - A session counts toward a stage when (a) that stage's event falls in
    //     the column's window (7d or 30d) AND (b) the session is anchored.
    //   - The anchor is evaluated ONCE and is intentionally UNBOUNDED in time —
    //     it is not re-applied per column. Anchoring per column would drop a
    //     legitimate in-progress funnel whose start predates the column window
    //     (started 9 days ago, reached home 3 days ago), silently shrinking an
    //     existing number. A 30d/90d-bounded anchor has the same failure mode
    //     for long-lived installs, whose session id today is per-INSTALL and so
    //     carries a start date that can be arbitrarily old.
    //   - Cost: the anchor is a DISTINCT scan over `onboarding_started` rows,
    //     served by the (name, created_at) index and hash-joined. This is an
    //     admin-only endpoint; correctness wins over the bounded-scan variant.
    //   - "Unbounded" is unbounded in SQL only. analytics/activationEventCleanup
    //     hard-deletes rows past 90 days, so the anchor can never see a start
    //     older than that no matter what this query asks for. Widening the SQL
    //     bound cannot help; only changing retention could. This also caps the
    //     scan, so the unbounded form costs nothing over a 90d-bounded one.
    //
    // CONSEQUENCE FOR EXISTING NUMBERS, deliberate and owner-visible: an install
    // that onboarded more than 90 days ago has had its onboarding_started
    // deleted, and the client emits that event once per install (it is gated on
    // !firstRaceOnboardingSeen) so it is never re-emitted. Such an install can
    // never be re-anchored. Its ongoing events — `home_reached` fires on every
    // app session, for every user, forever — used to inflate these stages and
    // now count zero. That is the intended meaning (a veteran opening the app
    // is not an onboarding funnel), but it is a genuine restatement of
    // already-collected numbers, not a no-op.
    //
    // NOTE: anchoring is only HALF the fix for counting settings-tutorial
    // replays as onboarding completions. Under today's per-INSTALL session ids
    // a replay shares the install's id, which IS anchored, so it still counts.
    // The other half is minting a per-RUN session id on the client; neither
    // half works alone.
    const onboardingFunnelRows = await prisma.$queryRaw`
      SELECT platform, stage,
        COUNT(DISTINCT onboarding_session_id) FILTER (
          WHERE created_at >= now() - interval '7 days'
        )::bigint AS sessions_7d,
        COUNT(DISTINCT onboarding_session_id) FILTER (
          WHERE created_at >= now() - interval '30 days'
        )::bigint AS sessions_30d
      FROM (
        SELECT e.platform, e.onboarding_session_id, e.created_at,
          CASE
            WHEN e.name = 'health_result' AND e.context->>'result' = 'granted'
              THEN 'health_granted'
            ELSE e.name
          END AS stage
        FROM activation_events e
        JOIN (
          SELECT DISTINCT onboarding_session_id
          FROM activation_events
          WHERE name = 'onboarding_started'
            AND onboarding_session_id IS NOT NULL
        ) anchor ON anchor.onboarding_session_id = e.onboarding_session_id
        WHERE e.onboarding_session_id IS NOT NULL
          AND e.created_at >= now() - interval '30 days'
      ) staged
      GROUP BY platform, stage`;

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
    const coinWatchers = n(rewardedAdRows?.coin_watchers);
    const extraSpinWatchers = n(rewardedAdRows?.extra_spin_watchers);

    function activationWindow(countKey) {
      const groups = new Map();
      for (const row of activationRows || []) {
        const key = `${row.app_version}\u0000${row.platform}`;
        let group = groups.get(key);
        if (!group) {
          group = {
            appVersion: row.app_version,
            platform: row.platform,
            total: 0,
            events: {},
          };
          groups.set(key, group);
        }
        const count = n(row[countKey]);
        group.events[row.name] = count;
        group.total += count;
      }
      return [...groups.values()];
    }

    // Stage order is the funnel order; every stage is always emitted (0 when
    // absent) so the admin UI renders a stable set of rows from day one, before
    // any v3 build has shipped a single event.
    const ONBOARDING_FUNNEL_STAGES = [
      "onboarding_started",
      "health_cta_tapped",
      "health_granted",
      "health_escaped",
      "health_probe_inconclusive",
      "daily_intro_viewed",
      // Demo race tutorial. The demo step runs between the race intro and the
      // home screen, so these sit here and the bars read as one continuous
      // curve. tutorial_opened/tutorial_completed are the bookends that bracket
      // the demo — without them the three demo_* stages have no denominator.
      //
      // CAVEAT, deliberately not fixed here: this aggregation groups by stage
      // NAME only and never reads context->>'source'. The settings-tutorial
      // replay emits the same tutorial_opened/tutorial_completed names with
      // source:'profile', and onboarding_session_id is minted once per INSTALL
      // rather than per onboarding run, so a replay is not excluded by the
      // NOT NULL filter either. The two tutorial_* stages are therefore an
      // OVER-COUNT wherever users replay from Profile -> Settings. The three
      // demo_* stages are emitted only by the demo and are exact.
      //
      // tutorial_skipped is intentionally absent: a skip is an exit, not a
      // step, and this structure has no exits bucket. Placing it inline would
      // distort the curve. It stays visible by name in the `activation`
      // section, which is not filtered by this list.
      "tutorial_opened",
      "demo_box_opened",
      "demo_powerup_used",
      "demo_won",
      "tutorial_completed",
      "home_reached",
    ];

    function onboardingByPlatform(countKey) {
      const byPlatform = {};
      const emptyStages = () =>
        Object.fromEntries(ONBOARDING_FUNNEL_STAGES.map((s) => [s, 0]));
      // ios/android always present even with no data.
      byPlatform.ios = emptyStages();
      byPlatform.android = emptyStages();
      for (const row of onboardingFunnelRows || []) {
        if (!ONBOARDING_FUNNEL_STAGES.includes(row.stage)) continue;
        const platform = row.platform || "other";
        if (!byPlatform[platform]) byPlatform[platform] = emptyStages();
        byPlatform[platform][row.stage] = n(row[countKey]);
      }
      return byPlatform;
    }

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
        rewardedAds: {
          timeZone: "America/New_York",
          coinReward: {
            uniqueDauWatchers: coinWatchers,
            pctOfDau: dau > 0 ? Math.round((coinWatchers / dau) * 100) : 0,
          },
          extraSpin: {
            uniqueDauWatchers: extraSpinWatchers,
            pctOfDau: dau > 0 ? Math.round((extraSpinWatchers / dau) * 100) : 0,
          },
        },
        // Additive (Item 9). Null when there is no box-open data yet (e.g. right
        // after deploy) so the admin UI can render an em dash. Rounded to 1 dp.
        avgUniqueBoxOpenersPerDay:
          boxOpenerRows?.avg_box_openers == null
            ? null
            : Math.round(Number(boxOpenerRows.avg_box_openers) * 10) / 10,
      },
      friends: { distribution },
      retention: ret,
      teamRaces: {
        createdTotal: n(teamRows?.team_created_total),
        createdLast7Days: n(teamRows?.team_created_7d),
        completedTotal: n(teamRows?.team_completed_total),
        completedLast7Days: n(teamRows?.team_completed_7d),
        activeNow: n(teamRows?.team_active_now),
      },
      referralFunnel: {
        linkOpensTotal: n(funnelRows?.link_opens_total),
        linkOpensLast7Days: n(funnelRows?.link_opens_7d),
        signups: n(funnelRows?.referrals_total),
        signupsLast7Days: n(funnelRows?.referrals_7d),
        joinedRace: n(funnelRows?.referees_joined_race),
        finishedRace: n(funnelRows?.referees_finished_race),
        rewarded: n(funnelRows?.referrals_rewarded),
      },
      activationFunnel: {
        last7Days: activationWindow("count_7d"),
        last30Days: activationWindow("count_30d"),
        last90Days: activationWindow("count_90d"),
      },
      // Additive section (§6.5). `windowDays` + `byPlatform` are the pinned
      // contract (the 7-day window); `byPlatformLast30Days` is an extra key for
      // the 30d view. Old admin builds ignore unknown sections entirely.
      onboardingFunnel: {
        windowDays: 7,
        byPlatform: onboardingByPlatform("sessions_7d"),
        byPlatformLast30Days: onboardingByPlatform("sessions_30d"),
      },
    };
  };
}

const getAdminStats = buildGetAdminStats();

module.exports = { buildGetAdminStats, getAdminStats };
