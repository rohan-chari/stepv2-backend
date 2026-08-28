const crypto = require("node:crypto");
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

async function buildArtifact(tx, { impact, work, entitlement, provenance }) {
  const race = await tx.race.findUnique({
    where: { id: impact.raceId },
    select: {
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
    },
  });
  const participant = race?.participants?.find((row) => row.userId === work.userId);
  if (!race || !participant) return { error: "PARTICIPANT_STATE_UNREPLAYABLE" };
  const cutoffCandidates = [entitlement.endsAt, race.endsAt,
    participant.finishedAt, participant.forfeitedAt]
    .filter(Boolean)
    .map((value) => new Date(value));
  const cutoffAt = new Date(Math.min(...cutoffCandidates.map((value) => value.getTime())));
  if (!Number.isFinite(cutoffAt.getTime())) return { error: "INPUTS_NOT_RETAINED" };

  const participantRows = race.participants.map((row) => {
    const candidates = [entitlement.endsAt, race.endsAt, row.finishedAt, row.forfeitedAt]
      .filter(Boolean)
      .map((value) => new Date(value).getTime());
    return { ...row, cutoffAt: new Date(Math.min(...candidates)) };
  });
  const dependencyUserIds = participantRows.map((row) => row.userId).sort();
  const earliestDate = new Date(new Date(race.startedAt).getTime() - 24 * 60 * 60 * 1000);
  const latestDate = new Date(cutoffAt.getTime() + 24 * 60 * 60 * 1000);
  const [samples, dailySteps, effects, inputVersions] = await Promise.all([
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
  const works = await tx.globalEventSummaryWork.findMany({
    where: {
      userId,
      status: "WAITING_SYNC",
      expiresAt: { gt: new Date(at) },
      event: { summaryAttributionVersion: 2, endsAt: { lte: new Date(at) } },
    },
    select: { id: true, eventId: true },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
  });
  if (works.length === 0) return [];
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
    `INSERT INTO user_scoring_input_versions (user_id, generation, updated_at)
     SELECT dependency.user_id, 1, CURRENT_TIMESTAMP
       FROM unnest($1::text[]) AS dependency(user_id)
      ORDER BY dependency.user_id
     ON CONFLICT (user_id) DO NOTHING`,
    discovered,
  );
  const locked = await tx.$queryRawUnsafe(
    `SELECT user_id AS "userId", generation
       FROM user_scoring_input_versions
      WHERE user_id = ANY($1::text[])
      ORDER BY user_id ASC
      FOR UPDATE`,
    discovered,
  );
  if (locked.length !== discovered.length) {
    const error = new Error("summary capture dependency input row missing");
    error.code = "SUMMARY_CAPTURE_CLOSURE_CHANGED";
    throw error;
  }
  // Global capture order is scoring-input rows (ascending user id) before race
  // C0 rows (ascending race id). Ordinary user syncs take only their own input
  // row, so this order prevents A-capture/B-sync cycles while C0 still freezes
  // membership/effect edges before the immutable copy is read.
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
  return workIds;
}

async function claimEligibleSummaryWork(tx, {
  userId,
  eligibleWorkIds = [],
  captureSyncRequestId,
  captureCompletedAt,
  captureCoverageThrough,
  sourceScoringInputGeneration,
}) {
  if (!captureCoverageThrough || !sourceScoringInputGeneration) return null;
  const existingActive = await tx.globalEventSummaryWork.findFirst({
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
  const candidates = await tx.globalEventSummaryWork.findMany({
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
  for (const work of candidates) {
    if (work.event.summaryAttributionVersion !== 2) continue;
    const entitlement = await tx.globalStepEventEntitlement.findUnique({
      where: { eventId_userId: { eventId: work.eventId, userId } },
    }) || legacyGlobalSummaryEntitlement({ event: work.event, userId });
    if (!entitlement) continue;
    if (new Date(captureCompletedAt) < new Date(entitlement.endsAt) ||
        new Date(captureCoverageThrough) < new Date(entitlement.endsAt)) continue;
    const impacts = await tx.globalEventRaceImpact.findMany({
      where: {
        eventId: work.eventId,
        userId,
        status: "PENDING",
      },
      orderBy: { raceId: "asc" },
    });
    const incompatibleCount = await tx.globalEventRaceImpact.count({
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
      const artifact = await buildArtifact(tx, { impact, work, entitlement, provenance });
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
    return { finalized: 0, terminalized: 0 };
  }
  const artifacts = await tx.globalEventCaptureArtifact.findMany({
    where: { raceId },
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
  return { finalized, terminalized };
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
};
