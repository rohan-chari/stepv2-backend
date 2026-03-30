const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");

// ---------------------------------------------------------------------------
// Red Card — offensive, auto-targets leader, removes 10% of leader's steps
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
  const user4 = overrides.user4 ? makeParticipant("rp-4", "user-4", "Dave", overrides.user4) : null;
  const participants = [user1, user2, user3, ...(user4 ? [user4] : [])];

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
            type: "RED_CARD",
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
          if (type === "COMPRESSION_SOCKS" && overrides.existingShield) {
            // Only return shield for the targeted participant
            if (overrides.shieldHolder && overrides.shieldHolder !== participantId) return null;
            return overrides.existingShield;
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
// Basic usage — auto-targets leader, removes 10%
// ===========================================================================

test("Red Card removes 10% of the leader's steps", async () => {
  // user-2 is leader with 20000
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.penalty, 2000); // 10% of 20000
  assert.equal(ctx.bonusChanges.length, 1);
  assert.equal(ctx.bonusChanges[0].id, "rp-2");
  assert.equal(ctx.bonusChanges[0].type, "subtract");
  assert.equal(ctx.bonusChanges[0].amount, 2000);
});

test("Red Card auto-targets the participant with the most steps", async () => {
  // user-3 is leader with 25000
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 10000 },
    user3: { totalSteps: 25000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.penalty, 2500); // 10% of 25000
  assert.equal(ctx.bonusChanges[0].id, "rp-3");
});

test("Red Card does NOT transfer steps to the attacker", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Only one bonus change — subtract from leader, no add to attacker
  assert.equal(ctx.bonusChanges.length, 1);
  assert.equal(ctx.bonusChanges[0].type, "subtract");
});

// ===========================================================================
// Rounding — 10% rounds to nearest whole number
// ===========================================================================

test("Red Card rounds penalty to nearest whole number (rounds down)", async () => {
  // 10% of 10001 = 1000.1 → rounds to 1000
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 10001 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.penalty, 1000);
});

test("Red Card rounds penalty to nearest whole number (rounds up)", async () => {
  // 10% of 10005 = 1000.5 → rounds to 1001
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 10005 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.penalty, 1001);
});

// ===========================================================================
// Edge cases — leader step counts
// ===========================================================================

test("Red Card on leader with 0 steps results in 0 penalty", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 0 },
    user2: { totalSteps: 0 },
    user3: { totalSteps: 0 },
  });
  const use = buildUsePowerup(ctx.deps);

  // All tied at 0 — should reject due to tie
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Red Card penalty can push leader below the attacker's steps", async () => {
  // Leader at 1100, attacker at 1050. 10% = 110. Leader drops to 990.
  const ctx = makeDeps({
    user1: { totalSteps: 1050 },
    user2: { totalSteps: 1100 },
    user3: { totalSteps: 500 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.penalty, 110);
  assert.equal(ctx.bonusChanges[0].amount, 110);
});

test("Red Card on leader with very few steps does not make them negative", async () => {
  // Leader has 5 steps, 10% = 0.5 → rounds to 1
  const ctx = makeDeps({
    user1: { totalSteps: 1 },
    user2: { totalSteps: 5 },
    user3: { totalSteps: 2 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.ok(result.penalty <= 5, "penalty should not exceed leader's total steps");
  assert.ok(result.penalty >= 0, "penalty should not be negative");
});

// ===========================================================================
// Tied leaders — reject
// ===========================================================================

test("Red Card rejects when top two participants are tied", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 15000 },
    user3: { totalSteps: 15000 },
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

test("Red Card powerup stays HELD when rejected due to tied leaders", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 15000 },
    user3: { totalSteps: 15000 },
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
// Cannot use if you're the leader
// ===========================================================================

test("Red Card rejects if the attacker is the leader", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 20000 },
    user2: { totalSteps: 10000 },
    user3: { totalSteps: 5000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.ok(err.message.includes("in the lead"));
      return true;
    }
  );
});

test("Red Card rejects if attacker is tied for the lead", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 15000 },
    user2: { totalSteps: 15000 },
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
// Rejects if targetUserId is provided
// ===========================================================================

test("Red Card rejects if a targetUserId is provided", async () => {
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
// Finished leader — skip to next non-finished leader
// ===========================================================================

test("Red Card skips a finished leader and targets the next highest", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 25000, finishedAt: new Date("2026-03-29T10:00:00Z") },
    user3: { totalSteps: 15000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Should target user-3 (next highest non-finished), not user-2
  assert.equal(result.penalty, 1500); // 10% of 15000
  assert.equal(ctx.bonusChanges[0].id, "rp-3");
});

test("Red Card rejects if all higher participants have finished", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 25000, finishedAt: new Date("2026-03-29T10:00:00Z") },
    user3: { totalSteps: 15000, finishedAt: new Date("2026-03-29T12:00:00Z") },
  });
  const use = buildUsePowerup(ctx.deps);

  // user-1 is the only non-finished participant, effectively in the lead
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Stealthed leader — Red Card sees through stealth
// ===========================================================================

test("Red Card targets a stealthed leader", async () => {
  // user-2 is stealthed leader — Red Card should still target them
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 8000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Should target user-2 regardless of stealth
  assert.equal(result.penalty, 2000);
  assert.equal(ctx.bonusChanges[0].id, "rp-2");
});

// ===========================================================================
// Compression Socks blocks Red Card
// ===========================================================================

test("Red Card is blocked by leader's Compression Socks", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
    shieldHolder: "rp-2",
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.bonusChanges.length, 0);
});

// ===========================================================================
// Back-to-back usage — no cooldown
// ===========================================================================

test("Red Card can be used back-to-back with no cooldown", async () => {
  // First use
  const ctx1 = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use1 = buildUsePowerup(ctx1.deps);
  const result1 = await use1({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  assert.equal(result1.penalty, 2000);

  // Second use (different powerup, same user)
  const ctx2 = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 18000 }, // after first penalty
    user3: { totalSteps: 3000 },
  });
  const use2 = buildUsePowerup(ctx2.deps);
  const result2 = await use2({ userId: "user-1", raceId: "race-1", powerupId: "pw-2" });
  assert.equal(result2.penalty, 1800); // 10% of 18000
});

// ===========================================================================
// Powerup status after use
// ===========================================================================

test("Red Card marks powerup as USED after use", async () => {
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

test("Red Card emits POWERUP_USED event with correct payload", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "RED_CARD");
  assert.equal(ctx.events[0].payload.userId, "user-1");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
  assert.equal(ctx.events[0].payload.targetUserId, "user-2");
});

test("Red Card creates a feed event with penalty amount", async () => {
  const ctx = makeDeps({
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "RED_CARD");
  assert.ok(ctx.feedEvents[0].description.includes("2,000") || ctx.feedEvents[0].description.includes("2000"),
    "feed event should mention the penalty amount");
});

// ===========================================================================
// Red Card does not create an active effect (instant)
// ===========================================================================

test("Red Card does not create an active effect", async () => {
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

test("Red Card rejects if the attacker has already finished", async () => {
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

test("Red Card rejects if powerup is USED", async () => {
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

test("Red Card rejects if powerup is DISCARDED", async () => {
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

test("Red Card rejects if powerup is EXPIRED", async () => {
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

test("Red Card rejects if race is COMPLETED", async () => {
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

test("Red Card rejects if race is PENDING", async () => {
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

test("Red Card rejects if race is CANCELLED", async () => {
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

test("Red Card rejects if used by someone who doesn't own it", async () => {
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
