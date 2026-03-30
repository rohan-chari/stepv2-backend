const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRollPowerup, MAX_INVENTORY } = require("../../src/commands/rollPowerup");

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const powerups = [];
  let heldCount = 0;
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
          heldCount++;
          return p;
        },
        async countHeldByParticipant() {
          return overrides.heldCount !== undefined ? overrides.heldCount : heldCount;
        },
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
      rollPowerupOdds: overrides.rollPowerupOdds || (() => ({ type: "PROTEIN_SHAKE", rarity: "COMMON" })),
    },
  };
}

test("rollPowerup grants a powerup when threshold is crossed", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    position: 2,
    totalParticipants: 4,
    powerupStepInterval: 5000,
    displayName: "Alex",
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].inventoryFull, false);
  assert.equal(results[0].powerup.type, "PROTEIN_SHAKE");
  assert.equal(ctx.powerups.length, 1);
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
    position: 1,
    totalParticipants: 2,
    powerupStepInterval: 5000,
    displayName: "Alex",
  });

  // Should cross 5k, 10k, 15k = 3 boxes (if inventory allows)
  assert.equal(results.length, 3);
  assert.equal(ctx.lastNextBoxAtSteps, 20000);
});

test("rollPowerup stops when inventory is full", async () => {
  const ctx = makeDeps({ heldCount: 3 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    position: 1,
    totalParticipants: 2,
    powerupStepInterval: 5000,
    displayName: "Alex",
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].inventoryFull, true);
  assert.equal(ctx.powerups.length, 0);
});

test("rollPowerup creates feed event with displayName", async () => {
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    position: 1,
    totalParticipants: 2,
    powerupStepInterval: 5000,
    displayName: "Jordan",
  });

  assert.ok(ctx.feedEvents[0].description.includes("Jordan"));
  assert.ok(ctx.feedEvents[0].description.includes("Protein Shake"));
});
