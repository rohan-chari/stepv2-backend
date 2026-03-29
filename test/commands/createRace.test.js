const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCreateRace,
  RaceCreationError,
} = require("../../src/commands/createRace");

function makeDeps(overrides = {}) {
  const events = [];
  let createdParticipant = null;

  return {
    events,
    get createdParticipant() { return createdParticipant; },
    deps: {
      Race: {
        async create({ creatorId, name, targetSteps, maxDurationDays }) {
          return { id: "race-1", creatorId, name, targetSteps, maxDurationDays };
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
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
    },
  };
}

test("createRace creates race and adds creator as ACCEPTED participant", async () => {
  const ctx = makeDeps();
  const createRace = buildCreateRace(ctx.deps);

  await createRace({ userId: "user-1", name: "Test Race", targetSteps: 50000 });

  assert.equal(ctx.createdParticipant.userId, "user-1");
  assert.equal(ctx.createdParticipant.status, "ACCEPTED");
  assert.equal(ctx.events[0].event, "RACE_CREATED");
});

test("createRace rejects empty name", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({ userId: "user-1", name: "", targetSteps: 50000 }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("createRace rejects target steps below 1000", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({ userId: "user-1", name: "Test", targetSteps: 500 }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("createRace rejects target steps above 1000000", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({ userId: "user-1", name: "Test", targetSteps: 2000000 }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("createRace rejects duration outside 1-30 range", async () => {
  const { deps } = makeDeps();
  const createRace = buildCreateRace(deps);

  await assert.rejects(
    () => createRace({ userId: "user-1", name: "Test", targetSteps: 50000, maxDurationDays: 0 }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
      return true;
    }
  );

  await assert.rejects(
    () => createRace({ userId: "user-1", name: "Test", targetSteps: 50000, maxDurationDays: 31 }),
    (err) => {
      assert.ok(err instanceof RaceCreationError);
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

  await createRace({ userId: "user-1", name: "  Trimmed  ", targetSteps: 50000 });

  assert.equal(capturedName, "Trimmed");
});
