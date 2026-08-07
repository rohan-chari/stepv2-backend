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

const COMPAT_STEP_GOAL = 5000;
const RECONCILE_LEASE_MS = 30 * 1000;
const DEFAULT_MAX_WAIT_MS = 5000;
const DEFAULT_POLL_MS = 150;

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
  const events = dependencies.eventBus || defaultEventBus;
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

    const { response } = await prisma.$transaction(async (tx) => {
      const requestedAt = now();
      const jobs = await raceResolutionJobModel.enqueueMany(
        {
          raceIds: activeRaceIds,
          userId,
          resolutionTimeZone: timeZone,
          now: requestedAt,
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

  return async function recordStepSyncV2({ userId, body, idempotencyKey, timeZone = "UTC" }) {
    validateIdempotencyKey(idempotencyKey);
    const { canonical, hash } = canonicalizeStepSyncRequest(body);
    // Enforce manual-sample rejection / recordingMethod rules (400) up front.
    const normalized = normalizeSamples(canonical.samples);
    const cleaned = removeOverlaps(normalized);

    // Idempotency: inspect any existing reservation for this (user, key).
    const existing = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
    if (existing) {
      if (existing.requestHash !== hash) throw new StepSyncConflictError();
      if (existing.state === "COMPLETE") return existing.responseJson;
      // PROCESSING same-hash: wait for completion or recover an expired lease.
      const deadline = now().getTime() + maxWaitMs;
      while (now().getTime() < deadline) {
        if (leaseExpired(existing, now().getTime())) {
          return recover({ reservation: existing, userId, timeZone, canonical });
        }
        await sleep(pollMs);
        const row = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
        if (!row) break;
        if (row.state === "COMPLETE") return row.responseJson;
        existing.leaseExpiresAt = row.leaseExpiresAt;
      }
      const row = await stepSyncRequestModel.findByKey(userId, idempotencyKey);
      if (row && row.state === "COMPLETE") return row.responseJson;
      if (row) return recover({ reservation: row, userId, timeZone, canonical });
      // Row vanished (cleanup); fall through to a fresh persist.
    }

    // ── Transaction A: persist steps/samples + create the reservation. ──
    let reservation;
    let record;
    let stepsChanged;
    try {
      const result = await prisma.$transaction(async (tx) => {
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
    });
  };
}

const recordStepSyncV2 = buildRecordStepSyncV2();

module.exports = {
  buildRecordStepSyncV2,
  recordStepSyncV2,
  StepSyncConflictError,
  StepSyncValidationError,
};
