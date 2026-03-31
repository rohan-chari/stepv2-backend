const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");
const { buildRollPowerup } = require("../../src/commands/rollPowerup");

// ---------------------------------------------------------------------------
// Fanny Pack — self-only, instant, adds 1 extra powerup slot (3 → 4)
// Rare. Auto-activates when inventory is full. Re-rolls if already active.
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    finishedAt: null,
    powerupSlots: 3,
    user: { displayName },
    ...overrides,
  };
}

// ===========================================================================
// usePowerup deps — for manual use tests
// ===========================================================================

function makePowerupDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  const bonusChanges = [];
  const slotUpdates = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);
  const participants = [user1, user2];

  return {
    events,
    feedEvents,
    effectsCreated,
    bonusChanges,
    slotUpdates,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            type: "FANNY_PACK",
            status: overrides.powerupStatus || "HELD",
            rarity: "RARE",
          };
        },
        async update(id, fields) {
          updatedPowerup = { id, ...fields };
          return updatedPowerup;
        },
      },
      RaceParticipant: {
        async addBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "add", amount });
        },
        async subtractBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "subtract", amount });
        },
        async updatePowerupSlots(id, slots) {
          slotUpdates.push({ id, slots });
        },
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant(participantId, type) {
          if (type === "FANNY_PACK" && overrides.existingFannyPack) {
            return overrides.existingFannyPack;
          }
          return null;
        },
        async create(data) {
          const e = { id: "eff-1", ...data };
          effectsCreated.push(e);
          return e;
        },
        async update(id, fields) { return { id, ...fields }; },
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: "fe-1", ...data };
        },
      },
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: overrides.raceStatus || "ACTIVE",
            targetSteps: overrides.targetSteps || 50000,
            participants,
          };
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      now: () => new Date("2026-03-30T12:00:00Z"),
    },
  };
}

// ===========================================================================
// Basic usage — manual use from inventory
// ===========================================================================

test("Fanny Pack increases powerup slots from 3 to 4", async () => {
  const ctx = makePowerupDeps({ user1: { powerupSlots: 3 } });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.slotUpdates.length, 1);
  assert.equal(ctx.slotUpdates[0].id, "rp-1");
  assert.equal(ctx.slotUpdates[0].slots, 4);
});

test("Fanny Pack does not modify step counts", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 0);
});

test("Fanny Pack does not create an active effect", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.effect, undefined);
  assert.equal(ctx.effectsCreated.length, 0);
});

test("Fanny Pack marks powerup as USED after use", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

// ===========================================================================
// Events
// ===========================================================================

test("Fanny Pack emits POWERUP_USED event with correct payload", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "FANNY_PACK");
  assert.equal(ctx.events[0].payload.userId, "user-1");
});

test("Fanny Pack creates a feed event", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "FANNY_PACK");
});

// ===========================================================================
// Self-only constraint
// ===========================================================================

test("Fanny Pack rejects if a targetUserId is provided", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Stacking — cannot use if already have expanded slots
// ===========================================================================

test("Fanny Pack rejects if user already has expanded slots", async () => {
  const ctx = makePowerupDeps({
    user1: { powerupSlots: 4 },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Fanny Pack powerup stays HELD when rejected due to already expanded slots", async () => {
  const ctx = makePowerupDeps({
    user1: { powerupSlots: 4 },
  });
  const use = buildUsePowerup(ctx.deps);

  try {
    await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  } catch {
    // expected
  }

  assert.equal(ctx.updatedPowerup, null);
});

// ===========================================================================
// Finished participant
// ===========================================================================

test("Fanny Pack rejects if user has already finished the race", async () => {
  const ctx = makePowerupDeps({
    user1: { finishedAt: new Date("2026-03-29T10:00:00Z") },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Powerup status validation
// ===========================================================================

test("Fanny Pack rejects if powerup is USED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "USED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Fanny Pack rejects if powerup is DISCARDED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "DISCARDED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Fanny Pack rejects if powerup is EXPIRED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "EXPIRED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Race status validation
// ===========================================================================

test("Fanny Pack rejects if race is COMPLETED", async () => {
  const ctx = makePowerupDeps({ raceStatus: "COMPLETED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Fanny Pack rejects if race is PENDING", async () => {
  const ctx = makePowerupDeps({ raceStatus: "PENDING" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Fanny Pack rejects if race is CANCELLED", async () => {
  const ctx = makePowerupDeps({ raceStatus: "CANCELLED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Ownership
// ===========================================================================

test("Fanny Pack rejects if used by someone who doesn't own it", async () => {
  const ctx = makePowerupDeps({ powerupOwner: "user-1" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Roll behavior — auto-activate when inventory full
// ===========================================================================

function makeRollDeps(overrides = {}) {
  const createdPowerups = [];
  const feedEvents = [];
  const events = [];
  const slotUpdates = [];
  let heldCount = overrides.heldCount ?? 0;
  let nextBox = overrides.nextBoxAtSteps ?? 1000;
  let rollCount = 0;

  return {
    createdPowerups,
    feedEvents,
    events,
    slotUpdates,
    get rollCount() { return rollCount; },
    deps: {
      RacePowerup: {
        async countHeldByParticipant() { return heldCount; },
        async create(data) {
          const p = { id: `pw-${createdPowerups.length + 1}`, ...data };
          createdPowerups.push(p);
          if (data.type !== "FANNY_PACK") heldCount++;
          return p;
        },
      },
      RaceParticipant: {
        async updateNextBoxAtSteps(id, val) { nextBox = val; },
        async updatePowerupSlots(id, slots) { slotUpdates.push({ id, slots }); },
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: "fe-1", ...data };
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      rollPowerupOdds: () => {
        rollCount++;
        if (overrides.rollSequence) {
          return overrides.rollSequence[rollCount - 1] || { type: "PROTEIN_SHAKE", rarity: "COMMON" };
        }
        return { type: "FANNY_PACK", rarity: "RARE" };
      },
    },
  };
}

test("rollPowerup creates mystery box without type (type determined at open time)", async () => {
  const ctx = makeRollDeps({
    heldCount: 3,
  });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 1500,
    nextBoxAtSteps: 1000,
    powerupStepInterval: 1000,
    displayName: "Alice",
  });

  assert.equal(results.length, 1);
  assert.ok(results[0].mysteryBox);
  assert.equal(ctx.createdPowerups.length, 1);
  assert.equal(ctx.createdPowerups[0].status, "MYSTERY_BOX");
  // Type is null — determined at open time, not earn time
  assert.equal(ctx.createdPowerups[0].type, undefined);
  assert.equal(ctx.createdPowerups[0].rarity, undefined);
});
