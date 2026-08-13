const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PREFETCH_EFFECT_TYPES,
  prefetchRaceScoringModels,
} = require("../../src/modules/races/services/raceScoringPrefetch");

test("race scoring prefetch collapses participant reads into three bulk reads", async () => {
  const calls = { samples: 0, daily: 0, effects: 0 };
  const start = new Date("2026-08-10T00:00:00Z");
  const now = new Date("2026-08-10T12:00:00Z");
  const effect = {
    id: "effect-1",
    raceId: "race-1",
    targetParticipantId: "participant-1",
    targetUserId: "user-1",
    type: "HITCHHIKE",
    status: "ACTIVE",
    createdAt: start,
  };
  const scoped = await prefetchRaceScoringModels({
    races: [
      {
        id: "race-1",
        startedAt: start,
        powerupsEnabled: true,
        participants: [
          { id: "participant-1", userId: "user-1" },
          { id: "participant-2", userId: "user-2" },
        ],
      },
    ],
    now,
    stepSampleModel: {
      async findRowsForUsersInRange(userIds) {
        calls.samples += 1;
        assert.deepEqual(userIds.sort(), ["user-1", "user-2"]);
        return [
          {
            userId: "user-1",
            start: new Date("2026-08-10T01:00:00Z"),
            end: new Date("2026-08-10T02:00:00Z"),
            steps: 600,
          },
        ];
      },
      async sumStepsInWindows() {
        assert.fail("covered sample windows must not fall through");
      },
      async sumClosedStepsInWindows() {
        assert.fail("covered closed windows must not fall through");
      },
      async hasAnyInWindow() {
        assert.fail("covered existence checks must not fall through");
      },
    },
    stepsModel: {
      async findByUserIdsAndDateRange() {
        calls.daily += 1;
        return [
          { userId: "user-1", date: start, steps: 900 },
        ];
      },
      async findByUserIdAndDate() {
        assert.fail("covered daily reads must not fall through");
      },
      async findByUserIdAndDateRange() {
        assert.fail("covered daily ranges must not fall through");
      },
    },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes(
        raceIds,
        participantIds,
        types
      ) {
        calls.effects += 1;
        assert.deepEqual(raceIds, ["race-1"]);
        assert.deepEqual(participantIds, ["participant-1", "participant-2"]);
        assert.deepEqual(types, PREFETCH_EFFECT_TYPES);
        return { "participant-1": { HITCHHIKE: [effect] } };
      },
      async findEffectsForRaceByTypes() {
        assert.fail("covered effect reads must not fall through");
      },
      async findRaceEffectsByType() {
        assert.fail("covered race effect reads must not fall through");
      },
    },
  });

  assert.deepEqual(calls, { samples: 1, daily: 1, effects: 1 });
  assert.equal(
    await scoped.stepSampleModel.sumStepsInWindow(
      "user-1",
      new Date("2026-08-10T01:00:00Z"),
      new Date("2026-08-10T02:00:00Z")
    ),
    600
  );
  assert.equal(
    await scoped.stepSampleModel.hasAnyInWindow(
      "user-1",
      start,
      now
    ),
    true
  );
  assert.equal(
    (
      await scoped.stepsModel.findByUserIdAndDate("user-1", "2026-08-10")
    ).steps,
    900
  );
  assert.deepEqual(
    await scoped.raceActiveEffectModel.findRaceEffectsByType(
      "race-1",
      "HITCHHIKE"
    ),
    [effect]
  );
});

test("race scoring prefetch preserves closed-bucket semantics", async () => {
  const start = new Date("2026-08-10T00:00:00Z");
  const scoped = await prefetchRaceScoringModels({
    races: [
      {
        id: "race-1",
        startedAt: start,
        powerupsEnabled: true,
        participants: [{ id: "participant-1", userId: "user-1" }],
      },
    ],
    now: new Date("2026-08-10T03:00:00Z"),
    stepSampleModel: {
      async findRowsForUsersInRange() {
        return [
          {
            userId: "user-1",
            start: new Date("2026-08-10T01:00:00Z"),
            end: new Date("2026-08-10T02:00:00Z"),
            steps: 600,
          },
          {
            userId: "user-1",
            start: new Date("2026-08-10T02:00:00Z"),
            end: new Date("2026-08-10T03:00:00Z"),
            steps: 900,
          },
        ];
      },
    },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    raceActiveEffectModel: {
      async findEffectsForRaceParticipantsByTypes() { return {}; },
    },
  });

  const total = await scoped.stepSampleModel.sumClosedStepsInWindow(
    "user-1",
    start,
    new Date("2026-08-10T03:00:00Z"),
    new Date("2026-08-10T02:30:00Z")
  );
  assert.equal(total, 600, "the still-open second bucket stays excluded");
});
