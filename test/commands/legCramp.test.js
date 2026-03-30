const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Leg Cramp — targeted, offensive, freezes target's steps for 2 hours
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    finishedAt: null,
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
  const user3 = makeParticipant("rp-3", "user-3", "Carol", { totalSteps: 8000, ...overrides.user3 });
  const participants = [user1, user2, user3];

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
            type: "LEG_CRAMP",
            status: overrides.powerupStatus || "HELD",
            rarity: "UNCOMMON",
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
          if (type === "COMPRESSION_SOCKS" && overrides.existingShield) {
            return overrides.existingShield;
          }
          if (type === "LEG_CRAMP" && overrides.existingLegCramp) {
            return overrides.existingLegCramp;
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
// Basic usage — applying Leg Cramp
// ===========================================================================

test("Leg Cramp creates an active effect on the target", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, false);
  assert.ok(result.effect);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "LEG_CRAMP");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-2");
  assert.equal(ctx.effectsCreated[0].sourceUserId, "user-1");
});

test("Leg Cramp effect lasts exactly 2 hours", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  const effect = ctx.effectsCreated[0];
  const startsAt = new Date(effect.startsAt).getTime();
  const expiresAt = new Date(effect.expiresAt).getTime();
  const twoHoursMs = 2 * 60 * 60 * 1000;

  assert.equal(expiresAt - startsAt, twoHoursMs);
});

test("Leg Cramp captures stepsAtFreezeStart in metadata", async () => {
  const ctx = makePowerupDeps({ user2: { totalSteps: 5000 } });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.effectsCreated[0].metadata.stepsAtFreezeStart, 5000);
});

test("Leg Cramp captures stepsAtFreezeStart of 0 when target has no steps", async () => {
  const ctx = makePowerupDeps({ user2: { totalSteps: 0 } });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.effectsCreated[0].metadata.stepsAtFreezeStart, 0);
});

test("Leg Cramp does not modify any step counts directly", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.bonusChanges.length, 0);
});

// ===========================================================================
// Powerup status after use
// ===========================================================================

test("Leg Cramp marks powerup as USED after use", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

// ===========================================================================
// Events
// ===========================================================================

test("Leg Cramp emits POWERUP_USED event with correct payload", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "LEG_CRAMP");
  assert.equal(ctx.events[0].payload.userId, "user-1");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
  assert.equal(ctx.events[0].payload.targetUserId, "user-2");
});

test("Leg Cramp creates a feed event", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "LEG_CRAMP");
  assert.equal(ctx.feedEvents[0].targetUserId, "user-2");
});

// ===========================================================================
// Compression Socks blocks Leg Cramp
// ===========================================================================

test("Leg Cramp is blocked by Compression Socks", async () => {
  const ctx = makePowerupDeps({
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.effectsCreated.length, 0, "no Leg Cramp effect should be created when blocked");
});

// ===========================================================================
// Stacking — Leg Cramp on someone who already has one
// ===========================================================================

test("Leg Cramp rejects if target already has an active Leg Cramp", async () => {
  const ctx = makePowerupDeps({
    existingLegCramp: {
      id: "eff-existing",
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T11:00:00Z"),
      expiresAt: new Date("2026-03-30T13:00:00Z"),
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Leg Cramp powerup stays HELD when rejected due to existing Leg Cramp on target", async () => {
  const ctx = makePowerupDeps({
    existingLegCramp: {
      id: "eff-existing",
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T11:00:00Z"),
      expiresAt: new Date("2026-03-30T13:00:00Z"),
    },
  });
  const use = buildUsePowerup(ctx.deps);

  try {
    await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });
  } catch {
    // expected
  }

  // Powerup should NOT have been updated to USED
  assert.equal(ctx.updatedPowerup, null);
});

// ===========================================================================
// Targeting validation
// ===========================================================================

test("Leg Cramp requires a targetUserId", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Leg Cramp cannot target yourself", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-1" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Leg Cramp rejects targeting a user not in the race", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-999" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Finished participants
// ===========================================================================

test("Leg Cramp rejects targeting a finished participant", async () => {
  const ctx = makePowerupDeps({
    user2: { finishedAt: new Date("2026-03-29T10:00:00Z") },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Leg Cramp rejects if attacker has already finished", async () => {
  const ctx = makePowerupDeps({
    user1: { finishedAt: new Date("2026-03-29T10:00:00Z") },
  });
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
// Participant status validation
// ===========================================================================

test("Leg Cramp rejects targeting a DECLINED participant", async () => {
  const ctx = makePowerupDeps({
    user2: { status: "DECLINED" },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Leg Cramp rejects targeting an INVITED participant", async () => {
  const ctx = makePowerupDeps({
    user2: { status: "INVITED" },
  });
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
// Powerup status validation
// ===========================================================================

test("Leg Cramp rejects if powerup is USED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "USED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Leg Cramp rejects if powerup is DISCARDED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "DISCARDED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Leg Cramp rejects if powerup is EXPIRED", async () => {
  const ctx = makePowerupDeps({ powerupStatus: "EXPIRED" });
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
// Race status validation
// ===========================================================================

test("Leg Cramp rejects if race is COMPLETED", async () => {
  const ctx = makePowerupDeps({ raceStatus: "COMPLETED" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Leg Cramp rejects if race is PENDING", async () => {
  const ctx = makePowerupDeps({ raceStatus: "PENDING" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

test("Leg Cramp rejects if race is CANCELLED", async () => {
  const ctx = makePowerupDeps({ raceStatus: "CANCELLED" });
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
// Ownership
// ===========================================================================

test("Leg Cramp rejects if used by someone who doesn't own it", async () => {
  const ctx = makePowerupDeps({ powerupOwner: "user-1" });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-2", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-3" }),
    (err) => {
      assert.ok(err instanceof PowerupUseError);
      return true;
    }
  );
});

// ===========================================================================
// Step sample handling during freeze — via getRaceProgress
// ===========================================================================
//
// Leg Cramp freezes steps for 2 hours. Steps walked during the freeze window
// should be subtracted from the total. Steps before/after should count normally.
//
// Timeline for these tests:
//   Race start:    2026-03-30T08:00:00Z
//   Freeze start:  2026-03-30T12:00:00Z
//   Freeze end:    2026-03-30T14:00:00Z
//   "now":         2026-03-30T16:00:00Z
// ===========================================================================

const RACE_START = new Date("2026-03-30T08:00:00Z");
const FREEZE_START = new Date("2026-03-30T12:00:00Z");
const FREEZE_END = new Date("2026-03-30T14:00:00Z");
const NOW = new Date("2026-03-30T16:00:00Z");

function makeProgressDeps(overrides = {}) {
  const finishCalls = [];
  const completeCalls = [];

  const legCramps = overrides.legCramps || [];
  const runnersHighs = overrides.runnersHighs || [];

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
            endsAt: new Date("2026-04-06T08:00:00Z"),
            powerupsEnabled: true,
            powerupStepInterval: 50000,
            participants: [
              makeParticipant("rp-1", "user-1", "Alice", {
                joinedAt: RACE_START,
                baselineSteps: 0,
                bonusSteps: overrides.bonusSteps || 0,
                finishedAt: overrides.finishedAt || null,
                nextBoxAtSteps: 50000,
              }),
              ...(overrides.extraParticipants || []),
            ],
          };
        },
      },
      StepSample: {
        async sumStepsInWindow(userId, start, end) {
          if (overrides.sumStepsInWindow) {
            return overrides.sumStepsInWindow(userId, start, end);
          }
          return overrides.totalSampleSteps || 0;
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
        async findEffectsForRaceByType(raceId, participantId, type) {
          if (type === "LEG_CRAMP") return legCramps.filter((e) => !e.targetParticipantId || e.targetParticipantId === participantId);
          if (type === "RUNNERS_HIGH") return runnersHighs.filter((e) => !e.targetParticipantId || e.targetParticipantId === participantId);
          return [];
        },
        async findActiveForParticipant() { return overrides.activeEffects || []; },
        async findActiveForRace() { return overrides.activeEffects || []; },
      },
      RacePowerup: {
        async findHeldByParticipant() { return []; },
      },
      expireEffects: async () => {},
      completeRace: async (data) => { completeCalls.push(data); },
      rollPowerup: async () => [],
      now: () => NOW,
    },
  };
}

test("Steps walked entirely before freeze are counted", async () => {
  // User walked 5000 steps total, all before the freeze
  // sumStepsInWindow for the freeze window returns 0 (no steps during freeze)
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      // Full race window query (start day)
      if (s === RACE_START.getTime()) return 5000;
      // Freeze window query — no steps during freeze
      if (s === FREEZE_START.getTime() && e === FREEZE_END.getTime()) return 0;
      return 0;
    },
    legCramps: [{
      id: "eff-1",
      type: "LEG_CRAMP",
      status: "EXPIRED",
      startsAt: FREEZE_START,
      expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 5000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // All 5000 steps should count — nothing frozen
  assert.equal(p.totalSteps, 5000);
});

test("Steps walked entirely during freeze are NOT counted", async () => {
  // User walked 8000 total, 3000 of which happened during the freeze window
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 8000;
      if (s === FREEZE_START.getTime() && e === FREEZE_END.getTime()) return 3000;
      return 0;
    },
    legCramps: [{
      id: "eff-1",
      type: "LEG_CRAMP",
      status: "EXPIRED",
      startsAt: FREEZE_START,
      expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 5000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 8000 total - 3000 frozen = 5000
  assert.equal(p.totalSteps, 5000);
});

test("Steps walked entirely after freeze expires are counted", async () => {
  // User walked 10000 total: 5000 before, 2000 during (frozen), 3000 after
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 10000;
      if (s === FREEZE_START.getTime() && e === FREEZE_END.getTime()) return 2000;
      return 0;
    },
    legCramps: [{
      id: "eff-1",
      type: "LEG_CRAMP",
      status: "EXPIRED",
      startsAt: FREEZE_START,
      expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 5000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 10000 - 2000 frozen = 8000
  assert.equal(p.totalSteps, 8000);
});

test("Steps spanning the freeze start boundary are excluded", async () => {
  // A sample that started before and ended during freeze — should be counted as frozen
  // sumStepsInWindow captures this because the freeze window overlaps with the sample
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 6000;
      // The freeze window captures 1500 steps (includes the boundary-spanning sample)
      if (s === FREEZE_START.getTime() && e === FREEZE_END.getTime()) return 1500;
      return 0;
    },
    legCramps: [{
      id: "eff-1",
      type: "LEG_CRAMP",
      status: "EXPIRED",
      startsAt: FREEZE_START,
      expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 4500 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 6000 - 1500 frozen = 4500
  assert.equal(p.totalSteps, 4500);
});

test("Steps spanning the freeze end boundary are included", async () => {
  // A sample that started during freeze but ended after — should NOT be frozen
  // The freeze window query should not capture steps after the freeze ends
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 7000;
      // Freeze window only captures 1000 (the portion within the freeze)
      // The 500 steps from the boundary-spanning sample that fell after freeze are NOT frozen
      if (s === FREEZE_START.getTime() && e === FREEZE_END.getTime()) return 1000;
      return 0;
    },
    legCramps: [{
      id: "eff-1",
      type: "LEG_CRAMP",
      status: "EXPIRED",
      startsAt: FREEZE_START,
      expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 5000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 7000 - 1000 frozen = 6000
  assert.equal(p.totalSteps, 6000);
});

test("Active Leg Cramp (not yet expired) freezes steps walked so far during it", async () => {
  // Freeze started at 12:00, it's now 13:00 (1hr in, 1hr remaining)
  // User walked 2000 steps during this first hour of freeze
  const midFreezeNow = new Date("2026-03-30T13:00:00Z");

  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      if (s === RACE_START.getTime()) return 7000;
      // Active effect: window is startsAt to expiresAt (or now)
      if (s === FREEZE_START.getTime()) return 2000;
      return 0;
    },
    legCramps: [{
      id: "eff-1",
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: FREEZE_START,
      expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 5000 },
    }],
  });
  ctx.deps.now = () => midFreezeNow;

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 7000 - 2000 frozen = 5000
  assert.equal(p.totalSteps, 5000);
});

// ===========================================================================
// Freeze does not make total negative
// ===========================================================================

test("Leg Cramp freeze does not make total steps negative", async () => {
  // Edge case: sample query might over-count due to rounding or overlap
  // Total should be clamped at 0
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      if (s === RACE_START.getTime()) return 1000;
      if (s === FREEZE_START.getTime()) return 1000;
      return 0;
    },
    legCramps: [{
      id: "eff-1",
      type: "LEG_CRAMP",
      status: "EXPIRED",
      startsAt: FREEZE_START,
      expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 0 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 1000 - 1000 = 0, not negative
  assert.ok(p.totalSteps >= 0, "total steps must not be negative");
  assert.equal(p.totalSteps, 0);
});

// ===========================================================================
// Leg Cramp vs Runner's High — Leg Cramp wins during overlap
// ===========================================================================

test("Leg Cramp suspends Runner's High during freeze, Runner's High resumes after", async () => {
  // Runner's High: 10:00 - 13:00 (3 hours)
  // Leg Cramp:     12:00 - 14:00 (2 hours)
  // Overlap:       12:00 - 13:00
  //
  // Steps timeline:
  //   08:00-10:00: 2000 steps (no effects)
  //   10:00-12:00: 3000 steps (Runner's High active, should be doubled)
  //   12:00-13:00: 1500 steps (both active, Leg Cramp wins — frozen, NOT doubled)
  //   13:00-14:00: 1000 steps (Leg Cramp only — frozen)
  //   14:00-16:00: 2000 steps (no effects)
  // Total raw: 9500
  // Frozen: 2500 (12:00-14:00)
  // Buffed: 3000 (10:00-12:00 only, overlap excluded)
  // Result: 9500 - 2500 + 3000 = 10000

  const RH_START = new Date("2026-03-30T10:00:00Z");
  const RH_END = new Date("2026-03-30T13:00:00Z");

  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      // Full race window
      if (s === RACE_START.getTime()) return 9500;
      // Leg Cramp window (12:00-14:00)
      if (s === FREEZE_START.getTime() && e === FREEZE_END.getTime()) return 2500;
      // Runner's High window (10:00-13:00)
      if (s === RH_START.getTime() && e === RH_END.getTime()) return 4500;
      // Overlap window (12:00-13:00)
      if (s === FREEZE_START.getTime() && e === RH_END.getTime()) return 1500;
      return 0;
    },
    legCramps: [{
      id: "eff-lc",
      type: "LEG_CRAMP",
      status: "EXPIRED",
      startsAt: FREEZE_START,
      expiresAt: FREEZE_END,
      metadata: { stepsAtFreezeStart: 5000 },
    }],
    runnersHighs: [{
      id: "eff-rh",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: RH_START,
      expiresAt: RH_END,
      metadata: { stepsAtBuffStart: 2000 },
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // If Leg Cramp wins during overlap:
  // frozen = 2500, buffed should exclude the overlap period
  // The overlap 1500 steps should be frozen, not doubled
  // Expected: 9500 - 2500 + (4500 - 1500) = 9500 - 2500 + 3000 = 10000
  //
  // If implementation doesn't handle overlap (just subtracts frozen and adds buffed independently):
  // 9500 - 2500 + 4500 = 11500 (wrong — double-counts overlap)
  assert.equal(p.totalSteps, 10000);
});

// ===========================================================================
// Leader position while frozen
// ===========================================================================

test("Frozen leader loses lead position when another participant passes them", async () => {
  // user-1 was leading with 10000, gets frozen, walks 3000 during freeze (not counted)
  // user-2 walks past them during the freeze
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      if (userId === "user-1") {
        if (s === RACE_START.getTime()) return 13000;
        if (s === FREEZE_START.getTime()) return 3000;
        return 0;
      }
      if (userId === "user-2") {
        if (s === RACE_START.getTime()) return 11000;
        return 0;
      }
      return 0;
    },
    legCramps: [{
      id: "eff-1",
      type: "LEG_CRAMP",
      status: "EXPIRED",
      startsAt: FREEZE_START,
      expiresAt: FREEZE_END,
      targetUserId: "user-1",
      targetParticipantId: "rp-1",
      metadata: { stepsAtFreezeStart: 10000 },
    }],
    extraParticipants: [
      makeParticipant("rp-2", "user-2", "Bob", {
        joinedAt: RACE_START,
        baselineSteps: 0,
        bonusSteps: 0,
        finishedAt: null,
        nextBoxAtSteps: 50000,
      }),
    ],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  const p1 = result.participants.find((p) => p.userId === "user-1");
  const p2 = result.participants.find((p) => p.userId === "user-2");

  // user-1: 13000 raw - 3000 frozen = 10000
  // user-2: 11000 raw, no effects = 11000
  // user-2 should be ahead
  assert.equal(p1.totalSteps, 10000);
  assert.equal(p2.totalSteps, 11000);
  assert.ok(p2.totalSteps > p1.totalSteps, "user-2 should be ahead of frozen user-1");
});
