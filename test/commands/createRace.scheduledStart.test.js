const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCreateRace,
  RaceCreationError,
} = require("../../src/modules/races/commands/createRace");

// ---------------------------------------------------------------------------
// 1.1.7 — scheduled race start. createRace accepts an OPTIONAL future
// scheduledStartAt. The race is still created in PENDING; an auto-start cron
// job (tested separately) starts it once the scheduled time arrives.
//
// Built with DI mocks (no DB), mirroring test/commands/createRace.test.js.
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  const events = [];
  let createdRace = null;
  let createdParticipant = null;
  const awards = [];

  return {
    events,
    awards,
    get createdRace() {
      return createdRace;
    },
    get createdParticipant() {
      return createdParticipant;
    },
    deps: {
      Race: {
        async create(payload) {
          createdRace = payload;
          return { id: "race-1", status: "PENDING", ...payload };
        },
        async findById(id) {
          return {
            id,
            creatorId: "user-1",
            name: "Test",
            status: "PENDING",
            scheduledStartAt: createdRace?.scheduledStartAt ?? null,
            participants: [],
          };
        },
        ...overrides.Race,
      },
      RaceParticipant: {
        async create(payload) {
          createdParticipant = payload;
          return { id: "rp-1", ...payload };
        },
        ...overrides.RaceParticipant,
      },
      User: {
        async findById(id) {
          return { id, coins: 500 };
        },
        ...overrides.User,
      },
      awardCoins: async (payload) => {
        awards.push(payload);
        return { awarded: true, coins: 0 };
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
    },
  };
}

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000); // +1 day
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000); // -1 day

test("createRace stores a future scheduledStartAt and leaves the race PENDING", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  const race = await createRace({
    userId: "user-1",
    name: "Scheduled Race",
    maxDurationDays: 7,
    scheduledStartAt: FUTURE.toISOString(),
  });

  assert.ok(ctx.createdRace.scheduledStartAt, "scheduledStartAt persisted");
  assert.equal(
    new Date(ctx.createdRace.scheduledStartAt).toISOString(),
    FUTURE.toISOString()
  );
  // Race must NOT be auto-started by createRace — stays PENDING.
  assert.equal(race.status, "PENDING");
  // No RACE_STARTED on creation.
  assert.ok(!ctx.events.some((e) => e.event === "RACE_STARTED"));
});

test("createRace omits scheduledStartAt (null) when not provided — unchanged behavior", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({ userId: "user-1", name: "Instant Race" });

  assert.equal(ctx.createdRace.scheduledStartAt ?? null, null);
});

test("createRace rejects a scheduledStartAt in the past", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () =>
      createRace({
        userId: "user-1",
        name: "Past Race",
        scheduledStartAt: PAST.toISOString(),
      }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("createRace ignores an unparseable scheduledStartAt (stores null)", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({
    userId: "user-1",
    name: "Garbage Date",
    scheduledStartAt: "not-a-date",
  });

  assert.equal(ctx.createdRace.scheduledStartAt ?? null, null);
});

test("createRace accepts a Date instance for scheduledStartAt", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({
    userId: "user-1",
    name: "Date Object Race",
    scheduledStartAt: FUTURE,
  });

  assert.ok(ctx.createdRace.scheduledStartAt);
  assert.equal(
    new Date(ctx.createdRace.scheduledStartAt).toISOString(),
    FUTURE.toISOString()
  );
});
