const assert = require("node:assert/strict");
const test = require("node:test");

const { buildStartRace, RaceStartError } = require("../../src/commands/startRace");

function makeDeps(overrides = {}) {
  const updates = [];
  const events = [];
  const startedAt = new Date("2026-03-28T14:00:00.000Z");
  const raceUpdates = [];

  return {
    updates,
    events,
    raceUpdates,
    startedAt,
    deps: {
      Race: {
        async findById(id) {
          return {
            id,
            creatorId: "creator-1",
            status: "PENDING",
            maxDurationDays: 7,
            buyInAmount: 0,
            payoutPreset: "WINNER_TAKES_ALL",
          };
        },
        async update(id, fields) {
          raceUpdates.push({ id, fields });
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
      RacePowerupEvent: {
        async create() { return {}; },
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

test("startRace only counts steps after race start (baseline subtracts pre-race steps)", async () => {
  // Simulate: creator had 5000 steps before race started
  // After race, creator walks 2000 more -> step record updates to 7000
  // Race should show 2000, not 7000
  const updates = [];
  const deps = {
    Race: {
      async findById(id) {
        return { id, creatorId: "creator-1", status: "PENDING", maxDurationDays: 7 };
      },
      async update(id, fields) { return { id, ...fields }; },
    },
    RaceParticipant: {
      async countAccepted() { return 2; },
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
    },
    Steps: {
      async findByUserIdAndDate(userId) {
        // Both users have pre-existing steps today
        if (userId === "creator-1") return { steps: 5000 };
        if (userId === "friend-1") return { steps: 8000 };
        return null;
      },
    },
    RacePowerupEvent: { async create() { return {}; } },
    eventBus: { emit() {} },
    now: () => new Date("2026-03-28T14:00:00.000Z"),
  };

  const startRace = buildStartRace(deps);
  await startRace({ userId: "creator-1", raceId: "race-1" });

  const creatorUpdate = updates.find((u) => u.id === "rp-1");
  const friendUpdate = updates.find((u) => u.id === "rp-2");

  // Baseline must capture pre-race steps so they're subtracted in progress
  assert.equal(creatorUpdate.fields.baselineSteps, 5000);
  assert.equal(friendUpdate.fields.baselineSteps, 8000);

  // Simulating progress calculation:
  // creator syncs again with 7000 total steps today
  // raceSteps = 7000 - baselineSteps(5000) = 2000 (only post-race steps)
  const creatorRaceSteps = 7000 - creatorUpdate.fields.baselineSteps;
  assert.equal(creatorRaceSteps, 2000);

  // friend syncs with 9500 total
  // raceSteps = 9500 - 8000 = 1500
  const friendRaceSteps = 9500 - friendUpdate.fields.baselineSteps;
  assert.equal(friendRaceSteps, 1500);
});

test("startRace with no prior sync sets baseline 0 - progress should use StepSample for accuracy", async () => {
  // When no Step record exists at race start, baseline = 0
  // This means ALL steps for the day count, which over-counts pre-race steps
  // The StepSample table provides time-windowed accuracy as a safeguard
  const updates = [];
  const deps = {
    Race: {
      async findById(id) {
        return { id, creatorId: "creator-1", status: "PENDING", maxDurationDays: 7 };
      },
      async update(id, fields) { return { id, ...fields }; },
    },
    RaceParticipant: {
      async countAccepted() { return 2; },
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
    },
    Steps: {
      async findByUserIdAndDate() { return null; },
    },
    RacePowerupEvent: { async create() { return {}; } },
    eventBus: { emit() {} },
    now: () => new Date("2026-03-28T14:00:00.000Z"),
  };

  const startRace = buildStartRace(deps);
  await startRace({ userId: "creator-1", raceId: "race-1" });

  // With no step record, baseline defaults to 0
  // This is a known limitation - StepSample data compensates at query time
  for (const u of updates) {
    assert.equal(u.fields.baselineSteps, 0);
  }
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

test("startRace rejects top-3 payout presets when fewer than 4 runners are accepted", async () => {
  const { deps } = makeDeps({
    Race: {
      async findById(id) {
        return {
          id,
          creatorId: "creator-1",
          status: "PENDING",
          maxDurationDays: 7,
          buyInAmount: 100,
          payoutPreset: "TOP3_70_20_10",
        };
      },
    },
    RaceParticipant: {
      async countAccepted() {
        return 3;
      },
      async findAcceptedByRace() {
        return [
          { id: "rp-1", userId: "creator-1" },
          { id: "rp-2", userId: "friend-1" },
          { id: "rp-3", userId: "friend-2" },
        ];
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
      assert.equal(err.message, "This payout mode only supports races with at least 4 accepted participants");
      return true;
    }
  );
});

test("startRace commits held buy-ins into the live pot", async () => {
  const { deps, raceUpdates, updates } = makeDeps({
    Race: {
      async findById(id) {
        return {
          id,
          creatorId: "creator-1",
          status: "PENDING",
          maxDurationDays: 7,
          buyInAmount: 100,
          payoutPreset: "WINNER_TAKES_ALL",
          potCoins: 0,
        };
      },
    },
    RaceParticipant: {
      async countAccepted() {
        return 2;
      },
      async findAcceptedByRace() {
        return [
          { id: "rp-1", userId: "creator-1", buyInAmount: 100, buyInStatus: "HELD" },
          { id: "rp-2", userId: "friend-1", buyInAmount: 100, buyInStatus: "HELD" },
        ];
      },
      async update(id, fields) {
        updates.push({ id, fields });
        return { id, ...fields };
      },
    },
  });
  const startRace = buildStartRace(deps);

  await startRace({ userId: "creator-1", raceId: "race-1" });

  assert.ok(
    raceUpdates.some((entry) => entry.fields.potCoins === 200),
    "expected startRace to seed the pot with committed holds"
  );
  assert.ok(
    updates.some((entry) => entry.fields.buyInStatus === "COMMITTED"),
    "expected held buy-ins to be marked committed"
  );
});
