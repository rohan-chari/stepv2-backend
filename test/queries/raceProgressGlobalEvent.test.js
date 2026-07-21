const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/modules/races/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// getRaceProgress: additive `globalEvent` field + the global-event step boost.
//
//   - when a GlobalStepEvent is ACTIVE, the response includes a top-level
//     `globalEvent` object { active: true, multiplier, endsAt } AND every
//     participant's in-window steps are boosted by the event multiplier.
//   - when no event is active, `globalEvent` is absent/null and totals are raw.
//
// New app reads `globalEvent` to show a banner; old apps ignore the field.
//
// Written from the spec + raceProgressImposterSwap mock pattern, NOT by
// mirroring implementation.
// ---------------------------------------------------------------------------

const RACE_START = new Date("2026-06-02T12:00:00.000Z");
const NOW = new Date("2026-06-02T13:00:00.000Z");
const TZ = "UTC";

function makeParticipant(id, userId, steps) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    joinedAt: RACE_START,
    baselineSteps: 0,
    finishedAt: null,
    bonusSteps: 0,
    nextBoxAtSteps: 0,
    powerupSlots: 3,
    totalSteps: steps,
    _steps: steps,
    user: { displayName: userId, profilePhotoUrl: null },
  };
}

function makeDeps({ globalEvents = [], participants } = {}) {
  const ps = participants || [
    makeParticipant("rp-1", "user-1", 6000),
    makeParticipant("rp-2", "user-2", 4000),
  ];
  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 100000,
    startedAt: RACE_START,
    endsAt: new Date("2026-06-08T12:00:00.000Z"),
    powerupsEnabled: false,
    powerupStepInterval: null,
    participants: ps,
  };

  // Each user's steps fall ENTIRELY inside the race-start day window 12:00-13:00.
  const samplesByUser = new Map(
    ps.map((p) => [
      p.userId,
      [
        {
          periodStart: "2026-06-02T12:00:00.000Z",
          periodEnd: "2026-06-02T13:00:00.000Z",
          steps: p._steps,
        },
      ],
    ])
  );

  const updates = [];

  return {
    updates,
    deps: {
      Race: { async findById() { return race; } },
      StepSample: {
        async sumStepsInWindow(userId, start, end) {
          const samples = samplesByUser.get(userId) || [];
          let total = 0;
          for (const s of samples) {
            const ss = new Date(s.periodStart).getTime();
            const se = new Date(s.periodEnd).getTime();
            const dur = se - ss;
            if (dur <= 0) continue;
            const os = Math.max(ss, new Date(start).getTime());
            const oe = Math.min(se, new Date(end).getTime());
            const od = oe - os;
            if (od <= 0) continue;
            total += Math.round(s.steps * (od / dur));
          }
          return total;
        },
        async findByUserIdAndTimeRange() { return []; },
      },
      Steps: {
        async findByUserIdAndDate() { return null; },
        async findByUserIdAndDateRange() { return []; },
      },
      RaceParticipant: {
        async findById(id) { return { id, powerupSlots: 3, nextBoxAtSteps: 0 }; },
        async updateTotalSteps(id, totalSteps) { updates.push({ id, totalSteps }); },
        async markFinished() {},
        async setPlacement() {},
      },
      RaceActiveEffect: {
        async findEffectsForRaceByType() { return []; },
        async findActiveForParticipant() { return []; },
        async findActiveForRace() { return []; },
      },
      RacePowerup: {
        async findSlotPowerups() { return []; },
        async countQueuedByParticipant() { return 0; },
      },
      GlobalStepEvent: {
        async findActiveInRange() { return globalEvents; },
      },
      expireEffects: async () => {},
      completeRace: async () => {},
      rollPowerup: async () => [],
      syncRacePowerupState: async () => ({
        enabled: true,
        newMysteryBoxes: [],
        newQueuedBoxes: 0,
        queuedBoxCount: 0,
      }),
      now: () => NOW,
    },
  };
}

test("omits globalEvent when no event is active and totals are raw", async () => {
  const { deps, updates } = makeDeps({ globalEvents: [] });
  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  assert.ok(
    result.globalEvent === undefined || result.globalEvent === null,
    "no globalEvent field when none active"
  );

  // Raw totals (no boost): user-1 = 6000, user-2 = 4000.
  const u1 = result.participants.find((p) => p.userId === "user-1");
  const u2 = result.participants.find((p) => p.userId === "user-2");
  assert.equal(u1.totalSteps, 6000);
  assert.equal(u2.totalSteps, 4000);

  const u1Update = updates.find((u) => u.id === "rp-1");
  assert.equal(u1Update.totalSteps, 6000);
});

test("includes additive globalEvent and boosts in-window steps when active", async () => {
  // Event spans now (13:00): 12:00 -> 13:30, so it is still ACTIVE at now and
  // the 12:00-13:00 step sample is fully inside the window (full doubling).
  const endsAt = new Date("2026-06-02T13:30:00.000Z");
  const { deps } = makeDeps({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00.000Z"),
        endsAt,
        multiplier: 2,
      },
    ],
  });
  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  assert.ok(result.globalEvent, "globalEvent present when active");
  assert.equal(result.globalEvent.active, true);
  assert.equal(result.globalEvent.multiplier, 2);
  assert.equal(
    new Date(result.globalEvent.endsAt).getTime(),
    endsAt.getTime()
  );

  // All steps were inside the 2x window => totals double.
  const u1 = result.participants.find((p) => p.userId === "user-1");
  const u2 = result.participants.find((p) => p.userId === "user-2");
  assert.equal(u1.totalSteps, 12000, "6000 * 2");
  assert.equal(u2.totalSteps, 8000, "4000 * 2");
});

test("only the in-window fraction is boosted (event covers half the steps)", async () => {
  // Event covers 12:00-12:30, the sample spans 12:00-13:00 (6000 steps).
  // In-window = 3000 steps => boost 3000 => total 6000 + 3000 = 9000.
  const { deps } = makeDeps({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00.000Z"),
        endsAt: new Date("2026-06-02T12:30:00.000Z"),
        multiplier: 2,
      },
    ],
  });
  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  const u1 = result.participants.find((p) => p.userId === "user-1");
  assert.equal(u1.totalSteps, 9000, "6000 base + 3000 in-window boost");
});
