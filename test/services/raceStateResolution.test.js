const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildResolveRaceState,
  determineFinishSnapshot,
} = require("../../src/modules/races/services/raceStateResolution");

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
    targetSteps: overrides.targetSteps ?? 10000,
    timeBased: overrides.timeBased ?? false,
    startedAt: overrides.startedAt || RACE_START,
    endsAt:
      overrides.endsAt !== undefined
        ? overrides.endsAt
        : new Date("2026-04-13T12:00:00Z"),
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
      // Mechanical (2026-08-09): production writes participant totals through
      // updateStepTotals({ totalSteps, rawSteps }); delegate so this fake keeps
      // recording exactly what it recorded before.
      async updateStepTotals(id, fields = {}) { return this.updateTotalSteps(id, fields.totalSteps); },
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

test("resolveRaceState never finishes or completes a targetSteps=0 (time-based) race", async () => {
  const alice = makeParticipant("rp-1", "user-1", "Alice");
  const bob = makeParticipant("rp-2", "user-2", "Bob");
  const carol = makeParticipant("rp-3", "user-3", "Carol");

  // Huge step totals: under the old `0 >= 0` logic this would finish everyone
  // and complete the race instantly. With the guard it must do neither.
  const ctx = makeContext({
    participants: [alice, bob, carol],
    targetSteps: 0,
    samplesByUser: new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-04-07T10:00:00Z",
            periodEnd: "2026-04-07T11:00:00Z",
            steps: 50000,
          },
        ],
      ],
    ]),
  });

  const resolveRaceState = buildResolveRaceState(ctx.deps);
  await resolveRaceState({ raceId: "race-1" });

  // Totals are still tracked (a large positive total)...
  const aliceUpdate = ctx.participantUpdates.find((u) => u.id === "rp-1");
  assert.ok(aliceUpdate && aliceUpdate.totalSteps > 0);
  // ...but no one is marked finished, no placements set, race not completed.
  assert.equal(ctx.finishCalls.length, 0);
  assert.equal(ctx.placementCalls.length, 0);
  assert.equal(ctx.completeCalls.length, 0);
});

test("resolveRaceState with targetSteps=0 does not finish even when total is zero", async () => {
  // The exact prod incident shape: brand-new race, everyone at 0 steps.
  const alice = makeParticipant("rp-1", "user-1", "Alice");
  const bob = makeParticipant("rp-2", "user-2", "Bob");

  const ctx = makeContext({
    participants: [alice, bob],
    targetSteps: 0,
    samplesByUser: new Map(),
  });

  const resolveRaceState = buildResolveRaceState(ctx.deps);
  await resolveRaceState({ raceId: "race-1" });

  assert.equal(ctx.finishCalls.length, 0);
  assert.equal(ctx.placementCalls.length, 0);
  assert.equal(ctx.completeCalls.length, 0);
});

test("resolveRaceState short-circuits a past-endsAt race (awaiting raceExpiry settlement)", async () => {
  // T9 defense-in-depth: once now >= endsAt the race is in the gap before the
  // raceExpiry cron settles it. resolveRaceState must NOT keep live-resolving it
  // (marking finishers, minting boxes, completing) — settlement owns that.
  const alice = makeParticipant("rp-1", "user-1", "Alice");
  const bob = makeParticipant("rp-2", "user-2", "Bob");
  const carol = makeParticipant("rp-3", "user-3", "Carol");

  const ctx = makeContext({
    participants: [alice, bob, carol],
    targetSteps: 10000,
    endsAt: new Date("2026-04-07T11:00:00Z"), // ended before NOW (12:00)
    samplesByUser: new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-04-07T10:00:00Z",
            periodEnd: "2026-04-07T11:00:00Z",
            steps: 12000, // would have finished the target if still resolving
          },
        ],
      ],
    ]),
  });

  const resolveRaceState = buildResolveRaceState(ctx.deps);
  const result = await resolveRaceState({ raceId: "race-1" });

  assert.deepEqual(result, []);
  assert.equal(ctx.participantUpdates.length, 0);
  assert.equal(ctx.finishCalls.length, 0);
  assert.equal(ctx.placementCalls.length, 0);
  assert.equal(ctx.completeCalls.length, 0);
});

test("resolveRaceState still resolves an open-ended (endsAt null) race normally", async () => {
  // Open-ended target races have no endsAt and must be unaffected by the T9 gate.
  const alice = makeParticipant("rp-1", "user-1", "Alice");
  const bob = makeParticipant("rp-2", "user-2", "Bob");
  const carol = makeParticipant("rp-3", "user-3", "Carol");

  const ctx = makeContext({
    participants: [alice, bob, carol],
    targetSteps: 10000,
    endsAt: null,
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
  const result = await resolveRaceState({ raceId: "race-1" });

  // TR-902 rebase: nothing target-finishes any more, so "resolution ran" is
  // observed through the participant totals it wrote (the exact inverse of the
  // past-endsAt short-circuit test above, which asserts zero updates). The
  // subject — the T9 endsAt gate must not skip an endsAt:null race — is
  // unchanged and still live.
  assert.equal(result.length, 1);
  assert.equal(result[0].raceId, "race-1");
  assert.ok(ctx.participantUpdates.length > 0, "resolution ran and wrote totals");
});

test("canonical resolver exposes a bounded pre-mine display capture without changing writes", async () => {
  const alice = makeParticipant("rp-1", "user-1", "Alice");
  const ctx = makeContext({
    participants: [alice],
    samplesByUser: new Map([["user-1", [{
      periodStart: "2026-04-07T10:00:00Z",
      periodEnd: "2026-04-07T11:00:00Z",
      steps: 1200,
    }]]]),
  });
  const result = (await buildResolveRaceState(ctx.deps)({ raceId: "race-1" }))[0];
  assert.deepEqual(result.displayCapture.stepTotals, [{
    participantId: "rp-1",
    userId: "user-1",
    totalSteps: 1200,
  }]);
  assert.deepEqual(result.displayCapture.currentMultiplierByParticipantId, { "rp-1": 1 });
  assert.deepEqual(result.displayCapture.activeEffects, []);
  assert.deepEqual(result.displayCapture.globalEvents, []);
  assert.equal(result.displayCapture.asOf.toISOString(), NOW.toISOString());
  assert.equal(ctx.participantUpdates.length, 1, "existing canonical write surface is unchanged");
});

test("resolveRaceState ignores same-day steps row delta when no post-start samples exist", async () => {
  const raceStart = new Date("2026-04-07T10:00:00Z");
  const alice = makeParticipant("rp-1", "user-1", "Alice", {
    baselineSteps: 1200,
    joinedAt: raceStart,
  });
  const bob = makeParticipant("rp-2", "user-2", "Bob", {
    joinedAt: raceStart,
  });

  const ctx = makeContext({
    participants: [alice, bob],
    startedAt: raceStart,
    now: new Date("2026-04-07T10:30:00Z"),
    stepsByUserAndDate: new Map([
      ["user-1:2026-04-07", { steps: 1800 }],
    ]),
    samplesByUser: new Map(),
  });

  const resolveRaceState = buildResolveRaceState(ctx.deps);
  await resolveRaceState({ raceId: "race-1", timeZone: "UTC" });

  assert.deepEqual(ctx.participantUpdates, [
    { id: "rp-1", totalSteps: 0 },
    { id: "rp-2", totalSteps: 0 },
  ]);
  assert.equal(ctx.finishCalls.length, 0);
});

test("resolveRaceState never finishes a timeBased race even past a positive targetSteps", async () => {
  // Seeded Weekly 50K shape: timeBased=true keeps 50000 as a DISPLAY goal.
  // A participant blowing past it (60000) must NOT finish; the winner is
  // decided only when ends_at passes (raceExpiry.js), not here.
  const alice = makeParticipant("rp-1", "user-1", "Alice");
  const bob = makeParticipant("rp-2", "user-2", "Bob");
  const carol = makeParticipant("rp-3", "user-3", "Carol");

  const ctx = makeContext({
    participants: [alice, bob, carol],
    timeBased: true,
    targetSteps: 50000,
    samplesByUser: new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-04-07T10:00:00Z",
            periodEnd: "2026-04-07T11:00:00Z",
            steps: 60000,
          },
        ],
      ],
    ]),
  });

  const resolveRaceState = buildResolveRaceState(ctx.deps);
  await resolveRaceState({ raceId: "race-1" });

  // Steps are still tracked...
  const aliceUpdate = ctx.participantUpdates.find((u) => u.id === "rp-1");
  assert.ok(aliceUpdate && aliceUpdate.totalSteps >= 50000);
  // ...but no finish, no placement, race not completed.
  assert.equal(ctx.finishCalls.length, 0);
  assert.equal(ctx.placementCalls.length, 0);
  assert.equal(ctx.completeCalls.length, 0);
});

// ── determineFinishSnapshot (TR-902 rebase) ────────────────────────────────
// These two were previously asserted THROUGH resolveRaceState's target-finish
// trigger. That trigger is gone (races are time-based), but the function is
// NOT: raceExpiry.js calls it to compute each participant's `reachedAt`, the
// tie-break for settling a tied race. The scaffolding changed; the math being
// asserted is identical, so the coverage is preserved by calling it directly.
function snapshotDeps({ samples = [], events = [] } = {}) {
  return {
    stepSampleModel: {
      async findByUserIdAndTimeRange() {
        return samples;
      },
    },
    powerupEventModel: {
      async findByRaceAsc() {
        return events;
      },
    },
  };
}

test("determineFinishSnapshot interpolates the crossing time from step samples", async () => {
  // 12,000 steps walked evenly over 10:00-11:00 crosses a 10,000 target at
  // 10:50 — the same assertion the old trigger test made via resolveRaceState.
  const participant = makeParticipant("rp-1", "user-1", "Alice");
  const snapshot = await determineFinishSnapshot({
    participant,
    currentTotal: 12000,
    targetSteps: 10000,
    effectiveStart: new Date("2026-04-07T10:00:00Z"),
    effectGroups: { legCramps: [], runnersHighs: [], wrongTurns: [], campfires: [], rainstorms: [] },
    ...snapshotDeps({
      samples: [
        {
          periodStart: "2026-04-07T10:00:00Z",
          periodEnd: "2026-04-07T11:00:00Z",
          steps: 12000,
        },
      ],
    }),
    raceId: "race-1",
    now: new Date("2026-04-07T11:00:00Z"),
  });

  assert.equal(snapshot.finishTotalSteps, 10000);
  assert.equal(snapshot.finishedAt.toISOString(), "2026-04-07T10:50:00.000Z");
});

test("determineFinishSnapshot uses a powerup bonus event's time for an instant crossing", async () => {
  // 9,500 walked steps + a 1,000-step Protein Shake at 11:15 crosses 10,000 AT
  // the bonus instant, not by walking. This is the ONLY coverage of
  // buildBonusTimeline (race-buyins' tie-break test uses no powerups).
  const participant = makeParticipant("rp-1", "user-1", "Alice", { bonusSteps: 1000 });
  const powerupTime = new Date("2026-04-07T11:15:00Z");
  const snapshot = await determineFinishSnapshot({
    participant,
    currentTotal: 10500,
    targetSteps: 10000,
    effectiveStart: new Date("2026-04-07T10:00:00Z"),
    effectGroups: { legCramps: [], runnersHighs: [], wrongTurns: [], campfires: [], rainstorms: [] },
    ...snapshotDeps({
      samples: [
        {
          periodStart: "2026-04-07T10:00:00Z",
          periodEnd: "2026-04-07T11:00:00Z",
          steps: 9500,
        },
      ],
      events: [
        {
          raceId: "race-1",
          actorUserId: "user-1",
          targetUserId: null,
          powerupType: "PROTEIN_SHAKE",
          metadata: { bonus: 1000 },
          createdAt: powerupTime,
        },
      ],
    }),
    raceId: "race-1",
    now: new Date("2026-04-07T11:20:00Z"),
  });

  assert.equal(snapshot.finishedAt.toISOString(), powerupTime.toISOString());
});
