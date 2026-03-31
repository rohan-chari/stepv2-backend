const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");

// ---------------------------------------------------------------------------
// Shortcut — targeted, offensive, steals up to 1000 steps from target
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
            type: "SHORTCUT",
            status: overrides.powerupStatus || "HELD",
            rarity: "COMMON",
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
          if (type === "COMPRESSION_SOCKS") return overrides.existingShield || null;
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
// Basic usage — step transfer
// ===========================================================================

test("Shortcut steals up to 1000 steps from the target", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.stolen, 1000);
  assert.deepEqual(ctx.bonusChanges, [
    { id: "rp-2", type: "subtract", amount: 1000 },
    { id: "rp-1", type: "add", amount: 1000 },
  ]);
});

test("Shortcut subtracts from target before adding to self", async () => {
  // Ensures the order is subtract-then-add (not the other way around)
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.bonusChanges[0].type, "subtract");
  assert.equal(ctx.bonusChanges[0].id, "rp-2");
  assert.equal(ctx.bonusChanges[1].type, "add");
  assert.equal(ctx.bonusChanges[1].id, "rp-1");
});

test("Shortcut on a target behind you pushes them further back", async () => {
  // user-1 at 10000, user-3 at 8000 — gap is 2000
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-3" });

  // Should still steal 1000 even though target is behind
  assert.equal(result.stolen, 1000);
  assert.deepEqual(ctx.bonusChanges, [
    { id: "rp-3", type: "subtract", amount: 1000 },
    { id: "rp-1", type: "add", amount: 1000 },
  ]);
});

// ===========================================================================
// Edge cases — target step counts
// ===========================================================================

test("Shortcut rejects targeting a player with 0 steps", async () => {
  const ctx = makeDeps({ user2: { totalSteps: 0 } });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.ok(err.message.includes("0 steps"));
      return true;
    }
  );
  // Powerup should not be consumed
  assert.equal(ctx.updatedPowerup, null);
  assert.equal(ctx.bonusChanges.length, 0);
});

test("Shortcut on target with fewer than 1000 steps steals only what they have", async () => {
  const ctx = makeDeps({ user2: { totalSteps: 400 } });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.stolen, 400);
  assert.deepEqual(ctx.bonusChanges, [
    { id: "rp-2", type: "subtract", amount: 400 },
    { id: "rp-1", type: "add", amount: 400 },
  ]);
});

test("Shortcut on target with exactly 1000 steps steals exactly 1000", async () => {
  const ctx = makeDeps({ user2: { totalSteps: 1000 } });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.stolen, 1000);
});

test("Shortcut never puts target below zero steps", async () => {
  const ctx = makeDeps({ user2: { totalSteps: 3 } });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  // Should steal at most 3, never subtract more than totalSteps
  assert.equal(result.stolen, 3);
  assert.equal(ctx.bonusChanges[0].amount, 3);
});

test("Shortcut stolen amount equals the amount added to self", async () => {
  const ctx = makeDeps({ user2: { totalSteps: 600 } });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  const subtracted = ctx.bonusChanges.find((c) => c.type === "subtract");
  const added = ctx.bonusChanges.find((c) => c.type === "add");
  assert.equal(subtracted.amount, added.amount, "subtracted and added amounts must match");
  assert.equal(result.stolen, added.amount);
});

// ===========================================================================
// Powerup status after use
// ===========================================================================

test("Shortcut marks powerup as USED after use", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt, "usedAt timestamp should be set");
});

// ===========================================================================
// Events
// ===========================================================================

test("Shortcut emits POWERUP_USED event with correct payload", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "SHORTCUT");
  assert.equal(ctx.events[0].payload.userId, "user-1");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
  assert.equal(ctx.events[0].payload.targetUserId, "user-2");
});

test("Shortcut creates a feed event with correct fields", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "SHORTCUT");
  assert.equal(ctx.feedEvents[0].raceId, "race-1");
  assert.equal(ctx.feedEvents[0].targetUserId, "user-2");
});

test("Shortcut feed event description mentions the stolen amount", async () => {
  const ctx = makeDeps({ user2: { totalSteps: 500 } });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.ok(ctx.feedEvents[0].description.includes("500"), "description should include stolen amount");
});

// ===========================================================================
// Compression Socks shield blocks Shortcut
// ===========================================================================

test("Shortcut is blocked by Compression Socks", async () => {
  const ctx = makeDeps({
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.bonusChanges.length, 0, "no steps should be transferred when blocked");
});

test("Shortcut blocked by shield emits POWERUP_BLOCKED event", async () => {
  const ctx = makeDeps({
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.events[0].event, "POWERUP_BLOCKED");
});

// ===========================================================================
// Targeting validation
// ===========================================================================

test("Shortcut requires a targetUserId", async () => {
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

test("Shortcut cannot target yourself", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.ok(err.message.includes("cannot target yourself"));
      return true;
    }
  );
});

test("Shortcut rejects targeting a user not in the race", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-999" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Finished participants
// ===========================================================================

test("Shortcut rejects targeting a participant who has finished the race", async () => {
  const ctx = makeDeps({
    user2: { finishedAt: new Date("2026-03-29T10:00:00Z") },
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

test("Shortcut rejects if the attacker has already finished the race", async () => {
  const ctx = makeDeps({
    user1: { finishedAt: new Date("2026-03-29T10:00:00Z") },
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
// Participant status validation
// ===========================================================================

test("Shortcut rejects targeting a participant with DECLINED status", async () => {
  const ctx = makeDeps({
    user2: { status: "DECLINED" },
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

test("Shortcut rejects targeting a participant with INVITED status", async () => {
  const ctx = makeDeps({
    user2: { status: "INVITED" },
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
// Powerup status validation
// ===========================================================================

test("Shortcut rejects if powerup status is USED", async () => {
  const ctx = makeDeps({ powerupStatus: "USED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Shortcut rejects if powerup status is DISCARDED", async () => {
  const ctx = makeDeps({ powerupStatus: "DISCARDED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Shortcut rejects if powerup status is EXPIRED", async () => {
  const ctx = makeDeps({ powerupStatus: "EXPIRED" });
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
// Race status validation
// ===========================================================================

test("Shortcut rejects if race is COMPLETED", async () => {
  const ctx = makeDeps({ raceStatus: "COMPLETED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Shortcut rejects if race is PENDING", async () => {
  const ctx = makeDeps({ raceStatus: "PENDING" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Shortcut rejects if race is CANCELLED", async () => {
  const ctx = makeDeps({ raceStatus: "CANCELLED" });
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
// Ownership validation
// ===========================================================================

test("Shortcut rejects if used by someone who doesn't own it", async () => {
  const ctx = makeDeps({ powerupOwner: "user-1" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-3" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Shortcut does not create a timed active effect (it is instant)
// ===========================================================================

test("Shortcut does not create an active effect", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.effect, undefined);
  assert.equal(ctx.effectsCreated.length, 0);
});
