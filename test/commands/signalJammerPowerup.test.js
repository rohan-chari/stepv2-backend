const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");

// ---------------------------------------------------------------------------
// SIGNAL_JAMMER — purchase-only, single-target attack (OFFENSIVE + TARGETED).
// It parks a 1h "can't use powerups" debuff on the target. As a shop-only
// powerup it can NEVER be reflected by a Mirror (the target's Mirror does NOT
// protect them and is NOT consumed), but Compression Socks DO block it
// (consumed, BLOCKED, POWERUP_BLOCKED event, powerup marked USED).
//
// Written from the spec + the imposter/rainstorm usePowerup mock patterns, NOT
// by mirroring implementation.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-04T12:00:00Z");
const ONE_HOUR_MS = 60 * 60 * 1000;

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
  const effectUpdates = [];
  const bonusChanges = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);
  const user3 = makeParticipant("rp-3", "user-3", "Carol", { totalSteps: 8000, ...overrides.user3 });
  const participants = [user1, user2, user3];

  // Pre-existing ACTIVE effects, keyed by participant id, e.g.
  // { "rp-2": [{ id: "shield-1", type: "COMPRESSION_SOCKS" }] }
  const existingEffects = overrides.existingEffects || {};

  return {
    events,
    feedEvents,
    effectsCreated,
    effectUpdates,
    bonusChanges,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            type: "SIGNAL_JAMMER",
            status: overrides.powerupStatus || "HELD",
            rarity: null,
          };
        },
        async update(id, fields) {
          updatedPowerup = { id, ...fields };
          return updatedPowerup;
        },
        async findHeldByParticipant() { return []; },
        async findUsedTypesByParticipant() { return []; },
      },
      RaceParticipant: {
        async addBonusSteps(id, amount) { bonusChanges.push({ id, type: "add", amount }); },
        async subtractBonusSteps(id, amount) { bonusChanges.push({ id, type: "subtract", amount }); },
        async updatePowerupSlots() {},
        async updateNextBoxAtSteps() {},
        async findById(id) { return participants.find((p) => p.id === id); },
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant(participantId, type) {
          const list = existingEffects[participantId] || [];
          return list.find((e) => e.type === type) || null;
        },
        async findActiveForParticipant(participantId) {
          return existingEffects[participantId] || [];
        },
        async findActiveForRace() { return []; },
        async create(data) {
          const e = { id: `eff-${effectsCreated.length + 1}`, ...data };
          effectsCreated.push(e);
          return e;
        },
        async update(id, fields) { effectUpdates.push({ id, ...fields }); },
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
            status: overrides.raceStatus || "ACTIVE",
            targetSteps: 50000,
            participants,
          };
        },
      },
      eventBus: { emit(event, payload) { events.push({ event, payload }); } },
      now: () => NOW,
    },
  };
}

test("SIGNAL_JAMMER parks a 1h jam on the target and marks the powerup USED", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.equal(result.outcome, "APPLIED");
  assert.equal(ctx.effectsCreated.length, 1);
  const eff = ctx.effectsCreated[0];
  assert.equal(eff.type, "SIGNAL_JAMMER");
  assert.equal(eff.targetParticipantId, "rp-2");
  assert.equal(eff.targetUserId, "user-2");
  assert.equal(
    new Date(eff.expiresAt).getTime(),
    NOW.getTime() + ONE_HOUR_MS,
    "jam expires exactly 1 hour after now"
  );
  assert.equal(ctx.updatedPowerup.status, "USED");
});

test("SIGNAL_JAMMER is NOT reflected by the target's Mirror (jam applies, mirror intact)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [{ id: "mirror-1", type: "MIRROR" }],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  // Jam lands on the target (not bounced onto the caster); mirror is untouched.
  assert.notEqual(result.reflected, true);
  assert.notEqual(result.blocked, true);
  assert.equal(ctx.effectsCreated.length, 1);
  const eff = ctx.effectsCreated[0];
  assert.equal(eff.type, "SIGNAL_JAMMER");
  assert.equal(eff.targetUserId, "user-2", "jam lands on the target, not the caster");
  assert.equal(ctx.effectUpdates.length, 0, "mirror is not consumed");
  assert.ok(!ctx.feedEvents.find((e) => e.eventType === "POWERUP_REFLECTED"));
  assert.ok(!ctx.events.find((e) => e.event === "POWERUP_REFLECTED"));
});

test("SIGNAL_JAMMER is blocked by the target's Compression Socks (shield consumed, no jam)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [{ id: "shield-1", type: "COMPRESSION_SOCKS" }],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(result.outcome, "BLOCKED");
  // No jam effect created; shield consumed.
  assert.equal(ctx.effectsCreated.length, 0, "no jam effect created");
  const blockedUpdate = ctx.effectUpdates.find((u) => u.id === "shield-1");
  assert.equal(blockedUpdate.status, "BLOCKED");
  assert.equal(ctx.updatedPowerup.status, "USED");
  const blockedEvent = ctx.feedEvents.find((e) => e.eventType === "POWERUP_BLOCKED");
  assert.ok(blockedEvent, "writes a POWERUP_BLOCKED feed event");
  assert.ok(ctx.events.find((e) => e.event === "POWERUP_BLOCKED"));
});

test("SIGNAL_JAMMER: a target holding BOTH Mirror and Socks is blocked by Socks (Mirror never triggers)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [
        { id: "mirror-1", type: "MIRROR" },
        { id: "shield-1", type: "COMPRESSION_SOCKS" },
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  // Socks consumed; Mirror is NOT (jammer can never reflect).
  assert.ok(ctx.effectUpdates.find((u) => u.id === "shield-1" && u.status === "BLOCKED"));
  assert.ok(!ctx.effectUpdates.find((u) => u.id === "mirror-1"));
  assert.ok(!ctx.feedEvents.find((e) => e.eventType === "POWERUP_REFLECTED"));
});
