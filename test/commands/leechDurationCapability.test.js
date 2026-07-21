const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup } = require("../../src/modules/powerups/commands/usePowerup");

// ---------------------------------------------------------------------------
// LEECH duration is CAPABILITY-VERSIONED (§7.5).
//
//   request WITHOUT `powerups3` => LEGACY_LEECH_DURATION_MS (30 min)
//   request WITH    `powerups3` => LEECH_DURATION_MS        (60 min)
//
// The capability MUST come from the REQUEST (req.clientFeatures), never from
// User.clientFeatures — that column is a STICKY UNION across all of a user's
// devices (requireAuth.js:41-70), so reading it would silently upgrade a request
// made by a frozen binary that describes a 30-minute Leech to its owner.
//
// test/commands/leechPowerup.test.js:152 is the untouched backward-compatibility
// guard for the legacy path; this suite adds the new one.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-20T12:00:00Z");
const THIRTY_MIN_MS = 30 * 60 * 1000;
const SIXTY_MIN_MS = 60 * 60 * 1000;

function makeParticipant(id, userId, displayName) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    finishedAt: null,
    forfeitedAt: null,
    powerupSlots: 3,
    team: null,
    user: { displayName },
  };
}

function makeDeps(overrides = {}) {
  const effectsCreated = [];
  const participants = [
    makeParticipant("rp-1", "user-1", "Alice"),
    makeParticipant("rp-2", "user-2", "Bob"),
  ];

  return {
    effectsCreated,
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: "user-1",
            raceId: "race-1",
            type: "LEECH",
            status: "HELD",
            rarity: null,
          };
        },
        async update() {},
        async findHeldByParticipant() {
          return [];
        },
        async findUsedTypesByParticipant() {
          return [];
        },
      },
      RaceParticipant: {
        async addBonusSteps() {},
        async subtractBonusSteps() {},
        async updatePowerupSlots() {},
        async updateNextBoxAtSteps() {},
        async findById(id) {
          return participants.find((p) => p.id === id);
        },
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant() {
          return null;
        },
        async findActiveForParticipant() {
          return [];
        },
        async findActiveForRace() {
          return [];
        },
        async create(data) {
          const e = { id: `eff-${effectsCreated.length + 1}`, ...data };
          effectsCreated.push(e);
          return e;
        },
        async update() {},
      },
      RacePowerupEvent: {
        async create(data) {
          return { id: "fe-1", ...data };
        },
      },
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            isTeamRace: false,
            targetSteps: 50000,
            participants,
          };
        },
      },
      // A user whose STICKY stored union already contains powerups3 — it must
      // never be consulted.
      User: {
        async findById() {
          return {
            id: "user-1",
            clientFeatures: ["powerups2", "powerups3", "jammer"],
          };
        },
      },
      eventBus: { emit() {} },
      now: () => NOW,
      ...overrides,
    },
  };
}

test("a request advertising `powerups3` creates a 60-minute Leech", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
    clientFeatures: new Set(["powerups2", "powerups3"]),
  });

  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(
    new Date(ctx.effectsCreated[0].expiresAt).getTime() - NOW.getTime(),
    SIXTY_MIN_MS,
    "powerups3 request => 60 minutes"
  );
});

test("`powerups3` is accepted as a plain array too (route may pass either shape)", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
    clientFeatures: ["powerups3"],
  });

  assert.equal(
    new Date(ctx.effectsCreated[0].expiresAt).getTime() - NOW.getTime(),
    SIXTY_MIN_MS
  );
});

test("a request WITHOUT `powerups3` stays at the legacy 30 minutes even when the user's STICKY union has it", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
    // Header-less / old-binary request: powerups2 only.
    clientFeatures: new Set(["powerups2"]),
  });

  assert.equal(
    new Date(ctx.effectsCreated[0].expiresAt).getTime() - NOW.getTime(),
    THIRTY_MIN_MS,
    "the sticky per-user feature union must NOT upgrade a request that omitted powerups3"
  );
});

test("an omitted clientFeatures argument is the legacy 30 minutes (frozen-binary default)", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.equal(
    new Date(ctx.effectsCreated[0].expiresAt).getTime() - NOW.getTime(),
    THIRTY_MIN_MS
  );
});

test("ratio, scoring version and metadata are unchanged by the duration switch", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);
  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
    clientFeatures: new Set(["powerups3"]),
  });
  assert.deepEqual(ctx.effectsCreated[0].metadata, {
    ratio: 2,
    scoringVersion: 2,
  });
});
