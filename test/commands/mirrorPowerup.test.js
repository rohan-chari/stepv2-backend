const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup, PowerupUseError } = require("../../src/modules/powerups/commands/usePowerup");

// ---------------------------------------------------------------------------
// MIRROR — RARE, self-applied shield-like buff. While active on a target, an
// incoming OFFENSIVE powerup is REFLECTED back onto the attacker instead of
// landing on the target. Compression Socks still wins over Mirror.
//
// These tests are written from the spec + the Compression Socks test patterns,
// NOT by mirroring implementation code.
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

// active effects keyed by participantId -> { TYPE: effect }
function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  const bonusChanges = [];
  const effectUpdates = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);
  const user3 = makeParticipant("rp-3", "user-3", "Carol", { totalSteps: 8000, ...overrides.user3 });
  const participants = [user1, user2, user3];

  // shieldsByParticipant: { "rp-1": { COMPRESSION_SOCKS: {...}, MIRROR: {...} } }
  const shieldsByParticipant = overrides.shieldsByParticipant || {};

  return {
    events,
    feedEvents,
    effectsCreated,
    bonusChanges,
    effectUpdates,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            type: overrides.powerupType || "MIRROR",
            status: overrides.powerupStatus || "HELD",
            rarity: overrides.powerupRarity || "RARE",
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
            status: overrides.raceStatus || "ACTIVE",
            targetSteps: overrides.targetSteps || 50000,
            participants,
          };
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      now: () => new Date("2026-03-30T12:00:00Z"),
    },
  };
}

// ===========================================================================
// MIRROR as a self-applied buff
// ===========================================================================

test("Mirror creates a shield-like effect on self", async () => {
  const ctx = makeDeps({ powerupType: "MIRROR" });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
  assert.ok(result.effect);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "MIRROR");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-1");
  assert.equal(ctx.effectsCreated[0].sourceUserId, "user-1");
});

test("Mirror activation is silent — writes NO POWERUP_USED/MIRROR feed event", async () => {
  // Like Imposter, Mirror activation should not post an activity-log event:
  // announcing it tips off attackers that a reflect is armed. The RacePowerupEffect
  // (the actual shield) is still created.
  const ctx = makeDeps({ powerupType: "MIRROR" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  const mirrorFeed = ctx.feedEvents.find(
    (e) => e.eventType === "POWERUP_USED" && e.powerupType === "MIRROR"
  );
  assert.equal(mirrorFeed, undefined, "no POWERUP_USED/MIRROR feed event on activation");

  // The MIRROR effect (shield) is still created.
  const mirrorEffect = ctx.effectsCreated.find((e) => e.type === "MIRROR");
  assert.ok(mirrorEffect, "the MIRROR effect should still be created");
});

test("Mirror is self-only — rejects when a targetUserId is given", async () => {
  const ctx = makeDeps({ powerupType: "MIRROR" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Mirror has the same active-shield duration as Compression Socks (24h base)", async () => {
  const ctx = makeDeps({ powerupType: "MIRROR" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  const effect = ctx.effectsCreated[0];
  assert.ok(effect.expiresAt, "should have an expiresAt timestamp");
  const dur = effect.expiresAt.getTime() - effect.startsAt.getTime();
  assert.equal(dur, 24 * 60 * 60 * 1000);
});

test("Mirror does not modify any step counts on activation", async () => {
  const ctx = makeDeps({ powerupType: "MIRROR" });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 0);
});

// ===========================================================================
// REFLECT — offensive attack on a target who has an active Mirror
// ===========================================================================

test("Leg Cramp on a Mirror holder reflects onto the ATTACKER", async () => {
  // user-2 attacks user-1; user-1 has an active Mirror.
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    powerupOwner: "user-2",
    shieldsByParticipant: {
      "rp-1": { MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" } },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  // Outcome is REFLECTED, not blocked
  assert.equal(result.reflected, true);
  assert.equal(result.outcome, "REFLECTED");
  assert.equal(result.reflectedBy, "MIRROR");

  // The Leg Cramp effect lands on the attacker (user-2 / rp-2), not user-1.
  const cramp = ctx.effectsCreated.find((e) => e.type === "LEG_CRAMP");
  assert.ok(cramp, "a Leg Cramp effect should be created");
  assert.equal(cramp.targetUserId, "user-2", "effect targets the original attacker");
  assert.equal(cramp.targetParticipantId, "rp-2", "effect targets the attacker's participant");
  assert.equal(cramp.sourceUserId, "user-1", "source becomes the original target");
});

test("Reflecting consumes/expires the Mirror", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    powerupOwner: "user-2",
    shieldsByParticipant: {
      "rp-1": { MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" } },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  const mirrorUpdate = ctx.effectUpdates.find((u) => u.id === "eff-mirror");
  assert.ok(mirrorUpdate, "Mirror effect should be updated");
  assert.notEqual(mirrorUpdate.status, "ACTIVE");
});

test("Reflect writes a POWERUP_REFLECTED feed event", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    powerupOwner: "user-2",
    shieldsByParticipant: {
      "rp-1": { MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" } },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  const reflected = ctx.feedEvents.find((e) => e.eventType === "POWERUP_REFLECTED");
  assert.ok(reflected, "should write a POWERUP_REFLECTED feed event");
  assert.equal(reflected.powerupType, "LEG_CRAMP");
});

test("Reflect emits a POWERUP_REFLECTED eventBus event", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    powerupOwner: "user-2",
    shieldsByParticipant: {
      "rp-1": { MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" } },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  const ev = ctx.events.find((e) => e.event === "POWERUP_REFLECTED");
  assert.ok(ev, "should emit POWERUP_REFLECTED");
  assert.equal(ev.payload.reflectedType, "LEG_CRAMP");
});

test("Reflected Shortcut steals from the ATTACKER and gives to the original target", async () => {
  // user-2 attacks user-1 with Shortcut; user-1 mirrors it.
  const ctx = makeDeps({
    powerupType: "SHORTCUT",
    powerupRarity: "COMMON",
    powerupOwner: "user-2",
    user1: { totalSteps: 10000 },
    user2: { totalSteps: 9000 },
    shieldsByParticipant: {
      "rp-1": { MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" } },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  assert.equal(result.outcome, "REFLECTED");
  // Steps should be subtracted from the attacker (rp-2) and added to the
  // original target (rp-1).
  const subtract = ctx.bonusChanges.find((c) => c.type === "subtract");
  const add = ctx.bonusChanges.find((c) => c.type === "add");
  assert.ok(subtract, "attacker should lose steps");
  assert.equal(subtract.id, "rp-2", "steps stolen FROM the attacker");
  assert.ok(add, "original target should gain steps");
  assert.equal(add.id, "rp-1", "steps go TO the original target");
});

test("Reflected Red Card penalizes the attacker, not the target", async () => {
  // Red Card auto-targets the leader. Make user-1 the leader and Mirror holder.
  const ctx = makeDeps({
    powerupType: "RED_CARD",
    powerupOwner: "user-2",
    user1: { totalSteps: 20000 }, // leader, holds Mirror
    user2: { totalSteps: 12000 }, // attacker
    user3: { totalSteps: 8000 },
    shieldsByParticipant: {
      "rp-1": { MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" } },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.outcome, "REFLECTED");
  const subtract = ctx.bonusChanges.find((c) => c.type === "subtract");
  assert.ok(subtract, "a penalty should be applied");
  assert.equal(subtract.id, "rp-2", "Red Card penalty hits the attacker");
});

// ===========================================================================
// PRECEDENCE — Mirror wins over Compression Socks
// ===========================================================================

test("Mirror wins when the target has BOTH socks and Mirror", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    powerupOwner: "user-2",
    shieldsByParticipant: {
      "rp-1": {
        COMPRESSION_SOCKS: { id: "eff-socks", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
        MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" },
      },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  // Reflected, not blocked.
  assert.equal(result.outcome, "REFLECTED");
  assert.equal(result.reflectedBy, "MIRROR");
  assert.ok(!result.blocked);

  // The Leg Cramp effect lands — on the original attacker (rp-2), via reflect.
  const legCramp = ctx.effectsCreated.find((e) => e.type === "LEG_CRAMP");
  assert.ok(legCramp, "the reflected Leg Cramp should be applied");
  assert.equal(legCramp.targetParticipantId, "rp-2", "reflected effect hits the attacker");
});

test("Compression Socks is NOT consumed when Mirror reflects", async () => {
  const ctx = makeDeps({
    powerupType: "LEG_CRAMP",
    powerupOwner: "user-2",
    shieldsByParticipant: {
      "rp-1": {
        COMPRESSION_SOCKS: { id: "eff-socks", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
        MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" },
      },
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" });

  // The Mirror is consumed...
  const mirrorUpdate = ctx.effectUpdates.find((u) => u.id === "eff-mirror");
  assert.ok(mirrorUpdate, "the Mirror should be consumed on reflect");
  assert.equal(mirrorUpdate.status, "EXPIRED");

  // ...but the socks shield is left untouched — banked for a later attack.
  const socksUpdate = ctx.effectUpdates.find((u) => u.id === "eff-socks");
  assert.equal(socksUpdate, undefined, "socks must not be touched when the Mirror reflects");
});

// ===========================================================================
// Each representative offensive type reflects when only Mirror is present
// ===========================================================================

for (const offensiveType of ["LEG_CRAMP", "WRONG_TURN", "DETOUR_SIGN", "SHORTCUT", "PINECONE_TOSS"]) {
  test(`Mirror reflects ${offensiveType} onto the attacker`, async () => {
    const isDirectional = offensiveType === "PINECONE_TOSS";
    const ctx = makeDeps({
      powerupType: offensiveType,
      powerupRarity: offensiveType === "SHORTCUT" ? "COMMON" : "RARE",
      powerupOwner: "user-2",
      // For directional Pinecone Toss, ensure rp-1 is directly ahead of rp-2.
      user1: { totalSteps: 12000 },
      user2: { totalSteps: 10000 },
      user3: { totalSteps: 5000 },
      shieldsByParticipant: {
        "rp-1": { MIRROR: { id: "eff-mirror", type: "MIRROR", status: "ACTIVE" } },
      },
    });
    const use = buildUsePowerup(ctx.deps);

    const args = { userId: "user-2", raceId: "race-1", powerupId: "pw-1" };
    if (isDirectional) {
      args.targetDirection = "FRONT"; // user-1 is ahead of user-2
    } else {
      args.targetUserId = "user-1";
    }

    const result = await use(args);

    assert.equal(result.outcome, "REFLECTED", `${offensiveType} should reflect`);
    assert.equal(result.reflectedBy, "MIRROR");

    // Mirror consumed
    const mirrorUpdate = ctx.effectUpdates.find((u) => u.id === "eff-mirror");
    assert.ok(mirrorUpdate, "Mirror should be consumed");
    assert.notEqual(mirrorUpdate.status, "ACTIVE");
  });
}
