const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildUsePowerup,
  PowerupUseError,
} = require("../../src/modules/powerups/commands/usePowerup");

// These cases retain the complete historical IMPOSTER interaction matrix. The
// behavior itself is now structurally unreachable: retirement must preempt
// target validation, effect creation, defenses, feed writes, step mutation,
// and consumption. Keeping each case explicit prevents a future refactor from
// accidentally restoring only one of those old paths.
function buildRetiredUse(overrides = {}) {
  const state = {
    updatedPowerups: [],
    effectsCreated: [],
    effectUpdates: [],
    feedEvents: [],
    bonusChanges: [],
    racesRead: 0,
  };
  const use = buildUsePowerup({
    // Even a stale injected gate returning true cannot revive the powerup.
    imposterEnabled: () => true,
    RacePowerup: {
      async findById(id) {
        return {
          id,
          userId: overrides.ownerId || "user-1",
          raceId: "race-1",
          type: "IMPOSTER",
          status: "HELD",
          rarity: null,
        };
      },
      async update(id, fields) {
        state.updatedPowerups.push({ id, ...fields });
      },
      async findHeldByParticipant() {
        return [];
      },
      async findUsedTypesByParticipant() {
        return [];
      },
    },
    RaceParticipant: {
      async addBonusSteps(id, amount) {
        state.bonusChanges.push({ id, amount });
      },
      async subtractBonusSteps(id, amount) {
        state.bonusChanges.push({ id, amount: -amount });
      },
    },
    RaceActiveEffect: {
      async findActiveByTypeForParticipant() {
        return null;
      },
      async findActiveForParticipant() {
        return overrides.existingEffects || [];
      },
      async create(data) {
        state.effectsCreated.push(data);
      },
      async update(id, fields) {
        state.effectUpdates.push({ id, ...fields });
      },
    },
    RacePowerupEvent: {
      async create(data) {
        state.feedEvents.push(data);
      },
    },
    Race: {
      async findById() {
        state.racesRead += 1;
        return overrides.race || null;
      },
    },
  });
  return { use, state };
}

async function assertRetired(ctx, overrides = {}) {
  await assert.rejects(
    () =>
      ctx.use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-2",
        ...overrides,
      }),
    (error) => {
      assert.ok(error instanceof PowerupUseError);
      assert.equal(error.statusCode, 410);
      assert.equal(error.message, "This powerup has been retired.");
      assert.equal(error.code, "POWERUP_RETIRED");
      assert.equal(error.powerupType, "IMPOSTER");
      assert.equal(error.retainHeld, true);
      return true;
    },
  );
  assert.deepEqual(ctx.state.updatedPowerups, [], "held powerup stays held");
  assert.deepEqual(ctx.state.effectsCreated, [], "no effect is created");
  assert.deepEqual(ctx.state.effectUpdates, [], "no defense is consumed");
  assert.deepEqual(ctx.state.feedEvents, [], "no feed event is written");
  assert.deepEqual(ctx.state.bonusChanges, [], "no steps are changed");
  assert.equal(ctx.state.racesRead, 0, "retirement preempts race evaluation");
}

test("retired IMPOSTER preempts the historical missing-target validation", async () => {
  await assertRetired(buildRetiredUse(), { targetUserId: undefined });
});

test("retired IMPOSTER preempts the historical self-target validation", async () => {
  await assertRetired(buildRetiredUse(), { targetUserId: "user-1" });
});

test("retired IMPOSTER cannot create its historical display-swap effect", async () => {
  await assertRetired(buildRetiredUse());
});

test("retired IMPOSTER is not consumed", async () => {
  await assertRetired(buildRetiredUse());
});

test("retired IMPOSTER remains stealthy and writes no feed event", async () => {
  await assertRetired(buildRetiredUse());
});

test("retired IMPOSTER cannot modify step counts", async () => {
  await assertRetired(buildRetiredUse());
});

test("retired IMPOSTER preempts the historical non-participant validation", async () => {
  await assertRetired(buildRetiredUse(), { targetUserId: "ghost-user" });
});

test("retired IMPOSTER cannot consume a target Compression Socks defense", async () => {
  await assertRetired(
    buildRetiredUse({
      existingEffects: [{ id: "shield-1", type: "COMPRESSION_SOCKS" }],
    }),
  );
});

test("retired IMPOSTER ignores Compression Socks held by another rival", async () => {
  await assertRetired(
    buildRetiredUse({
      existingEffects: [{ id: "other-shield", type: "COMPRESSION_SOCKS" }],
    }),
  );
});

test("retired IMPOSTER cannot trigger or consume Mirror", async () => {
  await assertRetired(
    buildRetiredUse({
      existingEffects: [{ id: "mirror-1", type: "MIRROR" }],
    }),
  );
});

test("IMPOSTER retirement preserves ownership checks", async () => {
  const ctx = buildRetiredUse({ ownerId: "other-user" });
  await assert.rejects(
    () =>
      ctx.use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-2",
      }),
    (error) => {
      assert.ok(error instanceof PowerupUseError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
  assert.deepEqual(ctx.state.updatedPowerups, []);
  assert.deepEqual(ctx.state.effectsCreated, []);
});
