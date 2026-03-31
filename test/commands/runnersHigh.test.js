const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Runner's High — self-only, doubles walked steps for 3 hours
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

function makePowerupDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  const bonusChanges = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);
  const participants = [user1, user2];

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
            type: "RUNNERS_HIGH",
            status: overrides.powerupStatus || "HELD",
            rarity: "UNCOMMON",
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
          if (type === "COMPRESSION_SOCKS") return null;
          if (type === "RUNNERS_HIGH" && overrides.existingRunnersHigh) {
            return overrides.existingRunnersHigh;
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
// Basic usage
// ===========================================================================

test("Runner's High creates an active effect on self", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
  assert.ok(result.effect);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "RUNNERS_HIGH");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-1");
  assert.equal(ctx.effectsCreated[0].sourceUserId, "user-1");
});

test("Runner's High effect lasts exactly 3 hours", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  const effect = ctx.effectsCreated[0];
  const startsAt = new Date(effect.startsAt).getTime();
  const expiresAt = new Date(effect.expiresAt).getTime();
  const threeHoursMs = 3 * 60 * 60 * 1000;

  assert.equal(expiresAt - startsAt, threeHoursMs);
});

test("Runner's High captures stepsAtBuffStart in metadata", async () => {
  const ctx = makePowerupDeps({ user1: { totalSteps: 7000 } });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.effectsCreated[0].metadata.stepsAtBuffStart, 7000);
});

test("Runner's High does not directly modify step counts", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 0);
});

// ===========================================================================
// Powerup status after use
// ===========================================================================

test("Runner's High marks powerup as USED after use", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

// ===========================================================================
// Events
// ===========================================================================

test("Runner's High emits POWERUP_USED event with correct payload", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "RUNNERS_HIGH");
  assert.equal(ctx.events[0].payload.userId, "user-1");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
});

test("Runner's High creates a feed event", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "RUNNERS_HIGH");
  assert.equal(ctx.feedEvents[0].raceId, "race-1");
});

// ===========================================================================
// Self-only constraint
// ===========================================================================

test("Runner's High rejects if a targetUserId is provided", async () => {
  const ctx = makePowerupDeps();
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
// Stacking — cannot use while one is already active
// ===========================================================================

test("Runner's High rejects if user already has an active Runner's High", async () => {
  const ctx = makePowerupDeps({
    existingRunnersHigh: {
      id: "eff-existing",
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T10:00:00Z"),
      expiresAt: new Date("2026-03-30T13:00:00Z"),
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

test("Runner's High powerup stays HELD when rejected due to existing active buff", async () => {
  const ctx = makePowerupDeps({
    existingRunnersHigh: {
      id: "eff-existing",
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T10:00:00Z"),
      expiresAt: new Date("2026-03-30T13:00:00Z"),
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
// Finished participant
// ===========================================================================

test("Runner's High rejects if user has already finished the race", async () => {
  const ctx = makePowerupDeps({
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

test("Runner's High rejects if powerup is USED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "USED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Runner's High rejects if powerup is DISCARDED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "DISCARDED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Runner's High rejects if powerup is EXPIRED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "EXPIRED" });
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

test("Runner's High rejects if race is COMPLETED", async () => {
  const ctx = makePowerupDeps({ raceStatus: "COMPLETED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Runner's High rejects if race is PENDING", async () => {
  const ctx = makePowerupDeps({ raceStatus: "PENDING" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Runner's High rejects if race is CANCELLED", async () => {
  const ctx = makePowerupDeps({ raceStatus: "CANCELLED" });
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

test("Runner's High rejects if used by someone who doesn't own it", async () => {
  const ctx = makePowerupDeps({ powerupOwner: "user-1" });
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
// Step sample handling during buff — via getRaceProgress
// ===========================================================================
//
// Runner's High doubles walked steps for 3 hours. Only walked (sampled) steps
// are doubled, NOT bonus steps.
//
// Timeline:
//   Race start:  2026-03-30T08:00:00Z
//   Buff start:  2026-03-30T12:00:00Z
//   Buff end:    2026-03-30T15:00:00Z
//   "now":       2026-03-30T17:00:00Z
// ===========================================================================

const RACE_START = new Date("2026-03-30T08:00:00Z");
const BUFF_START = new Date("2026-03-30T12:00:00Z");
const BUFF_END = new Date("2026-03-30T15:00:00Z");
const NOW = new Date("2026-03-30T17:00:00Z");

function makeProgressDeps(overrides = {}) {
  const finishCalls = [];
  const completeCalls = [];

  const legCramps = overrides.legCramps || [];
  const runnersHighs = overrides.runnersHighs || [];

  return {
    finishCalls,
    completeCalls,
    deps: {
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            targetSteps: overrides.targetSteps || 100000,
            startedAt: RACE_START,
            endsAt: new Date("2026-04-06T08:00:00Z"),
            powerupsEnabled: true,
            powerupStepInterval: 50000,
            participants: [
              makeParticipant("rp-1", "user-1", "Alice", {
                joinedAt: RACE_START,
                baselineSteps: 0,
                bonusSteps: overrides.bonusSteps || 0,
                finishedAt: overrides.finishedAt || null,
                nextBoxAtSteps: 50000,
              }),
            ],
          };
        },
      },
      StepSample: {
        async sumStepsInWindow(userId, start, end) {
          if (overrides.sumStepsInWindow) {
            return overrides.sumStepsInWindow(userId, start, end);
          }
          return overrides.totalSampleSteps || 0;
        },
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
        async findEffectsForRaceByType(raceId, participantId, type) {
          if (type === "LEG_CRAMP") return legCramps.filter((e) => !e.targetParticipantId || e.targetParticipantId === participantId);
          if (type === "RUNNERS_HIGH") return runnersHighs.filter((e) => !e.targetParticipantId || e.targetParticipantId === participantId);
          return [];
        },
        async findActiveForParticipant() { return overrides.activeEffects || []; },
        async findActiveForRace() { return overrides.activeEffects || []; },
      },
      RacePowerup: {
        async findHeldByParticipant() { return []; },
        async countMysteryBoxesByParticipant() { return 0; },
        async findMysteryBoxesByParticipant() { return []; },
      },
      expireEffects: async () => {},
      completeRace: async (data) => { completeCalls.push(data); },
      rollPowerup: async () => [],
      now: () => NOW,
    },
  };
}

test("Steps walked before buff are counted normally (not doubled)", async () => {
  // 5000 steps all before buff, 0 during buff
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 5000;
      if (s === BUFF_START.getTime() && e === BUFF_END.getTime()) return 0;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 5000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  assert.equal(p.totalSteps, 5000);
});

test("Steps walked during buff are doubled", async () => {
  // 8000 total: 5000 before buff, 3000 during buff
  // Expected: 8000 + 3000 (buff bonus) = 11000
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 8000;
      if (s === BUFF_START.getTime() && e === BUFF_END.getTime()) return 3000;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 5000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 8000 base + 3000 buffed = 11000
  assert.equal(p.totalSteps, 11000);
});

test("Steps walked after buff expires are counted normally", async () => {
  // 12000 total: 5000 before, 3000 during (doubled), 4000 after
  // Expected: 12000 + 3000 = 15000
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 12000;
      if (s === BUFF_START.getTime() && e === BUFF_END.getTime()) return 3000;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 5000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 12000 base + 3000 buffed = 15000
  assert.equal(p.totalSteps, 15000);
});

test("Steps spanning buff start boundary are excluded from doubling", async () => {
  // sumStepsInWindow for the buff window captures boundary-spanning samples
  // These should be excluded (same rule as Leg Cramp start boundary)
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 7000;
      // Buff window captures 2000 (no boundary-spanning samples included)
      if (s === BUFF_START.getTime() && e === BUFF_END.getTime()) return 2000;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 5000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 7000 base + 2000 buffed = 9000
  assert.equal(p.totalSteps, 9000);
});

test("Steps spanning buff end boundary are included in doubling", async () => {
  // Sample started during buff, ended after — should be included in buff
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 9000;
      // Buff window includes the boundary-spanning sample
      if (s === BUFF_START.getTime() && e === BUFF_END.getTime()) return 2500;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 5000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 9000 base + 2500 buffed = 11500
  assert.equal(p.totalSteps, 11500);
});

// ===========================================================================
// Active buff (not yet expired)
// ===========================================================================

test("Active Runner's High doubles steps walked so far during it", async () => {
  // Buff started at 12:00, now is 13:30 (1.5hr in, 1.5hr remaining)
  const midBuffNow = new Date("2026-03-30T13:30:00Z");

  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      if (s === RACE_START.getTime()) return 7000;
      if (s === BUFF_START.getTime()) return 2000;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 5000 },
    }],
  });
  ctx.deps.now = () => midBuffNow;

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 7000 base + 2000 buffed = 9000
  assert.equal(p.totalSteps, 9000);
});

// ===========================================================================
// Runner's High does NOT double bonus steps
// ===========================================================================

test("Runner's High does not double bonus steps", async () => {
  // 5000 walked steps, 1500 bonus steps, 2000 walked during buff
  // Expected: 5000 base + 2000 buffed + 1500 bonus = 8500
  // NOT: (5000 + 1500) base + (2000 + portion of 1500) buffed
  const ctx = makeProgressDeps({
    bonusSteps: 1500,
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 5000;
      if (s === BUFF_START.getTime() && e === BUFF_END.getTime()) return 2000;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 3000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 5000 base + 2000 buff + 1500 bonus = 8500
  assert.equal(p.totalSteps, 8500);
});

// ===========================================================================
// Edge case — 0 steps
// ===========================================================================

test("Runner's High on user with 0 steps doubles to 0", async () => {
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 0 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  assert.equal(p.totalSteps, 0);
});

// ===========================================================================
// Win detection — buff pushing total above target
// ===========================================================================

test("Runner's High buff pushes total above target — triggers race completion", async () => {
  // 8000 walked, 3000 during buff → 8000 + 3000 = 11000, target is 10000
  const ctx = makeProgressDeps({
    targetSteps: 10000,
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 8000;
      if (s === BUFF_START.getTime() && e === BUFF_END.getTime()) return 3000;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 5000 },
    }],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 1, "markFinished should be called");
  assert.equal(ctx.finishCalls[0].id, "rp-1");
  assert.equal(ctx.completeCalls.length, 1, "completeRace should be called");
  assert.equal(ctx.completeCalls[0].winnerUserId, "user-1");
});

test("Runner's High buff that doesn't reach target does NOT trigger win", async () => {
  // 5000 walked, 2000 during buff → 5000 + 2000 = 7000, target is 10000
  const ctx = makeProgressDeps({
    targetSteps: 10000,
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 5000;
      if (s === BUFF_START.getTime() && e === BUFF_END.getTime()) return 2000;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: BUFF_START,
      expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 3000 },
    }],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 0, "markFinished should NOT be called");
  assert.equal(ctx.completeCalls.length, 0, "completeRace should NOT be called");
});
