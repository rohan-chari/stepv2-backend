const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Protein Shake — self-only, instant, +1500 bonus steps
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
            type: "PROTEIN_SHAKE",
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
// Basic usage
// ===========================================================================

test("Protein Shake adds exactly 1500 bonus steps to self", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.bonus, 1500);
  assert.equal(ctx.bonusChanges.length, 1);
  assert.equal(ctx.bonusChanges[0].id, "rp-1");
  assert.equal(ctx.bonusChanges[0].amount, 1500);
  assert.equal(ctx.bonusChanges[0].type, "add");
});

test("Protein Shake is not blocked (self-only powerup)", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
});

test("Protein Shake status changes to USED after use", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt, "usedAt timestamp should be set");
});

test("Protein Shake does not create an active effect (it is instant)", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Instant powerups have no ongoing effect
  assert.equal(result.effect, undefined);
});

test("Protein Shake emits POWERUP_USED event", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "PROTEIN_SHAKE");
  assert.equal(ctx.events[0].payload.userId, "user-1");
});

test("Protein Shake creates a feed event", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "PROTEIN_SHAKE");
  assert.equal(ctx.feedEvents[0].raceId, "race-1");
});

// ===========================================================================
// Validation — status
// ===========================================================================

test("Protein Shake rejects if status is USED", async () => {
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

test("Protein Shake rejects if status is DISCARDED", async () => {
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

test("Protein Shake rejects if status is EXPIRED", async () => {
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
// Validation — race state
// ===========================================================================

test("Protein Shake rejects if race is COMPLETED", async () => {
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

test("Protein Shake rejects if race is PENDING", async () => {
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

test("Protein Shake rejects if race is CANCELLED", async () => {
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
// Validation — ownership
// ===========================================================================

test("Protein Shake rejects if used by someone who doesn't own it", async () => {
  // Powerup belongs to user-1, but user-2 tries to use it
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
// Self-only constraint
// ===========================================================================

test("Protein Shake does not require a targetUserId", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  // Should succeed without targetUserId
  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
  assert.equal(result.bonus, 1500);
});

test("Protein Shake bonus is applied to the user who used it, not to anyone else", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Only one bonus change, and it's for the user who used it
  assert.equal(ctx.bonusChanges.length, 1);
  assert.equal(ctx.bonusChanges[0].id, "rp-1"); // user-1's participant id
});

// ===========================================================================
// Win detection — Protein Shake pushing total above race target
// ===========================================================================
// Uses buildGetRaceProgress to verify that the +1500 bonus steps from
// Protein Shake are included in the race total and trigger race completion
// when they push a participant over the target.
// ===========================================================================

test("Protein Shake +1500 bonus pushes total above target — triggers race completion", async () => {
  const raceStart = new Date("2026-03-30T13:00:00.000Z");
  const finishCalls = [];
  const completeCalls = [];

  const getRaceProgress = buildGetRaceProgress({
    Race: {
      async findById() {
        return {
          id: "race-1",
          status: "ACTIVE",
          targetSteps: 10000,
          startedAt: raceStart,
          endsAt: new Date("2026-04-06T13:00:00.000Z"),
          powerupsEnabled: true,
          powerupStepInterval: 50000,
          participants: [
            makeParticipant("rp-1", "user-1", "Alice", {
              joinedAt: raceStart,
              baselineSteps: 0,
              bonusSteps: 1500, // from Protein Shake
              finishedAt: null,
              nextBoxAtSteps: 50000,
            }),
          ],
        };
      },
    },
    StepSample: {
      // 9000 base steps — not enough alone, but 9000 + 1500 bonus = 10500 > 10000
      async sumStepsInWindow() { return 9000; },
    },
    Steps: {
      async findByUserIdAndDate() { return null; },
      async findByUserIdAndDateRange() { return []; },
    },
    RaceParticipant: {
      async updateTotalSteps() {},
      async markFinished(id, time) { finishCalls.push({ id, time }); },
      async setPlacement() {},
    },
    RaceActiveEffect: {
      async findEffectsForRaceByType() { return []; },
      async findActiveForParticipant() { return []; },
      async findActiveForRace() { return []; },
    },
    RacePowerup: {
      async findHeldByParticipant() { return []; },
      async countMysteryBoxesByParticipant() { return 0; },
      async findMysteryBoxesByParticipant() { return []; },
    },
    expireEffects: async () => {},
    completeRace: async (data) => { completeCalls.push(data); },
    rollPowerup: async () => [],
    now: () => new Date("2026-03-30T16:00:00.000Z"),
  });

  await getRaceProgress("user-1", "race-1", "America/New_York");

  // Participant should be marked as finished
  assert.equal(finishCalls.length, 1, "markFinished should be called");
  assert.equal(finishCalls[0].id, "rp-1");

  // Race should be completed with user-1 as winner
  assert.equal(completeCalls.length, 1, "completeRace should be called");
  assert.equal(completeCalls[0].winnerUserId, "user-1");
});

test("Protein Shake +1500 bonus that doesn't reach target does NOT trigger win", async () => {
  const raceStart = new Date("2026-03-30T13:00:00.000Z");
  const finishCalls = [];
  const completeCalls = [];

  const getRaceProgress = buildGetRaceProgress({
    Race: {
      async findById() {
        return {
          id: "race-1",
          status: "ACTIVE",
          targetSteps: 20000,
          startedAt: raceStart,
          endsAt: new Date("2026-04-06T13:00:00.000Z"),
          powerupsEnabled: true,
          powerupStepInterval: 50000,
          participants: [
            makeParticipant("rp-1", "user-1", "Alice", {
              joinedAt: raceStart,
              baselineSteps: 0,
              bonusSteps: 1500, // from Protein Shake
              finishedAt: null,
              nextBoxAtSteps: 50000,
            }),
          ],
        };
      },
    },
    StepSample: {
      // 9000 base + 1500 bonus = 10500, still short of 20000 target
      async sumStepsInWindow() { return 9000; },
    },
    Steps: {
      async findByUserIdAndDate() { return null; },
      async findByUserIdAndDateRange() { return []; },
    },
    RaceParticipant: {
      async updateTotalSteps() {},
      async markFinished(id, time) { finishCalls.push({ id, time }); },
      async setPlacement() {},
    },
    RaceActiveEffect: {
      async findEffectsForRaceByType() { return []; },
      async findActiveForParticipant() { return []; },
      async findActiveForRace() { return []; },
    },
    RacePowerup: {
      async findHeldByParticipant() { return []; },
      async countMysteryBoxesByParticipant() { return 0; },
      async findMysteryBoxesByParticipant() { return []; },
    },
    expireEffects: async () => {},
    completeRace: async (data) => { completeCalls.push(data); },
    rollPowerup: async () => [],
    now: () => new Date("2026-03-30T16:00:00.000Z"),
  });

  await getRaceProgress("user-1", "race-1", "America/New_York");

  assert.equal(finishCalls.length, 0, "markFinished should NOT be called");
  assert.equal(completeCalls.length, 0, "completeRace should NOT be called");
});

test("Protein Shake bonus is reflected in the race progress total", async () => {
  const raceStart = new Date("2026-03-30T13:00:00.000Z");

  const getRaceProgress = buildGetRaceProgress({
    Race: {
      async findById() {
        return {
          id: "race-1",
          status: "ACTIVE",
          targetSteps: 100000,
          startedAt: raceStart,
          endsAt: new Date("2026-04-06T13:00:00.000Z"),
          powerupsEnabled: true,
          powerupStepInterval: 50000,
          participants: [
            makeParticipant("rp-1", "user-1", "Alice", {
              joinedAt: raceStart,
              baselineSteps: 0,
              bonusSteps: 1500,
              finishedAt: null,
              nextBoxAtSteps: 50000,
            }),
          ],
        };
      },
    },
    StepSample: {
      async sumStepsInWindow() { return 5000; },
    },
    Steps: {
      async findByUserIdAndDate() { return null; },
      async findByUserIdAndDateRange() { return []; },
    },
    RaceParticipant: {
      async updateTotalSteps() {},
      async markFinished() {},
      async setPlacement() {},
    },
    RaceActiveEffect: {
      async findEffectsForRaceByType() { return []; },
      async findActiveForParticipant() { return []; },
      async findActiveForRace() { return []; },
    },
    RacePowerup: {
      async findHeldByParticipant() { return []; },
      async countMysteryBoxesByParticipant() { return 0; },
      async findMysteryBoxesByParticipant() { return []; },
    },
    expireEffects: async () => {},
    completeRace: async () => {},
    rollPowerup: async () => [],
    now: () => new Date("2026-03-30T16:00:00.000Z"),
  });

  const result = await getRaceProgress("user-1", "race-1", "America/New_York");

  // 5000 base steps + 1500 bonus = 6500
  const p = result.participants.find((p) => p.userId === "user-1");
  assert.equal(p.totalSteps, 6500);
});
