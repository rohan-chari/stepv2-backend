const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");

// ---------------------------------------------------------------------------
// Second Wind — self-only, instant, bonus = 25% of gap to leader (500-5000)
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    finishedAt: null,
    user: { displayName },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  const bonusChanges = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);
  const user3 = makeParticipant("rp-3", "user-3", "Carol", { totalSteps: 8000, ...overrides.user3 });
  const participants = [user1, user2, user3];

  return {
    events,
    feedEvents,
    effectsCreated,
    bonusChanges,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            type: "SECOND_WIND",
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
        async findActiveByTypeForParticipant() { return null; },
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
// Core behavior — bonus = 25% of gap to leader, clamped 500-5000
// ===========================================================================

test("Second Wind gives 25% of gap to leader as bonus", async () => {
  // user-1 at 5000, leader (user-2) at 20000 → gap = 15000, 25% = 3750
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 3750);
  assert.equal(ctx.bonusChanges.length, 1);
  assert.equal(ctx.bonusChanges[0].id, "rp-1");
  assert.equal(ctx.bonusChanges[0].type, "add");
  assert.equal(ctx.bonusChanges[0].amount, 3750);
});

test("Second Wind bonus is added to the user who used it", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 1);
  assert.equal(ctx.bonusChanges[0].id, "rp-1"); // user-1's participant
  assert.equal(ctx.bonusChanges[0].type, "add");
});

// ===========================================================================
// Clamping — min 500, max 5000
// ===========================================================================

test("Second Wind clamps to minimum 500 when gap is small", async () => {
  // user-1 at 19500, leader at 20000 → gap = 500, 25% = 125 → clamp to 500
  const ctx = makeDeps({
    user1: { totalSteps: 19500 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 500);
});

test("Second Wind clamps to minimum 500 when gap is very tiny", async () => {
  // gap = 1, 25% = 0.25 → clamp to 500
  const ctx = makeDeps({
    user1: { totalSteps: 19999 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 500);
});

test("Second Wind clamps to maximum 5000 when gap is huge", async () => {
  // user-1 at 1000, leader at 40000 → gap = 39000, 25% = 9750 → clamp to 5000
  const ctx = makeDeps({
    user1: { totalSteps: 1000 },
    user2: { totalSteps: 40000 },
    user3: { totalSteps: 500 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 5000);
});

test("Second Wind gives exactly 5000 at the boundary", async () => {
  // gap = 20000, 25% = 5000 → exactly at max, no clamping needed
  const ctx = makeDeps({
    user1: { totalSteps: 0 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 0 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 5000);
});

test("Second Wind gives exactly 500 at the min boundary", async () => {
  // gap = 2000, 25% = 500 → exactly at min
  const ctx = makeDeps({
    user1: { totalSteps: 18000 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 500);
});

// ===========================================================================
// Rounding — Math.round
// ===========================================================================

test("Second Wind rounds bonus to nearest whole number", async () => {
  // gap = 15001, 25% = 3750.25 → rounds to 3750
  const ctx = makeDeps({
    user1: { totalSteps: 4999 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 3750);
});

test("Second Wind rounds up at .5", async () => {
  // gap = 15002, 25% = 3750.5 → rounds to 3751
  const ctx = makeDeps({
    user1: { totalSteps: 4998 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 3751);
});

// ===========================================================================
// Leader exclusions
// ===========================================================================

test("Second Wind rejects if you are the leader", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 25000 },
    user2: { totalSteps: 10000 },
    user3: { totalSteps: 5000 },
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

test("Second Wind rejects if you are tied for the lead", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 20000 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 5000 },
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
// Finished participants excluded from leader calculation
// ===========================================================================

test("Second Wind skips finished participants when finding the leader", async () => {
  // user-2 has most steps but finished. Leader among active is user-3 at 15000.
  // user-1 at 5000, gap to user-3 = 10000, 25% = 2500
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 30000, finishedAt: new Date("2026-03-29T10:00:00Z") },
    user3: { totalSteps: 15000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 2500);
});

test("Second Wind rejects if you are the leader among non-finished participants", async () => {
  // user-2 finished, user-1 is highest among active
  const ctx = makeDeps({
    user1: { totalSteps: 20000 },
    user2: { totalSteps: 30000, finishedAt: new Date("2026-03-29T10:00:00Z") },
    user3: { totalSteps: 5000 },
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
// Stealthed leader — sees through stealth
// ===========================================================================

test("Second Wind calculates gap using stealthed leader's actual steps", async () => {
  // user-2 is stealthed leader at 20000. user-1 at 5000. gap = 15000, 25% = 3750
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Should use actual steps, not hidden values
  assert.equal(result.bonus, 3750);
});

// ===========================================================================
// Multiple uses — no cooldown
// ===========================================================================

test("Second Wind can be used back-to-back", async () => {
  const ctx1 = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use1 = buildUsePowerup(ctx1.deps);
  const result1 = await use1({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  assert.equal(result1.bonus, 3750);

  // After bonus, user-1 at 8750. Gap now 11250, 25% = 2813
  const ctx2 = makeDeps({
    user1: { totalSteps: 8750 },
    user2: { totalSteps: 20000 },
  });
  const use2 = buildUsePowerup(ctx2.deps);
  const result2 = await use2({ userId: "user-1", raceId: "race-1", powerupId: "pw-2" });
  assert.equal(result2.bonus, 2813);
});

// ===========================================================================
// Self-only constraint
// ===========================================================================

test("Second Wind rejects if a targetUserId is provided", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
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
// Powerup status after use
// ===========================================================================

test("Second Wind marks powerup as USED", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

// ===========================================================================
// Events
// ===========================================================================

test("Second Wind emits POWERUP_USED event with correct payload", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "SECOND_WIND");
  assert.equal(ctx.events[0].payload.userId, "user-1");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
});

test("Second Wind creates a feed event", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "SECOND_WIND");
});

// ===========================================================================
// No active effect (instant)
// ===========================================================================

test("Second Wind does not create an active effect", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.effect, undefined);
  assert.equal(ctx.effectsCreated.length, 0);
});

// ===========================================================================
// Finished attacker
// ===========================================================================

test("Second Wind rejects if the user has already finished", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000, finishedAt: new Date("2026-03-29T10:00:00Z") },
    user2: { totalSteps: 20000 },
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

test("Second Wind rejects if powerup is USED", async () => {
  const ctx = makeDeps({ powerupStatus: "USED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Second Wind rejects if powerup is DISCARDED", async () => {
  const ctx = makeDeps({ powerupStatus: "DISCARDED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Second Wind rejects if powerup is EXPIRED", async () => {
  const ctx = makeDeps({ powerupStatus: "EXPIRED" });
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

test("Second Wind rejects if race is COMPLETED", async () => {
  const ctx = makeDeps({ raceStatus: "COMPLETED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Second Wind rejects if race is PENDING", async () => {
  const ctx = makeDeps({ raceStatus: "PENDING" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Second Wind rejects if race is CANCELLED", async () => {
  const ctx = makeDeps({ raceStatus: "CANCELLED" });
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

test("Second Wind rejects if used by someone who doesn't own it", async () => {
  const ctx = makeDeps({ powerupOwner: "user-1" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});
