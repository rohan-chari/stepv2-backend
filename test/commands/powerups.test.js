const assert = require("node:assert/strict");
const test = require("node:test");
const { buildRollPowerup, DEFAULT_POWERUP_SLOTS } = require("../../src/commands/rollPowerup");

// ---------------------------------------------------------------------------
// General powerup tests — mystery box creation rules
// ---------------------------------------------------------------------------

function makeDeps() {
  const powerups = [];
  const feedEvents = [];
  const events = [];
  let lastNextBoxAtSteps = null;

  return {
    powerups,
    feedEvents,
    events,
    get lastNextBoxAtSteps() { return lastNextBoxAtSteps; },
    deps: {
      RacePowerup: {
        async create(data) {
          const p = { id: `pw-${powerups.length + 1}`, ...data };
          powerups.push(p);
          return p;
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
    powerupStepInterval: 5000,
    displayName: "Alex",
    ...overrides,
  };
}

// ===========================================================================
// Mystery boxes are always created (type determined at open time)
// ===========================================================================

test("DEFAULT_POWERUP_SLOTS is 3", () => {
  assert.equal(DEFAULT_POWERUP_SLOTS, 3);
});

test("mystery box is created with null type and rarity", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs());

  assert.equal(ctx.powerups.length, 1);
  assert.equal(results.length, 1);
  assert.ok(results[0].mysteryBox);
  assert.equal(ctx.powerups[0].status, "MYSTERY_BOX");
  assert.equal(ctx.powerups[0].type, undefined);
  assert.equal(ctx.powerups[0].rarity, undefined);
});

test("multiple mystery boxes created crossing multiple thresholds", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs({
    currentSteps: 16000,
    nextBoxAtSteps: 5000,
  }));

  assert.equal(ctx.powerups.length, 3);
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.ok(r.mysteryBox);
  }
});

test("threshold advances when mystery box is created", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  await roll(rollArgs({
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
  }));

  assert.equal(ctx.lastNextBoxAtSteps, 10000);
});

test("feed event and bus event created for each mystery box", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  await roll(rollArgs());

  assert.equal(ctx.feedEvents.length, 1);
  assert.equal(ctx.events.length, 1);
  assert.ok(ctx.feedEvents[0].description.includes("mystery box"));
});

test("crossing 4 thresholds creates 4 mystery boxes", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs({
    currentSteps: 21000,
    nextBoxAtSteps: 5000,
  }));

  assert.equal(results.length, 4);
  assert.equal(ctx.powerups.length, 4);
  for (const p of ctx.powerups) {
    assert.equal(p.status, "MYSTERY_BOX");
  }
});

test("mystery box result does not expose type or rarity", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll(rollArgs());

  assert.ok(results[0].mysteryBox.id);
  assert.equal(results[0].mysteryBox.type, undefined);
  assert.equal(results[0].mysteryBox.rarity, undefined);
});
