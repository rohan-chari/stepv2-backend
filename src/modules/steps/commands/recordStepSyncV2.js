const { prisma: defaultPrisma } = require("../../../db");
const { StepSyncRequest: defaultStepSyncRequestModel } = require("../models/stepSyncRequest");
const {
  RaceResolutionJobV2: defaultRaceResolutionJobModel,
} = require("../../races/models/raceResolutionJobV2");
const { Race: defaultRaceModel } = require("../../races/models/race");
const {
  reconcileUploaderRaces: defaultReconcileUploaderRaces,
} = require("../../races/services/reconcileUploaderRaces");
const { eventBus: defaultEventBus } = require("../../../shared/events/eventBus");
const {
  canonicalizeStepSyncRequest,
  validateIdempotencyKey,
  StepSyncValidationError,
} = require("../stepSyncCanonical");
const { normalizeSamples, removeOverlaps } = require("./recordStepSamples");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const {
  bumpScoringInputVersion,
} = require("../services/scoringInputVersion");

const COMPAT_STEP_GOAL = 5000;
const RECONCILE_LEASE_MS = 30 * 1000;
const DEFAULT_MAX_WAIT_MS = 5000;
const DEFAULT_POLL_MS = 150;
const HOME_PULL_COOLDOWN_SECONDS = 30;

class StepSyncCooldownError extends Error {
  constructor(retryAfterSeconds) {
    super("Step sync is cooling down");
    this.name = "StepSyncCooldownError";
    this.code = "STEP_SYNC_COOLDOWN";
    this.statusCode = 429;
    this.retryAfterSeconds = Math.max(
      1,
      Math.min(HOME_PULL_COOLDOWN_SECONDS, Math.ceil(retryAfterSeconds || 1))
    );
  }
}

// 409: the idempotency key was reused with a DIFFERENT canonical request. The
// server may already have persisted the first request's data.
class StepSyncConflictError extends Error {
  constructor() {
    super("Idempotency key already used");
    this.name = "StepSyncConflictError";
    this.code = "IDEMPOTENCY_CONFLICT";
    this.statusCode = 409;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeRecord(step) {
  return {
    id: step.id,
    userId: step.userId,
    date: step.date,
    steps: step.steps,
    stepGoal: step.stepGoal ?? COMPAT_STEP_GOAL,
  };
}

function leaseExpired(row, nowMs) {
  return !row.leaseExpiresAt || new Date(row.leaseExpiresAt).getTime() <= nowMs;
}

// POST /steps/sync-v2 command (§6.4). Two-stage protocol so the durable worker
// can never race ahead of the uploader pass:
//   A. upsert daily steps/samples + create the PROCESSING idempotency reservation
//      (with the validated timezone). No queue write yet.
//   B. after commit: emit step events once, run locked uploader reconciliation,
//      then upsert the queue generation and finalize the reservation to COMPLETE
//      with the stored response — only now can the full worker claim the job.
function buildRecordStepSyncV2(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const stepSyncRequestModel =
    dependencies.StepSyncRequest || defaultStepSyncRequestModel;
  const raceResolutionJobModel =
    dependencies.RaceResolutionJobV2 ||
    dependencies.RaceResolutionJob ||
    defaultRaceResolutionJobModel;
  const raceModel = dependencies.Race || defaultRaceModel;
  const reconcileUploaderRaces =
    dependencies.reconcileUploaderRaces || defaultReconcileUploaderRaces;
  // The race-keyed worker is the authoritative full-field reconciler. Keeping
  // this on by default preserves the established response behavior, while a
  // runtime flag lets production return after durable enqueue when inline
  // reconciliation makes a step upload slow. Read at request time so a PM2
  // reload is an immediate, reversible rollout/rollback.
  const inlineUploaderReconciliation =
    dependencies.inlineUploaderReconciliation ||
    (() => process.env.SYNC_V2_INLINE_UPLOADER_RECONCILIATION !== "false");
  const events = dependencies.eventBus || defaultEventBus;
  const appSettings = dependencies.appSettings || defaultAppSettings;
  const now = dependencies.now || (() => new Date());
  const maxWaitMs = dependencies.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollMs = dependencies.pollMs ?? DEFAULT_POLL_MS;

  // Stage B: emit events once, reconcile the uploader (CURRENT/DEFERRED), then
  // enqueue + finalize. Shared by the fresh path and expired-lease recovery.
  async function finalizeReservation({
    reservation,
    userId,
    timeZone,
    record,
    sampleCount,
    stepsChanged,
    eventDate,
    eventSteps,
    reasonAware,
    burstCoalescing,
  }) {
    // One-time step-event emission, guarded by the reservation claim.
    const claimed = await stepSyncRequestModel.claimEventsEmission(reservation.id, now());
    if (claimed) {
      events.emit(stepsChanged ? "STEPS_UPDATED" : "STEPS_RECORDED", {
        userId,
        steps: eventSteps,
        date: eventDate,
      });
    }

    // Locked uploader reconciliation. On failure, still return DEFERRED — the
    // already-enqueued full job owns recovery.
    let uploaderReconciliation;
    if (!inlineUploaderReconciliation()) {
      uploaderReconciliation = {
        state: "DEFERRED",
        resolvedRaceCount: 0,
        boxStateCurrent: false,
      };
    } else {
      try {
        const { resolvedRaceCount, boxStateCurrent } = await reconcileUploaderRaces({
          userId,
          timeZone,
        });
        uploaderReconciliation = {
          state: "CURRENT",
          resolvedRaceCount,
          boxStateCurrent,
        };
      } catch (error) {
        // Logged + counted against SLO metrics by the worker/metrics layer.
        console.error("sync-v2 uploader reconciliation failed:", error);
        uploaderReconciliation = {
          state: "DEFERRED",
          resolvedRaceCount: 0,
          boxStateCurrent: false,
        };
      }
    }

    // Transaction B: enqueue the queue generation(s) + finalize the reservation.
    //
    // C0 (spec §5a item 4): the queue is RACE-keyed now, so one upload enqueues
    // EVERY active race of the uploader, each with this user appended to the
    // job's `triggeredByUserIds` so the worker computes their box state.
    //
    // Wire-shape compat for frozen clients: `raceResolution` still reports ONE
    // job — the uploader's lexicographically-first active race, which is the one
    // `GET /steps/race-resolution/:jobId` polls. A user with no active races has
    // no job to report and gets `jobId: null`, which the shipped client already
    // handles (it simply doesn't start the poll; see
    // backend_api_service.dart's nullable `jobId`).
    const activeRaces = await raceModel.findActiveForUser(userId).catch(() => []);
    const activeRaceIds = (activeRaces || [])
      .map((race) => race.id)
      .sort((a, b) => String(a).localeCompare(String(b)));
    const dirtyEnvelopeByRaceId = new Map();
    if (reasonAware) {
      for (const race of activeRaces || []) {
        const uploader = (race.participants || []).find(
          (participant) =>
            participant.userId === userId && participant.status === "ACCEPTED"
        );
        dirtyEnvelopeByRaceId.set(race.id, {
          reason: "STEP_SYNC",
          dirtyUserIds: [userId],
          dirtyParticipantIds: uploader ? [uploader.id] : [],
          powerupTypes: [],
          priority: uploader ? "COALESCE" : "IMMEDIATE",
        });
      }
    }

    const { response } = await prisma.$transaction(async (tx) => {
      const requestedAt = now();
      const jobs = await raceResolutionJobModel.enqueueMany(
        {
          raceIds: activeRaceIds,
          userId,
          resolutionTimeZone: timeZone,
          now: requestedAt,
          dirtyEnvelopeByRaceId,
          burstCoalescing,
        },
        tx
      );
      const reported = jobs.find(Boolean) || null;
      const built = {
        record,
        sampleCount,
        uploaderReconciliation,
        raceResolution: {
          jobId: reported ? reported.id : null,
          generation: reported ? reported.generation : null,
          state: "QUEUED",
          requestedAt: reported ? reported.requestedAt : requestedAt,
        },
      };
      await stepSyncRequestModel.finalize(
        { id: reservation.id, responseJson: built, now: requestedAt },
        tx
      );
      return { response: built };
    });

    return response;
  }

  // Resume a PROCESSING reservation whose lease expired (crash between A and B).
  // Steps/samples are already persisted; re-run the idempotent uploader pass and
  // Transaction B. Extends the lease first so only one recoverer proceeds.
  async function recover({ reservation, userId, timeZone, canonical }) {
    const claim = await prisma.stepSyncRequest.updateMany({
      where: {
        id: reservation.id,
        state: "PROCESSING",
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now() } },
        ],
      },
      data: { leaseExpiresAt: new Date(now().getTime() + RECONCILE_LEASE_MS) },
    });
    if (claim.count !== 1) {
      // Someone else took it; re-read for the (likely COMPLETE) result.
      const row = await stepSyncRequestModel.findByKey(userId, reservation.idempotencyKey);
      if (row && row.state === "COMPLETE") return row.responseJson;
    }

    const date = canonical.date;
    const cleaned = removeOverlaps(normalizeSamples(canonical.samples));
    const step = await prisma.step.findUnique({
      where: { userId_date: { userId, date: new Date(date) } },
    });
    const record = step
      ? serializeRecord(step)
      : { id: null, userId, date: new Date(date), steps: canonical.steps, stepGoal: COMPAT_STEP_GOAL };

    return finalizeReservation({
      reservation,
      userId,
      timeZone,
      record,
      sampleCount: cleaned.length,
      stepsChanged: true,
      eventDate: date,
      eventSteps: canonical.steps,
    });
  }

  // Same-key resolution is deliberately shared by the initial read and the
  // post-admission-loss read. In particular, two concurrent home pulls can
  // both miss the first lookup: the loser must replay/recover the winner's
  // reservation, not turn the winner's committed cooldown stamp into a 429.
  async function replayExisting({ reservation, userId, idempotencyKey, timeZone, canonical, hash }) {
    if (reservation.requestHash !== hash) throw new StepSyncConflictError();
    if (reservation.state === "COMPLETE") return reservation.responseJson;
    const deadline = now().getTime() + maxWaitMs;
    let current = reservation;
    while (now().getTime() < deadline) {
      if (leaseExpired(current, now().getTime())) {
        return recover({ reservation: current, userId, timeZone, canonical });
      }
      await sleep(pollMs);
      const row = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
      if (!row) break;
      if (row.state === "COMPLETE") return row.responseJson;
      current = row;
    }
    const row = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
    if (row && row.state === "COMPLETE") return row.responseJson;
    if (row) return recover({ reservation: row, userId, timeZone, canonical });
    return null;
  }

    return async function recordStepSyncV2({
    userId,
    body,
    idempotencyKey,
    timeZone = "UTC",
    homePull = false,
  }) {
    validateIdempotencyKey(idempotencyKey);
    const { canonical, hash } = canonicalizeStepSyncRequest(body);
    // Enforce manual-sample rejection / recordingMethod rules (400) up front.
    const normalized = normalizeSamples(canonical.samples);
    const cleaned = removeOverlaps(normalized);

    // Idempotency: inspect any existing reservation for this (user, key).
    const existing = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
    if (existing) {
      const replay = await replayExisting({
        reservation: existing, userId, idempotencyKey, timeZone, canonical, hash,
      });
      if (replay) return replay;
    }

    const reasonAware = await isStrictFlagEnabled(
      appSettings,
      "raceResolutionReasonAwareV1Enabled"
    );
    const burstCoalescing = await isStrictFlagEnabled(
      appSettings,
      "raceResolutionBurstCoalescingV1Enabled"
    );

    // ── Transaction A: persist steps/samples + create the reservation. ──
    let reservation;
    let record;
    let stepsChanged;
    try {
      const result = await prisma.$transaction(async (tx) => {
        // This conditional UPDATE is deliberately first inside Transaction A:
        // PostgreSQL's CURRENT_TIMESTAMP is the authority, so simultaneous
        // devices cannot both enter. Idempotency replay/recovery above happens
        // before reaching here, so a lost successful response still replays.
        if (homePull) {
          const stamped = await tx.$queryRaw`
            UPDATE "users"
            SET "last_home_pull_step_sync_at" = CURRENT_TIMESTAMP
            WHERE "id" = ${userId}
              AND (
                "last_home_pull_step_sync_at" IS NULL
                OR "last_home_pull_step_sync_at" <= CURRENT_TIMESTAMP - INTERVAL '30 seconds'
              )
            RETURNING "last_home_pull_step_sync_at" AS "lastHomePullStepSyncAt"
          `;
          if (stamped.length !== 1) {
            const cooldown = await tx.$queryRaw`
              SELECT CEIL(EXTRACT(EPOCH FROM (
                "last_home_pull_step_sync_at" + INTERVAL '30 seconds' - CURRENT_TIMESTAMP
              )))::int AS "retryAfterSeconds"
              FROM "users"
              WHERE "id" = ${userId}
            `;
            throw new StepSyncCooldownError(cooldown[0]?.retryAfterSeconds);
          }
        }
        const existingStep = await tx.step.findUnique({
          where: { userId_date: { userId, date: new Date(canonical.date) } },
        });
        const changed = Boolean(existingStep);
        const step = existingStep
          ? await tx.step.update({
              where: { id: existingStep.id },
              data: { steps: canonical.steps },
            })
          : await tx.step.create({
              data: { userId, steps: canonical.steps, date: new Date(canonical.date), stepGoal: null },
            });
        await tx.user.update({ where: { id: userId }, data: { lastStepSyncAt: now() } });
        if (cleaned.length > 0) {
          const { StepSample } = require("../models/stepSample");
          // §3.3 overlap resolution inside Transaction A (same tx as steps +
          // reservation), so mixed hourly/5-min data never double-counts.
          await StepSample.reconcileBatchOn(tx, userId, cleaned);
        }
        await bumpScoringInputVersion(tx, userId);
        const res = await stepSyncRequestModel.createReservation(
          {
            userId,
            idempotencyKey,
            requestHash: hash,
            resolutionTimeZone: timeZone,
            leaseMs: RECONCILE_LEASE_MS,
            now: now(),
          },
          tx
        );
        return { step, changed, res };
      });
      reservation = result.res;
      record = serializeRecord(result.step);
      stepsChanged = result.changed;
      // C4 (spec §5 Phase E): Transaction A has committed the daily total, so
      // `v1:user:daily:{id}:{date}` — the value every friend of this user reads
      // from `GET /friends/steps` — is now stale. This and `recordSteps` are the
      // only two daily-total writers; both invalidate here rather than at their
      // routes. Swallowed: bookkeeping never fails a sync.
      await require("../services/dailyStepsCache").invalidateSafe(
        userId,
        canonical.date
      );
    } catch (error) {
      // A concurrent home-pull winner may have committed Transaction A's
      // reservation while this request waited on the conditional timestamp
      // stamp. Re-read before surfacing the cooldown: same-key retries always
      // replay/recover the winner's result first.
      if (error?.code === "STEP_SYNC_COOLDOWN") {
        const row = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
        if (row) {
          const replay = await replayExisting({
            reservation: row, userId, idempotencyKey, timeZone, canonical, hash,
          });
          if (replay) return replay;
        }
      }
      // Unique-violation on the reservation => a concurrent request with the
      // same key created it first. Re-read and treat as a same-hash replay.
      if (error && error.code === "P2002") {
        const row = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
        if (row) {
          if (row.requestHash !== hash) throw new StepSyncConflictError();
          if (row.state === "COMPLETE") return row.responseJson;
          // The winner is reconciling; wait briefly then read its result.
          const deadline = now().getTime() + maxWaitMs;
          while (now().getTime() < deadline) {
            await sleep(pollMs);
            const r = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
            if (r && r.state === "COMPLETE") return r.responseJson;
            if (r && leaseExpired(r, now().getTime())) {
              return recover({ reservation: r, userId, timeZone, canonical });
            }
          }
          const r = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
          if (r && r.state === "COMPLETE") return r.responseJson;
          if (r) return recover({ reservation: r, userId, timeZone, canonical });
        }
      }
      throw error;
    }

    return finalizeReservation({
      reservation,
      userId,
      timeZone,
      record,
      sampleCount: cleaned.length,
      stepsChanged,
      eventDate: canonical.date,
      eventSteps: canonical.steps,
      reasonAware,
      burstCoalescing,
    });
  };
}

const recordStepSyncV2 = buildRecordStepSyncV2();

module.exports = {
  buildRecordStepSyncV2,
  recordStepSyncV2,
  StepSyncConflictError,
  StepSyncCooldownError,
  StepSyncValidationError,
};
