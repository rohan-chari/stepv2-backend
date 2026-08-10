const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/modules/races/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// IMPOSTER display swap in the getRaceProgress leaderboard build.
//
// For an ACTIVE, non-expired IMPOSTER effect owned by user A (targetUserId === A)
// with metadata.swapWithUserId === B, the two participants swap their DISPLAYED
// rank/position in the leaderboard array. Each keeps their OWN name + real
// steps but appears at the other's rank slot. Visible to ALL viewers.
//
//   - active IMPOSTER swaps the two users' positions for everyone
//   - an EXPIRED imposter does NOT swap
//   - graceful edge handling: target left the race => no swap, no throw
//
// Written from the spec + the raceProgressHiddenEffects mock pattern, NOT by
// mirroring implementation.
// ---------------------------------------------------------------------------

const RACE_START = new Date("2026-03-30T13:00:00.000Z");
const NOW = new Date("2026-03-31T15:00:00.000Z");
const TZ = "America/New_York";
const FUTURE = new Date("2026-03-31T18:00:00.000Z"); // active
const PAST = new Date("2026-03-31T10:00:00.000Z"); // already expired

// Three racers with DISTINCT real steps so natural order is unambiguous:
//   user-1 = 30000 (1st), user-2 = 20000 (2nd), user-3 = 10000 (3rd)
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

function makeDeps(activeEffects, { participants } = {}) {
  const ps = participants || [
    makeParticipant("rp-1", "user-1", 30000),
    makeParticipant("rp-2", "user-2", 20000),
    makeParticipant("rp-3", "user-3", 10000),
  ];
  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 100000,
    startedAt: RACE_START,
    endsAt: new Date("2026-04-06T13:00:00.000Z"),
    powerupsEnabled: true,
    powerupStepInterval: 5000,
    participants: ps,
  };

  const stepsByUser = Object.fromEntries(ps.map((p) => [p.userId, p._steps]));

  return {
    Race: { async findById() { return race; } },
    StepSample: {
      // Return each user's full step total in the "start day" window so the
      // progress query's adjusted total equals their real steps.
      async sumStepsInWindow(userId, windowStart) {
        if (windowStart.getTime() === RACE_START.getTime()) {
          return stepsByUser[userId] || 0;
        }
        return 0;
      },
    },
    Steps: {
      async findByUserIdAndDate() { return null; },
      async findByUserIdAndDateRange() { return []; },
    },
    RaceParticipant: {
      async findById(id) { return { id, powerupSlots: 3, nextBoxAtSteps: 0 }; },
      // Mechanical (2026-08-09): production writes participant totals through
      // updateStepTotals({ totalSteps, rawSteps }); delegate so this fake keeps
      // recording exactly what it recorded before.
      async updateStepTotals(id, fields = {}) { return this.updateTotalSteps(id, fields.totalSteps); },
      async updateTotalSteps() {},
      async markFinished() {},
      async setPlacement() {},
    },
    RaceActiveEffect: {
      async findEffectsForRaceByType() { return []; },
      async findActiveForParticipant() { return []; },
      async findActiveForRace() { return activeEffects; },
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
  };
}

function imposter(ownerUserId, swapWithUserId, expiresAt) {
  return {
    type: "IMPOSTER",
    status: "ACTIVE",
    expiresAt,
    targetUserId: ownerUserId,
    sourceUserId: ownerUserId,
    metadata: { swapWithUserId },
  };
}

test("active IMPOSTER swaps the two users' DISPLAYED positions for everyone", async () => {
  // user-1 (1st, 30k) plays IMPOSTER swapping display with user-3 (3rd, 10k).
  const effects = [imposter("user-1", "user-3", FUTURE)];

  // Viewer is a third party (user-2) — the swap is visible to ALL viewers.
  const deps = makeDeps(effects);
  const result = await buildGetRaceProgress(deps)("user-2", "race-1", TZ);

  const order = result.participants.map((p) => p.userId);
  // Without imposter, order is [user-1, user-2, user-3]. After swapping the
  // DISPLAY slots of user-1 and user-3: [user-3, user-2, user-1].
  assert.deepEqual(order, ["user-3", "user-2", "user-1"]);

  // Each keeps their OWN name + real steps, just shown at the other's slot.
  const first = result.participants[0];
  assert.equal(first.userId, "user-3");
  assert.equal(first.displayName, "user-3");
  assert.equal(first.totalSteps, 10000, "user-3 still shows their real steps");

  const last = result.participants[2];
  assert.equal(last.userId, "user-1");
  assert.equal(last.displayName, "user-1");
  assert.equal(last.totalSteps, 30000, "user-1 still shows their real steps");
});

test("the IMPOSTER owner ALSO sees the swap (visible to all viewers)", async () => {
  const effects = [imposter("user-1", "user-3", FUTURE)];
  const deps = makeDeps(effects);
  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  const order = result.participants.map((p) => p.userId);
  assert.deepEqual(order, ["user-3", "user-2", "user-1"]);
});

test("an EXPIRED imposter does NOT swap positions", async () => {
  const effects = [imposter("user-1", "user-3", PAST)];
  const deps = makeDeps(effects);
  const result = await buildGetRaceProgress(deps)("user-2", "race-1", TZ);

  const order = result.participants.map((p) => p.userId);
  assert.deepEqual(order, ["user-1", "user-2", "user-3"], "natural order");
});

test("imposter whose target left the race is skipped gracefully (no swap, no throw)", async () => {
  // swapWithUserId points at someone not in the participant list.
  const effects = [imposter("user-1", "ghost-user", FUTURE)];
  const deps = makeDeps(effects);
  const result = await buildGetRaceProgress(deps)("user-2", "race-1", TZ);

  const order = result.participants.map((p) => p.userId);
  assert.deepEqual(order, ["user-1", "user-2", "user-3"]);
});

test("no IMPOSTER effects => natural ordering by real steps", async () => {
  const deps = makeDeps([]);
  const result = await buildGetRaceProgress(deps)("user-2", "race-1", TZ);

  const order = result.participants.map((p) => p.userId);
  assert.deepEqual(order, ["user-1", "user-2", "user-3"]);
});
