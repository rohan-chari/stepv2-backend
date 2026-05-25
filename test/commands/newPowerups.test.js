const assert = require("node:assert/strict");
const test = require("node:test");

const { buildOpenMysteryBox } = require("../../src/commands/openMysteryBox");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");
const { buildResolveRaceState } = require("../../src/services/raceStateResolution");
const { RARITY_TIERS } = require("../../src/utils/powerupOdds");
const {
  isUpgradeable,
  upgradeCost,
  upgradedDuration,
  upgradedMagnitude,
} = require("../../src/utils/powerupUpgrades");

const HOUR = 60 * 60 * 1000;

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

function makeUseDeps(overrides = {}) {
  const effectsCreated = [];
  const effectsUpdated = [];
  const feedEvents = [];
  const powerupUpdates = [];
  const participantUpdates = [];
  const bonusChanges = [];
  const emittedEvents = [];
  const upgradeEvents = [];
  const swappedPowerups = [];

  const alice = makeParticipant("rp-alice", "user-alice", "Alice", {
    totalSteps: 9000,
    ...overrides.alice,
  });
  const bob = makeParticipant("rp-bob", "user-bob", "Bob", {
    totalSteps: 12000,
    ...overrides.bob,
  });
  const charlie = makeParticipant("rp-charlie", "user-charlie", "Charlie", {
    totalSteps: 7000,
    ...overrides.charlie,
  });
  const participants = overrides.participants || [alice, bob, charlie];
  const powerupType = overrides.powerupType || "LUCKY_HORSESHOE";

  return {
    alice,
    bob,
    charlie,
    effectsCreated,
    effectsUpdated,
    feedEvents,
    powerupUpdates,
    participantUpdates,
    bonusChanges,
    emittedEvents,
    upgradeEvents,
    swappedPowerups,
    deps: {
      RacePowerup: {
        async findById(id) {
          if (id === "missing") return null;
          return {
            id,
            userId: overrides.powerupOwner || "user-alice",
            raceId: "race-1",
            participantId: "rp-alice",
            type: powerupType,
            status: overrides.powerupStatus || "HELD",
            rarity: overrides.rarity || "COMMON",
          };
        },
        async update(id, fields) {
          powerupUpdates.push({ id, fields });
          return { id, ...fields };
        },
        async findHeldByParticipant(participantId) {
          return (overrides.heldPowerups || []).filter(
            (p) => p.participantId === participantId,
          );
        },
        async swapHeldPowerups(sourcePowerupId, targetPowerupId) {
          swappedPowerups.push({ sourcePowerupId, targetPowerupId });
          return {
            source: { id: sourcePowerupId, participantId: "rp-bob" },
            target: { id: targetPowerupId, participantId: "rp-alice" },
          };
        },
        async findUsedTypesByParticipant() {
          return [];
        },
      },
      RaceParticipant: {
        async addBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "add", amount });
        },
        async subtractBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "subtract", amount });
        },
        async update(id, fields) {
          participantUpdates.push({ id, fields });
          return { id, ...fields };
        },
        async updateNextBoxAtSteps(id, nextBoxAtSteps) {
          participantUpdates.push({ id, nextBoxAtSteps });
          return { id, nextBoxAtSteps };
        },
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant(participantId, type) {
          return (overrides.activeEffects || []).find(
            (effect) =>
              effect.targetParticipantId === participantId &&
              effect.type === type &&
              effect.status !== "EXPIRED",
          ) || null;
        },
        async findActiveForParticipant(participantId) {
          return (overrides.activeEffects || []).filter(
            (effect) =>
              effect.targetParticipantId === participantId &&
              effect.status !== "EXPIRED",
          );
        },
        async create(data) {
          const effect = { id: `eff-${effectsCreated.length + 1}`, ...data };
          effectsCreated.push(effect);
          return effect;
        },
        async update(id, fields) {
          effectsUpdated.push({ id, fields });
          return { id, ...fields };
        },
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: `event-${feedEvents.length}`, ...data };
        },
      },
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            targetSteps: 50000,
            powerupsEnabled: true,
            participants,
          };
        },
      },
      PowerupUpgradeEvent: {
        async create(data) {
          upgradeEvents.push(data);
          return { id: `upgrade-${upgradeEvents.length}`, ...data };
        },
      },
      deductCoinsAtomic: async (data) => data,
      eventBus: {
        emit(event, payload) {
          emittedEvents.push({ event, payload });
        },
      },
      now: () => new Date("2026-05-14T12:00:00Z"),
    },
  };
}

test("new powerups are assigned to the intended rarity pools", () => {
  assert.ok(RARITY_TIERS.RARE.includes("LUCKY_HORSESHOE"));
  assert.ok(RARITY_TIERS.UNCOMMON.includes("CAMPFIRE_REST"));
  assert.ok(RARITY_TIERS.COMMON.includes("TRAIL_MAGNET"));
  assert.ok(RARITY_TIERS.RARE.includes("POCKET_WATCH"));
  assert.ok(RARITY_TIERS.RARE.includes("TRAIL_MINE"));
  assert.ok(RARITY_TIERS.UNCOMMON.includes("PINECONE_TOSS"));
  assert.ok(RARITY_TIERS.RARE.includes("SNEAKY_SWAP"));
});

test("new upgrade policy matches the product spec", () => {
  assert.equal(isUpgradeable("LUCKY_HORSESHOE"), true);
  assert.equal(isUpgradeable("CAMPFIRE_REST"), true);
  assert.equal(isUpgradeable("TRAIL_MAGNET"), true);
  assert.equal(isUpgradeable("POCKET_WATCH"), true);
  assert.equal(isUpgradeable("TRAIL_MINE"), true);
  assert.equal(isUpgradeable("PINECONE_TOSS"), true);
  assert.equal(isUpgradeable("SNEAKY_SWAP"), false);

  assert.equal(upgradeCost("LUCKY_HORSESHOE", 3) >= 1000, true);
  assert.deepEqual(
    [0, 1, 2, 3].map((level) => upgradedMagnitude("TRAIL_MAGNET", level)),
    [1000, 1500, 2000, 3000],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((level) => upgradedMagnitude("TRAIL_MINE", level)),
    [0.03, 0.05, 0.08, 0.12],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((level) => upgradedMagnitude("PINECONE_TOSS", level)),
    [750, 1000, 1500, 2250],
  );
  assert.equal(upgradedDuration("POCKET_WATCH", 0), 1 * HOUR);
  assert.equal(upgradedDuration("CAMPFIRE_REST", 3), 90 * 60 * 1000);
});

test("Lucky Horseshoe creates next-box odds modifier and level 3 guarantees rare", async () => {
  const ctx = makeUseDeps({ powerupType: "LUCKY_HORSESHOE" });
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-lucky",
    upgradeLevel: 3,
  });

  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "LUCKY_HORSESHOE");
  assert.deepEqual(ctx.effectsCreated[0].metadata, {
    minRarity: "RARE",
    consumedOnNextBox: true,
  });
  assert.equal(ctx.powerupUpdates[0].fields.status, "USED");
});

test("Lucky Horseshoe changes only the next opened mystery box and then expires", async () => {
  const luckyEffect = {
    id: "eff-lucky",
    type: "LUCKY_HORSESHOE",
    status: "ACTIVE",
    metadata: { minRarity: "UNCOMMON", consumedOnNextBox: true },
  };
  const updates = [];
  const effectUpdates = [];
  const ctx = {
    deps: {
      RacePowerup: {
        async findById() {
          return {
            id: "box-1",
            raceId: "race-1",
            participantId: "rp-alice",
            userId: "user-alice",
            type: null,
            rarity: null,
            status: "MYSTERY_BOX",
          };
        },
        async update(id, fields) {
          updates.push({ id, fields });
          return { id, ...fields };
        },
        async countOccupiedSlots() {
          return 0;
        },
      },
      RaceParticipant: {
        async findByRaceAndUser() {
          return { id: "rp-alice", userId: "user-alice", totalSteps: 5000, powerupSlots: 3 };
        },
        async findAcceptedByRace() {
          return [{ id: "rp-alice", userId: "user-alice", totalSteps: 5000 }];
        },
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant(participantId, type) {
          assert.equal(participantId, "rp-alice");
          assert.equal(type, "LUCKY_HORSESHOE");
          return luckyEffect;
        },
        async update(id, fields) {
          effectUpdates.push({ id, fields });
        },
      },
      Race: {
        async findById() {
          return { id: "race-1", status: "ACTIVE" };
        },
      },
      RacePowerupEvent: { async create() {} },
      eventBus: { emit() {} },
      rollPowerupOdds: () => ({ type: "PROTEIN_SHAKE", rarity: "COMMON" }),
    },
  };
  const open = buildOpenMysteryBox(ctx.deps);

  const result = await open({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "box-1",
  });

  assert.equal(result.rarity, "UNCOMMON");
  assert.equal(updates[0].fields.rarity, "UNCOMMON");
  assert.deepEqual(effectUpdates, [{ id: "eff-lucky", fields: { status: "EXPIRED" } }]);
});

test("Campfire Rest freezes progress and stores delayed multiplier metadata", async () => {
  const ctx = makeUseDeps({ powerupType: "CAMPFIRE_REST" });
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-campfire",
    upgradeLevel: 2,
  });

  assert.equal(ctx.effectsCreated[0].type, "CAMPFIRE_REST");
  assert.deepEqual(ctx.effectsCreated[0].metadata, {
    freezeMs: 30 * 60 * 1000,
    multiplier: 2.75,
    boostMs: 60 * 60 * 1000,
    stepsAtRestStart: 9000,
  });
});

test("Trail Magnet pulls the next box threshold closer and can grant immediately", async () => {
  const ctx = makeUseDeps({
    powerupType: "TRAIL_MAGNET",
    alice: { totalSteps: 5200, nextBoxAtSteps: 6000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-magnet",
  });

  assert.equal(result.grantedBox, true);
  assert.deepEqual(ctx.participantUpdates[0], {
    id: "rp-alice",
    nextBoxAtSteps: 5000,
  });
});

test("Pocket Watch extends all active timed buffs", async () => {
  const ctx = makeUseDeps({
    powerupType: "POCKET_WATCH",
    activeEffects: [
      {
        id: "eff-rh",
        type: "RUNNERS_HIGH",
        status: "ACTIVE",
        targetParticipantId: "rp-alice",
        expiresAt: new Date("2026-05-14T13:00:00Z"),
      },
      {
        id: "eff-shield",
        type: "COMPRESSION_SOCKS",
        status: "ACTIVE",
        targetParticipantId: "rp-alice",
        expiresAt: new Date("2026-05-14T14:00:00Z"),
      },
    ],
  });
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-watch",
    upgradeLevel: 1,
  });

  assert.equal(ctx.effectsUpdated.length, 2);
  assert.equal(ctx.effectsUpdated[0].id, "eff-rh");
  assert.equal(ctx.effectsUpdated[0].fields.expiresAt.toISOString(), "2026-05-14T14:30:00.000Z");
  assert.equal(ctx.effectsUpdated[1].fields.expiresAt.toISOString(), "2026-05-14T15:30:00.000Z");
});

test("Pocket Watch rejects when no timed buff is active", async () => {
  const ctx = makeUseDeps({ powerupType: "POCKET_WATCH" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-alice", raceId: "race-1", powerupId: "pw-watch" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.equal(err.statusCode, 400);
      return err.message.includes("active timed buff");
    },
  );
});

test("Trail Mine drops a trap at current steps and rejects use in last place", async () => {
  const ctx = makeUseDeps({ powerupType: "TRAIL_MINE" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-alice", raceId: "race-1", powerupId: "pw-mine" });

  assert.equal(ctx.effectsCreated[0].type, "TRAIL_MINE");
  assert.deepEqual(ctx.effectsCreated[0].metadata, {
    ownerParticipantId: "rp-alice",
    positionSteps: 9000,
    penaltyPercent: 0.03,
  });

  const lastPlaceCtx = makeUseDeps({
    powerupType: "TRAIL_MINE",
    alice: { totalSteps: 1000 },
    bob: { totalSteps: 12000 },
    charlie: { totalSteps: 7000 },
  });
  const useLastPlace = buildUsePowerup(lastPlaceCtx.deps);
  await assert.rejects(
    () => useLastPlace({ userId: "user-alice", raceId: "race-1", powerupId: "pw-mine" }),
    (err) => err instanceof PowerupUseError && err.message.includes("last place"),
  );
});

test("Pinecone Toss hits the adjacent runner in the chosen direction", async () => {
  const ctx = makeUseDeps({ powerupType: "PINECONE_TOSS" });
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-pinecone",
    targetDirection: "FRONT",
    upgradeLevel: 1,
  });

  assert.deepEqual(ctx.bonusChanges, [
    { id: "rp-bob", type: "subtract", amount: 1000 },
  ]);
  assert.equal(ctx.powerupUpdates[0].fields.targetUserId, "user-bob");
});

test("Sneaky Swap swaps one held powerup with a non-stealthed target", async () => {
  const ctx = makeUseDeps({
    powerupType: "SNEAKY_SWAP",
    heldPowerups: [
      { id: "pw-own", participantId: "rp-alice", userId: "user-alice", status: "HELD", type: "TRAIL_MIX" },
      { id: "pw-target", participantId: "rp-bob", userId: "user-bob", status: "HELD", type: "RED_CARD" },
    ],
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-swap",
    targetUserId: "user-bob",
    swapOfferedPowerupId: "pw-own",
    swapRequestedPowerupId: "pw-target",
  });

  assert.equal(result.swapped, true);
  assert.deepEqual(ctx.swappedPowerups, [
    { sourcePowerupId: "pw-own", targetPowerupId: "pw-target" },
  ]);
});

test("Sneaky Swap cannot target stealthed players", async () => {
  const ctx = makeUseDeps({
    powerupType: "SNEAKY_SWAP",
    activeEffects: [
      {
        id: "eff-stealth",
        type: "STEALTH_MODE",
        status: "ACTIVE",
        targetParticipantId: "rp-bob",
        expiresAt: new Date("2026-05-14T14:00:00Z"),
      },
    ],
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () =>
      use({
        userId: "user-alice",
        raceId: "race-1",
        powerupId: "pw-swap",
        targetUserId: "user-bob",
        swapOfferedPowerupId: "pw-own",
        swapRequestedPowerupId: "pw-target",
      }),
    (err) => err instanceof PowerupUseError && err.message.includes("stealthed"),
  );
});

test("Trail Mine triggers when the next runner crosses its step position", async () => {
  const mine = {
    id: "eff-mine",
    raceId: "race-1",
    targetParticipantId: "rp-alice",
    targetUserId: "user-alice",
    sourceUserId: "user-alice",
    type: "TRAIL_MINE",
    status: "ACTIVE",
    startsAt: new Date("2026-05-14T11:00:00Z"),
    expiresAt: null,
    metadata: {
      ownerParticipantId: "rp-alice",
      positionSteps: 9000,
      penaltyPercent: 0.03,
    },
  };
  const bonusChanges = [];
  const effectsUpdated = [];
  const feedEvents = [];

  const resolve = buildResolveRaceState({
    Race: {
      async findById() {
        return {
          id: "race-1",
          status: "ACTIVE",
          startedAt: new Date("2026-05-14T10:00:00Z"),
          targetSteps: 50000,
          powerupsEnabled: true,
          participants: [
            makeParticipant("rp-alice", "user-alice", "Alice", { totalSteps: 9000 }),
            makeParticipant("rp-bob", "user-bob", "Bob", { totalSteps: 8500 }),
          ],
        };
      },
    },
    RaceParticipant: {
      async updateTotalSteps() {},
      async subtractBonusSteps(id, amount) {
        bonusChanges.push({ id, amount });
      },
      async markFinished() {},
      async setPlacement() {},
    },
    Steps: {
      async findByUserIdAndDateRange() {
        return [];
      },
    },
    StepSample: {
      async sumStepsInWindow(userId) {
        return userId === "user-bob" ? 9200 : 9000;
      },
      async findByUserIdAndTimeRange() {
        return [];
      },
    },
    RaceActiveEffect: {
      async findEffectsForRaceByType() {
        return [];
      },
      async findActiveForRace() {
        return [mine];
      },
      async findActiveByTypeForParticipant(participantId, type) {
        assert.equal(participantId, "rp-bob");
        assert.equal(type, "COMPRESSION_SOCKS");
        return null;
      },
      async update(id, fields) {
        effectsUpdated.push({ id, fields });
      },
    },
    RacePowerupEvent: {
      async findByRaceAsc() {
        return [];
      },
      async create(data) {
        feedEvents.push(data);
      },
    },
    completeRace: async () => {},
    now: () => new Date("2026-05-14T12:00:00Z"),
  });

  await resolve({ raceId: "race-1", timeZone: "UTC" });

  assert.deepEqual(bonusChanges, [{ id: "rp-bob", amount: 276 }]);
  assert.deepEqual(effectsUpdated, [{ id: "eff-mine", fields: { status: "EXPIRED" } }]);
  assert.equal(feedEvents[0].powerupType, "TRAIL_MINE");
  assert.equal(feedEvents[0].targetUserId, "user-bob");
});

test("Pocket Watch does not extend an opponent-applied debuff (WRONG_TURN)", async () => {
  const ctx = makeUseDeps({
    powerupType: "POCKET_WATCH",
    activeEffects: [
      {
        id: "eff-rh",
        type: "RUNNERS_HIGH",
        status: "ACTIVE",
        targetParticipantId: "rp-alice",
        targetUserId: "user-alice",
        sourceUserId: "user-alice",
        expiresAt: new Date("2026-05-14T13:00:00Z"),
      },
      {
        id: "eff-wt",
        type: "WRONG_TURN",
        status: "ACTIVE",
        targetParticipantId: "rp-alice",
        targetUserId: "user-alice",
        sourceUserId: "user-bob",
        expiresAt: new Date("2026-05-14T13:30:00Z"),
      },
    ],
  });
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-watch",
    upgradeLevel: 0,
  });

  // Only the Runner's High should be extended; the opponent-applied
  // Wrong Turn debuff must be left alone.
  assert.equal(ctx.effectsUpdated.length, 1);
  assert.equal(ctx.effectsUpdated[0].id, "eff-rh");
  assert.equal(
    ctx.effectsUpdated[0].fields.expiresAt.toISOString(),
    "2026-05-14T14:00:00.000Z",
  );
});

test("Pocket Watch rejects when only opponent-applied debuffs are active", async () => {
  const ctx = makeUseDeps({
    powerupType: "POCKET_WATCH",
    activeEffects: [
      {
        id: "eff-wt",
        type: "WRONG_TURN",
        status: "ACTIVE",
        targetParticipantId: "rp-alice",
        targetUserId: "user-alice",
        sourceUserId: "user-bob",
        expiresAt: new Date("2026-05-14T13:30:00Z"),
      },
      {
        id: "eff-cramp",
        type: "LEG_CRAMP",
        status: "ACTIVE",
        targetParticipantId: "rp-alice",
        targetUserId: "user-alice",
        sourceUserId: "user-bob",
        expiresAt: new Date("2026-05-14T14:00:00Z"),
      },
    ],
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-alice", raceId: "race-1", powerupId: "pw-watch" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.equal(err.statusCode, 400);
      return err.message.includes("active timed buff");
    },
  );
});

