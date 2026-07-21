const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup, PowerupUseError } = require("../../src/modules/powerups/commands/usePowerup");

// ---------------------------------------------------------------------------
// LEECH — store-only, TARGETED, leecher-driven debuff (Item 2). Using it parks a
// 30-minute LEECH effect on the chosen rival (targetUserId = victim,
// sourceUserId = leecher). The actual step drain is computed later in
// getRaceProgress from the LEECHER's in-window steps — not here. As a shop
// powerup it can NEVER be reflected by a Mirror, but Compression Socks DO block
// it. NOT stealthy: it writes a POWERUP_USED feed event (which drives the
// victim's push) and the effect targets the victim so a badge renders on their
// row.
//
// Written from the spec + the signal-jammer/rainstorm usePowerup mock patterns.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-17T12:00:00Z");
const THIRTY_MIN_MS = 30 * 60 * 1000;

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    finishedAt: null,
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
  const user3 = makeParticipant("rp-3", "user-3", "Carol", { totalSteps: 8000, ...overrides.user3 });
  const participants = [user1, user2, user3];

  const existingEffects = overrides.existingEffects || {};

  return {
    events,
    feedEvents,
    effectsCreated,
    effectUpdates,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            type: "LEECH",
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
        async addBonusSteps() {},
        async subtractBonusSteps() {},
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
            isTeamRace: overrides.isTeamRace || false,
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

test("LEECH requires a target", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => err instanceof PowerupUseError && /target/i.test(err.message)
  );
});

test("LEECH parks a 30-minute effect on the victim and marks the powerup USED", async () => {
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
  assert.equal(eff.type, "LEECH");
  assert.equal(eff.targetParticipantId, "rp-2");
  assert.equal(eff.targetUserId, "user-2", "effect targets the VICTIM (renders on their row)");
  assert.equal(eff.sourceUserId, "user-1", "sourced by the leecher (drives the scorer)");
  assert.equal(
    new Date(eff.expiresAt).getTime(),
    NOW.getTime() + THIRTY_MIN_MS,
    "leech window is exactly 30 minutes"
  );
  assert.equal(ctx.updatedPowerup.status, "USED");
});

test("LEECH writes a POWERUP_USED feed event + emits POWERUP_USED (drives the victim push, NOT stealthy)", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  const feed = ctx.feedEvents.find((e) => e.eventType === "POWERUP_USED" && e.powerupType === "LEECH");
  assert.ok(feed, "writes a POWERUP_USED feed event");
  assert.equal(feed.targetUserId, "user-2");
  const emitted = ctx.events.find((e) => e.event === "POWERUP_USED" && e.payload.powerupType === "LEECH");
  assert.ok(emitted, "emits POWERUP_USED so the notification handler can push the victim");
  assert.equal(emitted.payload.targetUserId, "user-2");
});

test("LEECH is blocked by the victim's Compression Socks (shield consumed, no leech effect)", async () => {
  const ctx = makeDeps({
    existingEffects: { "rp-2": [{ id: "shield-1", type: "COMPRESSION_SOCKS" }] },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.effectsCreated.length, 0, "no leech effect created");
  assert.ok(ctx.effectUpdates.find((u) => u.id === "shield-1" && u.status === "BLOCKED"));
  assert.equal(ctx.updatedPowerup.status, "USED");
});

test("LEECH is NOT reflected by the victim's Mirror (leech applies, mirror intact)", async () => {
  const ctx = makeDeps({
    existingEffects: { "rp-2": [{ id: "mirror-1", type: "MIRROR" }] },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.notEqual(result.reflected, true);
  assert.notEqual(result.blocked, true);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-2");
  assert.equal(ctx.effectUpdates.length, 0, "mirror is not consumed");
  assert.ok(!ctx.feedEvents.find((e) => e.eventType === "POWERUP_REFLECTED"));
});

test("LEECH rejects a second leech from the SAME leecher on the same victim (item kept)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [{ id: "leech-a", type: "LEECH", sourceUserId: "user-1", targetUserId: "user-2" }],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => err instanceof PowerupUseError
  );
  assert.equal(ctx.effectsCreated.length, 0, "no new leech created");
  assert.equal(ctx.updatedPowerup, null, "powerup NOT consumed on rejection");
});

test("LEECH rejects a THIRD concurrent leecher on the same victim (max 2)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [
        { id: "leech-a", type: "LEECH", sourceUserId: "user-3", targetUserId: "user-2" },
        { id: "leech-b", type: "LEECH", sourceUserId: "user-9", targetUserId: "user-2" },
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => err instanceof PowerupUseError
  );
  assert.equal(ctx.effectsCreated.length, 0);
  assert.equal(ctx.updatedPowerup, null, "powerup NOT consumed on rejection");
});

test("LEECH allows a SECOND distinct leecher on the same victim (only 1 already active)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [{ id: "leech-a", type: "LEECH", sourceUserId: "user-3", targetUserId: "user-2" }],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });
  assert.equal(result.outcome, "APPLIED");
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].sourceUserId, "user-1");
});

test("LEECH cannot target a teammate in a team race", async () => {
  const ctx = makeDeps({
    isTeamRace: true,
    user1: { team: "TEAM_A" },
    user2: { team: "TEAM_A" }, // same team as the leecher
    user3: { team: "TEAM_B" },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => err instanceof PowerupUseError
  );
  assert.equal(ctx.effectsCreated.length, 0);
});
