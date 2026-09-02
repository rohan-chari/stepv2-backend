const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const {
  assertFixtureDatabase,
  assertNoSyntheticRows,
  baselineIntegrity,
  cleanupSyntheticRun: cleanupGenericSyntheticRun,
} = require("./fixtures");
const { resetGlobalEventDerivedState } = require("./globalEventReliabilityFixtures");

const CHUNK_SIZE = 1000;
const SESSION_TOKEN_ISSUER = "steps-tracker-api";
const SESSION_TOKEN_EXPIRY = "90d";
const CURRENT_FEATURES = [
  "characters", "ads", "ad_coin_random", "jammer", "spinpowerups", "team_races",
  "tournaments", "race_leave", "powerups2", "powerups3", "powerups4", "powerups5",
  "stealth_runner_duration", "hitchhike_effective_steps", "remote_assets",
  "remote_asset_preferred", "next_race_cta", "discoverable_identity",
  "home_suggested_races", "seeded_race_buckets", "home_invite_modal",
  "race_participants_paging", "race_preview", "privacy_safe_display_ranks",
  "powerup_stacking_guide_v1", "impact_notices", "active_impact_notices_v1",
  "resolved_impact_events_v2", "impact_summaries", "impact_summary_expiry_v1",
  "review_prompt", "inbox_v1", "privateJoinApproval", "api_payload_compact_v1",
  "referral_contest_v1", "referral_contest_global_v1", "admin_metrics_v2",
  "race_payout_flat_50",
];

function signHomeOpenFixtureToken({ userId, appleId, env = {} } = {}) {
  const secret = env.SESSION_TOKEN_SECRET;
  if (!String(secret || "")) {
    throw new Error("home-open fixture requires its isolated SESSION_TOKEN_SECRET");
  }
  return jwt.sign({ appleId }, secret, {
    subject: userId,
    issuer: SESSION_TOKEN_ISSUER,
    expiresIn: SESSION_TOKEN_EXPIRY,
    algorithm: "HS256",
  });
}

async function createMany(model, rows) {
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    await model.createMany({ data: rows.slice(index, index + CHUNK_SIZE), skipDuplicates: true });
  }
}

function allocateCounts(total, weightedRows, weightKey, labelKey) {
  const rows = weightedRows.length ? weightedRows : [{ [labelKey]: 1, [weightKey]: 1 }];
  const weight = rows.reduce((sum, row) => sum + Math.max(0, Number(row[weightKey]) || 0), 0) || 1;
  const result = rows.map((row) => ({
    label: String(row[labelKey]),
    exact: total * Math.max(0, Number(row[weightKey]) || 0) / weight,
  }));
  const counts = result.map((row) => Math.floor(row.exact));
  let remaining = total - counts.reduce((sum, value) => sum + value, 0);
  for (const index of result.map((row, index) => ({ index, fraction: row.exact - counts[index] }))
    .sort((left, right) => right.fraction - left.fraction).map((row) => row.index)) {
    if (remaining-- <= 0) break;
    counts[index] += 1;
  }
  return Object.fromEntries(result.map((row, index) => [row.label, counts[index]]));
}

function interleaveActiveRaceCounts(usersByActiveRaceCount) {
  const cohorts = Object.entries(usersByActiveRaceCount).map(([label, count]) => ({
    label: Number(label), target: Number(count), allocated: 0,
  })).filter((row) => Number.isInteger(row.label) && row.label >= 0 &&
    Number.isInteger(row.target) && row.target > 0)
    .sort((left, right) => left.label - right.label);
  const total = cohorts.reduce((sum, row) => sum + row.target, 0);
  const sequence = [];
  for (let position = 1; position <= total; position += 1) {
    const selected = cohorts.filter((row) => row.allocated < row.target)
      .sort((left, right) => {
        const leftDeficit = position * left.target / total - left.allocated;
        const rightDeficit = position * right.target / total - right.allocated;
        return rightDeficit - leftDeficit || left.label - right.label;
      })[0];
    selected.allocated += 1;
    sequence.push(selected.label);
  }
  return sequence;
}

function scaleHomeTopology({
  syntheticUsers,
  activeRaceCountDistribution = [],
  participantBands = [],
} = {}) {
  if (!Number.isInteger(syntheticUsers) || syntheticUsers < 1 || syntheticUsers > 5000) {
    throw new Error("home-open fixture users must be 1-5000");
  }
  const usersByActiveRaceCount = allocateCounts(
    syntheticUsers, activeRaceCountDistribution, "users", "activeRaceCount");
  const membershipCount = Object.entries(usersByActiveRaceCount)
    .reduce((sum, [count, users]) => sum + Number(count) * users, 0);
  const totalBandRaces = participantBands.reduce((sum, row) => sum + Number(row.races || 0), 0);
  const weightedParticipants = participantBands.reduce((sum, row) =>
    sum + Number(row.races || 0) * Number(row.medianParticipants || 1), 0);
  const targetRaceSize = totalBandRaces ? Math.max(2, Math.round(weightedParticipants / totalBandRaces)) : 25;
  const maximumActiveRaceCount = Math.max(0, ...Object.entries(usersByActiveRaceCount)
    .filter(([, count]) => count > 0).map(([activeRaceCount]) => Number(activeRaceCount)));
  const raceCount = Math.max(1, Math.min(100, Math.max(maximumActiveRaceCount,
    Math.ceil(Math.max(1, membershipCount) / targetRaceSize))));
  const eligibleUsers = Object.entries(usersByActiveRaceCount)
    .filter(([activeRaceCount]) => Number(activeRaceCount) > 0)
    .reduce((sum, [, count]) => sum + count, 0);
  const intendedBands = allocateCounts(raceCount, participantBands, "races", "band");
  const medianByBand = Object.fromEntries(participantBands.map((row) =>
    [String(row.band), Math.max(1, Math.min(eligibleUsers || syntheticUsers,
      Math.round(Number(row.medianParticipants) || 1)))]));
  const raceParticipantTargets = Object.entries(intendedBands).flatMap(([band, count]) =>
    Array.from({ length: count }, () => medianByBand[band] || 1));
  while (raceParticipantTargets.length < raceCount) raceParticipantTargets.push(1);
  let delta = membershipCount - raceParticipantTargets.reduce((sum, value) => sum + value, 0);
  for (let cursor = 0; delta !== 0 && cursor < syntheticUsers * raceCount * 2; cursor += 1) {
    const index = cursor % raceParticipantTargets.length;
    if (delta > 0 && raceParticipantTargets[index] < syntheticUsers) {
      raceParticipantTargets[index] += 1; delta -= 1;
    } else if (delta < 0 && raceParticipantTargets[index] > 0) {
      raceParticipantTargets[index] -= 1; delta += 1;
    }
  }
  if (delta !== 0) throw new Error("home-open topology cannot materialize participant distribution");
  const participantBand = (size) => size < 10 ? "1-9" : size < 50 ? "10-49" :
    size < 200 ? "50-199" : "200+";
  const racesByParticipantBand = raceParticipantTargets.reduce((result, size) => {
    const band = participantBand(size); result[band] = (result[band] || 0) + 1; return result;
  }, {});
  return { syntheticUsers, usersByActiveRaceCount, membershipCount, raceCount,
    racesByParticipantBand, raceParticipantTargets, targetRaceSize };
}

function homeStepPayload({ userIndex } = {}) {
  const index = Number(userIndex);
  if (!Number.isInteger(index) || index < 0 || index >= 5000) {
    throw new Error("home-open user index must be 0-4999");
  }
  const steps = 4000 + (index * 7919 % 12000);
  const sampleSteps = Math.min(steps, 500 + (index * 1543 % 3500));
  return { steps, sampleSteps };
}

async function aggregateSnapshotTopology(prisma) {
  const [activeCounts, bands, sampleWindow, activeEvents] = await Promise.all([
    prisma.$queryRawUnsafe(`
      WITH counts AS (
        SELECT u.id, count(r.id)::int AS active_race_count
        FROM users u
        LEFT JOIN race_participants rp ON rp.user_id=u.id AND rp.status='accepted'
        LEFT JOIN races r ON r.id=rp.race_id AND r.status='active'
        GROUP BY u.id
      )
      SELECT active_race_count AS "activeRaceCount", count(*)::int AS users
      FROM counts GROUP BY active_race_count ORDER BY active_race_count`),
    prisma.$queryRawUnsafe(`
      WITH sizes AS (
        SELECT r.id, count(rp.id)::int AS participants
        FROM races r JOIN race_participants rp ON rp.race_id=r.id AND rp.status='accepted'
        WHERE r.status='active' GROUP BY r.id
      )
      SELECT CASE WHEN participants < 10 THEN '1-9'
                  WHEN participants < 50 THEN '10-49'
                  WHEN participants < 200 THEN '50-199'
                  ELSE '200+' END AS band,
             count(*)::int AS races,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY participants)::float AS "medianParticipants"
      FROM sizes GROUP BY 1 ORDER BY 1`),
    prisma.$queryRawUnsafe(`SELECT count(*)::int AS count,
      coalesce(extract(epoch FROM (max(period_end)-min(period_start))),0)::float AS "windowSeconds"
      FROM step_samples`),
    prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM global_step_events
      WHERE starts_at <= now() AND ends_at > now()`),
  ]);
  return {
    activeRaceCountDistribution: activeCounts.map((row) => ({
      activeRaceCount: Math.max(0, Math.min(100, Number(row.activeRaceCount))),
      users: Number(row.users),
    })),
    participantBands: bands.map((row) => ({ band: row.band, races: Number(row.races),
      medianParticipants: Number(row.medianParticipants) })),
    stepSampleCount: Number(sampleWindow[0]?.count || 0),
    stepSampleWindowSeconds: Number(sampleWindow[0]?.windowSeconds || 0),
    activeGlobalEventCount: Number(activeEvents[0]?.count || 0),
  };
}

async function createHomeOpenFixtures({
  prisma, runId, users = 5000, arrivalRate = 1, env = process.env, now = new Date(),
} = {}) {
  if (!/^[a-z0-9][a-z0-9._-]{5,63}$/.test(String(runId || ""))) {
    throw new Error("home-open fixture requires a safe run id");
  }
  assertFixtureDatabase(env);
  const aggregate = await aggregateSnapshotTopology(prisma);
  const scaled = scaleHomeTopology({ syntheticUsers: users, ...aggregate });
  // A production snapshot may legitimately be captured during a live global
  // event. This profile excludes that request-graph variant, so remove the
  // complete derived domain only inside the guarded disposable clone/test DB.
  const removedGlobalEvents = await resetGlobalEventDerivedState(prisma);
  const [isolated] = await prisma.$queryRawUnsafe(`SELECT
    (SELECT count(*)::int FROM global_step_events WHERE starts_at <= now() AND ends_at > now())
      AS "activeEventCount",
    (SELECT count(*)::int FROM global_event_summary_work) AS "summaryWorkCount"`);
  if (Number(isolated?.activeEventCount || 0) !== 0 ||
      Number(isolated?.summaryWorkCount || 0) !== 0) {
    throw new Error("home-open fixture global-event isolation failed");
  }
  const before = await baselineIntegrity(prisma);
  const ids = { users: [], races: [], raceParticipants: [], steps: [], stepSamples: [] };
  try {
    const marker = `capacity-home:${runId}`;
    await createMany(prisma.user, Array.from({ length: users }, (_, index) => ({
      appleId: `${marker}:apple:${index}`,
      email: `${marker}:${String(index).padStart(5, "0")}@synthetic.invalid`,
      displayName: `${marker}:${index}`,
      timezone: "America/New_York",
      clientFeatures: CURRENT_FEATURES,
      lastAppVersion: "2.3.11",
      lastSeenAt: new Date(now.getTime() - 24 * 60 * 60_000),
    })));
    const userRows = await prisma.user.findMany({ where: { email: { startsWith: `${marker}:` } },
      orderBy: { email: "asc" }, select: { id: true, appleId: true, email: true } });
    if (userRows.length !== users) throw new Error("home-open fixture user census mismatch");
    ids.users.push(...userRows.map((row) => row.id));

    const startedAt = new Date(now.getTime() - 60 * 60_000);
    const endsAt = new Date(now.getTime() + 24 * 60 * 60_000);
    const races = [];
    for (let index = 0; index < scaled.raceCount; index += 1) {
      const race = await prisma.race.create({ data: {
        creatorId: userRows[0].id, name: `${marker}:race:${index}`,
        targetSteps: 1_000_000, status: "ACTIVE", startedAt, endsAt,
        maxDurationDays: 2, maxParticipants: users, isPublic: false,
      } });
      races.push(race); ids.races.push(race.id);
    }
    const requestedCounts = interleaveActiveRaceCounts(scaled.usersByActiveRaceCount)
      .map((count) => Math.min(races.length, count));
    while (requestedCounts.length < userRows.length) requestedCounts.push(0);
    const participantRows = [];
    const capacities = scaled.raceParticipantTargets.map((remaining, index) => ({ index, remaining }));
    requestedCounts.map((count, userIndex) => ({ count, userIndex }))
      .sort((left, right) => right.count - left.count || left.userIndex - right.userIndex)
      .forEach(({ count, userIndex }) => {
        const candidates = capacities.filter((row) => row.remaining > 0)
          .sort((left, right) => right.remaining - left.remaining || left.index - right.index)
          .slice(0, count);
        if (candidates.length !== count) throw new Error("home-open participant topology is not materializable");
        for (const candidate of candidates) {
          const user = userRows[userIndex];
          participantRows.push({ raceId: races[candidate.index].id,
          userId: user.id, status: "ACCEPTED", joinedAt: startedAt,
          rawSteps: 1000, totalSteps: 1000, totalsUpdatedAt: now, nextBoxAtSteps: 5000 });
          candidate.remaining -= 1;
        }
      });
    if (capacities.some((row) => row.remaining !== 0)) {
      throw new Error("home-open participant topology census mismatch");
    }
    await createMany(prisma.raceParticipant, participantRows);
    const storedParticipants = await prisma.raceParticipant.findMany({ where: { raceId: { in: ids.races } },
      select: { id: true, raceId: true } });
    ids.raceParticipants.push(...storedParticipants.map((row) => row.id));
    const sizes = new Map(ids.races.map((raceId) => [raceId, 0]));
    for (const row of storedParticipants) sizes.set(row.raceId, (sizes.get(row.raceId) || 0) + 1);
    const sortedSizes = [...sizes.values()].sort((a, b) => a - b);
    const reuseSeconds = users / Math.max(1, Number(arrivalRate));
    const topology = {
      schema: "home-open-fixture-topology-v1",
      userCohortOrdering: "weighted-fair-active-race-count-v1",
      syntheticUserCount: users,
      usersByActiveRaceCount: scaled.usersByActiveRaceCount,
      racesByParticipantCountBand: sortedSizes.reduce((result, size) => {
        const band = size < 10 ? "1-9" : size < 50 ? "10-49" : size < 200 ? "50-199" : "200+";
        result[band] = (result[band] || 0) + 1; return result;
      }, {}),
      raceParticipantCounts: sortedSizes,
      raceCount: races.length,
      maximumRaceSize: Math.max(0, ...sortedSizes),
      sharedRaceConcentration: users ? Math.max(0, ...sortedSizes) / users : 0,
      syntheticStepSampleTopology: {
        samplesPerUser: 1, periodSeconds: 600, closedBeforeSessionSeconds: 600,
        stepRange: { minimum: 500, maximum: 3999 }, stableAcrossUserReuse: true,
      },
      snapshotReference: { stepSampleCount: aggregate.stepSampleCount,
        stepSampleWindowSeconds: aggregate.stepSampleWindowSeconds },
      globalEventIsolation: {
        snapshotActiveEventCount: aggregate.activeGlobalEventCount,
        removedEventCount: removedGlobalEvents.removedEventCount,
        removedSummaryWorkCount: removedGlobalEvents.removedSummaryWorkCount,
        activeEventCountAfterIsolation: Number(isolated.activeEventCount),
        summaryWorkCountAfterIsolation: Number(isolated.summaryWorkCount),
      },
      minimumUserReuseIntervalSeconds: reuseSeconds,
      medianUserReuseIntervalSeconds: reuseSeconds,
      aggregateSourceHash: crypto.createHash("sha256").update(JSON.stringify(aggregate)).digest("hex"),
    };
    return {
      manifest: { schema: "synthetic-load-manifest-v1", runId, baseline: before, ids },
      users: userRows.map((user) => ({ ...user,
        token: signHomeOpenFixtureToken({ userId: user.id, appleId: user.appleId, env }) })),
      races, topology,
    };
  } catch (error) {
    await cleanupHomeOpenFixtures({ prisma,
      manifest: { schema: "synthetic-load-manifest-v1", runId, baseline: before, ids } }).catch(() => {});
    throw error;
  }
}

async function cleanupHomeOpenFixtures({ prisma, manifest } = {}) {
  let cleanup;
  try {
    cleanup = await cleanupGenericSyntheticRun({ prisma, manifest });
  } catch (error) {
    if (error?.code !== "SYNTHETIC_BASELINE_DRIFT") throw error;
    await assertNoSyntheticRows(prisma, manifest.ids || {});
    cleanup = { cleaned: true, noSyntheticRows: true, baselineUnchanged: false,
      baselineDriftObserved: true, baselineDrift: error.baselineDrift };
  }
  return { ...cleanup,
    globalEventIsolation: await readHomeOpenGlobalIsolationCensus(prisma) };
}

async function readHomeOpenGlobalIsolationCensus(prisma) {
  const [row] = await prisma.$queryRawUnsafe(`SELECT
    (SELECT count(*)::int FROM global_step_events) AS "totalEventCount",
    (SELECT count(*)::int FROM global_step_events
      WHERE starts_at <= now() AND ends_at > now()) AS "activeEventCount",
    (SELECT count(*)::int FROM global_event_summary_work) AS "summaryWorkCount"`);
  const result = { totalEventCount: Number(row?.totalEventCount),
    activeEventCount: Number(row?.activeEventCount),
    summaryWorkCount: Number(row?.summaryWorkCount) };
  if (!Object.values(result).every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error("home-open final global-event isolation census is invalid");
  }
  return result;
}

module.exports = { aggregateSnapshotTopology, cleanupHomeOpenFixtures,
  createHomeOpenFixtures, homeStepPayload, interleaveActiveRaceCounts,
  readHomeOpenGlobalIsolationCensus,
  scaleHomeTopology, signHomeOpenFixtureToken };
