const assert = require("node:assert/strict");
const test = require("node:test");
const { buildRollPowerup, DEFAULT_POWERUP_SLOTS } = require("../../src/commands/rollPowerup");

// ---------------------------------------------------------------------------
// General powerup tests — rules that apply to ALL powerup types
// ---------------------------------------------------------------------------

function makeDeps({ heldCount = 0 } = {}) {
  let held = heldCount;
  const powerups = [];
  const feedEvents = [];
  const events = [];
  let lastNextBoxAtSteps = null;

  return {
    powerups,
    feedEvents,
    events,
    get held() { return held; },
    get lastNextBoxAtSteps() { return lastNextBoxAtSteps; },
    deps: {
      RacePowerup: {
        async create(data) {
          const p = { id: `pw-${powerups.length + 1}`, ...data };
          powerups.push(p);
          held++;
          return p;
        },
        async countHeldByParticipant() {
          return held;
        },
      },
      RaceParticipant: {
        async updateNextBoxAtSteps(id, value) {
          lastNextBoxAtSteps = value;
        },
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: "fe-1", ...data };
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      rollPowerupOdds: () => ({ type: "PROTEIN_SHAKE", rarity: "COMMON" }),
    },
  };
}

function rollArgs(overrides = {}) {
  return {
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    position: 2,
    totalParticipants: 4,
    powerupStepInterval: 5000,
    displayName: "Alex",
    ...overrides,
  };
}

// ===========================================================================
// Inventory limit — max 3 HELD powerups
// ===========================================================================

test("DEFAULT_POWERUP_SLOTS is 3", () => {
  assert.equal(DEFAULT_POWERUP_SLOTS, 3);
});

test("user with 3 HELD powerups cannot earn another", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs());

  // No powerup should be created
  assert.equal(ctx.powerups.length, 0);
  // Result should signal inventory is full
  assert.equal(results.length, 1);
  assert.equal(results[0].inventoryFull, true);
  assert.equal(results[0].powerup, null);
});

test("user with 3 HELD powerups earns nothing even when crossing multiple thresholds", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const roll = buildRollPowerup(ctx.deps);

  // Crosses 5k, 10k, 15k — 3 thresholds
  const results = await roll(rollArgs({
    currentSteps: 16000,
    nextBoxAtSteps: 5000,
  }));

  // Zero powerups created despite 3 threshold crossings
  assert.equal(ctx.powerups.length, 0);
  // Every roll should report inventory full
  for (const r of results) {
    assert.equal(r.inventoryFull, true);
    assert.equal(r.powerup, null);
  }
});

test("threshold still advances when inventory is full", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const roll = buildRollPowerup(ctx.deps);

  await roll(rollArgs({
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
  }));

  // Next threshold should advance to 10k so user isn't stuck
  assert.equal(ctx.lastNextBoxAtSteps, 10000);
});

test("no feed event or bus event when inventory is full", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const roll = buildRollPowerup(ctx.deps);

  await roll(rollArgs());

  assert.equal(ctx.feedEvents.length, 0);
  assert.equal(ctx.events.length, 0);
});

test("user with 2 HELD powerups can earn exactly 1 more", async () => {
  const ctx = makeDeps({ heldCount: 2 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs());

  assert.equal(ctx.powerups.length, 1);
  assert.equal(results[0].inventoryFull, false);
  assert.ok(results[0].powerup);
});

test("user with 2 HELD crossing 2 thresholds earns 1 then is blocked", async () => {
  const ctx = makeDeps({ heldCount: 2 });
  const roll = buildRollPowerup(ctx.deps);

  // Crosses 5k and 10k — 2 thresholds
  const results = await roll(rollArgs({
    currentSteps: 11000,
    nextBoxAtSteps: 5000,
  }));

  // First roll: held=2 → allowed (held becomes 3)
  // Second roll: held=3 → blocked
  assert.equal(results.length, 2);
  assert.equal(ctx.powerups.length, 1);

  assert.equal(results[0].inventoryFull, false);
  assert.ok(results[0].powerup);

  assert.equal(results[1].inventoryFull, true);
  assert.equal(results[1].powerup, null);
});

test("user with 0 HELD can fill inventory to exactly 3", async () => {
  const ctx = makeDeps({ heldCount: 0 });
  const roll = buildRollPowerup(ctx.deps);

  // Crosses 5k, 10k, 15k — 3 thresholds
  const results = await roll(rollArgs({
    currentSteps: 16000,
    nextBoxAtSteps: 5000,
  }));

  assert.equal(ctx.powerups.length, 3);
  for (const r of results) {
    assert.equal(r.inventoryFull, false);
    assert.ok(r.powerup);
  }
});

test("user with 0 HELD crossing 4 thresholds earns 3 then is blocked", async () => {
  const ctx = makeDeps({ heldCount: 0 });
  const roll = buildRollPowerup(ctx.deps);

  // Crosses 5k, 10k, 15k, 20k — 4 thresholds
  const results = await roll(rollArgs({
    currentSteps: 21000,
    nextBoxAtSteps: 5000,
  }));

  assert.equal(results.length, 4);
  assert.equal(ctx.powerups.length, 3);

  // First 3 succeed
  for (let i = 0; i < 3; i++) {
    assert.equal(results[i].inventoryFull, false, `roll ${i} should succeed`);
    assert.ok(results[i].powerup, `roll ${i} should have a powerup`);
  }
  // 4th is blocked
  assert.equal(results[3].inventoryFull, true);
  assert.equal(results[3].powerup, null);
});

test("only HELD status counts toward inventory limit (USED/DISCARDED do not)", async () => {
  // User has used or discarded past powerups, but only 1 is currently HELD
  // countHeldByParticipant only counts HELD status per Prisma schema
  const ctx = makeDeps({ heldCount: 1 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs());

  // Should be allowed — only 1 HELD, well below limit of 3
  assert.equal(ctx.powerups.length, 1);
  assert.equal(results[0].inventoryFull, false);
  assert.ok(results[0].powerup);
});
