const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/modules/races/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Display clamp: stepsUntilNextPowerup can never read above one interval.
//
// nextBoxAtSteps ratchets up off effective steps; a transient step-spike (later
// corrected) can push it far above the player's REAL steps, which previously
// surfaced as a wildly-inflated "steps to next box" (e.g. ~12000 when the
// interval is 2000). The countdown must be clamped to [0, powerupStepInterval].
// ---------------------------------------------------------------------------

const RACE_START = new Date("2026-03-30T13:00:00.000Z");
const NOW = new Date("2026-03-31T15:00:00.000Z");
const TZ = "America/New_York";

// Only ~1500 real steps logged for the user.
const SAMPLES = [
  { userId: "user-1", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 500 },
  { userId: "user-1", periodStart: "2026-03-31T12:00:00.000Z", periodEnd: "2026-03-31T13:00:00.000Z", steps: 1000 },
];

function createStepSampleStore(samples) {
  return {
    async sumStepsInWindow(userId, windowStart, windowEnd) {
      const ws = new Date(windowStart).getTime();
      const we = new Date(windowEnd).getTime();
      return samples
        .filter(
          (s) =>
            s.userId === userId &&
            new Date(s.periodEnd).getTime() > ws &&
            new Date(s.periodStart).getTime() < we
        )
        .reduce((sum, s) => sum + s.steps, 0);
    },
  };
}

function makeParticipant(overrides = {}) {
  return {
    id: "rp-1",
    userId: "user-1",
    status: "ACCEPTED",
    joinedAt: RACE_START,
    baselineSteps: 0,
    finishedAt: null,
    bonusSteps: 0,
    nextBoxAtSteps: 0,
    powerupSlots: overrides.powerupSlots || 3,
    user: { displayName: "TestUser" },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const slotPowerups = overrides.slotPowerups || [];

  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 100000,
    startedAt: RACE_START,
    endsAt: new Date("2026-04-06T13:00:00.000Z"),
    powerupsEnabled: true,
    powerupStepInterval: overrides.powerupStepInterval || 2000,
    participants: [makeParticipant(overrides.participant || {})],
  };

  return {
    deps: {
      Race: { async findById() { return race; } },
      StepSample: createStepSampleStore(SAMPLES),
      Steps: {
        async findByUserIdAndDate() { return null; },
        async findByUserIdAndDateRange() { return []; },
      },
      RaceParticipant: {
        async findById(id) {
          return {
            id,
            powerupSlots: 3,
            nextBoxAtSteps: overrides.freshNextBoxAtSteps,
            bonusSteps: overrides.freshBonusSteps || 0,
            maxBonusSteps: overrides.freshMaxBonusSteps || 0,
          };
        },
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
        async findHeldByParticipant() { return slotPowerups.filter((p) => p.status === "HELD"); },
        async findMysteryBoxesByParticipant() { return slotPowerups.filter((p) => p.status === "MYSTERY_BOX"); },
        async countMysteryBoxesByParticipant() { return slotPowerups.filter((p) => p.status === "MYSTERY_BOX").length; },
        async findSlotPowerups() { return slotPowerups; },
        async countOccupiedSlots() { return slotPowerups.length; },
        async countQueuedByParticipant() { return 0; },
        async findQueuedByParticipant() { return []; },
        async update() {},
      },
      expireEffects: async () => {},
      completeRace: async () => {},
      rollPowerup: async () => [],
      now: () => NOW,
    },
  };
}

test("stepsUntilNextPowerup is clamped to the interval when nextBoxAtSteps is far above effective steps", async () => {
  // Real steps ~1500, but nextBoxAtSteps drifted to 14000 from a transient spike.
  // Raw countdown would be 14000 - 1500 = 12500; clamp must cap it at the 2000 interval.
  const { deps } = makeDeps({
    powerupStepInterval: 2000,
    participant: { nextBoxAtSteps: 14000 },
    freshNextBoxAtSteps: 14000,
  });

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  assert.equal(result.powerupData.powerupStepInterval, 2000);
  assert.ok(
    result.powerupData.stepsUntilNextPowerup <= 2000,
    `expected countdown <= interval (2000) but got ${result.powerupData.stepsUntilNextPowerup}`
  );
  assert.equal(result.powerupData.stepsUntilNextPowerup, 2000);
});

test("normal in-interval countdown is unaffected by the clamp", async () => {
  // nextBoxAtSteps 2000, real steps ~1500 → countdown 500, well under the interval.
  const { deps } = makeDeps({
    powerupStepInterval: 2000,
    participant: { nextBoxAtSteps: 2000 },
    freshNextBoxAtSteps: 2000,
  });

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  assert.equal(result.powerupData.stepsUntilNextPowerup, 500);
});
