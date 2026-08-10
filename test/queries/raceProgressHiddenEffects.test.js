const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/modules/races/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// PART A: Certain ACTIVE self-buffs are hidden from OTHER racers (server-side)
// in the race progress payload's powerupData.activeEffects.
//
// HIDDEN_FROM_OPPONENTS effect types are visible ONLY to their owner:
//   COMPRESSION_SOCKS, MIRROR, LUCKY_HORSESHOE, POCKET_WATCH, FANNY_PACK, TRAIL_MINE
//
// Filter rule for a requesting userId: keep an effect IF
//   effect.targetUserId === userId   (the viewer owns it / it's on them)
//   OR effect.type is NOT in HIDDEN_FROM_OPPONENTS
// Otherwise drop it.
//
// STEALTH_MODE and DETOUR_SIGN have their own separate hiding and are NOT part
// of this set.
// ---------------------------------------------------------------------------

const RACE_START = new Date("2026-03-30T13:00:00.000Z");
const NOW = new Date("2026-03-31T15:00:00.000Z");
const TZ = "America/New_York";

const EXPIRES = new Date("2026-03-31T18:00:00.000Z");

function makeParticipant(overrides = {}) {
  return {
    id: overrides.id || "rp-1",
    userId: overrides.userId || "user-1",
    status: "ACCEPTED",
    joinedAt: RACE_START,
    baselineSteps: 0,
    finishedAt: null,
    bonusSteps: 0,
    nextBoxAtSteps: 0,
    powerupSlots: 3,
    user: { displayName: overrides.userId || "user-1" },
    ...overrides,
  };
}

// activeEffects entries fed to both findActiveForRace calls in getRaceProgress.
function makeDeps(activeEffects) {
  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 100000,
    startedAt: RACE_START,
    endsAt: new Date("2026-04-06T13:00:00.000Z"),
    powerupsEnabled: true,
    powerupStepInterval: 5000,
    participants: [
      makeParticipant({ id: "rp-1", userId: "user-1" }),
      makeParticipant({ id: "rp-2", userId: "user-2" }),
    ],
  };

  return {
    Race: { async findById() { return race; } },
    StepSample: { async sumStepsInWindow() { return 0; } },
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

const HIDDEN_TYPES = [
  "COMPRESSION_SOCKS",
  "MIRROR",
  "LUCKY_HORSESHOE",
  "POCKET_WATCH",
  "FANNY_PACK",
  "TRAIL_MINE",
];

for (const hiddenType of HIDDEN_TYPES) {
  test(`getRaceProgress hides an opponent's ${hiddenType} from a requesting user`, async () => {
    const deps = makeDeps([
      {
        type: hiddenType,
        expiresAt: EXPIRES,
        targetUserId: "user-2",
        sourceUserId: "user-2",
      },
    ]);

    const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);
    const active = result.powerupData.activeEffects;

    assert.equal(
      active.some((e) => e.type === hiddenType),
      false,
      `expected opponent's ${hiddenType} to be hidden from user-1`
    );
  });
}

test("getRaceProgress KEEPS the requesting user's OWN hidden-type effects (targetUserId===me)", async () => {
  const deps = makeDeps([
    {
      type: "COMPRESSION_SOCKS",
      expiresAt: EXPIRES,
      targetUserId: "user-1",
      sourceUserId: "user-1",
    },
    {
      type: "MIRROR",
      expiresAt: EXPIRES,
      targetUserId: "user-1",
      sourceUserId: "user-1",
    },
  ]);

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);
  const active = result.powerupData.activeEffects;

  const socks = active.find((e) => e.type === "COMPRESSION_SOCKS");
  const mirror = active.find((e) => e.type === "MIRROR");

  assert.ok(socks, "owner should still see their own COMPRESSION_SOCKS");
  assert.equal(socks.onSelf, true);
  assert.ok(mirror, "owner should still see their own MIRROR");
  assert.equal(mirror.onSelf, true);
});

test("getRaceProgress still shows a non-hidden public debuff (LEG_CRAMP) on an opponent to everyone", async () => {
  const deps = makeDeps([
    {
      type: "LEG_CRAMP",
      expiresAt: EXPIRES,
      targetUserId: "user-2",
      sourceUserId: "user-1",
    },
  ]);

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);
  const active = result.powerupData.activeEffects;

  const cramp = active.find((e) => e.type === "LEG_CRAMP");
  assert.ok(cramp, "public debuff on opponent should remain visible to others");
  assert.equal(cramp.targetUserId, "user-2");
  assert.equal(cramp.onSelf, false);
});

test("getRaceProgress filters per-viewer: opponent does NOT see my hidden buff but DOES see public debuff on me", async () => {
  const deps = makeDeps([
    // My own concealed self-advantage.
    {
      type: "FANNY_PACK",
      expiresAt: EXPIRES,
      targetUserId: "user-1",
      sourceUserId: "user-1",
    },
    // A public debuff that user-2 placed on me.
    {
      type: "LEG_CRAMP",
      expiresAt: EXPIRES,
      targetUserId: "user-1",
      sourceUserId: "user-2",
    },
  ]);

  // Viewer is the OPPONENT (user-2).
  const result = await buildGetRaceProgress(deps)("user-2", "race-1", TZ);
  const active = result.powerupData.activeEffects;

  assert.equal(
    active.some((e) => e.type === "FANNY_PACK"),
    false,
    "opponent must not see my hidden FANNY_PACK"
  );
  assert.ok(
    active.find((e) => e.type === "LEG_CRAMP"),
    "opponent should still see the public LEG_CRAMP they put on me"
  );
});
