const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRollPowerup } = require("../../src/commands/rollPowerup");

function makeDeps(overrides = {}) {
  const events = [];
  const powerups = [];
  let lastNextBoxAtSteps = null;
  let lastMaxBonusSteps = null;

  return {
    powerups,
    events,
    get lastNextBoxAtSteps() { return lastNextBoxAtSteps; },
    get lastMaxBonusSteps() { return lastMaxBonusSteps; },
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
        async updateNextBoxAtSteps(_id, value) { lastNextBoxAtSteps = value; },
        async updateMaxBonusSteps(_id, value) { lastMaxBonusSteps = value; },
        ...overrides.RaceParticipant,
      },
      RacePowerupEvent: {
        async create(data) { return { id: "fe-1", ...data }; },
      },
      eventBus: { emit(event, payload) { events.push({ event, payload }); } },
    },
  };
}

test("rollPowerup uses effectiveSteps (with maxBonusSteps) instead of currentSteps for thresholds", async () => {
  // Scenario: player walked to step 4990 (base=4990, bonus=0), then got Banana Peel
  // dropping bonus to -1000, so currentSteps would be 3990. But maxBonusSteps stays at 0.
  // Then player walks 10 more steps → base=5000, bonus=-1000, currentSteps=4000.
  // effective for boxes = base + buffed - frozen + maxBonusSteps = 5000 + 0 - 0 + 0 = 5000.
  // The threshold (5000) should be crossed.
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 4000,
    effectiveSteps: 5000,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
  });

  assert.equal(results.length, 1, "should earn the box after pushback");
  assert.equal(ctx.lastNextBoxAtSteps, 10000);
});

test("rollPowerup falls back to currentSteps if effectiveSteps not provided", async () => {
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
});

test("rollPowerup does NOT cross threshold when effectiveSteps is below it (leg cramp case)", async () => {
  // Scenario: player walked to 5000 raw steps, but Leg Cramp froze 200 of them.
  // effectiveSteps = 5000 - 200 + 0 + maxBonus(0) = 4800. Should NOT earn box.
  const ctx = makeDeps();
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5000,
    effectiveSteps: 4800,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
  });

  assert.equal(results.length, 0);
});
