const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildMaybeStartGlobalEvent,
} = require("../../src/jobs/globalStepEventScheduler");
const {
  chooseEventStartForEtDay,
  GLOBAL_EVENT_DURATION_MS,
  GLOBAL_EVENT_MULTIPLIER,
} = require("../../src/utils/globalStepEvent");
const { zonedDateTimeToUtc } = require("../../src/utils/week");

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
  return {
    created,
    emitted,
    sinceCalls,
    deps: {
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
      },
      Race: {
        async findActiveParticipantUserIds() {
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
  assert.deepEqual(ctx.emitted[0].payload.participantUserIds, [
    "user-1",
    "user-2",
    "user-3",
  ]);
  assert.equal(ctx.emitted[0].payload.multiplier, GLOBAL_EVENT_MULTIPLIER);
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
});

test("does nothing when now is before the chosen time", async () => {
  const now = new Date(chosenNow().getTime() - 60 * 1000);
  const ctx = makeCtx({ participantUserIds: ["user-1"] });

  const run = buildMaybeStartGlobalEvent({ ...ctx.deps, now: () => now });
  const event = await run();

  assert.equal(event, null);
  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.emitted.length, 0);
});
