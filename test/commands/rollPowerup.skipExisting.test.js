const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRollPowerup } = require("../../src/commands/rollPowerup");

// Regression: when nextBoxAtSteps sits at/below an ALREADY-earned box row
// (e.g. a remediated/reset nextBox, or a legacy orphan), the roll must SKIP that
// threshold gracefully — advancing nextBox WITHOUT re-granting a box and WITHOUT
// crashing. Previously it inserted, hit a unique-constraint P2002, ABORTED the
// transaction, and the next statement threw "current transaction is aborted",
// 500-ing the whole request (this is what made races inaccessible).

function makeCtx({ existingThresholds = [], initialNextBox = 2000 } = {}) {
  const created = [];
  let nextBox = initialNextBox;
  const existing = new Set(existingThresholds);

  const tx = {
    async $executeRaw() {
      return [];
    },
    racePowerup: {
      async findUnique({ where }) {
        const t = where.participantId_earnedAtSteps.earnedAtSteps;
        return existing.has(t) ? { id: `existing-${t}` } : null;
      },
      async create({ data }) {
        // Real Postgres would raise P2002 here for a duplicate; if the pre-check
        // is ever removed this throw makes the test fail loudly.
        if (existing.has(data.earnedAtSteps)) {
          const e = new Error("Unique constraint failed");
          e.code = "P2002";
          throw e;
        }
        existing.add(data.earnedAtSteps);
        const p = { id: `pw-${created.length + 1}`, ...data };
        created.push(p);
        return p;
      },
      async count() {
        return 0;
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
    get nextBox() {
      return nextBox;
    },
    roll: buildRollPowerup({ prisma, eventBus: { emit() {} } }),
  };
}

test("roll skips already-earned thresholds without crashing or double-granting", async () => {
  // Boxes already exist at 2000 and 4000; effective 6000, nextBox starts at 2000.
  // Must skip 2000 + 4000 (no new boxes), earn exactly ONE at 6000, advance to 8000.
  const ctx = makeCtx({ existingThresholds: [2000, 4000], initialNextBox: 2000 });

  const results = await ctx.roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 6000,
    effectiveSteps: 6000,
    nextBoxAtSteps: 2000,
    powerupStepInterval: 2000,
    displayName: "Nathan",
    powerupSlots: 3,
  });

  assert.equal(ctx.created.length, 1, "exactly one NEW box earned (at 6000)");
  assert.equal(ctx.created[0].earnedAtSteps, 6000);
  assert.equal(ctx.nextBox, 8000, "nextBox advanced past the skipped + earned thresholds");
  assert.equal(results.filter((r) => r.mysteryBox).length, 1);
});

test("roll with all thresholds already earned grants nothing and just advances nextBox", async () => {
  const ctx = makeCtx({ existingThresholds: [2000, 4000, 6000], initialNextBox: 2000 });

  await ctx.roll({
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    currentSteps: 6000,
    effectiveSteps: 6000,
    nextBoxAtSteps: 2000,
    powerupStepInterval: 2000,
    displayName: "Nathan",
    powerupSlots: 3,
  });

  assert.equal(ctx.created.length, 0, "no new boxes (all thresholds already claimed)");
  assert.equal(ctx.nextBox, 8000);
});
