const { createGlobalEventEnrollmentController } = require('./globalEventEnrollmentController');
const { GlobalStepEvent } = require("../models/globalStepEvent");
const {
  GlobalStepEventBoundaryCursor,
} = require("../models/globalStepEventBoundaryCursor");
const { Race } = require("../../races/models/race");
const {
  enqueueRaceResolution,
} = require("../../races/services/enqueueRaceResolution");
const {
  shouldStartGlobalEvent,
  GLOBAL_EVENT_DURATION_MS,
  localEventWindowForZone,
} = require("../globalStepEvent");
const {
  processDueEntitlementBoundaries,
} = require("../services/globalStepEventEntitlement");
const {
  heartbeatAndCheck: heartbeatCronOwnerAndCheck,
} = require("../models/globalStepEventCronOwner");
const {
  captureOperationalSnapshot: captureDefaultOperationalSnapshot,
} = require("../services/globalStepEventObservability");
const {
  cleanupExpiredEntitlements: cleanupDefaultExpiredEntitlements,
} = require("../services/globalStepEventRetention");

// The scheduler runs once per minute. The "should an event start now?" decision is the PURE function
// shouldStartGlobalEvent; this job only does the DB read/write + push fan-out.
const SCHEDULER_INTERVAL_MS = 60 * 1000; // every minute
const MATERIALIZATION_BATCH_SIZE = 500;

function addCivilDays(day, amount) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function firstSafeLocalEventDay(now) {
  const threshold = new Date(now).getTime() + 36 * 60 * 60 * 1000;
  let day = new Date(now).toISOString().slice(0, 10);
  for (let index = 0; index < 7; index += 1) {
    const earliest = localEventWindowForZone({
      eventDay: day,
      localStartMinute: 480,
      durationMinutes: 30,
      timeZone: "Pacific/Kiritimati",
    }).startsAt.getTime();
    if (earliest >= threshold) return day;
    day = addCivilDays(day, 1);
  }
  throw new Error("unable to select safe local event day");
}

function buildLocalGlobalStepEventTick(dependencies = {}) {
  const globalStepEventModel = dependencies.GlobalStepEvent || GlobalStepEvent;
  const now = dependencies.now || (() => new Date());
  const processBoundaries = dependencies.processDueEntitlementBoundaries ||
    processDueEntitlementBoundaries;
  const logger = dependencies.logger || console;
  const cronOwnerGuard = dependencies.cronOwnerGuard || heartbeatCronOwnerAndCheck;
  const captureOperationalSnapshot = dependencies.captureOperationalSnapshot ||
    captureDefaultOperationalSnapshot;
  const cleanupExpiredEntitlements = dependencies.cleanupExpiredEntitlements ||
    cleanupDefaultExpiredEntitlements;
  const enrollment = createGlobalEventEnrollmentController(dependencies);
  async function runMinuteMaintenance({ isStopped = () => false, flushEnrollment = false } = {}) {
    const current = now();
    if (isStopped()) return false;
    const firstDay = firstSafeLocalEventDay(current);
    const targetDays = [firstDay, addCivilDays(firstDay, 1)];
    const boundedModel = typeof globalStepEventModel.findLocalParentsForEventDays === 'function';
    const existingParents = boundedModel
      ? await globalStepEventModel.findLocalParentsForEventDays(targetDays)
      : typeof globalStepEventModel.findLocalParentsForMaintenance === 'function'
        ? await globalStepEventModel.findLocalParentsForMaintenance(current) : [];
    enrollment.requestHead(boundedModel ? {} : { parents: existingParents || [] });
    if (flushEnrollment) await enrollment.runEnrollmentSlice({ isStopped });

    const retentionEnabled = true;
    let retentionHealthy = retentionEnabled;
    if (retentionEnabled) {
      try {
        const retention = await cleanupExpiredEntitlements({ now: current });
        retentionHealthy = retention?.healthy === true || typeof retention === "number";
        if (!retentionHealthy) {
          logger.error(
            `[CRON] Local global event retention blocked by ${retention?.blockedEntitlements ?? "unknown"} old lifecycle(s)`
          );
        }
      } catch (error) {
        retentionHealthy = false;
        logger.error("[CRON] Local global event retention failed:", error);
      }
    }

    const existingDays = new Set((existingParents || []).map((event) => event.eventDay));
    if (targetDays.every((eventDay) => existingDays.has(eventDay))) return true;

    let operationalSnapshot = null;
    try {
      operationalSnapshot = await captureOperationalSnapshot({ now: current });
      logger.log(`[CRON] Local global event operations ${JSON.stringify({
        observedAt: operationalSnapshot.observedAt,
        dueStarts: operationalSnapshot.dueStarts,
        dueEnds: operationalSnapshot.dueEnds,
        stalePendingStarts: operationalSnapshot.stalePendingStarts,
        invalidLocalParents: operationalSnapshot.invalidLocalParents,
        activeParents: operationalSnapshot.activeParents,
        activeEntitlements: operationalSnapshot.activeEntitlements,
        exposureZeroRaces: operationalSnapshot.exposureZeroRaces,
        exposureOneRaces: operationalSnapshot.exposureOneRaces,
        exposureMultipleRaces: operationalSnapshot.exposureMultipleRaces,
        exposureBuckets: operationalSnapshot.exposureBuckets,
        entitlementsByOffset: operationalSnapshot.entitlementsByOffset,
        rolloutCounters: operationalSnapshot.rolloutCounters,
        healthy: operationalSnapshot.healthy,
      })}`);
    } catch (error) {
      // Observability is an enablement guard, not a reason to abandon durable
      // maintenance or legacy-global scheduling.
      logger.error("[CRON] Local global event operational audit failed:", error);
    }

    if (!retentionHealthy) {
      logger.error("[CRON] Local global event creation rejected: retention is not enabled");
      return false;
    }
    if (operationalSnapshot?.healthy !== true) {
      logger.error("[CRON] Local global event creation rejected: operational audit is unhealthy");
      return false;
    }
    if (!(await cronOwnerGuard({ now: current }))) {
      logger.error("[CRON] Local global event creation rejected: cron owners are not all local-aware");
      return false;
    }
    for (const eventDay of targetDays) {
      if (isStopped()) return false;
      const parent = await globalStepEventModel.createLocalParentIfAbsent({ eventDay });
      if (parent?.event && (!boundedModel || parent.created)) {
        enrollment.addParent(parent.event);
        if (flushEnrollment) await enrollment.runEnrollmentSlice({ isStopped });
      }
      if (parent?.created) {
        logger.log(`[CRON] Local global step event materialized: ${eventDay}`);
      }
    }
    return true;
  }
  const tick = async function localGlobalStepEventTick({ isStopped = () => false } = {}) {
    if (!dependencies.skipEndBoundaries && !isStopped()) await processBoundaries({ now: now(), processStarts: false });
    return runMinuteMaintenance({ isStopped, flushEnrollment: true });
  };
  tick.runMinuteMaintenance = runMinuteMaintenance;
  tick.runEnrollmentSlice = enrollment.runEnrollmentSlice;
  tick.enrollmentSnapshot = enrollment.snapshot;
  return tick;
}

function buildMaybeStartGlobalEvent(dependencies = {}) {
  const globalStepEventModel = dependencies.GlobalStepEvent || GlobalStepEvent;
  const raceModel = dependencies.Race || Race;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const enqueue = dependencies.enqueueRaceResolution || enqueueRaceResolution;
  const boundaryCursor = dependencies.GlobalStepEventBoundaryCursor ||
    GlobalStepEventBoundaryCursor;
  const compatibilityEvents = dependencies.eventBus || null;

  const localTick = dependencies.localGlobalStepEventTick || buildLocalGlobalStepEventTick(dependencies);

  async function boundarySchedulingEnabled() { return true; }

  async function enqueueBoundaryForActiveRaces(at, isStopped = () => false) {
    const races = typeof raceModel.findActiveIds === "function"
      ? await raceModel.findActiveIds()
      : [];
    let complete = true;
    for (const race of races || []) {
      if (isStopped()) return false;
      const job = await enqueue({
        raceId: race.id,
        timeZone: race.timezone || "UTC",
        now: at,
        reason: "GLOBAL_EVENT_BOUNDARY",
        priority: "IMMEDIATE",
      });
      if (!job) complete = false;
    }
    return complete;
  }

  async function deliverDueBoundaries(at, isStopped = () => false) {
    if (isStopped()) return false;
    if (typeof boundaryCursor?.claim !== "function") return false;
    const claim = await boundaryCursor.claim({ now: at });
    if (!claim) return false;
    try {
      const boundary = await boundaryCursor.findLatestDue(claim, at);
      if (!boundary) {
        await boundaryCursor.release(claim, at);
        return true;
      }
      const persisted = await enqueueBoundaryForActiveRaces(at, isStopped);
      if (!persisted) {
        await boundaryCursor.release(claim, at);
        return false;
      }
      return boundaryCursor.advance(claim, boundary, at);
    } catch (error) {
      try { await boundaryCursor.release(claim, at); } catch {}
      throw error;
    }
  }

  // Returns the created event (or null if nothing started this tick).
  return async function maybeStartGlobalEvent(options = {}) {
    const currentTime = now();
    const isStopped = options.isStopped || (() => false);
    if (isStopped()) return null;

    if (options.minuteOnly && localTick.runMinuteMaintenance) await localTick.runMinuteMaintenance(options);
    else await localTick(options);
    if (isStopped()) return null;

    // Local mode materializes a safely future horizon. Until that horizon's
    // first event day arrives, the intervening days still need their legacy
    // global event. Always continue to the legacy decision: the event-day
    // advisory lock in createIfAbsentWithEnrollments is the authoritative
    // mode fence and returns created=false once a local parent owns the day.

    // A cluster-owned DB cursor coalesces all due event edges through the latest
    // crossing. Its lease is reclaimable after process loss, and the cursor is
    // advanced only after every active race has a durable FULL enqueue.
    if (await boundarySchedulingEnabled()) {
      await deliverDueBoundaries(currentTime, isStopped);
    }

    if (isStopped()) return null;

    // Idempotency input: events started in the last 24h (rolling window — see
    // findStartedSince for why this isn't a UTC calendar-day bucket).
    const todaysEvents =
      (await globalStepEventModel.findStartedSince(
        new Date(currentTime.getTime() - 24 * 60 * 60 * 1000)
      )) || [];

    if (isStopped()) return null;
    const decision = shouldStartGlobalEvent({
      now: currentTime,
      todaysEvents,
    });
    if (!decision) return null;

    const eventInput = {
      startsAt: decision.startsAt,
      endsAt: decision.endsAt,
      multiplier: decision.multiplier,
      label: dependencies.label ?? null,
    };
    const created = typeof globalStepEventModel.createIfAbsentWithEnrollments === "function"
      ? await globalStepEventModel.createIfAbsentWithEnrollments(eventInput)
      : typeof globalStepEventModel.createIfAbsent === "function"
      ? await globalStepEventModel.createIfAbsent(eventInput)
      : { event: await globalStepEventModel.create(eventInput), created: true };
    // A peer won the durable anchor fence. It owns the only fan-out; doing any
    // participant work here would be both duplicate delivery and needless load.
    if (!created.created) return null;
    const event = created.event;
    if (isStopped()) return event;

    // Make the newly-visible start boundary produce a newer FULL generation
    // before an older closure post-task can publish. The queue row is durable;
    // post-task supersession then drops the older snapshot.
    if (await boundarySchedulingEnabled()) {
      await deliverDueBoundaries(currentTime, isStopped);
    }

    logger.log(
      `[CRON] Global step event started: ${decision.multiplier}x ` +
        `${decision.startsAt.toISOString()} -> ${decision.endsAt.toISOString()}`
    );

    // Compatibility-only adapter for injected legacy callers. The production
    // model appends GLOBAL_STEP_EVENT_ACTIVATED_V1 in the creation transaction;
    // the scheduler itself has no notification dependency.
    if (compatibilityEvents) {
      let participantUserIds = created.participantUserIds || [];
      if (!Array.isArray(created.participantUserIds)) {
        try {
          participantUserIds =
            (await raceModel.findActiveParticipantUserIds()) || [];
        } catch (error) {
          logger.error("[CRON] Global event participant lookup failed:", error);
        }
      }
      compatibilityEvents.emit("GLOBAL_EVENT_STARTED", {
        eventId: event?.id,
        multiplier: decision.multiplier,
        startsAt: decision.startsAt,
        endsAt: decision.endsAt,
        participantUserIds,
      });
    }

    return event;
  };
}

const maybeStartGlobalEvent = buildMaybeStartGlobalEvent();

function scheduleGlobalStepEvents(dependencies = {}) {
  const interval = dependencies.intervalMs || SCHEDULER_INTERVAL_MS;
  const logger = dependencies.logger || console;
  const localTick = dependencies.localGlobalStepEventTick || buildLocalGlobalStepEventTick({ ...dependencies, skipEndBoundaries: true });
  const runFn = dependencies.maybeStartGlobalEvent || buildMaybeStartGlobalEvent({ ...dependencies,
    skipEndBoundaries: true, localGlobalStepEventTick: localTick });
  const { buildGlobalEventEndDrain } = require('./globalEventEndDrain');
  const endDrain = dependencies.endDrain || buildGlobalEventEndDrain(dependencies);
  const schedule = dependencies.setTimeout || setTimeout;
  const cancel = dependencies.clearTimeout || clearTimeout;
  const clock = dependencies.nowMs || Date.now;
  // Preserve the pre-existing exported injection contract: a supplied complete
  // minute job starts synchronously. The production stable controller always
  // drains due boundaries first. Neither adapter contains database algorithms.
  const legacyImmediate = Boolean(dependencies.maybeStartGlobalEvent && !dependencies.endDrain && !dependencies.localGlobalStepEventTick);
  let stopped = false, running = null, timer = null;
  const pending = { minute: clock(), end: clock(), enrollment: clock() };
  function requestMinute() {
    const current = clock();
    pending.minute = Math.min(pending.minute, current);
    pending.end = Math.min(pending.end, current);
  }
  function arm() {
    if (stopped || running) return;
    if (timer) cancel(timer);
    const earliest = Math.min(...Object.values(pending));
    if (!Number.isFinite(earliest)) { timer = null; return; }
    timer = schedule(() => { timer = null; void run(); }, Math.max(1, earliest - clock()));
    timer?.unref?.();
  }
  async function minute() {
    if (pending.minute > clock() || stopped) return;
    pending.minute = clock() + interval;
    try {
      await runFn({ minuteOnly: true, isStopped: () => stopped });
      pending.enrollment = Math.min(pending.enrollment, clock());
    } catch (error) {
      pending.minute = Math.min(pending.minute, clock() + 1000);
      logger.error('[CRON] Global step event scheduler error:', error);
    }
  }
  async function boundaries() {
    if (pending.end > clock() || stopped) return;
    const dueAt = pending.end;
    pending.end = clock() + interval;
    try {
      const result = await endDrain.run({ isStopped: () => stopped });
      if (result?.more) pending.end = Math.min(pending.end, clock() + Math.max(1, result.retryAfterMs || dependencies.endContinuationMs || 250));
    } catch (error) {
      pending.end = Math.min(pending.end, clock() + 1000);
      logger.error('[CRON] Global event end drain failed:', error);
    } finally {
      const { coordinatedOptimizationMetrics: metrics } = require('../../../shared/observability/coordinatedOptimizationMetrics');
      metrics.observe('global_event_enrollment_seconds', Math.max(0, clock() - dueAt) / 1000, { kind: 'boundary_service_latency' });
    }
  }
  function run() {
    if (stopped) return Promise.resolve(null);
    if (running) return running;
    if (timer) { cancel(timer); timer = null; }
    running = (async () => {
      if (legacyImmediate) { await minute(); await boundaries(); }
      else { await boundaries(); await minute(); }
      if (stopped || pending.enrollment > clock()) return;
      pending.enrollment = Infinity;
      try {
        const result = await localTick.runEnrollmentSlice?.({ isStopped: () => stopped });
        if (result?.more) pending.enrollment = Math.min(pending.enrollment, clock() + Math.max(1, result.retryAfterMs || 250));
      } catch (error) {
        pending.enrollment = Math.min(pending.enrollment, clock() + 1000);
        logger.error('[CRON] Global event enrollment continuation failed:', error);
      }
    })().finally(() => { running = null; arm(); });
    return running;
  }
  function tick() { if (stopped) return Promise.resolve(null); requestMinute(); return run(); }
  void run();
  // Existing injected interval owners remain supported; production has exactly
  // one earliest-deadline timer and no independent interval callback.
  const injectedInterval = dependencies.setInterval?.(tick, interval);
  injectedInterval?.unref?.();
  logger.log(`[CRON] Global step event scheduler scheduled (every ${interval / 1000}s)`);
  return {
    tick,
    async stop() {
      if (stopped) { await running; return; }
      stopped = true;
      if (timer) cancel(timer);
      timer = null;
      if (injectedInterval) clearInterval(injectedInterval);
      for (const key of Object.keys(pending)) pending[key] = Infinity;
      await running;
    },
  };
}

module.exports = {
  buildMaybeStartGlobalEvent,
  maybeStartGlobalEvent,
  scheduleGlobalStepEvents,
  SCHEDULER_INTERVAL_MS,
  GLOBAL_EVENT_DURATION_MS,
  buildLocalGlobalStepEventTick,
  firstSafeLocalEventDay,
  MATERIALIZATION_BATCH_SIZE,
};
