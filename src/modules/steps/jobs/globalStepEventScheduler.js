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
  materializeEntitlementsForActiveRacers,
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

function addCivilDays(day, amount) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function firstSafeLocalEventDay(now) {
  const threshold = new Date(now).getTime() + 24 * 60 * 60 * 1000;
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
  const materialize = dependencies.materializeEntitlementsForActiveRacers ||
    materializeEntitlementsForActiveRacers;
  const processBoundaries = dependencies.processDueEntitlementBoundaries ||
    processDueEntitlementBoundaries;
  const logger = dependencies.logger || console;
  const cronOwnerGuard = dependencies.cronOwnerGuard || heartbeatCronOwnerAndCheck;
  const captureOperationalSnapshot = dependencies.captureOperationalSnapshot ||
    captureDefaultOperationalSnapshot;
  const cleanupExpiredEntitlements = dependencies.cleanupExpiredEntitlements ||
    cleanupDefaultExpiredEntitlements;
  const materializationTickBudgetMs = Math.max(
    1,
    Number(dependencies.materializationTickBudgetMs) || 5000
  );
  return async function localGlobalStepEventTick() {
    const current = now();
    // Maintenance is fail-open with respect to creation switches: once a local
    // parent exists its entitlements and due edges remain contractual data.
    // Starts are drained before lower-priority fan-out so a large cohort cannot
    // make an on-time edge stale while future parents are being prepared.
    await processBoundaries({ now: current });
    const materializationStarted = Date.now();
    async function drainParent(event) {
      let afterUserId = null;
      for (;;) {
        if (Date.now() - materializationStarted >= materializationTickBudgetMs) break;
        const page = await materialize(event, {
          now: current,
          batchSize: 100,
          afterUserId,
          returnPage: true,
        });
        // Compatibility for narrow injected doubles and old internal callers.
        if (typeof page === "number") {
          if (page !== 100) break;
          continue;
        }
        if (!page || page.exhausted) break;
        if (!page.nextCursor || page.nextCursor === afterUserId) break;
        afterUserId = page.nextCursor;
      }
    }
    const existingParents =
      typeof globalStepEventModel.findLocalParentsForMaintenance === "function"
        ? await globalStepEventModel.findLocalParentsForMaintenance(current)
        : [];
    for (const event of existingParents || []) {
      await drainParent(event);
      if (Date.now() - materializationStarted >= materializationTickBudgetMs) break;
    }

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
    const firstDay = firstSafeLocalEventDay(current);
    for (const eventDay of [firstDay, addCivilDays(firstDay, 1)]) {
      const parent = await globalStepEventModel.createLocalParentIfAbsent({ eventDay });
      if (parent?.event) await drainParent(parent.event);
      if (parent?.created) {
        logger.log(`[CRON] Local global step event materialized: ${eventDay}`);
      }
    }
    return true;
  };
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

  async function boundarySchedulingEnabled() { return true; }

  async function enqueueBoundaryForActiveRaces(at) {
    const races = typeof raceModel.findActiveIds === "function"
      ? await raceModel.findActiveIds()
      : [];
    let complete = true;
    for (const race of races || []) {
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

  async function deliverDueBoundaries(at) {
    if (typeof boundaryCursor?.claim !== "function") return false;
    const claim = await boundaryCursor.claim({ now: at });
    if (!claim) return false;
    try {
      const boundary = await boundaryCursor.findLatestDue(claim, at);
      if (!boundary) {
        await boundaryCursor.release(claim, at);
        return true;
      }
      const persisted = await enqueueBoundaryForActiveRaces(at);
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
  return async function maybeStartGlobalEvent() {
    const currentTime = now();

    const localTick = dependencies.localGlobalStepEventTick ||
      buildLocalGlobalStepEventTick({ ...dependencies, now: () => currentTime });
    await localTick();

    // Local mode materializes a safely future horizon. Until that horizon's
    // first event day arrives, the intervening days still need their legacy
    // global event. Always continue to the legacy decision: the event-day
    // advisory lock in createIfAbsentWithEnrollments is the authoritative
    // mode fence and returns created=false once a local parent owns the day.

    // A cluster-owned DB cursor coalesces all due event edges through the latest
    // crossing. Its lease is reclaimable after process loss, and the cursor is
    // advanced only after every active race has a durable FULL enqueue.
    if (await boundarySchedulingEnabled()) {
      await deliverDueBoundaries(currentTime);
    }

    // Idempotency input: events started in the last 24h (rolling window — see
    // findStartedSince for why this isn't a UTC calendar-day bucket).
    const todaysEvents =
      (await globalStepEventModel.findStartedSince(
        new Date(currentTime.getTime() - 24 * 60 * 60 * 1000)
      )) || [];

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

    // Make the newly-visible start boundary produce a newer FULL generation
    // before an older closure post-task can publish. The queue row is durable;
    // post-task supersession then drops the older snapshot.
    if (await boundarySchedulingEnabled()) {
      await deliverDueBoundaries(currentTime);
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
  const runFn = dependencies.maybeStartGlobalEvent || maybeStartGlobalEvent;
  const schedule = dependencies.setInterval || setInterval;

  async function run() {
    try {
      await runFn();
    } catch (error) {
      logger.error("[CRON] Global step event scheduler error:", error);
    }
  }

  run();
  const timer = schedule(run, interval);
  timer?.unref?.();
  logger.log(
    `[CRON] Global step event scheduler scheduled (every ${interval / 1000}s)`
  );
}

module.exports = {
  buildMaybeStartGlobalEvent,
  maybeStartGlobalEvent,
  scheduleGlobalStepEvents,
  SCHEDULER_INTERVAL_MS,
  GLOBAL_EVENT_DURATION_MS,
  buildLocalGlobalStepEventTick,
  firstSafeLocalEventDay,
};
