const { GlobalStepEvent } = require("../models/globalStepEvent");
const { Race } = require("../../races/models/race");
const { eventBus } = require("../../../shared/events/eventBus");
const {
  shouldStartGlobalEvent,
  GLOBAL_EVENT_DURATION_MS,
} = require("../globalStepEvent");

// The scheduler runs on the same 5-minute cadence as the other cron jobs in
// src/index.js. The "should an event start now?" decision is the PURE function
// shouldStartGlobalEvent; this job only does the DB read/write + push fan-out.
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

function buildMaybeStartGlobalEvent(dependencies = {}) {
  const globalStepEventModel = dependencies.GlobalStepEvent || GlobalStepEvent;
  const raceModel = dependencies.Race || Race;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  // Returns the created event (or null if nothing started this tick).
  return async function maybeStartGlobalEvent() {
    const currentTime = now();

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

    const event = await globalStepEventModel.create({
      startsAt: decision.startsAt,
      endsAt: decision.endsAt,
      multiplier: decision.multiplier,
      label: dependencies.label ?? null,
    });

    logger.log(
      `[CRON] Global step event started: ${decision.multiplier}x ` +
        `${decision.startsAt.toISOString()} -> ${decision.endsAt.toISOString()}`
    );

    // Fan-out target set: every distinct user currently in an ACTIVE race.
    let participantUserIds = [];
    try {
      participantUserIds =
        (await raceModel.findActiveParticipantUserIds()) || [];
    } catch (error) {
      logger.error("[CRON] Global event participant lookup failed:", error);
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

  async function run() {
    try {
      await runFn();
    } catch (error) {
      logger.error("[CRON] Global step event scheduler error:", error);
    }
  }

  run();
  setInterval(run, interval);
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
