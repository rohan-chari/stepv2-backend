const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup, PowerupUseError } = require("../../src/modules/powerups/commands/usePowerup");

const HOUR_MS = 60 * 60 * 1000;

function makeParticipant(userId, overrides = {}) {
  return {
    id: `rp-${userId}`,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    user: { displayName: userId },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  const bonusChanges = [];
  const upgradeEvents = [];
  const coinDeductions = [];

  const user1 = makeParticipant("user-1", overrides.user1);
  const user2 = makeParticipant("user-2", overrides.user2);
  const user3 = makeParticipant("user-3", { totalSteps: 8000, ...overrides.user3 });
  const participants = [user1, user2, user3];

  const userCoins = overrides.userCoins ?? 1000;

  return {
    events,
    feedEvents,
    effectsCreated,
    bonusChanges,
    upgradeEvents,
    coinDeductions,
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: "user-1",
            raceId: "race-1",
            type: overrides.powerupType || "PROTEIN_SHAKE",
            status: overrides.powerupStatus || "HELD",
            rarity: "COMMON",
            ...(overrides.powerup || {}),
          };
        },
        async update(id, fields) {
          return { id, ...fields };
        },
        async findUsedTypesByParticipant() {
          return [];
        },
        ...overrides.RacePowerup,
      },
      RaceParticipant: {
        async addBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "add", amount });
        },
        async subtractBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "subtract", amount });
        },
        async updatePowerupSlots() {},
        ...overrides.RaceParticipant,
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant(participantId, type) {
          if (type === "COMPRESSION_SOCKS") return overrides.existingShield || null;
          if (overrides.existingEffectsByType && overrides.existingEffectsByType[type]) {
            return overrides.existingEffectsByType[type];
          }
          return null;
        },
        async create(data) {
          const e = { id: `eff-${effectsCreated.length + 1}`, ...data };
          effectsCreated.push(e);
          return e;
        },
        async update(id, fields) {
          return { id, ...fields };
        },
        ...overrides.RaceActiveEffect,
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: `fe-${feedEvents.length}`, ...data };
        },
      },
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: overrides.raceStatus || "ACTIVE",
            targetSteps: 50000,
            participants,
          };
        },
        ...overrides.Race,
      },
      User: {
        async findById() {
          return { id: "user-1", coins: userCoins };
        },
        ...overrides.User,
      },
      deductCoinsAtomic: async ({ userId, amount, reason, refId }) => {
        if (overrides.deductCoinsAtomicOverride) {
          return overrides.deductCoinsAtomicOverride({ userId, amount, reason, refId });
        }
        if (userCoins < amount) {
          const { InsufficientCoinsError } = require("../../src/shared/economy/deductCoinsAtomic");
          throw new InsufficientCoinsError("not enough coins");
        }
        coinDeductions.push({ userId, amount, reason, refId });
        return { coins: userCoins - amount };
      },
      PowerupUpgradeEvent: {
        async create(data) {
          const e = { id: `ue-${upgradeEvents.length + 1}`, ...data };
          upgradeEvents.push(e);
          return e;
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      now: () => new Date("2026-05-12T12:00:00Z"),
    },
  };
}

// ===========================================================================
// Base (Lvl 0) — existing behavior; no coins deducted, no upgrade event
// ===========================================================================

test("upgradeLevel=0 (base) keeps existing Protein Shake behavior — no coins, no upgrade event", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    upgradeLevel: 0,
  });

  assert.equal(result.bonus, 1500);
  assert.equal(ctx.coinDeductions.length, 0);
  assert.equal(ctx.upgradeEvents.length, 0);
});

test("upgradeLevel omitted defaults to 0 (back-compat with existing API callers)", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 1500);
  assert.equal(ctx.coinDeductions.length, 0);
});

// ===========================================================================
// Magnitude upgrades — Protein Shake & Shortcut
// ===========================================================================

test("Lvl 1 Protein Shake: +2250 bonus, 5 coins deducted", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 1,
  });

  assert.equal(result.bonus, 2250);
  assert.equal(ctx.bonusChanges[0].amount, 2250);
  assert.equal(ctx.coinDeductions.length, 1);
  assert.equal(ctx.coinDeductions[0].amount, 5);
  assert.equal(ctx.coinDeductions[0].reason, "powerup_upgrade");
  assert.equal(ctx.coinDeductions[0].refId, "pw-1");
});

test("Lvl 2 Protein Shake: +3000 bonus, 15 coins deducted", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 2,
  });

  assert.equal(result.bonus, 3000);
  assert.equal(ctx.coinDeductions[0].amount, 15);
});

test("Lvl 3 Protein Shake: +4500 bonus, 25 coins deducted", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3,
  });

  assert.equal(result.bonus, 4500);
  assert.equal(ctx.coinDeductions[0].amount, 45);
});

test("Lvl 3 Shortcut steals up to 3000 (capped at target's steps)", async () => {
  const ctx = makeDeps({
    powerupType: "SHORTCUT",
    user2: { totalSteps: 10000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 3,
  });

  assert.equal(result.stolen, 3000);
  assert.equal(ctx.bonusChanges[0].amount, 3000);  // subtract from target
  assert.equal(ctx.bonusChanges[1].amount, 3000);  // add to attacker
  // Shortcut is RARE now (was pricing off the COMMON ladder): 15/45/135.
  assert.equal(ctx.coinDeductions[0].amount, 135);
});

test("Lvl 3 Shortcut against low-step target — capped to target's actual steps", async () => {
  const ctx = makeDeps({
    powerupType: "SHORTCUT",
    user2: { totalSteps: 1200 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 3,
  });

  assert.equal(result.stolen, 1200, "stealing capped at target's steps even with Lvl 3");
});

// ===========================================================================
// Duration upgrades — timed effects
// ===========================================================================

function durationAssert(effect, expectedHours) {
  const expectedExpiry = new Date("2026-05-12T12:00:00Z").getTime() + expectedHours * HOUR_MS;
  assert.equal(
    new Date(effect.expiresAt).getTime(),
    expectedExpiry,
    `expected expiresAt at +${expectedHours}h`
  );
}

// Batch 2026-08-09 item 1: LEG_CRAMP and WRONG_TURN moved to +15m per level
// (1 / 1.25 / 1.5 / 1.75h) with a byType cost override.
//
// 2026-08-15 (owner decision): RUNNERS_HIGH, STEALTH_MODE, and DETOUR_SIGN
// joined the same 15-min ladder and byType cost overrides — every non-shop,
// timed drop-pool powerup now upgrades on the same timeframe. POCKET_WATCH is
// excluded (shop-only) and keeps the old 1/2/3/4h ladder.
test("Lvl 3 Leg Cramp: 1h45m freeze duration, 30 coins deducted", async () => {
  const ctx = makeDeps({ powerupType: "LEG_CRAMP" });
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 3,
  });

  durationAssert(ctx.effectsCreated[0], 1.75);
  assert.equal(ctx.coinDeductions[0].amount, 30);
});

test("Lvl 1 Leg Cramp: 1h15m freeze, 10 coins (entry price unchanged)", async () => {
  const ctx = makeDeps({ powerupType: "LEG_CRAMP" });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 1 });
  durationAssert(ctx.effectsCreated[0], 1.25);
  assert.equal(ctx.coinDeductions[0].amount, 10);
});

test("Lvl 3 Runner's High: 1h45m duration, 15 coins deducted", async () => {
  const ctx = makeDeps({ powerupType: "RUNNERS_HIGH" });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3 });
  durationAssert(ctx.effectsCreated[0], 1.75);
  assert.equal(ctx.coinDeductions[0].amount, 15);
});

test("Lvl 3 Stealth Mode: 1h45m duration", async () => {
  const ctx = makeDeps({ powerupType: "STEALTH_MODE" });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3 });
  durationAssert(ctx.effectsCreated[0], 1.75);
});

test("Lvl 2 Stealth Mode: 1h30m duration", async () => {
  const ctx = makeDeps({ powerupType: "STEALTH_MODE" });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 2 });
  durationAssert(ctx.effectsCreated[0], 1.5);
});

test("Lvl 3 Wrong Turn: 1h45m duration, 45 coins deducted", async () => {
  const ctx = makeDeps({ powerupType: "WRONG_TURN" });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 3 });
  durationAssert(ctx.effectsCreated[0], 1.75);
  // Coins were never asserted here despite the old test name claiming 90.
  // Pinned now, at the repriced value.
  assert.equal(ctx.coinDeductions[0].amount, 45);
});

test("Lvl 3 Detour Sign: 1h45m duration, 15 coins deducted (byType override)", async () => {
  const ctx = makeDeps({ powerupType: "DETOUR_SIGN" });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 3 });
  durationAssert(ctx.effectsCreated[0], 1.75);
  assert.equal(ctx.coinDeductions[0].amount, 15);
});

test("Lvl 3 Compression Socks: 48h duration, 135 coins deducted (Rare rarity)", async () => {
  const ctx = makeDeps({ powerupType: "COMPRESSION_SOCKS" });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3 });
  durationAssert(ctx.effectsCreated[0], 48);
  assert.equal(ctx.coinDeductions[0].amount, 135);
});

// ===========================================================================
// Trail Mix — magnitude is per-unique-type; final bonus = magnitude × uniqueTypes
// ===========================================================================

test("Lvl 0 Trail Mix with 0 prior unique types: 100 × 1 = 100 bonus, no coins", async () => {
  const ctx = makeDeps({ powerupType: "TRAIL_MIX" });
  const use = buildUsePowerup(ctx.deps);
  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  assert.equal(result.bonus, 100);
  assert.equal(ctx.coinDeductions.length, 0);
});

test("Lvl 1 Trail Mix with 0 prior unique types: 150 × 1 = 150 bonus, 5 coins (Common L1)", async () => {
  const ctx = makeDeps({ powerupType: "TRAIL_MIX" });
  const use = buildUsePowerup(ctx.deps);
  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 1 });
  assert.equal(result.bonus, 150);
  assert.equal(ctx.coinDeductions[0].amount, 5);
});

test("Lvl 3 Trail Mix with 0 prior unique types: 300 × 1 = 300 bonus, 45 coins (Common L3)", async () => {
  const ctx = makeDeps({ powerupType: "TRAIL_MIX" });
  const use = buildUsePowerup(ctx.deps);
  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3 });
  assert.equal(result.bonus, 300);
  assert.equal(ctx.coinDeductions[0].amount, 45);
});

test("Lvl 3 Trail Mix with 5 prior unique types: 300 × 6 = 1,800 bonus", async () => {
  const ctx = makeDeps({
    powerupType: "TRAIL_MIX",
    RacePowerup: {
      async findById(id) {
        return {
          id, userId: "user-1", raceId: "race-1",
          type: "TRAIL_MIX", status: "HELD", rarity: "COMMON",
        };
      },
      async update() {},
      async findUsedTypesByParticipant() {
        return ["PROTEIN_SHAKE", "SHORTCUT", "RUNNERS_HIGH", "STEALTH_MODE", "DETOUR_SIGN"];
      },
    },
  });
  const use = buildUsePowerup(ctx.deps);
  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3 });
  assert.equal(result.bonus, 1800, "300 per type × 6 unique (5 prior + Trail Mix itself)");
});

test("Race feed for Lvl 2 Trail Mix mentions Lvl 2 and the dynamic bonus", async () => {
  const ctx = makeDeps({ powerupType: "TRAIL_MIX" });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 2 });

  const feedEvent = ctx.feedEvents.find((e) => e.eventType === "POWERUP_USED");
  assert.match(feedEvent.description, /Lvl 2/);
  assert.match(feedEvent.description, /200/); // 200 per type * 1 unique = 200
});

// ===========================================================================
// Reject upgrades on non-upgradeable powerup types
// ===========================================================================

for (const type of ["RED_CARD", "SECOND_WIND", "FANNY_PACK"]) {
  test(`Reject upgradeLevel>0 on non-upgradeable ${type}`, async () => {
    const ctx = makeDeps({
      powerupType: type,
      user2: { totalSteps: 20000 }, // ensure not the leader so RED_CARD can attempt
    });
    const use = buildUsePowerup(ctx.deps);

    await assert.rejects(
      () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 1 }),
      (err) => {
        assert.ok(err instanceof PowerupUseError);
        assert.match(err.message, /not upgradeable|cannot be upgraded/i);
        return true;
      }
    );
    assert.equal(ctx.coinDeductions.length, 0, "no coins deducted on rejected upgrade");
  });
}

// ===========================================================================
// Reject out-of-range upgrade levels
// ===========================================================================

test("Reject upgradeLevel=4 (above max)", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 4 }),
    /level/i
  );
  assert.equal(ctx.coinDeductions.length, 0);
});

test("Reject upgradeLevel=-1", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: -1 }),
    /level/i
  );
});

test("Reject non-integer upgradeLevel", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 1.5 }),
    /level/i
  );
});

// ===========================================================================
// Insufficient coins
// ===========================================================================

test("Insufficient coins: Lvl 3 attempt fails, no powerup state changes", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE", userCoins: 10 });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3 }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.match(err.message, /coins|insufficient/i);
      return true;
    }
  );

  // No effect created, no bonus applied — powerup must remain HELD
  assert.equal(ctx.effectsCreated.length, 0);
  assert.equal(ctx.bonusChanges.length, 0);
  assert.equal(ctx.upgradeEvents.length, 0);
});

// ===========================================================================
// Compression Socks shield blocks an upgraded offensive powerup
// ===========================================================================

test("Lvl 3 Shortcut blocked by shield: coins ARE deducted, shield consumed", async () => {
  const ctx = makeDeps({
    powerupType: "SHORTCUT",
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 3,
  });

  assert.equal(result.blocked, true);
  // No bonus transferred when blocked
  assert.equal(ctx.bonusChanges.length, 0);
  // BUT coins are still spent (per design Wave 2)
  assert.equal(ctx.coinDeductions.length, 1);
  assert.equal(ctx.coinDeductions[0].amount, 135);
  // Upgrade event must record BLOCKED status
  assert.equal(ctx.upgradeEvents.length, 1);
  assert.equal(ctx.upgradeEvents[0].status, "BLOCKED");
});

test("Lvl 3 Leg Cramp blocked by shield: coins deducted, no effect created", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 3,
  });

  assert.equal(result.blocked, true);
  assert.equal(ctx.effectsCreated.length, 0);
  assert.equal(ctx.coinDeductions[0].amount, 30);
  assert.equal(ctx.upgradeEvents[0].status, "BLOCKED");
});

// ===========================================================================
// Race feed event description includes "Lvl X" prefix
// ===========================================================================

// Batch 2026-08-09 item 1: Lvl 3 Leg Cramp is 1h45m, and the feed string comes
// from the shared formatter — so this also pins that the feed never renders a
// decimal hour ("1.75 hours") for the new ladder.
test("Race feed for Lvl 3 Leg Cramp says 'Lvl 3' and shows 1h 45m", async () => {
  const ctx = makeDeps({ powerupType: "LEG_CRAMP" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 3 });

  const feedEvent = ctx.feedEvents.find((e) => e.eventType === "POWERUP_USED");
  assert.ok(feedEvent, "feed event should exist");
  assert.match(feedEvent.description, /Lvl 3/);
  assert.match(feedEvent.description, /1h 45m/);
  assert.ok(!/\d\.\d/.test(feedEvent.description), "no decimal hours in the feed");
});

test("Race feed for Lvl 0 (base) Leg Cramp does NOT include 'Lvl' prefix", async () => {
  const ctx = makeDeps({ powerupType: "LEG_CRAMP" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  const feedEvent = ctx.feedEvents.find((e) => e.eventType === "POWERUP_USED");
  assert.doesNotMatch(feedEvent.description, /Lvl/);
});

test("Race feed for Lvl 2 Protein Shake mentions 3,000 (upgraded magnitude)", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 2 });

  const feedEvent = ctx.feedEvents.find((e) => e.eventType === "POWERUP_USED");
  assert.match(feedEvent.description, /Lvl 2/);
  assert.match(feedEvent.description, /3,000|3000/);
});

// ===========================================================================
// PowerupUpgradeEvent audit log
// ===========================================================================

test("PowerupUpgradeEvent created on Lvl 2 success", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 2 });

  assert.equal(ctx.upgradeEvents.length, 1);
  const ev = ctx.upgradeEvents[0];
  assert.equal(ev.raceId, "race-1");
  assert.equal(ev.userId, "user-1");
  assert.equal(ev.powerupId, "pw-1");
  assert.equal(ev.powerupType, "PROTEIN_SHAKE");
  assert.equal(ev.tier, 2);
  assert.equal(ev.costCoins, 15);
  assert.equal(ev.status, "APPLIED");
  assert.equal(ev.targetUserId, null);
});

test("PowerupUpgradeEvent records targetUserId for offensive upgrades", async () => {
  const ctx = makeDeps({ powerupType: "SHORTCUT" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 1 });

  assert.equal(ctx.upgradeEvents[0].targetUserId, "user-2");
  assert.equal(ctx.upgradeEvents[0].status, "APPLIED");
});

test("No PowerupUpgradeEvent for Lvl 0 (base) use", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 0 });

  assert.equal(ctx.upgradeEvents.length, 0);
});

// ===========================================================================
// Stack-rejection still applies regardless of tier (Wave 5 rule)
// ===========================================================================

test("Lvl 3 Runner's High rejected if active Runner's High exists; no coins deducted", async () => {
  const ctx = makeDeps({
    powerupType: "RUNNERS_HIGH",
    existingEffectsByType: {
      RUNNERS_HIGH: { id: "eff-existing", type: "RUNNERS_HIGH", status: "ACTIVE" },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3 }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.match(err.message, /already have an active/i);
      return true;
    }
  );

  // Critical: no coins should be deducted on stack rejection
  assert.equal(ctx.coinDeductions.length, 0);
  assert.equal(ctx.upgradeEvents.length, 0);
});

test("Lvl 3 Leg Cramp rejected if target already has active Leg Cramp; no coins deducted", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    RaceActiveEffect: {
      async findActiveByTypeForParticipant(participantId, type) {
        if (type === "LEG_CRAMP" && participantId === "rp-user-2") {
          return { id: "eff-existing", type: "LEG_CRAMP", status: "ACTIVE" };
        }
        return null;
      },
      async create(data) { return { id: "x", ...data }; },
      async update(id, fields) { return { id, ...fields }; },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2", upgradeLevel: 3 }),
    PowerupUseError
  );
  assert.equal(ctx.coinDeductions.length, 0);
});

// ===========================================================================
// Validation rejection paths must NOT deduct coins
// ===========================================================================

test("Race not active: Lvl 3 attempt rejected, no coins deducted", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE", raceStatus: "COMPLETED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3 }),
    /not active/i
  );
  assert.equal(ctx.coinDeductions.length, 0);
});

test("Powerup already USED: Lvl 3 attempt rejected, no coins deducted", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE", powerupStatus: "USED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", upgradeLevel: 3 }),
    /already been used/i
  );
  assert.equal(ctx.coinDeductions.length, 0);
});
