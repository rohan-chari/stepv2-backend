const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildMaybeStartGlobalEvent,
} = require("../../src/jobs/globalStepEventScheduler");
const {
  computeAnchorTimesForDay,
  GLOBAL_EVENT_DURATION_MS,
  GLOBAL_EVENT_MULTIPLIER,
} = require("../../src/utils/globalStepEvent");

// ---------------------------------------------------------------------------
// Scheduler job (DB read/write + push fan-out). The PURE decision is tested in
// test/utils/globalStepEventSchedule.test.js; here we verify the job wires the
// decision to model.create + an event-bus fan-out, and is idempotent.
//
// Built with DI mocks (no DB), mirroring the seededRaceRenewal test style.
// ---------------------------------------------------------------------------

function makeCtx({ todaysEvents = [], participantUserIds = [] } = {}) {
  const created = [];
  const emitted = [];
  return {
    created,
    emitted,
    deps: {
      GlobalStepEvent: {
        async findCreatedOnUtcDay() {
          return todaysEvents;
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

// A `now` exactly at the first anchor of the day.
function anchorNow() {
  const anchors = computeAnchorTimesForDay(new Date(Date.UTC(2026, 5, 2)));
  return new Date(anchors[0].getTime());
}

test("creates an event and fans out to active-race participants at an anchor", async () => {
  const now = anchorNow();
  const ctx = makeCtx({
    todaysEvents: [],
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

  assert.equal(ctx.emitted.length, 1);
  assert.equal(ctx.emitted[0].name, "GLOBAL_EVENT_STARTED");
  assert.deepEqual(ctx.emitted[0].payload.participantUserIds, [
    "user-1",
    "user-2",
    "user-3",
  ]);
  assert.equal(ctx.emitted[0].payload.multiplier, GLOBAL_EVENT_MULTIPLIER);
});

test("idempotent: does not create a second event when one already exists for the anchor", async () => {
  const now = anchorNow();
  const ctx = makeCtx({
    todaysEvents: [
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

test("does nothing when now is not near any anchor", async () => {
  const anchors = computeAnchorTimesForDay(new Date(Date.UTC(2026, 5, 2)));
  // 1 minute before the first anchor — outside the (after-anchor) catch window.
  const now = new Date(anchors[0].getTime() - 60 * 1000);
  const ctx = makeCtx({ participantUserIds: ["user-1"] });

  const run = buildMaybeStartGlobalEvent({ ...ctx.deps, now: () => now });
  const event = await run();

  assert.equal(event, null);
  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.emitted.length, 0);
});
