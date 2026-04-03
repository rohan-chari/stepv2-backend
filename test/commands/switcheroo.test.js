const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");

// ---------------------------------------------------------------------------
// Switcheroo — targeted, instant, swaps step totals via bonusSteps adjustment
// Only works upward (target must have more steps)
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    user: { displayName },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const bonusChanges = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);

  return {
    events,
    feedEvents,
    bonusChanges,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            participantId: "rp-1",
            type: "SWITCHEROO",
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
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant(participantId, type) {
          if (type === "COMPRESSION_SOCKS" && overrides.targetHasShield) {
            return { id: "shield-1", status: "ACTIVE" };
          }
          return null;
        },
        async create(data) { return { id: "eff-1", ...data }; },
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
            targetSteps: 50000,
            participants: [user1, user2],
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
// Basic usage — swap mechanics
// ===========================================================================

test("Switcheroo swaps totals via bonusSteps: user gains diff, target loses diff", async () => {
  // Alice has 5000, Bob has 15000 → diff = 10000
  const ctx = makeDeps({
    user1: { totalSteps: 5000, bonusSteps: 0 },
    user2: { totalSteps: 15000, bonusSteps: 0 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  // Alice gains 10000 bonus, Bob loses 10000 bonus
  const aliceChange = ctx.bonusChanges.find((c) => c.id === "rp-1");
  const bobChange = ctx.bonusChanges.find((c) => c.id === "rp-2");
  assert.equal(aliceChange.type, "add");
  assert.equal(aliceChange.amount, 10000);
  assert.equal(bobChange.type, "subtract");
  assert.equal(bobChange.amount, 10000);
});

test("Switcheroo works with existing bonusSteps (additive)", async () => {
  // Alice: 8000 total (bonus 2000), Bob: 12000 total (bonus 1000) → diff = 4000
  const ctx = makeDeps({
    user1: { totalSteps: 8000, bonusSteps: 2000 },
    user2: { totalSteps: 12000, bonusSteps: 1000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  const aliceChange = ctx.bonusChanges.find((c) => c.id === "rp-1");
  const bobChange = ctx.bonusChanges.find((c) => c.id === "rp-2");
  assert.equal(aliceChange.amount, 4000);
  assert.equal(bobChange.amount, 4000);
});

// ===========================================================================
// Validation
// ===========================================================================

test("Switcheroo requires a target", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Switcheroo cannot target yourself", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Switcheroo rejects if target has fewer steps (can only swap up)", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 15000 },
    user2: { totalSteps: 5000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Switcheroo rejects if target has equal steps", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 10000 },
    user2: { totalSteps: 10000 },
  });
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
// Shield
// ===========================================================================

test("Switcheroo is blocked by Compression Socks", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 15000 },
    targetHasShield: true,
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.bonusChanges.length, 0); // no swap happened
});

// ===========================================================================
// Feed event
// ===========================================================================

test("Switcheroo creates feed event", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 15000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "SWITCHEROO");
  assert.equal(ctx.feedEvents[0].targetUserId, "user-2");
  assert.ok(ctx.feedEvents[0].description.includes("Switcheroo"));
});

// ===========================================================================
// Status
// ===========================================================================

test("Switcheroo status changes to USED", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 15000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

test("Switcheroo does not create an active effect (instant)", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 15000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.effect, undefined);
});
