const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");

// ---------------------------------------------------------------------------
// RAINSTORM — purchase-only, UNTARGETED AoE debuff. When used inside an active
// race it creates a RAINSTORM RaceActiveEffect (multiplier 0.5, 1 HOUR) on
// every OTHER active (unfinished) participant — never on the caster. As a
// shop-only powerup it can NEVER be reflected by a Mirror: a victim's Mirror
// does not protect them and is not consumed. The only per-victim defense is
// COMPRESSION_SOCKS, which consumes (BLOCKED) and protects that victim. Never
// stacks: while any RAINSTORM is active in the race a second use is rejected.
// Writes one POWERUP_USED feed event.
//
// Written from the spec + the imposter/cleanse usePowerup mock patterns, NOT
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
  const participants = overrides.participants || [user1, user2, user3];

  // Pre-existing ACTIVE effects, keyed by participant id, e.g.
  // { "rp-2": [{ id: "shield-1", type: "COMPRESSION_SOCKS" }] }
  const existingEffects = overrides.existingEffects || {};
  const raceEffects = overrides.raceEffects || [];

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
            type: "RAINSTORM",
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
        async findActiveForRace() { return raceEffects; },
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

test("RAINSTORM is untargeted — rejects when a target is specified", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-2",
      }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.match(err.message, /target/i);
      return true;
    }
  );
});

test("RAINSTORM debuffs every OTHER active participant for 1h at 0.5x — never the caster", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.effectsCreated.length, 2, "one effect per rival");
  const targets = ctx.effectsCreated.map((e) => e.targetUserId).sort();
  assert.deepEqual(targets, ["user-2", "user-3"]);
  for (const eff of ctx.effectsCreated) {
    assert.equal(eff.type, "RAINSTORM");
    assert.equal(eff.sourceUserId, "user-1");
    assert.equal(eff.metadata.multiplier, 0.5);
    assert.equal(
      new Date(eff.expiresAt).getTime(),
      NOW.getTime() + ONE_HOUR_MS,
      "expires exactly 1 hour after now"
    );
  }
  assert.equal(result.affected, 2);
  assert.equal(ctx.bonusChanges.length, 0, "no instant step changes");
});

test("RAINSTORM skips finished participants", async () => {
  const ctx = makeDeps({ user3: { finishedAt: new Date("2026-07-03T00:00:00Z") } });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-2");
});

test("RAINSTORM rejects when a storm is already active in the race (no stacking)", async () => {
  const ctx = makeDeps({
    raceEffects: [{ id: "eff-old", type: "RAINSTORM", status: "ACTIVE" }],
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.match(err.message, /already active/i);
      return true;
    }
  );
  assert.equal(ctx.effectsCreated.length, 0);
});

test("RAINSTORM rejects when there is no other active runner", async () => {
  const solo = makeParticipant("rp-1", "user-1", "Alice");
  const ctx = makeDeps({ participants: [solo] });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => err instanceof PowerupUseError
  );
});

test("COMPRESSION_SOCKS blocks the rain for that victim only (shield consumed)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [{ id: "shield-1", type: "COMPRESSION_SOCKS" }],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Bob is protected; Carol still gets rained on.
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-3");
  assert.equal(result.affected, 1);
  assert.equal(result.blockedCount, 1);
  // The shield is consumed.
  const blockedUpdate = ctx.effectUpdates.find((u) => u.id === "shield-1");
  assert.equal(blockedUpdate.status, "BLOCKED");
  const blockedEvent = ctx.feedEvents.find((e) => e.eventType === "POWERUP_BLOCKED");
  assert.ok(blockedEvent, "writes a POWERUP_BLOCKED feed event");
});

test("MIRROR does NOT protect victims and does NOT bounce the rain — victims soaked, mirrors intact", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [{ id: "mirror-1", type: "MIRROR" }],
      "rp-3": [{ id: "mirror-2", type: "MIRROR" }],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  // Both rivals are soaked (Mirror is Rainstorm-proof); the caster is never hit.
  assert.equal(ctx.effectsCreated.length, 2, "both rivals get the 0.5x debuff");
  const targets = ctx.effectsCreated.map((e) => e.targetUserId).sort();
  assert.deepEqual(targets, ["user-2", "user-3"]);
  for (const eff of ctx.effectsCreated) {
    assert.equal(eff.type, "RAINSTORM");
    assert.notEqual(eff.targetUserId, "user-1", "caster is never soaked");
  }
  assert.equal(result.affected, 2);
  assert.equal(result.blockedCount, 0);
  assert.equal(result.reflectedOntoCaster, false);
  // Neither mirror is consumed, and no reflect event is emitted.
  assert.equal(ctx.effectUpdates.length, 0, "mirrors are not touched");
  assert.ok(!ctx.feedEvents.find((e) => e.eventType === "POWERUP_REFLECTED"));
  assert.ok(!ctx.events.find((e) => e.event === "POWERUP_REFLECTED"));
});

test("RAINSTORM consumes the powerup and writes one POWERUP_USED feed event", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.ok(ctx.updatedPowerup);
  assert.equal(ctx.updatedPowerup.status, "USED");
  const usedEvents = ctx.feedEvents.filter((e) => e.eventType === "POWERUP_USED");
  assert.equal(usedEvents.length, 1);
  assert.match(usedEvents[0].description, /Rainstorm/);
});
