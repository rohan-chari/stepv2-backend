const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");

// ---------------------------------------------------------------------------
// Trail Mix — self-only, instant, +500 per unique powerup type used in race
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

  // Default: no prior used types (trail mix itself will be counted after marking USED)
  const usedTypes = overrides.usedTypes || [];

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
            type: "TRAIL_MIX",
            status: overrides.powerupStatus || "HELD",
            rarity: "COMMON",
          };
        },
        async update(id, fields) {
          updatedPowerup = { id, ...fields };
          return updatedPowerup;
        },
        async findUsedTypesByParticipant() {
          // Returns types already marked USED in DB (Trail Mix adds itself in the case)
          return [...usedTypes];
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
        async findActiveByTypeForParticipant() { return null; },
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
            targetSteps: overrides.targetSteps || 50000,
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
// Basic usage — bonus calculation
// ===========================================================================

test("Trail Mix with 0 prior types gives 500 bonus (counts itself)", async () => {
  const ctx = makeDeps({ usedTypes: [] });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Only trail mix itself = 1 unique type × 500 = 500
  assert.equal(result.bonus, 500);
  assert.equal(ctx.bonusChanges[0].amount, 500);
});

test("Trail Mix with 2 prior types gives 1500 bonus", async () => {
  const ctx = makeDeps({ usedTypes: ["PROTEIN_SHAKE", "LEG_CRAMP"] });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // 2 prior + trail mix = 3 × 500 = 1500
  assert.equal(result.bonus, 1500);
});

test("Trail Mix with 5 prior types gives 3000 bonus", async () => {
  const ctx = makeDeps({ usedTypes: ["PROTEIN_SHAKE", "LEG_CRAMP", "SHORTCUT", "RED_CARD", "RUNNERS_HIGH"] });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // 5 prior + trail mix = 6 × 500 = 3000
  assert.equal(result.bonus, 3000);
});

test("Trail Mix counts itself (marked USED before counting)", async () => {
  const ctx = makeDeps({ usedTypes: [] });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Powerup should be marked USED before counting
  assert.equal(ctx.updatedPowerup.status, "USED");
  // Bonus should be 500 (trail mix is the only unique type)
  assert.equal(ctx.bonusChanges[0].amount, 500);
});

test("Trail Mix does not double-count duplicate types", async () => {
  // Even if two PROTEIN_SHAKEs were used, it's still 1 unique type
  const ctx = makeDeps({ usedTypes: ["PROTEIN_SHAKE"] });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // 1 unique prior + trail mix = 2 × 500 = 1000
  assert.equal(result.bonus, 1000);
});

// ===========================================================================
// Self-only constraint
// ===========================================================================

test("Trail Mix rejects when targetUserId is provided", async () => {
  const ctx = makeDeps();
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
// Feed event
// ===========================================================================

test("Trail Mix creates feed event with bonus and unique count", async () => {
  const ctx = makeDeps({ usedTypes: ["PROTEIN_SHAKE", "LEG_CRAMP"] });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "TRAIL_MIX");
  assert.ok(ctx.feedEvents[0].description.includes("Trail Mix"));
  assert.ok(ctx.feedEvents[0].metadata.bonus === 1500);
  assert.ok(ctx.feedEvents[0].metadata.uniqueTypes === 3);
});

// ===========================================================================
// Status changes
// ===========================================================================

test("Trail Mix status changes to USED after use", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

test("Trail Mix does not create an active effect (instant)", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.effect, undefined);
});
