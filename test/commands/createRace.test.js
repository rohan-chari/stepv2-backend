const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCreateRace,
  RaceCreationError,
} = require("../../src/commands/createRace");

function makeDeps(overrides = {}) {
  const events = [];
  let createdParticipant = null;
  const awards = [];
  let createdRace = null;

  return {
    events,
    awards,
    get createdRace() { return createdRace; },
    get createdParticipant() { return createdParticipant; },
    deps: {
      Race: {
        async create(payload) {
          createdRace = payload;
          return { id: "race-1", ...payload };
        },
        async findById(id) {
          return { id, creatorId: "user-1", name: "Test", participants: [] };
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

test("createRace persists maxDurationDays on new races (time-based)", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({ userId: "user-1", name: "Weekend Warriors", maxDurationDays: 5 });

  assert.equal(ctx.createdRace.maxDurationDays, 5);
});

test("createRace defaults maxDurationDays to 7 when not provided", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({ userId: "user-1", name: "Default Duration" });

  assert.equal(ctx.createdRace.maxDurationDays, 7);
});

test("createRace creates race and adds creator as ACCEPTED participant", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({ userId: "user-1", name: "Test Race" });

  assert.equal(ctx.createdParticipant.userId, "user-1");
  assert.equal(ctx.createdParticipant.status, "ACCEPTED");
  assert.equal(ctx.events[0].event, "RACE_CREATED");
});

test("createRace rejects empty name", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({ userId: "user-1", name: "" }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

// Uses the REAL bad-words filter (like displayNameValidator.test.js) so this
// guards the actual censor wiring, not a mock.
test("createRace rejects a profane name", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({ userId: "user-1", name: "total shit race" }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /inappropriate/i);
      return true;
    }
  );
});

test("createRace still accepts a clean name", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({ userId: "user-1", name: "Weekend Warriors" });

  assert.equal(ctx.createdRace.name, "Weekend Warriors");
});

test("createRace rejects duration outside 1-30 range", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({ userId: "user-1", name: "Test", maxDurationDays: 0 }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );

  await assert.rejects(
    () => createRace({ userId: "user-1", name: "Test", maxDurationDays: 31 }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("createRace trims the name", async () => {
  let capturedName;
  const { deps } = makeDeps({
    Race: {
      async create({ name }) {
        capturedName = name;
        return { id: "race-1", name };
      },
      async findById(id) {
        return { id, participants: [] };
      },
    },
  });
  const createRace = buildCreateRace(deps);

  await createRace({ userId: "user-1", name: "  Trimmed  " });

  assert.equal(capturedName, "Trimmed");
});

test("createRace reserves the creator buy-in immediately", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({
    userId: "user-1",
    name: "Paid Race",
    buyInAmount: 100,
    payoutPreset: "WINNER_TAKES_ALL",
  });

  assert.equal(ctx.createdRace.buyInAmount, 100);
  assert.equal(ctx.createdRace.payoutPreset, "WINNER_TAKES_ALL");
  assert.equal(ctx.createdParticipant.buyInAmount, 100);
  assert.equal(ctx.createdParticipant.buyInStatus, "HELD");
  assert.deepEqual(ctx.awards[0], {
    userId: "user-1",
    amount: -100,
    reason: "race_buy_in_hold",
    refId: "race-1:user-1",
  });
});

test("createRace rejects when the creator cannot afford the buy-in", async () => {
  const { deps } = makeDeps({
    User: {
      async findById(id) {
        return { id, coins: 25 };
      },
    },
  });
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({
      userId: "user-1",
      name: "Paid Race",
      buyInAmount: 100,
      payoutPreset: "WINNER_TAKES_ALL",
    }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, "You do not have enough coins for this buy-in");
      return true;
    }
  );
});
