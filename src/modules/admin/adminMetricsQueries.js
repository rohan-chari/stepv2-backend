const { prisma: defaultPrisma } = require("../../db");
const { buildWindow } = require("./adminMetricsDashboard");

const FORWARD_KEYS = [
  "observedForegroundDau",
  "observedForegroundWau",
  "observedForegroundMau",
  "retentionD1",
  "retentionD7",
  "retentionD30",
  "healthWithin24h",
  "leaderboardViews",
  "notificationOpen",
  "boxOpen",
  "firstRacePowerUse",
];
const REWARD_KINDS = [
  "coin_reward",
  "extra_daily_spin",
  "box_reroll",
  "race_payout_double",
  "powerup_unlock",
];
const FRIEND_BUCKETS = ["0", "1", "2", "3-5", "6+"];

function number(value) {
  return Number(value ?? 0);
}
function nullableNumber(value) {
  return value == null ? null : Number(value);
}
function round1(value) {
  return value == null ? null : Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}
function ratio(numerator, denominator, available = true) {
  if (!available || numerator == null || denominator == null) {
    return { numerator: null, denominator: null, percent: null };
  }
  const n = number(numerator);
  const d = number(denominator);
  return { numerator: n, denominator: d, percent: d === 0 ? null : round1((n / d) * 100) };
}
function average(numerator, denominator, available = true) {
  if (!available || numerator == null || denominator == null) {
    return { numerator: null, denominator: null, average: null };
  }
  const n = number(numerator);
  const d = number(denominator);
  return { numerator: n, denominator: d, average: d === 0 ? null : round1(n / d) };
}

function buildAdminMetricsBlockLoader(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const env = dependencies.env || process.env;

  async function coverage(generatedAt, start, end) {
    const [row] = await prisma.$queryRaw`
      WITH epoch AS (
        SELECT id,started_at FROM admin_metrics_collection_epochs
        WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
      ), ios_users AS (
        SELECT * FROM users WHERE apple_id IS NOT NULL AND is_review_account=false
      ), signup_cohorts AS (
        SELECT id,
          (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date signup_date,
          metrics_v2_signup_eligible=true AND
            metrics_v2_signup_epoch_id=(SELECT id FROM epoch) eligible
        FROM ios_users
      ), d1_cohort_dates AS (
        SELECT DISTINCT signup_date FROM signup_cohorts
        WHERE eligible AND signup_date<=CAST(${end} AS date)-2
        ORDER BY signup_date DESC LIMIT 30
      ), d7_cohort_dates AS (
        SELECT DISTINCT signup_date FROM signup_cohorts
        WHERE eligible AND signup_date<=CAST(${end} AS date)-8
        ORDER BY signup_date DESC LIMIT 30
      ), d30_cohort_dates AS (
        SELECT DISTINCT signup_date FROM signup_cohorts
        WHERE eligible AND signup_date<=CAST(${end} AS date)-31
        ORDER BY signup_date DESC LIMIT 30
      ), eligible_races AS (
        SELECT r.* FROM races r JOIN users c ON c.id=r.creator_id
        WHERE r.seed_id IS NULL AND r.tournament_id IS NULL
          AND r.status<>'cancelled' AND r.powerups_enabled=true
          AND c.apple_id IS NOT NULL AND c.is_review_account=false
          AND (SELECT COUNT(*) FROM race_participants field
            WHERE field.race_id=r.id AND field.status='accepted')>=2
      ), first_power_cohorts AS (
        SELECT rp.user_id,er.id race_id,COALESCE(er.started_at,er.created_at) race_at,
          ROW_NUMBER() OVER (PARTITION BY rp.user_id
            ORDER BY COALESCE(er.started_at,er.created_at),er.id) sequence
        FROM race_participants rp JOIN ios_users u ON u.id=rp.user_id
          JOIN eligible_races er ON er.id=rp.race_id
        WHERE rp.status='accepted'
      ), selected_first_power AS (
        SELECT * FROM first_power_cohorts WHERE sequence=1
          AND (race_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date
            BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
      ), eligible_racers AS (
        SELECT DISTINCT rp.user_id FROM race_participants rp
          JOIN ios_users u ON u.id=rp.user_id JOIN races r ON r.id=rp.race_id
          JOIN users c ON c.id=r.creator_id
        WHERE rp.status='accepted' AND r.seed_id IS NULL
          AND r.tournament_id IS NULL AND r.status<>'cancelled'
          AND c.apple_id IS NOT NULL AND c.is_review_account=false
      ) SELECT
        (SELECT id FROM epoch) epoch_id,
        (SELECT started_at FROM epoch) epoch_started_at,
        (SELECT to_char(
          (started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,
          'YYYY-MM-DD'
        ) FROM epoch) epoch_started_et_date,
        (SELECT operational_at FROM metric_coverage_starts WHERE metric='boxOpen') box_open_at,
        (SELECT to_char(
          (operational_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,
          'YYYY-MM-DD'
        ) FROM metric_coverage_starts WHERE metric='boxOpen') box_open_et_date,
        (SELECT operational_at <= (
          (CAST(${start} AS date)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM metric_coverage_starts WHERE metric='boxOpen') box_open_full_window,
        (SELECT operational_at FROM metric_coverage_starts WHERE metric='firstRacePowerUse') first_power_at,
        (SELECT to_char(
          (operational_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,
          'YYYY-MM-DD'
        ) FROM metric_coverage_starts WHERE metric='firstRacePowerUse') first_power_et_date,
        (SELECT operational_at <= (
          (CAST(${start} AS date)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM metric_coverage_starts WHERE metric='firstRacePowerUse') first_power_full_window,
        (SELECT started_at <= (
          (CAST(${end} AS date)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM epoch) epoch_covers_dau,
        (SELECT started_at <= (
          ((CAST(${end} AS date)-6)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM epoch) epoch_covers_wau,
        (SELECT started_at <= (
          ((CAST(${end} AS date)-29)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM epoch) epoch_covers_mau,
        (SELECT started_at <= (
          ((CAST(${end} AS date)-2)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM epoch) epoch_covers_signup_d1,
        (SELECT started_at <= (
          ((CAST(${end} AS date)-8)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM epoch) epoch_covers_signup_d7,
        (SELECT started_at <= (
          ((CAST(${end} AS date)-31)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM epoch) epoch_covers_signup_d30,
        (SELECT started_at <= (
          (CAST(${start} AS date)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM epoch) epoch_covers_selected_window,
        (SELECT COUNT(*) FROM ios_users)::bigint total,
        (SELECT COUNT(*) FROM ios_users WHERE metrics_v2_eligible_epoch_id=(SELECT id FROM epoch)
          AND metrics_v2_eligible_at <= (
            (CAST(${end} AS date)::timestamp AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'UTC'
          ))::bigint capable_d1,
        (SELECT COUNT(*) FROM ios_users WHERE metrics_v2_eligible_epoch_id=(SELECT id FROM epoch)
          AND metrics_v2_eligible_at <= (
            ((CAST(${end} AS date)-6)::timestamp AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'UTC'
          ))::bigint capable_d7,
        (SELECT COUNT(*) FROM ios_users WHERE metrics_v2_eligible_epoch_id=(SELECT id FROM epoch)
          AND metrics_v2_eligible_at <= (
            ((CAST(${end} AS date)-29)::timestamp AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'UTC'
          ))::bigint capable_d30,
        (SELECT COUNT(*) FROM signup_cohorts
          WHERE signup_date IN (SELECT signup_date FROM d1_cohort_dates))::bigint signup_total_d1,
        (SELECT COUNT(*) FROM signup_cohorts WHERE eligible
          AND signup_date IN (SELECT signup_date FROM d1_cohort_dates))::bigint signup_eligible_d1,
        (SELECT COUNT(*) FROM signup_cohorts
          WHERE signup_date IN (SELECT signup_date FROM d7_cohort_dates))::bigint signup_total_d7,
        (SELECT COUNT(*) FROM signup_cohorts WHERE eligible
          AND signup_date IN (SELECT signup_date FROM d7_cohort_dates))::bigint signup_eligible_d7,
        (SELECT COUNT(*) FROM signup_cohorts
          WHERE signup_date IN (SELECT signup_date FROM d30_cohort_dates))::bigint signup_total_d30,
        (SELECT COUNT(*) FROM signup_cohorts WHERE eligible
          AND signup_date IN (SELECT signup_date FROM d30_cohort_dates))::bigint signup_eligible_d30,
        (SELECT COUNT(*) FROM eligible_racers)::bigint leaderboard_total,
        (SELECT COUNT(*) FROM eligible_racers er JOIN ios_users u ON u.id=er.user_id
          WHERE u.metrics_v2_eligible_epoch_id=(SELECT id FROM epoch)
            AND u.metrics_v2_eligible_at <= (
              (CAST(${start} AS date)::timestamp AT TIME ZONE 'America/New_York')
              AT TIME ZONE 'UTC'
            ))::bigint leaderboard_eligible,
        (SELECT COUNT(*) FROM ios_users)::bigint notification_total,
        (SELECT COUNT(DISTINCT u.id) FROM ios_users u JOIN device_tokens t ON t.user_id=u.id
          WHERE t.platform='ios' AND t.admin_metrics_open_capable=true
            AND t.admin_metrics_open_epoch_id=(SELECT id FROM epoch))::bigint notification_eligible,
        (SELECT COUNT(*) FROM selected_first_power)::bigint first_power_total,
        (SELECT COUNT(*) FROM selected_first_power
          WHERE race_at>=(SELECT operational_at FROM metric_coverage_starts WHERE metric='firstRacePowerUse'))::bigint first_power_eligible`;
    const epoch = row?.epoch_id
      ? { id: row.epoch_id, startedAt: row.epoch_started_at }
      : null;
    const byMetric = {
      ...(row?.box_open_at
        ? {
            boxOpen: {
              operationalAt: row.box_open_at,
              operationalEtDate: row.box_open_et_date,
            },
          }
        : {}),
      ...(row?.first_power_at
        ? {
            firstRacePowerUse: {
              operationalAt: row.first_power_at,
              operationalEtDate: row.first_power_et_date,
            },
          }
        : {}),
    };
    const total = number(row?.total);
    const collectingSince = epoch ? row.epoch_started_et_date : null;
    const diagnostic = (eligible, totalPopulation) => ({
      eligible: number(eligible),
      totalPopulation: number(totalPopulation),
      eligibilityPercent: number(totalPopulation) === 0
        ? null
        : round1((number(eligible) / number(totalPopulation)) * 100),
    });
    const capable = (coverageField, eligibleField) => {
      if (!epoch) {
        return { status: "unavailable", collectingSince: null, eligible: 0, totalPopulation: total, eligibilityPercent: total ? 0 : null };
      }
      return {
        status: row?.[coverageField] === true ? "mature" : "collecting",
        collectingSince,
        ...diagnostic(row?.[eligibleField], total),
      };
    };
    const signupCoverage = (coverageField, eligibleField, totalField) => {
      if (!epoch) return { status:"unavailable",collectingSince:null,eligible:0,totalPopulation:number(row?.[totalField]),eligibilityPercent:number(row?.[totalField])?0:null };
      return {status:row?.[coverageField]===true?"mature":"collecting",collectingSince,...diagnostic(row?.[eligibleField],row?.[totalField])};
    };
    const eventCoverage = (metric, eligibleField = null, totalField = null) => {
      const metricRow = byMetric[metric];
      if (!metricRow) return { status: "unavailable", collectingSince: null, eligible: null, totalPopulation: null, eligibilityPercent: null };
      const operationalDate = metricRow.operationalEtDate;
      return {
        status: row?.[metric === "boxOpen" ? "box_open_full_window" : "first_power_full_window"] === true ? "mature" : "collecting",
        collectingSince: operationalDate,
        ...(eligibleField ? diagnostic(row?.[eligibleField],row?.[totalField]) : {eligible:null,totalPopulation:null,eligibilityPercent:null}),
      };
    };
    return {
      foregroundActivitySince: collectingSince,
      boxOpenOperationalSince: byMetric.boxOpen?.operationalAt?.toISOString() ?? null,
      metricCoverage: {
        observedForegroundDau: capable("epoch_covers_dau","capable_d1"),
        observedForegroundWau: capable("epoch_covers_wau","capable_d7"),
        observedForegroundMau: capable("epoch_covers_mau","capable_d30"),
        retentionD1: signupCoverage("epoch_covers_signup_d1","signup_eligible_d1","signup_total_d1"),
        retentionD7: signupCoverage("epoch_covers_signup_d7","signup_eligible_d7","signup_total_d7"),
        retentionD30: signupCoverage("epoch_covers_signup_d30","signup_eligible_d30","signup_total_d30"),
        healthWithin24h: signupCoverage("epoch_covers_signup_d1","signup_eligible_d1","signup_total_d1"),
        leaderboardViews: epoch ? {status:row?.epoch_covers_selected_window===true?"mature":"collecting",collectingSince,...diagnostic(row?.leaderboard_eligible,row?.leaderboard_total)} : {status:"unavailable",collectingSince:null,eligible:0,totalPopulation:number(row?.leaderboard_total),eligibilityPercent:number(row?.leaderboard_total)?0:null},
        notificationOpen: capable("epoch_covers_wau","notification_eligible"),
        boxOpen: eventCoverage("boxOpen"),
        firstRacePowerUse: eventCoverage("firstRacePowerUse","first_power_eligible","first_power_total"),
      },
      providerThrough: { appStoreConnect: null, admob: null },
    };
  }

  async function foregroundCounts(start, end) {
    const rows = await prisma.$queryRaw`
      WITH epoch AS (
        SELECT id FROM admin_metrics_collection_epochs
        WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
      ), eligible_activity AS (
        SELECT a.*,u.metrics_v2_eligible_at
        FROM user_activity_days a JOIN users u ON u.id=a.user_id
        WHERE u.apple_id IS NOT NULL AND u.is_review_account=false
          AND u.metrics_v2_eligible_epoch_id=(SELECT id FROM epoch)
          AND a.activity_date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
      )
      SELECT
        COUNT(DISTINCT user_id) FILTER (
          WHERE activity_date=CAST(${end} AS date)
            AND metrics_v2_eligible_at <= (
              (CAST(${end} AS date)::timestamp AT TIME ZONE 'America/New_York')
              AT TIME ZONE 'UTC'
            )
        )::bigint AS dau,
        COUNT(DISTINCT user_id) FILTER (
          WHERE activity_date >= CAST(${end} AS date)-6
            AND metrics_v2_eligible_at <= (
              ((CAST(${end} AS date)-6)::timestamp AT TIME ZONE 'America/New_York')
              AT TIME ZONE 'UTC'
            )
        )::bigint AS wau,
        COUNT(DISTINCT user_id) FILTER (
          WHERE activity_date >= CAST(${end} AS date)-29
            AND metrics_v2_eligible_at <= (
              ((CAST(${end} AS date)-29)::timestamp AT TIME ZONE 'America/New_York')
              AT TIME ZONE 'UTC'
            )
        )::bigint AS mau
      FROM eligible_activity`;
    return rows[0] || {};
  }

  async function observedRetention(end, includeCohorts = false, start = end) {
    const rows = await prisma.$queryRaw`
      WITH cohort AS (
        SELECT u.id,
          (u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date signup_date
        FROM users u
        WHERE u.apple_id IS NOT NULL AND u.is_review_account=false
          AND u.metrics_v2_signup_eligible=true
          AND u.metrics_v2_signup_epoch_id=(SELECT id FROM admin_metrics_collection_epochs WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1)
      )
      SELECT to_char(c.signup_date,'YYYY-MM-DD') signup_date,COUNT(*)::bigint eligible,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_activity_days a WHERE a.user_id=c.id AND a.activity_date=c.signup_date+1))::bigint d1,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_activity_days a WHERE a.user_id=c.id AND a.activity_date=c.signup_date+7))::bigint d7,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_activity_days a WHERE a.user_id=c.id AND a.activity_date=c.signup_date+30))::bigint d30
      FROM cohort c
      WHERE c.signup_date BETWEEN CAST(${includeCohorts ? start : "1900-01-01"} AS date) AND CAST(${end} AS date)
      GROUP BY c.signup_date ORDER BY c.signup_date`;
    return rows;
  }

  function pooledRetention(rows, end, horizon) {
    const matureEnd = new Date(`${end}T00:00:00Z`);
    matureEnd.setUTCDate(matureEnd.getUTCDate() - horizon - 1);
    const matureEndString = matureEnd.toISOString().slice(0, 10);
    const mature = rows
      .filter((row) => row.signup_date <= matureEndString)
      .slice(-30);
    return ratio(
      mature.reduce((sum, row) => sum + number(row[`d${horizon}`]), 0),
      mature.reduce((sum, row) => sum + number(row.eligible), 0)
    );
  }

  async function loadSummary({ start, end, coverageData }) {
    const [row] = await prisma.$queryRaw`
      SELECT
        (SELECT COUNT(*) FROM users u WHERE u.apple_id IS NOT NULL AND u.is_review_account=false)::bigint AS total_signups,
        (SELECT COUNT(*) FROM users u WHERE u.apple_id IS NOT NULL AND u.is_review_account=false
          AND (u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=CAST(${end} AS date))::bigint AS signups_today,
        (SELECT COUNT(*) FROM users u WHERE u.apple_id IS NOT NULL AND u.is_review_account=false
          AND (u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${end} AS date)-6 AND CAST(${end} AS date))::bigint AS signups_7d,
        (SELECT COUNT(DISTINCT e.actor_user_id) FROM race_powerup_events e JOIN users u ON u.id=e.actor_user_id
          WHERE e.event_type='MYSTERY_BOX_OPENED' AND u.apple_id IS NOT NULL AND u.is_review_account=false
          AND (e.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=CAST(${end} AS date))::bigint AS box_openers,
        (SELECT COUNT(*) FROM races r JOIN users c ON c.id=r.creator_id
          WHERE r.status='active' AND r.seed_id IS NULL AND r.tournament_id IS NULL
          AND c.apple_id IS NOT NULL AND c.is_review_account=false)::bigint AS active_non_featured,
        (SELECT COUNT(DISTINCT rp.user_id) FROM race_participants rp JOIN users u ON u.id=rp.user_id
          JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id
          WHERE rp.status='accepted' AND r.status='active' AND r.seed_id IS NULL AND r.tournament_id IS NULL
          AND u.apple_id IS NOT NULL AND u.is_review_account=false AND c.apple_id IS NOT NULL AND c.is_review_account=false)::bigint AS active_users,
        (SELECT COUNT(*) FROM races r JOIN race_seeds s ON s.id=r.seed_id
          WHERE r.status='active' AND s.cadence='daily')::bigint AS active_daily,
        (SELECT COUNT(*) FROM races r JOIN users c ON c.id=r.creator_id
          WHERE r.seed_id IS NULL AND r.tournament_id IS NULL AND c.apple_id IS NOT NULL AND c.is_review_account=false
          AND (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=CAST(${end} AS date))::bigint AS created_today`;
    const forwardAvailable = coverageData.metricCoverage.observedForegroundDau.status === "mature";
    const fg = forwardAvailable ? await foregroundCounts(start, end) : {};
    const retentionRows = await observedRetention(end);
    return {
      summary: {
        growth: {
          totalSignups: number(row.total_signups),
          signupsToday: number(row.signups_today),
          signupsLast7Days: number(row.signups_7d),
          engagedBoxOpenersToday: coverageData.metricCoverage.boxOpen.status === "mature" ? number(row.box_openers) : null,
          observedForegroundDau: forwardAvailable ? number(fg.dau) : null,
          observedForegroundWau: coverageData.metricCoverage.observedForegroundWau.status === "mature" ? number(fg.wau) : null,
        },
        retention: {
          d1: coverageData.metricCoverage.retentionD1.status === "mature" ? pooledRetention(retentionRows,end,1) : ratio(null,null,false),
          d7: coverageData.metricCoverage.retentionD7.status === "mature" ? pooledRetention(retentionRows,end,7) : ratio(null,null,false),
          d30: coverageData.metricCoverage.retentionD30.status === "mature" ? pooledRetention(retentionRows,end,30) : ratio(null,null,false),
        },
        races: {
          usersInActiveNonFeaturedRaces: number(row.active_users),
          activeNonFeaturedRaces: number(row.active_non_featured),
          activeDailyRaces: number(row.active_daily),
          nonFeaturedRacesCreatedToday: number(row.created_today),
        },
      },
    };
  }

  async function loadGrowth({ start, end, coverageData }) {
    const rows = await prisma.$queryRaw`
      WITH dates AS (SELECT generate_series(CAST(${start} AS date), CAST(${end} AS date), interval '1 day')::date d),
      epoch AS (
        SELECT id,started_at FROM admin_metrics_collection_epochs
        WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
      ),
      signups AS (
        SELECT (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date d, COUNT(*)::bigint n
        FROM users WHERE apple_id IS NOT NULL AND is_review_account=false
          AND created_at >= (
            (CAST(${start} AS date)::timestamp AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'UTC'
          )
          AND created_at < (
            ((CAST(${end} AS date)+1)::timestamp AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'UTC'
          )
        GROUP BY 1
      ), activity AS (
        SELECT a.activity_date d, COUNT(DISTINCT a.user_id)::bigint n
        FROM user_activity_days a JOIN users u ON u.id=a.user_id
        WHERE a.activity_date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
          AND u.apple_id IS NOT NULL AND u.is_review_account=false
          AND u.metrics_v2_eligible_epoch_id=(SELECT id FROM epoch)
          AND u.metrics_v2_eligible_at <= (
            (a.activity_date::timestamp AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'UTC'
          )
        GROUP BY 1
      )
      SELECT to_char(dates.d,'YYYY-MM-DD') date, COALESCE(signups.n,0)::bigint signups,
        CASE WHEN (SELECT started_at FROM epoch) <= (
          (dates.d::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'
        ) THEN COALESCE(activity.n,0)::bigint ELSE NULL END observed
      FROM dates LEFT JOIN signups USING(d) LEFT JOIN activity USING(d) ORDER BY dates.d`;
    const activityMature = coverageData.metricCoverage.observedForegroundDau.status === "mature";
    const fg = activityMature ? await foregroundCounts(start, end) : {};
    return {
      userGrowth: {
        daily: rows.map((row) => ({
          date: row.date,
          signups: number(row.signups),
          observedForegroundUsers:
            activityMature && row.observed != null ? number(row.observed) : null,
          appleFirstTimeDownloads: null,
          appleDeletions: null,
        })),
        observedForegroundWau: coverageData.metricCoverage.observedForegroundWau.status === "mature" ? number(fg.wau) : null,
        observedForegroundMau: coverageData.metricCoverage.observedForegroundMau.status === "mature" ? number(fg.mau) : null,
      },
    };
  }

  async function inviteCounts(start, end) {
    const configuredVersion = Number(env.REFERRAL_IP_HMAC_ACTIVE_VERSION);
    const configuredSecret = Number.isInteger(configuredVersion)
      ? env[`REFERRAL_IP_HMAC_SECRET_V${configuredVersion}`]
      : null;
    const activeConfigured =
      Number.isInteger(configuredVersion) && configuredVersion >= 1 &&
      typeof configuredSecret === "string" && configuredSecret.length >= 32;
    const activeHashVersion = activeConfigured ? configuredVersion : -1;
    const coverageMetric = activeConfigured
      ? `referralHmacV${activeHashVersion}`
      : "referralHmacUnavailable";
    const [row] = await prisma.$queryRaw`
      WITH coverage AS (
        SELECT operational_at FROM metric_coverage_starts
        WHERE metric=${coverageMetric}
      ), owned_codes AS (
        SELECT referral_code code FROM users WHERE apple_id IS NOT NULL AND is_review_account=false AND referral_code IS NOT NULL
      ), opens AS (
        SELECT lo.*, LAG(lo.created_at) OVER (PARTITION BY lo.code,lo.ip_hash_version,lo.ip_hash ORDER BY lo.created_at) prior
        FROM link_opens lo JOIN owned_codes oc ON oc.code=lo.code
        WHERE lo.kind='referral' AND lo.ip_hash_version=${activeHashVersion}
          AND (lo.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date
          BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
      ), signup_cohort AS (
        SELECT r.id,r.status,r.referee_id FROM referrals r JOIN users u ON u.id=r.referee_id
        JOIN users owner ON owner.id=r.referrer_id
        WHERE u.apple_id IS NOT NULL AND u.is_review_account=false AND owner.apple_id IS NOT NULL AND owner.is_review_account=false
          AND (u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
      ) SELECT
        (SELECT operational_at FROM coverage) hmac_operational_at,
        (SELECT operational_at <= (
          (CAST(${start} AS date)::timestamp AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'UTC'
        ) FROM coverage) hmac_full_window,
        (SELECT COUNT(*) FROM opens)::bigint link_opens,
        (SELECT COUNT(*) FROM opens WHERE ip_hash IS NULL OR prior IS NULL OR created_at-prior > interval '24 hours')::bigint unique_opens,
        (SELECT COUNT(*) FROM signup_cohort)::bigint signups,
        (SELECT COUNT(*) FROM signup_cohort s WHERE EXISTS (SELECT 1 FROM race_participants rp WHERE rp.user_id=s.referee_id AND rp.status='accepted'))::bigint joined,
        (SELECT COUNT(*) FROM signup_cohort WHERE status IN ('QUALIFIED','REWARDED'))::bigint qualified,
        (SELECT COUNT(*) FROM signup_cohort WHERE status='REWARDED')::bigint rewarded`;
    return {
      ...row,
      hmacCoverageStatus: !activeConfigured || !row?.hmac_operational_at
        ? "unavailable"
        : row.hmac_full_window === true
          ? "mature"
          : "collecting",
    };
  }

  async function loadFunnels({ start, end, days, generatedAt }) {
    const row = await inviteCounts(start, end);
    const hmacMature = row.hmacCoverageStatus === "mature";
    const opens = hmacMature ? number(row.link_opens) : null;
    const unique = hmacMature ? number(row.unique_opens) : null;
    const signups = number(row.signups), joined = number(row.joined), qualified = number(row.qualified), rewarded = number(row.rewarded);
    const cohortDays = days === 90 ? 30 : days;
    const cohortStartDate = new Date(`${end}T00:00:00Z`);
    cohortStartDate.setUTCDate(cohortStartDate.getUTCDate() - (cohortDays - 1));
    const cohortStart = cohortStartDate.toISOString().slice(0,10);
    const spine = ["onboarding_started", "health_cta_tapped", "health_granted", "daily_intro_viewed", "tutorial_opened", "demo_box_opened", "demo_powerup_used", "demo_won", "tutorial_completed", "home_reached"];
    const sideExits = new Set(["health_escaped","health_probe_inconclusive","tutorial_skipped"]);
    const stages = ["onboarding_started", "health_cta_tapped", "health_granted", "health_escaped", "health_probe_inconclusive", "daily_intro_viewed", "tutorial_opened", "tutorial_skipped", "demo_box_opened", "demo_powerup_used", "demo_won", "tutorial_completed", "home_reached"];
    const stageRows = await prisma.$queryRaw`
      WITH starts AS (
        SELECT DISTINCT ON (e.onboarding_session_id)
          e.onboarding_session_id,e.user_id,e.occurred_at
        FROM activation_events e JOIN users u ON u.id=e.user_id
        WHERE e.name='onboarding_started' AND e.platform='ios'
          AND e.onboarding_session_id IS NOT NULL
          AND u.apple_id IS NOT NULL AND u.is_review_account=false
          AND e.occurred_at <= CAST(${generatedAt} AS timestamp)-interval '24 hours'
          AND (e.occurred_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${cohortStart} AS date) AND CAST(${end} AS date)
        ORDER BY e.onboarding_session_id,e.occurred_at
      ) SELECT CASE WHEN e.name='health_result' AND e.context->>'result'='granted' THEN 'health_granted' ELSE e.name END name,
          COUNT(DISTINCT e.onboarding_session_id)::bigint count FROM activation_events e
        JOIN starts s ON s.onboarding_session_id=e.onboarding_session_id AND s.user_id=e.user_id
        WHERE e.platform='ios' AND e.occurred_at BETWEEN s.occurred_at AND s.occurred_at+interval '24 hours'
        GROUP BY 1`;
    const counts = Object.fromEntries(stageRows.map((r) => [r.name, number(r.count)]));
    const startCount = counts.onboarding_started || 0;
    let previous = null;
    return {
      inviteFunnel: {
        linkOpens: opens, uniqueLinkOpens: unique, attributedSignups: signups, joinedRace: joined, qualified, rewarded,
        openToSignup: ratio(signups, unique, hmacMature), signupToJoinedRace: ratio(joined, signups),
        joinedRaceToQualified: ratio(qualified, joined), qualifiedToRewarded: ratio(rewarded, qualified),
      },
      onboardingFunnel: {
        cohortWindowDays: cohortDays,
        stages: stages.map((key) => {
          const count = counts[key] || 0;
          const item = { key, count, previousSpineConversion: sideExits.has(key) || previous == null ? ratio(null, null, false) : ratio(count, previous), startConversion: ratio(count, startCount) };
          if (spine.includes(key)) previous = count;
          return item;
        }),
      },
    };
  }

  async function loadActivation({ start, end, coverageData, generatedAt }) {
    const rows = await prisma.$queryRaw`
      WITH dates AS (SELECT generate_series(CAST(${start} AS date),CAST(${end} AS date),interval '1 day')::date d), eligible_races AS (
        SELECT r.* FROM races r JOIN users c ON c.id=r.creator_id WHERE r.seed_id IS NULL AND r.tournament_id IS NULL
          AND r.status<>'cancelled' AND c.apple_id IS NOT NULL AND c.is_review_account=false
      ) SELECT to_char(d.d,'YYYY-MM-DD') date,
        (SELECT COUNT(DISTINCT rp.user_id) FROM eligible_races r JOIN race_participants rp ON rp.race_id=r.id JOIN users u ON u.id=rp.user_id
          WHERE rp.status='accepted' AND u.apple_id IS NOT NULL AND u.is_review_account=false AND r.started_at IS NOT NULL
          AND (r.started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') < d.d+interval '1 day'
          AND COALESCE((r.completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'),
            (CAST(${generatedAt} AS timestamp) AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'))>d.d)::bigint live,
        (SELECT COUNT(DISTINCT creator_id) FROM eligible_races r WHERE (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint creators,
        (SELECT COUNT(*) FROM eligible_races r WHERE (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint created FROM dates d ORDER BY d.d`;
    const friendRows = await prisma.$queryRaw`
      WITH c AS (SELECT u.id,(SELECT COUNT(*) FROM friendships f WHERE f.status='ACCEPTED' AND (f.requester_id=u.id OR f.addressee_id=u.id)) n
        FROM users u WHERE u.apple_id IS NOT NULL AND u.is_review_account=false), b AS (
        SELECT CASE WHEN n=0 THEN '0' WHEN n=1 THEN '1' WHEN n=2 THEN '2' WHEN n<=5 THEN '3-5' ELSE '6+' END bucket,COUNT(*)::bigint count FROM c GROUP BY 1)
      SELECT * FROM b`;
    const byBucket = Object.fromEntries(friendRows.map((r) => [r.bucket, number(r.count)]));
    const total = Object.values(byBucket).reduce((a,b)=>a+b,0);
    const [activationRow] = await prisma.$queryRaw`
      WITH epoch AS (
        SELECT id FROM admin_metrics_collection_epochs
        WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
      ), mature_signups AS (
        SELECT u.id,u.created_at
        FROM users u
        WHERE u.apple_id IS NOT NULL AND u.is_review_account=false
          AND u.metrics_v2_signup_eligible=true
          AND u.metrics_v2_signup_epoch_id=(SELECT id FROM epoch)
          AND (u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date
            BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
          AND u.created_at <= CAST(${generatedAt} AS timestamp)-interval '24 hours'
      )
      SELECT COUNT(*)::bigint denominator,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM activation_events e
          WHERE e.user_id=mature_signups.id AND e.name='health_connected'
            AND e.platform='ios' AND e.occurred_at>=mature_signups.created_at
            AND e.occurred_at<=mature_signups.created_at+interval '24 hours'
        ))::bigint health,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM races r JOIN users c ON c.id=r.creator_id
          WHERE r.creator_id=mature_signups.id AND r.seed_id IS NULL
            AND r.tournament_id IS NULL AND r.status<>'cancelled'
            AND c.apple_id IS NOT NULL AND c.is_review_account=false
            AND r.created_at>=mature_signups.created_at
            AND r.created_at<=mature_signups.created_at+interval '24 hours'
          UNION ALL
          SELECT 1 FROM race_participants rp JOIN races r ON r.id=rp.race_id
            JOIN users c ON c.id=r.creator_id
          WHERE rp.user_id=mature_signups.id AND rp.status='accepted'
            AND r.seed_id IS NULL AND r.tournament_id IS NULL
            AND r.status<>'cancelled' AND c.apple_id IS NOT NULL
            AND c.is_review_account=false
            AND rp.joined_at>=mature_signups.created_at
            AND rp.joined_at<=mature_signups.created_at+interval '24 hours'
        ))::bigint race
      FROM mature_signups`;
    const [firstPowerRow] = await prisma.$queryRaw`
      WITH coverage AS (
        SELECT operational_at FROM metric_coverage_starts
        WHERE metric='firstRacePowerUse'
      ), qualifying AS (
        SELECT rp.user_id,r.id race_id,COALESCE(r.started_at,r.created_at) race_at,
          ROW_NUMBER() OVER (
            PARTITION BY rp.user_id
            ORDER BY COALESCE(r.started_at,r.created_at),r.id
          ) sequence
        FROM race_participants rp JOIN users u ON u.id=rp.user_id
          JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id
        WHERE rp.status='accepted' AND u.apple_id IS NOT NULL
          AND u.is_review_account=false AND c.apple_id IS NOT NULL
          AND c.is_review_account=false AND r.seed_id IS NULL
          AND r.tournament_id IS NULL AND r.status<>'cancelled'
          AND r.powerups_enabled=true
          AND (SELECT COUNT(*) FROM race_participants field
            WHERE field.race_id=r.id AND field.status='accepted')>=2
      ), firsts AS (
        SELECT * FROM qualifying WHERE sequence=1
          AND race_at>=(SELECT operational_at FROM coverage)
          AND (race_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date
            BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
      )
      SELECT COUNT(*)::bigint denominator,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM race_powerup_events e
          WHERE e.race_id=firsts.race_id AND e.actor_user_id=firsts.user_id
            AND e.event_type='POWERUP_USED'
        ))::bigint numerator
      FROM firsts`;
    const signupActivationAvailable = coverageData.metricCoverage.healthWithin24h.status === "mature";
    const firstPowerAvailable = coverageData.metricCoverage.firstRacePowerUse.status === "mature";
    return {
      activation: {
        daily: rows.map((r)=>({date:r.date,liveRaceParticipants:number(r.live),raceCreators:number(r.creators),racesCreated:number(r.created)})),
        healthWithin24h: signupActivationAvailable ? ratio(activationRow.health,activationRow.denominator) : ratio(null,null,false),
        raceWithin24h: signupActivationAvailable ? ratio(activationRow.race,activationRow.denominator) : ratio(null,null,false),
        firstRacePowerUse: firstPowerAvailable ? ratio(firstPowerRow.numerator,firstPowerRow.denominator) : ratio(null,null,false),
        friends: FRIEND_BUCKETS.map((bucket)=>({bucket,ratio:ratio(byBucket[bucket]||0,total)})),
      },
    };
  }

  async function loadRetention({ start, end, coverageData, generatedAt }) {
    const rows=await observedRetention(end,true,start);
    const byDate=Object.fromEntries(rows.map(row=>[row.signup_date,row]));
    const dates=[]; for(let d=new Date(`${start}T00:00:00Z`);d<=new Date(`${end}T00:00:00Z`);d=new Date(d.getTime()+86400000)) dates.push(d.toISOString().slice(0,10));
    const mature=(date,horizon)=>new Date(`${date}T00:00:00Z`).getTime()+horizon*86400000<new Date(`${end}T00:00:00Z`).getTime();
    const repeat=await prisma.$queryRaw`
      WITH ranked AS (
        SELECT rp.user_id,r.id race_id,r.completed_at,r.status,
          rp.finished_at,rp.forfeited_at,
          ROW_NUMBER() OVER(
            PARTITION BY rp.user_id
            ORDER BY COALESCE(r.started_at,r.created_at),r.id
          ) rn
        FROM race_participants rp JOIN users u ON u.id=rp.user_id JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id
        WHERE rp.status='accepted' AND r.seed_id IS NULL AND r.tournament_id IS NULL
          AND r.status<>'cancelled'
          AND u.apple_id IS NOT NULL AND u.is_review_account=false AND c.apple_id IS NOT NULL AND c.is_review_account=false
      ), firsts AS (
        SELECT * FROM ranked WHERE rn=1 AND finished_at IS NOT NULL
          AND forfeited_at IS NULL AND completed_at IS NOT NULL
          AND status='completed'
      )
      SELECT
        COUNT(*) FILTER(WHERE completed_at<=CAST(${generatedAt} AS timestamp)-interval '7 days'
          AND (completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint d7_den,
        COUNT(*) FILTER(WHERE completed_at<=CAST(${generatedAt} AS timestamp)-interval '7 days'
          AND (completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
          AND EXISTS(SELECT 1 FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id WHERE rp.user_id=firsts.user_id AND rp.status='accepted' AND r.id<>firsts.race_id AND r.seed_id IS NULL AND r.tournament_id IS NULL AND r.status<>'cancelled' AND c.apple_id IS NOT NULL AND c.is_review_account=false AND rp.joined_at>firsts.completed_at AND rp.joined_at<=firsts.completed_at+interval '7 days'))::bigint d7_num,
        COUNT(*) FILTER(WHERE completed_at<=CAST(${generatedAt} AS timestamp)-interval '30 days'
          AND (completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint d30_den,
        COUNT(*) FILTER(WHERE completed_at<=CAST(${generatedAt} AS timestamp)-interval '30 days'
          AND (completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
          AND EXISTS(SELECT 1 FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id WHERE rp.user_id=firsts.user_id AND rp.status='accepted' AND r.id<>firsts.race_id AND r.seed_id IS NULL AND r.tournament_id IS NULL AND r.status<>'cancelled' AND c.apple_id IS NOT NULL AND c.is_review_account=false AND rp.joined_at>firsts.completed_at AND rp.joined_at<=firsts.completed_at+interval '30 days'))::bigint d30_num
      FROM firsts`;
    const rep=repeat[0]||{};
    return { retention: {
      d1:coverageData.metricCoverage.retentionD1.status==="mature"?pooledRetention(rows,end,1):ratio(null,null,false),
      d7:coverageData.metricCoverage.retentionD7.status==="mature"?pooledRetention(rows,end,7):ratio(null,null,false),
      d30:coverageData.metricCoverage.retentionD30.status==="mature"?pooledRetention(rows,end,30):ratio(null,null,false),
      cohorts:dates.map(signupDate=>{const row=byDate[signupDate];const eligible=number(row?.eligible);return {signupDate,eligibleSignups:eligible,d1:mature(signupDate,1)?ratio(number(row?.d1),eligible):ratio(null,null,false),d7:mature(signupDate,7)?ratio(number(row?.d7),eligible):ratio(null,null,false),d30:mature(signupDate,30)?ratio(number(row?.d30),eligible):ratio(null,null,false)};}),
      secondRaceWithin7d:ratio(rep.d7_num,rep.d7_den),secondRaceWithin30d:ratio(rep.d30_num,rep.d30_den) } };
  }

  async function loadEngagement({ start, end, coverageData, generatedAt }) {
    const rows = await prisma.$queryRaw`
      WITH dates AS (SELECT generate_series(CAST(${start} AS date),CAST(${end} AS date),interval '1 day')::date d), er AS (
        SELECT r.* FROM races r JOIN users c ON c.id=r.creator_id
        WHERE r.seed_id IS NULL AND r.tournament_id IS NULL
          AND r.status<>'cancelled' AND c.apple_id IS NOT NULL
          AND c.is_review_account=false
      ), em AS (
        SELECT rp.* FROM race_participants rp JOIN er r ON r.id=rp.race_id
          JOIN users u ON u.id=rp.user_id
        WHERE rp.status='accepted' AND u.apple_id IS NOT NULL
          AND u.is_review_account=false
      )
      SELECT to_char(d.d,'YYYY-MM-DD') date,
        (SELECT COUNT(*) FROM er r WHERE (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint created,
        (SELECT COUNT(*) FROM er r WHERE (r.started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint started,
        (SELECT COUNT(DISTINCT rp.user_id) FROM em rp WHERE (rp.joined_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint new_participants,
        (SELECT COUNT(DISTINCT rp.user_id) FROM em rp JOIN er r ON r.id=rp.race_id WHERE r.started_at IS NOT NULL AND (r.started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')<d.d+interval '1 day' AND COALESCE((r.completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'),(CAST(${generatedAt} AS timestamp) AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'))>d.d)::bigint live,
        (SELECT COUNT(*) FROM race_powerup_events e JOIN em rp ON rp.race_id=e.race_id AND rp.user_id=e.actor_user_id WHERE e.event_type='POWERUP_USED' AND (e.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint powers,
        (SELECT COALESCE(SUM(GREATEST(ct.amount,0)),0) FROM coin_transactions ct JOIN users u ON u.id=ct.user_id WHERE u.apple_id IS NOT NULL AND u.is_review_account=false AND (ct.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint credits,
        (SELECT COALESCE(SUM(GREATEST(-ct.amount,0)),0) FROM coin_transactions ct JOIN users u ON u.id=ct.user_id WHERE u.apple_id IS NOT NULL AND u.is_review_account=false AND (ct.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint debits,
        (SELECT COUNT(*) FROM daily_reward_claims c JOIN users u ON u.id=c.user_id WHERE u.apple_id IS NOT NULL AND u.is_review_account=false AND (c.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint claims,
        (SELECT COUNT(DISTINCT c.user_id) FROM daily_reward_claims c JOIN users u ON u.id=c.user_id WHERE u.apple_id IS NOT NULL AND u.is_review_account=false AND (c.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date=d.d)::bigint claimers FROM dates d ORDER BY d.d`;
    const [stats] = await prisma.$queryRaw`
      WITH er AS (
        SELECT r.* FROM races r JOIN users c ON c.id=r.creator_id
        WHERE r.seed_id IS NULL AND r.tournament_id IS NULL
          AND r.status<>'cancelled' AND c.apple_id IS NOT NULL
          AND c.is_review_account=false
      ), em AS (
        SELECT rp.* FROM race_participants rp JOIN er r ON r.id=rp.race_id
          JOIN users u ON u.id=rp.user_id
        WHERE rp.status='accepted' AND u.apple_id IS NOT NULL
          AND u.is_review_account=false
      ), balances AS (SELECT coins::numeric coins FROM users WHERE apple_id IS NOT NULL AND is_review_account=false)
      SELECT (SELECT COUNT(*) FROM er WHERE started_at IS NOT NULL
          AND (started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint started,
        (SELECT COUNT(*) FROM em rp JOIN er r ON r.id=rp.race_id WHERE r.started_at IS NOT NULL
          AND (r.started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint runners,
        (SELECT COUNT(*) FROM er WHERE is_public=true
          AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint public_count,
        (SELECT COUNT(*) FROM er
          WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint visibility_total,
        (SELECT COUNT(*) FROM race_powerup_events e JOIN em rp ON rp.race_id=e.race_id AND rp.user_id=e.actor_user_id WHERE e.event_type='POWERUP_USED'
          AND (e.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint powers,
        (SELECT COUNT(*) FROM er WHERE powerups_enabled=true AND started_at IS NOT NULL
          AND (started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint power_races,
        (SELECT COUNT(*) FROM balances)::bigint pop,(SELECT COALESCE(SUM(coins),0) FROM balances)::numeric total,(SELECT AVG(coins) FROM balances)::float avg,
        (SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY coins) FROM balances)::float median,(SELECT percentile_cont(0.9) WITHIN GROUP(ORDER BY coins) FROM balances)::float p90`;
    const notificationRows = await prisma.$queryRaw`
      WITH epoch AS (
        SELECT started_at FROM admin_metrics_collection_epochs
        WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
      )
      SELECT d.notification_type,
        COUNT(DISTINCT d.id)::bigint denominator,
        COUNT(DISTINCT d.id) FILTER (WHERE d.opened_at IS NOT NULL)::bigint numerator
      FROM push_deliveries d JOIN users u ON u.id=d.user_id
      WHERE d.open_capable=true AND d.provider_accepted_at IS NOT NULL
        AND u.apple_id IS NOT NULL AND u.is_review_account=false
        AND d.provider_accepted_at >= GREATEST(
          CAST(${generatedAt} AS timestamp)-interval '7 days',
          (SELECT started_at FROM epoch)
        )
        AND d.provider_accepted_at <= CAST(${generatedAt} AS timestamp)
      GROUP BY d.notification_type ORDER BY d.notification_type`;
    const [observedRow] = await prisma.$queryRaw`
      WITH epoch AS (
        SELECT id FROM admin_metrics_collection_epochs
        WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
      ), capable_active AS (
        SELECT DISTINCT u.id FROM users u JOIN user_activity_days a ON a.user_id=u.id
        WHERE u.apple_id IS NOT NULL AND u.is_review_account=false
          AND u.metrics_v2_eligible_epoch_id=(SELECT id FROM epoch)
          AND u.metrics_v2_eligible_at<=CAST(${start} AS date)
          AND a.activity_date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date)
      ), capable_racers AS (
        SELECT DISTINCT u.id FROM users u JOIN race_participants rp ON rp.user_id=u.id
          JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id
        WHERE u.apple_id IS NOT NULL AND u.is_review_account=false
          AND u.metrics_v2_eligible_epoch_id=(SELECT id FROM epoch)
          AND u.metrics_v2_eligible_at<=CAST(${start} AS date)
          AND rp.status='accepted' AND r.seed_id IS NULL
          AND r.tournament_id IS NULL AND r.status<>'cancelled'
          AND c.apple_id IS NOT NULL AND c.is_review_account=false
      ) SELECT
        (SELECT COUNT(*) FROM capable_active)::bigint active_denominator,
        (SELECT COUNT(*) FROM capable_active a JOIN race_participants rp ON rp.user_id=a.id
          JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id
          WHERE rp.status='accepted' AND r.seed_id IS NULL AND r.tournament_id IS NULL
            AND r.status<>'cancelled' AND c.apple_id IS NOT NULL AND c.is_review_account=false
            AND r.started_at IS NOT NULL
            AND (r.started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date<=CAST(${end} AS date)
            AND COALESCE((r.completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,CAST(${end} AS date)+1)>CAST(${start} AS date))::bigint active_memberships,
        (SELECT COUNT(*) FROM capable_racers)::bigint racer_denominator,
        (SELECT COUNT(*) FROM activation_events e JOIN capable_racers r ON r.id=e.user_id
          WHERE e.name='race_leaderboard_viewed' AND e.platform='ios'
            AND (e.occurred_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date
              BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint leaderboard_views`;
    const featuredRows = await prisma.$queryRaw`
      SELECT s.cadence,
        COUNT(DISTINCT rp.user_id) FILTER (WHERE r.started_at IS NOT NULL
          AND (r.started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date<=CAST(${end} AS date)
          AND COALESCE((r.completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,CAST(${end} AS date)+1)>CAST(${start} AS date))::bigint active_users,
        COUNT(*) FILTER (WHERE r.started_at IS NOT NULL
          AND (r.started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date<=CAST(${end} AS date)
          AND COALESCE((r.completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,CAST(${end} AS date)+1)>CAST(${start} AS date))::bigint active_memberships,
        COUNT(DISTINCT rp.user_id) FILTER (WHERE
          (rp.joined_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint joined_users,
        COUNT(*) FILTER (WHERE
          (rp.joined_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date BETWEEN CAST(${start} AS date) AND CAST(${end} AS date))::bigint joined_memberships
      FROM races r JOIN race_seeds s ON s.id=r.seed_id
        JOIN race_participants rp ON rp.race_id=r.id JOIN users u ON u.id=rp.user_id
      WHERE rp.status='accepted' AND r.status<>'cancelled'
        AND u.apple_id IS NOT NULL AND u.is_review_account=false
        AND s.cadence IN ('daily','weekly') GROUP BY s.cadence`;
    const [rankedRow] = await prisma.$queryRaw`
      SELECT COUNT(DISTINCT m.user_id)::bigint users
      FROM ranked_cohort_members m JOIN ranked_weeks w ON w.id=m.week_id
        JOIN users u ON u.id=m.user_id
      WHERE u.apple_id IS NOT NULL AND u.is_review_account=false
        AND w.starts_on<CAST(${end} AS date)+1 AND w.ends_on>CAST(${start} AS date)`;
    const pub=number(stats.public_count),vis=number(stats.visibility_total);
    const daily=rows.map(r=>({date:r.date,racesCreated:number(r.created),racesStarted:number(r.started),newParticipants:number(r.new_participants),liveRaceParticipants:number(r.live),powerupsUsed:number(r.powers),grossCoinCredits:number(r.credits),grossCoinDebits:number(r.debits),dailyRewardClaims:number(r.claims),distinctDailyRewardClaimers:number(r.claimers)}));
    const emptyFeatured={activeOverlapUsers:0,activeOverlapMemberships:0,joinedWindowUsers:0,joinedWindowMemberships:0};
    const featuredByCadence=Object.fromEntries(featuredRows.map(row=>[String(row.cadence).toLowerCase(),{activeOverlapUsers:number(row.active_users),activeOverlapMemberships:number(row.active_memberships),joinedWindowUsers:number(row.joined_users),joinedWindowMemberships:number(row.joined_memberships)}]));
    const notificationAvailable = coverageData.metricCoverage.notificationOpen.status === "mature";
    const notificationNumerator = notificationRows.reduce((sum,row)=>sum+number(row.numerator),0);
    const notificationDenominator = notificationRows.reduce((sum,row)=>sum+number(row.denominator),0);
    const notificationRatio = notificationAvailable
      ? ratio(notificationNumerator,notificationDenominator)
      : ratio(null,null,false);
    const foregroundAvailable=coverageData.metricCoverage.observedForegroundDau.status==="mature";
    const leaderboardAvailable=coverageData.metricCoverage.leaderboardViews.status==="mature";
    return { raceEngagement:{ daily,averageRunnersPerStartedRace:average(stats.runners,stats.started).average,visibility:{public:ratio(pub,vis),private:ratio(vis-pub,vis)},racesPerObservedActiveUser:foregroundAvailable?average(observedRow.active_memberships,observedRow.active_denominator):average(null,null,false),leaderboardViewsPerCapableRacer:leaderboardAvailable?average(observedRow.leaderboard_views,observedRow.racer_denominator):average(null,null,false),powerupsPerRace:average(stats.powers,stats.power_races),coinBalance:{populationCount:number(stats.pop),total:number(stats.total),average:round1(stats.avg),median:round1(stats.median),p90:round1(stats.p90),asOf:generatedAt},featuredParticipation:{daily:featuredByCadence.daily||{...emptyFeatured},weekly:featuredByCadence.weekly||{...emptyFeatured}},rankedParticipationUsers:number(rankedRow.users),notificationOpenRate:{windowDays:7,...notificationRatio,breakdown:notificationAvailable?notificationRows.map(row=>({notificationType:row.notification_type,ratio:ratio(row.numerator,row.denominator)})):[]} } };
  }

  async function loadVirality({ start,end,coverageData }) {
    const row=await inviteCounts(start,end);
    const signups=number(row.signups);
    const hmacMature=row.hmacCoverageStatus==="mature";
    const unique=hmacMature?number(row.unique_opens):null;
    let attributedSignupsPerWau=null;
    if(coverageData.metricCoverage.observedForegroundWau.status==="mature"){
      const fg=await foregroundCounts(start,end);
      const wau=number(fg.wau);
      attributedSignupsPerWau=wau===0?null:round1(signups/wau);
    }
    return {virality:{shareCompletions:null,sharingUsers:null,attributedSignups:signups,attributedSignupsPerWau,linkOpenToSignup:ratio(signups,unique,hmacMature)}};
  }

  async function loadRevenue({ start,end }) {
    const rows=await prisma.$queryRaw`
      WITH dates AS (SELECT generate_series(CAST(${start} AS date),CAST(${end} AS date),interval '1 day')::date d),base AS (
        SELECT (g.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date d,g.reward_kind,g.user_id
        FROM ad_reward_grants g JOIN users u ON u.id=g.user_id
        WHERE u.apple_id IS NOT NULL AND u.is_review_account=false
          AND g.created_at >= (
            (CAST(${start} AS date)::timestamp AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'UTC'
          )
          AND g.created_at < (
            ((CAST(${end} AS date)+1)::timestamp AT TIME ZONE 'America/New_York')
            AT TIME ZONE 'UTC'
          )
      ),g AS (
        SELECT d,reward_kind,COUNT(*)::bigint grants,COUNT(DISTINCT user_id)::bigint watchers FROM base GROUP BY 1,2),totals AS (
        SELECT d,COUNT(DISTINCT user_id)::bigint total_watchers FROM base GROUP BY 1)
      SELECT to_char(dates.d,'YYYY-MM-DD') date,g.reward_kind,COALESCE(g.grants,0)::bigint grants,COALESCE(g.watchers,0)::bigint watchers,COALESCE(totals.total_watchers,0)::bigint total_watchers FROM dates LEFT JOIN g ON g.d=dates.d LEFT JOIN totals ON totals.d=dates.d ORDER BY dates.d,g.reward_kind`;
    const byDate=new Map(); for(const row of rows){if(!byDate.has(row.date))byDate.set(row.date,new Map());if(row.reward_kind)byDate.get(row.date).set(row.reward_kind,row)}
    const daily=[...byDate].map(([date,kinds])=>{const ssvByRewardKind=REWARD_KINDS.map(rewardKind=>({rewardKind,grants:number(kinds.get(rewardKind)?.grants),uniqueWatchers:number(kinds.get(rewardKind)?.watchers)}));const any=[...kinds.values()][0];return {date,impressions:null,ssvGrants:ssvByRewardKind.reduce((a,r)=>a+r.grants,0),uniqueSsvWatchers:number(any?.total_watchers),ssvByRewardKind,estimatedEarnings:null,matchRate:null,showRate:null};});
    const total=daily.reduce((a,r)=>a+r.ssvGrants,0);
    return {revenue:{daily,adRevenuePerDau:null,ssvGrantsPerRewardedImpression:{numerator:total,denominator:null,percent:null},byNetwork:[],realMoneyPurchases:{available:false,reason:"NO_IAP_PRODUCT"}}};
  }

  async function loadReleaseAdoption() {
    const rows=await prisma.$queryRaw`
      SELECT COALESCE(last_app_version,'unknown') version,COUNT(*)::bigint accounts
      FROM users WHERE apple_id IS NOT NULL AND is_review_account=false AND last_seen_at>=now()-interval '30 days'
      GROUP BY 1 ORDER BY accounts DESC,version`;
    return {releaseAdoption:{windowDays:30,versions:rows.map(r=>({version:r.version,accountsSeen:number(r.accounts)}))}};
  }

  return async function loadBlock({ section, days, generatedAt }) {
    const window=buildWindow(days,new Date(generatedAt));
    const coverageData=await coverage(generatedAt,window.start,window.end);
    const args={...window,days,generatedAt,coverageData};
    let block;
    if(section==="dashboard-summary")block=await loadSummary(args);
    else if(section==="dashboard-growth")block=await loadGrowth(args);
    else if(section==="dashboard-funnels")block=await loadFunnels(args);
    else if(section==="dashboard-activation")block=await loadActivation(args);
    else if(section==="dashboard-retention")block=await loadRetention(args);
    else if(section==="dashboard-engagement")block=await loadEngagement(args);
    else if(section==="dashboard-virality")block=await loadVirality(args);
    else if(section==="dashboard-revenue")block=await loadRevenue(args);
    else block=await loadReleaseAdoption(args);
    return {coverage:coverageData,...block};
  };
}

module.exports={buildAdminMetricsBlockLoader,ratio,average};
