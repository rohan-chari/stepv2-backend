const assert = require("node:assert/strict");
const test = require("node:test");

const { buildStartRace, RaceStartError } = require("../../src/commands/startRace");

function makeDeps(overrides = {}) {
  const updates = [];
  const events = [];
  const startedAt = new Date("2026-03-28T14:00:00.000Z");

  return {
    updates,
    events,
    startedAt,
    deps: {
      Race: {
        async findById(id) {
          return {
            id,
            creatorId: "creator-1",
            status: "PENDING",
            maxDurationDays: 7,
          };
        },
        async update(id, fields) {
          return { id, ...fields };
        },
        ...overrides.Race,
      },
      RaceParticipant: {
        async countAccepted() {
          return 2;
        },
        async findAcceptedByRace() {
          return [
            { id: "rp-1", userId: "creator-1" },
            { id: "rp-2", userId: "friend-1" },
          ];
        },
        async update(id, fields) {
          updates.push({ id, fields });
          return { id, ...fields };
        },
        ...overrides.RaceParticipant,
      },
      Steps: {
        async findByUserIdAndDate(userId) {
          if (userId === "creator-1") return { steps: 5000 };
          if (userId === "friend-1") return { steps: 3200 };
          return null;
        },
        ...overrides.Steps,
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      now: () => startedAt,
    },
  };
}

test("startRace snapshots baseline steps for each accepted participant", async () => {
  const { deps, updates } = makeDeps();
  const startRace = buildStartRace(deps);

  await startRace({ userId: "creator-1", raceId: "race-1" });

  assert.equal(updates.length, 2);

  const creatorUpdate = updates.find((u) => u.id === "rp-1");
  assert.equal(creatorUpdate.fields.baselineSteps, 5000);

  const friendUpdate = updates.find((u) => u.id === "rp-2");
  assert.equal(friendUpdate.fields.baselineSteps, 3200);
});

test("startRace sets joinedAt to the start time for each participant", async () => {
  const { deps, updates, startedAt } = makeDeps();
  const startRace = buildStartRace(deps);

  await startRace({ userId: "creator-1", raceId: "race-1" });

  for (const u of updates) {
    assert.equal(u.fields.joinedAt, startedAt);
  }
});

test("startRace sets baseline to 0 when participant has no steps today", async () => {
  const { deps, updates } = makeDeps({
    Steps: {
      async findByUserIdAndDate() {
        return null;
      },
    },
  });
  const startRace = buildStartRace(deps);

  await startRace({ userId: "creator-1", raceId: "race-1" });

  for (const u of updates) {
    assert.equal(u.fields.baselineSteps, 0);
  }
});

test("startRace emits RACE_STARTED event", async () => {
  const { deps, events } = makeDeps();
  const startRace = buildStartRace(deps);

  await startRace({ userId: "creator-1", raceId: "race-1" });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "RACE_STARTED");
  assert.deepEqual(events[0].payload.participantUserIds, ["creator-1", "friend-1"]);
});

test("startRace rejects when caller is not the creator", async () => {
  const { deps } = makeDeps();
  const startRace = buildStartRace(deps);

  await assert.rejects(
    () => startRace({ userId: "someone-else", raceId: "race-1" }),
    (err) => {
      assert.ok(err instanceof RaceStartError);
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

test("startRace rejects when fewer than 2 accepted participants", async () => {
  const { deps } = makeDeps({
    RaceParticipant: {
      async countAccepted() {
        return 1;
      },
      async findAcceptedByRace() {
        return [{ id: "rp-1", userId: "creator-1" }];
      },
      async update() {},
    },
  });
  const startRace = buildStartRace(deps);

  await assert.rejects(
    () => startRace({ userId: "creator-1", raceId: "race-1" }),
    (err) => {
      assert.ok(err instanceof RaceStartError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("startRace rejects when race is not PENDING", async () => {
  const { deps } = makeDeps({
    Race: {
      async findById(id) {
        return { id, creatorId: "creator-1", status: "ACTIVE", maxDurationDays: 7 };
      },
    },
  });
  const startRace = buildStartRace(deps);

  await assert.rejects(
    () => startRace({ userId: "creator-1", raceId: "race-1" }),
    (err) => {
      assert.ok(err instanceof RaceStartError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});
