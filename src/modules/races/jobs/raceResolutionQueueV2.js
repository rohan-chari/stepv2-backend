const crypto = require("node:crypto");
const { prisma: defaultPrisma, getDbPoolPressure } = require("../../../db");
const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const {
  RaceResolutionJobV2: defaultJobModel,
  newLeaseToken,
  LEASE_MS,
} = require("../models/raceResolutionJobV2");
const {
  RacePlacementTransitionJob: defaultPlacementJobModel,
} = require("../models/racePlacementTransitionJob");
const {
  buildResolveRaceState,
} = require("../services/raceStateResolution");
const {
  createWriteCapture,
  computeRaceState: defaultComputeRaceState,
} = require("../services/computeRaceState");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");
const {
  recentBoxMints: defaultRecentBoxMints,
} = require("../services/recentBoxMints");
const { nudgeOvertakenRivals } = require("../../steps/commands/recordSteps");
const { stepSyncPushService } = require("../../../shared/push/stepSyncPush");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const {
  raceResolutionWorkerDisabled,
} = require("../../../shared/config/operationalControls");
const {
  StepSyncRequest: defaultStepSyncRequestModel,
} = require("../../steps/models/stepSyncRequest");
const {
  raceResolutionWorkBudget: defaultWorkBudget,
} = require("../services/raceResolutionWorkBudget");
const {
  raceResolutionPostTaskHandoff: defaultPostTaskHandoff,
} = require("../services/raceResolutionPostTaskHandoff");
const {
  raceResolutionDisplayArtifact: defaultDisplayArtifactStore,
  artifactMatchesClaim,
  computeArtifactReuseDeadline,
} = require("../services/raceResolutionDisplayArtifact");
const {
  buildRaceResolutionInputFingerprint: defaultBuildInputFingerprint,
} = require("../services/raceResolutionInputFingerprint");
const { balanceConfig: defaultBalanceConfig } = require("../../economy/balanceConfig");
const { eventBus: defaultEventBus } = require("../../../shared/events/eventBus");
const {
  buildRaceResolutionStepSyncScope: defaultBuildStepSyncScope,
  stepSyncScopeMatchesFence: defaultStepSyncScopeMatchesFence,
  isClosureEligibleReasonSet,
  isSourceInputClosureEligibleReasonSet,
} = require("../services/raceResolutionStepSyncScope");
const {
  buildRaceScoringDependencyClosure: defaultBuildDependencyClosure,
  buildClosureFingerprintDigest,
  wouldTrailMineEscalate: defaultWouldTrailMineEscalate,
  TRAIL_MINE_ESCALATION_UNKNOWN,
  CLOSURE_FALLBACK_REASON_VALUES,
} = require("../services/raceScoringDependencyClosure");
const {
  raceResolutionDeliveryIntents: defaultDeliveryIntents,
} = require("../services/raceResolutionDeliveryIntents");
const {
  runCapacityMetricsEntry,
  startCapacityPhase,
} = require("../../../shared/observability/capacityPhaseMetrics");
const {
  impactDescription,
  naturalExpiryImpactDescription,
  normalizeAttackerDisplayName,
} = require("../models/raceImpactEvent");
const {
  prorateSamplesIntoWindow,
} = require("../../steps/models/stepSample");
const {
  shouldResolveUmbrellaImpacts,
} = require("./resolvedImpactBoundaryScheduler");
const {
  SNAPSHOT_AT_EXPIRY_TYPES,
} = require("../../powerups/constants/expiryEffectTypes");
const {
  persistCapturedSummaryImpactsForRace,
} = require("../../steps/services/globalEventSummaryCapture");
const {
  createOperationalAlertSpool,
} = require("../../../shared/operationalAlerts/operationalAlertSpool");

const POLL_INTERVAL_MS = 250;
const QUEUE_LAG_LOG_INTERVAL_MS = 60 * 1000;
const QUEUE_LAG_ALARM_MS = 30 * 1000;
const RACE_RESOLUTION_SLOW_PHASE_MS = 10_000;
const RACE_RESOLUTION_SLOW_ATTEMPT_MS = 30_000;
const RACE_RESOLUTION_WATCHDOG_MS = 60_000;
const RACE_RESOLUTION_DIAGNOSTIC_FLUSH_MS = 200;
// Best-effort reservation cleanup cadence (never affects correctness). Carried
// over from the v1 scheduler, which src/index.js no longer starts.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ADAPTIVE_DRAIN_SLICE_MS = 100;
const ADAPTIVE_DRAIN_SLICE_JOBS = 16;
const ADAPTIVE_DRAIN_ERROR_BACKOFF_MS = 1000;
const TARGETED_CLAIM_DISABLED = Symbol("TARGETED_CLAIM_DISABLED");
const POST_COMMIT_SLACK_MS = 30_000;
const FENCE_DUE_EXPIRY_VETO_TYPES = Object.freeze(
  new Set([...SNAPSHOT_AT_EXPIRY_TYPES, "DRILL_SERGEANT"])
);
const PROCESS_BOOT_ID = crypto.randomUUID();
const PROCESS_BOOT_TIMESTAMP = new Date().toISOString();

function containsSourceInputWork(reasons) {
  return Array.isArray(reasons) && reasons.includes("STEP_INPUT_CHANGED");
}

function sourceInputTargetIsTerminal(fingerprint, triggeringUserIds, at) {
  const race = fingerprint?.race;
  if (!race) return false;
  if (race.status !== "ACTIVE") return true;
  const endsAt = race.endsAt == null ? null : new Date(race.endsAt).getTime();
  if (Number.isFinite(endsAt) && endsAt <= new Date(at).getTime()) return true;
  const triggering = new Set(triggeringUserIds || []);
  const targets = (fingerprint.participants || []).filter((participant) =>
    triggering.has(participant.userId)
  );
  return targets.length > 0 && targets.every((participant) =>
    participant.status !== "ACCEPTED" ||
    participant.finishedAt != null ||
    participant.forfeitedAt != null
  );
}

async function promoteMismatchedCommittedStepSync(job, prisma) {
  const reasons = Array.isArray(job?.processingDirtyReasons)
    ? job.processingDirtyReasons
    : [];
  if (!reasons.includes("STEP_SYNC") || containsSourceInputWork(reasons)) {
    return false;
  }
  const userIds = [...new Set(
    (job.processingTriggeredByUserIds || []).filter(
      (value) => typeof value === "string" && value.length > 0
    )
  )].sort();
  if (userIds.length === 0) return false;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT user_id AS "userId", generation,
            source_queue_semantics_generation AS "sourceQueueSemanticsGeneration"
       FROM user_scoring_input_versions
      WHERE user_id = ANY($1::text[])
      ORDER BY user_id`,
    userIds
  );
  const byUser = new Map(rows.map((row) => [row.userId, row]));
  const mismatch = userIds.some((userId) => {
    const row = byUser.get(userId);
    return !row || row.sourceQueueSemanticsGeneration == null ||
      BigInt(row.generation) !== BigInt(row.sourceQueueSemanticsGeneration);
  });
  if (!mismatch) return false;
  job.processingDirtyReasons = [...new Set(
    reasons.map((reason) =>
      reason === "STEP_SYNC" ? "STEP_INPUT_CHANGED" : reason
    )
  )];
  return true;
}

function dueExpiryOutsideClosureAtFence(
  activeEffects,
  closureParticipantIds,
  currentTime,
) {
  const closure = new Set(closureParticipantIds || []);
  const horizonMs = currentTime.getTime() + POST_COMMIT_SLACK_MS;
  for (const effect of activeEffects || []) {
    if (!FENCE_DUE_EXPIRY_VETO_TYPES.has(effect?.type)) continue;
    if (closure.has(effect.targetParticipantId)) continue;
    if (effect.expiresAt == null) continue;
    const expiresAtMs = new Date(effect.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= horizonMs) return true;
  }
  return false;
}

async function persistResolvedImpactEventsV2({ tx, raceId, result }) {
  const capture = result?.activeImpactCapture || {};
  const impacts = [
    ...(capture.timedImpacts || []),
    ...(capture.trailMineImpacts || []),
    ...(capture.drillSergeantImpacts || []),
  ].filter((impact) =>
    impact?.effectId &&
    impact?.userId &&
    Number.isInteger(impact.deltaSteps) &&
    impact.deltaSteps !== 0
  );
  if (impacts.length === 0) return { sourceCount: 0, insertedCount: 0 };
  const unique = new Map();
  for (const impact of impacts) {
    const key = `${impact.userId}:${impact.effectId}`;
    if (!unique.has(key)) unique.set(key, impact);
  }
  const effectRows = typeof tx.raceActiveEffect?.findMany === "function"
    ? await tx.raceActiveEffect.findMany({
        where: { id: { in: [...new Set([...unique.values()].map((impact) => impact.effectId))] } },
        select: { id: true, sourceUserId: true, metadata: true },
      })
    : [];
  const effectById = new Map(effectRows.map((effect) => [effect.id, effect]));
  const resultWrite = await tx.raceImpactEvent.createMany({
    data: [...unique.values()].map((impact) => {
      const effect = effectById.get(impact.effectId);
      const boundary = effect?.metadata?.impactBoundaryV1;
      const attackerDisplayName =
        effect?.sourceUserId && effect.sourceUserId !== impact.userId
          ? normalizeAttackerDisplayName(boundary?.attackerDisplayName)
          : null;
      return {
        raceId,
        recipientUserId: impact.userId,
        sourceKind: "ACTIVE_EFFECT",
        sourceId: impact.effectId,
        sourceFeedEventId: impact.sourceFeedEventId || null,
        powerupType: impact.powerupType,
        deltaSteps: impact.deltaSteps,
        description: impact.naturalExpiry === true
          ? naturalExpiryImpactDescription(impact.powerupType, impact.deltaSteps)
          : impactDescription(impact.powerupType, impact.deltaSteps),
        attackerDisplayName,
        valueStatus: "SYNCED_SNAPSHOT",
        calculationVersion: 2,
        resolvedAt: new Date(impact.resolvedAt || capture.asOf),
      };
    }),
    skipDuplicates: true,
  });
  return { sourceCount: unique.size, insertedCount: resultWrite.count };
}

async function resolveDueUmbrellaInterceptionsV2({
  tx,
  raceId,
  currentTime,
  limit = 8,
}) {
  const due = await tx.raceUmbrellaInterception.findMany({
    where: {
      raceId,
      status: "PENDING",
      resolvesAt: { lte: currentTime },
    },
    orderBy: [{ resolvesAt: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const selected = due.slice(0, limit);
  const race = await tx.race.findUnique({
    where: { id: raceId },
    select: { status: true, endsAt: true },
  });
  const pastDeadline = race?.endsAt && new Date(race.endsAt) <= currentTime;
  if (!race || race.status !== "ACTIVE" || pastDeadline) {
    if (selected.length > 0) {
      await tx.raceUmbrellaInterception.updateMany({
        where: { id: { in: selected.map((source) => source.id) }, status: "PENDING" },
        data: { status: "RESOLVED", resolvedAt: currentTime },
      });
    }
    return {
      sourceCount: selected.length,
      insertedCount: 0,
      hasMore: due.length > limit,
    };
  }
  let insertedCount = 0;
  for (const source of selected) {
    const samples = await tx.$queryRawUnsafe(
      `SELECT period_start AS "start", period_end AS "end", steps
         FROM step_samples
        WHERE user_id = $1
          AND period_end > $2::timestamp
          AND period_start < $3::timestamp
          AND period_end <= $4::timestamp`,
      source.recipientUserId,
      source.windowStart.toISOString(),
      source.resolvesAt.toISOString(),
      currentTime.toISOString(),
    );
    const walked = prorateSamplesIntoWindow(
      samples,
      source.windowStart.getTime(),
      source.resolvesAt.getTime(),
    );
    const deltaSteps = walked - Math.round(
      walked * Number(source.avoidedMultiplier),
    );
    if (deltaSteps !== 0) {
      const created = await tx.raceImpactEvent.createMany({
        data: [{
          raceId,
          recipientUserId: source.recipientUserId,
          sourceKind: "UMBRELLA_INTERCEPTION",
          sourceId: source.id,
          powerupType: "UMBRELLA",
          deltaSteps,
          description: impactDescription("UMBRELLA", deltaSteps),
          valueStatus: "SYNCED_SNAPSHOT",
          calculationVersion: 2,
          resolvedAt: source.resolvesAt,
        }],
        skipDuplicates: true,
      });
      insertedCount += created.count;
    }
    await tx.raceUmbrellaInterception.updateMany({
      where: { id: source.id, status: "PENDING" },
      data: { status: "RESOLVED", resolvedAt: currentTime },
    });
  }
  return {
    sourceCount: selected.length,
    insertedCount,
    hasMore: due.length > limit,
  };
}

// Keep one stable phase schema on every successful job line so production log
// aggregation can compare jobs without treating an unvisited branch as missing
// data. These are aggregate timings only: no ids, payloads, or query text.
const RACE_RESOLUTION_PHASES = Object.freeze([
  "claimReadiness",
  "fullTriggerPromotion",
  "claim",
  "planSettings",
  "dependencyClosurePlanner",
  "artifactLookup",
  "stepSyncScope",
  "compute",
  "prepareWrites",
  "transaction",
  "fenceAcquire",
  "fenceValidation",
  "discardSuperseded",
  "participantWrites",
  "sideWrites",
  "boxConsequences",
  "recordSuccess",
  "placementHandoff",
  "postSettings",
  "postCommitHook",
  "powerupStateSync",
  "overtakeNudges",
  "postTaskHandoff",
]);
const RACE_RESOLUTION_COMPUTE_PHASES = Object.freeze([
  "raceLoad",
  "scoringPrefetch",
  "globalEvents",
  "participantScoring",
  "hitchhikeCopies",
  "leechAndCapture",
  // Keep the aggregate key stable while exposing the two attribution
  // subphases. A resolver may emit all three; additive timing fields never
  // select behavior.
  "activeImpactAttribution",
  "activeTimedImpactAttribution",
  "activeDefenseImpactAttribution",
  "activeEffects",
  "trailMines",
]);
const RACE_RESOLUTION_NUDGE_PHASES = Object.freeze([
  "participantLoad",
  "ranking",
  "intentHandoff",
]);
const RACE_RESOLUTION_HANDOFF_PHASES = Object.freeze([
  "taskInsert",
  "resolveIntents",
  "taskUpdate",
  "intentInsert",
  "taskTransaction",
  "runnerReadiness",
  "inlineClaim",
]);

function emptyPhaseTotals(names) {
  return Object.fromEntries(names.map((name) => [name, 0]));
}

function addPhaseTiming(totals, name, durationMs) {
  if (!Object.hasOwn(totals, name)) return;
  const duration = Number(durationMs);
  if (Number.isFinite(duration)) totals[name] += Math.max(0, duration);
}

function addPhaseCount(totals, name, count) {
  if (!Object.hasOwn(totals, name)) return;
  const numeric = Number(count);
  if (Number.isFinite(numeric)) totals[name] += Math.max(0, Math.trunc(numeric));
}

function createRaceResolutionPhaseTimer(
  monotonicNow = process.hrtime.bigint,
  options = {}
) {
  const totals = emptyPhaseTotals(RACE_RESOLUTION_PHASES);
  let attemptStartedAt = monotonicNow();
  const stack = [];
  let lastCompletedPhase = null;
  let nextInstanceId = 0;
  const emit = typeof options.emit === "function" ? options.emit : null;
  let attemptContext = options.attemptContext || null;
  const scheduleTimeout = options.scheduleTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;

  const elapsedMs = (startedAt) =>
    Math.max(0, Number(monotonicNow() - startedAt) / 1e6);

  function liveState() {
    const active = stack.at(-1) || null;
    return {
      activePhase: active?.name || null,
      parentPhase: stack.length > 1 ? stack.at(-2).name : null,
      phaseStack: stack.map((entry) => entry.name).slice(-12),
      activePhaseElapsedMs: active ? elapsedMs(active.startedAt) : 0,
      attemptElapsedMs: elapsedMs(attemptStartedAt),
      lastCompletedPhase,
    };
  }

  function emitPhase(checkpoint, instance) {
    if (!emit || !attemptContext) return;
    const state = liveState();
    emit({
      event: "race_resolution_v2_phase",
      schemaVersion: 3,
      observedAt: new Date().toISOString(),
      checkpoint,
      attemptId: attemptContext.attemptId,
      activePhase: state.activePhase,
      parentPhase: state.parentPhase,
      phaseStack: state.phaseStack,
      phaseElapsedMs: state.activePhaseElapsedMs,
      attemptElapsedMs: state.attemptElapsedMs,
      queuePriority: attemptContext.queuePriority || "LIVE",
      resolutionPlan: typeof attemptContext.resolutionPlan === "function"
        ? attemptContext.resolutionPlan()
        : attemptContext.resolutionPlan || null,
      workerPid: process.pid,
      monotonicPhaseElapsedMs: state.activePhaseElapsedMs,
      monotonicAttemptElapsedMs: state.attemptElapsedMs,
      phaseInstance: instance.instanceId,
    });
  }

  function emitSlowIfOverdue(instance) {
    if (
      !instance ||
      instance.slowEmitted ||
      stack.at(-1) !== instance ||
      elapsedMs(instance.startedAt) < RACE_RESOLUTION_SLOW_PHASE_MS
    ) return;
    instance.slowEmitted = true;
    emitPhase("slow", instance);
  }

  function start(name) {
    if (!Object.hasOwn(totals, name)) throw new Error(`unknown race resolution phase: ${name}`);
    const instance = {
      name,
      startedAt: monotonicNow(),
      instanceId: ++nextInstanceId,
      slowEmitted: false,
      slowHandle: null,
    };
    stack.push(instance);
    emitPhase("enter", instance);
    if (emit && attemptContext) {
      instance.slowHandle = scheduleTimeout(() => {
        emitSlowIfOverdue(instance);
      }, RACE_RESOLUTION_SLOW_PHASE_MS);
      instance.slowHandle?.unref?.();
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      if (stack.at(-1) !== instance) {
        throw new Error(
          `non-LIFO race resolution phase stop: expected ${stack.at(-1)?.name || "none"}, received ${name}`
        );
      }
      stopped = true;
      if (instance.slowHandle) cancelTimeout(instance.slowHandle);
      stack.pop();
      totals[name] += elapsedMs(instance.startedAt);
      lastCompletedPhase = name;
      // A parent's own 10-second callback may have fired while a nested child
      // was innermost. Surface it as soon as it becomes the active phase again.
      emitSlowIfOverdue(stack.at(-1));
    };
  }

  return {
    start,
    async measure(name, operation) {
      const stop = start(name);
      try {
        return await operation();
      } finally {
        stop();
      }
    },
    snapshot() {
      return { ...totals };
    },
    liveState,
    setAttemptContext(context) {
      attemptContext = context || null;
      attemptStartedAt = monotonicNow();
    },
  };
}

function createRaceResolutionAttemptWatchdog(dependencies = {}) {
  const processRole = dependencies.processRole || process.env.STEPS_PROCESS_ROLE || "all";
  if (processRole !== "resolution") return { cancel() {} };

  const attempt = dependencies.attempt || {};
  const phaseTimer = dependencies.phaseTimer;
  const workBudget = dependencies.workBudget;
  const scheduleTimeout = dependencies.scheduleTimeout || setTimeout;
  const cancelTimeout = dependencies.clearTimeout || clearTimeout;
  const emitDiagnostic = dependencies.emitDiagnostic || ((event) => {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  });
  const writeAlertMarker = dependencies.writeAlertMarker || (() => {});
  const flushDiagnostics = dependencies.flushDiagnostics || (() => Promise.all(
    [process.stdout, process.stderr].map((stream) => new Promise((resolve) => {
      try { stream.write("", resolve); } catch (_) { resolve(); }
    }))
  ));
  const failStop = dependencies.failStop || ((code) => {
    process.exitCode = code;
    process.exit(code);
  });
  const getSiblingAttempts = dependencies.getSiblingAttempts || (() => []);
  const expiredLeaseCount = dependencies.expiredLeaseCount || (() => null);
  let cancelled = false;
  let expired = false;

  const snapshot = (alertType) => {
    const state = phaseTimer?.liveState?.() || {};
    return {
      schemaVersion: 1,
      alertType,
      environment: process.env.NODE_ENV || "development",
      observedAt: new Date().toISOString(),
      attemptId: attempt.attemptId,
      jobId: attempt.jobId,
      raceId: attempt.raceId,
      leaseExpiresAt: attempt.leaseExpiresAt instanceof Date
        ? attempt.leaseExpiresAt.toISOString()
        : attempt.leaseExpiresAt || null,
      activePhase: state.activePhase || null,
      parentPhase: state.parentPhase || null,
      phaseStack: Array.isArray(state.phaseStack) ? state.phaseStack.slice(-12) : [],
      phaseElapsedMs: Math.round(state.activePhaseElapsedMs || 0),
      attemptElapsedMs: Math.round(state.attemptElapsedMs || 0),
      queueLagMs: Math.round(attempt.queueLagMs || 0),
      workBudget: workBudget?.snapshot?.() || null,
      expiredLeaseCount: expiredLeaseCount(),
      workerPid: process.pid,
      lastCompletedPhase: state.lastCompletedPhase || null,
      authoritativeCommitCompleted: attempt.authoritativeCommitCompleted === true,
    };
  };

  const slowHandle = scheduleTimeout(() => {
    if (cancelled || expired) return;
    try {
      writeAlertMarker(snapshot("slow"));
    } catch (error) {
      emitDiagnostic({
        event: "race_resolution_v2_alert_spool_error",
        schemaVersion: 1,
        alertType: "slow",
        attemptId: attempt.attemptId,
        errorCode: error?.code || "SPOOL_WRITE_FAILED",
      });
    }
  }, RACE_RESOLUTION_SLOW_ATTEMPT_MS);
  slowHandle?.unref?.();

  const watchdogHandle = scheduleTimeout(async () => {
    if (cancelled || expired) return;
    expired = true;
    try {
      // The fail-stop boundary deliberately starts before every diagnostic
      // getter. Diagnostics are valuable, but a broken snapshot seam must
      // never turn a watchdog expiry into a process that keeps serving work.
      const diagnostic = {
        event: "race_resolution_v2_watchdog",
        outcome: "expired",
        ...snapshot("watchdog"),
        siblingActiveAttempts: getSiblingAttempts()
          .filter((entry) => entry?.attemptId !== attempt.attemptId),
      };
      emitDiagnostic(diagnostic);
      writeAlertMarker(diagnostic);
      await Promise.race([
        Promise.resolve(flushDiagnostics(RACE_RESOLUTION_DIAGNOSTIC_FLUSH_MS)),
        new Promise((resolve) => {
          scheduleTimeout(resolve, RACE_RESOLUTION_DIAGNOSTIC_FLUSH_MS);
        }),
      ]);
    } catch (error) {
      try {
        emitDiagnostic({
          event: "race_resolution_v2_alert_spool_error",
          schemaVersion: 1,
          alertType: "watchdog",
          attemptId: attempt.attemptId,
          errorCode: error?.code || "WATCHDOG_DIAGNOSTIC_FAILED",
        });
      } catch (_) {}
    } finally {
      failStop(70);
    }
  }, RACE_RESOLUTION_WATCHDOG_MS);
  watchdogHandle?.unref?.();

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      cancelTimeout(slowHandle);
      cancelTimeout(watchdogHandle);
    },
  };
}

// Starts a bounded number of independently-claimed jobs at once. Every
// [processOne] claim uses `FOR UPDATE SKIP LOCKED` and the later fenced write is
// race-keyed, so separate lanes can never write the same race concurrently.
// Keeping this helper small and pure makes the scheduler's actual parallelism
// directly testable without mocking the worker's settlement machinery.
async function runBoundedRaceResolutionJobs(concurrency, processOne) {
  const lanes = Math.min(3, Math.max(1, Number(concurrency) || 1));
  // Do not reject early: the scheduler clears its in-flight guard when tick()
  // settles. An early rejection while a sibling is still resolving would let
  // the next 250ms tick exceed the lane cap. Surface the error only once every
  // lane has settled, so the scheduler stays closed over all active work.
  const settled = await Promise.allSettled(
    Array.from({ length: lanes }, () => processOne())
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return settled.filter(
    (result) => result.status === "fulfilled" && result.value
  ).length;
}

// §5a item 1 "worker handoff": the v2 worker must not claim while an OLD-binary
// worker could still be draining the per-user table during a `pm2 reload`
// overlap. 60s > the old worker's 30s lease + the reload window. Env-tunable so
// tests can shrink it (they assert the gate, not the wall-clock).
function quietPeriodMs() {
  const parsed = Number(process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60 * 1000;
}

function effectiveResolutionConcurrency(environment = process.env) {
  return Math.min(3, Math.max(1,
    Number(environment.ASYNC_RACE_RESOLUTION_CONCURRENCY) || 1));
}

// Thrown by the fenced write transaction when the job row no longer matches our
// lease token. It means the lease expired and someone else re-claimed the race,
// so we must roll back HAVING WRITTEN NOTHING and walk away without touching the
// job row (it belongs to the new owner now).
class FenceLostError extends Error {
  constructor() {
    super("Race resolution lease token no longer valid");
    this.name = "FenceLostError";
  }
}

function participantTotalWriteChangesRow(write, current) {
  if (write.kind !== "participantTotal") return true;
  // Compare against the same normalization the writer applies
  // (normalizeParticipantWrites rounds; the model clamps rawSteps): a fractional
  // capture (e.g. 2150.5 under a 0.5x effect) compared raw against the stored
  // integer would classify the row as changed on every resolution forever.
  if (!current || current.totalSteps !== Math.round(write.totalSteps)) return true;
  return (
    typeof write.rawSteps === "number" &&
    Number.isFinite(write.rawSteps) &&
    current.rawSteps !== Math.max(0, Math.round(write.rawSteps))
  );
}

function retainTeamAsOfHeartbeat(candidateWrites, changedWrites, isTeamRace) {
  if (!isTeamRace) return changedWrites;
  if (changedWrites.some((write) => write.kind === "participantTotal")) {
    return changedWrites;
  }
  const heartbeat = candidateWrites.find(
    (write) => write.kind === "participantTotal"
  );
  return heartbeat ? [...changedWrites, heartbeat] : changedWrites;
}

function supersededRunMayDiscard(job, currentTime = new Date()) {
  return Boolean(
    job &&
      Number(job.generation) > Number(job.processingGeneration) &&
      job.dirtyPriority === "COALESCE" &&
      job.processingDirtyPriority === "COALESCE" &&
      job.lastCompletedAt &&
      currentTime.getTime() - new Date(job.lastCompletedAt).getTime() <= 15_000
  );
}

async function rebindArtifactPresentation(tx, artifactPayload) {
  const participants = artifactPayload?.result?.race?.participants;
  if (!Array.isArray(participants)) return false;
  const userIds = [...new Set(participants.map((row) => row.userId).filter(Boolean))];
  const users = await tx.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, profilePhotoUrl: true },
  });
  if (users.length !== userIds.length) return false;
  const byId = new Map(users.map((user) => [user.id, user]));
  for (const participant of participants) {
    const current = byId.get(participant.userId);
    if (!current) return false;
    participant.user = { ...(participant.user || {}), ...current };
  }
  for (const write of artifactPayload.writes || []) {
    if (write.kind !== "eventCreate") continue;
    const data = write.data;
    const target = byId.get(data?.targetUserId);
    const metadata = data?.metadata;
    if (!target || data?.powerupType !== "TRAIL_MINE" || !metadata) return false;
    const name = target.displayName || "A runner";
    data.description = metadata.blocked
      ? `${name} blocked a Trail Mine with Compression Socks!`
      : `${name} triggered a Trail Mine and lost ${
        Number(metadata.penalty || 0).toLocaleString()
      } steps.`;
  }
  return true;
}

function resolutionPlanForDirtyReasons(reasons) {
  return Array.isArray(reasons) &&
    reasons.length === 1 &&
    reasons[0] === "BOX_OPEN"
    ? "NO_SCORE"
    : "FULL";
}

// ── Phase 2b: dependency-closure SHADOW observability ───────────────────────
//
// The planner's result carries in-memory handoffs (participant ids, effect
// rows, per-participant step totals) that exist for the Phase 3 write path.
// NONE of them may reach a log line. What follows is the complete, closed set
// of fields the shadow is allowed to emit: plan, a closed-enum fallback reason,
// three counts, two booleans/tri-state, and a duration. No user id, participant
// id, step total, or effect metadata — spec §Observability and the result-field
// contract comment on raceScoringDependencyClosure's return value.
//
// Every field is null when the flag is off or the envelope is not
// closure-candidate-shaped, so "the shadow did not run" is unambiguous in the
// log rather than indistinguishable from "it ran and found nothing".
const NULL_CLOSURE_SHADOW_FIELDS = Object.freeze({
  shadowClosurePlan: null,
  shadowClosureFallbackReason: null,
  shadowClosureCount: null,
  shadowSourceCount: null,
  shadowMinesActive: null,
  shadowWouldEscalateOnMine: null,
  shadowPlannerMs: null,
  shadowRetainedSourceCount: null,
});

function summarizeClosureShadow(
  result,
  plannerMs,
  escalationProbe = defaultWouldTrailMineEscalate
) {
  if (!result || typeof result !== "object") {
    return { ...NULL_CLOSURE_SHADOW_FIELDS, shadowPlannerMs: plannerMs };
  }
  const plan =
    result.plan === "DEPENDENCY_CLOSURE" || result.plan === "FULL"
      ? result.plan
      : null;
  const isClosure = plan === "DEPENDENCY_CLOSURE";
  const minesActive = result.minesActive === true;
  let wouldEscalate = null;
  if (isClosure && minesActive) {
    const verdict = escalationProbe({
      mines: result.mines,
      closureIds: result.participantIds,
      participantTotals: result.participantTotals,
    });
    // The tri-state is the whole point of this measurement: "UNKNOWN" is the
    // legacy-mine case (no `aheadParticipantIds`, no pre-generation total) and
    // Phase 3 must treat it as ESCALATE. It is logged as the STRING "UNKNOWN",
    // never coerced to a boolean and never dropped — the rate of this exact
    // value on the Weekly is what decides whether the closure can ship there.
    wouldEscalate =
      verdict === TRAIL_MINE_ESCALATION_UNKNOWN
        ? String(TRAIL_MINE_ESCALATION_UNKNOWN)
        : verdict === true;
  }
  return {
    shadowClosurePlan: plan,
    // Closed enum only. An unrecognized value is logged as null rather than
    // widening the dimension the rollout gates are read from.
    shadowClosureFallbackReason: CLOSURE_FALLBACK_REASON_VALUES.has(
      result.fallbackReason
    )
      ? result.fallbackReason
      : null,
    // Null (not 0) on a FULL plan: there is no closure to size, and a 0 would
    // drag every aggregate over closure size toward zero.
    shadowClosureCount: isClosure ? (result.participantIds || []).length : null,
    shadowSourceCount: Array.isArray(result.sourceParticipantIds)
      ? result.sourceParticipantIds.length
      : null,
    // On a FULL fallback the planner may have short-circuited before ever
    // inspecting the active set — "no mines" and "never looked" must not
    // collapse into the same value, so mines are reported only on a closure.
    shadowMinesActive: isClosure ? minesActive : null,
    shadowWouldEscalateOnMine: wouldEscalate,
    shadowPlannerMs: plannerMs,
    shadowRetainedSourceCount: Array.isArray(result.retainedUnresolvedSources)
      ? result.retainedUnresolvedSources.length
      : null,
  };
}

function normalizeParticipantWrites(writes) {
  const byParticipant = new Map();
  for (const write of writes || []) {
    if (!write?.participantId) throw new Error("participant capture missing id");
    let row = byParticipant.get(write.participantId);
    if (!row) {
      row = {
        participantId: write.participantId,
        totalSteps: null,
        hasTotal: false,
        rawSteps: null,
        hasRaw: false,
        bonusDecrement: 0,
      };
      byParticipant.set(write.participantId, row);
    }
    if (write.kind === "participantBonus") {
      if (!Number.isFinite(write.amount)) {
        throw new Error("invalid participant bonus capture");
      }
      // Safety net only: today's sole producer (Trail Mine's Math.round'ed
      // penalty) already emits an integer.
      row.bonusDecrement += Math.round(write.amount);
      continue;
    }
    if (write.kind !== "participantTotal" || !Number.isFinite(write.totalSteps)) {
      throw new Error("invalid participant total capture");
    }
    // Effect multipliers (0.5x debuffs, freeze proration, …) produce fractional
    // totals. The legacy per-row Prisma UPDATE survived them because Postgres
    // ROUNDS on numeric→int assignment, but jsonb_to_recordset's `integer`
    // column is a text cast that raises 22P02 on "59939.5" — which failed the
    // whole resolution transaction for any race with such an effect. Round here
    // to keep the exact values the legacy writer persisted (assignment casts
    // round half AWAY FROM ZERO vs Math.round's half-up — they differ only on
    // negative halves, unreachable because totals are floored at 0 upstream).
    // `rawSteps` also
    // mirrors the model's `Math.max(0, Math.round(...))` clamp, which this bulk
    // writer bypasses.
    const totalSteps = Math.round(write.totalSteps);
    const hasRaw = Number.isFinite(write.rawSteps);
    const rawSteps = hasRaw ? Math.max(0, Math.round(write.rawSteps)) : null;
    if (
      row.hasTotal &&
      (row.totalSteps !== totalSteps ||
        row.hasRaw !== hasRaw ||
        (hasRaw && row.rawSteps !== rawSteps))
    ) {
      throw new Error("conflicting participant total capture");
    }
    row.totalSteps = totalSteps;
    row.hasTotal = true;
    row.rawSteps = rawSteps;
    row.hasRaw = hasRaw;
  }
  return [...byParticipant.values()];
}

async function writeParticipantsBulk(tx, writes, totalsUpdatedAt) {
  const rows = normalizeParticipantWrites(writes);
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.participantId);
  const locked = await tx.$queryRawUnsafe(
    `SELECT id
     FROM race_participants
     WHERE id = ANY($1::text[])
     ORDER BY user_id ASC, id ASC
     FOR UPDATE`,
    ids
  );
  if (locked.length !== rows.length) {
    throw new Error("race participant bulk lock count mismatch");
  }
  const updated = await tx.$queryRawUnsafe(
    `WITH input AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS row(
         "participantId" text,
         "totalSteps" integer,
         "hasTotal" boolean,
         "rawSteps" integer,
         "hasRaw" boolean,
         "bonusDecrement" integer
       )
       ), resolved AS (
         SELECT participant.id,
                input."totalSteps",
                input."hasTotal",
                input."rawSteps",
                input."hasRaw",
                GREATEST(
                  0,
                  CASE WHEN input."hasTotal"
                    THEN input."totalSteps"
                    ELSE participant.total_steps
                  END
                ) AS base_total,
                GREATEST(0, -participant.total_steps) AS legacy_overkill,
                LEAST(
                  input."bonusDecrement",
                  GREATEST(
                    0,
                    CASE WHEN input."hasTotal"
                      THEN input."totalSteps"
                      ELSE participant.total_steps
                    END
                  )
                ) AS actual_penalty
           FROM race_participants participant
           JOIN input ON input."participantId" = participant.id
       )
     UPDATE race_participants participant
     SET total_steps = resolved.base_total - resolved.actual_penalty,
         raw_steps = CASE WHEN resolved."hasRaw" THEN resolved."rawSteps" ELSE participant.raw_steps END,
         bonus_steps = participant.bonus_steps + resolved.legacy_overkill - resolved.actual_penalty,
         totals_updated_at = CASE WHEN resolved."hasTotal" THEN $2 ELSE participant.totals_updated_at END
     FROM resolved
     WHERE participant.id = resolved.id
     RETURNING participant.id`,
    JSON.stringify(rows),
    totalsUpdatedAt
  );
  if (updated.length !== rows.length) {
    throw new Error("race participant bulk update count mismatch");
  }
  return updated.length;
}

// The write-capture proxy lives in services/computeRaceState.js — the SAME one
// the read-only callers (usePowerup's Trail Mine plant and Uprising gate) use.
// One capture, one definition of "the write surface of resolveRaceState": the
// worker replays the recorded writes inside its fence, the read-only callers
// discard them. A second copy here would be a second thing to keep in lockstep.

function buildRaceResolutionWorkerV2(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const jobModel = dependencies.RaceResolutionJobV2 || defaultJobModel;
  const placementJobModel = dependencies.RacePlacementTransitionJob ||
    defaultPlacementJobModel;
  const syncRacePowerupState =
    dependencies.syncRacePowerupState || defaultSyncRacePowerupState;
  const recentBoxMints = dependencies.recentBoxMints || defaultRecentBoxMints;
  const requestStepSyncForUsers =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const nudge = dependencies.nudgeOvertakenRivals || nudgeOvertakenRivals;
  const settings = dependencies.appSettings || defaultAppSettings;
  const logger = dependencies.logger || console;
  const workBudget = dependencies.raceResolutionWorkBudget || defaultWorkBudget;
  const postTaskHandoff =
    dependencies.raceResolutionPostTaskHandoff || defaultPostTaskHandoff;
  const displayArtifactStore =
    dependencies.raceResolutionDisplayArtifact || defaultDisplayArtifactStore;
  const computeFullBoxState =
    dependencies.computeRaceState || defaultComputeRaceState;
  const buildInputFingerprint =
    dependencies.buildRaceResolutionInputFingerprint || defaultBuildInputFingerprint;
  const balanceConfig = dependencies.balanceConfig || defaultBalanceConfig;
  const events = dependencies.eventBus || defaultEventBus;
  const buildStepSyncScope =
    dependencies.buildRaceResolutionStepSyncScope || defaultBuildStepSyncScope;
  const stepSyncScopeMatchesFence =
    dependencies.stepSyncScopeMatchesFence || defaultStepSyncScopeMatchesFence;
  const deliveryIntents =
    dependencies.raceResolutionDeliveryIntents || defaultDeliveryIntents;
  // Injectable planner seam for deterministic parity and failure-fallback tests.
  const buildDependencyClosure =
    dependencies.buildRaceScoringDependencyClosure || defaultBuildDependencyClosure;
  // Production closure planning is permanent. This narrow injection seam keeps
  // the independent FULL-control parity fixtures possible without restoring a
  // runtime setting, cohort, environment switch, or admin control.
  const dependencyClosureEnabled = dependencies.dependencyClosureEnabled ?? true;
  const wouldTrailMineEscalateProbe =
    dependencies.wouldTrailMineEscalate || defaultWouldTrailMineEscalate;
  const now = dependencies.now || (() => new Date());
  const leaseMs = dependencies.leaseMs ?? LEASE_MS;
  const processRole = dependencies.processRole || process.env.STEPS_PROCESS_ROLE || "all";
  const nodeEnv = dependencies.nodeEnv || process.env.NODE_ENV || "development";
  const productionExecutionRole =
    nodeEnv !== "production" ||
    processRole === "resolution" ||
    processRole === "staging_all";
  const monotonicNow = dependencies.monotonicNow || process.hrtime.bigint;
  const wallClockNow = dependencies.wallClockNow || Date.now;
  const sleep = dependencies.sleep || ((delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)));
  const compatibilityPollIntervalMs = Math.max(
    150,
    Math.min(250, Number(dependencies.compatibilityPollIntervalMs) || 250),
  );
  const scheduleTimeout = dependencies.scheduleTimeout || setTimeout;
  const cancelTimeout = dependencies.clearTimeout || clearTimeout;
  const bootId = dependencies.bootId || PROCESS_BOOT_ID;
  const spool = dependencies.operationalAlertSpool || createOperationalAlertSpool();
  const writeAlertMarker = dependencies.writeAlertMarker || ((marker) => {
    spool.writeIncident(marker);
  });
  const emitLiveDiagnostic = dependencies.emitLiveDiagnostic || ((event) => {
    const method = event?.event === "race_resolution_v2_watchdog" ? "error" : "log";
    (logger[method] || logger.log).call(logger, JSON.stringify(event));
  });
  const activeAttempts = new Map();
  let lastTerminalMonotonicAt = null;
  let lastExpiredRunningCount = null;
  let eventLoopDelayMs = 0;
  const processBootMonotonicAt = monotonicNow();
  let eventLoopProbeAt = processBootMonotonicAt;
  const eventLoopProbe = scheduleTimeout(function probeEventLoop() {
    const observed = monotonicNow();
    eventLoopDelayMs = Math.max(0, Number(observed - eventLoopProbeAt) / 1e6 - 1_000);
    eventLoopProbeAt = observed;
    const next = scheduleTimeout(probeEventLoop, 1_000);
    next?.unref?.();
  }, 1_000);
  eventLoopProbe?.unref?.();
  // Phase D owns snapshot/expiry/notification decisions. With durable post
  // tasks enabled it runs in read-only preparation mode before the fence, then
  // its immutable decisions are committed with recordSuccess and executed by
  // the post-task runner. The legacy flag-off path still invokes it only after
  // commit. Durable preparation is independent of Redis availability; only
  // the legacy process-local publish path is gated by Redis standings.
  const onCommitted =
    dependencies.onCommitted ||
    require("../services/raceProgressSideEffects").raceProgressPostCommit;

  const bootAt = dependencies.bootAt ?? Date.now();
  let oldQueueDrainedObserved = false;

  function startupReadiness() {
    const startupQuietPeriodMs = quietPeriodMs();
    const remainingQuietMs = Math.max(0, startupQuietPeriodMs - (Date.now() - bootAt));
    const quietPeriodElapsed = remainingQuietMs === 0;
    const ready = quietPeriodElapsed && oldQueueDrainedObserved;
    return {
      state: ready ? "ready" : quietPeriodElapsed ? "old-queue-handoff" : "startup-quiet",
      ready,
      quietPeriodElapsed,
      oldQueueDrainedObserved,
      quietPeriodMs: startupQuietPeriodMs,
      remainingQuietMs,
      effectiveConcurrency: effectiveResolutionConcurrency(),
    };
  }

  // (a) 60s quiet period after boot AND (b) one observation of the OLD table
  // with zero RUNNING-with-unexpired-lease rows. Once observed, the check is
  // never repeated: pm2 kills old workers within seconds of reload, so a single
  // clean observation proves the old bulk writer is gone. A missing old table
  // (post-contract restart) counts as drained.
  async function readyToClaim(currentTime) {
    if (Date.now() - bootAt < quietPeriodMs()) return false;
    if (oldQueueDrainedObserved) return true;
    try {
      const rows = await prisma.$queryRawUnsafe(
        `
        SELECT 1
        FROM race_resolution_jobs
        WHERE state = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > $1
        LIMIT 1
        `,
        currentTime
      );
      if (rows.length === 0) {
        oldQueueDrainedObserved = true;
        return true;
      }
      return false;
    } catch (error) {
      // 42P01 undefined_table => the old table is gone; nothing to hand off from.
      if (error && (error.code === "42P01" || String(error.message || "").includes("does not exist"))) {
        oldQueueDrainedObserved = true;
        return true;
      }
      logger.error("[RACE_RESOLUTION_V2] old-queue drain check failed:", error);
      return false;
    }
  }

  // ── Claiming kill-switch read cache. ────────────────────────────────────────
  //
  // `claimingDisabled()` runs on EVERY 250ms tick, forever, even with an empty
  // queue — ~345k `appSetting.findUnique` round trips a day on a 1-vCPU box that
  // is ~50% busy, essentially all of them answering "no, still enabled".
  //
  // The read stays UNCACHED in the sense that matters (it never rides the 30s
  // in-process appSettings cache, which is what the rollback drill proves); it
  // is memoized here for a deliberately tiny window instead. Two asymmetries
  // keep the emergency-response intent intact:
  //
  //   1. Only the ENABLED answer (`false`) is cached. A `true` read — the switch
  //      is actively thrown — is never cached, so UN-flipping it resumes claims
  //      on the very next tick, with no delay at all. Only the boring idle
  //      answer is allowed to go stale.
  //   2. The cache is dropped whenever a job is actually claimed. A worker doing
  //      real work re-reads the switch; only a worker idling against an empty
  //      queue coasts on the cached answer, which is exactly the traffic we are
  //      trying to remove.
  //
  // Net worst case for THROWING the switch: CLAIMING_FLAG_TTL_MS of additional
  // claiming on an otherwise-idle worker. Clearing it: unchanged, one tick.
  const CLAIMING_FLAG_TTL_MS = dependencies.claimingFlagTtlMs ?? 2_000;
  let claimingEnabledCachedUntil = 0;

  function invalidateClaimingFlagCache() {
    claimingEnabledCachedUntil = 0;
  }

  async function claimingDisabled() {
    if (Date.now() < claimingEnabledCachedUntil) return false;
    const disabled =
      (await settings.getUncachedFlag("raceQueueV2ClaimingDisabled")) === true;
    claimingEnabledCachedUntil = disabled ? 0 : Date.now() + CLAIMING_FLAG_TTL_MS;
    return disabled;
  }

  // ── The fenced ownership protocol (§5a item 5). Ordering is NOT negotiable. ──
  //
  //   1. claim (elsewhere) mints a fresh lease token
  //   2. run the computation OUTSIDE any transaction, capturing its writes
  //   3. ONE write transaction:
  //        (i)   SELECT ... FOR UPDATE the job row WHERE id AND lease_token.
  //              Zero rows => abort immediately, having written NOTHING.
  //        (ii)  only as the verified lock-holder, write all participant rows,
  //              in ASCENDING userId order (the one global lock order)
  //        (iii) update the job row
  //        commit
  //
  // Fence-THEN-write, never write-then-fence: two workers can never both be
  // mid-flight on participant rows because the loser is turned away at the
  // job-row lock before its first participant write. The held job-row lock also
  // serializes this against raceExpiry, which acquires the same row.
  async function processOneUnbudgeted({ raceId = null } = {}) {
    if (!productionExecutionRole) return null;
    const phaseTimer = createRaceResolutionPhaseTimer(monotonicNow, {
      emit: emitLiveDiagnostic,
      scheduleTimeout,
      clearTimeout: cancelTimeout,
    });
    const currentTime = now();
    if (raceId) {
      // Targeted compatibility work is still C0 claiming. It may bypass the
      // debounce floor, but never the global drain/emergency switch. Drop the
      // short idle-worker cache so a progress request cannot reuse a stale
      // enabled answer after operations has disabled claiming.
      invalidateClaimingFlagCache();
      const disabled = await phaseTimer.measure(
        "claimReadiness",
        claimingDisabled,
      );
      if (disabled) return TARGETED_CLAIM_DISABLED;
    }
    const ready = raceId
      ? true
      : await phaseTimer.measure("claimReadiness", async () => {
          if (await claimingDisabled()) return false;
          return readyToClaim(currentTime);
        });
    if (!ready) return null;

    // Fold append-only large-race intake into one ordinary FULL generation
    // before claiming. The promotion is bounded and SKIP LOCKED, so parallel
    // worker lanes cooperate without making HTTP uploaders contend on the
    // race-keyed job row.
    if (!raceId && typeof jobModel.promoteFullScopeTriggers === "function") {
      await phaseTimer.measure(
        "fullTriggerPromotion",
        () => jobModel.promoteFullScopeTriggers({ now: currentTime }),
      );
    }

    const job = await phaseTimer.measure("claim", () => jobModel.claimNext({
        now: currentTime,
        leaseMs,
        leaseToken: newLeaseToken(),
        raceId,
        force: raceId != null,
    }));
    if (!job) return null;
    const startMs = Date.now();
    const attemptUuid = crypto.randomUUID();
    const attemptId = `${bootId}:${attemptUuid}`;
    let resolutionPlan = "FULL";
    const attempt = {
      attemptId,
      bootId,
      attemptUuid,
      jobId: job.id,
      raceId: job.raceId,
      leaseExpiresAt: job.leaseExpiresAt || null,
      queueLagMs: Math.max(0, startMs - new Date(job.requestedAt).getTime()),
      authoritativeCommitCompleted: false,
    };
    phaseTimer.setAttemptContext({
      attemptId,
      queuePriority: job.processingQueuePriority || "LIVE",
      resolutionPlan: () => resolutionPlan,
    });
    activeAttempts.set(attemptId, { attempt, phaseTimer });
    const watchdog = createRaceResolutionAttemptWatchdog({
      attempt,
      phaseTimer,
      workBudget,
      processRole,
      scheduleTimeout,
      clearTimeout: cancelTimeout,
      emitDiagnostic: emitLiveDiagnostic,
      writeAlertMarker,
      flushDiagnostics: dependencies.flushDiagnostics,
      failStop: dependencies.failStop,
      expiredLeaseCount: dependencies.expiredLeaseCount || (() => lastExpiredRunningCount),
      getSiblingAttempts: () => [...activeAttempts.values()].map(({ attempt: sibling, phaseTimer: timer }) => ({
        attemptId: sibling.attemptId,
        jobId: sibling.jobId,
        raceId: sibling.raceId,
        authoritativeCommitCompleted: sibling.authoritativeCommitCompleted === true,
        ...timer.liveState(),
      })),
    });
    logger.log(JSON.stringify({
      event: "race_resolution_v2_claim",
      schemaVersion: 3,
      observedAt: new Date(startMs).toISOString(),
      attemptId,
      jobId: job.id,
      raceId: job.raceId,
      leaseExpiresAt: job.leaseExpiresAt || null,
      workerPid: process.pid,
      queuePriority: job.processingQueuePriority || "LIVE",
      queueLagMs: Math.max(0, startMs - new Date(job.requestedAt).getTime()),
    }));
    // Real work claimed => stop coasting on the cached kill-switch answer (see
    // CLAIMING_FLAG_TTL_MS). Only idle ticks are allowed to reuse it.
    invalidateClaimingFlagCache();

    try {
    // Mixed-worker safety: old intake advances the scoring generation and
    // enqueues STEP_SYNC without the new ownership stamp. Promote that already
    // queued claim in memory before any committed-scope admission; intake alone
    // owns the stamp, avoiding the scoring-row/queue-row lock inversion.
    await promoteMismatchedCommittedStepSync(job, prisma);

    // Dependency closure is permanent. Ineligible or failed plans still fall
    // back to FULL through the existing correctness path.
    const closureShadow = NULL_CLOSURE_SHADOW_FIELDS;
    // `closurePlan` is non-null ONLY when the permanent planner returned
    // DEPENDENCY_CLOSURE and the Trail-Mine escalation cleared. It is
    // the single gate every closure behavior below reads.
    let closurePlan = null;
    // bool when a closure plan was evaluated, null when the envelope is not
    // candidate-shaped or the planner said FULL.
    let closureEscalatedOnMine = null;
    if (
        dependencyClosureEnabled &&
        (isClosureEligibleReasonSet(job.processingDirtyReasons) ||
          isSourceInputClosureEligibleReasonSet(job.processingDirtyReasons))
      ) {
        try {
            const shadowConfig = await balanceConfig.getSnapshot();
            const shadowResult = await phaseTimer.measure(
              "dependencyClosurePlanner",
              () => buildDependencyClosure({
                raceId: job.raceId,
                dirtyParticipantIds: job.processingDirtyParticipantIds,
                job,
                now: now(),
                Race: raceModel,
                RaceActiveEffect: effectModel,
                RaceParticipant: participantModel,
                balanceConfigVersion: shadowConfig?.version ?? null,
                // ONE fingerprint seam for the whole generation. Without this the
                // planner lazily resolves the shipped module itself while the
                // fence uses this worker's injected dependency — two different
                // code paths computing the digest that must match each other, and
                // a test can only ever see one of them.
                buildInputFingerprint,
              })
            );
            if (
              shadowResult &&
              shadowResult.plan === "DEPENDENCY_CLOSURE"
            ) {
              // ── TRAIL_MINE escalation (spec core rule 3). ────────────────
              //
              // Evaluated HERE — before the resolve, before the fence, before
              // any write — so an escalation costs a plan selection and nothing
              // else. "Zero partial writes" is therefore structural, not a
              // rollback: the closure path is simply never entered.
              //
              // The predicate runs over the full-field projection the planner
              // already assembled from its fingerprint read: fresh totals for
              // closure participants, persisted `total_steps` for every other
              // accepted row. Note the predicate SKIPS closure members outright
              // (they detonate in-closure exactly as FULL would), so the only
              // rows it reads are the non-closure ones — which is precisely why
              // no fresh score is needed to answer it and no second query is
              // issued.
              //
              // Tri-state, and "UNKNOWN" (a legacy pre-2026-08-07 mine with no
              // `aheadParticipantIds` and no pre-generation total) ESCALATES.
              // Answering "no" to a question we did not answer would send the
              // mine to the wrong player — `candidates[0]` is the LOWEST-total
              // crosser — and the mine then EXPIREs, which is unrecoverable.
              let escalate = false;
              if (shadowResult.minesActive === true) {
                try {
                  escalate =
                    wouldTrailMineEscalateProbe({
                      mines: shadowResult.mines,
                      closureIds: shadowResult.scoringParticipantIds ||
                        shadowResult.participantIds,
                      participantTotals: shadowResult.participantTotals,
                    }) !== false;
                } catch {
                  // Fail CLOSED. An unanswerable predicate is an escalation.
                  escalate = true;
                }
              }
              closureEscalatedOnMine = escalate;
              if (!escalate) closurePlan = shadowResult;
            }
        } catch (error) {
            // The duration is still honest and still useful (a timeout is the
            // failure mode worth measuring); every other field stays null. With
            // a planner throw leaves `closurePlan` null, so
            // the job proceeds down the existing FULL path unchanged.
            logger.error(JSON.stringify({
              event: "race_resolution_v2_dependency_closure_error",
              operation: "dependency_closure_planner",
              errorCode: String(error?.code || "DEPENDENCY_CLOSURE_PLANNER_ERROR"),
              // A race id is not user data; without it a failure spike cannot
              // be correlated to the race that provokes it.
              raceId: job.raceId,
            }));
        }
    }

    const triggeringUserIds = Array.isArray(job.processingTriggeredByUserIds)
      ? job.processingTriggeredByUserIds.filter(Boolean)
      : [];
    const orderedTriggeringUserIds = [...new Set(triggeringUserIds)].sort();
    const computePhaseMs = emptyPhaseTotals(RACE_RESOLUTION_COMPUTE_PHASES);
    const computePhaseQueryCaptureEnabled =
      process.env.PRISMA_QUERY_EVENTS_ENABLED === "true";
    const computePhaseQueryCount = computePhaseQueryCaptureEnabled
      ? emptyPhaseTotals(RACE_RESOLUTION_COMPUTE_PHASES)
      : null;
    const nudgePhaseMs = emptyPhaseTotals(RACE_RESOLUTION_NUDGE_PHASES);
    const postHandoffPhaseMs = emptyPhaseTotals(RACE_RESOLUTION_HANDOFF_PHASES);
    const stepSyncScopePhaseMs = { activeEffects: 0, raceHydration: 0 };
    let stepSyncScopeOutcome = "not_attempted";
    let stepSyncScopeActiveEffectCount = 0;
    try {
      // ── Step 2: computation, outside every transaction. ──────────────────
      const reasonAwareEnabled = await phaseTimer.measure(
        "planSettings",
        () => isStrictFlagEnabled(settings, "raceResolutionReasonAwareV1Enabled")
      );
      let baseResolutionPlan = reasonAwareEnabled
        ? resolutionPlanForDirtyReasons(job.processingDirtyReasons)
        : "FULL";
      let result = null;
      let computeMs = 0;
      const bulkWritesEnabled = await phaseTimer.measure(
        "planSettings",
        () => isStrictFlagEnabled(settings, "raceResolutionBulkWriteV1Enabled")
      );
      const burstCoalescingEnabled = await phaseTimer.measure(
        "planSettings",
        () => isStrictFlagEnabled(settings, "raceResolutionBurstCoalescingV1Enabled")
      );
      const postTasksEnabled = await phaseTimer.measure(
        "planSettings",
        () => isStrictFlagEnabled(settings, "raceResolutionPostTasksV1Enabled")
      );
      const atomicPostTaskHandoff = Boolean(
        postTasksEnabled &&
        postTaskHandoff?.supportsAtomicDurableCreate === true &&
        typeof postTaskHandoff.createDurable === "function"
      );
      let superseded = false;
      let placementHandoffGeneration = null;
      let placementHandoffOutcome = "not_applicable";
      let discarded = false;
      let writeMs = 0;
      let participantWrites = [];
      resolutionPlan = baseResolutionPlan;
      let forceFull = false;
      let artifactHit = false;
      let artifactFallbackReason = null;
      // Aggregate count only — how many times a closure was turned away at the
      // fence for this claim. Never an id, a total, or a reason string.
      let closureCommittedRejections = 0;
      let closureFenceRejectionReason = null;
      let sourceInputFenceRejections = 0;
      let activeImpactPersistMs = 0;
      // Source discovery is boundary work, never ordinary score-generation
      // work. STEP_SYNC/FULL/POWERUP_MUTATION runs may still score active
      // effects authoritatively, but they must perform zero v2 materialization
      // reads unless a real time/source boundary was coalesced into the claim.
      let resolveTimedActiveImpacts =
        job.processingDirtyReasons?.includes("EFFECT_BOUNDARY") === true;
      let activeImpactMetrics = {
        created: 0,
        zero: 0,
        suppressed: 0,
        failures: 0,
        durationMs: 0,
      };
      let committedBoxSyncResults = [];
      let committedPowerupEvents = [];
      let committedPostTaskId = null;

      for (;;) {
        let artifactPayload = null;
        let stepSyncScope = null;
        let capture = null;
        let sourceInputFingerprint = null;
        let sourceInputTerminal = false;
        const sourceInputWork = containsSourceInputWork(
          job.processingDirtyReasons
        );
        if (sourceInputWork) {
          if (!forceFull && closurePlan?.graphFingerprint && closurePlan?.validUntil) {
            // The closure planner already captured the exact canonical input
            // fingerprint. Source-input fencing intentionally shares it so a
            // closure claim has one candidate read and one fence revalidation.
            sourceInputFingerprint = {
              digest: closurePlan.graphFingerprint,
              plannedAgainstGeneration: Number(job.processingGeneration),
              validUntil: closurePlan.validUntil,
              balanceConfigVersion: closurePlan.balanceConfigVersion,
            };
          } else {
            const config = await balanceConfig.getSnapshot();
            const capturedAt = now();
            const fingerprint = await buildInputFingerprint({
              raceId: job.raceId,
              now: capturedAt,
              balanceConfigVersion: config.version,
            });
            const validUntil = fingerprint && computeArtifactReuseDeadline({
              asOf: capturedAt,
              timeZone: fingerprint.race?.timezone || job.processingTimeZone || "UTC",
              raceEndsAt: fingerprint.race?.endsAt || null,
              nextSampleBoundary: fingerprint.nextSampleBoundary,
              activeEffects: fingerprint.activeEffects,
              globalEvents: fingerprint.globalEvents,
            });
            sourceInputTerminal = sourceInputTargetIsTerminal(
              fingerprint,
              job.processingTriggeredByUserIds,
              capturedAt
            );
            sourceInputFingerprint = fingerprint?.digest && (validUntil || sourceInputTerminal) ? {
                digest: fingerprint.digest,
                plannedAgainstGeneration: Number(job.processingGeneration),
                validUntil,
                balanceConfigVersion: config.version,
              } : null;
          }
          if (!sourceInputFingerprint?.digest) {
            const error = new Error("source-input fingerprint unavailable");
            error.code = "SOURCE_INPUT_SNAPSHOT_UNAVAILABLE";
            throw error;
          }
        }
        const artifactEnabled = !forceFull && await phaseTimer.measure(
          "planSettings",
          () => isStrictFlagEnabled(
            settings,
            "raceResolutionDisplayArtifactReuseV1Enabled"
          )
        );
        await phaseTimer.measure("artifactLookup", async () => {
          if (
            artifactEnabled &&
            job.processingDisplayArtifactId &&
            baseResolutionPlan === "FULL"
          ) {
            const loaded = await displayArtifactStore.load({
              id: job.processingDisplayArtifactId,
              digest: job.processingDisplayArtifactDigest,
              schema: job.processingDisplayArtifactSchema,
              raceId: job.raceId,
              timeZone: job.processingTimeZone || "UTC",
            });
            if (!loaded) {
              artifactFallbackReason = "load_or_envelope_mismatch";
            } else if (!artifactMatchesClaim(loaded, job)) {
              artifactFallbackReason = "claim_mismatch";
            } else {
              const config = await balanceConfig.getSnapshot();
              const fingerprint = await buildInputFingerprint({
                raceId: job.raceId,
                now: now(),
                balanceConfigVersion: config.version,
              });
              if (
                fingerprint?.digest === loaded.inputFingerprint &&
                String(config.version ?? "code-default") ===
                  String(loaded.balanceConfigVersion ?? "code-default")
              ) {
                artifactPayload = loaded;
              } else {
                artifactFallbackReason = "input_or_config_mismatch";
              }
            }
          }
        });

        if (artifactPayload && baseResolutionPlan === "FULL") {
          const boxUsers = artifactPayload.result?.boxEffectiveStepsByUser || {};
          const missingFullBoxTotal = (artifactPayload.result?.race?.participants || [])
            .some((participant) =>
              participant.status === "ACCEPTED" &&
              !participant.finishedAt &&
              !participant.forfeitedAt &&
              !Object.hasOwn(boxUsers, participant.userId)
            );
          if (missingFullBoxTotal) {
            // Existing display artifacts intentionally carry box progress only
            // for their viewer. Preserve their canonical score/write reuse,
            // but supplement the FULL recovery envelope with one canonical
            // all-eligible box computation so a non-viewer cannot be stranded.
            const supplemental = await computeFullBoxState({
              raceId: job.raceId,
              timeZone: job.processingTimeZone || "UTC",
              userIds: [],
              includeAllAcceptedBoxUsers: true,
            });
            if (!supplemental?.result?.boxEffectiveStepsByUser) {
              artifactPayload = null;
              artifactFallbackReason = "full_box_scope_missing";
            } else {
              artifactPayload.result.boxEffectiveStepsByUser = {
                ...boxUsers,
                ...supplemental.result.boxEffectiveStepsByUser,
              };
            }
          }
        }

        if (artifactPayload) {
          resolutionPlan = "ARTIFACT_REUSE";
          capture = { writes: artifactPayload.writes };
          result = artifactPayload.result;
        } else {
          resolutionPlan = baseResolutionPlan;
          capture = createWriteCapture({ participantModel, effectModel, eventModel });
          result = null;
          if (
            !forceFull &&
            reasonAwareEnabled &&
            resolutionPlan === "FULL"
          ) {
            stepSyncScope = await phaseTimer.measure(
              "stepSyncScope",
              () => buildStepSyncScope(job, {
                Race: raceModel,
                RaceActiveEffect: effectModel,
                // The independent FULL-control seam intentionally disables
                // all optimized planners. Production keeps this true because
                // dependency closure and incremental STEP_SYNC are both
                // permanent correctness-preserving paths.
                allowIncrementalEffects: dependencyClosureEnabled === true,
                recordDiagnostics: (diagnostics) => {
                  stepSyncScopeOutcome = diagnostics?.outcome || "unknown";
                  stepSyncScopeActiveEffectCount = Math.max(
                    0,
                    Number(diagnostics?.activeEffectCount) || 0
                  );
                  for (const name of Object.keys(stepSyncScopePhaseMs)) {
                    const value = Number(diagnostics?.phaseMs?.[name]);
                    if (Number.isFinite(value)) {
                      stepSyncScopePhaseMs[name] += Math.max(0, value);
                    }
                  }
                },
              })
            );
          }
          if (stepSyncScope) {
            if (stepSyncScope.plan === "STEP_SYNC_INCREMENTAL") {
              const computeStartedAt = Date.now();
              const computeResolve = buildResolveRaceState({
                Race: raceModel,
                RaceParticipant: capture.participants,
                RaceActiveEffect: capture.effects,
                RacePowerupEvent: capture.events,
                now,
                activeImpactEnabled: resolveTimedActiveImpacts,
                recordPhaseTiming: (name, durationMs) =>
                  addPhaseTiming(computePhaseMs, name, durationMs),
              });
              const processed = await phaseTimer.measure(
                "compute",
                () => computeResolve({
                  raceId: job.raceId,
                  userIds: triggeringUserIds,
                  timeZone: job.processingTimeZone || "UTC",
                  scoreParticipantIds: stepSyncScope.scoreParticipantIds,
                })
              );
              result = Array.isArray(processed) ? processed[0] : null;
              computeMs += Math.max(0, Date.now() - computeStartedAt);
              resolutionPlan = "STEP_SYNC_INCREMENTAL";
            } else {
              resolutionPlan = stepSyncScope.plan;
              result = stepSyncScope.result;
            }
          } else if (resolutionPlan === "FULL") {
            // Precedence (spec rule 1): artifact → cheap committed scope →
            // closure → FULL. `forceFull` (the retry loop's second pass, and the
            // path a rejected fence takes) disables the closure exactly as it
            // disables the artifact, so a rejected closure can never be retried
            // as another closure.
            //
            // The cheap STEP_SYNC_COMMITTED scope above stays ahead of the
            // closure deliberately: it fires only on a race with ZERO active
            // effects, where the closure would compute the same rows for more
            // work. Nothing shipped changes ordering here.
            const useClosure = !forceFull && closurePlan != null;
            const computeStartedAt = Date.now();
            const computeResolve = buildResolveRaceState({
              Race: raceModel,
              RaceParticipant: capture.participants,
              RaceActiveEffect: capture.effects,
              RacePowerupEvent: capture.events,
              now,
              activeImpactEnabled: resolveTimedActiveImpacts,
              ...(dependencies.prefetchRaceScoringModels
                ? { prefetchRaceScoringModels: dependencies.prefetchRaceScoringModels }
                : {}),
              recordPhaseTiming: (name, durationMs) =>
                addPhaseTiming(computePhaseMs, name, durationMs),
              ...(computePhaseQueryCaptureEnabled
                ? {
                    recordPhaseQueryCount: (name, count) =>
                      addPhaseCount(computePhaseQueryCount, name, count),
                  }
                : {}),
            });
            const processed = await phaseTimer.measure(
              "compute",
              () => computeResolve({
                raceId: job.raceId,
                userIds: triggeringUserIds,
                timeZone: job.processingTimeZone || "UTC",
                // Additive and null on every non-closure run, so the FULL path is
                // byte-for-byte what it was.
                ...(useClosure
                  ? { scoreParticipantIds:
                    closurePlan.scoringParticipantIds || closurePlan.participantIds }
                  : { includeAllAcceptedBoxUsers: true }),
              })
            );
            if (computePhaseQueryCount) {
              computePhaseQueryCount.activeImpactAttribution =
                computePhaseQueryCount.activeTimedImpactAttribution +
                computePhaseQueryCount.activeDefenseImpactAttribution;
            }
            result = Array.isArray(processed) ? processed[0] : null;
            computeMs += Math.max(0, Date.now() - computeStartedAt);
            // Only after a result actually came back: a null result means the
            // race was skipped (settled/ended) and no plan was executed.
            if (useClosure && result) resolutionPlan = "DEPENDENCY_CLOSURE";
          }
        }

        const stopPrepareWrites = phaseTimer.start("prepareWrites");
        let sideWrites = [];
        try {
        const userIdByParticipant = new Map();
        for (const participant of result?.race?.participants || []) {
          userIdByParticipant.set(participant.id, participant.userId);
        }
        const sortKey = (write) =>
          `${userIdByParticipant.get(write.participantId) ?? "￿"}:${write.participantId}`;
        const participantById = new Map(
          (result?.race?.participants || []).map((participant) => [
            participant.id,
            participant,
          ])
        );
        const candidateParticipantWrites = capture.writes.filter(
          (write) => write.kind === "participantTotal" || write.kind === "participantBonus"
        );
        const participantsWithBonusWrites = new Set(
          candidateParticipantWrites
            .filter((write) => write.kind === "participantBonus")
            .map((write) => write.participantId),
        );
        // A penalty capture may first restore a sample-less legacy snapshot.
        // Retain every total for that participant so normalization's last-total
        // rule supplies the penalty's intended base instead of an earlier zero.
        participantWrites = retainTeamAsOfHeartbeat(
          candidateParticipantWrites,
          candidateParticipantWrites.filter((write) =>
            participantTotalWriteChangesRow(
              write,
              participantById.get(write.participantId),
            ) || (
              write.kind === "participantTotal" &&
              participantsWithBonusWrites.has(write.participantId)
            )
          ),
          result?.race?.isTeamRace === true
        ).sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
        sideWrites = capture.writes.filter(
          (write) => write.kind === "effectUpdate" || write.kind === "eventCreate"
        );
        } finally {
          stopPrepareWrites();
        }

        // Decide every stateful post-commit action before entering the write
        // transaction.  The decision functions only read the computed result;
        // cooldown claims and immutable outbox rows are resolved below inside
        // the same fenced transaction as recordSuccess.
        let preparedSnapshotCommand = null;
        const preparedIntentClaims = [];
        if (atomicPostTaskHandoff) {
          const stopPostCommitPrepare = phaseTimer.start("postCommitHook");
          try {
            const prepared = await onCommitted({
              raceId: job.raceId,
              job,
              result,
              superseded: false,
              deferEffectExpiry: true,
              deferSnapshot: true,
              deferDelivery: true,
              prepareOnly: true,
              recoverEffectExpiry: resolveTimedActiveImpacts,
            });
            preparedSnapshotCommand = prepared?.snapshotCommand || null;
            if (Array.isArray(prepared?.intentClaims)) {
              preparedIntentClaims.push(...prepared.intentClaims);
            }
          } catch (error) {
            logger.error("[RACE_RESOLUTION_V2] post-commit preparation error:", error);
            throw error;
          } finally {
            stopPostCommitPrepare();
          }

          if (result && preparedSnapshotCommand) {
            const nudgeBatchEnabled = await phaseTimer.measure(
              "postSettings",
              () => isStrictFlagEnabled(settings, "raceResolutionNudgeBatchV1Enabled")
            );
            const stopOvertakeNudges = phaseTimer.start("overtakeNudges");
            const nudgeTriggerGroups = nudgeBatchEnabled
              ? [orderedTriggeringUserIds]
              : orderedTriggeringUserIds.map((id) => [id]);
            try {
              for (const nudgeTriggerIds of nudgeTriggerGroups) {
                await nudge({
                  raceResults: [result],
                  userId: nudgeTriggerIds[0] || null,
                  ...(nudgeBatchEnabled ? {
                    userIds: nudgeTriggerIds,
                    participantWrites,
                    preferHydratedRoster: true,
                  } : {}),
                  participantModel,
                  recordPhaseTiming: (name, durationMs) =>
                    addPhaseTiming(nudgePhaseMs, name, durationMs),
                  requestStepSyncForUsers: async (recipientIds) => {
                    preparedIntentClaims.push({
                      kind: "STEP_SYNC",
                      recipientIds: [...new Set(recipientIds || [])],
                      raceId: job.raceId,
                      sourceGeneration: job.processingGeneration,
                      deliveryKind: "NUDGE",
                    });
                  },
                });
              }
            } catch (error) {
              logger.error("[RACE_RESOLUTION_V2] overtake nudge preparation error:", error);
              throw error;
            } finally {
              stopOvertakeNudges();
            }
          }
          if (result && !preparedSnapshotCommand) {
            const preparationError = new Error("durable post-task command was not prepared");
            preparationError.code = "POST_TASK_PREPARE_FAILED";
            throw preparationError;
          }
        }

        // Concurrency-test seam: lets an integration synchronize a real late
        // HTTP step upload after generation capture but before the C0 fence.
        // Production never injects it.
        if (typeof dependencies.beforeWriteTransaction === "function") {
          await dependencies.beforeWriteTransaction({ job, result });
        }

        // ── Step 3: the ONE write transaction. ─────────────────────────────
        let artifactRejectedAtFence = false;
        let stepSyncRejectedAtFence = false;
        let closureRejectedAtFence = false;
        let sourceInputRejectedAtFence = false;
        const closureCommitting = resolutionPlan === "DEPENDENCY_CLOSURE";
        const writeStartedAt = Date.now();
        const attemptedBoxSyncResults = [];
        const attemptedPowerupEvents = [];
        let attemptedPostTaskId = null;
        await phaseTimer.measure("transaction", () => prisma.$transaction(async (tx) => {
        // (i) fence
        const fenced = await phaseTimer.measure(
          "fenceAcquire",
          () => jobModel.acquireForWrite(tx, {
            id: job.id,
            expectedLeaseToken: job.leaseToken,
          })
        );
        if (!fenced) throw new FenceLostError();

        // A newer all-COALESCE generation already owns the follow-up work. If
        // this race completed recently, discard the stale claim before any
        // narrow-scope/artifact/source fence can demote it to a full replay.
        // No participant write has occurred yet, and discardSuperseded merges
        // the claimed scope back into the queued generation atomically.
        if (
          burstCoalescingEnabled &&
          supersededRunMayDiscard(fenced, now()) &&
          typeof jobModel.discardSuperseded === "function"
        ) {
          const outcome = await phaseTimer.measure(
            "discardSuperseded",
            () => jobModel.discardSuperseded(
              { id: job.id, leaseToken: job.leaseToken, now: now() },
              tx
            )
          );
          if (outcome.applied) {
            discarded = true;
            return;
          }
        }

        const stopFenceValidation = phaseTimer.start("fenceValidation");
        try {
        let sourceFenceNow = null;
        let sourceFenceConfig = null;
        let sourceFenceFingerprint = null;
        if (sourceInputWork && !closureCommitting) {
          const dbClock = await tx.$queryRawUnsafe(
            `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8
               AS "dbNowMs"`
          );
          sourceFenceNow = new Date(Number(dbClock[0]?.dbNowMs));
          sourceFenceConfig = await balanceConfig.getSnapshot();
          sourceFenceFingerprint = await buildInputFingerprint({
            raceId: job.raceId,
            now: sourceFenceNow,
            balanceConfigVersion: sourceFenceConfig.version,
            client: tx,
          });
          const deadline = sourceInputFingerprint?.validUntil
            ? new Date(sourceInputFingerprint.validUntil).getTime()
            : null;
          if (
            !sourceInputFingerprint ||
            !sourceFenceFingerprint ||
            sourceFenceFingerprint.digest !== sourceInputFingerprint.digest ||
            Number(fenced.generation) !==
              Number(sourceInputFingerprint.plannedAgainstGeneration) ||
            String(sourceFenceConfig.version ?? "code-default") !==
              String(sourceInputFingerprint.balanceConfigVersion ?? "code-default") ||
            (deadline != null &&
              (!Number.isFinite(deadline) || sourceFenceNow.getTime() >= deadline))
          ) {
            sourceInputRejectedAtFence = true;
            return;
          }
        }
        if (artifactPayload) {
          const currentConfig = await balanceConfig.getSnapshot();
          const fingerprint = await buildInputFingerprint({
            raceId: job.raceId,
            now: now(),
            balanceConfigVersion: currentConfig.version,
            client: tx,
          });
          if (
            Number(fenced.generation) !== Number(fenced.processingGeneration) ||
            !artifactMatchesClaim(artifactPayload, fenced) ||
            fingerprint?.digest !== artifactPayload.inputFingerprint ||
            String(currentConfig.version ?? "code-default") !==
              String(artifactPayload.balanceConfigVersion ?? "code-default") ||
            !(await rebindArtifactPresentation(tx, artifactPayload))
          ) {
            artifactRejectedAtFence = true;
            return;
          }
        }

        if (stepSyncScope) {
          const generationIsCurrent =
            Number(fenced.generation) === Number(fenced.processingGeneration);
          const inputsStillMatch = generationIsCurrent &&
            await stepSyncScopeMatchesFence(stepSyncScope, tx, job.raceId);
          if (!inputsStillMatch) {
            stepSyncRejectedAtFence = true;
            return;
          }
        }

        // ── Closure fence re-verify (spec rule 7). ─────────────────────────
        //
        // Atomic, inside the SAME transaction that holds the job row, and
        // strictly BEFORE the first participant write. Any mismatch returns
        // having written nothing and retries the generation as FULL — a stale
        // closure is never committed.
        //
        // ONE re-read covers the required scoring checks, because
        // `buildRaceResolutionInputFingerprint` already digests all of them:
        // the graph (active effects + the schema-2 EXPIRED LEECH/HITCHHIKE
        // rows), MEMBERSHIP (every participant row, so a join/leave/forfeit or
        // an accepted-status change moves the digest), the accepted members'
        // `user_scoring_input_versions.generation`, and the race row itself.
        // Re-deriving those separately would be a second fingerprint
        // implementation, which rule 7 prohibits.
        //
        // The remaining conditions are checked explicitly:
        //   * job generation — a newer generation arrived, so this plan was
        //     computed against a superseded dirty set;
        //   * the closure's exclusive validity deadline — a boundary the
        //     planner could SEE may now have crossed. `validUntil` is a
        //     NECESSARY condition only; the digest above is what makes the
        //     write safe, and it stays mandatory inside the window.
        //   * durable global-boundary delivery is current. A missing cursor or
        //     any due-but-undelivered start/end edge forces FULL.
        if (closureCommitting) {
          const dbClock = sourceFenceNow ? null : await tx.$queryRawUnsafe(
            `SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8
               AS "dbNowMs"`
          );
          const fenceNow = sourceFenceNow ||
            new Date(Number(dbClock[0]?.dbNowMs));
          const currentConfig = sourceFenceConfig ||
            await balanceConfig.getSnapshot();
          const fingerprint = sourceFenceFingerprint ||
            await buildInputFingerprint({
              raceId: job.raceId,
              now: fenceNow,
              balanceConfigVersion: currentConfig.version,
              client: tx,
            });
          const deadline = closurePlan.validUntil
            ? new Date(closurePlan.validUntil).getTime()
            : null;
          const currentClosureFingerprint = fingerprint
            ? buildClosureFingerprintDigest(fingerprint, {
              participantIds: closurePlan.participantIds,
              minesActive: closurePlan.minesActive,
              balanceConfigVersion: currentConfig.version,
            })
            : null;
          const legacyBoundaryRequiresCursor =
            (fingerprint?.globalEvents || []).some(
              (event) => event?.scheduleMode === "LEGACY_GLOBAL",
            );
          const rejectionReason =
            !fingerprint ? "fingerprint_unavailable" :
            currentClosureFingerprint !== closurePlan.closureFingerprint
              ? "scoped_fingerprint_changed" :
            legacyBoundaryRequiresCursor &&
              fingerprint.globalBoundaryScheduleCurrent !== true
              ? "global_boundary_cursor_stale" :
            deadline == null || !Number.isFinite(deadline) ||
              !Number.isFinite(fenceNow.getTime()) || fenceNow.getTime() >= deadline
              ? "validity_deadline_crossed" :
            dueExpiryOutsideClosureAtFence(
              fingerprint.activeEffects,
              closurePlan.participantIds,
              fenceNow,
            ) ? "due_effect_outside_closure" : null;
          if (rejectionReason) {
            closureFenceRejectionReason = rejectionReason;
            closureRejectedAtFence = true;
            return;
          }
        }

        } finally {
          stopFenceValidation();
        }

        // Acquire every triggering participant advisory lock in the same
        // user-id/participant-id order used by standalone rollPowerup, before
        // the first participant-row write. This removes the worker/standalone
        // lock inversion and makes box consequences part of the race fence.
        const boxByUser = result?.boxEffectiveStepsByUser || {};
        const fullBoxScope =
          resolutionPlan === "FULL" || resolutionPlan === "ARTIFACT_REUSE";
        const boxScopeUserIds = fullBoxScope
          ? Object.keys(boxByUser).sort()
          : orderedTriggeringUserIds;
        const boxCandidates = boxScopeUserIds.length > 0
          ? await tx.raceParticipant.findMany({
              where: {
                raceId: job.raceId,
                userId: { in: boxScopeUserIds },
                status: "ACCEPTED",
                race: { status: "ACTIVE" },
              },
              select: {
                id: true,
                userId: true,
                nextBoxAtSteps: true,
                powerupSlots: true,
              },
              orderBy: [{ userId: "asc" }, { id: "asc" }],
            })
          : [];
        // FULL recovery can preselect against the bulk cursor read because the
        // canonical roll path only advances nextBoxAtSteps: a not-yet-due row
        // cannot become due concurrently. Keep incremental scope behavior
        // unchanged, then recheck every selected FULL cursor after row locks.
        const initiallySelectedBoxCandidates = boxCandidates.filter((participant) =>
          !fullBoxScope || (
            participant.nextBoxAtSteps > 0 &&
            Number(boxByUser[participant.userId]) >= participant.nextBoxAtSteps
          )
        );
        // Ordinary rolls use this advisory key. Acquire it only for preselected
        // box candidates and in the same stable user/id order as their bulk
        // read; a zero-due 477-person FULL run therefore takes zero advisory
        // round trips.
        for (const participant of initiallySelectedBoxCandidates) {
          await tx.$executeRawUnsafe(
            "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
            participant.id
          );
        }
        // Fanny/usePowerup and forfeiture serialize on participant rows. Lock
        // the union of box candidates and score writes once in database
        // user/id order before either write path runs. This prevents a narrow
        // job from taking later box row P2 and subsequently waiting on earlier
        // score row P1 while a request holds P1 and waits on P2.
        const participantRowLockIds = [...new Set([
          ...initiallySelectedBoxCandidates.map((participant) => participant.id),
          ...participantWrites.map((write) => write.participantId),
        ])];
        const lockedParticipantRows = participantRowLockIds.length > 0
          ? await tx.$queryRawUnsafe(
              `SELECT id,
                      user_id AS "userId",
                      next_box_at_steps AS "nextBoxAtSteps",
                      powerup_slots AS "powerupSlots",
                      status,
                      forfeited_at AS "forfeitedAt"
                 FROM race_participants
                WHERE id = ANY($1::text[])
                ORDER BY user_id, id
                FOR UPDATE`,
              participantRowLockIds,
            )
          : [];
        const lockedParticipantById = new Map(
          lockedParticipantRows.map((participant) => [participant.id, participant]),
        );
        const selectedBoxCandidates = initiallySelectedBoxCandidates
          .map((participant) => lockedParticipantById.get(participant.id))
          .filter((participant) => participant &&
          String(participant.status || "").toUpperCase() === "ACCEPTED" &&
          participant.forfeitedAt == null &&
          (!fullBoxScope || (
            participant.nextBoxAtSteps > 0 &&
            Number(boxByUser[participant.userId]) >= participant.nextBoxAtSteps
          ))
        );
        const boxInventoryRows = selectedBoxCandidates.length > 0
          ? await tx.racePowerup.findMany({
              where: { participantId: { in: selectedBoxCandidates.map((row) => row.id) } },
              select: {
                id: true,
                participantId: true,
                status: true,
                earnedAtSteps: true,
                createdAt: true,
              },
              orderBy: [{ participantId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
            })
          : [];
        const inventoryByParticipant = new Map();
        for (const box of boxInventoryRows) {
          if (!inventoryByParticipant.has(box.participantId)) {
            inventoryByParticipant.set(box.participantId, []);
          }
          inventoryByParticipant.get(box.participantId).push(box);
        }
        const preloadedBoxState = new Map(selectedBoxCandidates.map((participant) => [
          participant.id,
          {
            nextBoxAtSteps: participant.nextBoxAtSteps,
            powerupSlots: participant.powerupSlots,
            status: String(participant.status || "").toUpperCase(),
            forfeitedAt: participant.forfeitedAt,
            inventory: inventoryByParticipant.get(participant.id) || [],
          },
        ]));

        // (ii) participant rows, ascending userId
        await phaseTimer.measure("participantWrites", async () => {
          if (bulkWritesEnabled) {
            await writeParticipantsBulk(tx, participantWrites, now());
          } else for (const write of participantWrites) {
            if (write.kind === "participantTotal") {
              await tx.raceParticipant.update({
                where: { id: write.participantId },
                data: {
                  totalSteps: Math.max(0, write.totalSteps),
                  totalsUpdatedAt: now(),
                  // The RAW walked total (2026-08-09). Same row, same UPDATE,
                  // same fence, same ascending-userId ordering — no new writer
                  // and no extra statement. The captured value is already
                  // high-watered against the stored one. Omitted (never nulled)
                  // when the capture carries none, so a caller without a raw
                  // figure can't blank a healed row.
                  ...(typeof write.rawSteps === "number" &&
                  Number.isFinite(write.rawSteps)
                    ? { rawSteps: write.rawSteps }
                    : {}),
                },
              });
            } else {
              await tx.$executeRaw`
                WITH current AS (
                  SELECT id,
                         GREATEST(0, total_steps) AS repaired_total,
                         GREATEST(0, -total_steps) AS overkill
                    FROM race_participants
                   WHERE id = ${write.participantId}
                   FOR UPDATE
                ), penalty AS (
                  SELECT id, repaired_total, overkill,
                         LEAST(${write.amount}, repaired_total) AS actual_penalty
                    FROM current
                )
                UPDATE race_participants participant
                   SET total_steps = penalty.repaired_total - penalty.actual_penalty,
                       bonus_steps = participant.bonus_steps + penalty.overkill - penalty.actual_penalty,
                       totals_updated_at = ${now()}
                  FROM penalty
                 WHERE participant.id = penalty.id
              `;
            }
          }
        });

        // Trail-mine bookkeeping (effect status + feed row) rides the same
        // transaction, so a detonation is all-or-nothing with the totals it
        // adjusted. Fire-once serialization comes free from the fence.
        await phaseTimer.measure("sideWrites", async () => {
          for (const write of sideWrites) {
            if (write.kind === "effectUpdate") {
              await tx.raceActiveEffect.update({
                where: { id: write.id },
                data: write.fields,
              });
            } else {
              await tx.racePowerupEvent.create({ data: write.data });
            }
          }
        });

        // V2 consequence events are part of the authoritative C0 commit. The
        // source transition, shared feed row, score consequence, and private
        // event therefore roll back and retry as one unit.
        const activeImpactPersistStartedAt = process.hrtime.bigint();
        let impactContinuationNeeded = false;
        let umbrellaContinuationNeeded = false;
        try {
          const persisted = await persistResolvedImpactEventsV2({
            tx,
            raceId: job.raceId,
            result,
          });
          activeImpactMetrics.created += persisted.insertedCount;
          const umbrella = shouldResolveUmbrellaImpacts(job)
            ? await resolveDueUmbrellaInterceptionsV2({
                tx,
                raceId: job.raceId,
                currentTime,
              })
            : { sourceCount: 0, insertedCount: 0, hasMore: false };
          activeImpactMetrics.created += umbrella.insertedCount;
          umbrellaContinuationNeeded = umbrella.hasMore;
          impactContinuationNeeded =
            umbrella.hasMore ||
            result?.activeImpactCapture?.hasMoreTimedSources === true;
          await persistCapturedSummaryImpactsForRace(tx, {
            raceId: job.raceId,
            sourceResolutionGeneration: job.processingGeneration,
            now: currentTime,
          });
        } finally {
          activeImpactPersistMs += Math.max(
            0,
            Number(process.hrtime.bigint() - activeImpactPersistStartedAt) / 1e6
          );
        }

        // Durable box consequences happen before job success in the same
        // transaction. A box failure therefore rolls back participant totals,
        // effect writes, box rows, thresholds, feed rows, and recordSuccess.
        await phaseTimer.measure("boxConsequences", async () => {
          if (result) {
            for (const participant of selectedBoxCandidates) {
              const syncResult = await syncRacePowerupState({
                raceId: result.raceId,
                userId: participant.userId,
                race: result.race,
                boxEffectiveSteps: boxByUser[participant.userId] ?? null,
                tx,
                advisoryLockHeld: true,
                pendingEvents: attemptedPowerupEvents,
                preloadedState: preloadedBoxState.get(participant.id),
              });
              attemptedBoxSyncResults.push({
                userId: participant.userId,
                syncResult,
              });
            }
          }
        });

        // (iii) job row
        const outcome = await phaseTimer.measure(
          "recordSuccess",
          () => jobModel.recordSuccess(
            {
              id: job.id,
              leaseToken: job.leaseToken,
              processingGeneration: job.processingGeneration,
              now: now(),
              ...(impactContinuationNeeded ? { debounceMs: 0 } : {}),
            },
            tx
          )
        );
        if (!outcome.applied) throw new FenceLostError();
        if (!outcome.superseded) {
          const placementJob = await phaseTimer.measure(
            "placementHandoff",
            () => placementJobModel.enqueueCurrentGeneration({
              raceId: job.raceId,
              generation: job.processingGeneration,
              observedAt: currentTime,
              now: now(),
            }, tx),
          );
          if (!placementJob) {
            const handoffError = new Error("placement handoff was not persisted");
            handoffError.code = "PLACEMENT_HANDOFF_FAILED";
            throw handoffError;
          }
          placementHandoffGeneration = job.processingGeneration;
          placementHandoffOutcome =
            placementJob.requestedGeneration === job.processingGeneration
              ? "queued"
              : "merged";
        } else {
          placementHandoffOutcome = "superseded_skip";
        }
        if (impactContinuationNeeded) {
          await jobModel.enqueue({
            raceId: job.raceId,
            now: now(),
            dirtyEnvelope: {
              reason: "EFFECT_BOUNDARY",
              dirtyUserIds: [],
              dirtyParticipantIds: [],
              powerupTypes: umbrellaContinuationNeeded ? ["UMBRELLA"] : [],
              priority: "IMMEDIATE",
            },
          }, tx);
        }
        if (atomicPostTaskHandoff && preparedSnapshotCommand) {
          const resolveIntents = async (client) => {
            const resolved = [];
            for (const claim of preparedIntentClaims) {
              if (claim?.kind === "HIGH_MULTIPLIER") {
                resolved.push(...await deliveryIntents.claimHighMultiplier(claim.data, {
                  sourceGeneration: claim.sourceGeneration,
                  client,
                  participantClaim: claim.participantClaim,
                }));
              } else if (claim?.kind === "HIGH_MULTIPLIER_REARM") {
                await deliveryIntents.rearmHighMultiplier({
                  participantId: claim.participantId,
                  expectedNotifiedAt: claim.expectedNotifiedAt,
                  client,
                });
              } else if (claim?.kind === "STEP_SYNC") {
                resolved.push(...await deliveryIntents.claimStepSync(claim.recipientIds, {
                  raceId: claim.raceId,
                  sourceGeneration: claim.sourceGeneration,
                  kind: claim.deliveryKind,
                  client,
                }));
              }
            }
            return resolved;
          };
          const durableTask = await phaseTimer.measure(
            "postTaskHandoff",
            () => postTaskHandoff.createDurable({
              raceId: job.raceId,
              sourceGeneration: job.processingGeneration,
              snapshotCommand: preparedSnapshotCommand,
              intents: [],
              resolveIntents,
              fastHandoff: false,
              recordPhaseTiming: (name, durationMs) =>
                addPhaseTiming(postHandoffPhaseMs, name, durationMs),
            }, tx),
          );
          if (!durableTask?.id) {
            const handoffError = new Error("durable post-task handoff was not persisted");
            handoffError.code = "POST_TASK_HANDOFF_FAILED";
            throw handoffError;
          }
          attemptedPostTaskId = durableTask.id;
        }
        superseded = outcome.superseded;
        committedBoxSyncResults = attemptedBoxSyncResults;
        committedPowerupEvents = attemptedPowerupEvents;
        },
      // Only short writes run inside the fence (the expensive replay already
      // happened outside it), but a large field is still N row updates — give it
      // headroom past Prisma's 5s default so a big race can never be aborted
      // mid-write by a transaction timeout.
        { timeout: 15_000, maxWait: 10_000 }));
        writeMs += Math.max(0, Date.now() - writeStartedAt);
        if (
          !discarded &&
          !artifactRejectedAtFence &&
          !stepSyncRejectedAtFence &&
          !closureRejectedAtFence &&
          !sourceInputRejectedAtFence
        ) {
          attempt.authoritativeCommitCompleted = true;
          committedPostTaskId = attemptedPostTaskId;
          if (typeof dependencies.afterAuthoritativeCommit === "function") {
            await dependencies.afterAuthoritativeCommit({ job, result });
          }
        }

        if (artifactRejectedAtFence) {
          artifactFallbackReason = "fence_mismatch";
          forceFull = true;
          await displayArtifactStore.consume(job.processingDisplayArtifactId);
          continue;
        }
        if (stepSyncRejectedAtFence) {
          forceFull = true;
          continue;
        }
        if (closureRejectedAtFence) {
          // The graph, membership, an input generation, the job generation, or
          // the validity deadline moved under us. Nothing was written (the fence
          // returned before the first participant UPDATE). Retry the SAME
          // generation as FULL, which commits the current full state.
          closureCommittedRejections += 1;
          const refreshed = typeof jobModel.refreshClaim === "function"
            ? await jobModel.refreshClaim({
                id: job.id,
                leaseToken: job.leaseToken,
                processingDirtyReasons: job.processingDirtyReasons,
                now: now(),
              })
            : null;
          if (!refreshed) throw new FenceLostError();
          Object.assign(job, refreshed);
          baseResolutionPlan = reasonAwareEnabled
            ? resolutionPlanForDirtyReasons(job.processingDirtyReasons)
            : "FULL";
          resolveTimedActiveImpacts =
            job.processingDirtyReasons?.includes("EFFECT_BOUNDARY") === true;
          closurePlan = null;
          forceFull = true;
          continue;
        }
        if (sourceInputRejectedAtFence) {
          sourceInputFenceRejections += 1;
          if (sourceInputFenceRejections > 3) {
            const error = new Error("source-input fence did not stabilize");
            error.code = "SOURCE_INPUT_FENCE_UNSTABLE";
            throw error;
          }
          const refreshed = typeof jobModel.refreshClaim === "function"
            ? await jobModel.refreshClaim({
                id: job.id,
                leaseToken: job.leaseToken,
                processingDirtyReasons: job.processingDirtyReasons,
                now: now(),
              })
            : null;
          if (!refreshed) throw new FenceLostError();
          Object.assign(job, refreshed);
          baseResolutionPlan = reasonAwareEnabled
            ? resolutionPlanForDirtyReasons(job.processingDirtyReasons)
            : "FULL";
          resolveTimedActiveImpacts =
            job.processingDirtyReasons?.includes("EFFECT_BOUNDARY") === true;
          closurePlan = null;
          forceFull = true;
          continue;
        }
        if (artifactPayload) {
          artifactHit = true;
          await displayArtifactStore.consume(job.processingDisplayArtifactId);
        }
        break;
      }

      if (discarded) {
        logger.log(JSON.stringify({
          event: "race_resolution_v2",
          schemaVersion: 2,
          observedAt: new Date().toISOString(),
          attemptId,
          outcome: "superseded_discard",
          queuePriority: job.processingQueuePriority || "LIVE",
          reasonClasses: job.processingDirtyReasons || ["FULL"],
          resolutionPlan,
          dirtyParticipantCount: job.processingDirtyParticipantIds?.length || 0,
          changedRows: 0,
          computeMs,
          writeMs,
          durationMs: Math.max(0, Date.now() - startMs),
          coreMs: Math.max(0, Date.now() - startMs),
          queueLagMs: Math.max(0, startMs - new Date(job.requestedAt).getTime()),
          phaseMs: phaseTimer.snapshot(),
          computePhaseMs,
          computePhaseQueryCaptureEnabled,
          computePhaseQueryCount,
          nudgePhaseMs,
          postHandoffPhaseMs,
          stepSyncScopeOutcome,
          stepSyncScopeActiveEffectCount,
          stepSyncScopePhaseMs,
        }));
        return { jobId: job.id, discarded: true };
      }

      // ── Post-commit. Everything below is best-effort and holds no lock. ──
      const postStartedAt = Date.now();
      let deferredSnapshotCommand = null;
      const deferredIntents = [];
      // These are decisions waiting to be claimed.  They must not touch a
      // cooldown/cap until the durable post-task row has won its generation
      // dedupe insert, and they are resolved inside that same transaction.
      const deferredIntentClaims = [];
      // DEPENDENCY_CLOSURE is ADMITTED here, not exempted (spec item 8): it must
      // never skip expireEffects, box consequences, the high-multiplier re-arm,
      // the snapshot, or one-attempt delivery just because the scoring was
      // scoped. It carries the same generation-time artifacts:
      //   * `result.race.participants` is the FULL accepted roster (R9), so the
      //     alert pass reads exactly the recipients a FULL run would;
      //   * `baseAdjustedByParticipantId` is SUBSET, made safe by the planner's
      //     exact scoringClosure expansion: every active snapshot-at-expiry or
      //     Drill target and its graph component is computed regardless of
      //     expiry distance. Its starts/expiry transitions also participate in
      //     validUntil; malformed boundary metadata selects FULL. The in-fence
      //     digest/deadline re-read then rejects any crossed or changed input
      //     before writes, so post-commit expiry always has the value it may
      //     consume without a timing-slack heuristic;
      //   * the snapshot is assembled by `computePersistedSnapshot`, which
      //     re-reads the committed rows. No second full score recompute happens
      //     on any plan, so no closure-specific approximation exists to make.
      if (
        !atomicPostTaskHandoff &&
        [
          "FULL",
          "ARTIFACT_REUSE",
          "STEP_SYNC_COMMITTED",
          "STEP_SYNC_INCREMENTAL",
          "DEPENDENCY_CLOSURE",
        ].includes(resolutionPlan)
      ) {
        const stopPostCommitHook = phaseTimer.start("postCommitHook");
        try {
          const outcome = await onCommitted({
            raceId: job.raceId,
            job,
            result,
            superseded,
            deferEffectExpiry: !resolveTimedActiveImpacts,
            deferSnapshot: postTasksEnabled,
            deferDelivery: postTasksEnabled,
          });
          deferredSnapshotCommand = outcome?.snapshotCommand || null;
          if (Array.isArray(outcome?.intentClaims)) {
            deferredIntentClaims.push(...outcome.intentClaims);
          }
        } catch (error) {
          logger.error("[RACE_RESOLUTION_V2] post-commit hook error:", error);
        } finally {
          stopPostCommitHook();
        }
      }

      // PostgreSQL is already committed. Only rebuildable toast/event
      // projections remain here; they can never determine whether a box exists.
      if (result) {
        const stopPowerupStateSync = phaseTimer.start("powerupStateSync");
        try {
          for (const { userId: triggerUserId, syncResult } of committedBoxSyncResults) {
            try {
              await recentBoxMints.record({
                userId: triggerUserId,
                raceId: result.raceId,
                syncResult,
              });
            } catch (error) {
              logger.error(JSON.stringify({
                event: "race_resolution_v2_post_error",
                operation: "powerup_state_sync",
                errorCode: error?.code || "POST_WORK_ERROR",
              }));
            }
          }
          for (const payload of committedPowerupEvents) {
            try {
              events.emit("POWERUP_EARNED", payload);
            } catch (error) {
              logger.error(JSON.stringify({
                event: "race_resolution_v2_post_error",
                operation: "powerup_event_publish",
                errorCode: error?.code || "POST_WORK_ERROR",
              }));
            }
          }
        } finally {
          stopPowerupStateSync();
        }

        if (!atomicPostTaskHandoff) {
          const nudgeBatchEnabled = await phaseTimer.measure(
            "postSettings",
            () => isStrictFlagEnabled(settings, "raceResolutionNudgeBatchV1Enabled")
          );
          const stopOvertakeNudges = phaseTimer.start("overtakeNudges");
          const nudgeTriggerGroups = nudgeBatchEnabled
            ? [orderedTriggeringUserIds]
            : orderedTriggeringUserIds.map((id) => [id]);
          try {
            for (const nudgeTriggerIds of nudgeTriggerGroups) {
              try {
                await nudge({
                raceResults: [result],
                userId: nudgeTriggerIds[0] || null,
                ...(nudgeBatchEnabled ? {
                  userIds: nudgeTriggerIds,
                  participantWrites,
                  preferHydratedRoster: true,
                } : {}),
                participantModel,
                recordPhaseTiming: (name, durationMs) =>
                  addPhaseTiming(nudgePhaseMs, name, durationMs),
                requestStepSyncForUsers: postTasksEnabled
                  ? async (recipientIds) => {
                    try {
                      deferredIntentClaims.push({
                        kind: "STEP_SYNC",
                        recipientIds: [...new Set(recipientIds || [])],
                        raceId: job.raceId,
                        sourceGeneration: job.processingGeneration,
                        deliveryKind: "NUDGE",
                      });
                    } catch (error) {
                      // Preserve the current delivery immediately when an
                      // immutable cooldown reservation cannot be made.
                      logger.error(JSON.stringify({
                        event: "race_resolution_v2_post_error",
                        operation: "nudge_intent_claim",
                        errorCode: error?.code || "INTENT_CLAIM_ERROR",
                      }));
                      await requestStepSyncForUsers(recipientIds);
                    }
                  }
                  : requestStepSyncForUsers,
                });
              } catch (error) {
                logger.error("[RACE_RESOLUTION_V2] overtake nudge error:", error);
              }
            }
          } finally {
            stopOvertakeNudges();
          }
        }
      }

      // Creation happens only after every stateful/RNG/recipient decision above
      // has finished. The payload contains only already-claimed immutable
      // transport intents plus the generation-level publication command.
      if (atomicPostTaskHandoff && committedPostTaskId) {
        const stopPostTaskHandoff = phaseTimer.start("postTaskHandoff");
        try {
          await postTaskHandoff.resumeDurable(committedPostTaskId, {
            fastHandoff: false,
            recordPhaseTiming: (name, durationMs) =>
              addPhaseTiming(postHandoffPhaseMs, name, durationMs),
          });
        } catch (error) {
          // The task is already committed and independently reclaimable.
          logger.error(JSON.stringify({
            event: "race_resolution_v2_post_error",
            operation: "post_task_resume",
            errorCode: error?.code || "POST_HANDOFF_RESUME_ERROR",
          }));
        } finally {
          stopPostTaskHandoff();
        }
      } else if (postTasksEnabled && deferredSnapshotCommand) {
        const stopPostTaskHandoff = phaseTimer.start("postTaskHandoff");
        try {
          const resolveIntents = async (client) => {
            const resolved = [];
            for (const claim of deferredIntentClaims) {
              if (claim?.kind === "HIGH_MULTIPLIER") {
                resolved.push(...await deliveryIntents.claimHighMultiplier(claim.data, {
                  sourceGeneration: claim.sourceGeneration,
                  client,
                  participantClaim: claim.participantClaim,
                }));
              } else if (claim?.kind === "STEP_SYNC") {
                resolved.push(...await deliveryIntents.claimStepSync(claim.recipientIds, {
                  raceId: claim.raceId,
                  sourceGeneration: claim.sourceGeneration,
                  kind: claim.deliveryKind,
                  client,
                }));
              }
            }
            return resolved;
          };
          await postTaskHandoff({
            raceId: job.raceId,
            sourceGeneration: job.processingGeneration,
            snapshotCommand: deferredSnapshotCommand,
            intents: deferredIntents,
            resolveIntents,
            fastHandoff: false,
            recordPhaseTiming: (name, durationMs) =>
              addPhaseTiming(postHandoffPhaseMs, name, durationMs),
          });
        } catch (error) {
          // A created row remains recoverable by the runner; never issue an
          // uncoordinated second snapshot attempt after an ambiguous handoff.
          logger.error(JSON.stringify({
            event: "race_resolution_v2_post_error",
            operation: "post_task_handoff",
            errorCode: error?.code || "POST_HANDOFF_ERROR",
          }));
        } finally {
          stopPostTaskHandoff();
        }
      }

      logger.log(JSON.stringify({
        event: "race_resolution_v2",
        schemaVersion: 2,
        observedAt: new Date().toISOString(),
        attemptId,
        outcome: superseded ? "superseded_commit" : "commit",
        queuePriority: job.processingQueuePriority || "LIVE",
        reasonClasses: job.processingDirtyReasons?.length
          ? job.processingDirtyReasons
          : ["FULL"],
        resolutionPlan,
        artifactHit,
        artifactFallbackReason,
        dirtyParticipantCount: job.processingDirtyParticipantIds?.length || 0,
        fullParticipantCount: result?.race?.participants?.length || 0,
        triggeringUserCount: triggeringUserIds.length,
        changedRows: new Set(participantWrites.map((write) => write.participantId)).size,
        activeImpactCreated: activeImpactMetrics?.created || 0,
        activeImpactZero: activeImpactMetrics?.zero || 0,
        activeImpactSuppressed: activeImpactMetrics?.suppressed || 0,
        activeImpactFailures: activeImpactMetrics?.failures || 0,
        activeImpactMs: activeImpactMetrics?.durationMs || 0,
        activeImpactPersistMs,
        computeMs,
        writeMs,
        postTaskMs: Math.max(0, Date.now() - postStartedAt),
        coreMs: Math.max(0, Date.now() - startMs),
        queueLagMs: Math.max(0, startMs - new Date(job.requestedAt).getTime()),
        // Additive, aggregate-only Phase 2b shadow dimensions. They are
        // populated ONLY when the shadow flag is on: with just the write flag
        // on, the planner still runs (once) but every `shadow*` field is null,
        // and the plan it chose is reported by `resolutionPlan` instead. Both
        // flags on = both, from that same single planner call.
        ...closureShadow,
        // Phase 3, aggregate-only. `null` when no closure plan was evaluated
        // (write flag off, envelope not candidate-shaped, or the planner said
        // FULL); `true` when an active mine had a non-closure candidate or an
        // UNKNOWN answer and the generation was escalated to FULL before any
        // write; `false` when a closure ran with the mine question answered no.
        closureEscalatedOnMine,
        closureFenceRejections: closureCommittedRejections,
        closureFenceRejectionReason,
        placementHandoffGeneration,
        placementHandoffOutcome,
        sourceInputFenceRejections,
        sqlCount: typeof dependencies.sqlCount === "function" ? dependencies.sqlCount() : null,
        phaseMs: phaseTimer.snapshot(),
        computePhaseMs,
        computePhaseQueryCaptureEnabled,
        computePhaseQueryCount,
        nudgePhaseMs,
        postHandoffPhaseMs,
        stepSyncScopeOutcome,
        stepSyncScopeActiveEffectCount,
        stepSyncScopePhaseMs,
      }));
      return job;
    } catch (error) {
      if (error instanceof FenceLostError) {
        // Lost the lease mid-run. Nothing was written and the job row belongs to
        // whoever re-claimed it — recording a failure here would stomp them.
        logger.log(JSON.stringify({
          event: "race_resolution_v2",
          schemaVersion: 2,
          observedAt: new Date().toISOString(),
          attemptId,
          outcome: "fence_lost",
          queuePriority: job.processingQueuePriority || "LIVE",
          resolutionPlan,
          coreMs: Math.max(0, Date.now() - startMs),
          queueLagMs: Math.max(0, startMs - new Date(job.requestedAt).getTime()),
          reasonClasses: job.processingDirtyReasons || ["FULL"],
          phaseMs: phaseTimer.snapshot(),
          computePhaseMs,
          computePhaseQueryCaptureEnabled,
          computePhaseQueryCount,
          nudgePhaseMs,
          postHandoffPhaseMs,
          stepSyncScopeOutcome,
          stepSyncScopeActiveEffectCount,
          stepSyncScopePhaseMs,
        }));
        return job;
      }
      logger.error(JSON.stringify({
        event: "race_resolution_v2",
        schemaVersion: 2,
        observedAt: new Date().toISOString(),
        attemptId,
        outcome: "failed",
        queuePriority: job.processingQueuePriority || "LIVE",
        resolutionPlan,
        coreMs: Math.max(0, Date.now() - startMs),
        queueLagMs: Math.max(0, startMs - new Date(job.requestedAt).getTime()),
        reasonClasses: job.processingDirtyReasons || ["FULL"],
        errorCode: error?.code || "WORKER_ERROR",
        phaseMs: phaseTimer.snapshot(),
        computePhaseMs,
        computePhaseQueryCaptureEnabled,
        computePhaseQueryCount,
        nudgePhaseMs,
        postHandoffPhaseMs,
        stepSyncScopeOutcome,
        stepSyncScopeActiveEffectCount,
        stepSyncScopePhaseMs,
        // Diagnosability for raw-query failures (dependency-closure spec,
        // rollout item 7). Under the pg driver adapter (src/db.js) the
        // SQLSTATE lives at meta.driverAdapterError.cause.originalCode —
        // meta.code is undefined there; it only carries the SQLSTATE on the
        // non-adapter engine. Log the bare five-char code only — never SQL
        // text, IDs, raw steps, or tokens.
        sqlState: (() => {
          const s =
            error?.meta?.driverAdapterError?.cause?.originalCode ??
            error?.meta?.code;
          return typeof s === "string" && /^[0-9A-Z]{5}$/.test(s) ? s : null;
        })(),
      }));
      try {
        await jobModel.recordFailure({
          id: job.id,
          leaseToken: job.leaseToken,
          attempts: job.attempts,
          errorCode: error && error.code ? String(error.code) : "WORKER_ERROR",
          now: now(),
        });
      } catch (failureError) {
        logger.error("[RACE_RESOLUTION_V2] recordFailure failed:", failureError);
      }
      return job;
    }
    } catch (error) {
      logger.error(JSON.stringify({
        event: "race_resolution_v2",
        schemaVersion: 2,
        observedAt: new Date().toISOString(),
        attemptId,
        outcome: "failed",
        queuePriority: job.processingQueuePriority || "LIVE",
        resolutionPlan,
        coreMs: Math.max(0, Date.now() - startMs),
        queueLagMs: attempt.queueLagMs,
        reasonClasses: job.processingDirtyReasons || ["FULL"],
        errorCode: error?.code || "WORKER_PREPARE_ERROR",
        phaseMs: phaseTimer.snapshot(),
      }));
      try {
        await jobModel.recordFailure({
          id: job.id,
          leaseToken: job.leaseToken,
          attempts: job.attempts,
          errorCode: error?.code || "WORKER_PREPARE_ERROR",
          now: now(),
        });
      } catch (failureError) {
        logger.error("[RACE_RESOLUTION_V2] prepare recordFailure failed:", failureError);
      }
      return job;
    } finally {
      watchdog.cancel();
      activeAttempts.delete(attemptId);
      lastTerminalMonotonicAt = monotonicNow();
    }
  }

  async function processOne() {
    if (!productionExecutionRole) return null;
    return workBudget.run("core", () => processOneUnbudgeted());
  }

  // Compatibility bridge for request paths whose historical contract requires
  // a due boundary to be committed before the response returns. This still
  // runs the exact C0 worker and takes the same lease/fence; the only difference
  // from the scheduler is that it targets one race and bypasses debounce. If a
  // background worker already owns the row, wait for that generation instead
  // of claiming unrelated queue work or writing outside C0.
  async function processRace({ raceId, generation = null } = {}) {
    if (!raceId) return null;
    const requestedGeneration = Number.isInteger(Number(generation))
      ? Number(generation)
      : null;
    const deadline = wallClockNow() + (
      nodeEnv === "production" && processRole !== "resolution"
        ? 25_000
        : leaseMs + 5_000
    );
    while (wallClockNow() <= deadline) {
      if (productionExecutionRole) {
        const processed = await workBudget.run("core", () =>
          processOneUnbudgeted({ raceId })
        );
        if (processed === TARGETED_CLAIM_DISABLED) return null;
        if (processed) return processed;
      }

      if (typeof jobModel.findByRaceId !== "function") return null;
      const current = await jobModel.findByRaceId(raceId);
      if (!current) return null;
      const processedRequestedGeneration =
        requestedGeneration == null ||
        Number(current.processingGeneration) >= requestedGeneration;
      if (
        processedRequestedGeneration &&
        (current.state === "SUCCEEDED" || current.state === "FAILED")
      ) {
        return current;
      }

      // On the first miss another worker normally owns the lease. Poll without
      // holding a database connection; once it commits or its lease expires,
      // the next targeted claim either observes completion or safely reclaims.
      const remainingMs = deadline - wallClockNow();
      if (remainingMs <= 0) break;
      await sleep(Math.min(compatibilityPollIntervalMs, remainingMs));
    }
    logger.error(`[RACE_RESOLUTION_V2] timed out waiting for race ${raceId}`);
    return null;
  }

  async function tick({ concurrencyOverride = null } = {}) {
    if (!productionExecutionRole) return 0;
    if (raceResolutionWorkerDisabled()) return 0;
    const concurrency = concurrencyOverride == null
      ? effectiveResolutionConcurrency()
      : Math.min(3, Math.max(1, Number(concurrencyOverride) || 1));
    return runBoundedRaceResolutionJobs(concurrency, processOne);
  }

  async function logQueueLagInternal() {
    const capacity = startCapacityPhase("resolution_queue_lag");
    let outcome = "error";
    try {
      const service = await capacity.measurePhase(
        "lagProbe",
        () => typeof jobModel.queueServiceSnapshot === "function"
          ? jobModel.queueServiceSnapshot(now())
          : jobModel.queueLagMs(now()).then((oldestRequestAgeMs) => ({
            oldestRequestAgeMs,
            claimableCount: 0,
            oldestClaimableAgeMs: 0,
            runningCount: 0,
          })),
      );
      const lanes = typeof workBudget.snapshot === "function"
        ? workBudget.snapshot()
        : { active: null, queuedCore: null, queuedPost: null };
      lastExpiredRunningCount = service.expiredRunningCount ?? null;
      const lagMs = service.oldestRequestAgeMs;
      const claimableLagMs = service.oldestClaimableAgeMs;
      const lastTerminalAgeMs = lastTerminalMonotonicAt == null
        ? null
        : Math.max(0, Number(monotonicNow() - lastTerminalMonotonicAt) / 1e6);
      const noTerminalProgressAgeMs = lastTerminalAgeMs == null
        ? Math.max(0, Number(monotonicNow() - processBootMonotonicAt) / 1e6)
        : lastTerminalAgeMs;
      const oldestClaimWithoutTerminalMs = [...activeAttempts.values()].reduce(
        (oldest, entry) => Math.max(oldest, entry.phaseTimer.liveState().attemptElapsedMs),
        0
      );
      const alarm =
        claimableLagMs > QUEUE_LAG_ALARM_MS ||
        (service.expiredRunningCount > 0 && lanes.active >= 2) ||
        (service.claimableCount > 0 &&
          noTerminalProgressAgeMs > RACE_RESOLUTION_WATCHDOG_MS);
      const level = alarm ? "warn" : "log";
      (logger[level] || logger.log).call(
        logger,
        JSON.stringify({
          event: "race_resolution_v2_queue_service",
          oldestRequestAgeMs: lagMs,
          claimableCount: service.claimableCount,
          oldestClaimableAgeMs: claimableLagMs,
          runningCount: service.runningCount,
          expiredRunningCount: service.expiredRunningCount,
          settlementCount: service.settlementCount,
          recoveryCount: service.recoveryCount,
          liveCount: service.liveCount,
          maintenanceCount: service.maintenanceCount,
          workLaneActive: lanes.active,
          workLaneQueuedCore: lanes.queuedCore,
          workLaneQueuedPost: lanes.queuedPost,
          lastTerminalAgeMs,
          oldestClaimWithoutTerminalMs,
          eventLoopDelayMs: Math.round(eventLoopDelayMs),
          processBootId: bootId,
          processBootedAt: PROCESS_BOOT_TIMESTAMP,
          alarm,
        })
      );
      capacity.setCounts({
        lagMs,
        claimableCount: service.claimableCount,
        claimableLagMs,
        runningCount: service.runningCount,
        expiredRunningCount: service.expiredRunningCount,
        settlementCount: service.settlementCount,
        recoveryCount: service.recoveryCount,
        liveCount: service.liveCount,
        maintenanceCount: service.maintenanceCount,
        workLaneActive: lanes.active,
        workLaneQueuedCore: lanes.queuedCore,
        workLaneQueuedPost: lanes.queuedPost,
        lastTerminalAgeMs,
        oldestClaimWithoutTerminalMs,
        eventLoopDelayMs,
      });
      capacity.setDimensions({ alarm });
      outcome = "success";
      return lagMs;
    } catch (error) {
      logger.error("[RACE_RESOLUTION_V2] queue lag probe failed:", error);
      return null;
    } finally {
      capacity.finish(outcome);
    }
  }

  function logQueueLag() {
    return runCapacityMetricsEntry(
      {
        settings,
        logger,
        env: dependencies.capacityMetricsEnv || process.env,
        random: dependencies.capacityMetricsRandom || Math.random,
        readDbPoolPressure:
          dependencies.getDbPoolPressure || getDbPoolPressure,
        forceSample: true,
      },
      logQueueLagInternal,
    );
  }

  return {
    processOne,
    processRace,
    tick,
    logQueueLag,
    readyToClaim,
    startupReadiness,
    claimingDisabled,
    FenceLostError,
  };
}

function scheduleRaceResolutionWorkerV2(dependencies = {}) {
  const logger = dependencies.logger || console;
  const processRole = dependencies.processRole || process.env.STEPS_PROCESS_ROLE || "all";
  const nodeEnv = dependencies.nodeEnv || process.env.NODE_ENV || "development";
  if (nodeEnv === "production" && processRole === "resolution") {
    try {
      const bootSpool = dependencies.operationalAlertSpool || createOperationalAlertSpool();
      bootSpool.ensureDirectory();
      bootSpool.writeBoot({
        bootId: dependencies.bootId || PROCESS_BOOT_ID,
        pid: process.pid,
        bootedAt: PROCESS_BOOT_TIMESTAMP,
      });
    } catch (error) {
      try {
        process.stderr.write(`${JSON.stringify({
          event: "race_resolution_v2_alert_spool_error",
          schemaVersion: 1,
          alertType: "boot",
          errorCode: error?.code || "BOOT_MARKER_WRITE_FAILED",
        })}\n`);
      } catch (_) {}
    }
  }
  const worker = buildRaceResolutionWorkerV2(dependencies);
  const settings = dependencies.appSettings || defaultAppSettings;
  const yieldToEventLoop = dependencies.yieldToEventLoop ||
    (() => new Promise((resolve) => setImmediate(resolve)));
  const drainSliceMs = Math.max(
    1,
    Number(dependencies.adaptiveDrainSliceMs) || ADAPTIVE_DRAIN_SLICE_MS
  );
  const drainSliceJobs = Math.max(
    1,
    Number(dependencies.adaptiveDrainSliceJobs) || ADAPTIVE_DRAIN_SLICE_JOBS
  );
  const errorBackoffMs = Math.max(
    POLL_INTERVAL_MS,
    Number(dependencies.adaptiveDrainErrorBackoffMs) ||
      ADAPTIVE_DRAIN_ERROR_BACKOFF_MS
  );

  let running = false;
  let backoffUntilMs = 0;
  const adaptiveDrainEnabled = () => isStrictFlagEnabled(
    settings,
    "raceResolutionAdaptiveDrainV1Enabled"
  );
  async function runScheduledWork() {
    if (running) return;
    running = true;
    let adaptive = false;
    try {
      adaptive = await adaptiveDrainEnabled();
      if (adaptive && Date.now() < backoffUntilMs) return;
      if (!adaptive) {
        await worker.tick();
        return;
      }

      let sliceStartedAt = Date.now();
      let sliceJobs = 0;
      for (;;) {
        // Adaptive mode preserves the configured bounded concurrency. It
        // removes only the idle 250ms gap; leases, fencing, the shared work
        // budget, and DB ownership remain the ordinary scheduler path.
        const processed = await worker.tick();
        if (processed === 0) return;
        sliceJobs += processed;
        if (
          sliceJobs >= drainSliceJobs ||
          Date.now() - sliceStartedAt >= drainSliceMs
        ) {
          await yieldToEventLoop();
          // Bound flag rollback latency during a continuously non-empty queue.
          // The emergency claiming switch is still checked by every job.
          if (!(await adaptiveDrainEnabled())) return;
          sliceStartedAt = Date.now();
          sliceJobs = 0;
        }
      }
    } catch (error) {
      if (adaptive) {
        backoffUntilMs = Date.now() + errorBackoffMs;
        logger.error("[RACE_RESOLUTION_V2] adaptive tick error:", error);
      } else {
        logger.error("[RACE_RESOLUTION_V2] tick error:", error);
      }
    } finally {
      running = false;
    }
  }
  const interval = setInterval(async () => {
    await runScheduledWork();
  }, POLL_INTERVAL_MS);
  if (interval.unref) interval.unref();

  // Backpressure metric, once a minute (Phase A0 step (c) — shipped so before/
  // after lag is comparable across the C0 cutover).
  const lagInterval = setInterval(() => {
    worker.logQueueLag().catch(() => {});
  }, QUEUE_LAG_LOG_INTERVAL_MS);
  if (lagInterval.unref) lagInterval.unref();

  const stepSyncRequestModel =
    dependencies.StepSyncRequest || defaultStepSyncRequestModel;
  const cleanup = setInterval(() => {
    stepSyncRequestModel.cleanupExpired(new Date()).catch(() => {});
  }, CLEANUP_INTERVAL_MS);
  if (cleanup.unref) cleanup.unref();

  logger.log(
    "[CRON] Race-keyed (v2) resolution worker scheduled (poll 250ms, " +
      `${quietPeriodMs() / 1000}s startup quiet period)`
  );
  return { interval, lagInterval, cleanup, worker };
}

module.exports = {
  buildRaceResolutionWorkerV2,
  scheduleRaceResolutionWorkerV2,
  FenceLostError,
  createRaceResolutionPhaseTimer,
  createRaceResolutionAttemptWatchdog,
  RACE_RESOLUTION_SLOW_PHASE_MS,
  RACE_RESOLUTION_SLOW_ATTEMPT_MS,
  RACE_RESOLUTION_WATCHDOG_MS,
  createWriteCapture,
  runBoundedRaceResolutionJobs,
  quietPeriodMs,
  effectiveResolutionConcurrency,
  POLL_INTERVAL_MS,
  participantTotalWriteChangesRow,
  retainTeamAsOfHeartbeat,
  normalizeParticipantWrites,
  writeParticipantsBulk,
  supersededRunMayDiscard,
  resolutionPlanForDirtyReasons,
  summarizeClosureShadow,
  NULL_CLOSURE_SHADOW_FIELDS,
};
