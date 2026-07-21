const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup } = require("../../src/modules/powerups/commands/usePowerup");

// ---------------------------------------------------------------------------
// SHORTCUT vs MIRROR
//
// Scenario: the attacker uses Shortcut on a target who holds an active Mirror.
// Mirror reflects the offensive powerup back onto the attacker, so the steal is
// applied in reverse: 1000 steps are taken FROM the attacker and handed to the
// original target.
//
// Expectation under test: the net result is the attacker ("the user") just
// losing 1000 steps.
//
// Written from the spec + the existing Mirror/Shortcut test patterns, not by
// reading the implementation back to itself.
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    finishedAt: null,
    powerupSlots: 3,
    user: { displayName },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  const bonusChanges = [];
  const effectUpdates = [];

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1); // target, holds Mirror
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2); // attacker, uses Shortcut
  const participants = [user1, user2];

  const shieldsByParticipant = overrides.shieldsByParticipant || {};

  return {
    events,
    feedEvents,
    effectsCreated,
    bonusChanges,
    effectUpdates,
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-2",
            raceId: "race-1",
            type: overrides.powerupType || "SHORTCUT",
            status: overrides.powerupStatus || "HELD",
            rarity: overrides.powerupRarity || "COMMON",
          };
        },
        async update() {},
        async findHeldByParticipant() { return []; },
        async findUsedTypesByParticipant() { return []; },
      },
      RaceParticipant: {
        async addBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "add", amount });
        },
        async subtractBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "subtract", amount });
        },
        async updatePowerupSlots() {},
        async updateNextBoxAtSteps() {},
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant(participantId, type) {
          const forP = shieldsByParticipant[participantId] || {};
          return forP[type] || null;
        },
        async findActiveForParticipant(participantId) {
          const forP = shieldsByParticipant[participantId] || {};
          return Object.values(forP);
        },
        async create(data) {
          const e = { id: `eff-${effectsCreated.length + 1}`, ...data };
          effectsCreated.push(e);
          return e;
        },
        async update(id, fields) {
          effectUpdates.push({ id, ...fields });
          return { id, ...fields };
        },
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: "fe-1", ...data };
        },
      },
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            targetSteps: 200000,
            participants,
          };
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      now: () => new Date("2026-06-22T12:00:00Z"),
    },
  };
}

test("Shortcut reflected by Mirror: attacker just loses 1000 steps", async () => {
  // Bob (user-2 / rp-2) attacks Alice (user-1 / rp-1) with Shortcut.
  // Alice holds an active Mirror — it reflects the Shortcut back onto Bob.
  const ctx = makeDeps({
    powerupType: "SHORTCUT",
    powerupRarity: "COMMON",
    powerupOwner: "user-2",
    user1: { totalSteps: 5000 }, // target / Mirror holder
    user2: { totalSteps: 5000 }, // attacker — needs >=1000 for the reflected steal
    shieldsByParticipant: {
      "rp-1": { MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" } },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-2",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-1",
  });

  // The attack was reflected, and the magnitude is the base 1000.
  assert.equal(result.outcome, "REFLECTED");
  assert.equal(result.reflected, true);
  assert.equal(result.reflectedBy, "MIRROR");
  assert.equal(result.stolen, 1000);

  // The 1000 steps are taken FROM the attacker (rp-2) and given to the original
  // target (rp-1). Net for the attacker: -1000.
  const subtract = ctx.bonusChanges.find((c) => c.type === "subtract");
  const add = ctx.bonusChanges.find((c) => c.type === "add");

  assert.ok(subtract, "the attacker should lose steps");
  assert.equal(subtract.id, "rp-2", "steps are taken from the attacker");
  assert.equal(subtract.amount, 1000, "attacker loses exactly 1000");

  assert.ok(add, "the mirror holder should gain steps");
  assert.equal(add.id, "rp-1", "steps go to the original target");
  assert.equal(add.amount, 1000, "target gains exactly 1000");

  // Net effect on the attacker is a clean -1000 (no other charges to rp-2).
  const attackerChanges = ctx.bonusChanges.filter((c) => c.id === "rp-2");
  const attackerNet = attackerChanges.reduce(
    (sum, c) => sum + (c.type === "add" ? c.amount : -c.amount),
    0
  );
  assert.equal(attackerNet, -1000, "attacker's net step change is exactly -1000");
});
