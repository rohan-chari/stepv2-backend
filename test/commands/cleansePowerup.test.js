const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup, PowerupUseError } = require("../../src/modules/powerups/commands/usePowerup");

// ---------------------------------------------------------------------------
// CLEANSE — UNCOMMON, SELF-ONLY (no target picker). When used it removes ALL
// opponent-inflicted debuffs currently active on the user (effects whose
// sourceUserId !== targetUserId), setting them to EXPIRED. It must NEVER touch
// the user's OWN self-buffs (sourceUserId === targetUserId).
//
// "Opponent-inflicted debuff" includes timed debuffs (LEG_CRAMP, WRONG_TURN,
// DETOUR_SIGN) AND a TRAIL_MINE penalty effect placed on the user by someone
// else.
//
// Written from the spec + the Compression Socks / Mirror test mock patterns,
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

// activeEffectsByParticipant: { "rp-1": [ {effect}, ... ] }
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

  // effectsByParticipant: { "rp-1": [ {id, type, status, sourceUserId, targetUserId, ...}, ... ] }
  const effectsByParticipant = overrides.effectsByParticipant || {};

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
            type: overrides.powerupType || "CLEANSE",
            status: overrides.powerupStatus || "HELD",
            rarity: overrides.powerupRarity || "UNCOMMON",
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
          const forP = effectsByParticipant[participantId] || [];
          return forP.find((e) => e.type === type && e.status === "ACTIVE") || null;
        },
        async findActiveForParticipant(participantId) {
          const forP = effectsByParticipant[participantId] || [];
          return forP.filter((e) => e.status === "ACTIVE");
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
      now: () => new Date("2026-06-02T12:00:00Z"),
    },
  };
}

// Helper: build an effect row as the DB would store it.
function effect(id, type, sourceUserId, { targetUserId = "user-1", targetParticipantId = "rp-1", status = "ACTIVE", expiresAt = new Date("2026-06-02T14:00:00Z") } = {}) {
  return { id, type, sourceUserId, targetUserId, targetParticipantId, status, expiresAt };
}

// ===========================================================================
// Self-only behavior
// ===========================================================================

test("Cleanse is self-only — rejects when a targetUserId is given", async () => {
  const ctx = makeDeps({ powerupType: "CLEANSE" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Cleanse consumes the powerup (marks it USED) with no target", async () => {
  const ctx = makeDeps({
    powerupType: "CLEANSE",
    effectsByParticipant: {
      "rp-1": [effect("eff-cramp", "LEG_CRAMP", "user-2")],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.ok(ctx.updatedPowerup, "powerup should be updated");
  assert.equal(ctx.updatedPowerup.id, "pw-1");
  assert.equal(ctx.updatedPowerup.status, "USED");
});

test("Cleanse writes a POWERUP_CLEANSE feed event", async () => {
  const ctx = makeDeps({
    powerupType: "CLEANSE",
    effectsByParticipant: {
      "rp-1": [effect("eff-cramp", "LEG_CRAMP", "user-2")],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  const feed = ctx.feedEvents.find((e) => e.eventType === "POWERUP_CLEANSE");
  assert.ok(feed, "should write a POWERUP_CLEANSE feed event");
  assert.equal(feed.powerupType, "CLEANSE");
});

test("Cleanse does not modify any step counts", async () => {
  const ctx = makeDeps({
    powerupType: "CLEANSE",
    effectsByParticipant: {
      "rp-1": [effect("eff-cramp", "LEG_CRAMP", "user-2")],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 0);
});

// ===========================================================================
// Clears opponent-inflicted debuffs
// ===========================================================================

test("Cleanse expires all opponent-inflicted active debuffs on the user", async () => {
  const ctx = makeDeps({
    powerupType: "CLEANSE",
    effectsByParticipant: {
      "rp-1": [
        effect("eff-cramp", "LEG_CRAMP", "user-2"),
        effect("eff-wt", "WRONG_TURN", "user-3"),
        effect("eff-detour", "DETOUR_SIGN", "user-2"),
        // A Trail Mine penalty placed ON the user by someone else.
        effect("eff-mine", "TRAIL_MINE", "user-3", { expiresAt: null }),
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  for (const id of ["eff-cramp", "eff-wt", "eff-detour", "eff-mine"]) {
    const upd = ctx.effectUpdates.find((u) => u.id === id);
    assert.ok(upd, `effect ${id} should be updated`);
    assert.equal(upd.status, "EXPIRED", `effect ${id} should be EXPIRED`);
  }
});

test("Cleanse returns how many debuffs were cleared", async () => {
  const ctx = makeDeps({
    powerupType: "CLEANSE",
    effectsByParticipant: {
      "rp-1": [
        effect("eff-cramp", "LEG_CRAMP", "user-2"),
        effect("eff-wt", "WRONG_TURN", "user-3"),
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.cleared, 2);
});

test("Cleanse truncates expiresAt to now so the freeze window ends immediately", async () => {
  // Step resolution computes a timed debuff's freeze window from
  // [startsAt, expiresAt] and reads EXPIRED rows too — so flipping status alone
  // (leaving the future expiresAt) would keep freezing steps for the cramp's
  // full original duration. Cleanse must also pull expiresAt back to now.
  const ctx = makeDeps({
    powerupType: "CLEANSE",
    effectsByParticipant: {
      // expiresAt is 2h in the future relative to the mocked now (12:00Z).
      "rp-1": [effect("eff-cramp", "LEG_CRAMP", "user-2")],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  const upd = ctx.effectUpdates.find((u) => u.id === "eff-cramp");
  assert.ok(upd, "the cramp should be updated");
  assert.equal(upd.status, "EXPIRED");
  assert.equal(
    new Date(upd.expiresAt).getTime(),
    new Date("2026-06-02T12:00:00Z").getTime(),
    "expiresAt must be truncated to the cleanse moment (now)"
  );
});

// ===========================================================================
// Does NOT clear the user's OWN self-buffs
// ===========================================================================

test("Cleanse does NOT clear the user's own self-buffs", async () => {
  const ctx = makeDeps({
    powerupType: "CLEANSE",
    effectsByParticipant: {
      "rp-1": [
        // Self-buffs: sourceUserId === targetUserId === user-1
        effect("eff-socks", "COMPRESSION_SOCKS", "user-1"),
        effect("eff-high", "RUNNERS_HIGH", "user-1"),
        effect("eff-mirror", "MIRROR", "user-1"),
        effect("eff-stealth", "STEALTH_MODE", "user-1"),
        // Opponent-inflicted debuff that SHOULD be cleared
        effect("eff-cramp", "LEG_CRAMP", "user-2"),
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  for (const id of ["eff-socks", "eff-high", "eff-mirror", "eff-stealth"]) {
    const upd = ctx.effectUpdates.find((u) => u.id === id);
    assert.equal(upd, undefined, `self-buff ${id} must NOT be touched`);
  }

  // The opponent-inflicted Leg Cramp should still be expired.
  const cramp = ctx.effectUpdates.find((u) => u.id === "eff-cramp");
  assert.ok(cramp, "the opponent Leg Cramp should be cleared");
  assert.equal(cramp.status, "EXPIRED");
});

test("Cleanse with no opponent debuffs is rejected and does NOT consume the powerup", async () => {
  // Only a self-buff is active — there is nothing for Cleanse to clear, so the
  // use must be rejected and the powerup left HELD (not wasted).
  const ctx = makeDeps({
    powerupType: "CLEANSE",
    effectsByParticipant: {
      "rp-1": [effect("eff-socks", "COMPRESSION_SOCKS", "user-1")],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );

  assert.equal(ctx.effectUpdates.length, 0, "no effects should be expired");
  assert.equal(ctx.updatedPowerup, null, "powerup must not be consumed");
});
