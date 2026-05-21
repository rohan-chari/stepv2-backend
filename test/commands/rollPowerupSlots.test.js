const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRollPowerup } = require("../../src/commands/rollPowerup");

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const powerups = [];
  let lastNextBoxAtSteps = null;
  let participantNextBoxAtSteps =
    overrides.initialNextBoxAtSteps != null
      ? overrides.initialNextBoxAtSteps
      : 5000;
  let occupiedSlots = overrides.occupiedSlots || 0;
  let queuedSlots = overrides.queuedSlots || 0;

  const tx = {
    async $queryRaw() {
      return [];
    },
    racePowerup: {
      async create({ data }) {
        const p = { id: `pw-${powerups.length + 1}`, ...data };
        powerups.push(p);
        if (data.status === "MYSTERY_BOX" || data.status === "HELD") {
          occupiedSlots++;
        } else if (data.status === "QUEUED") {
          queuedSlots++;
        }
        return p;
      },
      async count({ where }) {
        if (where && where.status && where.status.in) {
          return occupiedSlots;
        }
        if (where && where.status === "QUEUED") {
          return queuedSlots;
        }
        return 0;
      },
    },
    raceParticipant: {
      async findUnique() {
        return { nextBoxAtSteps: participantNextBoxAtSteps };
      },
      async update({ data }) {
        if (data && typeof data.nextBoxAtSteps === "number") {
          participantNextBoxAtSteps = data.nextBoxAtSteps;
          lastNextBoxAtSteps = data.nextBoxAtSteps;
        }
        return { id: "rp-1", ...data };
      },
    },
    racePowerupEvent: {
      async create({ data }) {
        feedEvents.push(data);
        return { id: `fe-${feedEvents.length}`, ...data };
      },
    },
  };

  const prisma = {
    async $transaction(cb) {
      return cb(tx);
    },
    async $queryRaw() {
      return [];
    },
  };

  return {
    events,
    feedEvents,
    powerups,
    get lastNextBoxAtSteps() {
      return lastNextBoxAtSteps;
    },
    deps: {
      prisma,
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
  const ctx = makeDeps({ initialNextBoxAtSteps: 5000, occupiedSlots: 1 });
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
  const ctx = makeDeps({ initialNextBoxAtSteps: 5000, occupiedSlots: 3 });
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
  const ctx = makeDeps({ initialNextBoxAtSteps: 5000, occupiedSlots: 3 });
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

test("multi-threshold crossing: some fill slots, rest queued (with forfeit at MAX_QUEUED)", async () => {
  // 1 slot open, crossing 3 thresholds → 1 fills slot, 1 queued, 1 forfeited
  // (MAX_QUEUED_BOXES=1, so once queued is full, additional boxes forfeit).
  const ctx = makeDeps({ initialNextBoxAtSteps: 5000, occupiedSlots: 2 });
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

  // Second box is queued (slots now full, queue empty)
  assert.equal(results[1].queued, true);
  assert.equal(ctx.powerups[1].status, "QUEUED");

  // Third box is forfeited (slots full AND queue full at MAX_QUEUED_BOXES=1)
  assert.equal(results[2].forfeited, true);

  assert.equal(ctx.lastNextBoxAtSteps, 20000);
});

test("queued box emits POWERUP_EARNED event and feed entry", async () => {
  const ctx = makeDeps({ initialNextBoxAtSteps: 5000, occupiedSlots: 3 });
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
  const ctx = makeDeps({ initialNextBoxAtSteps: 5000, occupiedSlots: 0 });
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
