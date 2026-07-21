const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildUsePowerup,
  PowerupUseError,
} = require("../../src/modules/powerups/commands/usePowerup");

// ---------------------------------------------------------------------------
// HITCHHIKE (§7) — store-only, TARGETED, 60-minute 1:1 raw-step COPY. Using it
// parks a HITCHHIKE effect on the chosen rival (targetUserId = the walked-on
// racer, sourceUserId = the hitchhiker). The copy itself is scored later from
// the TARGET's in-window steps (src/modules/powerups/hitchhikeCopies.js) — not here.
//
// Socks/Mirror behavior is achieved by LIST MEMBERSHIP alone (§7.2):
//   OFFENSIVE_TYPES  => Compression Socks blocks it
//   SHOP_POWERUP_TYPES => a Mirror can NEVER reflect it
//   TARGETED_TYPES   => the shared targeting validation applies
// There is deliberately no hard-coded IMPOSTER-style branch.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-20T12:00:00Z");
const SIXTY_MIN_MS = 60 * 60 * 1000;

function makeParticipant(id, userId, displayName, overrides = {}) {
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
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  const effectUpdates = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);
  const user3 = makeParticipant("rp-3", "user-3", "Carol", {
    totalSteps: 8000,
    ...overrides.user3,
  });
  const participants = [user1, user2, user3];

  const existingEffects = overrides.existingEffects || {};

  return {
    events,
    feedEvents,
    effectsCreated,
    effectUpdates,
    get updatedPowerup() {
      return updatedPowerup;
    },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            type: "HITCHHIKE",
            status: "HELD",
            rarity: null,
          };
        },
        async update(id, fields) {
          updatedPowerup = { id, ...fields };
          return updatedPowerup;
        },
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
        async findActiveByTypeForParticipant(participantId, type) {
          const list = existingEffects[participantId] || [];
          return list.find((e) => e.type === type) || null;
        },
        async findActiveForParticipant(participantId) {
          return existingEffects[participantId] || [];
        },
        async findActiveForRace() {
          return Object.values(existingEffects).flat();
        },
        async create(data) {
          const e = { id: `eff-${effectsCreated.length + 1}`, ...data };
          effectsCreated.push(e);
          return e;
        },
        async update(id, fields) {
          effectUpdates.push({ id, ...fields });
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
            isTeamRace: overrides.isTeamRace || false,
            targetSteps: 50000,
            participants,
          };
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      now: () => NOW,
    },
  };
}

test("HITCHHIKE requires a target and rejects self-targeting", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => err instanceof PowerupUseError && /target/i.test(err.message)
  );
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

test("HITCHHIKE parks a 60-minute 1:1 link on the target and marks the powerup USED", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.equal(result.outcome, "APPLIED");
  assert.equal(result.durationMs, SIXTY_MIN_MS);
  assert.equal(result.copyRatio, 1);
  assert.equal(ctx.effectsCreated.length, 1);
  const eff = ctx.effectsCreated[0];
  assert.equal(eff.type, "HITCHHIKE");
  assert.equal(eff.targetParticipantId, "rp-2");
  assert.equal(
    eff.targetUserId,
    "user-2",
    "the effect targets the walked-on racer (renders on their row)"
  );
  assert.equal(eff.sourceUserId, "user-1", "sourced by the hitchhiker");
  assert.equal(
    new Date(eff.expiresAt).getTime(),
    NOW.getTime() + SIXTY_MIN_MS,
    "hitchhike window is exactly 60 minutes"
  );
  assert.deepEqual(eff.metadata, { copyRatio: 1, scoringVersion: 1 });
  assert.equal(ctx.updatedPowerup.status, "USED");
});

test("HITCHHIKE writes a POWERUP_USED feed event + emits POWERUP_USED (drives the target push)", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);
  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  const feed = ctx.feedEvents.find(
    (e) => e.eventType === "POWERUP_USED" && e.powerupType === "HITCHHIKE"
  );
  assert.ok(feed, "writes a POWERUP_USED feed event");
  assert.equal(feed.targetUserId, "user-2");
  const emitted = ctx.events.find(
    (e) => e.event === "POWERUP_USED" && e.payload.powerupType === "HITCHHIKE"
  );
  assert.ok(emitted);
  assert.equal(emitted.payload.targetUserId, "user-2");
});

test("HITCHHIKE is blocked by the target's Compression Socks (shield consumed, no link)", async () => {
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
  assert.equal(ctx.effectsCreated.length, 0);
  assert.ok(
    ctx.effectUpdates.find((u) => u.id === "shield-1" && u.status === "BLOCKED")
  );
});

test("HITCHHIKE is NOT reflected by the target's Mirror (link applies, mirror intact)", async () => {
  const ctx = makeDeps({
    existingEffects: { "rp-2": [{ id: "mirror-1", type: "MIRROR" }] },
  });
  const use = buildUsePowerup(ctx.deps);
  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-2",
  });

  assert.notEqual(result.reflected, true);
  assert.notEqual(result.blocked, true);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-2");
  assert.equal(ctx.effectUpdates.length, 0, "mirror is not consumed");
  assert.ok(!ctx.feedEvents.find((e) => e.eventType === "POWERUP_REFLECTED"));
});

test("HITCHHIKE rejects a second link from the SAME caster (409 HITCHHIKE_ALREADY_ACTIVE, item kept)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-3": [
        {
          id: "hh-a",
          type: "HITCHHIKE",
          sourceUserId: "user-1",
          targetUserId: "user-3",
          expiresAt: new Date(NOW.getTime() + 1000),
        },
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-2",
      }),
    (err) =>
      err instanceof PowerupUseError &&
      err.statusCode === 409 &&
      err.code === "HITCHHIKE_ALREADY_ACTIVE"
  );
  assert.equal(ctx.effectsCreated.length, 0);
  assert.equal(ctx.updatedPowerup, null, "powerup NOT consumed on rejection");
});

test("HITCHHIKE rejects a second link ON a target that already has one (409 HITCHHIKE_TARGET_FULL, limit 1)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [
        {
          id: "hh-b",
          type: "HITCHHIKE",
          sourceUserId: "user-3",
          targetUserId: "user-2",
          expiresAt: new Date(NOW.getTime() + 1000),
        },
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-2",
      }),
    (err) =>
      err instanceof PowerupUseError &&
      err.statusCode === 409 &&
      err.code === "HITCHHIKE_TARGET_FULL"
  );
  assert.equal(ctx.effectsCreated.length, 0);
  assert.equal(ctx.updatedPowerup, null, "powerup NOT consumed on rejection");
});

test("HITCHHIKE cannot target a teammate in a team race", async () => {
  const ctx = makeDeps({
    isTeamRace: true,
    user1: { team: "TEAM_A" },
    user2: { team: "TEAM_A" },
    user3: { team: "TEAM_B" },
  });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-2",
      }),
    (err) => err instanceof PowerupUseError
  );
  assert.equal(ctx.effectsCreated.length, 0);
});

test("HITCHHIKE cannot target a forfeited racer", async () => {
  const ctx = makeDeps({ user2: { forfeitedAt: NOW } });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-2",
      }),
    (err) => err instanceof PowerupUseError
  );
  assert.equal(ctx.effectsCreated.length, 0);
});
