const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildUsePowerup,
  PowerupUseError,
} = require("../../src/modules/powerups/commands/usePowerup");

// ---------------------------------------------------------------------------
// QUICK RINSE (§8) — store-only, SELF-ONLY, instantaneous. It HALVES the
// remaining duration of every active TIMED opponent-inflicted effect on the
// user:  newExpiresAt = now + floor((oldExpiresAt - now) / 2)
//
// It excludes self-buffs (sourceUserId === targetUserId) and untimed effects
// (expiresAt == null). With nothing eligible it rejects with 409
// NO_TIMED_DEBUFFS and does NOT consume the item. Signal Jammer blocks it just
// like every other powerup including Cleanse (§8.1 — deliberately NOT bypassed).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-20T12:00:00Z");
const MIN = 60 * 1000;

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

  const user1 = makeParticipant("rp-1", "user-1", "Alice");
  const user2 = makeParticipant("rp-2", "user-2", "Bob");
  const participants = [user1, user2];
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
            userId: "user-1",
            raceId: "race-1",
            type: "QUICK_RINSE",
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
        // Backs the once-an-hour-per-race cooldown. `lastRinseAt` is the
        // POWERUP_USED event this user's previous rinse in THIS race wrote.
        // Backs the once-an-hour-per-race cooldown. A stored rinse answers only
        // for the (race, user, type) it belongs to, exactly like the real query.
        async findLastPowerupUseAt({ raceId, actorUserId, powerupType }) {
          if (!overrides.lastRinseAt) return null;
          if (raceId !== (overrides.lastRinseRaceId || "race-1")) return null;
          if (actorUserId !== "user-1" || powerupType !== "QUICK_RINSE") return null;
          return overrides.lastRinseAt;
        },
      },
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            isTeamRace: false,
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

function debuff(id, type, minutesLeft, overrides = {}) {
  return {
    id,
    type,
    status: "ACTIVE",
    sourceUserId: "user-2",
    targetUserId: "user-1",
    startsAt: new Date(NOW.getTime() - 10 * MIN),
    expiresAt: new Date(NOW.getTime() + minutesLeft * MIN),
    ...overrides,
  };
}

test("QUICK_RINSE rejects a target (self-only)", async () => {
  const ctx = makeDeps({
    existingEffects: { "rp-1": [debuff("d1", "LEG_CRAMP", 60)] },
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
});

test("QUICK_RINSE halves the remaining duration of every eligible timed debuff", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-1": [
        debuff("d1", "LEG_CRAMP", 60),
        debuff("d2", "WRONG_TURN", 31),
        // Self-buff — must NEVER be touched.
        debuff("b1", "RUNNERS_HIGH", 90, { sourceUserId: "user-1" }),
        // Untimed opponent effect — excluded (no expiry to halve).
        debuff("u1", "TRAIL_MINE", 0, { expiresAt: null }),
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });

  assert.equal(result.shortened, 2);
  assert.equal(result.reductionFraction, 0.5);
  assert.equal(result.affectedEffects.length, 2);

  const byId = Object.fromEntries(ctx.effectUpdates.map((u) => [u.id, u]));
  assert.equal(
    new Date(byId.d1.expiresAt).getTime(),
    NOW.getTime() + 30 * MIN,
    "60 min remaining -> 30"
  );
  assert.equal(
    new Date(byId.d2.expiresAt).getTime(),
    NOW.getTime() + Math.floor((31 * MIN) / 2),
    "floors the halved remainder"
  );
  assert.ok(!byId.b1, "self-buff untouched");
  assert.ok(!byId.u1, "untimed effect untouched");
  assert.ok(
    ctx.effectUpdates.every((u) => u.status === undefined),
    "shortened rows stay ACTIVE; normal expiry processing ends them"
  );
  assert.equal(ctx.updatedPowerup.status, "USED");

  const response = Object.fromEntries(
    result.affectedEffects.map((e) => [e.id, e])
  );
  assert.equal(response.d1.type, "LEG_CRAMP");
  assert.equal(
    new Date(response.d1.expiresAt).getTime(),
    NOW.getTime() + 30 * MIN
  );
});

// ---------------------------------------------------------------------------
// Cooldown (owner decision 2026-08-17): ONE rinse per user per race per hour.
// Derived from the POWERUP_USED feed event, which every successful rinse writes
// — including rinses from app versions that predate the rule.
// ---------------------------------------------------------------------------

test("QUICK_RINSE is rejected 409 QUICK_RINSE_COOLDOWN within an hour of the last rinse", async () => {
  const ctx = makeDeps({
    lastRinseAt: new Date(NOW.getTime() - 48 * MIN),
    existingEffects: { "rp-1": [debuff("d1", "LEG_CRAMP", 60)] },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) =>
      err instanceof PowerupUseError &&
      err.statusCode === 409 &&
      err.code === "QUICK_RINSE_COOLDOWN" &&
      // Transient guard: a REDEEMED item stays in the race rather than being
      // refunded to the general inventory.
      err.retainHeld === true &&
      /12 minutes/.test(err.message)
  );
  assert.equal(ctx.effectUpdates.length, 0, "nothing halved");
  assert.equal(ctx.updatedPowerup, null, "item retained");
  assert.equal(ctx.feedEvents.length, 0, "no feed event for a rejected use");
});

test("QUICK_RINSE cooldown is reported ahead of NO_TIMED_DEBUFFS", async () => {
  // On cooldown AND holding nothing rinsable: "wait" is the actionable message.
  const ctx = makeDeps({
    lastRinseAt: new Date(NOW.getTime() - 1 * MIN),
    existingEffects: { "rp-1": [] },
  });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => err.code === "QUICK_RINSE_COOLDOWN"
  );
});

test("QUICK_RINSE is usable again once the hour has elapsed", async () => {
  const ctx = makeDeps({
    lastRinseAt: new Date(NOW.getTime() - 60 * MIN),
    existingEffects: { "rp-1": [debuff("d1", "LEG_CRAMP", 60)] },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });
  assert.equal(result.shortened, 1);
  assert.equal(
    result.nextAvailableAt,
    new Date(NOW.getTime() + 60 * MIN).toISOString(),
    "the response advertises when the next rinse unlocks"
  );
  assert.equal(ctx.updatedPowerup.status, "USED");
});

test("QUICK_RINSE cooldown is per race — a rinse in another race does not gate this one", async () => {
  const ctx = makeDeps({
    lastRinseAt: new Date(NOW.getTime() - 5 * MIN),
    lastRinseRaceId: "race-other",
    existingEffects: { "rp-1": [debuff("d1", "LEG_CRAMP", 60)] },
  });
  const seen = [];
  const inner = ctx.deps.RacePowerupEvent.findLastPowerupUseAt;
  ctx.deps.RacePowerupEvent.findLastPowerupUseAt = async (args) => {
    seen.push(args);
    return inner(args);
  };
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });
  assert.equal(result.shortened, 1);
  assert.deepEqual(
    seen,
    [{ raceId: "race-1", actorUserId: "user-1", powerupType: "QUICK_RINSE" }],
    "the cooldown lookup is scoped to this race, this user, this type"
  );
});

test("QUICK_RINSE halves an active HITCHHIKE link too", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-1": [debuff("hh", "HITCHHIKE", 40)],
    },
  });
  const use = buildUsePowerup(ctx.deps);
  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });
  assert.equal(result.shortened, 1);
  const update = ctx.effectUpdates.find((u) => u.id === "hh");
  assert.equal(
    new Date(update.expiresAt).getTime(),
    NOW.getTime() + 20 * MIN,
    "the halved expiry is always > now, so already-credited copies are never clawed back"
  );
});

test("QUICK_RINSE returns 409 NO_TIMED_DEBUFFS without consuming inventory", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-1": [
        debuff("b1", "RUNNERS_HIGH", 90, { sourceUserId: "user-1" }),
        debuff("u1", "TRAIL_MINE", 0, { expiresAt: null }),
        // Already lapsed — nothing left to halve.
        debuff("x1", "LEG_CRAMP", -5),
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) =>
      err instanceof PowerupUseError &&
      err.statusCode === 409 &&
      err.code === "NO_TIMED_DEBUFFS"
  );
  assert.equal(ctx.effectUpdates.length, 0);
  assert.equal(ctx.updatedPowerup, null, "item retained");
});

test("QUICK_RINSE is BLOCKED while the user is jammed (inherits Cleanse behavior — no bypass)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-1": [
        {
          id: "jam-1",
          type: "SIGNAL_JAMMER",
          status: "ACTIVE",
          sourceUserId: "user-2",
          targetUserId: "user-1",
          expiresAt: new Date(NOW.getTime() + 30 * MIN),
        },
        debuff("d1", "LEG_CRAMP", 60),
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => err instanceof PowerupUseError && err.statusCode === 409
  );
  assert.equal(ctx.effectUpdates.length, 0, "nothing halved");
  assert.equal(ctx.updatedPowerup, null, "item retained");
});
