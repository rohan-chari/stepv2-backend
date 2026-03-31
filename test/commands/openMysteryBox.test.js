const assert = require("node:assert/strict");
const test = require("node:test");
const { buildOpenMysteryBox, MysteryBoxOpenError } = require("../../src/commands/openMysteryBox");

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const updates = [];
  let participantUpdates = [];

  const mysteryBoxPowerup = {
    id: "pw-1",
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    type: null,
    rarity: null,
    status: "MYSTERY_BOX",
    ...overrides.powerup,
  };

  return {
    events,
    feedEvents,
    updates,
    participantUpdates,
    mysteryBoxPowerup,
    deps: {
      RacePowerup: {
        async findById(id) {
          if (id === mysteryBoxPowerup.id) return mysteryBoxPowerup;
          return null;
        },
        async update(id, fields) {
          updates.push({ id, fields });
          return { ...mysteryBoxPowerup, ...fields };
        },
        async countHeldByParticipant() {
          return overrides.heldCount !== undefined ? overrides.heldCount : 0;
        },
        ...overrides.RacePowerup,
      },
      RaceParticipant: {
        async findByRaceAndUser(raceId, userId) {
          if (raceId === "race-1" && userId === "user-1") {
            return { id: "rp-1", userId: "user-1", totalSteps: 5000, powerupSlots: overrides.powerupSlots || 3 };
          }
          return null;
        },
        async findAcceptedByRace() {
          return overrides.participants || [
            { id: "rp-1", userId: "user-1", totalSteps: 5000 },
            { id: "rp-2", userId: "user-2", totalSteps: 3000 },
          ];
        },
        async update(id, fields) {
          participantUpdates.push({ id, fields });
          return { id, ...fields };
        },
        ...overrides.RaceParticipant,
      },
      Race: {
        async findById(id) {
          if (id === "race-1") return { id: "race-1", status: overrides.raceStatus || "ACTIVE" };
          return null;
        },
        ...overrides.Race,
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: "fe-1", ...data };
        },
        ...overrides.RacePowerupEvent,
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      rollPowerupOdds: overrides.rollPowerupOdds || (() => ({ type: "PROTEIN_SHAKE", rarity: "COMMON" })),
    },
  };
}

test("opens a mystery box — rolls type at open time and transitions to HELD", async () => {
  const ctx = makeDeps();
  const open = buildOpenMysteryBox(ctx.deps);

  const result = await open({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Alex",
  });

  assert.equal(result.id, "pw-1");
  assert.equal(result.type, "PROTEIN_SHAKE");
  assert.equal(result.rarity, "COMMON");
  assert.equal(result.autoActivated, false);
  // Should update with rolled type, rarity, and status HELD
  assert.equal(ctx.updates.length, 1);
  assert.equal(ctx.updates[0].fields.status, "HELD");
  assert.equal(ctx.updates[0].fields.type, "PROTEIN_SHAKE");
  assert.equal(ctx.updates[0].fields.rarity, "COMMON");
});

test("rejects if powerup is not a mystery box", async () => {
  const ctx = makeDeps({ powerup: { status: "HELD", type: "PROTEIN_SHAKE", rarity: "COMMON" } });
  const open = buildOpenMysteryBox(ctx.deps);

  await assert.rejects(
    () => open({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.equal(err.name, "MysteryBoxOpenError");
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test("rejects if inventory is full", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const open = buildOpenMysteryBox(ctx.deps);

  await assert.rejects(
    () => open({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.equal(err.name, "MysteryBoxOpenError");
      assert.ok(err.message.includes("Inventory full"));
      return true;
    },
  );
});

test("rejects if race is not active", async () => {
  const ctx = makeDeps({ raceStatus: "COMPLETED" });
  const open = buildOpenMysteryBox(ctx.deps);

  await assert.rejects(
    () => open({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.equal(err.name, "MysteryBoxOpenError");
      assert.ok(err.message.includes("not active"));
      return true;
    },
  );
});

test("rejects if powerup does not belong to user", async () => {
  const ctx = makeDeps();
  const open = buildOpenMysteryBox(ctx.deps);

  await assert.rejects(
    () => open({ userId: "other-user", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.equal(err.name, "MysteryBoxOpenError");
      assert.equal(err.statusCode, 403);
      return true;
    },
  );
});

test("rejects if powerup not found", async () => {
  const ctx = makeDeps();
  const open = buildOpenMysteryBox(ctx.deps);

  await assert.rejects(
    () => open({ userId: "user-1", raceId: "race-1", powerupId: "nonexistent" }),
    (err) => {
      assert.equal(err.name, "MysteryBoxOpenError");
      assert.equal(err.statusCode, 404);
      return true;
    },
  );
});

test("auto-activates Fanny Pack when inventory is full", async () => {
  const ctx = makeDeps({
    heldCount: 3,
    rollPowerupOdds: () => ({ type: "FANNY_PACK", rarity: "RARE" }),
  });
  const open = buildOpenMysteryBox(ctx.deps);

  const result = await open({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Alex",
  });

  assert.equal(result.type, "FANNY_PACK");
  assert.equal(result.autoActivated, true);
  // Should update powerup with type and USED status
  assert.equal(ctx.updates[0].fields.status, "USED");
  assert.equal(ctx.updates[0].fields.type, "FANNY_PACK");
  assert.equal(ctx.updates[0].fields.rarity, "RARE");
  // Should expand slots
  assert.equal(ctx.participantUpdates.length, 1);
  assert.equal(ctx.participantUpdates[0].fields.powerupSlots, 4);
  // Should create feed event
  assert.equal(ctx.feedEvents.length, 1);
  assert.ok(ctx.feedEvents[0].description.includes("Auto-activated"));
});

test("allows opening with 2 HELD powerups", async () => {
  const ctx = makeDeps({ heldCount: 2 });
  const open = buildOpenMysteryBox(ctx.deps);

  const result = await open({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });

  assert.equal(result.autoActivated, false);
  assert.equal(ctx.updates[0].fields.status, "HELD");
});

test("emits MYSTERY_BOX_OPENED event with rolled type", async () => {
  const ctx = makeDeps();
  const open = buildOpenMysteryBox(ctx.deps);

  await open({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "MYSTERY_BOX_OPENED");
  assert.equal(ctx.events[0].payload.type, "PROTEIN_SHAKE");
  assert.equal(ctx.events[0].payload.autoActivated, false);
});

test("uses current position for odds calculation", async () => {
  // User is in last place (position 2 of 2)
  let calledWithPosition = null;
  const ctx = makeDeps({
    participants: [
      { id: "rp-2", userId: "user-2", totalSteps: 10000 },
      { id: "rp-1", userId: "user-1", totalSteps: 3000 },
    ],
    rollPowerupOdds: (position, total) => {
      calledWithPosition = { position, total };
      return { type: "PROTEIN_SHAKE", rarity: "COMMON" };
    },
  });
  const open = buildOpenMysteryBox(ctx.deps);

  await open({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });

  assert.equal(calledWithPosition.position, 2);
  assert.equal(calledWithPosition.total, 2);
});
