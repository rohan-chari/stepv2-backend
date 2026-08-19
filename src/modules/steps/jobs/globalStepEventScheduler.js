const { GlobalStepEvent } = require("../models/globalStepEvent");
const {
  GlobalStepEventBoundaryCursor,
} = require("../models/globalStepEventBoundaryCursor");
const { Race } = require("../../races/models/race");
const { eventBus } = require("../../../shared/events/eventBus");
const { appSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const {
  dependencyClosureRolloutPercent,
} = require("../../races/services/raceResolutionDependencyClosureRollout");
const {
  enqueueRaceResolution,
} = require("../../races/services/enqueueRaceResolution");
const {
  shouldStartGlobalEvent,
  GLOBAL_EVENT_DURATION_MS,
} = require("../globalStepEvent");

// The scheduler runs once per minute. The "should an event start now?" decision is the PURE function
// shouldStartGlobalEvent; this job only does the DB read/write + push fan-out.
const SCHEDULER_INTERVAL_MS = 60 * 1000; // every minute

function buildMaybeStartGlobalEvent(dependencies = {}) {
  const globalStepEventModel = dependencies.GlobalStepEvent || GlobalStepEvent;
  const raceModel = dependencies.Race || Race;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const settings = dependencies.appSettings || appSettings;
  const enqueue = dependencies.enqueueRaceResolution || enqueueRaceResolution;
  const boundaryCursor = dependencies.GlobalStepEventBoundaryCursor ||
    GlobalStepEventBoundaryCursor;

  async function boundarySchedulingEnabled() {
    const enabled = await isStrictFlagEnabled(
      settings,
      "raceResolutionDependencyClosureV1Enabled"
    );
    if (!enabled) return false;
    return (await dependencyClosureRolloutPercent(settings, true)) > 0;
  }

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

    // Fan-out target set: every distinct user currently in an ACTIVE race.
    let participantUserIds = created.participantUserIds || [];
    if (!Array.isArray(created.participantUserIds)) {
      try {
        participantUserIds =
          (await raceModel.findActiveParticipantUserIds()) || [];
      } catch (error) {
        logger.error("[CRON] Global event participant lookup failed:", error);
      }
    }

    // Emit on the shared event bus; notificationHandlers.js handles the actual
    // APNs push. Kept additive — old handlers ignore the unknown event.
    events.emit("GLOBAL_EVENT_STARTED", {
      eventId: event?.id,
      multiplier: decision.multiplier,
      startsAt: decision.startsAt,
      endsAt: decision.endsAt,
      participantUserIds,
    });

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
};
