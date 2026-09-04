const crypto = require("node:crypto");
const {
  coordinatedOptimizationMetrics,
} = require("../../../shared/observability/coordinatedOptimizationMetrics");
const { prorateSamplesIntoWindow } = require("../models/stepSample");
const {
  calculateBaseAdjusted,
} = require("../../races/services/raceStateResolution");
const {
  chronologicalAttributionRows,
  scoreWholeRaceTotals,
} = require("../../races/services/wholeRaceAttributionScoring");
const {
  SETTLEMENT_EFFECT_TYPES,
} = require("../../races/services/raceScoringEffectTypes");
const {
  acquireRaceWriteFences,
} = require("../../races/services/raceWriteFence");
const {
  legacyGlobalSummaryEntitlement,
} = require("./globalEventSummaryLifecycle");

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_WORK_BYTES = 16 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const CAPTURE_EFFECT_TYPES = [...new Set([
  ...SETTLEMENT_EFFECT_TYPES,
  // Hitchhike is loaded race-wide by the canonical scorer rather than through
  // its per-participant settlement list, but its row is still an artifact
  // dependency and must be retained with the same immutable capture.
  "HITCHHIKE",
])];

function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalize(value[key])]),
    );
  }
  if (typeof value === "number" && Object.is(value, -0)) return 0;
  return value;
}

function canonicalize(value) {
  return JSON.stringify(normalize(value));
}

function digestCanonical(value) {
  const bytes = Buffer.from(canonicalize(value), "utf8");
  return {
    bytes,
    digest: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function samplesFor(payload, userId) {
  return (payload.samples || []).filter((sample) => sample.userId === userId).map((sample) => ({
    start: new Date(sample.periodStart),
    end: new Date(sample.periodEnd),
    steps: Number(sample.steps) || 0,
  }));
}

function artifactModels(payload) {
  const sampleModel = {
    async sumStepsInWindow(userId, start, end) {
      return prorateSamplesIntoWindow(
        samplesFor(payload, userId),
        new Date(start).getTime(),
        new Date(end).getTime(),
      );
    },
    async sumClosedStepsInWindow(userId, start, end, asOf) {
      const closed = samplesFor(payload, userId).filter((sample) =>
        sample.end.getTime() <= new Date(asOf).getTime());
      return prorateSamplesIntoWindow(
        closed,
        new Date(start).getTime(),
        new Date(end).getTime(),
      );
    },
    async hasAnyInWindow(userId, start, end) {
      const from = new Date(start).getTime();
      const through = new Date(end).getTime();
      return samplesFor(payload, userId).some((sample) =>
        sample.end.getTime() > from && sample.start.getTime() < through);
    },
  };
  const stepsModel = {
    async findByUserIdAndDate(userId, date) {
      const key = new Date(date).toISOString().slice(0, 10);
      return (payload.dailySteps || []).find((row) =>
        row.userId === userId && new Date(row.date).toISOString().slice(0, 10) === key) || null;
    },
    async findByUserIdAndDateRange(userId, start, end) {
      const from = new Date(start).getTime();
      const through = new Date(end).getTime();
      return (payload.dailySteps || []).filter((row) => {
        const at = new Date(row.date).getTime();
        return row.userId === userId && at >= from && at <= through;
      });
    },
  };
  const effectModel = {
    async findEffectsForRaceByTypes(_raceId, participantId, types) {
      return Object.fromEntries((types || []).map((type) => [
        type,
        chronologicalAttributionRows((payload.effects || []).filter((effect) =>
          effect.targetParticipantId === participantId && effect.type === type)),
      ]));
    },
    async findRaceEffectsByType(_raceId, type) {
      return chronologicalAttributionRows(
        (payload.effects || []).filter((effect) => effect.type === type),
      );
    },
  };
  return { sampleModel, stepsModel, effectModel };
}

async function scoreWholeRaceArtifact(payload, includeEvent) {
  const { sampleModel, stepsModel, effectModel } = artifactModels(payload);
  const eventEndMs = new Date(payload.event.endsAt).getTime();
  const entries = [];
  for (const participant of payload.participants || []) {
    const cutoffAt = new Date(participant.cutoffAt);
    const base = await calculateBaseAdjusted({
      participant,
      raceStartedAt: new Date(payload.race.startedAt),
      timeZone: payload.race.timezone,
      stepsModel,
      stepSampleModel: sampleModel,
      now: cutoffAt,
      raceEndsAt: cutoffAt,
    });
    entries.push({
      participant,
      baseAdjusted: base.baseAdjusted,
      hasSampleData: base.hasSampleData,
      now: cutoffAt,
    });
  }
  const eventsByUserId = new Map([[
    payload.userId,
    includeEvent ? [payload.event] : [],
  ]]);
  const totals = await scoreWholeRaceTotals({
    raceId: payload.race.id,
    racePowerupsEnabled: payload.race.powerupsEnabled,
    raceEndsAt: new Date(payload.event.endsAt),
    raceTimezone: payload.race.timezone || "UTC",
    participants: payload.participants || [],
    entries,
    raceActiveEffectModel: effectModel,
    stepSampleModel: sampleModel,
    now: new Date(payload.event.endsAt),
    eventsByUserId,
    isFrozen: (participant) => [participant.finishedAt, participant.forfeitedAt]
      .filter(Boolean)
      .some((value) => new Date(value).getTime() <= eventEndMs),
  });
  const uploader = (payload.participants || []).find((row) => row.userId === payload.userId);
  return Number(totals.get(uploader?.id)) || 0;
}

async function scoreCaptureArtifact(payload) {
  const [withEvent, withoutEvent] = await Promise.all([
    scoreWholeRaceArtifact(payload, true),
    scoreWholeRaceArtifact(payload, false),
  ]);
  return Math.round(withEvent - withoutEvent);
}

const artifactRaceSelect = {
  id: true,
  startedAt: true,
  endsAt: true,
  timezone: true,
  powerupsEnabled: true,
  participants: {
    where: { status: "ACCEPTED" },
    select: {
      id: true,
      userId: true,
      finishedAt: true,
      forfeitedAt: true,
      joinedAt: true,
      bonusSteps: true,
    },
    orderBy: { userId: "asc" },
  },
};

function artifactCutoffAt(race, participant, entitlement) {
  const candidates = [entitlement.endsAt, race.endsAt,
    participant.finishedAt, participant.forfeitedAt]
    .filter(Boolean)
    .map((value) => new Date(value));
  return new Date(Math.min(...candidates.map((value) => value.getTime())));
}

function connectedScoringUserIds({ race, effects, uploaderUserId }) {
  if (!race.powerupsEnabled) return new Set([uploaderUserId]);
  const participantUserIdById = new Map(
    race.participants.map((participant) => [participant.id, participant.userId]),
  );
  const adjacency = new Map();
  const connect = (left, right) => {
    if (!left || !right) return;
    if (!adjacency.has(left)) adjacency.set(left, new Set());
    if (!adjacency.has(right)) adjacency.set(right, new Set());
    adjacency.get(left).add(right);
    adjacency.get(right).add(left);
  };
  for (const effect of effects) {
    if (effect.raceId !== race.id ||
        (effect.type !== "LEECH" && effect.type !== "HITCHHIKE")) continue;
    // Retained effects can still read a source/target's mutable samples after
    // that user is no longer an accepted participant. Keep those historical
    // endpoints in the component; participant identity is authoritative while
    // the denormalized target remains the scorer's fallback for departed users.
    const targetUserId = participantUserIdById.get(effect.targetParticipantId) ||
      effect.targetUserId;
    connect(effect.sourceUserId, targetUserId);
  }
  const connected = new Set([uploaderUserId]);
  const pending = [uploaderUserId];
  while (pending.length) {
    const userId = pending.pop();
    for (const adjacentUserId of adjacency.get(userId) || []) {
      if (connected.has(adjacentUserId)) continue;
      connected.add(adjacentUserId);
      pending.push(adjacentUserId);
    }
  }
  return connected;
}

async function loadMutableScoringFactsSnapshot(tx, {
  dependencyUserIds,
  earliest,
  latest,
}) {
  const rows = await tx.$queryRawUnsafe(
    `WITH dependencies AS MATERIALIZED (
       SELECT dependency.user_id
         FROM unnest($1::text[]) AS dependency(user_id)
     ), facts AS (
       SELECT 0 AS "kindOrder", 'sample'::text AS kind,
              sample.user_id AS "userId", sample.period_start AS "periodStart",
              sample.period_end AS "periodEnd", NULL::date AS date,
              sample.steps, NULL::bigint AS generation, sample.id AS "rowId"
         FROM step_samples sample
         JOIN dependencies dependency ON dependency.user_id=sample.user_id
        WHERE sample.period_end > $2::timestamp
          AND sample.period_start < $3::timestamp
       UNION ALL
       SELECT 1 AS "kindOrder", 'daily'::text AS kind,
              daily.user_id AS "userId", NULL::timestamp AS "periodStart",
              NULL::timestamp AS "periodEnd", daily.date,
              daily.steps, NULL::bigint AS generation, daily.id AS "rowId"
         FROM steps daily
         JOIN dependencies dependency ON dependency.user_id=daily.user_id
        WHERE daily.date >= $2::date AND daily.date <= $3::date
       UNION ALL
       SELECT 2 AS "kindOrder", 'version'::text AS kind,
              version.user_id AS "userId", NULL::timestamp AS "periodStart",
              NULL::timestamp AS "periodEnd", NULL::date AS date,
              NULL::integer AS steps, version.generation, version.user_id AS "rowId"
         FROM user_scoring_input_versions version
         JOIN dependencies dependency ON dependency.user_id=version.user_id
     )
     SELECT kind,"userId","periodStart","periodEnd",date,steps,generation
       FROM facts
      ORDER BY "kindOrder","userId","periodStart",date,"rowId"`,
    dependencyUserIds,
    earliest,
    latest,
  );
  const samples = [];
  const dailySteps = [];
  const inputVersions = [];
  for (const row of rows) {
    if (row.kind === "sample") {
      samples.push({
        userId: row.userId,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        steps: row.steps,
      });
    } else if (row.kind === "daily") {
      dailySteps.push({ userId: row.userId, date: row.date, steps: row.steps });
    } else if (row.kind === "version") {
      inputVersions.push({ userId: row.userId, generation: row.generation });
    }
  }
  return { samples, dailySteps, inputVersions };
}

async function loadArtifactFacts(tx, { works, impacts, entitlementsByEventId }) {
  const raceIds = [...new Set(impacts.map((impact) => impact.raceId))].sort();
  if (raceIds.length === 0) return {
    racesById: new Map(), samples: [], dailySteps: [], effects: [], inputVersions: [],
  };
  const races = await tx.race.findMany({
    where: { id: { in: raceIds } },
    select: artifactRaceSelect,
    orderBy: { id: "asc" },
  });
  const racesById = new Map(races.map((race) => [race.id, race]));
  const workByEventId = new Map(works.map((work) => [work.eventId, work]));
  const effects = await tx.raceActiveEffect.findMany({
    where: {
      raceId: { in: raceIds },
      type: { in: CAPTURE_EFFECT_TYPES },
      status: { in: ["ACTIVE", "EXPIRED"] },
    },
    select: {
      id: true, raceId: true, type: true, status: true, startsAt: true,
      expiresAt: true, targetParticipantId: true, targetUserId: true,
      sourceUserId: true, metadata: true,
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  const factUserIdsByRaceId = new Map();
  const recordedScopeRaceIds = new Set();
  for (const impact of impacts) {
    const race = racesById.get(impact.raceId);
    const work = workByEventId.get(impact.eventId);
    if (!race || !work) continue;
    const scoringUserIds = connectedScoringUserIds({
      race,
      effects,
      uploaderUserId: work.userId,
    });
    if (!recordedScopeRaceIds.has(race.id)) {
      const participantUserIds = race.participants.map((row) => row.userId);
      const coversWholeRace = scoringUserIds.size === participantUserIds.length &&
        participantUserIds.every((userId) => scoringUserIds.has(userId));
      const outcome = scoringUserIds.size === 1
        ? "uploader_only"
        : coversWholeRace
          ? "whole_race"
          : "dependency_component";
      coordinatedOptimizationMetrics.increment(
        "global_summary_capture_mutable_scope_total",
        { outcome },
      );
      recordedScopeRaceIds.add(race.id);
    }
    factUserIdsByRaceId.set(race.id, scoringUserIds);
  }
  const factUserIds = [...new Set([...factUserIdsByRaceId.values()]
    .flatMap((userIds) => [...userIds]))].sort();
  coordinatedOptimizationMetrics.observe(
    "global_summary_capture_mutable_users",
    factUserIds.length,
  );
  let earliest = null;
  let latest = null;
  for (const impact of impacts) {
    const race = racesById.get(impact.raceId);
    const work = workByEventId.get(impact.eventId);
    const entitlement = entitlementsByEventId.get(impact.eventId);
    const participant = race?.participants.find((row) => row.userId === work?.userId);
    if (!race || !participant || !entitlement) continue;
    const cutoffAt = artifactCutoffAt(race, participant, entitlement);
    const rangeStart = new Date(new Date(race.startedAt).getTime() - DAY_MS);
    const rangeEnd = new Date(cutoffAt.getTime() + DAY_MS);
    if (!earliest || rangeStart < earliest) earliest = rangeStart;
    if (!latest || rangeEnd > latest) latest = rangeEnd;
  }
  const shouldLoadMutableFacts = Boolean(factUserIds.length && earliest && latest);
  const mutableFacts = shouldLoadMutableFacts
    ? await loadMutableScoringFactsSnapshot(tx, {
        // Both mutable rows and their generation witnesses are scoped to users
        // that can affect the uploader's counterfactual.
        dependencyUserIds: factUserIds,
        earliest,
        latest,
      })
    : { samples: [], dailySteps: [], inputVersions: [] };
  const capturedInputVersionUserIds = mutableFacts.inputVersions
    .map((row) => row.userId)
    .sort();
  coordinatedOptimizationMetrics.observe(
    "global_summary_capture_mutable_rows",
    mutableFacts.samples.length + mutableFacts.dailySteps.length +
      mutableFacts.inputVersions.length,
  );
  if (shouldLoadMutableFacts && (
    mutableFacts.inputVersions.length !== factUserIds.length ||
    capturedInputVersionUserIds.some(
      (userId, index) => userId !== factUserIds[index],
    )
  )) {
    const error = new Error("summary capture generation witness changed");
    error.code = "SUMMARY_CAPTURE_CLOSURE_CHANGED";
    throw error;
  }
  return { racesById, factUserIdsByRaceId, ...mutableFacts, effects };
}

async function buildArtifact(tx, {
  impact, work, entitlement, provenance, artifactFacts = null,
}) {
  const race = artifactFacts?.racesById.get(impact.raceId) || await tx.race.findUnique({
    where: { id: impact.raceId }, select: artifactRaceSelect,
  });
  const participant = race?.participants?.find((row) => row.userId === work.userId);
  if (!race || !participant) return { error: "PARTICIPANT_STATE_UNREPLAYABLE" };
  const cutoffAt = artifactCutoffAt(race, participant, entitlement);
  if (!Number.isFinite(cutoffAt.getTime())) return { error: "INPUTS_NOT_RETAINED" };

  const participantRows = race.participants.map((row) => {
    const candidates = [entitlement.endsAt, race.endsAt, row.finishedAt, row.forfeitedAt]
      .filter(Boolean)
      .map((value) => new Date(value).getTime());
    return { ...row, cutoffAt: new Date(Math.min(...candidates)) };
  });
  const dependencyUserIds = participantRows.map((row) => row.userId).sort();
  const factUserIds = artifactFacts?.factUserIdsByRaceId?.get(race.id) ||
    new Set(dependencyUserIds);
  const earliestDate = new Date(new Date(race.startedAt).getTime() - 24 * 60 * 60 * 1000);
  const latestDate = new Date(cutoffAt.getTime() + 24 * 60 * 60 * 1000);
  const loaded = artifactFacts || {};
  const [samples, dailySteps, effects, inputVersions] = artifactFacts ? [
    loaded.samples.filter((row) => factUserIds.has(row.userId) &&
      new Date(row.periodEnd) > new Date(race.startedAt) && new Date(row.periodStart) < cutoffAt),
    loaded.dailySteps.filter((row) => factUserIds.has(row.userId) &&
      new Date(row.date) >= earliestDate && new Date(row.date) <= latestDate),
    race.powerupsEnabled
      ? loaded.effects.filter((row) => row.raceId === race.id)
          .map(({ raceId: _raceId, ...row }) => row)
      : [],
    loaded.inputVersions.filter((row) => factUserIds.has(row.userId)),
  ] : await Promise.all([
    tx.stepSample.findMany({
      where: {
        userId: { in: dependencyUserIds },
        periodEnd: { gt: race.startedAt },
        periodStart: { lt: cutoffAt },
      },
      select: { userId: true, periodStart: true, periodEnd: true, steps: true },
      orderBy: [{ userId: "asc" }, { periodStart: "asc" }, { id: "asc" }],
    }),
    tx.step.findMany({
      where: {
        userId: { in: dependencyUserIds },
        date: { gte: earliestDate, lte: latestDate },
      },
      select: { userId: true, date: true, steps: true },
      orderBy: [{ userId: "asc" }, { date: "asc" }],
    }),
    race.powerupsEnabled
      ? tx.raceActiveEffect.findMany({
          where: {
            raceId: race.id,
            type: { in: CAPTURE_EFFECT_TYPES },
            status: { in: ["ACTIVE", "EXPIRED"] },
          },
          select: {
            id: true,
            type: true,
            status: true,
            startsAt: true,
            expiresAt: true,
            targetParticipantId: true,
            targetUserId: true,
            sourceUserId: true,
            metadata: true,
          },
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        })
      : [],
    tx.userScoringInputVersion.findMany({
      where: { userId: { in: dependencyUserIds } },
      select: { userId: true, generation: true },
      orderBy: { userId: "asc" },
    }),
  ]);
  const payload = {
    schemaVersion: 1,
    userId: work.userId,
    race: {
      id: race.id,
      startedAt: race.startedAt,
      endsAt: race.endsAt,
      timezone: race.timezone || entitlement.timezone,
      powerupsEnabled: race.powerupsEnabled,
    },
    participants: participantRows,
    event: {
      id: work.eventId,
      startsAt: entitlement.startsAt,
      endsAt: entitlement.endsAt,
      multiplier: work.event.multiplier,
    },
    cutoffAt,
    samples,
    dailySteps,
    effects,
    dependencyInputGenerations: inputVersions,
  };
  payload.attributionDeltaSteps = await scoreCaptureArtifact(normalize(payload));
  const normalizedPayload = normalize(payload);
  const { bytes, digest } = digestCanonical(normalizedPayload);
  if (bytes.length > MAX_ARTIFACT_BYTES) return { error: "INPUTS_NOT_RETAINED" };
  return {
    bytes: bytes.length,
    data: {
      workId: work.id,
      eventId: work.eventId,
      raceId: race.id,
      userId: work.userId,
      ...provenance,
      payload: normalizedPayload,
      payloadDigest: digest,
      schemaVersion: 1,
    },
  };
}

async function lockEligibleSummaryCaptureDependencies(tx, {
  userId,
  at = new Date(),
}) {
  if (!tx?.globalEventSummaryWork || !tx?.userScoringInputVersion) return [];
  // Keep the two eligibility branches separate so PostgreSQL can use the
  // user/status/expiry index for each, but send them as one round trip. The
  // waiting branch also carries the immutable event definition consumed by
  // claimEligibleSummaryWork, avoiding a second event lookup during capture.
  const eligibleRows = await tx.$queryRawUnsafe(
    `(SELECT 'active' AS kind,
             0 AS "kindOrder",
             work.id,
             work.event_id AS "eventId",
             work.user_id AS "userId",
             work.status::text AS status,
             work.expires_at AS "expiresAt",
             NULL::timestamp AS "eventStartsAt",
             NULL::timestamp AS "eventEndsAt",
             NULL::double precision AS "eventMultiplier",
             NULL::text AS "eventScheduleMode",
             NULL::integer AS "eventSummaryAttributionVersion"
        FROM global_event_summary_work work
        JOIN global_step_events event ON event.id = work.event_id
       WHERE work.user_id = $1
         AND work.status IN ('QUEUED', 'PROCESSING', 'WAITING_RACES')
         AND work.expires_at > $2::timestamp
         AND event.summary_attribution_version = 2
       ORDER BY work.expires_at ASC, work.id ASC
       LIMIT 1)
     UNION ALL
     (SELECT 'waiting' AS kind,
             1 AS "kindOrder",
             work.id,
             work.event_id AS "eventId",
             work.user_id AS "userId",
             work.status::text AS status,
             work.expires_at AS "expiresAt",
             event.starts_at AS "eventStartsAt",
             event.ends_at AS "eventEndsAt",
             event.multiplier::double precision AS "eventMultiplier",
             event.schedule_mode::text AS "eventScheduleMode",
             event.summary_attribution_version AS "eventSummaryAttributionVersion"
        FROM global_event_summary_work work
        JOIN global_step_events event ON event.id = work.event_id
       WHERE work.user_id = $1
         AND work.status = 'WAITING_SYNC'
         AND work.expires_at > $2::timestamp
         AND event.summary_attribution_version = 2
         AND event.ends_at <= $2::timestamp
       ORDER BY work.expires_at ASC, work.id ASC)
     ORDER BY "kindOrder" ASC, "expiresAt" ASC, id ASC`,
    userId,
    new Date(at),
  );
  const activeRow = eligibleRows.find((row) => row.kind === "active");
  const activeWork = activeRow ? {
    id: activeRow.id,
    status: activeRow.status,
    expiresAt: activeRow.expiresAt,
  } : null;
  const works = eligibleRows.filter((row) => row.kind === "waiting").map((row) => ({
    id: row.id,
    eventId: row.eventId,
    userId: row.userId,
    expiresAt: row.expiresAt,
    event: {
      id: row.eventId,
      startsAt: row.eventStartsAt,
      endsAt: row.eventEndsAt,
      multiplier: row.eventMultiplier,
      scheduleMode: row.eventScheduleMode,
      summaryAttributionVersion: row.eventSummaryAttributionVersion,
    },
  }));
  if (works.length === 0) return { activeWork, works: [], impacts: [], entitlements: [] };
  const impactWhere = {
    eventId: { in: works.map((work) => work.eventId) },
    userId,
  };
  const impactSelect = {
    eventId: true,
    raceId: true,
    userId: true,
    status: true,
    attributionVersion: true,
  };
  const readImpactVector = () => tx.globalEventRaceImpact.findMany({
    where: {
      ...impactWhere,
    },
    select: impactSelect,
    orderBy: [{ eventId: "asc" }, { raceId: "asc" }, { userId: "asc" }],
  });
  // This is deliberately all-version and is read before any input/C0 locks.
  // A rolling old worker touches the matching work row through the database
  // trigger, so the later work-row lock and vector recheck either observe this
  // exact vector or raise the narrow capture-closure retry signal.
  const initialVector = await readImpactVector();
  const raceIds = [...new Set(initialVector
    .filter((row) => row.status === "PENDING")
    .map((row) => row.raceId))].sort();
  async function discoverIds() {
    const [participants, effects] = await Promise.all([
      tx.raceParticipant.findMany({
        where: { raceId: { in: raceIds }, status: "ACCEPTED" },
        select: { userId: true },
      }),
      tx.raceActiveEffect.findMany({
        where: {
          raceId: { in: raceIds },
          type: { in: ["LEECH", "HITCHHIKE"] },
          status: { in: ["ACTIVE", "EXPIRED"] },
        },
        select: { sourceUserId: true, targetUserId: true },
      }),
    ]);
    return [...new Set([
      userId,
      ...participants.map((row) => row.userId),
      ...effects.flatMap((row) => [row.sourceUserId, row.targetUserId]),
    ].filter(Boolean))].sort();
  }

  const discovered = await discoverIds();
  await tx.$executeRawUnsafe(
    `WITH dependencies AS MATERIALIZED (
       SELECT dependency.user_id
         FROM unnest($1::text[]) AS dependency(user_id)
     )
     INSERT INTO user_scoring_input_versions (user_id, generation, updated_at)
     SELECT dependency.user_id, 1, CURRENT_TIMESTAMP
       FROM dependencies dependency
       LEFT JOIN user_scoring_input_versions existing
         ON existing.user_id=dependency.user_id
      WHERE existing.user_id IS NULL
      ORDER BY dependency.user_id
     ON CONFLICT (user_id) DO NOTHING`,
    discovered,
  );
  // Preserve the established scoring-input -> race-C0 lock order used by
  // intake and by rolling old workers. Lock only the uploader: shared race
  // dependencies are read later from one MVCC statement snapshot and must not
  // serialize captures for otherwise independent races.
  const uploaderFence = await tx.$queryRawUnsafe(
    `SELECT user_id
       FROM user_scoring_input_versions
      WHERE user_id=$1
      FOR UPDATE`,
    userId,
  );
  if (uploaderFence.length !== 1) {
    const error = new Error("summary capture uploader scoring fence changed");
    error.code = "SUMMARY_CAPTURE_CLOSURE_CHANGED";
    throw error;
  }
  // C0 freezes race topology and effects. Participant step inputs remain
  // writable: loadArtifactFacts captures their samples, daily totals, and
  // generation witnesses in one statement-level MVCC snapshot instead of
  // serializing otherwise independent races on shared participant rows.
  await acquireRaceWriteFences(tx, raceIds);
  const verified = await discoverIds();
  if (verified.length !== discovered.length ||
      verified.some((value, index) => value !== discovered[index])) {
    const error = new Error("summary capture dependency closure changed");
    error.code = "SUMMARY_CAPTURE_CLOSURE_CHANGED";
    throw error;
  }
  const workIds = works.map((work) => work.id).sort();
  const lockedWorks = await tx.$queryRawUnsafe(
    `SELECT work.id
       FROM global_event_summary_work work
       JOIN global_step_events event ON event.id = work.event_id
      WHERE work.id = ANY($1::text[])
        AND work.user_id = $2
        AND work.status = 'WAITING_SYNC'
        AND work.expires_at > $3::timestamp
        AND event.summary_attribution_version = 2
        AND event.ends_at <= $3::timestamp
      ORDER BY work.id ASC
      FOR UPDATE OF work`,
    workIds,
    userId,
    new Date(at),
  );
  if (lockedWorks.length !== workIds.length) {
    const error = new Error("summary capture work row changed");
    error.code = "SUMMARY_CAPTURE_CLOSURE_CHANGED";
    throw error;
  }
  const verifiedVector = await readImpactVector();
  if (canonicalize(verifiedVector) !== canonicalize(initialVector)) {
    const error = new Error("summary capture impact vector changed");
    error.code = "SUMMARY_CAPTURE_CLOSURE_CHANGED";
    throw error;
  }
  // Pending v1 rows are rolling-old-worker membership, not a different score
  // result. Promote only after the uploader-inclusive input rows, race C0 rows,
  // work rows, and the complete all-version vector are fenced and reverified.
  await tx.globalEventRaceImpact.updateMany({
    where: {
      ...impactWhere,
      attributionVersion: 1,
      status: "PENDING",
    },
    data: { attributionVersion: 2 },
  });
  const entitlements = await tx.globalStepEventEntitlement.findMany({
    where: { eventId: { in: works.map((work) => work.eventId) }, userId },
    orderBy: [{ eventId: "asc" }, { id: "asc" }],
  });
  return {
    activeWork,
    works,
    impacts: verifiedVector.map((impact) =>
      impact.status === "PENDING" && impact.attributionVersion === 1
        ? { ...impact, attributionVersion: 2 }
        : impact),
    entitlements,
  };
}

async function claimEligibleSummaryWork(tx, {
  userId,
  captureDependencies = null,
  eligibleWorkIds = [],
  captureSyncRequestId,
  captureCompletedAt,
  captureCoverageThrough,
  sourceScoringInputGeneration,
}) {
  if (!captureCoverageThrough || !sourceScoringInputGeneration) return null;
  const existingActive = captureDependencies?.activeWork ||
    await tx.globalEventSummaryWork.findFirst({
      where: {
        userId,
        status: { in: ["QUEUED", "PROCESSING", "WAITING_RACES"] },
        expiresAt: { gt: captureCompletedAt },
        event: { summaryAttributionVersion: 2 },
      },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    });
  let receipt = existingActive
    ? { id: existingActive.id, state: existingActive.status, expiresAt: existingActive.expiresAt }
    : null;
  const dependencyWorks = captureDependencies?.works;
  const candidates = dependencyWorks || await tx.globalEventSummaryWork.findMany({
    where: {
      id: { in: eligibleWorkIds },
      userId,
      status: "WAITING_SYNC",
      expiresAt: { gt: captureCompletedAt },
    },
    include: {
      event: {
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          multiplier: true,
          scheduleMode: true,
          summaryAttributionVersion: true,
        },
      },
    },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
  });
  const carriedImpacts = captureDependencies?.impacts || null;
  const entitlementRows = captureDependencies?.entitlements || [];
  const entitlementsByEventId = new Map(
    entitlementRows.map((entitlement) => [entitlement.eventId, entitlement]),
  );
  for (const work of candidates) {
    if (!entitlementsByEventId.has(work.eventId)) {
      const legacy = legacyGlobalSummaryEntitlement({ event: work.event, userId });
      if (legacy) entitlementsByEventId.set(work.eventId, legacy);
    }
  }
  const coverageQualifiedCandidates = candidates.filter((work) => {
    if (work.event.summaryAttributionVersion !== 2) return false;
    const entitlement = entitlementsByEventId.get(work.eventId);
    if (!entitlement) return false;
    return new Date(captureCompletedAt) >= new Date(entitlement.endsAt) &&
      new Date(captureCoverageThrough) >= new Date(entitlement.endsAt);
  });
  const coverageSkipped = candidates.filter((work) => {
    const entitlement = entitlementsByEventId.get(work.eventId);
    return entitlement && (
      new Date(captureCompletedAt) < new Date(entitlement.endsAt) ||
      new Date(captureCoverageThrough) < new Date(entitlement.endsAt)
    );
  }).length;
  if (coverageSkipped > 0) {
    coordinatedOptimizationMetrics.increment(
      "global_summary_capture_coverage_skip_total",
      {},
      coverageSkipped,
    );
  }
  // The intake path carries the entitlement snapshot captured under the C0
  // fences, so it can safely gate before hydration. Preserve the standalone
  // fallback's existing per-work entitlement lookup semantics.
  const hydrationCandidates = carriedImpacts
    ? coverageQualifiedCandidates
    : candidates;
  const capturableEventIds = new Set(hydrationCandidates.map((work) => work.eventId));
  const allPendingImpacts = carriedImpacts
    ? carriedImpacts.filter((impact) =>
        impact.status === "PENDING" && capturableEventIds.has(impact.eventId))
    : [];
  const artifactFacts = carriedImpacts
    ? await loadArtifactFacts(tx, {
        works: hydrationCandidates,
        impacts: allPendingImpacts,
        entitlementsByEventId,
      })
    : null;
  for (const work of hydrationCandidates) {
    if (work.event.summaryAttributionVersion !== 2) continue;
    const entitlement = entitlementsByEventId.get(work.eventId) ||
      await tx.globalStepEventEntitlement.findUnique({
        where: { eventId_userId: { eventId: work.eventId, userId } },
      }) || legacyGlobalSummaryEntitlement({ event: work.event, userId });
    if (!entitlement) continue;
    if (new Date(captureCompletedAt) < new Date(entitlement.endsAt) ||
        new Date(captureCoverageThrough) < new Date(entitlement.endsAt)) continue;
    const impacts = carriedImpacts ? carriedImpacts.filter((impact) =>
      impact.eventId === work.eventId && impact.userId === userId && impact.status === "PENDING") :
      await tx.globalEventRaceImpact.findMany({
      where: {
        eventId: work.eventId,
        userId,
        status: "PENDING",
      },
      orderBy: { raceId: "asc" },
    });
    const incompatibleCount = carriedImpacts ? carriedImpacts.filter((impact) =>
      impact.eventId === work.eventId && impact.userId === userId &&
      (impact.attributionVersion !== 2 || impact.status !== "PENDING")).length :
      await tx.globalEventRaceImpact.count({
      where: {
        eventId: work.eventId,
        userId,
        OR: [
          { attributionVersion: { not: 2 } },
          { status: { not: "PENDING" } },
        ],
      },
    });
    const provenance = {
      captureSyncRequestId,
      captureCompletedAt,
      captureCoverageThrough,
      sourceScoringInputGeneration,
    };
    const artifacts = [];
    let totalBytes = 0;
    let terminalReason = incompatibleCount > 0
      ? "DEPENDENCY_INPUT_UNREPLAYABLE"
      : null;
    for (const impact of impacts) {
      const artifact = await buildArtifact(tx, {
        impact, work, entitlement, provenance, artifactFacts,
      });
      if (artifact.error) {
        terminalReason = artifact.error;
        break;
      }
      totalBytes += artifact.bytes;
      if (totalBytes > MAX_WORK_BYTES) {
        terminalReason = "INPUTS_NOT_RETAINED";
        break;
      }
      artifacts.push(artifact.data);
    }
    if (terminalReason) {
      await tx.globalEventSummaryWork.updateMany({
        where: { id: work.id, status: "WAITING_SYNC", leaseToken: null },
        data: {
          status: "UNSCORABLE",
          lastErrorCode: terminalReason,
          raceReconciledAt: null,
        },
      });
      if (tx.jobRun) {
        await tx.jobRun.upsert({
          where: {
            jobName: `global_event_summary:${work.eventId}:${userId}:v2`,
          },
          update: {},
          create: {
            jobName: `global_event_summary:${work.eventId}:${userId}:v2`,
            lastRanFor: "UNSCORABLE",
          },
        });
      }
      continue;
    }
    if (artifacts.length) {
      await tx.globalEventCaptureArtifact.createMany({ data: artifacts, skipDuplicates: true });
    }
    const claimed = await tx.globalEventSummaryWork.updateMany({
      where: { id: work.id, status: "WAITING_SYNC", leaseToken: null },
      data: {
        status: "QUEUED",
        availableAt: captureCompletedAt,
        requiredRaceCount: impacts.length,
        raceReconciledAt: null,
        ...provenance,
      },
    });
    if (claimed.count === 1 && !receipt) {
      receipt = { id: work.id, state: "QUEUED", expiresAt: work.expiresAt };
    }
  }
  return receipt;
}

const ACTIVE_WORK_STATES = new Set([
  "WAITING_SYNC",
  "QUEUED",
  "PROCESSING",
  "WAITING_RACES",
]);

async function refreshSummaryReadinessForRace(tx, { raceId, now = new Date() }) {
  if (typeof tx?.$executeRawUnsafe !== "function") return 0;
  const updated = await tx.$executeRawUnsafe(
    `WITH touched AS MATERIALIZED (
       SELECT DISTINCT event_id,user_id
         FROM global_event_race_impacts
        WHERE race_id=$1
     ), counts AS MATERIALIZED (
       SELECT impact.event_id,impact.user_id,
              COUNT(*) FILTER (WHERE impact.status='FINAL')::int AS final_count,
              COUNT(*) FILTER (WHERE impact.status IN
                ('FINAL','UNSCORABLE','EXPIRED_UNDELIVERED'))::int AS terminal_count
         FROM global_event_race_impacts impact
         JOIN touched USING (event_id,user_id)
        GROUP BY impact.event_id,impact.user_id
     )
     UPDATE global_event_summary_work work
        SET final_race_count=counts.final_count,
            ready_at=CASE WHEN counts.terminal_count>=work.required_race_count
                          THEN COALESCE(work.ready_at,$2) ELSE NULL END,
            available_at=CASE WHEN counts.terminal_count>=work.required_race_count
                              THEN LEAST(work.available_at,$2) ELSE work.available_at END,
            next_recovery_at=$2+interval '60 seconds'
       FROM counts
      WHERE work.event_id=counts.event_id AND work.user_id=counts.user_id
        AND work.status='WAITING_RACES'`,
    raceId,
    new Date(now),
  );
  if (updated > 0) {
    coordinatedOptimizationMetrics.increment(
      "global_summary_waiting_races_ready_total", {}, updated,
    );
  }
  return updated;
}

async function persistCapturedSummaryImpactsForRace(tx, {
  raceId,
  sourceResolutionGeneration,
  now = new Date(),
}) {
  // Some isolated race-worker tests inject only the core resolution models.
  // The additive post-task is a no-op when its migrated models are absent.
  if (!tx?.globalEventCaptureArtifact?.findMany ||
      !tx?.globalEventRaceImpact?.updateMany ||
      typeof tx?.$queryRawUnsafe !== "function") {
    return { finalized: 0, terminalized: 0, artifactCount: 0, terminalCandidateCount: 0 };
  }
  const artifacts = await tx.globalEventCaptureArtifact.findMany({
    where: {
      raceId,
      work: { status: { in: [...ACTIVE_WORK_STATES] } },
    },
    include: {
      work: {
        select: {
          id: true,
          status: true,
          expiresAt: true,
          captureSyncRequestId: true,
          captureCompletedAt: true,
          captureCoverageThrough: true,
          sourceScoringInputGeneration: true,
        },
      },
    },
    orderBy: [{ workId: "asc" }, { id: "asc" }],
  });
  let finalized = 0;
  let terminalized = 0;
  for (const artifact of artifacts) {
    const work = artifact.work;
    let terminalReason = null;
    let terminalStatus = null;
    if (work.status === "EXPIRED_UNDELIVERED" ||
        (ACTIVE_WORK_STATES.has(work.status) && new Date(work.expiresAt) <= new Date(now))) {
      terminalStatus = "EXPIRED_UNDELIVERED";
      terminalReason = "DEADLINE_PASSED";
    } else if (work.status === "UNSCORABLE") {
      terminalStatus = "UNSCORABLE";
      terminalReason = "DEPENDENCY_INPUT_UNREPLAYABLE";
    } else if (ACTIVE_WORK_STATES.has(work.status)) {
      const digest = crypto.createHash("sha256")
        .update(Buffer.from(canonicalize(artifact.payload), "utf8"))
        .digest("hex");
      const provenanceMatches =
        artifact.schemaVersion === 1 &&
        digest === artifact.payloadDigest &&
        artifact.captureSyncRequestId === work.captureSyncRequestId &&
        new Date(artifact.captureCompletedAt).getTime() ===
          new Date(work.captureCompletedAt).getTime() &&
        new Date(artifact.captureCoverageThrough).getTime() ===
          new Date(work.captureCoverageThrough).getTime() &&
        BigInt(artifact.sourceScoringInputGeneration) ===
          BigInt(work.sourceScoringInputGeneration);
      if (!provenanceMatches || !Number.isInteger(artifact.payload?.attributionDeltaSteps)) {
        terminalStatus = "UNSCORABLE";
        terminalReason = "INPUTS_NOT_RETAINED";
      } else {
        const updated = await tx.globalEventRaceImpact.updateMany({
          where: {
            eventId: artifact.eventId,
            raceId,
            userId: artifact.userId,
            attributionVersion: 2,
            status: "PENDING",
          },
          data: {
            status: "FINAL",
            deltaSteps: artifact.payload.attributionDeltaSteps,
            settledAt: new Date(now),
            captureKind: "POST_BOUNDARY_SYNC",
            captureSyncRequestId: artifact.captureSyncRequestId,
            captureCompletedAt: artifact.captureCompletedAt,
            captureCoverageThrough: artifact.captureCoverageThrough,
            sourceScoringInputGeneration: artifact.sourceScoringInputGeneration,
            sourceResolutionGeneration: Number(sourceResolutionGeneration) || 1,
          },
        });
        finalized += updated.count;
      }
    }
    if (terminalStatus) {
      const updated = await tx.globalEventRaceImpact.updateMany({
        where: {
          eventId: artifact.eventId,
          raceId,
          userId: artifact.userId,
          attributionVersion: 2,
          status: "PENDING",
        },
        data: {
          status: terminalStatus,
          terminalReason,
          terminalAt: new Date(now),
        },
      });
      terminalized += updated.count;
    }
  }
  // Terminal work can predate artifact capture (most notably a missed-sync
  // expiry), so the C0 cleanup path must also consume work directly. This is
  // intentionally inside the same race-fenced transaction as FINAL writes.
  const terminalRows = await tx.$queryRawUnsafe(
    `SELECT impact.event_id AS "eventId", impact.user_id AS "userId",
            work.status, work.last_error_code AS "lastErrorCode",
            work.expires_at <= $2::timestamp AS "deadlinePassed"
       FROM global_event_race_impacts impact
       JOIN global_event_summary_work work
         ON work.event_id = impact.event_id AND work.user_id = impact.user_id
      WHERE impact.race_id = $1
        AND impact.status = 'PENDING'
        AND (work.status IN ('UNSCORABLE', 'EXPIRED_UNDELIVERED')
             OR work.expires_at <= $2::timestamp)
      ORDER BY impact.event_id ASC, impact.user_id ASC`,
    raceId,
    new Date(now),
  );
  for (const row of terminalRows) {
    const expired = row.status === "EXPIRED_UNDELIVERED" || row.deadlinePassed === true;
    const status = expired ? "EXPIRED_UNDELIVERED" : "UNSCORABLE";
    const terminalReason = expired
      ? "DEADLINE_PASSED"
      : ([
          "INPUTS_NOT_RETAINED",
          "RACE_CANCELLED_UNREPLAYABLE",
          "PARTICIPANT_STATE_UNREPLAYABLE",
          "DEPENDENCY_INPUT_UNREPLAYABLE",
        ].includes(row.lastErrorCode)
          ? row.lastErrorCode
          : "DEPENDENCY_INPUT_UNREPLAYABLE");
    const updated = await tx.globalEventRaceImpact.updateMany({
      where: {
        eventId: row.eventId,
        raceId,
        userId: row.userId,
        status: "PENDING",
      },
      data: {
        attributionVersion: 2,
        status,
        terminalReason,
        terminalAt: new Date(now),
      },
    });
    terminalized += updated.count;
  }
  await refreshSummaryReadinessForRace(tx, { raceId, now });
  return {
    finalized,
    terminalized,
    artifactCount: artifacts.length,
    terminalCandidateCount: terminalRows.length,
  };
}

module.exports = {
  MAX_ARTIFACT_BYTES,
  MAX_WORK_BYTES,
  canonicalize,
  digestCanonical,
  scoreCaptureArtifact,
  lockEligibleSummaryCaptureDependencies,
  claimEligibleSummaryWork,
  persistCapturedSummaryImpactsForRace,
  refreshSummaryReadinessForRace,
};
