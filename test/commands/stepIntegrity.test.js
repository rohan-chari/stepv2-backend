const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup } = require("../../src/commands/usePowerup");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Step Integrity — powerup bonuses/penalties must not affect real step data
//
// Real steps: Step model (daily totals), StepSample model (windowed samples)
// Artificial steps: bonusSteps on RaceParticipant, effect modifiers (freeze/buff/reverse)
//
// Rules:
//   1. usePowerup only writes to bonusSteps, never to Step or StepSample
//   2. getRaceProgress only reads from Step/StepSample, never writes to them
//   3. Effect modifiers adjust the computed total, not the underlying data
//   4. General leaderboard uses raw Step data, not race-adjusted totals
// ---------------------------------------------------------------------------

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

// ===========================================================================
// usePowerup — only modifies bonusSteps, never raw step data
// ===========================================================================

function makePowerupDeps(overrides = {}) {
  const bonusChanges = [];
  const stepWrites = [];
  const stepSampleWrites = [];

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);
  const user3 = makeParticipant("rp-3", "user-3", "Carol", { totalSteps: 8000, ...overrides.user3 });
  const participants = [user1, user2, user3];

  return {
    bonusChanges,
    stepWrites,
    stepSampleWrites,
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: "user-1",
            raceId: "race-1",
            type: overrides.powerupType || "PROTEIN_SHAKE",
            status: "HELD",
            rarity: "COMMON",
          };
        },
        async update(id, fields) { return { id, ...fields }; },
      },
      RaceParticipant: {
        async addBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "add", amount });
        },
        async subtractBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "subtract", amount });
        },
        async updatePowerupSlots() {},
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant() { return null; },
        async create(data) { return { id: "eff-1", ...data }; },
        async update(id, fields) { return { id, ...fields }; },
      },
      RacePowerupEvent: {
        async create(data) { return { id: "fe-1", ...data }; },
      },
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            targetSteps: 50000,
            participants,
          };
        },
      },
      // Spy on Step and StepSample writes — these should never be called
      Steps: {
        async create(data) { stepWrites.push(data); },
        async update(id, data) { stepWrites.push({ id, ...data }); },
      },
      StepSample: {
        async create(data) { stepSampleWrites.push(data); },
        async update(id, data) { stepSampleWrites.push({ id, ...data }); },
      },
      eventBus: { emit() {} },
      now: () => new Date("2026-03-30T12:00:00Z"),
    },
  };
}

test("Protein Shake only writes to bonusSteps, not to Step or StepSample", async () => {
  const ctx = makePowerupDeps({ powerupType: "PROTEIN_SHAKE" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 1);
  assert.equal(ctx.bonusChanges[0].type, "add");
  assert.equal(ctx.stepWrites.length, 0, "Step model should not be written to");
  assert.equal(ctx.stepSampleWrites.length, 0, "StepSample model should not be written to");
});

test("Shortcut only writes to bonusSteps, not to Step or StepSample", async () => {
  const ctx = makePowerupDeps({ powerupType: "SHORTCUT" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  // subtract from target + add to self = 2 bonus changes
  assert.equal(ctx.bonusChanges.length, 2);
  assert.equal(ctx.stepWrites.length, 0, "Step model should not be written to");
  assert.equal(ctx.stepSampleWrites.length, 0, "StepSample model should not be written to");
});

test("Red Card only writes to bonusSteps, not to Step or StepSample", async () => {
  const ctx = makePowerupDeps({
    powerupType: "RED_CARD",
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
    user3: { totalSteps: 3000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 1);
  assert.equal(ctx.bonusChanges[0].type, "subtract");
  assert.equal(ctx.stepWrites.length, 0, "Step model should not be written to");
  assert.equal(ctx.stepSampleWrites.length, 0, "StepSample model should not be written to");
});

test("Second Wind only writes to bonusSteps, not to Step or StepSample", async () => {
  const ctx = makePowerupDeps({
    powerupType: "SECOND_WIND",
    user1: { totalSteps: 5000 },
    user2: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 1);
  assert.equal(ctx.bonusChanges[0].type, "add");
  assert.equal(ctx.stepWrites.length, 0, "Step model should not be written to");
  assert.equal(ctx.stepSampleWrites.length, 0, "StepSample model should not be written to");
});

test("Leg Cramp does not write to Step, StepSample, or bonusSteps", async () => {
  const ctx = makePowerupDeps({ powerupType: "LEG_CRAMP" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.bonusChanges.length, 0, "Leg Cramp should not modify bonusSteps");
  assert.equal(ctx.stepWrites.length, 0, "Step model should not be written to");
  assert.equal(ctx.stepSampleWrites.length, 0, "StepSample model should not be written to");
});

test("Wrong Turn does not write to Step, StepSample, or bonusSteps", async () => {
  const ctx = makePowerupDeps({ powerupType: "WRONG_TURN" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.bonusChanges.length, 0, "Wrong Turn should not modify bonusSteps");
  assert.equal(ctx.stepWrites.length, 0, "Step model should not be written to");
  assert.equal(ctx.stepSampleWrites.length, 0, "StepSample model should not be written to");
});

test("Runner's High does not write to Step, StepSample, or bonusSteps", async () => {
  const ctx = makePowerupDeps({ powerupType: "RUNNERS_HIGH" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 0, "Runner's High should not modify bonusSteps");
  assert.equal(ctx.stepWrites.length, 0, "Step model should not be written to");
  assert.equal(ctx.stepSampleWrites.length, 0, "StepSample model should not be written to");
});

// ===========================================================================
// getRaceProgress — reads raw steps, computes adjusted total, never writes to Step/StepSample
// ===========================================================================

const RACE_START = new Date("2026-03-30T08:00:00Z");
const NOW = new Date("2026-03-30T16:00:00Z");

function makeProgressDeps(overrides = {}) {
  const stepWrites = [];
  const stepSampleWrites = [];
  const totalStepsUpdates = [];

  const participants = overrides.participants || [
    makeParticipant("rp-1", "user-1", "Alice", {
      joinedAt: RACE_START,
      baselineSteps: 0,
      bonusSteps: overrides.bonusSteps || 0,
      finishedAt: null,
      nextBoxAtSteps: 50000,
    }),
  ];

  return {
    stepWrites,
    stepSampleWrites,
    totalStepsUpdates,
    deps: {
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            targetSteps: 100000,
            startedAt: RACE_START,
            endsAt: new Date("2026-04-06T08:00:00Z"),
            powerupsEnabled: true,
            powerupStepInterval: 50000,
            participants,
          };
        },
      },
      StepSample: {
        async sumStepsInWindow(userId, start, end) {
          if (overrides.sumStepsInWindow) return overrides.sumStepsInWindow(userId, start, end);
          return overrides.rawSteps || 5000;
        },
        // Spy: should never be called
        async create(data) { stepSampleWrites.push(data); },
        async update(id, data) { stepSampleWrites.push({ id, ...data }); },
      },
      Steps: {
        async findByUserIdAndDate() { return null; },
        async findByUserIdAndDateRange() { return []; },
        // Spy: should never be called
        async create(data) { stepWrites.push(data); },
        async update(id, data) { stepWrites.push({ id, ...data }); },
      },
      RaceParticipant: {
        async updateTotalSteps(id, totalSteps) { totalStepsUpdates.push({ id, totalSteps }); },
        async markFinished() {},
        async setPlacement() {},
      },
      RaceActiveEffect: {
        async findEffectsForRaceByType(raceId, participantId, type) {
          if (type === "LEG_CRAMP") return overrides.legCramps || [];
          if (type === "RUNNERS_HIGH") return overrides.runnersHighs || [];
          if (type === "WRONG_TURN") return overrides.wrongTurns || [];
          return [];
        },
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
      now: () => NOW,
    },
  };
}

test("getRaceProgress never writes to Step model", async () => {
  const ctx = makeProgressDeps({ rawSteps: 8000, bonusSteps: 1500 });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.stepWrites.length, 0, "Step model should never be written to by getRaceProgress");
});

test("getRaceProgress never writes to StepSample model", async () => {
  const ctx = makeProgressDeps({ rawSteps: 8000, bonusSteps: 1500 });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.stepSampleWrites.length, 0, "StepSample model should never be written to by getRaceProgress");
});

test("getRaceProgress with Leg Cramp does not write to Step or StepSample", async () => {
  const FREEZE_START = new Date("2026-03-30T12:00:00Z");
  const FREEZE_END = new Date("2026-03-30T14:00:00Z");

  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start) {
      if (start.getTime() === RACE_START.getTime()) return 10000;
      if (start.getTime() === FREEZE_START.getTime()) return 2000;
      return 0;
    },
    legCramps: [{
      id: "eff-1", type: "LEG_CRAMP", status: "EXPIRED",
      startsAt: FREEZE_START, expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 8000 },
    }],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.stepWrites.length, 0, "Leg Cramp should not write to Step model");
  assert.equal(ctx.stepSampleWrites.length, 0, "Leg Cramp should not write to StepSample model");
});

test("getRaceProgress with Runner's High does not write to Step or StepSample", async () => {
  const BUFF_START = new Date("2026-03-30T12:00:00Z");
  const BUFF_END = new Date("2026-03-30T15:00:00Z");

  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start) {
      if (start.getTime() === RACE_START.getTime()) return 10000;
      if (start.getTime() === BUFF_START.getTime()) return 3000;
      return 0;
    },
    runnersHighs: [{
      id: "eff-1", type: "RUNNERS_HIGH", status: "EXPIRED",
      startsAt: BUFF_START, expiresAt: BUFF_END,
      metadata: { stepsAtBuffStart: 7000 },
    }],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.stepWrites.length, 0, "Runner's High should not write to Step model");
  assert.equal(ctx.stepSampleWrites.length, 0, "Runner's High should not write to StepSample model");
});

test("getRaceProgress with Wrong Turn does not write to Step or StepSample", async () => {
  const WT_START = new Date("2026-03-30T12:00:00Z");
  const WT_END = new Date("2026-03-30T13:00:00Z");

  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start) {
      if (start.getTime() === RACE_START.getTime()) return 8000;
      if (start.getTime() === WT_START.getTime()) return 1000;
      return 0;
    },
    wrongTurns: [{
      id: "eff-1", type: "WRONG_TURN", status: "EXPIRED",
      startsAt: WT_START, expiresAt: WT_END,
      metadata: {},
    }],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.stepWrites.length, 0, "Wrong Turn should not write to Step model");
  assert.equal(ctx.stepSampleWrites.length, 0, "Wrong Turn should not write to StepSample model");
});

// ===========================================================================
// Bonus steps are separate from raw steps in the computed total
// ===========================================================================

test("bonusSteps are added on top of raw steps, not mixed into them", async () => {
  const ctx = makeProgressDeps({ rawSteps: 5000, bonusSteps: 1500 });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // Total = raw (5000) + bonus (1500) = 6500
  assert.equal(p.totalSteps, 6500);
});

test("Negative bonusSteps (from Shortcut/Red Card) reduce total but don't change raw steps", async () => {
  // User had 1000 bonus stolen (bonusSteps = -1000)
  const ctx = makeProgressDeps({ rawSteps: 8000, bonusSteps: -1000 });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // Total = raw (8000) + bonus (-1000) = 7000
  assert.equal(p.totalSteps, 7000);
});

test("updateTotalSteps receives the computed total (raw + adjustments), not just raw", async () => {
  const ctx = makeProgressDeps({ rawSteps: 5000, bonusSteps: 2000 });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  // The stored totalSteps should be the full computed value
  assert.equal(ctx.totalStepsUpdates.length, 1);
  assert.equal(ctx.totalStepsUpdates[0].totalSteps, 7000); // 5000 + 2000
});

test("Effect modifiers adjust computed total without touching raw step counts", async () => {
  const FREEZE_START = new Date("2026-03-30T12:00:00Z");
  const FREEZE_END = new Date("2026-03-30T14:00:00Z");

  const ctx = makeProgressDeps({
    rawSteps: 10000,
    bonusSteps: 500,
    sumStepsInWindow(userId, start) {
      if (start.getTime() === RACE_START.getTime()) return 10000;
      if (start.getTime() === FREEZE_START.getTime()) return 3000;
      return 0;
    },
    legCramps: [{
      id: "eff-1", type: "LEG_CRAMP", status: "EXPIRED",
      startsAt: FREEZE_START, expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 7000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // raw (10000) - frozen (3000) + bonus (500) = 7500
  assert.equal(p.totalSteps, 7500);
  // And no writes to raw step data
  assert.equal(ctx.stepWrites.length, 0);
  assert.equal(ctx.stepSampleWrites.length, 0);
});
