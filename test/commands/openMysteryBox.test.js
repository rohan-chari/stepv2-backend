const assert = require("node:assert/strict");
const test = require("node:test");
const { buildOpenMysteryBox, MysteryBoxOpenError } = require("../../src/modules/powerups/commands/openMysteryBox");

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const updates = [];
  let participantUpdates = [];
  const calls = {
    countOccupiedSlots: 0,
    repairInventory: 0,
    invalidateProgress: 0,
  };

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
    calls,
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
        async countOccupiedSlots() {
          calls.countOccupiedSlots += 1;
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
      RaceActiveEffect: overrides.RaceActiveEffect,
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      repairRacePowerupInventory: async () => {
        calls.repairInventory += 1;
      },
      invalidateRaceProgress: async () => {
        calls.invalidateProgress += 1;
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
  assert.equal(ctx.calls.countOccupiedSlots, 0, "ordinary rolls do not inspect slot occupancy");
  assert.equal(ctx.calls.repairInventory, 0, "an in-place box-to-held transition frees no slot");
  assert.equal(ctx.calls.invalidateProgress, 0, "inventory is not stored in the shared progress snapshot");
});

// 2026-08-10: an already-rolled id resolves idempotently (the batch endpoint's
// contract) instead of 400ing — prod showed those requests are always a stale
// client surface re-POSTing a roll that already succeeded.
test("re-open of an already-rolled (HELD) powerup returns its roll without writing", async () => {
  const ctx = makeDeps({ powerup: { status: "HELD", type: "PROTEIN_SHAKE", rarity: "COMMON" } });
  const open = buildOpenMysteryBox(ctx.deps);

  const result = await open({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.id, "pw-1");
  assert.equal(result.type, "PROTEIN_SHAKE");
  assert.equal(result.rarity, "COMMON");
  assert.equal(result.autoActivated, false);
  assert.equal(result.alreadyOpened, true);
  // Pure read: no row update, no audit event row, no bus emit.
  assert.equal(ctx.updates.length, 0);
  assert.equal(ctx.feedEvents.length, 0);
  assert.equal(ctx.events.length, 0);
});

for (const status of ["USED", "EXPIRED"]) {
  test(`re-open of an already-rolled ${status} powerup also replays its roll`, async () => {
    const ctx = makeDeps({ powerup: { status, type: "PROTEIN_SHAKE", rarity: "COMMON" } });
    const open = buildOpenMysteryBox(ctx.deps);

    const result = await open({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

    assert.equal(result.type, "PROTEIN_SHAKE");
    assert.equal(result.alreadyOpened, true);
    assert.equal(ctx.updates.length, 0);
    assert.equal(ctx.feedEvents.length, 0);
  });
}

for (const powerup of [
  { status: "QUEUED" },
  { status: "DISCARDED", type: "PROTEIN_SHAKE", rarity: "COMMON" },
  // A null-type HELD row was never rolled — there is nothing to replay.
  { status: "HELD", type: null, rarity: null },
]) {
  test(`rejects a non-replayable row (${powerup.status}, type ${powerup.type ?? "null"})`, async () => {
    const ctx = makeDeps({ powerup });
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
}

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
  assert.equal(ctx.calls.countOccupiedSlots, 1);
  assert.equal(ctx.calls.repairInventory, 1);
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

test("consuming Lucky Horseshoe invalidates the shared active-effects snapshot", async () => {
  const effectUpdates = [];
  const ctx = makeDeps({
    RaceActiveEffect: {
      async findActiveByTypeForParticipant() {
        return {
          id: "lucky-1",
          metadata: { minRarity: "UNCOMMON" },
        };
      },
      async update(id, fields) {
        effectUpdates.push({ id, fields });
      },
    },
    rollPowerupOdds: () => ({ type: "TRAIL_MIX", rarity: "UNCOMMON" }),
  });
  const open = buildOpenMysteryBox(ctx.deps);

  await open({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });

  assert.deepEqual(effectUpdates, [
    { id: "lucky-1", fields: { status: "EXPIRED" } },
  ]);
  assert.equal(ctx.calls.invalidateProgress, 1);
  assert.equal(ctx.calls.repairInventory, 0);
  assert.equal(ctx.calls.countOccupiedSlots, 0);
});

test("does not consume Lucky Horseshoe when Fanny Pack slot inspection fails", async () => {
  const effectUpdates = [];
  const ctx = makeDeps({
    RaceActiveEffect: {
      async findActiveByTypeForParticipant() {
        return {
          id: "lucky-1",
          metadata: { minRarity: "RARE" },
        };
      },
      async update(id, fields) {
        effectUpdates.push({ id, fields });
      },
    },
    RacePowerup: {
      async countOccupiedSlots() {
        throw new Error("slot count unavailable");
      },
    },
    rollPowerupOdds: () => ({ type: "FANNY_PACK", rarity: "RARE" }),
  });
  const open = buildOpenMysteryBox(ctx.deps);

  await assert.rejects(
    () => open({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    /slot count unavailable/,
  );

  assert.deepEqual(effectUpdates, []);
  assert.equal(ctx.updates.length, 0);
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
