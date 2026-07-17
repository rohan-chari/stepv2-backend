const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// IMPOSTER kill switch (Item 3). When disabled (imposterEnabled() === false):
//   * a use request is REJECTED and the item is NOT consumed (stays HELD), and
//   * the leaderboard slot-swap is NOT applied in getRaceProgress (existing
//     held/active Imposters stop swapping rows for everyone).
// The disable is injected here (defaults to the env reader in prod) so these
// tests never touch process.env and never disturb the legacy imposter tests.
// ---------------------------------------------------------------------------

// ── use rejection ──────────────────────────────────────────────────────────
function makeUseDeps() {
  let updatedPowerup = null;
  const participants = [
    { id: "rp-1", userId: "user-1", status: "ACCEPTED", totalSteps: 10000, bonusSteps: 0, finishedAt: null, powerupSlots: 3, user: { displayName: "Alice" } },
    { id: "rp-2", userId: "user-2", status: "ACCEPTED", totalSteps: 8000, bonusSteps: 0, finishedAt: null, powerupSlots: 3, user: { displayName: "Bob" } },
  ];
  return {
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      imposterEnabled: () => false,
      RacePowerup: {
        async findById(id) { return { id, userId: "user-1", raceId: "race-1", type: "IMPOSTER", status: "HELD", rarity: null }; },
        async update(id, fields) { updatedPowerup = { id, ...fields }; return updatedPowerup; },
        async findHeldByParticipant() { return []; },
        async findUsedTypesByParticipant() { return []; },
      },
      RaceParticipant: { async findById(id) { return participants.find((p) => p.id === id); } },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant() { return null; },
        async findActiveForParticipant() { return []; },
        async findActiveForRace() { return []; },
        async create() { throw new Error("should not create an effect when disabled"); },
        async update() {},
      },
      RacePowerupEvent: { async create() {} },
      Race: { async findById() { return { id: "race-1", status: "ACTIVE", participants }; } },
      eventBus: { emit() {} },
      now: () => new Date("2026-07-17T12:00:00Z"),
    },
  };
}

test("IMPOSTER use is rejected when disabled, and the powerup is NOT consumed", async () => {
  const ctx = makeUseDeps();
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => err instanceof PowerupUseError && /unavailable/i.test(err.message)
  );
  assert.equal(ctx.updatedPowerup, null, "item stays HELD — never marked USED");
});

// ── leaderboard swap suppressed ─────────────────────────────────────────────
const RACE_START = new Date("2026-03-30T13:00:00.000Z");
const NOW = new Date("2026-03-31T15:00:00.000Z");
const FUTURE = new Date("2026-03-31T18:00:00.000Z");

function makeProgressDeps(activeEffects) {
  const ps = [
    { id: "rp-1", userId: "user-1", status: "ACCEPTED", joinedAt: RACE_START, finishedAt: null, bonusSteps: 0, nextBoxAtSteps: 0, powerupSlots: 3, totalSteps: 30000, _steps: 30000, user: { displayName: "user-1", profilePhotoUrl: null } },
    { id: "rp-2", userId: "user-2", status: "ACCEPTED", joinedAt: RACE_START, finishedAt: null, bonusSteps: 0, nextBoxAtSteps: 0, powerupSlots: 3, totalSteps: 20000, _steps: 20000, user: { displayName: "user-2", profilePhotoUrl: null } },
    { id: "rp-3", userId: "user-3", status: "ACCEPTED", joinedAt: RACE_START, finishedAt: null, bonusSteps: 0, nextBoxAtSteps: 0, powerupSlots: 3, totalSteps: 10000, _steps: 10000, user: { displayName: "user-3", profilePhotoUrl: null } },
  ];
  const race = { id: "race-1", status: "ACTIVE", targetSteps: 100000, startedAt: RACE_START, endsAt: new Date("2026-04-06T13:00:00.000Z"), powerupsEnabled: true, powerupStepInterval: 5000, participants: ps };
  const stepsByUser = Object.fromEntries(ps.map((p) => [p.userId, p._steps]));
  return {
    imposterEnabled: () => false,
    Race: { async findById() { return race; } },
    StepSample: { async sumStepsInWindow(userId, windowStart) { return windowStart.getTime() === RACE_START.getTime() ? (stepsByUser[userId] || 0) : 0; } },
    Steps: { async findByUserIdAndDate() { return null; }, async findByUserIdAndDateRange() { return []; } },
    RaceParticipant: { async findById(id) { return { id, powerupSlots: 3, nextBoxAtSteps: 0 }; }, async updateTotalSteps() {} },
    RaceActiveEffect: { async findEffectsForRaceByType() { return []; }, async findActiveForParticipant() { return []; }, async findActiveForRace() { return activeEffects; } },
    RacePowerup: { async findSlotPowerups() { return []; }, async countQueuedByParticipant() { return 0; }, async findHeldByParticipant() { return []; }, async findMysteryBoxesByParticipant() { return []; }, async countMysteryBoxesByParticipant() { return 0; }, async countOccupiedSlots() { return 0; }, async findQueuedByParticipant() { return []; } },
    expireEffects: async () => {},
    completeRace: async () => {},
    rollPowerup: async () => [],
    syncRacePowerupState: async () => ({ enabled: true, newMysteryBoxes: [], newQueuedBoxes: 0, queuedBoxCount: 0 }),
    now: () => NOW,
  };
}

test("an active IMPOSTER does NOT swap leaderboard rows when disabled (natural order)", async () => {
  const effects = [{ type: "IMPOSTER", status: "ACTIVE", expiresAt: FUTURE, targetUserId: "user-1", sourceUserId: "user-1", metadata: { swapWithUserId: "user-3" } }];
  const deps = makeProgressDeps(effects);
  const result = await buildGetRaceProgress(deps)("user-2", "race-1", "America/New_York");
  const order = result.participants.map((p) => p.userId);
  assert.deepEqual(order, ["user-1", "user-2", "user-3"], "no swap — natural order by real steps");
});
