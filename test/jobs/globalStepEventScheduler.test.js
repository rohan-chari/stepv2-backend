const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildMaybeStartGlobalEvent,
  scheduleGlobalStepEvents,
  SCHEDULER_INTERVAL_MS,
} = require("../../src/modules/steps/jobs/globalStepEventScheduler");
const {
  chooseEventStartForEtDay,
  GLOBAL_EVENT_DURATION_MS,
  GLOBAL_EVENT_MULTIPLIER,
} = require("../../src/modules/steps/globalStepEvent");
const { zonedDateTimeToUtc } = require("../../src/shared/time/week");

// ---------------------------------------------------------------------------
// Scheduler job (DB read/write + push fan-out). The PURE decision is tested in
// test/utils/globalStepEventSchedule.test.js; here we verify the job wires the
// decision to model.create + an event-bus fan-out, and is idempotent.
//
// Idempotency now reads events STARTED IN THE LAST 24H (findStartedSince), not
// "created on this UTC day" — an ET-evening event and the next tick can land on
// different UTC calendar days, which would defeat UTC-day bucketing.
// ---------------------------------------------------------------------------

function makeCtx({ recentEvents = [], participantUserIds = [] } = {}) {
  const created = [];
  const emitted = [];
  const sinceCalls = [];
  let participantReads = 0;
  let createdEvent = null;
  return {
    created,
    emitted,
    sinceCalls,
    get participantReads() { return participantReads; },
    deps: {
      localGlobalStepEventTick: async () => false,
      GlobalStepEvent: {
        async findStartedSince(since) {
          sinceCalls.push(since);
          return recentEvents;
        },
        async create(data) {
          const event = { id: `gse-${created.length + 1}`, ...data };
          created.push(event);
          return event;
        },
        async createIfAbsent(data) {
          if (createdEvent) return { event: createdEvent, created: false };
          createdEvent = { id: `gse-${created.length + 1}`, ...data };
          created.push(createdEvent);
          return { event: createdEvent, created: true };
        },
      },
      Race: {
        async findActiveParticipantUserIds() {
          participantReads += 1;
          return participantUserIds;
        },
      },
      eventBus: {
        emit(name, payload) {
          emitted.push({ name, payload });
        },
      },
      logger: { log() {}, error() {} },
    },
  };
}

// The chosen start instant for Mon 2026-06-08 (ET).
function chosenNow() {
  const day = zonedDateTimeToUtc(
    { year: 2026, month: 6, day: 8, hour: 12, minute: 0 },
    "America/New_York"
  );
  return chooseEventStartForEtDay(day);
}

test("creates an event and fans out to active-race participants at the chosen time", async () => {
  const now = chosenNow();
  const ctx = makeCtx({
    recentEvents: [],
    participantUserIds: ["user-1", "user-2", "user-3"],
  });

  const run = buildMaybeStartGlobalEvent({ ...ctx.deps, now: () => now });
  const event = await run();

  assert.ok(event, "an event is created");
  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.created[0].multiplier, GLOBAL_EVENT_MULTIPLIER);
  assert.equal(
    ctx.created[0].endsAt.getTime(),
    now.getTime() + GLOBAL_EVENT_DURATION_MS
  );

  // Idempotency lookback covers a full day (survives the UTC-midnight straddle).
  assert.equal(ctx.sinceCalls.length, 1);
  assert.equal(
    now.getTime() - ctx.sinceCalls[0].getTime(),
    24 * 60 * 60 * 1000
  );

  assert.equal(ctx.emitted.length, 1);
  assert.equal(ctx.emitted[0].name, "GLOBAL_EVENT_STARTED");
  assert.equal(
    ctx.emitted[0].payload.eventId,
    event.id,
    "the persisted event id is the durable notification intent"
  );
  assert.deepEqual(ctx.emitted[0].payload.participantUserIds, [
    "user-1",
    "user-2",
    "user-3",
  ]);
  assert.equal(ctx.emitted[0].payload.multiplier, GLOBAL_EVENT_MULTIPLIER);
});

test("local future-horizon maintenance does not suppress an unfenced legacy day", async () => {
  const now = chosenNow();
  const ctx = makeCtx({
    recentEvents: [],
    participantUserIds: ["user-1"],
  });

  const run = buildMaybeStartGlobalEvent({
    ...ctx.deps,
    now: () => now,
    // Local mode can be healthy while its first parent is still days away.
    // The event-day creation fence, not this maintenance result, decides
    // whether today's legacy event has already been claimed by local mode.
    localGlobalStepEventTick: async () => true,
  });

  const event = await run();

  assert.ok(event, "the still-unclaimed day receives its legacy event");
  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.emitted.length, 1);
});

test("idempotent: does not create a second event when one already exists for the chosen time", async () => {
  const now = chosenNow();
  const ctx = makeCtx({
    recentEvents: [
      {
        startsAt: new Date(now.getTime()),
        endsAt: new Date(now.getTime() + GLOBAL_EVENT_DURATION_MS),
        multiplier: GLOBAL_EVENT_MULTIPLIER,
      },
    ],
    participantUserIds: ["user-1"],
  });

  const run = buildMaybeStartGlobalEvent({ ...ctx.deps, now: () => now });
  const event = await run();

  assert.equal(event, null, "no event created");
  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.emitted.length, 0, "no fan-out when nothing started");
  assert.equal(ctx.participantReads, 0, "idempotency-only ticks avoid active-racer reads");
});

test("concurrent ticks retain one event and the losing tick skips heavy participant work", async () => {
  const now = chosenNow();
  const ctx = makeCtx({ recentEvents: [], participantUserIds: ["user-1"] });
  const first = buildMaybeStartGlobalEvent({ ...ctx.deps, now: () => now });
  const second = buildMaybeStartGlobalEvent({ ...ctx.deps, now: () => now });
  const results = await Promise.all([first(), second()]);

  assert.equal(ctx.created.length, 1);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(ctx.emitted.length, 1);
  assert.equal(ctx.participantReads, 1);
});

test("uses the creation transaction's enrollment snapshot for the only fan-out", async () => {
  const now = chosenNow();
  const emitted = [];
  let legacyParticipantRead = 0;
  const run = buildMaybeStartGlobalEvent({
    now: () => now,
    localGlobalStepEventTick: async () => false,
    GlobalStepEvent: {
      async findStartedSince() { return []; },
      async createIfAbsentWithEnrollments(data) {
        return {
          created: true,
          event: { id: "gse-atomic", ...data },
          participantUserIds: ["user-1", "user-2"],
        };
      },
    },
    Race: {
      async findActiveParticipantUserIds() {
        legacyParticipantRead += 1;
        return ["wrong-user"];
      },
    },
    eventBus: { emit(name, payload) { emitted.push({ name, payload }); } },
    logger: { log() {}, error() {} },
  });

  await run();

  assert.equal(legacyParticipantRead, 0);
  assert.deepEqual(emitted[0].payload.participantUserIds, ["user-1", "user-2"]);
});

test("does nothing when now is before the chosen time", async () => {
  const now = new Date(chosenNow().getTime() - 60 * 1000);
  const ctx = makeCtx({ participantUserIds: ["user-1"] });

  const run = buildMaybeStartGlobalEvent({ ...ctx.deps, now: () => now });
  const event = await run();

  assert.equal(event, null);
  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.emitted.length, 0);
  assert.equal(ctx.participantReads, 0, "ordinary ticks do not read active racers");
});

test("uses a one-minute default interval", async () => {
  let scheduledMs = null;
  let runs = 0;
  scheduleGlobalStepEvents({
    maybeStartGlobalEvent: async () => { runs += 1; },
    setInterval(fn, ms) { scheduledMs = ms; return { unref() {} }; },
    logger: { log() {}, error() {} },
  });
  // run() is async, so only assert the synchronous schedule contract here.
  assert.equal(SCHEDULER_INTERVAL_MS, 60 * 1000);
  assert.equal(scheduledMs, 60 * 1000);
  assert.equal(runs, 1, "the scheduler still executes an immediate lightweight tick");
});
