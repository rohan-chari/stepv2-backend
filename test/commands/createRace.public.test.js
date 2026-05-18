const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCreateRace,
  RaceCreationError,
} = require("../../src/commands/createRace");

function makeDeps(overrides = {}) {
  let createdRace = null;
  let createdParticipant = null;

  return {
    get createdRace() { return createdRace; },
    get createdParticipant() { return createdParticipant; },
    deps: {
      Race: {
        async create(payload) {
          createdRace = payload;
          return { id: "race-1", ...payload };
        },
        async findById(id) {
          return { id, creatorId: "user-1", name: "Test", targetSteps: 50000, participants: [] };
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
          return { id, coins: 5000 };
        },
        ...overrides.User,
      },
      awardCoins: async () => ({ awarded: true, coins: 0 }),
      eventBus: { emit() {} },
    },
  };
}

test("createRace accepts isPublic and persists it", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({
    userId: "user-1",
    name: "Open Run",
    targetSteps: 50000,
    isPublic: true,
  });

  assert.equal(ctx.createdRace.isPublic, true);
});

test("createRace defaults isPublic to false", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({
    userId: "user-1",
    name: "Closed",
    targetSteps: 50000,
  });

  assert.equal(ctx.createdRace.isPublic, false);
});

test("createRace accepts maxParticipants in [2, 100]", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({
    userId: "user-1",
    name: "Big",
    targetSteps: 50000,
    isPublic: true,
    maxParticipants: 50,
  });

  assert.equal(ctx.createdRace.maxParticipants, 50);
});

test("createRace defaults maxParticipants to 10", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({
    userId: "user-1",
    name: "Default",
    targetSteps: 50000,
  });

  assert.equal(ctx.createdRace.maxParticipants, 10);
});

test("createRace rejects maxParticipants below 2", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({
      userId: "user-1",
      name: "Too Small",
      targetSteps: 50000,
      maxParticipants: 1,
    }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("createRace rejects maxParticipants above 100", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({
      userId: "user-1",
      name: "Too Big",
      targetSteps: 50000,
      maxParticipants: 101,
    }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      return true;
    }
  );
});
