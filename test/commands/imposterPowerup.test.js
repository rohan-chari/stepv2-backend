const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup, PowerupUseError } = require("../../src/modules/powerups/commands/usePowerup");

// ---------------------------------------------------------------------------
// IMPOSTER — purchase-only, TARGETED (needs a target racer). When used inside
// an active race it creates a self-applied (onSelf) RaceActiveEffect of type
// IMPOSTER on the ACTING user's participant, with metadata.swapWithUserId = the
// chosen target, expiring 1 HOUR later. The acting user's IMPOSTER RacePowerup
// is consumed (USED). IMPOSTER is STEALTHY: it must NOT write any feed event, so
// other participants are never notified of the swap. It is purely a DISPLAY swap
// and must NOT change any step counts.
//
// Written from the spec + the cleanse/mirror usePowerup mock patterns, NOT by
// mirroring implementation.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-02T12:00:00Z");
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
            type: "IMPOSTER",
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

test("IMPOSTER is TARGETED — rejects with no target", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      assert.match(err.message, /target/i);
      return true;
    }
  );
});

test("IMPOSTER rejects targeting yourself", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-1",
      }),
    (err) => err instanceof PowerupUseError
  );
});

test("IMPOSTER creates a self-applied display-swap effect with the target + 1h expiry", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.equal(ctx.effectsCreated.length, 1, "exactly one effect created");
  const eff = ctx.effectsCreated[0];
  assert.equal(eff.type, "IMPOSTER");
  // onSelf semantics: the effect is anchored on the ACTING user's participant.
  assert.equal(eff.targetParticipantId, "rp-1");
  assert.equal(eff.targetUserId, "user-1");
  assert.equal(eff.sourceUserId, "user-1");
  // The chosen rival to swap display with lives in metadata.
  assert.equal(eff.metadata.swapWithUserId, "user-2");
  // 1 hour expiry.
  assert.equal(
    new Date(eff.expiresAt).getTime(),
    NOW.getTime() + ONE_HOUR_MS,
    "expires exactly 1 hour after now"
  );
});

test("IMPOSTER consumes the powerup (marks it USED)", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.ok(ctx.updatedPowerup);
  assert.equal(ctx.updatedPowerup.status, "USED");
});

test("IMPOSTER is stealthy: writes NO feed event", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  const feed = ctx.feedEvents.find((e) => e.eventType === "POWERUP_IMPOSTER");
  assert.equal(feed, undefined, "should NOT write a POWERUP_IMPOSTER feed event");
});

test("IMPOSTER does not modify any step counts (purely cosmetic)", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.equal(ctx.bonusChanges.length, 0, "no step/bonus changes");
});

test("IMPOSTER rejects targeting a non-participant", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "ghost-user",
      }),
    (err) => err instanceof PowerupUseError
  );
  assert.equal(ctx.effectsCreated.length, 0);
});

// ---------------------------------------------------------------------------
// Shop-powerup defense rules: IMPOSTER can be BLOCKED by the target's
// Compression Socks (new behavior), but is NEVER reflected by a Mirror.
// ---------------------------------------------------------------------------

test("IMPOSTER is blocked by the target's Compression Socks (shield consumed, no swap)", async () => {
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

  // Blocked outcome, socks consumed, no imposter effect created.
  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(ctx.effectsCreated.length, 0, "no display-swap effect created");
  const blockedUpdate = ctx.effectUpdates.find((u) => u.id === "shield-1");
  assert.equal(blockedUpdate.status, "BLOCKED", "shield is consumed");
  // Powerup is still marked USED.
  assert.ok(ctx.updatedPowerup);
  assert.equal(ctx.updatedPowerup.status, "USED");
  // Emits + writes a POWERUP_BLOCKED event.
  const blockedEvent = ctx.feedEvents.find((e) => e.eventType === "POWERUP_BLOCKED");
  assert.ok(blockedEvent, "writes a POWERUP_BLOCKED feed event");
  assert.match(blockedEvent.description, /Compression Socks/);
  assert.ok(ctx.events.find((e) => e.event === "POWERUP_BLOCKED"));
});

test("IMPOSTER is NOT blocked when a DIFFERENT rival holds Compression Socks", async () => {
  // Socks on Carol (rp-3), but Alice targets Bob (rp-2) — the swap applies.
  const ctx = makeDeps({
    existingEffects: {
      "rp-3": [{ id: "shield-1", type: "COMPRESSION_SOCKS" }],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.notEqual(result.blocked, true);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "IMPOSTER");
  assert.equal(ctx.effectUpdates.length, 0, "unrelated shield untouched");
});

test("IMPOSTER is NOT reflected by the target's Mirror (swap applies, mirror intact)", async () => {
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

  // Applies normally onto the caster; mirror is NOT consumed.
  assert.notEqual(result.blocked, true);
  assert.notEqual(result.reflected, true);
  assert.equal(ctx.effectsCreated.length, 1);
  const eff = ctx.effectsCreated[0];
  assert.equal(eff.type, "IMPOSTER");
  assert.equal(eff.targetParticipantId, "rp-1", "self-applied on the caster");
  assert.equal(eff.metadata.swapWithUserId, "user-2");
  assert.equal(ctx.effectUpdates.length, 0, "mirror is not consumed");
  assert.ok(!ctx.feedEvents.find((e) => e.eventType === "POWERUP_REFLECTED"));
});
