const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildReconcileUploaderRaces,
} = require("../../src/modules/races/services/reconcileUploaderRaces");

const NOW = new Date("2026-07-17T18:00:00.000Z");

function makeDeps() {
  const calls = { updateTotalSteps: [], sync: [], lockOrder: [] };

  const uploader = {
    id: "p-uploader",
    userId: "uploader",
    status: "ACCEPTED",
    totalSteps: 0,
    bonusSteps: 0,
    maxBonusSteps: 0,
    finishedAt: null,
    forfeitedAt: null,
    joinedAt: NOW,
  };
  const rival = {
    id: "p-rival",
    userId: "rival",
    status: "ACCEPTED",
    totalSteps: 999,
    bonusSteps: 0,
    maxBonusSteps: 0,
    finishedAt: null,
    forfeitedAt: null,
    joinedAt: NOW,
  };

  const race = {
    id: "race-1",
    status: "ACTIVE",
    startedAt: NOW,
    endsAt: null,
    powerupsEnabled: false,
    timezone: null,
    participants: [uploader, rival],
  };

  const zeroSteps = {
    async findByUserIdAndDate() { return null; },
    async findByUserIdAndDateRange() { return []; },
  };
  const zeroSamples = {
    async sumStepsInWindow() { return 0; },
    async sumStepsInWindows(_u, windows) { return windows.map(() => 0); },
    async findByUserIdAndTimeRange() { return []; },
  };

  const deps = {
    now: () => NOW,
    Race: { async findActiveForUser() { return [race]; } },
    RaceParticipant: {
      // Mechanical (2026-08-09): production writes participant totals through
      // updateStepTotals({ totalSteps, rawSteps }); delegate so this fake keeps
      // recording exactly what it recorded before.
      async updateStepTotals(id, fields = {}) { return this.updateTotalSteps(id, fields.totalSteps); },
      async updateTotalSteps(id, total) { calls.updateTotalSteps.push({ id, total }); },
    },
    Steps: zeroSteps,
    StepSample: zeroSamples,
    RaceActiveEffect: {
      async findEffectsForRaceByTypes() { return {}; },
      async findActiveForRace() { return []; },
    },
    GlobalStepEvent: { async findActiveInRange() { return []; } },
    syncRacePowerupState: async (args) => { calls.sync.push(args); },
    withRaceResolutionLock: async (raceId, cb) => {
      calls.lockOrder.push(raceId);
      return cb();
    },
  };
  return { deps, calls };
}

test("writes ONLY the uploader's total and runs powerup sync for the uploader", async () => {
  const { deps, calls } = makeDeps();
  const result = await buildReconcileUploaderRaces(deps)({
    userId: "uploader",
    timeZone: "UTC",
  });

  // Exactly one participant write — the uploader — never the rival.
  assert.equal(calls.updateTotalSteps.length, 1);
  assert.equal(calls.updateTotalSteps[0].id, "p-uploader");

  // Powerup state synced once, for the uploader, on the same race.
  assert.equal(calls.sync.length, 1);
  assert.equal(calls.sync[0].userId, "uploader");
  assert.equal(calls.sync[0].raceId, "race-1");

  // Reconciliation happened under the per-race advisory lock.
  assert.deepEqual(calls.lockOrder, ["race-1"]);

  assert.deepEqual(result, { resolvedRaceCount: 1, boxStateCurrent: true });
});

test("skips forfeited uploader participants (frozen totals)", async () => {
  const { deps, calls } = makeDeps();
  const race = (await deps.Race.findActiveForUser())[0];
  race.participants[0].forfeitedAt = NOW;

  const result = await buildReconcileUploaderRaces(deps)({ userId: "uploader", timeZone: "UTC" });
  assert.equal(calls.updateTotalSteps.length, 0);
  assert.equal(result.resolvedRaceCount, 0);
});
