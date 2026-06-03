const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// End-to-end: the "steps to next powerup" countdown must IGNORE Leg Cramp
// (freeze) and Wrong Turn (reverse). Those debuffs subtract from totalSteps, but
// getRaceProgress re-credits exactly what they shaved off (boxDebuffOffsetSteps)
// before computing stepsUntilNextPowerup — so a fresh freeze/reverse never makes
// the countdown jump backward. It also persists that offset so the roll gate
// matches.

// Same-day race so there are no "subsequent days" — baseAdjusted == the start-day
// sample sum, which keeps the arithmetic easy to assert.
const RACE_START = new Date("2026-06-03T13:00:00.000Z");
const NOW = new Date("2026-06-03T20:00:00.000Z");
const TZ = "UTC";
const START_DAY_END = new Date("2026-06-04T00:00:00.000Z");

const CRAMP_START = new Date("2026-06-03T15:00:00.000Z");
const CRAMP_END = new Date("2026-06-03T16:00:00.000Z");
const WT_START = new Date("2026-06-03T17:00:00.000Z");
const WT_END = new Date("2026-06-03T18:00:00.000Z");

function buildDeps({ effectsByType, sampleByWindowStart, nextBoxAtSteps }) {
  const participant = {
    id: "rp-1",
    userId: "user-1",
    status: "ACCEPTED",
    joinedAt: RACE_START,
    baselineSteps: 0,
    totalSteps: 0,
    bonusSteps: 0,
    maxBonusSteps: 0,
    nextBoxAtSteps,
    boxDebuffOffsetSteps: 0,
    powerupSlots: 3,
    finishedAt: null,
    finishTotalSteps: null,
    user: { displayName: "user-1" },
  };

  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 1000000,
    startedAt: RACE_START,
    endsAt: new Date("2026-06-10T13:00:00.000Z"),
    powerupsEnabled: true,
    powerupStepInterval: 2000,
    participants: [participant],
  };

  const persisted = { totalSteps: null, boxDebuffOffsetSteps: null };

  const deps = {
    Race: { async findById() { return race; } },
    StepSample: {
      async sumStepsInWindow(_userId, windowStart) {
        return sampleByWindowStart[new Date(windowStart).getTime()] || 0;
      },
    },
    Steps: {
      async findByUserIdAndDate() { return null; },
      async findByUserIdAndDateRange() { return []; },
    },
    RaceParticipant: {
      async findById() {
        return {
          id: "rp-1",
          powerupSlots: 3,
          nextBoxAtSteps,
          bonusSteps: 0,
          maxBonusSteps: 0,
        };
      },
      async updateTotalSteps(_id, totalSteps) { persisted.totalSteps = totalSteps; },
      async updateBoxDebuffOffsetSteps(_id, v) { persisted.boxDebuffOffsetSteps = v; },
      async markFinished() {},
      async setPlacement() {},
    },
    RaceActiveEffect: {
      async findEffectsForRaceByType(_raceId, _pid, type) {
        return effectsByType[type] || [];
      },
      async findActiveForParticipant() { return []; },
      async findActiveForRace() {
        return Object.values(effectsByType).flat();
      },
    },
    RacePowerup: {
      async findSlotPowerups() { return []; },
      async countQueuedByParticipant() { return 0; },
      async findHeldByParticipant() { return []; },
      async findMysteryBoxesByParticipant() { return []; },
      async countMysteryBoxesByParticipant() { return 0; },
      async countOccupiedSlots() { return 0; },
      async findQueuedByParticipant() { return []; },
    },
    GlobalStepEvent: { async findActiveInRange() { return []; } },
    expireEffects: async () => {},
    completeRace: async () => {},
    rollPowerup: async () => [],
    // Use the REAL sync wiring through the same deps so the gate sees the
    // persisted offset; but to keep this test about the display number, stub it.
    syncRacePowerupState: async () => ({
      enabled: true,
      newMysteryBoxes: [],
      newQueuedBoxes: 0,
      queuedBoxCount: 0,
    }),
    now: () => NOW,
  };

  return { deps, persisted };
}

test("countdown ignores a Leg Cramp freeze (no backward jump)", async () => {
  // baseAdjusted = 10000 (start-day samples). Leg Cramp froze 2000 -> net total
  // 8000. Next box at 12000. With the offset re-credit, effective = 10000, so the
  // countdown is 2000 — NOT 4000 (which is what a debuff-sensitive countdown
  // would show).
  const { deps, persisted } = buildDeps({
    nextBoxAtSteps: 12000,
    effectsByType: {
      LEG_CRAMP: [
        { type: "LEG_CRAMP", startsAt: CRAMP_START, expiresAt: CRAMP_END, status: "ACTIVE", metadata: {} },
      ],
    },
    sampleByWindowStart: {
      [RACE_START.getTime()]: 10000, // start-day base
      [CRAMP_START.getTime()]: 2000, // frozen
    },
  });

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  assert.equal(persisted.totalSteps, 8000, "stored total still reflects the freeze");
  assert.equal(persisted.boxDebuffOffsetSteps, 2000, "offset re-credits the frozen steps");
  assert.equal(
    result.powerupData.stepsUntilNextPowerup,
    2000,
    "countdown ignores the Leg Cramp (would be 4000 if debuff-sensitive)"
  );
});

test("countdown ignores Leg Cramp + Wrong Turn together", async () => {
  // base 10000; Leg Cramp froze 1000; Wrong Turn reversed 500 (swings total by
  // 2*500=1000). Net total = 10000 - 1000 - 1000 = 8000. Offset = 1000 + 2*500 =
  // 2000 -> effective 10000. Next box 12000 -> countdown 2000.
  const { deps, persisted } = buildDeps({
    nextBoxAtSteps: 12000,
    effectsByType: {
      LEG_CRAMP: [
        { type: "LEG_CRAMP", startsAt: CRAMP_START, expiresAt: CRAMP_END, status: "ACTIVE", metadata: {} },
      ],
      WRONG_TURN: [
        { type: "WRONG_TURN", startsAt: WT_START, expiresAt: WT_END, status: "ACTIVE", metadata: {} },
      ],
    },
    sampleByWindowStart: {
      [RACE_START.getTime()]: 10000,
      [CRAMP_START.getTime()]: 1000,
      [WT_START.getTime()]: 500,
    },
  });

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  assert.equal(persisted.totalSteps, 8000);
  assert.equal(persisted.boxDebuffOffsetSteps, 2000);
  assert.equal(result.powerupData.stepsUntilNextPowerup, 2000);
});
