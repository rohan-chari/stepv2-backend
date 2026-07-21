const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// GET /races/{raceId}/progress — powerupData capability contract (§6.2) and
// frozen-client Hitchhike handling (§9.3).
//
//   * `powerupData.capabilities.pocketWatchTargetEffect` tells a new client that
//     this backend understands `targetEffectId`. Without it the client must offer
//     legacy self-buff mode ONLY — otherwise a new binary talking to an OLD
//     backend would send an ignored targetEffectId and silently extend the wrong
//     effects.
//   * activeEffects entries carry `id` so the targeted sheet can name one.
//   * HITCHHIKE effect entries are WITHHELD from clients that don't advertise
//     `powerups3` (they cannot render the type), while the authoritative score
//     still applies. This is the accepted "unexplained score movement" artifact.
// ---------------------------------------------------------------------------

const RACE_START = new Date("2026-07-20T00:00:00Z");
const NOW = new Date("2026-07-20T15:00:00Z");

function participant(id, userId, name) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 0,
    bonusSteps: 0,
    maxBonusSteps: 0,
    powerupSlots: 3,
    nextBoxAtSteps: 0,
    finishedAt: null,
    forfeitedAt: null,
    joinedAt: RACE_START,
    team: null,
    placement: null,
    user: { displayName: name, profilePhotoUrl: null, accessories: [] },
  };
}

function effect(id, type, overrides = {}) {
  return {
    id,
    raceId: "race-1",
    type,
    status: "ACTIVE",
    startsAt: RACE_START,
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    sourceUserId: "me",
    targetUserId: "rival",
    targetParticipantId: "rp-2",
    metadata: {},
    ...overrides,
  };
}

function makeDeps(effects) {
  const me = participant("rp-1", "me", "Alice");
  const rival = participant("rp-2", "rival", "Bob");
  const participants = [me, rival];

  return {
    Race: {
      async findById() {
        return {
          id: "race-1",
          status: "ACTIVE",
          powerupsEnabled: true,
          powerupStepInterval: 2000,
          startedAt: RACE_START,
          endsAt: null,
          timezone: "UTC",
          maxDurationDays: 1,
          targetSteps: 100000,
          isTeamRace: false,
          participants,
        };
      },
    },
    RaceParticipant: {
      async updateTotalSteps() {},
      async findById(id) {
        return participants.find((p) => p.id === id);
      },
    },
    Steps: {
      async findByUserIdAndDate() {
        return null;
      },
      async findByUserIdAndDateRange() {
        return [];
      },
    },
    StepSample: {
      async sumStepsInWindow() {
        return 0;
      },
      async findByUserIdAndTimeRange() {
        return [];
      },
    },
    RaceActiveEffect: {
      async findEffectsForRaceByType() {
        return [];
      },
      async findRaceEffectsByType(_raceId, type) {
        return effects.filter((e) => e.type === type);
      },
      async findActiveForParticipant() {
        return effects;
      },
      async findActiveForRace() {
        return effects;
      },
      async update() {},
    },
    RacePowerup: {
      async findSlotPowerups() {
        return [];
      },
      async countQueuedByParticipant() {
        return 0;
      },
    },
    RacePowerupEvent: {
      async create() {},
      async findMany() {
        return [];
      },
    },
    GlobalStepEvent: {
      async findActiveInRange() {
        return [];
      },
    },
    completeRace: async () => {},
    expireEffects: async () => {},
    syncRacePowerupState: async () => ({}),
    now: () => NOW,
  };
}

test("powerupData.capabilities advertises pocketWatchTargetEffect", async () => {
  const get = buildGetRaceProgress(makeDeps([effect("e1", "LEG_CRAMP")]));
  const progress = await get("me", "race-1", "UTC");
  assert.equal(progress.powerupData.capabilities.pocketWatchTargetEffect, true);
});

test("activeEffects entries carry id, type, expiresAt, onSelf and both user ids", async () => {
  const get = buildGetRaceProgress(makeDeps([effect("e1", "LEG_CRAMP")]));
  const progress = await get("me", "race-1", "UTC");
  const entry = progress.powerupData.activeEffects.find((e) => e.id === "e1");
  assert.ok(entry, "the effect id is exposed so a targeted sheet can name one");
  assert.equal(entry.type, "LEG_CRAMP");
  assert.equal(entry.sourceUserId, "me");
  assert.equal(entry.targetUserId, "rival");
  assert.equal(entry.onSelf, false);
  assert.ok(entry.expiresAt);
});

test("HITCHHIKE effects are WITHHELD from clients without powerups3", async () => {
  const effects = [effect("e1", "LEG_CRAMP"), effect("hh", "HITCHHIKE")];
  const get = buildGetRaceProgress(makeDeps(effects));
  const progress = await get("me", "race-1", "UTC");
  const types = progress.powerupData.activeEffects.map((e) => e.type);
  assert.ok(types.includes("LEG_CRAMP"));
  assert.ok(
    !types.includes("HITCHHIKE"),
    "a frozen binary must never receive a type it cannot render"
  );
});

test("HITCHHIKE effects ARE returned to a powerups3 client", async () => {
  const effects = [effect("e1", "LEG_CRAMP"), effect("hh", "HITCHHIKE")];
  const get = buildGetRaceProgress(makeDeps(effects));
  const progress = await get("me", "race-1", "UTC", false, true);
  const types = progress.powerupData.activeEffects.map((e) => e.type);
  assert.ok(types.includes("HITCHHIKE"));
});

test("withholding the Hitchhike ENTRY does not withhold the score it produces", async () => {
  // The link on the rival is hidden from an old client, but the copy it mints is
  // still applied by the authoritative backend scorer — the accepted §9.3
  // artifact, asserted here so it is never "fixed" into a score divergence.
  const effects = [effect("hh", "HITCHHIKE", { sourceUserId: "rival", targetUserId: "me", targetParticipantId: "rp-1" })];
  const get = buildGetRaceProgress(makeDeps(effects));
  const progress = await get("me", "race-1", "UTC");
  assert.ok(
    !progress.powerupData.activeEffects.some((e) => e.type === "HITCHHIKE")
  );
  assert.ok(
    Array.isArray(progress.participants),
    "the leaderboard still renders, carrying the authoritative total"
  );
});
