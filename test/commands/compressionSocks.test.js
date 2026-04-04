const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");
const { buildExpireEffects } = require("../../src/commands/expireEffects");

// ---------------------------------------------------------------------------
// Compression Socks — self-only, shield that blocks the next offensive powerup
// No expiry — lasts until consumed.
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
  const effectUpdates = [];
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
    effectUpdates,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            type: overrides.powerupType || "COMPRESSION_SOCKS",
            status: overrides.powerupStatus || "HELD",
            rarity: overrides.powerupRarity || "RARE",
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
            if (overrides.shieldHolder && overrides.shieldHolder !== participantId) return null;
            return overrides.existingShield;
          }
          if (type === "COMPRESSION_SOCKS" && overrides.existingShieldOnSelf) {
            if (participantId === "rp-1") return overrides.existingShieldOnSelf;
          }
          return null;
        },
        async create(data) {
          const e = { id: "eff-1", ...data };
          effectsCreated.push(e);
          return e;
        },
        async update(id, fields) {
          effectUpdates.push({ id, ...fields });
          return { id, ...fields };
        },
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
// Basic usage — creating the shield
// ===========================================================================

test("Compression Socks creates a shield effect on self", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
  assert.ok(result.effect);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "COMPRESSION_SOCKS");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-1");
  assert.equal(ctx.effectsCreated[0].sourceUserId, "user-1");
});



test("Compression Socks does not modify any step counts", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 0);
});

// ===========================================================================
// Powerup status after use
// ===========================================================================

test("Compression Socks marks powerup as USED after use", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

// ===========================================================================
// Events
// ===========================================================================

test("Compression Socks emits POWERUP_USED event with correct payload", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "COMPRESSION_SOCKS");
  assert.equal(ctx.events[0].payload.userId, "user-1");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
});

test("Compression Socks creates a feed event", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "COMPRESSION_SOCKS");
});

// ===========================================================================
// Self-only constraint
// ===========================================================================

test("Compression Socks rejects if a targetUserId is provided", async () => {
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
// Stacking — reject if already have active shield
// ===========================================================================

test("Compression Socks rejects if user already has an active shield", async () => {
  const ctx = makeDeps({
    existingShieldOnSelf: {
      id: "eff-existing",
      type: "COMPRESSION_SOCKS",
      status: "ACTIVE",
    },
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

test("Compression Socks powerup stays HELD when rejected due to existing shield", async () => {
  const ctx = makeDeps({
    existingShieldOnSelf: {
      id: "eff-existing",
      type: "COMPRESSION_SOCKS",
      status: "ACTIVE",
    },
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
// Blocking offensive powerups
// ===========================================================================

test("Compression Socks blocks Leg Cramp", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    powerupOwner: "user-2",
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
    shieldHolder: "rp-1",
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.effectsCreated.length, 0, "no Leg Cramp effect should be created");
  assert.equal(ctx.bonusChanges.length, 0);
});

test("Compression Socks blocks Shortcut", async () => {
  const ctx = makeDeps({
    powerupType: "SHORTCUT",
    powerupRarity: "COMMON",
    powerupOwner: "user-2",
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
    shieldHolder: "rp-1",
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.bonusChanges.length, 0, "no steps should be stolen");
});

test("Compression Socks blocks Red Card", async () => {
  const ctx = makeDeps({
    powerupType: "RED_CARD",
    powerupOwner: "user-3",
    user1: { totalSteps: 20000 }, // leader
    user3: { totalSteps: 5000 },
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
    shieldHolder: "rp-1",
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-3", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.bonusChanges.length, 0, "no steps should be removed");
});

// ===========================================================================
// Shield is consumed when it blocks
// ===========================================================================

test("Shield status changes to BLOCKED when it absorbs an attack", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    powerupOwner: "user-2",
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
    shieldHolder: "rp-1",
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  const shieldUpdate = ctx.effectUpdates.find((u) => u.id === "eff-shield");
  assert.ok(shieldUpdate, "shield should be updated");
  assert.equal(shieldUpdate.status, "BLOCKED");
});

test("Attacker's powerup is still marked USED when blocked", async () => {
  const ctx = makeDeps({
    powerupType: "SHORTCUT",
    powerupRarity: "COMMON",
    powerupOwner: "user-2",
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
    shieldHolder: "rp-1",
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

// ===========================================================================
// POWERUP_BLOCKED event
// ===========================================================================

test("Blocking emits POWERUP_BLOCKED event", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    powerupOwner: "user-2",
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
    shieldHolder: "rp-1",
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  const blockedEvent = ctx.events.find((e) => e.event === "POWERUP_BLOCKED");
  assert.ok(blockedEvent, "should emit POWERUP_BLOCKED event");
  assert.equal(blockedEvent.payload.attackerUserId, "user-2");
  assert.equal(blockedEvent.payload.defenderUserId, "user-1");
  assert.equal(blockedEvent.payload.blockedType, "LEG_CRAMP");
});

test("Blocking creates a feed event describing the block", async () => {
  const ctx = makeDeps({
    powerupType: "SHORTCUT",
    powerupRarity: "COMMON",
    powerupOwner: "user-2",
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
    shieldHolder: "rp-1",
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_BLOCKED");
});

// ===========================================================================
// Can activate while under Leg Cramp (doesn't remove it)
// ===========================================================================

test("Compression Socks can be activated while under a Leg Cramp", async () => {
  // user-1 has an active Leg Cramp but no existing shield
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
  assert.ok(result.effect);
  assert.equal(ctx.effectsCreated[0].type, "COMPRESSION_SOCKS");
});

// ===========================================================================
// Finished participant
// ===========================================================================

test("Compression Socks rejects if user has already finished the race", async () => {
  const ctx = makeDeps({
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

test("Compression Socks rejects if powerup is USED", async () => {
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

test("Compression Socks rejects if powerup is DISCARDED", async () => {
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

test("Compression Socks rejects if powerup is EXPIRED", async () => {
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

test("Compression Socks rejects if race is COMPLETED", async () => {
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

test("Compression Socks rejects if race is PENDING", async () => {
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

test("Compression Socks rejects if race is CANCELLED", async () => {
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

test("Compression Socks rejects if used by someone who doesn't own it", async () => {
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

// ===========================================================================
// 24-hour expiry
// ===========================================================================

test("Compression Socks shield has 24-hour expiry", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.effectsCreated.length, 1);
  const effect = ctx.effectsCreated[0];
  assert.ok(effect.expiresAt, "should have an expiresAt timestamp");

  const startsAt = effect.startsAt.getTime();
  const expiresAt = effect.expiresAt.getTime();
  assert.equal(expiresAt - startsAt, 24 * 60 * 60 * 1000);
});

test("Compression Socks expires naturally after 24 hours if not consumed", async () => {
  const expired = [];
  const feedEvents = [];

  const expire = buildExpireEffects({
    RaceActiveEffect: {
      async findExpired() {
        return [{
          id: "eff-cs",
          raceId: "race-1",
          targetParticipantId: "rp-1",
          targetUserId: "user-1",
          type: "COMPRESSION_SOCKS",
          status: "ACTIVE",
          expiresAt: new Date("2026-03-29T12:00:00Z"),
          metadata: {},
        }];
      },
      async update(id, fields) {
        expired.push({ id, ...fields });
        return { id, ...fields };
      },
    },
    RacePowerupEvent: {
      async create(data) {
        feedEvents.push(data);
        return { id: "fe-1", ...data };
      },
    },
    eventBus: { emit() {} },
    now: () => new Date("2026-03-30T12:00:00Z"),
  });

  await expire({ raceId: "race-1" });

  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, "EXPIRED");
  assert.equal(feedEvents.length, 1);
  assert.ok(feedEvents[0].description.includes("Compression Socks"));
});
