const assert = require("node:assert/strict");
const test = require("node:test");

const { buildOpenMysteryBox } = require("../../src/modules/powerups/commands/openMysteryBox");
const { buildUsePowerup, PowerupUseError } = require("../../src/modules/powerups/commands/usePowerup");
const { buildResolveRaceState } = require("../../src/modules/races/services/raceStateResolution");
const { RARITY_TIERS } = require("../../src/modules/powerups/powerupOdds");
const {
  isUpgradeable,
  upgradeCost,
  upgradedDuration,
  upgradedMagnitude,
} = require("../../src/modules/powerups/powerupUpgrades");
const {
  defaultConfig,
} = require("../../src/modules/economy/balanceConfig.defaults");

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
  const stealCalls = [];

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
    stealCalls,
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
        async stealRandomHeldPowerup(args) {
          stealCalls.push(args);
          if (overrides.stealResult !== undefined) return overrides.stealResult;
          const candidates = (overrides.heldPowerups || []).filter(
            (p) =>
              p.participantId === args.fromParticipantId &&
              p.status === "HELD" &&
              !(args.excludeTypes || []).includes(p.type),
          );
          return candidates[0] || null;
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
  assert.ok(
    !Object.values(RARITY_TIERS).some((tier) => tier.includes("POCKET_WATCH")),
    "Pocket Watch is disabled indefinitely and must not roll from a box"
  );
  assert.ok(RARITY_TIERS.RARE.includes("TRAIL_MINE"));
  assert.ok(RARITY_TIERS.COMMON.includes("PINECONE_TOSS"));
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

  // Horseshoe's premium ladder was retired in 2026-07-14 (it repriced to plain
  // RARE, 135 at L3). Batch 2026-08-09 item 8b retires the ladder ITSELF: the
  // Horseshoe now guarantees a rare at EVERY level, so levels 1-3 buy nothing
  // and cost nothing (upgradeCosts.byType.LUCKY_HORSESHOE = [0,0,0,0]).
  //
  // isUpgradeable() must STAY true above — that is the frozen-client contract.
  // A shipped binary decides "is this upgradeable?" from its BUNDLED table, so
  // dropping the type here would leave old builds offering L1-3 and taking a
  // permanent 400 ("not upgradeable"). Free-and-inert is what keeps them working.
  assert.deepEqual(
    [0, 1, 2, 3].map((level) => upgradeCost("LUCKY_HORSESHOE", level)),
    [0, 0, 0, 0]
  );
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
      // Balance config is operational data and may differ in a developer DB.
      // Pin the shipped snapshot so this unit test owns the rollout-era
      // UNCOMMON floor it is specifically asserting.
      balanceConfig: {
        async getSnapshot() {
          return { version: null, config: defaultConfig() };
        },
      },
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
  assert.equal(ctx.effectsUpdated[0].fields.expiresAt.toISOString(), "2026-05-14T15:00:00.000Z");
  assert.equal(ctx.effectsUpdated[1].fields.expiresAt.toISOString(), "2026-05-14T16:00:00.000Z");
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
  // `aheadParticipantIds` (C0, docs/redis-derived-data-layer-requirements.md
  // §5a) is load-bearing, not incidental: it records who was ALREADY past the
  // plant point, captured from the same computed totals that produced
  // `positionSteps`, and triggerTrailMines excludes exactly that set. It
  // replaced the old "their stored total is below the mine" inference, which
  // broke once the uploader-only reconcile started advancing the syncing user's
  // stored row before the resolution worker read it — the runner who actually
  // crossed arrived already above the mine and was misread as always-ahead, so
  // the mine never fired for the person who tripped it.
  //
  // Fixture: Alice plants at 9,000; Bob (12,000) is ahead and must be excluded;
  // Charlie (7,000) is behind and must stay eligible to trip it.
  assert.deepEqual(ctx.effectsCreated[0].metadata, {
    ownerParticipantId: "rp-alice",
    positionSteps: 9000,
    penaltyPercent: 0.03,
    aheadParticipantIds: ["rp-bob"],
  });
  assert.ok(
    !ctx.effectsCreated[0].metadata.aheadParticipantIds.includes("rp-charlie"),
    "a runner behind the plant point must remain able to trigger the mine"
  );
  assert.ok(
    !ctx.effectsCreated[0].metadata.aheadParticipantIds.includes("rp-alice"),
    "the owner is never in the ahead-set (they are excluded as the owner)"
  );

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

// Sneaky Swap is a one-way STEAL (2026-07 redesign): pick an opponent, take
// one RANDOM stealable powerup from them, give up nothing of your own. The
// stolen powerup occupies the slot the consumed Sneaky Swap frees.
test("Sneaky Swap steals one random powerup from the target without giving one up", async () => {
  const ctx = makeUseDeps({
    powerupType: "SNEAKY_SWAP",
    heldPowerups: [
      { id: "pw-own", participantId: "rp-alice", userId: "user-alice", status: "HELD", type: "TRAIL_MIX" },
      { id: "pw-target", participantId: "rp-bob", userId: "user-bob", status: "HELD", type: "RED_CARD", rarity: "UNCOMMON" },
    ],
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-swap",
    targetUserId: "user-bob",
  });

  // One steal, from the target's shelf to the attacker's, excluding
  // non-stealable types.
  assert.equal(ctx.stealCalls.length, 1);
  const call = ctx.stealCalls[0];
  assert.equal(call.fromParticipantId, "rp-bob");
  assert.equal(call.toParticipantId, "rp-alice");
  assert.equal(call.toUserId, "user-alice");
  assert.ok(call.excludeTypes.includes("SNEAKY_SWAP"));
  assert.ok(call.excludeTypes.includes("MYSTERY_BOX"));

  assert.equal(result.swapped, true, "legacy flag kept for old clients");
  assert.deepEqual(result.stolenPowerup, {
    id: "pw-target",
    type: "RED_CARD",
    rarity: "UNCOMMON",
  });

  // The sneaky swap itself is consumed; nothing else of the attacker's is
  // touched.
  assert.equal(ctx.powerupUpdates.length, 1);
  assert.equal(ctx.powerupUpdates[0].id, "pw-swap");
  assert.equal(ctx.powerupUpdates[0].fields.status, "USED");

  // Feed event names the theft.
  const feed = ctx.feedEvents.find((e) => e.powerupType === "SNEAKY_SWAP");
  assert.ok(feed.description.includes("stole"));
});

test("Sneaky Swap ignores legacy swap ids — the attacker's own powerup is never transferred", async () => {
  const ctx = makeUseDeps({
    powerupType: "SNEAKY_SWAP",
    heldPowerups: [
      { id: "pw-own", participantId: "rp-alice", userId: "user-alice", status: "HELD", type: "TRAIL_MIX" },
      { id: "pw-target", participantId: "rp-bob", userId: "user-bob", status: "HELD", type: "RED_CARD" },
    ],
  });
  const use = buildUsePowerup(ctx.deps);

  // An old app version still sends the mutual-swap ids.
  const result = await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-swap",
    targetUserId: "user-bob",
    swapOfferedPowerupId: "pw-own",
    swapRequestedPowerupId: "pw-target",
  });

  assert.equal(result.swapped, true);
  // Steal executed with steal semantics; the offered id plays no part.
  assert.equal(ctx.stealCalls.length, 1);
  assert.equal(ctx.stealCalls[0].fromParticipantId, "rp-bob");
  assert.equal(ctx.stealCalls[0].toParticipantId, "rp-alice");
  // Only the sneaky swap row itself was updated — pw-own stays with Alice.
  assert.deepEqual(
    ctx.powerupUpdates.map((u) => u.id),
    ["pw-swap"],
  );
});

test("Sneaky Swap rejects (and is not consumed) when the target has nothing stealable", async () => {
  const ctx = makeUseDeps({
    powerupType: "SNEAKY_SWAP",
    heldPowerups: [
      // Target holds only non-stealable types.
      { id: "pw-their-swap", participantId: "rp-bob", userId: "user-bob", status: "HELD", type: "SNEAKY_SWAP" },
      { id: "pw-their-box", participantId: "rp-bob", userId: "user-bob", status: "HELD", type: "MYSTERY_BOX" },
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
      }),
    (err) => err instanceof PowerupUseError && err.message.includes("steal"),
  );
  assert.equal(ctx.stealCalls.length, 0);
  assert.equal(ctx.powerupUpdates.length, 0, "sneaky swap not consumed");
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
      }),
    (err) => err instanceof PowerupUseError && err.message.includes("stealthed"),
  );
});

test("Sneaky Swap reflected by Mirror steals from the attacker instead", async () => {
  const ctx = makeUseDeps({
    powerupType: "SNEAKY_SWAP",
    activeEffects: [
      {
        id: "eff-mirror",
        type: "MIRROR",
        status: "ACTIVE",
        targetParticipantId: "rp-bob",
        expiresAt: new Date("2026-05-14T14:00:00Z"),
      },
    ],
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
  });

  assert.equal(result.reflected, true);
  assert.equal(result.outcome, "REFLECTED");
  // Roles swapped: Bob steals from Alice.
  assert.equal(ctx.stealCalls.length, 1);
  assert.equal(ctx.stealCalls[0].fromParticipantId, "rp-alice");
  assert.equal(ctx.stealCalls[0].toParticipantId, "rp-bob");
  assert.equal(ctx.stealCalls[0].toUserId, "user-bob");
  // Mirror consumed + reflect feed event written.
  assert.ok(ctx.effectsUpdated.some((u) => u.fields.status === "EXPIRED"));
  assert.ok(ctx.feedEvents.some((e) => e.eventType === "POWERUP_REFLECTED"));
});

test("Sneaky Swap blocked by Compression Socks is still consumed and steals nothing", async () => {
  const ctx = makeUseDeps({
    powerupType: "SNEAKY_SWAP",
    activeEffects: [
      {
        id: "eff-socks",
        type: "COMPRESSION_SOCKS",
        status: "ACTIVE",
        targetParticipantId: "rp-bob",
        expiresAt: new Date("2026-05-14T14:00:00Z"),
      },
    ],
    heldPowerups: [
      { id: "pw-target", participantId: "rp-bob", userId: "user-bob", status: "HELD", type: "RED_CARD" },
    ],
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-alice",
    raceId: "race-1",
    powerupId: "pw-swap",
    targetUserId: "user-bob",
  });

  assert.equal(result.blocked, true);
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(ctx.stealCalls.length, 0, "no powerup changes hands");
  // The sneaky swap is consumed on a block (product decision 2026-07-01).
  assert.ok(
    ctx.powerupUpdates.some((u) => u.id === "pw-swap" && u.fields.status === "USED"),
  );
  // Shield consumed.
  assert.ok(ctx.effectsUpdated.some((u) => u.fields.status === "BLOCKED"));
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
      // Mechanical (2026-08-09): production writes participant totals through
      // updateStepTotals({ totalSteps, rawSteps }); delegate so this fake keeps
      // recording exactly what it recorded before.
      async updateStepTotals(id, fields = {}) { return this.updateTotalSteps(id, fields.totalSteps); },
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
