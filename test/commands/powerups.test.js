const assert = require("node:assert/strict");
const test = require("node:test");
const { buildRollPowerup, DEFAULT_POWERUP_SLOTS } = require("../../src/commands/rollPowerup");

// ---------------------------------------------------------------------------
// General powerup tests — mystery box creation rules
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
// Mystery boxes are always created (inventory limit enforced at open time)
// ===========================================================================

test("DEFAULT_POWERUP_SLOTS is 3", () => {
  assert.equal(DEFAULT_POWERUP_SLOTS, 3);
});

test("mystery box is created even with 3 HELD powerups", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs());

  assert.equal(ctx.powerups.length, 1);
  assert.equal(results.length, 1);
  assert.ok(results[0].mysteryBox);
  assert.equal(ctx.powerups[0].status, "MYSTERY_BOX");
});

test("multiple mystery boxes created with full inventory crossing multiple thresholds", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const roll = buildRollPowerup(ctx.deps);

  // Crosses 5k, 10k, 15k — 3 thresholds
  const results = await roll(rollArgs({
    currentSteps: 16000,
    nextBoxAtSteps: 5000,
  }));

  // All 3 mystery boxes created despite full inventory
  assert.equal(ctx.powerups.length, 3);
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.ok(r.mysteryBox);
  }
});

test("threshold advances when mystery box is created", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const roll = buildRollPowerup(ctx.deps);

  await roll(rollArgs({
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
  }));

  assert.equal(ctx.lastNextBoxAtSteps, 10000);
});

test("feed event and bus event created for each mystery box", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const roll = buildRollPowerup(ctx.deps);

  await roll(rollArgs());

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.events.length, 1);
  assert.ok(ctx.feedEvents[0].description.includes("mystery box"));
});

test("mystery box created with status MYSTERY_BOX", async () => {
  const ctx = makeDeps({ heldCount: 0 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs());

  assert.equal(ctx.powerups.length, 1);
  assert.equal(ctx.powerups[0].status, "MYSTERY_BOX");
  assert.ok(results[0].mysteryBox.id);
});

test("crossing 4 thresholds creates 4 mystery boxes", async () => {
  const ctx = makeDeps({ heldCount: 0 });
  const roll = buildRollPowerup(ctx.deps);

  // Crosses 5k, 10k, 15k, 20k — 4 thresholds
  const results = await roll(rollArgs({
    currentSteps: 21000,
    nextBoxAtSteps: 5000,
  }));

  assert.equal(results.length, 4);
  assert.equal(ctx.powerups.length, 4);
  for (const r of results) {
    assert.ok(r.mysteryBox);
  }
  for (const p of ctx.powerups) {
    assert.equal(p.status, "MYSTERY_BOX");
  }
});

test("mystery box result does not expose type or rarity", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs());

  // The result should only have mysteryBox.id, not type or rarity
  assert.ok(results[0].mysteryBox.id);
  assert.equal(results[0].mysteryBox.type, undefined);
  assert.equal(results[0].mysteryBox.rarity, undefined);
  // But the DB record should have type and rarity stored
  assert.equal(ctx.powerups[0].type, "PROTEIN_SHAKE");
  assert.equal(ctx.powerups[0].rarity, "COMMON");
});
