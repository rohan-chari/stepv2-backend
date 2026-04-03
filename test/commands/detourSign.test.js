const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");

// ---------------------------------------------------------------------------
// Detour Sign — targeted, 3 hours, hides entire leaderboard from target
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    user: { displayName },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);

  return {
    events,
    feedEvents,
    effectsCreated,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            participantId: "rp-1",
            type: "DETOUR_SIGN",
            status: overrides.powerupStatus || "HELD",
            rarity: "COMMON",
          };
        },
        async update(id, fields) {
          updatedPowerup = { id, ...fields };
          return updatedPowerup;
        },
      },
      RaceParticipant: {
        async addBonusSteps(id, amount) {},
        async subtractBonusSteps(id, amount) {},
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant(participantId, type) {
          if (type === "COMPRESSION_SOCKS" && overrides.targetHasShield) {
            return { id: "shield-1", status: "ACTIVE" };
          }
          if (type === "DETOUR_SIGN" && overrides.targetHasDetour) {
            return { id: "detour-existing", status: "ACTIVE" };
          }
          return null;
        },
        async create(data) {
          effectsCreated.push(data);
          return { id: "eff-1", ...data };
        },
        async update(id, fields) { return { id, ...fields }; },
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
            participants: [user1, user2],
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
// Basic usage
// ===========================================================================

test("Detour Sign creates a 3-hour timed effect on target", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.ok(result.effect);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "DETOUR_SIGN");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-2");
  assert.equal(ctx.effectsCreated[0].sourceUserId, "user-1");

  // Verify 3-hour duration
  const startsAt = ctx.effectsCreated[0].startsAt.getTime();
  const expiresAt = ctx.effectsCreated[0].expiresAt.getTime();
  assert.equal(expiresAt - startsAt, 3 * 60 * 60 * 1000);
});

// ===========================================================================
// Validation
// ===========================================================================

test("Detour Sign requires a target", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Detour Sign cannot target yourself", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Detour Sign cannot stack on same target", async () => {
  const ctx = makeDeps({ targetHasDetour: true });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Detour Sign is blocked by Compression Socks", async () => {
  const ctx = makeDeps({ targetHasShield: true });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
});

// ===========================================================================
// Feed event
// ===========================================================================

test("Detour Sign creates feed event with target", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "DETOUR_SIGN");
  assert.equal(ctx.feedEvents[0].targetUserId, "user-2");
  assert.ok(ctx.feedEvents[0].description.includes("Detour"));
});

// ===========================================================================
// Status changes
// ===========================================================================

test("Detour Sign status changes to USED after use", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});
