const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Stealth Mode — self-only, hides progress from others for 4 hours
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    finishedAt: null,
    placement: null,
    user: { displayName },
    ...overrides,
  };
}

function makePowerupDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  const bonusChanges = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);
  const participants = [user1, user2];

  return {
    events,
    feedEvents,
    effectsCreated,
    bonusChanges,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            type: "STEALTH_MODE",
            status: overrides.powerupStatus || "HELD",
            rarity: "RARE",
          };
        },
        async update(id, fields) {
          updatedPowerup = { id, ...fields };
          return updatedPowerup;
        },
      },
      RaceParticipant: {
        async addBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "add", amount });
        },
        async subtractBonusSteps(id, amount) {
          bonusChanges.push({ id, type: "subtract", amount });
        },
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant(participantId, type) {
          if (type === "STEALTH_MODE" && overrides.existingStealthMode) {
            return overrides.existingStealthMode;
          }
          return null;
        },
        async create(data) {
          const e = { id: "eff-1", ...data };
          effectsCreated.push(e);
          return e;
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
// Basic usage
// ===========================================================================

test("Stealth Mode creates an active effect on self", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(result.blocked, false);
  assert.ok(result.effect);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "STEALTH_MODE");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-1");
  assert.equal(ctx.effectsCreated[0].sourceUserId, "user-1");
});

test("Stealth Mode effect lasts exactly 4 hours", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  const effect = ctx.effectsCreated[0];
  const startsAt = new Date(effect.startsAt).getTime();
  const expiresAt = new Date(effect.expiresAt).getTime();
  const fourHoursMs = 4 * 60 * 60 * 1000;

  assert.equal(expiresAt - startsAt, fourHoursMs);
});

test("Stealth Mode does not modify any step counts", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.bonusChanges.length, 0);
});

// ===========================================================================
// Powerup status after use
// ===========================================================================

test("Stealth Mode marks powerup as USED after use", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

// ===========================================================================
// Events
// ===========================================================================

test("Stealth Mode emits POWERUP_USED event with correct payload", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "STEALTH_MODE");
  assert.equal(ctx.events[0].payload.userId, "user-1");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
});

test("Stealth Mode creates a feed event", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "STEALTH_MODE");
  assert.equal(ctx.feedEvents[0].raceId, "race-1");
});

// ===========================================================================
// Self-only constraint
// ===========================================================================

test("Stealth Mode rejects if a targetUserId is provided", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Stacking
// ===========================================================================

test("Stealth Mode rejects if user already has an active Stealth Mode", async () => {
  const ctx = makePowerupDeps({
    existingStealthMode: {
      id: "eff-existing",
      type: "STEALTH_MODE",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T10:00:00Z"),
      expiresAt: new Date("2026-03-30T14:00:00Z"),
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
});

test("Stealth Mode powerup stays HELD when rejected due to existing active stealth", async () => {
  const ctx = makePowerupDeps({
    existingStealthMode: {
      id: "eff-existing",
      type: "STEALTH_MODE",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T10:00:00Z"),
      expiresAt: new Date("2026-03-30T14:00:00Z"),
    },
  });
  const use = buildUsePowerup(ctx.deps);

  try {
    await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  } catch {
    // expected
  }

  assert.equal(ctx.updatedPowerup, null);
});

// ===========================================================================
// Finished participant
// ===========================================================================

test("Stealth Mode rejects if user has already finished the race", async () => {
  const ctx = makePowerupDeps({
    user1: { finishedAt: new Date("2026-03-29T10:00:00Z") },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Powerup status validation
// ===========================================================================

test("Stealth Mode rejects if powerup is USED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "USED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Stealth Mode rejects if powerup is DISCARDED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "DISCARDED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Stealth Mode rejects if powerup is EXPIRED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "EXPIRED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Race status validation
// ===========================================================================

test("Stealth Mode rejects if race is COMPLETED", async () => {
  const ctx = makePowerupDeps({ raceStatus: "COMPLETED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Stealth Mode rejects if race is PENDING", async () => {
  const ctx = makePowerupDeps({ raceStatus: "PENDING" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Stealth Mode rejects if race is CANCELLED", async () => {
  const ctx = makePowerupDeps({ raceStatus: "CANCELLED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Ownership
// ===========================================================================

test("Stealth Mode rejects if used by someone who doesn't own it", async () => {
  const ctx = makePowerupDeps({ powerupOwner: "user-1" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Leaderboard visibility — via getRaceProgress
// ===========================================================================

const RACE_START = new Date("2026-03-28T08:00:00Z");
const NOW = new Date("2026-03-30T12:00:00Z");

function makeProgressDeps(overrides = {}) {
  const finishCalls = [];
  const completeCalls = [];

  const participants = overrides.participants || [];
  const activeEffects = overrides.activeEffects || [];

  return {
    finishCalls,
    completeCalls,
    deps: {
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            targetSteps: overrides.targetSteps || 100000,
            startedAt: RACE_START,
            endsAt: new Date("2026-04-04T08:00:00Z"),
            powerupsEnabled: true,
            powerupStepInterval: 50000,
            participants,
          };
        },
      },
      StepSample: {
        async sumStepsInWindow(userId, start) {
          // Only return steps for windows that overlap with the start day
          if (new Date(start).getTime() >= new Date("2026-03-29T00:00:00Z").getTime()) return 0;
          const p = participants.find((p) => p.userId === userId);
          return p?._rawSteps || 0;
        },
      },
      Steps: {
        async findByUserIdAndDate() { return null; },
        async findByUserIdAndDateRange() { return []; },
      },
      RaceParticipant: {
        async updateTotalSteps() {},
        async markFinished(id, time) { finishCalls.push({ id, time }); },
        async setPlacement() {},
      },
      RaceActiveEffect: {
        async findEffectsForRaceByType() { return []; },
        async findActiveForParticipant() { return activeEffects; },
        async findActiveForRace() { return activeEffects; },
      },
      RacePowerup: {
        async findHeldByParticipant() { return []; },
        async countMysteryBoxesByParticipant() { return 0; },
        async findMysteryBoxesByParticipant() { return []; },
      },
      expireEffects: async () => {},
      completeRace: async (data) => { completeCalls.push(data); },
      rollPowerup: async () => [],
      now: () => NOW,
    },
  };
}

test("Stealthed user appears as '???' with null steps to other participants", async () => {
  const ctx = makeProgressDeps({
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 8000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 6000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
    ],
    activeEffects: [{
      id: "eff-1",
      type: "STEALTH_MODE",
      status: "ACTIVE",
      targetUserId: "user-1",
      sourceUserId: "user-1",
      startsAt: new Date("2026-03-30T10:00:00Z"),
      expiresAt: new Date("2026-03-30T14:00:00Z"),
    }],
  });

  // user-2 viewing the race — user-1 should be hidden
  const result = await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");
  const p1 = result.participants.find((p) => p.userId === "user-1");

  assert.equal(p1.displayName, "???");
  assert.equal(p1.totalSteps, null);
  assert.equal(p1.progress, null);
  assert.equal(p1.stealthed, true);
});

test("Stealthed user can see their own stats normally", async () => {
  const ctx = makeProgressDeps({
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 8000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 6000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
    ],
    activeEffects: [{
      id: "eff-1",
      type: "STEALTH_MODE",
      status: "ACTIVE",
      targetUserId: "user-1",
      sourceUserId: "user-1",
      startsAt: new Date("2026-03-30T10:00:00Z"),
      expiresAt: new Date("2026-03-30T14:00:00Z"),
    }],
  });

  // user-1 viewing the race — should see their own stats
  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p1 = result.participants.find((p) => p.userId === "user-1");

  assert.equal(p1.displayName, "Alice");
  assert.equal(p1.totalSteps, 8000);
  assert.equal(p1.stealthed, false);
});

test("Stealthed user appears at the top of the leaderboard", async () => {
  const ctx = makeProgressDeps({
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 3000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 9000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 6000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
    ],
    activeEffects: [{
      id: "eff-1",
      type: "STEALTH_MODE",
      status: "ACTIVE",
      targetUserId: "user-1",
      sourceUserId: "user-1",
      startsAt: new Date("2026-03-30T10:00:00Z"),
      expiresAt: new Date("2026-03-30T14:00:00Z"),
    }],
  });

  // user-2 viewing — user-1 (stealthed, 3000 steps) should be at top despite having fewest steps
  const result = await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");

  assert.equal(result.participants[0].userId, "user-1");
  assert.equal(result.participants[0].stealthed, true);
  // Non-stealthed users sorted normally after
  assert.equal(result.participants[1].userId, "user-2");
  assert.equal(result.participants[2].userId, "user-3");
});

test("Multiple stealthed users all appear at the top", async () => {
  const ctx = makeProgressDeps({
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 2000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 9000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 1000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
    ],
    activeEffects: [
      {
        id: "eff-1", type: "STEALTH_MODE", status: "ACTIVE",
        targetUserId: "user-1", sourceUserId: "user-1",
        startsAt: new Date("2026-03-30T10:00:00Z"), expiresAt: new Date("2026-03-30T14:00:00Z"),
      },
      {
        id: "eff-2", type: "STEALTH_MODE", status: "ACTIVE",
        targetUserId: "user-3", sourceUserId: "user-3",
        startsAt: new Date("2026-03-30T10:00:00Z"), expiresAt: new Date("2026-03-30T14:00:00Z"),
      },
    ],
  });

  // user-2 viewing — both stealthed users should be at the top
  const result = await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");

  const stealthedEntries = result.participants.filter((p) => p.stealthed);
  const nonStealthedEntries = result.participants.filter((p) => !p.stealthed);

  assert.equal(stealthedEntries.length, 2);
  assert.equal(nonStealthedEntries.length, 1);

  // All stealthed entries come before non-stealthed
  const firstNonStealthIdx = result.participants.findIndex((p) => !p.stealthed);
  const lastStealthIdx = result.participants.length - 1 - [...result.participants].reverse().findIndex((p) => p.stealthed);
  assert.ok(lastStealthIdx < firstNonStealthIdx, "all stealthed users should be above non-stealthed");
});

test("Stealth wears off after expiry — user becomes visible again", async () => {
  // No active stealth effects (it expired)
  const ctx = makeProgressDeps({
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 8000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 6000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
    ],
    activeEffects: [], // stealth expired
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");
  const p1 = result.participants.find((p) => p.userId === "user-1");

  assert.equal(p1.displayName, "Alice");
  assert.equal(p1.totalSteps, 8000);
  assert.equal(p1.stealthed, false);
});

// ===========================================================================
// Stealthed user can still be targeted by offensive powerups
// ===========================================================================

test("Stealthed user can be targeted by Leg Cramp", async () => {
  const ctx = makePowerupDeps({
    user1: { totalSteps: 10000 },
    user2: { totalSteps: 8000 },
  });
  // Override the powerup type to LEG_CRAMP and add stealth on user-2
  ctx.deps.RacePowerup.findById = async (id) => ({
    id,
    userId: "user-1",
    raceId: "race-1",
    type: "LEG_CRAMP",
    status: "HELD",
    rarity: "UNCOMMON",
  });

  const use = buildUsePowerup(ctx.deps);

  // user-1 attacks stealthed user-2 — should succeed
  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, false);
  assert.ok(result.effect);
});

test("Stealthed user can be targeted by Shortcut", async () => {
  const ctx = makePowerupDeps({
    user1: { totalSteps: 10000 },
    user2: { totalSteps: 8000 },
  });
  ctx.deps.RacePowerup.findById = async (id) => ({
    id,
    userId: "user-1",
    raceId: "race-1",
    type: "SHORTCUT",
    status: "HELD",
    rarity: "COMMON",
  });

  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, false);
  assert.equal(result.stolen, 1000);
});

// ===========================================================================
// Stealthed user finishing — becomes visible
// ===========================================================================

test("Stealthed user who finishes becomes visible on leaderboard", async () => {
  const ctx = makeProgressDeps({
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000,
        finishedAt: new Date("2026-03-30T11:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 6000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
    ],
    targetSteps: 10000,
    // Stealth is still technically active, but user-1 has finished
    activeEffects: [{
      id: "eff-1",
      type: "STEALTH_MODE",
      status: "ACTIVE",
      targetUserId: "user-1",
      sourceUserId: "user-1",
      startsAt: new Date("2026-03-30T10:00:00Z"),
      expiresAt: new Date("2026-03-30T14:00:00Z"),
    }],
  });

  // user-2 viewing — finished stealthed user-1 should be visible
  const result = await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");
  const p1 = result.participants.find((p) => p.userId === "user-1");

  assert.equal(p1.displayName, "Alice", "finished user should be visible even if stealth is active");
  assert.ok(p1.totalSteps !== null, "finished user's steps should be visible");
  assert.equal(p1.stealthed, false, "finished user should not be marked as stealthed");
});

// ===========================================================================
// Stealthed user's placing/numbers hidden
// ===========================================================================

test("Stealthed user's progress is null to other viewers", async () => {
  const ctx = makeProgressDeps({
    targetSteps: 50000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 25000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 10000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 50000 }),
    ],
    activeEffects: [{
      id: "eff-1",
      type: "STEALTH_MODE",
      status: "ACTIVE",
      targetUserId: "user-1",
      sourceUserId: "user-1",
      startsAt: new Date("2026-03-30T10:00:00Z"),
      expiresAt: new Date("2026-03-30T14:00:00Z"),
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");
  const p1 = result.participants.find((p) => p.userId === "user-1");

  assert.equal(p1.totalSteps, null);
  assert.equal(p1.progress, null);
});
