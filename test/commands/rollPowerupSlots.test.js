const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRollPowerup } = require("../../src/commands/rollPowerup");

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const powerups = [];
  let lastNextBoxAtSteps = null;
  let occupiedSlots = overrides.occupiedSlots || 0;

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
          // MYSTERY_BOX occupies a slot, QUEUED does not
          if (data.status === "MYSTERY_BOX") occupiedSlots++;
          return p;
        },
        async countOccupiedSlots() {
          return occupiedSlots;
        },
        ...overrides.RacePowerup,
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

// ---------------------------------------------------------------------------
// Slot-aware mystery box earning
// ---------------------------------------------------------------------------

test("box fills slot when slots are available", async () => {
  const ctx = makeDeps({ occupiedSlots: 1 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
    powerupSlots: 3,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].queued, false);
  assert.equal(ctx.powerups[0].status, "MYSTERY_BOX");
});

test("box is queued when all slots are full", async () => {
  const ctx = makeDeps({ occupiedSlots: 3 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
    powerupSlots: 3,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].queued, true);
  assert.equal(ctx.powerups[0].status, "QUEUED");
});

test("threshold advances even when box is queued", async () => {
  const ctx = makeDeps({ occupiedSlots: 3 });
  const roll = buildRollPowerup(ctx.deps);

  await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
    powerupSlots: 3,
  });

  assert.equal(ctx.lastNextBoxAtSteps, 10000);
});

test("multi-threshold crossing: some fill slots, rest queued", async () => {
  // 1 slot open, crossing 3 thresholds → 1 fills slot, 2 queued
  const ctx = makeDeps({ occupiedSlots: 2 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 16000,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
    powerupSlots: 3,
  });

  assert.equal(results.length, 3);

  // First box fills the last open slot
  assert.equal(results[0].queued, false);
  assert.equal(ctx.powerups[0].status, "MYSTERY_BOX");

  // Remaining boxes are queued (slots now full)
  assert.equal(results[1].queued, true);
  assert.equal(ctx.powerups[1].status, "QUEUED");
  assert.equal(results[2].queued, true);
  assert.equal(ctx.powerups[2].status, "QUEUED");

  assert.equal(ctx.lastNextBoxAtSteps, 20000);
});

test("queued box emits POWERUP_EARNED event and feed entry", async () => {
  const ctx = makeDeps({ occupiedSlots: 3 });
  const roll = buildRollPowerup(ctx.deps);

  await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 5500,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
    powerupSlots: 3,
  });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "POWERUP_EARNED");
  assert.equal(ctx.feedEvents.length, 1);
  assert.ok(ctx.feedEvents[0].description.includes("queued"));
});

test("all slots open — all boxes fill slots", async () => {
  const ctx = makeDeps({ occupiedSlots: 0 });
  const roll = buildRollPowerup(ctx.deps);

  const results = await roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 16000,
    nextBoxAtSteps: 5000,
    powerupStepInterval: 5000,
    displayName: "Alex",
    powerupSlots: 3,
  });

  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.queued, false);
  }
  for (const p of ctx.powerups) {
    assert.equal(p.status, "MYSTERY_BOX");
  }
});
