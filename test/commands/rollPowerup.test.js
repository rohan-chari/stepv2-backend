const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRollPowerup } = require("../../src/commands/rollPowerup");

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const powerups = [];
  let lastNextBoxAtSteps = null;

  return {
    events,
    feedEvents,
    powerups,
    get lastNextBoxAtSteps() { return lastNextBoxAtSteps; },
    deps: {
      RacePowerup: {
        async create(data) {
          const p = { id: `pw-${powerups.length + 1}`, ...data };
          powerups.push(p);
          return p;
        },
        async countOccupiedSlots() { return 0; },
        ...overrides.RacePowerup,
      },
      RaceParticipant: {
        async updateNextBoxAtSteps(id, value) {
          lastNextBoxAtSteps = value;
        },
        ...overrides.RaceParticipant,
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: "fe-1", ...data };
        },
        ...overrides.RacePowerupEvent,
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
    },
  };
}

test("rollPowerup creates a mystery box when threshold is crossed", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
  });

  assert.equal(results.length, 1);
  assert.ok(results[0].mysteryBox);
  assert.ok(results[0].mysteryBox.id);
  assert.equal(ctx.powerups.length, 1);
  assert.equal(ctx.powerups[0].status, "MYSTERY_BOX");
  assert.equal(ctx.powerups[0].type, undefined);
  assert.equal(ctx.powerups[0].rarity, undefined);
  assert.equal(ctx.lastNextBoxAtSteps, 10000);
  assert.equal(ctx.events[0].event, "POWERUP_EARNED");
  assert.equal(ctx.feedEvents[0].eventType, "POWERUP_EARNED");
});

test("rollPowerup handles multiple threshold crossings", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 16000,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
  });

  assert.equal(results.length, 3);
  assert.equal(ctx.powerups.length, 3);
  for (const r of results) {
    assert.ok(r.mysteryBox);
  }
  assert.equal(ctx.lastNextBoxAtSteps, 20000);
});

test("rollPowerup creates mystery boxes even when inventory is full", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
  });

  assert.equal(results.length, 1);
  assert.ok(results[0].mysteryBox);
  assert.equal(ctx.powerups.length, 1);
  assert.equal(ctx.powerups[0].status, "MYSTERY_BOX");
});

test("rollPowerup does not store type or rarity on mystery box", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Jordan",
  });

  assert.ok(ctx.feedEvents[0].description.includes("Jordan"));
  assert.ok(ctx.feedEvents[0].description.includes("mystery box"));
  assert.equal(ctx.feedEvents[0].powerupType, "MYSTERY_BOX");
  // No type or rarity stored — determined at open time
  assert.equal(ctx.powerups[0].type, undefined);
  assert.equal(ctx.powerups[0].rarity, undefined);
});
