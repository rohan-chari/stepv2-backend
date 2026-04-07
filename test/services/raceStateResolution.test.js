const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildResolveRaceState,
} = require("../../src/services/raceStateResolution");

const RACE_START = new Date("2026-04-06T12:00:00Z");
const NOW = new Date("2026-04-07T12:00:00Z");

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 0,
    bonusSteps: 0,
    baselineSteps: 0,
    joinedAt: RACE_START,
    powerupSlots: 3,
    nextBoxAtSteps: 0,
    placement: null,
    finishedAt: null,
    finishTotalSteps: null,
    user: { id: userId, displayName },
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  const participantUpdates = [];
  const finishCalls = [];
  const placementCalls = [];
  const completeCalls = [];

  const participants = overrides.participants || [];
  const race = {
    id: "race-1",
    name: "Test Race",
    status: "ACTIVE",
    targetSteps: overrides.targetSteps || 10000,
    startedAt: overrides.startedAt || RACE_START,
    endsAt: new Date("2026-04-13T12:00:00Z"),
    powerupsEnabled: overrides.powerupsEnabled || false,
    powerupStepInterval: null,
    participants,
  };

  const stepsByUserAndDate = overrides.stepsByUserAndDate || new Map();
  const samplesByUser = overrides.samplesByUser || new Map();
  const effectsByParticipantAndType = overrides.effectsByParticipantAndType || new Map();
  const powerupEventsByRace = overrides.powerupEventsByRace || [];

  const deps = {
    Race: {
      async findById(id) {
        assert.equal(id, race.id);
        return {
          ...race,
          participants: participants.map((p) => ({ ...p })),
        };
      },
    },
    RaceParticipant: {
      async updateTotalSteps(id, totalSteps) {
        participantUpdates.push({ id, totalSteps });
      },
      async markFinished(id, finishedAt, finishTotalSteps) {
        finishCalls.push({ id, finishedAt, finishTotalSteps });
      },
      async setPlacement(id, placement) {
        placementCalls.push({ id, placement });
      },
    },
    Steps: {
      async findByUserIdAndDate(userId, date) {
        return stepsByUserAndDate.get(`${userId}:${date}`) || null;
      },
      async findByUserIdAndDateRange() {
        return [];
      },
    },
    StepSample: {
      async sumStepsInWindow(userId, start, end) {
        const samples = samplesByUser.get(userId) || [];
        let total = 0;
        for (const sample of samples) {
          const sampleStart = new Date(sample.periodStart).getTime();
          const sampleEnd = new Date(sample.periodEnd).getTime();
          const sampleDuration = sampleEnd - sampleStart;
          if (sampleDuration <= 0) continue;

          const overlapStart = Math.max(sampleStart, new Date(start).getTime());
          const overlapEnd = Math.min(sampleEnd, new Date(end).getTime());
          const overlapDuration = overlapEnd - overlapStart;
          if (overlapDuration <= 0) continue;

          total += Math.round(sample.steps * (overlapDuration / sampleDuration));
        }
        return total;
      },
      async findByUserIdAndTimeRange(userId, start, end) {
        const startMs = new Date(start).getTime();
        const endMs = new Date(end).getTime();
        return (samplesByUser.get(userId) || []).filter((sample) => {
          const sampleStart = new Date(sample.periodStart).getTime();
          const sampleEnd = new Date(sample.periodEnd).getTime();
          return sampleEnd > startMs && sampleStart < endMs;
        });
      },
    },
    RaceActiveEffect: {
      async findEffectsForRaceByType(raceId, participantId, type) {
        assert.equal(raceId, race.id);
        return effectsByParticipantAndType.get(`${participantId}:${type}`) || [];
      },
    },
    RacePowerupEvent: {
      async findByRaceAsc(raceId) {
        assert.equal(raceId, race.id);
        return powerupEventsByRace;
      },
    },
    completeRace: async (payload) => {
      completeCalls.push(payload);
    },
    now: () => overrides.now || NOW,
  };

  return {
    participantUpdates,
    finishCalls,
    placementCalls,
    completeCalls,
    deps,
  };
}

test("resolveRaceState marks finish from step samples before progress is read", async () => {
  const alice = makeParticipant("rp-1", "user-1", "Alice");
  const bob = makeParticipant("rp-2", "user-2", "Bob");
  const carol = makeParticipant("rp-3", "user-3", "Carol");

  const ctx = makeContext({
    participants: [alice, bob, carol],
    samplesByUser: new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-04-07T10:00:00Z",
            periodEnd: "2026-04-07T11:00:00Z",
            steps: 12000,
          },
        ],
      ],
    ]),
  });

  const resolveRaceState = buildResolveRaceState(ctx.deps);
  await resolveRaceState({ raceId: "race-1" });

  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.finishCalls[0].id, "rp-1");
  assert.equal(ctx.finishCalls[0].finishTotalSteps, 10000);
  assert.equal(
    ctx.finishCalls[0].finishedAt.toISOString(),
    "2026-04-07T10:50:00.000Z"
  );
  assert.deepEqual(ctx.placementCalls, [{ id: "rp-1", placement: 1 }]);
  assert.equal(ctx.completeCalls.length, 1);
  assert.equal(ctx.completeCalls[0].winnerUserId, "user-1");
});

test("resolveRaceState freezes finished participant totals on later syncs", async () => {
  const alice = makeParticipant("rp-1", "user-1", "Alice", {
    totalSteps: 10000,
    finishedAt: new Date("2026-04-07T10:50:00Z"),
    finishTotalSteps: 10000,
    placement: 1,
  });
  const bob = makeParticipant("rp-2", "user-2", "Bob");
  const carol = makeParticipant("rp-3", "user-3", "Carol");

  const ctx = makeContext({
    participants: [alice, bob, carol],
    samplesByUser: new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-04-07T10:00:00Z",
            periodEnd: "2026-04-07T12:00:00Z",
            steps: 15000,
          },
        ],
      ],
    ]),
  });

  const resolveRaceState = buildResolveRaceState(ctx.deps);
  await resolveRaceState({ raceId: "race-1" });

  assert.equal(ctx.finishCalls.length, 0);
  assert.equal(ctx.participantUpdates.some((u) => u.id === "rp-1"), false);
});

test("resolveRaceState uses powerup bonus event time for instant finish", async () => {
  const alice = makeParticipant("rp-1", "user-1", "Alice", {
    bonusSteps: 1000,
  });
  const bob = makeParticipant("rp-2", "user-2", "Bob");
  const carol = makeParticipant("rp-3", "user-3", "Carol");

  const powerupTime = new Date("2026-04-07T11:15:00Z");
  const ctx = makeContext({
    participants: [alice, bob, carol],
    now: new Date("2026-04-07T11:20:00Z"),
    powerupsEnabled: true,
    powerupEventsByRace: [
      {
        raceId: "race-1",
        actorUserId: "user-1",
        targetUserId: null,
        powerupType: "PROTEIN_SHAKE",
        metadata: { bonus: 1000 },
        createdAt: powerupTime,
      },
    ],
    samplesByUser: new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-04-07T10:00:00Z",
            periodEnd: "2026-04-07T11:00:00Z",
            steps: 9500,
          },
        ],
      ],
    ]),
  });

  const resolveRaceState = buildResolveRaceState(ctx.deps);
  await resolveRaceState({ raceId: "race-1" });

  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.finishCalls[0].id, "rp-1");
  assert.equal(ctx.finishCalls[0].finishTotalSteps, 10500);
  assert.equal(ctx.finishCalls[0].finishedAt.toISOString(), powerupTime.toISOString());
});
