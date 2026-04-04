const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");

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
  let powerupState = "HELD";

  const user1 = makeParticipant("user-1", overrides.user1);
  const user2 = makeParticipant("user-2", overrides.user2);
  const user3 = makeParticipant("user-3", { totalSteps: 8000, ...overrides.user3 });
  const participants = [user1, user2, user3];

  return {
    events,
    feedEvents,
    effectsCreated,
    bonusChanges,
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
          powerupState = fields.status || powerupState;
          return { id, ...fields };
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
        ...overrides.RaceParticipant,
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
        async update(id, fields) {
          return { id, ...fields };
        },
        ...overrides.RaceActiveEffect,
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
            participants,
          };
        },
        ...overrides.Race,
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      now: () => new Date("2026-01-15T12:00:00Z"),
    },
  };
}

test("usePowerup applies Protein Shake bonus", async () => {
  const ctx = makeDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
  assert.equal(result.bonus, 1500);
  assert.equal(ctx.bonusChanges[0].amount, 1500);
  assert.equal(ctx.bonusChanges[0].type, "add");
  assert.equal(ctx.events[0].event, "POWERUP_USED");
});

test("usePowerup applies Runner's High effect", async () => {
  const ctx = makeDeps({ powerupType: "RUNNERS_HIGH" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
  assert.ok(result.effect);
  assert.equal(ctx.effectsCreated[0].type, "RUNNERS_HIGH");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-1");
  assert.ok(ctx.effectsCreated[0].expiresAt);
});

test("usePowerup applies Stealth Mode effect", async () => {
  const ctx = makeDeps({ powerupType: "STEALTH_MODE" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.effectsCreated[0].type, "STEALTH_MODE");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-1");
});

test("usePowerup applies Compression Socks shield", async () => {
  const ctx = makeDeps({ powerupType: "COMPRESSION_SOCKS" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.effectsCreated[0].type, "COMPRESSION_SOCKS");
  assert.ok(ctx.effectsCreated[0].expiresAt, "should have expiresAt set");
});

test("usePowerup applies Leg Cramp to target", async () => {
  const ctx = makeDeps({ powerupType: "LEG_CRAMP" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, false);
  assert.equal(ctx.effectsCreated[0].type, "LEG_CRAMP");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-2");
  assert.equal(ctx.effectsCreated[0].metadata.stepsAtFreezeStart, 10000);
});

test("usePowerup applies Shortcut and transfers steps", async () => {
  const ctx = makeDeps({ powerupType: "SHORTCUT" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.stolen, 1000);
  assert.deepEqual(ctx.bonusChanges, [
    { id: "rp-user-2", type: "subtract", amount: 1000 },
    { id: "rp-user-1", type: "add", amount: 1000 },
  ]);
});

test("usePowerup Red Card auto-targets leader", async () => {
  // user-2 is leader with most steps
  const ctx = makeDeps({
    powerupType: "RED_CARD",
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
  assert.equal(result.penalty, 2000); // 10% of 20000
  assert.equal(ctx.bonusChanges[0].id, "rp-user-2");
  assert.equal(ctx.bonusChanges[0].amount, 2000);
});

test("usePowerup Red Card rejects when user is leader", async () => {
  const ctx = makeDeps({
    powerupType: "RED_CARD",
    user1: { totalSteps: 50000 },
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

test("usePowerup Second Wind gives bonus based on gap", async () => {
  const ctx = makeDeps({
    powerupType: "SECOND_WIND",
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Gap is 15000, bonus = floor(15000 * 0.25) = 3750
  assert.equal(result.bonus, 3750);
  assert.equal(ctx.bonusChanges[0].amount, 3750);
});

test("usePowerup Second Wind clamps to min 500", async () => {
  const ctx = makeDeps({
    powerupType: "SECOND_WIND",
    user1: { totalSteps: 19500 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 500);
});

test("usePowerup Compression Socks blocks offensive powerup", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.events[0].event, "POWERUP_BLOCKED");
});

test("usePowerup rejects targeting self", async () => {
  const ctx = makeDeps({ powerupType: "LEG_CRAMP" });
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

test("usePowerup rejects targeted powerup without target", async () => {
  const ctx = makeDeps({ powerupType: "SHORTCUT" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.ok(err.message.includes("requires a target"));
      return true;
    }
  );
});

test("usePowerup rejects if powerup is not HELD", async () => {
  const ctx = makeDeps({ powerupStatus: "USED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.ok(err.message.includes("already been used"));
      return true;
    }
  );
});

// ===========================================================================
// Finished participants — powerups should not affect finished users
// ===========================================================================

test("usePowerup rejects if attacker has finished the race (self powerup)", async () => {
  const ctx = makeDeps({
    powerupType: "PROTEIN_SHAKE",
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

test("usePowerup rejects if attacker has finished the race (offensive powerup)", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
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

test("usePowerup rejects targeting a finished participant (Leg Cramp)", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
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

test("usePowerup rejects targeting a finished participant (Shortcut)", async () => {
  const ctx = makeDeps({
    powerupType: "SHORTCUT",
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

test("Finished user's steps are not modified by Red Card", async () => {
  // user-2 is leader but finished — Red Card should not target them
  const ctx = makeDeps({
    powerupType: "RED_CARD",
    user2: { totalSteps: 20000, finishedAt: new Date("2026-03-29T10:00:00Z") },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
  assert.equal(ctx.bonusChanges.length, 0);
});

// ===========================================================================
// Steps cannot go negative
// ===========================================================================

test("Red Card on a user with very few steps does not make them negative", async () => {
  // user-2 is leader with 100 steps, 10% = 10
  const ctx = makeDeps({
    powerupType: "RED_CARD",
    user1: { totalSteps: 50 },
    user2: { totalSteps: 100 },
    user3: { totalSteps: 30 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Penalty should be 10 (10% of 100), which keeps them at 90 — not negative
  assert.equal(result.penalty, 10);
  assert.ok(result.penalty <= 100, "penalty should not exceed the leader's total steps");
});


test("Leg Cramp on a user with 0 steps does not put them negative after freeze", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    user2: { totalSteps: 0 },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  // Should succeed but freeze at 0
  assert.equal(result.blocked, false);
  assert.ok(ctx.effectsCreated[0].metadata.stepsAtFreezeStart === 0);
});

test("usePowerup rejects if race is not ACTIVE", async () => {
  const ctx = makeDeps({ raceStatus: "COMPLETED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.ok(err.message.includes("not active"));
      return true;
    }
  );
});
