const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCutover,
} = require("../../scripts/cutover-seeded-races-to-midnight");

const NOW = new Date("2026-06-25T18:00:00Z"); // nextMidnight ET = 2026-06-26T04:00:00Z
const dailySeed = { id: "seed-daily-10k", kind: "DAILY_10K", cadence: "DAILY", active: true };

function makeCtx({ seeds = [dailySeed], racesBySeed = {} } = {}) {
  const updates = [];
  const prisma = {
    raceSeed: {
      async findMany() {
        return seeds;
      },
    },
    race: {
      async findMany({ where }) {
        return (racesBySeed[where.seedId] || []).filter(
          (r) => r.status === where.status
        );
      },
      async update({ where, data }) {
        updates.push({ id: where.id, data });
        return null;
      },
    },
  };
  return { prisma, updates };
}

function run(ctx, opts) {
  return buildCutover({ prisma: ctx.prisma, now: () => NOW })(opts);
}

test("truncates a rolling race ending after the next ET midnight and stamps timezone", async () => {
  const ctx = makeCtx({
    racesBySeed: {
      "seed-daily-10k": [
        {
          id: "rolling",
          status: "ACTIVE",
          endsAt: new Date("2026-06-26T15:47:00Z"), // weird, later than boundary
          timezone: null,
        },
      ],
    },
  });

  const changes = await run(ctx);

  assert.equal(ctx.updates.length, 1);
  assert.equal(ctx.updates[0].data.endsAt.toISOString(), "2026-06-26T04:00:00.000Z");
  assert.equal(ctx.updates[0].data.timezone, "America/New_York");
  assert.equal(changes[0].raceId, "rolling");
});

test("does not EXTEND a race already ending before the boundary (only sets timezone)", async () => {
  const ctx = makeCtx({
    racesBySeed: {
      "seed-daily-10k": [
        {
          id: "short",
          status: "ACTIVE",
          endsAt: new Date("2026-06-26T02:00:00Z"), // before boundary
          timezone: null,
        },
      ],
    },
  });

  await run(ctx);

  assert.equal(ctx.updates.length, 1);
  assert.equal(ctx.updates[0].data.endsAt, undefined); // not extended
  assert.equal(ctx.updates[0].data.timezone, "America/New_York");
});

test("idempotent: already-aligned race is a no-op", async () => {
  const ctx = makeCtx({
    racesBySeed: {
      "seed-daily-10k": [
        {
          id: "aligned",
          status: "ACTIVE",
          endsAt: new Date("2026-06-26T04:00:00Z"),
          timezone: "America/New_York",
        },
      ],
    },
  });

  const changes = await run(ctx);
  assert.equal(changes.length, 0);
  assert.equal(ctx.updates.length, 0);
});

test("dry-run reports changes without writing", async () => {
  const ctx = makeCtx({
    racesBySeed: {
      "seed-daily-10k": [
        {
          id: "rolling",
          status: "ACTIVE",
          endsAt: new Date("2026-06-26T15:47:00Z"),
          timezone: null,
        },
      ],
    },
  });

  const changes = await run(ctx, { dryRun: true });
  assert.equal(changes.length, 1);
  assert.equal(ctx.updates.length, 0); // nothing written
});
