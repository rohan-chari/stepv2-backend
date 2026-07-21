const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildUsePowerup,
  PowerupUseError,
} = require("../../src/commands/usePowerup");

// ---------------------------------------------------------------------------
// POCKET WATCH (§6) — two modes on ONE endpoint.
//
//   * No `targetEffectId`  => LEGACY, bit-identical: extend EVERY active timed
//     SELF-BUFF on the user. Guarded here so the new mode can never leak into an
//     old client's request.
//   * With `targetEffectId` => extend EXACTLY ONE active timed harmful effect
//     that THIS user applied to a rival, from the §6.1 allowlist.
//
// Extension modifies an effect that already passed defenses, so it triggers
// neither Compression Socks nor a Mirror. All validation runs before coin
// deduction / consumption.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-20T12:00:00Z");
const HOUR = 60 * 60 * 1000;

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
  const effectUpdates = [];
  const coinDeductions = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice");
  const user2 = makeParticipant("rp-2", "user-2", "Bob");
  const participants = [user1, user2];
  const existingEffects = overrides.existingEffects || {};
  const effectsById = overrides.effectsById || {};

  return {
    events,
    feedEvents,
    effectUpdates,
    coinDeductions,
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
            type: "POCKET_WATCH",
            status: "HELD",
            rarity: "RARE",
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
        async findById(id) {
          return effectsById[id] || null;
        },
        async create(data) {
          return { id: "eff-new", ...data };
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
      PowerupUpgradeEvent: {
        async create() {},
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
      deductCoinsAtomic: async (args) => {
        coinDeductions.push(args);
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

function selfBuff(id, type, hoursLeft) {
  return {
    id,
    type,
    status: "ACTIVE",
    sourceUserId: "user-1",
    targetUserId: "user-1",
    targetParticipantId: "rp-1",
    raceId: "race-1",
    startsAt: NOW,
    expiresAt: new Date(NOW.getTime() + hoursLeft * HOUR),
  };
}

function myDebuffOnRival(id, type, hoursLeft, overrides = {}) {
  return {
    id,
    type,
    status: "ACTIVE",
    sourceUserId: "user-1",
    targetUserId: "user-2",
    targetParticipantId: "rp-2",
    raceId: "race-1",
    startsAt: NOW,
    expiresAt: new Date(NOW.getTime() + hoursLeft * HOUR),
    ...overrides,
  };
}

// ── Legacy mode (unchanged) ────────────────────────────────────────────────

test("POCKET_WATCH with NO targetEffectId extends every timed self-buff (legacy, unchanged)", async () => {
  const ctx = makeDeps({
    existingEffects: {
      "rp-1": [
        selfBuff("b1", "RUNNERS_HIGH", 1),
        selfBuff("b2", "COMPRESSION_SOCKS", 2),
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });

  assert.equal(result.extendedEffects, 2);
  assert.equal(result.extensionMs, HOUR);
  assert.equal(
    result.extensionMode,
    undefined,
    "legacy responses gain no new discriminator"
  );
  assert.equal(ctx.effectUpdates.length, 2);
});

test("POCKET_WATCH with NO targetEffectId still rejects when the user has no self-buff", async () => {
  const ctx = makeDeps({
    existingEffects: {
      // Only an OPPONENT's debuff on the user — never legacy-extendable.
      "rp-1": [
        {
          id: "d1",
          type: "LEG_CRAMP",
          status: "ACTIVE",
          sourceUserId: "user-2",
          targetUserId: "user-1",
          expiresAt: new Date(NOW.getTime() + HOUR),
        },
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () => use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" }),
    (err) => err instanceof PowerupUseError
  );
  assert.equal(ctx.updatedPowerup, null);
});

// ── Targeted mode ──────────────────────────────────────────────────────────

test("POCKET_WATCH targeted mode extends EXACTLY ONE owned debuff and returns the OWN_DEBUFF envelope", async () => {
  const cramp = myDebuffOnRival("d1", "LEG_CRAMP", 1);
  const ctx = makeDeps({
    effectsById: { d1: cramp, d2: myDebuffOnRival("d2", "WRONG_TURN", 1) },
    existingEffects: { "rp-1": [selfBuff("b1", "RUNNERS_HIGH", 1)] },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetEffectId: "d1",
    upgradeLevel: 1,
  });

  assert.equal(result.extendedEffects, 1);
  assert.equal(result.extensionMs, 1.5 * HOUR);
  assert.equal(result.extensionMode, "OWN_DEBUFF");
  assert.deepEqual(
    {
      id: result.extendedEffect.id,
      type: result.extendedEffect.type,
      targetUserId: result.extendedEffect.targetUserId,
    },
    { id: "d1", type: "LEG_CRAMP", targetUserId: "user-2" }
  );
  assert.equal(
    new Date(result.extendedEffect.expiresAt).getTime(),
    cramp.expiresAt.getTime() + 1.5 * HOUR,
    "the tier duration is added to the effect's CURRENT expiresAt"
  );
  assert.equal(ctx.effectUpdates.length, 1, "exactly one effect extended");
  assert.equal(ctx.effectUpdates[0].id, "d1");
  assert.equal(ctx.updatedPowerup.status, "USED");
});

test("POCKET_WATCH targeted mode extends each tier by its own duration", async () => {
  const tiers = [
    [0, 1 * HOUR],
    [1, 1.5 * HOUR],
    [2, 2 * HOUR],
    [3, 3 * HOUR],
  ];
  for (const [level, expected] of tiers) {
    const ctx = makeDeps({ effectsById: { d1: myDebuffOnRival("d1", "LEG_CRAMP", 1) } });
    const use = buildUsePowerup(ctx.deps);
    const result = await use({
      userId: "user-1",
      raceId: "race-1",
      powerupId: "pw-1",
      targetEffectId: "d1",
      upgradeLevel: level,
    });
    assert.equal(result.extensionMs, expected, `tier ${level}`);
  }
});

test("POCKET_WATCH targeted mode bypasses Compression Socks and Mirror on the rival", async () => {
  const ctx = makeDeps({
    effectsById: { d1: myDebuffOnRival("d1", "LEG_CRAMP", 1) },
    existingEffects: {
      "rp-2": [
        { id: "shield-1", type: "COMPRESSION_SOCKS" },
        { id: "mirror-1", type: "MIRROR" },
      ],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetEffectId: "d1",
  });

  assert.notEqual(result.blocked, true);
  assert.notEqual(result.reflected, true);
  assert.equal(result.extendedEffects, 1);
  assert.ok(
    !ctx.effectUpdates.find(
      (u) => u.id === "shield-1" || u.id === "mirror-1"
    ),
    "neither defense is consumed"
  );
});

test("POCKET_WATCH targeted mode rejects an effect the user did not apply (403 EFFECT_NOT_OWNED)", async () => {
  const ctx = makeDeps({
    effectsById: {
      d1: myDebuffOnRival("d1", "LEG_CRAMP", 1, { sourceUserId: "user-2" }),
    },
  });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetEffectId: "d1",
      }),
    (err) =>
      err instanceof PowerupUseError &&
      err.statusCode === 403 &&
      err.code === "EFFECT_NOT_OWNED"
  );
  assert.equal(ctx.effectUpdates.length, 0);
  assert.equal(ctx.updatedPowerup, null, "nothing consumed");
});

test("POCKET_WATCH targeted mode rejects missing / expired / untimed / wrong-race / ineligible effects (400 INVALID_EFFECT)", async () => {
  const cases = {
    missing: null,
    lapsed: myDebuffOnRival("d1", "LEG_CRAMP", -1),
    inactive: myDebuffOnRival("d1", "LEG_CRAMP", 1, { status: "EXPIRED" }),
    untimed: myDebuffOnRival("d1", "TRAIL_MINE", 1, { expiresAt: null }),
    otherRace: myDebuffOnRival("d1", "LEG_CRAMP", 1, { raceId: "race-2" }),
    // Hitchhike is explicitly NOT Pocket-Watch-extendable (§2 non-goal).
    hitchhike: myDebuffOnRival("d1", "HITCHHIKE", 1),
    // A self-buff is never valid in TARGETED mode.
    selfBuff: selfBuff("d1", "RUNNERS_HIGH", 1),
  };

  for (const [name, effect] of Object.entries(cases)) {
    const ctx = makeDeps({ effectsById: effect ? { d1: effect } : {} });
    const use = buildUsePowerup(ctx.deps);
    await assert.rejects(
      () =>
        use({
          userId: "user-1",
          raceId: "race-1",
          powerupId: "pw-1",
          targetEffectId: "d1",
        }),
      (err) =>
        err instanceof PowerupUseError &&
        err.statusCode === 400 &&
        err.code === "INVALID_EFFECT",
      `case: ${name}`
    );
    assert.equal(ctx.effectUpdates.length, 0, `case: ${name}`);
    assert.equal(ctx.updatedPowerup, null, `case: ${name} — nothing consumed`);
    assert.equal(ctx.coinDeductions.length, 0, `case: ${name} — no coins spent`);
  }
});

test("POCKET_WATCH targeted mode accepts every allowlisted harmful type", async () => {
  for (const type of [
    "LEG_CRAMP",
    "WRONG_TURN",
    "DETOUR_SIGN",
    "SIGNAL_JAMMER",
    "LEECH",
    "RAINSTORM",
  ]) {
    const ctx = makeDeps({ effectsById: { d1: myDebuffOnRival("d1", type, 1) } });
    const use = buildUsePowerup(ctx.deps);
    const result = await use({
      userId: "user-1",
      raceId: "race-1",
      powerupId: "pw-1",
      targetEffectId: "d1",
    });
    assert.equal(result.extendedEffects, 1, type);
    assert.equal(
      ctx.effectUpdates.length,
      1,
      `${type}: RAINSTORM extends exactly ONE rival's row, like every other type`
    );
  }
});

test("POCKET_WATCH targeted mode validates BEFORE deducting upgrade coins", async () => {
  const ctx = makeDeps({ effectsById: {} });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetEffectId: "nope",
        upgradeLevel: 3,
      }),
    (err) => err instanceof PowerupUseError && err.code === "INVALID_EFFECT"
  );
  assert.equal(ctx.coinDeductions.length, 0);
});
