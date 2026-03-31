const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup, PowerupUseError } = require("../../src/commands/usePowerup");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Wrong Turn — targeted, offensive, reverses target's steps for 1 hour
// Every step walked during the effect gets subtracted instead of added.
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
  const effectUpdates = [];
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
    effectUpdates,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: overrides.powerupOwner || "user-1",
            raceId: "race-1",
            type: "WRONG_TURN",
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
            if (overrides.shieldHolder && overrides.shieldHolder !== participantId) return null;
            return overrides.existingShield;
          }
          if (type === "WRONG_TURN" && overrides.existingWrongTurn) {
            return overrides.existingWrongTurn;
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
// Basic usage — creating the effect
// ===========================================================================

test("Wrong Turn creates an active effect on the target", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, false);
  assert.ok(result.effect);
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "WRONG_TURN");
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-2");
  assert.equal(ctx.effectsCreated[0].sourceUserId, "user-1");
});

test("Wrong Turn effect lasts exactly 1 hour", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  const effect = ctx.effectsCreated[0];
  const startsAt = new Date(effect.startsAt).getTime();
  const expiresAt = new Date(effect.expiresAt).getTime();
  const oneHourMs = 1 * 60 * 60 * 1000;

  assert.equal(expiresAt - startsAt, oneHourMs);
});

test("Wrong Turn does not directly modify step counts", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.bonusChanges.length, 0);
});

// ===========================================================================
// Powerup status after use
// ===========================================================================

test("Wrong Turn marks powerup as USED after use", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.ok(ctx.updatedPowerup.usedAt);
});

// ===========================================================================
// Events
// ===========================================================================

test("Wrong Turn emits POWERUP_USED event with correct payload", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_USED");
  assert.equal(ctx.events[0].payload.powerupType, "WRONG_TURN");
  assert.equal(ctx.events[0].payload.userId, "user-1");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
  assert.equal(ctx.events[0].payload.targetUserId, "user-2");
});

test("Wrong Turn creates a feed event", async () => {
  const ctx = makePowerupDeps();
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_USED");
  assert.equal(ctx.feedEvents[0].powerupType, "WRONG_TURN");
  assert.equal(ctx.feedEvents[0].targetUserId, "user-2");
});

// ===========================================================================
// Compression Socks blocks Wrong Turn
// ===========================================================================

test("Wrong Turn is blocked by Compression Socks", async () => {
  const ctx = makePowerupDeps({
    existingShield: { id: "eff-shield", type: "COMPRESSION_SOCKS", status: "ACTIVE" },
    shieldHolder: "rp-2",
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, "COMPRESSION_SOCKS");
  assert.equal(ctx.effectsCreated.length, 0);
});

// ===========================================================================
// Stacking — reject if target already has active Wrong Turn
// ===========================================================================

test("Wrong Turn rejects if target already has an active Wrong Turn", async () => {
  const ctx = makePowerupDeps({
    existingWrongTurn: {
      id: "eff-existing",
      type: "WRONG_TURN",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T11:30:00Z"),
      expiresAt: new Date("2026-03-30T12:30:00Z"),
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

test("Wrong Turn powerup stays HELD when rejected due to existing Wrong Turn on target", async () => {
  const ctx = makePowerupDeps({
    existingWrongTurn: {
      id: "eff-existing",
      type: "WRONG_TURN",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T11:30:00Z"),
      expiresAt: new Date("2026-03-30T12:30:00Z"),
    },
  });
  const use = buildUsePowerup(ctx.deps);

  try {
    await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });
  } catch {
    // expected
  }

  assert.equal(ctx.updatedPowerup, null);
});

// ===========================================================================
// Replaces active Leg Cramp
// ===========================================================================

test("Wrong Turn cancels an active Leg Cramp on the target", async () => {
  const ctx = makePowerupDeps({
    existingLegCramp: {
      id: "eff-cramp",
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T11:00:00Z"),
      expiresAt: new Date("2026-03-30T13:00:00Z"),
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  // Leg Cramp should be expired/cancelled
  const crampUpdate = ctx.effectUpdates.find((u) => u.id === "eff-cramp");
  assert.ok(crampUpdate, "Leg Cramp should be updated");
  assert.equal(crampUpdate.status, "EXPIRED");

  // Wrong Turn should be created
  assert.equal(ctx.effectsCreated.length, 1);
  assert.equal(ctx.effectsCreated[0].type, "WRONG_TURN");
});

test("Wrong Turn replaces Leg Cramp — Leg Cramp does not resume after Wrong Turn expires", async () => {
  // This is implicit in the cancellation — Leg Cramp status is EXPIRED, not paused
  const ctx = makePowerupDeps({
    existingLegCramp: {
      id: "eff-cramp",
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: new Date("2026-03-30T11:00:00Z"),
      expiresAt: new Date("2026-03-30T13:00:00Z"),
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", targetUserId: "user-2" });

  const crampUpdate = ctx.effectUpdates.find((u) => u.id === "eff-cramp");
  // Should be permanently expired, not a temporary status
  assert.equal(crampUpdate.status, "EXPIRED");
});

// ===========================================================================
// Targeting validation
// ===========================================================================

test("Wrong Turn requires a targetUserId", async () => {
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

test("Wrong Turn cannot target yourself", async () => {
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

test("Wrong Turn rejects targeting a user not in the race", async () => {
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

test("Wrong Turn rejects targeting a finished participant", async () => {
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

test("Wrong Turn rejects if attacker has already finished", async () => {
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

test("Wrong Turn rejects targeting a DECLINED participant", async () => {
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

test("Wrong Turn rejects targeting an INVITED participant", async () => {
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

test("Wrong Turn rejects if powerup is USED", async () => {
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

test("Wrong Turn rejects if powerup is DISCARDED", async () => {
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

test("Wrong Turn rejects if powerup is EXPIRED", async () => {
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

test("Wrong Turn rejects if race is COMPLETED", async () => {
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

test("Wrong Turn rejects if race is PENDING", async () => {
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

test("Wrong Turn rejects if race is CANCELLED", async () => {
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

test("Wrong Turn rejects if used by someone who doesn't own it", async () => {
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
// Step calculation during Wrong Turn — via getRaceProgress
// ===========================================================================
//
// Steps walked during Wrong Turn are subtracted (reversed).
//
// Timeline:
//   Race start:       2026-03-30T08:00:00Z
//   Wrong Turn start: 2026-03-30T12:00:00Z
//   Wrong Turn end:   2026-03-30T13:00:00Z
//   "now":            2026-03-30T15:00:00Z
// ===========================================================================

const RACE_START = new Date("2026-03-30T08:00:00Z");
const WT_START = new Date("2026-03-30T12:00:00Z");
const WT_END = new Date("2026-03-30T13:00:00Z");
const NOW = new Date("2026-03-30T15:00:00Z");

function makeProgressDeps(overrides = {}) {
  const finishCalls = [];
  const completeCalls = [];

  const legCramps = overrides.legCramps || [];
  const runnersHighs = overrides.runnersHighs || [];
  const wrongTurns = overrides.wrongTurns || [];

  const participants = overrides.participants || [
    makeParticipant("rp-1", "user-1", "Alice", {
      joinedAt: RACE_START,
      baselineSteps: 0,
      bonusSteps: overrides.bonusSteps || 0,
      finishedAt: null,
      nextBoxAtSteps: 50000,
    }),
  ];

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
        async sumStepsInWindow(userId, start, end) {
          if (overrides.sumStepsInWindow) {
            return overrides.sumStepsInWindow(userId, start, end);
          }
          return 0;
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
          if (type === "WRONG_TURN") return wrongTurns.filter((e) => !e.targetParticipantId || e.targetParticipantId === participantId);
          return [];
        },
        async findActiveForParticipant() { return []; },
        async findActiveForRace() { return []; },
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

test("Steps walked during Wrong Turn are subtracted (reversed)", async () => {
  // 10000 total steps, 2000 during Wrong Turn
  // Expected: 10000 - 2000 (frozen) - 2000 (reversed) = 6000
  // Or equivalently: steps outside WT count normally, steps during WT count as negative
  // Before WT: 8000, during WT: 2000 reversed = -2000, after: 0
  // Total: 8000 - 2000 = 6000
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 10000;
      if (s === WT_START.getTime() && e === WT_END.getTime()) return 2000;
      return 0;
    },
    wrongTurns: [{
      id: "eff-1",
      type: "WRONG_TURN",
      status: "EXPIRED",
      startsAt: WT_START,
      expiresAt: WT_END,
      metadata: {},
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 10000 raw - 2*2000 reversed = 6000
  assert.equal(p.totalSteps, 6000);
});

test("Steps before Wrong Turn are counted normally", async () => {
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 5000;
      if (s === WT_START.getTime() && e === WT_END.getTime()) return 0;
      return 0;
    },
    wrongTurns: [{
      id: "eff-1",
      type: "WRONG_TURN",
      status: "EXPIRED",
      startsAt: WT_START,
      expiresAt: WT_END,
      metadata: {},
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  assert.equal(p.totalSteps, 5000);
});

test("Steps after Wrong Turn expires are counted normally", async () => {
  // 12000 total: 8000 before, 1000 during (reversed), 3000 after
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 12000;
      if (s === WT_START.getTime() && e === WT_END.getTime()) return 1000;
      return 0;
    },
    wrongTurns: [{
      id: "eff-1",
      type: "WRONG_TURN",
      status: "EXPIRED",
      startsAt: WT_START,
      expiresAt: WT_END,
      metadata: {},
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 12000 - 2*1000 = 10000
  assert.equal(p.totalSteps, 10000);
});

test("Wrong Turn total is clamped at 0 (does not go negative)", async () => {
  // 3000 total, 2000 during Wrong Turn → 3000 - 4000 = -1000 → clamp to 0
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 3000;
      if (s === WT_START.getTime() && e === WT_END.getTime()) return 2000;
      return 0;
    },
    wrongTurns: [{
      id: "eff-1",
      type: "WRONG_TURN",
      status: "EXPIRED",
      startsAt: WT_START,
      expiresAt: WT_END,
      metadata: {},
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  assert.ok(p.totalSteps >= 0, "total steps must not be negative");
  assert.equal(p.totalSteps, 0);
});

// ===========================================================================
// Interaction with Runner's High — doubled AND negated
// ===========================================================================

test("Wrong Turn + Runner's High: steps are doubled and negated", async () => {
  // Runner's High: 11:00 - 14:00
  // Wrong Turn:    12:00 - 13:00
  // Overlap:       12:00 - 13:00
  //
  // Steps:
  //   08:00-11:00: 4000 (no effects)
  //   11:00-12:00: 2000 (Runner's High only — doubled)
  //   12:00-13:00: 1000 (both active — doubled AND negated = -2000)
  //   13:00-14:00: 1500 (Runner's High only — doubled)
  //   14:00-15:00: 1000 (no effects)
  // Total raw: 9500
  //
  // Runner's High window (11:00-14:00): 4500 steps → buffed = 4500
  // Wrong Turn window (12:00-13:00): 1000 steps → reversed = 2*1000 = 2000
  // Overlap (12:00-13:00): 1000 steps — these are in both windows
  //   Already counted as buffed (+1000) but should be negated doubled (-2000)
  //   Net adjustment for overlap: subtract the buff (1000) and subtract doubled (2000) = -3000 from overlap
  //
  // Expected: 9500 + 4500 (buff) - 2000 (wrong turn) - 2*1000 (overlap: remove buff + add negate)
  // Simpler: raw - 2*wrongTurnSteps + buffedSteps - 2*overlapSteps
  // = 9500 - 2000 + 4500 - 2*1000 (overlap already in buff, needs to be removed AND negated)
  //
  // Let me think about this differently:
  // Non-overlap buff (11-12, 13-14): 3500 steps doubled = +3500
  // Overlap (12-13): 1000 steps doubled AND negated = -2000
  // Wrong turn non-overlap: 0 (the whole WT window is within RH)
  // = 9500 + 3500 - 2000 = 11000? No...
  //
  // Actually: each step during overlap counts as -2 (doubled negated)
  // Each step during RH-only counts as +2 (doubled)
  // Each normal step counts as +1
  //
  // 4000 normal + 2000*2 RH-only + 1000*(-2) overlap + 1500*2 RH-only + 1000 normal
  // = 4000 + 4000 - 2000 + 3000 + 1000 = 10000

  const RH_START = new Date("2026-03-30T11:00:00Z");
  const RH_END = new Date("2026-03-30T14:00:00Z");

  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      const e = end.getTime();
      if (s === RACE_START.getTime()) return 9500;
      // Runner's High window
      if (s === RH_START.getTime() && e === RH_END.getTime()) return 4500;
      // Wrong Turn window
      if (s === WT_START.getTime() && e === WT_END.getTime()) return 1000;
      // Overlap (RH start to WT end, or WT start to RH end — overlap is 12:00-13:00)
      if (s === WT_START.getTime() && e === WT_END.getTime()) return 1000;
      return 0;
    },
    runnersHighs: [{
      id: "eff-rh",
      type: "RUNNERS_HIGH",
      status: "EXPIRED",
      startsAt: RH_START,
      expiresAt: RH_END,
      metadata: { stepsAtBuffStart: 4000 },
    }],
    wrongTurns: [{
      id: "eff-wt",
      type: "WRONG_TURN",
      status: "EXPIRED",
      startsAt: WT_START,
      expiresAt: WT_END,
      metadata: {},
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // Steps during overlap (1000) should be doubled AND negated = -2000 net effect
  // Non-overlap RH steps (3500) doubled = +3500
  // Normal steps (5000) = +5000
  // Total = 5000 + 3500 - 2000 + ... this is complex
  // Simplest check: result should be 10000
  assert.equal(p.totalSteps, 10000);
});

// ===========================================================================
// Active Wrong Turn (not yet expired)
// ===========================================================================

test("Active Wrong Turn reverses steps walked so far during it", async () => {
  const midWTNow = new Date("2026-03-30T12:30:00Z");

  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      if (s === RACE_START.getTime()) return 8000;
      if (s === WT_START.getTime()) return 500;
      return 0;
    },
    wrongTurns: [{
      id: "eff-1",
      type: "WRONG_TURN",
      status: "ACTIVE",
      startsAt: WT_START,
      expiresAt: WT_END,
      metadata: {},
    }],
  });
  ctx.deps.now = () => midWTNow;

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  // 8000 - 2*500 = 7000
  assert.equal(p.totalSteps, 7000);
});

// ===========================================================================
// Wrong Turn with 0 steps during effect
// ===========================================================================

test("Wrong Turn with 0 steps during effect has no impact", async () => {
  const ctx = makeProgressDeps({
    sumStepsInWindow(userId, start, end) {
      const s = start.getTime();
      if (s === RACE_START.getTime()) return 8000;
      if (s === WT_START.getTime()) return 0;
      return 0;
    },
    wrongTurns: [{
      id: "eff-1",
      type: "WRONG_TURN",
      status: "EXPIRED",
      startsAt: WT_START,
      expiresAt: WT_END,
      metadata: {},
    }],
  });

  const result = await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");
  const p = result.participants.find((p) => p.userId === "user-1");

  assert.equal(p.totalSteps, 8000);
});
