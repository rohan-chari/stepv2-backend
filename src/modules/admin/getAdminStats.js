const { prisma: defaultPrisma } = require("../../db");
const { AD_COIN_REWARD_DAILY_CAP } = require("../economy/adRewards");

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
//
// ── OPTIONAL SECTIONS (batch 2026-08-09 item 10) ────────────────────────────
//
// `getAdminStats({ sections })` — and `GET /admin/stats?sections=a,b` — adds
// aggregate blocks that the SHIPPED admin build cannot render. Passing no
// sections returns exactly the payload above and runs exactly the queries
// above: not one extra `$queryRaw`. That is the whole point of the parameter.
// Prod is a one-vCPU box and these are ~5 additional grouped aggregates; the
// old build must not pay for them, and neither must a new build whose section
// is collapsed. The frontend requests each section lazily as it expands.
//
// Contract (LOCKED — the frontend codes against these exact key names):
//   sections=economy -> coinEconomy: {
//     windowDays, timeZone,
//     days: [{ date, minted, sunk }],
//     purchasesBySku: [{ sku, count, coins }],
//     boxOpens: [{ date, count }] }
//   sections=ads     -> adRevenue: {
//     windowDays, timeZone,
//     days: [{ date, coinRewardWatches, extraSpinWatches }],
//     capUtilization: { avgWatchesPerUser, usersAtCap } }
//   sections=extra-spin-funnel -> extraSpinFunnel: {
//     windowDays, timeZone,
//     sources: { clientTelemetry: { label, reliability },
//                serverVerified: { label, reliability } },
//     byPlatformAndAppVersion: [{
//       platform, appVersion,
//       clientTelemetry: {
//         offerShownUsers, ctaTappedUsers, adReadyUsers, adNotReadyUsers,
//         adCompletedUsers, claimSucceededUsers },
//       serverVerified: {
//         watchGrants, uniqueWatchers, redeemedSpinGrants, uniqueRedeemers }
//     }] }
// Unknown section names are ignored rather than rejected, so a newer admin
// build asking for a section this backend has not shipped yet degrades to a
// missing key instead of a 400.
//
// INDEXES. Every new aggregate is bounded to 30 days and reviewed below; none
// of them ships a migration, deliberately:
//   * coin_transactions      — filtered on created_at. The existing indexes are
//     (user_id) and (user_id, reason, created_at); neither leads on created_at,
//     so the daily ledger roll-up is a seq scan. At the current table size
//     (well under a million rows at ~1k DAU) that is milliseconds on an
//     admin-only, human-triggered endpoint. IF this gets slow, the index to add
//     is `coin_transactions(created_at)` — do not add it speculatively; it is a
//     write-path cost on the hottest ledger in the system.
//   * race_powerup_events    — the daily box-open roll-up filters
//     event_type + created_at. It is STRICTLY CHEAPER than the pre-existing
//     `avgUniqueBoxOpenersPerDay` query in the default payload, which scans the
//     same table with NO time bound at all. Nothing to add here that the
//     default payload would not have needed first.
//   * ad_reward_grants       — filtered on created_at; the existing index is
//     (user_id, granted_date). Smallest table of the three (one row per
//     verified ad watch). Seq scan accepted for the same reason.
//   * powerup_purchase_requests / user_shop_items — one row per purchase ever
//     made, in the low thousands. Seq scan accepted.
// No EXPLAIN on this branch showed a plan that justified a migration; re-check
// when any of these tables crosses ~10^6 rows.
//
// TIME ZONE. New queries use the two-step
// `(col AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date` form, which
// is the correct one for this schema: prod datetimes are `timestamp without
// time zone` holding UTC, so the one-step form (used by the older
// `avgUniqueBoxOpenersPerDay` query) mislabels rows near midnight. The older
// query is left alone — changing it would restate an existing number.
function buildGetAdminStats(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;

  const n = (v) => Number(v ?? 0);
  const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

  const KNOWN_SECTIONS = new Set(["economy", "ads", "extra-spin-funnel"]);
  function parseSections(raw) {
    const list = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? raw.split(",")
        : [];
    return new Set(
      list
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => KNOWN_SECTIONS.has(s))
    );
  }

  // ── economy section ───────────────────────────────────────────────────────
  async function loadCoinEconomy() {
    // Coins MINTED vs SUNK per ET day. One signed ledger, so the split is a
    // sign filter rather than a reason allowlist — a new coin source or sink
    // is counted the day it ships, with no list to keep in sync. `sunk` is
    // reported POSITIVE (magnitude), which is what the chart plots.
    const ledgerRows = await prisma.$queryRaw`
      /* coinLedgerDaily */
      SELECT
        to_char(
          (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,
          'YYYY-MM-DD'
        )                                                          AS date,
        COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)::bigint  AS minted,
        COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0)::bigint AS sunk
      FROM coin_transactions
      WHERE created_at >= now() - interval '30 days'
      GROUP BY 1
      ORDER BY 1`;

    // Purchases by SKU across BOTH shops. The powerup side reads the purchase
    // REQUEST table rather than coin_transactions because the ledger's ref_id
    // for a powerup purchase is the per-request id, not the SKU — the ledger
    // literally cannot answer "which SKU". SUCCEEDED only: a PROCESSING row is
    // an in-flight or abandoned attempt.
    const purchaseRows = await prisma.$queryRaw`
      /* purchasesBySku */
      SELECT sku, COUNT(*)::bigint AS count, COALESCE(SUM(coins), 0)::bigint AS coins
      FROM (
        SELECT psi.sku AS sku, ppr.coins_spent AS coins
        FROM powerup_purchase_requests ppr
        JOIN powerup_shop_items psi ON psi.id = ppr.powerup_shop_item_id
        WHERE ppr.status = 'SUCCEEDED'
          AND ppr.created_at >= now() - interval '30 days'
        UNION ALL
        SELECT si.sku AS sku, si.price_coins AS coins
        FROM user_shop_items usi
        JOIN shop_items si ON si.id = usi.shop_item_id
        WHERE usi.purchased_at >= now() - interval '30 days'
      ) p
      GROUP BY sku
      ORDER BY coins DESC, sku ASC`;

    // Box opens per ET day. Distinct from the default payload's
    // `avgUniqueBoxOpenersPerDay` (distinct USERS, all time, one scalar): this
    // is the raw open COUNT per day, which is the series the chart draws.
    const boxRows = await prisma.$queryRaw`
      /* boxOpensDaily */
      SELECT
        to_char(
          (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,
          'YYYY-MM-DD'
        )               AS date,
        COUNT(*)::bigint AS count
      FROM race_powerup_events
      WHERE event_type = 'MYSTERY_BOX_OPENED'
        AND created_at >= now() - interval '30 days'
      GROUP BY 1
      ORDER BY 1`;

    return {
      windowDays: 30,
      timeZone: "America/New_York",
      days: (ledgerRows || []).map((row) => ({
        date: row.date,
        minted: n(row.minted),
        sunk: n(row.sunk),
      })),
      purchasesBySku: (purchaseRows || []).map((row) => ({
        sku: row.sku,
        count: n(row.count),
        coins: n(row.coins),
      })),
      boxOpens: (boxRows || []).map((row) => ({
        date: row.date,
        count: n(row.count),
      })),
    };
  }

  // ── ads section ───────────────────────────────────────────────────────────
  async function loadAdRevenue() {
    // Verified watches per ET day, by reward kind. created_at is the SSV
    // verification time (server-trusted); granted_date is client-supplied and
    // is deliberately NOT used for the trend — same rule the default payload's
    // rewardedAds block already follows.
    const dayRows = await prisma.$queryRaw`
      /* adWatchesDaily */
      SELECT
        to_char(
          (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,
          'YYYY-MM-DD'
        )                                                              AS date,
        COUNT(*) FILTER (WHERE reward_kind = 'coin_reward')::bigint     AS coin_reward_watches,
        COUNT(*) FILTER (WHERE reward_kind = 'extra_daily_spin')::bigint AS extra_spin_watches,
        COUNT(*) FILTER (WHERE reward_kind = 'box_reroll')::bigint       AS box_reroll_watches
      FROM ad_reward_grants
      WHERE created_at >= now() - interval '30 days'
      GROUP BY 1
      ORDER BY 1`;

    // Reroll ads only. A verified watch mints a grant; the grant is consumed
    // when the player actually rerolls a box (rerollMysteryBox CASes
    // consumed_at). Watched-but-unconsumed is therefore the drop-off between
    // sitting through the ad and completing the reroll — the one number the
    // daily counts above cannot show.
    const [rerollRow] = await prisma.$queryRaw`
      /* boxRerollAds */
      SELECT
        COUNT(*)::bigint                                            AS watches,
        COUNT(DISTINCT user_id)::bigint                             AS unique_watchers,
        COUNT(*) FILTER (WHERE consumed_at IS NOT NULL)::bigint     AS consumed
      FROM ad_reward_grants
      WHERE reward_kind = 'box_reroll'
        AND created_at >= now() - interval '30 days'`;

    // Cap utilization. This one DOES bucket by granted_date, and that is not an
    // inconsistency with the trend above: granted_date is the user-LOCAL day
    // the daily cap is actually enforced on, so it is the only bucketing under
    // which "hit the cap" means what the player experienced.
    //
    // avgWatchesPerUser: mean coin-reward watches per (user, day) that had at
    // least one watch — i.e. among watchers, not diluted by the whole base,
    // averaged across the whole 30-day window. NULL (not 0) when nobody has
    // watched, so the UI can render an em dash.
    //
    // usersAtCap is scoped to the LATEST granted_date in the window, not to the
    // window as a whole (code review 2026-08-09). The admin card labels this
    // "Users at cap", which reads as a CURRENT count; a 30-day-wide filter
    // answered a different question — "users who hit the cap on at least one
    // day in the last month" — and drifted further from the label the longer
    // the window ran, since it only ever accumulates. The JSON key is part of
    // the locked contract and is deliberately NOT renamed; the number is
    // brought in line with the label instead.
    //
    // granted_date is a YYYY-MM-DD string, so MAX() is lexicographic and
    // therefore also chronological. An empty table yields NULL, the FILTER
    // matches nothing, and usersAtCap is 0 — not an error.
    const cap = AD_COIN_REWARD_DAILY_CAP;
    const [capRow] = await prisma.$queryRaw`
      /* adCapUtilization */
      WITH per_user_day AS (
        SELECT user_id, granted_date, COUNT(*) AS watches
        FROM ad_reward_grants
        WHERE reward_kind = 'coin_reward'
          AND created_at >= now() - interval '30 days'
        GROUP BY 1, 2
      ),
      latest_day AS (SELECT MAX(granted_date) AS d FROM per_user_day)
      SELECT
        AVG(watches)::float AS avg_watches_per_user,
        COUNT(DISTINCT user_id) FILTER (
          WHERE watches >= ${cap}
            AND granted_date = (SELECT d FROM latest_day)
        )::bigint AS users_at_cap
      FROM per_user_day`;

    return {
      windowDays: 30,
      timeZone: "America/New_York",
      days: (dayRows || []).map((row) => ({
        date: row.date,
        coinRewardWatches: n(row.coin_reward_watches),
        extraSpinWatches: n(row.extra_spin_watches),
        boxRerollWatches: n(row.box_reroll_watches),
      })),
      boxReroll: {
        watches: n(rerollRow?.watches),
        uniqueWatchers: n(rerollRow?.unique_watchers),
        consumed: n(rerollRow?.consumed),
        // Null rather than 0 when nobody has watched: "0% converted" would
        // read as a broken reroll flow when the truth is no data yet.
        pctConsumed:
          n(rerollRow?.watches) > 0
            ? Math.round((n(rerollRow?.consumed) / n(rerollRow?.watches)) * 100)
            : null,
      },
      capUtilization: {
        avgWatchesPerUser: round1(capRow?.avg_watches_per_user),
        usersAtCap: n(capRow?.users_at_cap),
      },
    };
  }

  // ── extra-spin CTA funnel section ─────────────────────────────────────────
  //
  // Both sources use the trailing 30 ET calendar days, including today. The
  // two-step conversion is necessary because this schema's `created_at` values
  // are UTC instants stored in a `timestamp without time zone` column.
  //
  // Client telemetry dimensions come from the event itself. SSV rows do not
  // carry a client platform/version (correctly: that callback is server-owned),
  // so their platform is derived from the account provider and their version is
  // the user's latest sticky X-App-Version value. The source labels are part of
  // the wire contract so an admin cannot mistake best-effort client events for
  // verified reward records.
  async function loadExtraSpinFunnel() {
    const rows = await prisma.$queryRaw`
      WITH window_start AS (
        SELECT (
          (((now() AT TIME ZONE 'America/New_York')::date - 29)::timestamp
            AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'
        )::timestamp AS created_at
      ),
      client AS (
        SELECT
          e.platform,
          e.app_version,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.name = 'extra_spin_offer_shown'
          )::bigint AS offer_shown_users,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.name = 'extra_spin_cta_tapped'
          )::bigint AS cta_tapped_users,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.name = 'extra_spin_ad_ready'
          )::bigint AS ad_ready_users,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.name = 'extra_spin_ad_not_ready'
          )::bigint AS ad_not_ready_users,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.name = 'extra_spin_ad_completed'
          )::bigint AS ad_completed_users,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.name = 'extra_spin_claim_succeeded'
          )::bigint AS claim_succeeded_users
        FROM activation_events e
        CROSS JOIN window_start w
        WHERE e.created_at >= w.created_at
          AND e.name IN (
            'extra_spin_offer_shown',
            'extra_spin_cta_tapped',
            'extra_spin_ad_ready',
            'extra_spin_ad_not_ready',
            'extra_spin_ad_completed',
            'extra_spin_claim_succeeded'
          )
        GROUP BY e.platform, e.app_version
      ),
      verified AS (
        SELECT
          CASE
            WHEN u.apple_id IS NOT NULL THEN 'ios'
            WHEN u.google_sub IS NOT NULL THEN 'android'
            ELSE 'other'
          END AS platform,
          COALESCE(u.last_app_version, 'unknown') AS app_version,
          COUNT(*)::bigint AS watch_grants,
          COUNT(DISTINCT g.user_id)::bigint AS unique_watchers,
          COUNT(*) FILTER (WHERE g.consumed_at IS NOT NULL)::bigint
            AS redeemed_spin_grants,
          COUNT(DISTINCT g.user_id) FILTER (WHERE g.consumed_at IS NOT NULL)::bigint
            AS unique_redeemers
        FROM ad_reward_grants g
        JOIN users u ON u.id = g.user_id
        CROSS JOIN window_start w
        WHERE g.created_at >= w.created_at
          AND g.reward_kind = 'extra_daily_spin'
        GROUP BY 1, 2
      )
      SELECT
        COALESCE(c.platform, v.platform) AS platform,
        COALESCE(c.app_version, v.app_version) AS app_version,
        c.offer_shown_users,
        c.cta_tapped_users,
        c.ad_ready_users,
        c.ad_not_ready_users,
        c.ad_completed_users,
        c.claim_succeeded_users,
        v.watch_grants,
        v.unique_watchers,
        v.redeemed_spin_grants,
        v.unique_redeemers
      FROM client c
      FULL OUTER JOIN verified v
        ON v.platform = c.platform AND v.app_version = c.app_version
      ORDER BY 1, 2`;

    return {
      windowDays: 30,
      timeZone: "America/New_York",
      sources: {
        clientTelemetry: {
          label: "Client telemetry",
          reliability: "best_effort_may_be_lost_offline",
        },
        serverVerified: {
          label: "Server-verified AdMob SSV",
          reliability: "authoritative",
        },
      },
      byPlatformAndAppVersion: (rows || []).map((row) => ({
        platform: row.platform,
        appVersion: row.app_version,
        clientTelemetry: {
          offerShownUsers: n(row.offer_shown_users),
          ctaTappedUsers: n(row.cta_tapped_users),
          adReadyUsers: n(row.ad_ready_users),
          adNotReadyUsers: n(row.ad_not_ready_users),
          adCompletedUsers: n(row.ad_completed_users),
          claimSucceededUsers: n(row.claim_succeeded_users),
        },
        serverVerified: {
          watchGrants: n(row.watch_grants),
          uniqueWatchers: n(row.unique_watchers),
          redeemedSpinGrants: n(row.redeemed_spin_grants),
          uniqueRedeemers: n(row.unique_redeemers),
        },
      })),
    };
  }

  return async function getAdminStats(options = {}) {
    const sections = parseSections(options?.sections);
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
        )::bigint AS extra_spin_watchers,
        COUNT(DISTINCT g.user_id) FILTER (
          WHERE g.reward_kind = 'box_reroll'
        )::bigint AS box_reroll_watchers
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

    // Batch 2026-08-08 item 9 — install-base version spread.
    //
    // Population: users SEEN in the last 30 days (`last_seen_at`, stamped by the
    // sticky write in requireAuth). Rows never seen since the column shipped are
    // excluded outright — they are dormant accounts, not an unknown version.
    //
    // The NULL bucket is COALESCEd to the literal 'unknown' rather than dropped.
    // This matters most on day one: no row is backfilled, so until each user
    // makes their next request everything is NULL, and an omitted bucket would
    // render as "we have almost no users". A client that literally sends
    // `X-App-Version: unknown` (the app's own fallback string, which the shared
    // regex permits) folds into the same bucket, which is the correct reading —
    // both mean "we do not know this user's version".
    //
    // PLATFORM is derived from the account's auth provider, not from any header:
    // a user is keyed on exactly ONE provider id (appleId for iOS, googleSub for
    // Android — see User.create), so the column already IS the platform and it
    // cannot be spoofed by a request. Precedence appleId -> googleSub covers the
    // rare linked account (today's base is iOS-only); anything with neither (the
    // review/test accounts) reports 'unknown'.
    const versionRows = await prisma.$queryRaw`
      SELECT
        COALESCE(last_app_version, 'unknown') AS version,
        CASE
          WHEN apple_id   IS NOT NULL THEN 'ios'
          WHEN google_sub IS NOT NULL THEN 'android'
          ELSE 'unknown'
        END AS platform,
        COUNT(*)::bigint AS users
      FROM users
      WHERE last_seen_at >= now() - interval '30 days'
      GROUP BY 1, 2
      ORDER BY users DESC, version ASC, platform ASC`;

    // The window's left edge, as a plain YYYY-MM-DD, so the admin card can label
    // the section instead of presenting an undated count.
    const [versionsSinceRow] = await prisma.$queryRaw`
      SELECT to_char((now() - interval '30 days')::date, 'YYYY-MM-DD') AS since`;

    // Private (invite-only) vs public race volume, grouped by status. "Active"
    // is status='active' only; the totals span every status including cancelled,
    // so privateTotal is lifetime creation volume rather than a live count.
    const [raceRows] = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE NOT is_public)::bigint                             AS private_total,
        COUNT(*) FILTER (WHERE NOT is_public AND status = 'active')::bigint       AS private_active,
        COUNT(*) FILTER (WHERE is_public)::bigint                                 AS public_total,
        COUNT(*) FILTER (WHERE is_public AND status = 'active')::bigint           AS public_active
      FROM races`;

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
    const boxRerollWatchers = n(rewardedAdRows?.box_reroll_watchers);

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

    const payload = {
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
          // Additive. Reroll ads ship behind ADS_BOX_REROLL_ENABLED and are
          // iOS-only, so 0 here is the expected reading while the switch is
          // off — it is not the same signal as a missing key on an older
          // backend, which the client renders as an em dash.
          boxReroll: {
            uniqueDauWatchers: boxRerollWatchers,
            pctOfDau: dau > 0 ? Math.round((boxRerollWatchers / dau) * 100) : 0,
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
      // Additive (item 9). `versions` stays a flat array exactly as specced, so
      // the two scalars that describe its window ride alongside it rather than
      // wrapping it. Old admin builds ignore all three keys.
      versions: (versionRows || []).map((row) => ({
        version: row.version,
        platform: row.platform,
        users: n(row.users),
      })),
      versionsSince: versionsSinceRow?.since ?? null,
      versionsWindowDays: 30,
      races: {
        privateTotal: n(raceRows?.private_total),
        privateActive: n(raceRows?.private_active),
        publicTotal: n(raceRows?.public_total),
        publicActive: n(raceRows?.public_active),
      },
      onboardingFunnel: {
        windowDays: 7,
        byPlatform: onboardingByPlatform("sessions_7d"),
        byPlatformLast30Days: onboardingByPlatform("sessions_30d"),
      },
    };

    // Opt-in sections, appended AFTER the default payload is assembled so the
    // default query set stays byte-identical in both order and content.
    if (sections.has("economy")) payload.coinEconomy = await loadCoinEconomy();
    if (sections.has("ads")) payload.adRevenue = await loadAdRevenue();
    if (sections.has("extra-spin-funnel")) {
      payload.extraSpinFunnel = await loadExtraSpinFunnel();
    }

    return payload;
  };
}

const getAdminStats = buildGetAdminStats();

module.exports = { buildGetAdminStats, getAdminStats };
