const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const { hashAppleSub } = require("../../users/appleSubHash");

const EVENT = "fixed_team_payout_economy_monitor_v1";
const INTERVAL_MS = 60 * 60 * 1000;
const WARN_DAILY_COINS = 2_000;
const PAGE_DAILY_COINS = 4_000;

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function cohortHash(userIds) {
  return crypto
    .createHash("sha256")
    .update([...userIds].sort().join("\u0000"), "utf8")
    .digest("hex");
}

async function loadFixedTeamPayoutMonitoringSnapshot({
  prisma = defaultPrisma,
  now = new Date(),
} = {}) {
  const nowIso = now.toISOString();
  const [dailyRows, recipientRows, membershipRows] = await Promise.all([
    prisma.$queryRawUnsafe(`
      WITH bounds AS (
        SELECT date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC') AS current_day_utc
      ), days AS (
        SELECT generate_series(
          current_day_utc - interval '6 days',
          current_day_utc, interval '1 day'
        ) AS day FROM bounds
      ), totals AS (
        SELECT date_trunc('day', ct.created_at AT TIME ZONE 'UTC') AS day,
               COALESCE(sum(ct.amount) FILTER (
                 WHERE ct.reason = 'race_prize_pool_payout'
                   AND r.team_payout_version = 1
                   AND r.team_winner_reward_coins > 0
               ), 0) AS fixed_team_coins,
               COALESCE(sum(ct.amount) FILTER (WHERE ct.amount > 0), 0) AS positive_coins,
               COALESCE(-sum(ct.amount) FILTER (WHERE ct.amount < 0), 0) AS sink_coins
          FROM coin_transactions ct CROSS JOIN bounds
          LEFT JOIN races r ON r.id = split_part(ct.ref_id, ':', 1)
         WHERE ct.created_at >= (current_day_utc - interval '6 days') AT TIME ZONE 'UTC'
           AND ct.created_at < (current_day_utc + interval '1 day') AT TIME ZONE 'UTC'
         GROUP BY 1
      )
      SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
             COALESCE(t.fixed_team_coins, 0)::bigint AS "fixedTeamCoins",
             COALESCE(t.positive_coins, 0)::bigint AS "positiveCoins",
             COALESCE(t.sink_coins, 0)::bigint AS "sinkCoins"
        FROM days LEFT JOIN totals t USING (day)
       ORDER BY days.day DESC
    `, nowIso),
    prisma.$queryRawUnsafe(`
      SELECT r.id AS "raceId", r.max_duration_days AS "durationDays",
             r.winner_team AS "winnerTeam", rp.user_id AS "userId",
             rp.team, rp.raw_steps AS "rawSteps", rp.payout_coins AS "payoutCoins",
             rp.forfeited_at AS "forfeitedAt", u.apple_id AS "appleId",
             u.google_sub AS "googleSub"
        FROM races r
        JOIN race_participants rp ON rp.race_id = r.id
        JOIN users u ON u.id = rp.user_id
       WHERE r.team_payout_version = 1
         AND r.team_winner_reward_coins > 0
         AND r.completed_at >= $1::timestamptz - interval '7 days'
         AND r.completed_at <= $1::timestamptz
       ORDER BY r.id, rp.user_id
    `, nowIso),
    prisma.$queryRawUnsafe(`
      WITH memberships AS (
        SELECT rp.user_id, 'race:' || rp.race_id AS competition
          FROM race_participants rp JOIN races r ON r.id = rp.race_id
         WHERE rp.status = 'accepted' AND rp.finished_at IS NULL
           AND rp.forfeited_at IS NULL AND r.funded_prize = true
           AND r.creator_id IS NOT NULL AND r.seed_id IS NULL
           AND r.tournament_id IS NULL AND r.status IN ('pending', 'active')
        UNION
        SELECT tp.user_id, 'tournament:' || tp.tournament_id AS competition
          FROM tournament_participants tp
          JOIN tournaments t ON t.id = tp.tournament_id
         WHERE tp.status = 'accepted' AND tp.eliminated_in_round IS NULL
           AND t.funded_prize = true AND t.creator_id IS NOT NULL
           AND t.seed_id IS NULL AND t.status IN ('pending', 'active')
      )
      SELECT user_id AS "userId", count(*)::int AS count
        FROM memberships GROUP BY user_id ORDER BY user_id
    `),
  ]);

  const fixedTeamCoinsByDay = dailyRows.map((row) => ({
    day: row.day,
    fixedTeamCoins: integer(row.fixedTeamCoins),
    positiveCoins: integer(row.positiveCoins),
    sinkCoins: integer(row.sinkCoins),
    issuanceShare: ratio(integer(row.fixedTeamCoins), integer(row.positiveCoins)),
  }));
  const byRace = new Map();
  const byProvider = new Map();
  const coinsByIdentity = new Map();
  for (const row of recipientRows) {
    const race = byRace.get(row.raceId) || {
      raceId: row.raceId,
      durationDays: integer(row.durationDays),
      winnerTeam: row.winnerTeam || null,
      recipients: [],
    };
    race.recipients.push(row);
    byRace.set(row.raceId, race);
    if (integer(row.payoutCoins) <= 0) continue;
    coinsByIdentity.set(
      row.userId,
      (coinsByIdentity.get(row.userId) || 0) + integer(row.payoutCoins),
    );
    const providerHash = hashAppleSub(row.appleId || row.googleSub);
    if (providerHash) {
      byProvider.set(
        providerHash,
        (byProvider.get(providerHash) || 0) + integer(row.payoutCoins),
      );
    }
  }
  const races = [...byRace.values()];
  const totalPaidRecipients = recipientRows.filter((row) => integer(row.payoutCoins) > 0).length;
  const paidZeroStepRecipients = recipientRows.filter(
    (row) => integer(row.payoutCoins) > 0 && integer(row.rawSteps) === 0,
  ).length;
  const forfeits = recipientRows.filter((row) => row.forfeitedAt != null).length;
  const cohortCounts = new Map();
  for (const race of races) {
    const fingerprint = cohortHash(race.recipients.map((row) => row.userId));
    cohortCounts.set(fingerprint, (cohortCounts.get(fingerprint) || 0) + 1);
  }
  const providerCoins = [...byProvider.entries()]
    .map(([providerHash, coins]) => ({ providerHash, coins }))
    .sort((a, b) => b.coins - a.coins || a.providerHash.localeCompare(b.providerHash));
  const totalProviderCoins = providerCoins.reduce((sum, row) => sum + row.coins, 0);
  const membershipCounts = membershipRows.map((row) => integer(row.count)).sort((a, b) => a - b);
  return {
    measuredAt: now.toISOString(),
    fixedTeamCoinsByDay,
    membership: {
      p50: percentile(membershipCounts, 0.50),
      p90: percentile(membershipCounts, 0.90),
      p99: percentile(membershipCounts, 0.99),
      max: membershipCounts.at(-1) || 0,
      atCapAccounts: membershipCounts.filter((count) => count === 5).length,
      grandfatheredAboveCapAccounts: membershipCounts.filter((count) => count > 5).length,
    },
    capRejectionsSource: "structured_log:funded_exposure_limit_v1",
    paidZeroStepRecipients7d: paidZeroStepRecipients,
    paidZeroStepShare7d: ratio(paidZeroStepRecipients, totalPaidRecipients),
    tieRaceShare7d: ratio(races.filter((race) => race.winnerTeam == null).length, races.length),
    oneDayRaceShare7d: ratio(races.filter((race) => race.durationDays === 1).length, races.length),
    forfeits7d: forfeits,
    repeatedCohorts7d: [...cohortCounts.values()].filter((count) => count > 1).length,
    providerConcentration7d: {
      distinctProviders: providerCoins.length,
      topProviderShare: ratio(providerCoins[0]?.coins || 0, totalProviderCoins),
      topProviders: providerCoins.slice(0, 5),
    },
    identitiesOver1000Coins7d: [...coinsByIdentity.values()].filter((coins) => coins > 1_000).length,
  };
}

function evaluateFixedTeamPayoutAlert(snapshot) {
  const days = snapshot?.fixedTeamCoinsByDay || [];
  const currentCoins = integer(days[0]?.fixedTeamCoins);
  if (currentCoins > PAGE_DAILY_COINS) {
    return { severity: "page", reason: "CURRENT_UTC_DAY_ABOVE_4000", currentCoins };
  }
  if (
    integer(days[0]?.fixedTeamCoins) > WARN_DAILY_COINS &&
    integer(days[1]?.fixedTeamCoins) > WARN_DAILY_COINS
  ) {
    return { severity: "warn", reason: "TWO_CONSECUTIVE_UTC_DAYS_ABOVE_2000", currentCoins };
  }
  return { severity: "info", reason: null, currentCoins };
}

function buildFixedTeamPayoutMonitor(dependencies = {}) {
  const loadSnapshot = dependencies.loadSnapshot ||
    ((options) => loadFixedTeamPayoutMonitoringSnapshot({
      prisma: dependencies.prisma || defaultPrisma,
      now: options.now,
    }));
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());
  return async function monitorFixedTeamPayouts() {
    const snapshot = await loadSnapshot({ now: now() });
    const alert = evaluateFixedTeamPayoutAlert(snapshot);
    const event = { event: EVENT, ...alert, ...snapshot };
    if (alert.severity === "page") logger.error(event);
    else if (alert.severity === "warn") logger.warn(event);
    else logger.log(event);
    return snapshot;
  };
}

function scheduleFixedTeamPayoutMonitoring(dependencies = {}) {
  const run = buildFixedTeamPayoutMonitor(dependencies);
  const logger = dependencies.logger || console;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      logger.error({ event: EVENT, severity: "error", error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || INTERVAL_MS);
  interval.unref?.();
  return { stop: () => clearInterval(interval), run: tick };
}

module.exports = {
  EVENT,
  INTERVAL_MS,
  PAGE_DAILY_COINS,
  WARN_DAILY_COINS,
  buildFixedTeamPayoutMonitor,
  evaluateFixedTeamPayoutAlert,
  loadFixedTeamPayoutMonitoringSnapshot,
  scheduleFixedTeamPayoutMonitoring,
};
