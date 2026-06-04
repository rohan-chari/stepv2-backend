const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRollPowerup,
  MAX_BOXES_PER_ROLL,
} = require("../../src/commands/rollPowerup");

// ---------------------------------------------------------------------------
// Per-sync grant cap.
//
// A transient step-spike (later corrected) could otherwise make a single
// rollPowerup call cross hundreds of thresholds, minting a pile of free boxes
// and rocketing nextBoxAtSteps far above the player's real steps. A single call
// must grant at most MAX_BOXES_PER_ROLL boxes and advance nextBoxAtSteps by at
// most MAX_BOXES_PER_ROLL * interval. Remaining thresholds are left for later
// syncs (no progress lost). The normal 0-3 boxes/sync case is unaffected.
// ---------------------------------------------------------------------------

function makeCtx({ initialNextBox = 2000, interval = 2000 } = {}) {
  const created = [];
  let nextBox = initialNextBox;

  const tx = {
    async $executeRaw() {
      return [];
    },
    racePowerup: {
      async findUnique() {
        return null; // no pre-existing boxes
      },
      async create({ data }) {
        const p = { id: `pw-${created.length + 1}`, ...data };
        created.push(p);
        return p;
      },
      async count() {
        return 0; // inventory never full
      },
    },
    raceParticipant: {
      async findUnique() {
        return { nextBoxAtSteps: nextBox };
      },
      async update({ data }) {
        if (typeof data.nextBoxAtSteps === "number") nextBox = data.nextBoxAtSteps;
        return { id: "rp-1", ...data };
      },
    },
    racePowerupEvent: {
      async create({ data }) {
        return { id: "ev-1", ...data };
      },
    },
  };

  const prisma = {
    async $transaction(cb) {
      return cb(tx);
    },
    async $executeRaw() {
      return [];
    },
  };

  return {
    created,
    interval,
    initialNextBox,
    get nextBox() {
      return nextBox;
    },
    roll: buildRollPowerup({ prisma, eventBus: { emit() {} } }),
  };
}

test("a single roll with a huge effectiveSteps grants at most MAX_BOXES_PER_ROLL boxes", async () => {
  const interval = 2000;
  const initialNextBox = 2000;
  // Effective steps far beyond what the cap allows: would cross 1000 thresholds.
  const hugeSteps = initialNextBox + interval * 1000;
  const ctx = makeCtx({ initialNextBox, interval });

  const results = await ctx.roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: hugeSteps,
    effectiveSteps: hugeSteps,
    nextBoxAtSteps: initialNextBox,
    powerupStepInterval: interval,
    displayName: "Spiker",
    powerupSlots: 3,
  });

  assert.equal(
    ctx.created.length,
    MAX_BOXES_PER_ROLL,
    `granted ${ctx.created.length} boxes, expected cap of ${MAX_BOXES_PER_ROLL}`
  );
  assert.equal(results.filter((r) => r.mysteryBox).length, MAX_BOXES_PER_ROLL);

  // nextBoxAtSteps advanced by at most MAX_BOXES_PER_ROLL * interval.
  const expectedNextBox = initialNextBox + MAX_BOXES_PER_ROLL * interval;
  assert.equal(
    ctx.nextBox,
    expectedNextBox,
    `nextBox=${ctx.nextBox}, expected ${expectedNextBox}`
  );
});

test("remaining thresholds are picked up by subsequent syncs (no progress lost)", async () => {
  const interval = 2000;
  const initialNextBox = 2000;
  const hugeSteps = initialNextBox + interval * 1000;
  const ctx = makeCtx({ initialNextBox, interval });

  const args = {
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: hugeSteps,
    effectiveSteps: hugeSteps,
    nextBoxAtSteps: initialNextBox,
    powerupStepInterval: interval,
    displayName: "Spiker",
    powerupSlots: 3,
  };

  await ctx.roll(args); // first sync: capped
  const afterFirst = ctx.nextBox;
  await ctx.roll(args); // second sync: continues from the advanced threshold

  assert.equal(
    ctx.nextBox,
    afterFirst + MAX_BOXES_PER_ROLL * interval,
    "second sync advances another full cap's worth of thresholds"
  );
  assert.equal(ctx.created.length, MAX_BOXES_PER_ROLL * 2);
});

test("normal small crossing (under the cap) is unaffected", async () => {
  const interval = 2000;
  const initialNextBox = 2000;
  // Cross exactly 3 thresholds: 2000, 4000, 6000.
  const ctx = makeCtx({ initialNextBox, interval });

  await ctx.roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 6500,
    effectiveSteps: 6500,
    nextBoxAtSteps: initialNextBox,
    powerupStepInterval: interval,
    displayName: "Walker",
    powerupSlots: 3,
  });

  assert.equal(ctx.created.length, 3, "all 3 boxes granted, cap not triggered");
  assert.equal(ctx.nextBox, 8000);
});
