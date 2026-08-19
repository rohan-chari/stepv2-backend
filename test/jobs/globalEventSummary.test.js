const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGlobalEventSummaryTick,
} = require("../../src/modules/steps/jobs/globalEventSummary");

function summaryPrisma({ endsAt, pending = 0, nonzero = 1, sum = 12, count = 1 }) {
  const writes = [];
  return {
    writes,
    globalEventRaceImpact: {
      async groupBy() {
        return [{
          eventId: "event-1",
          userId: "user-1",
          _sum: { deltaSteps: sum },
          _count: { _all: count },
        }];
      },
      async count({ where }) {
        return where?.deltaSteps ? nonzero : pending;
      },
    },
    globalStepEvent: {
      async findUnique() { return { endsAt }; },
    },
    async $transaction(write) {
      return write({
        jobRun: { async create(input) { writes.push({ kind: "job", input }); } },
        globalEventUserSummary: { async upsert(input) { writes.push({ kind: "summary", input }); } },
      });
    },
  };
}

test("global recap waits until the event enrollment window has closed", async () => {
  const current = new Date("2026-08-17T12:00:00.000Z");
  const prisma = summaryPrisma({ endsAt: new Date("2026-08-17T12:01:00.000Z") });
  const tick = buildGlobalEventSummaryTick({ prisma, now: () => current });

  assert.deepEqual(await tick(), { upserts: 0 });
  assert.deepEqual(prisma.writes, []);
});

test("closed events still require every durable enrollment to settle", async () => {
  const current = new Date("2026-08-17T12:00:00.000Z");
  const prisma = summaryPrisma({
    endsAt: new Date("2026-08-17T11:59:59.000Z"), pending: 1,
  });
  const tick = buildGlobalEventSummaryTick({ prisma, now: () => current });

  assert.deepEqual(await tick(), { upserts: 0 });
  assert.deepEqual(prisma.writes, []);
});

test("all-zero final groups are durably claimed without creating a summary", async () => {
  const current = new Date("2026-08-17T12:00:00.000Z");
  const prisma = summaryPrisma({
    endsAt: new Date("2026-08-17T11:59:59.000Z"),
    nonzero: 0,
    sum: 0,
    count: 2,
  });
  const tick = buildGlobalEventSummaryTick({ prisma, now: () => current });

  assert.deepEqual(await tick(), { upserts: 0 });
  assert.equal(prisma.writes.length, 1);
  assert.equal(prisma.writes[0].kind, "job");
  assert.equal(prisma.writes[0].input.data.lastRanFor, "ALL_ZERO");
});

test("mixed nonzero contributions summing to zero still create the recap", async () => {
  const current = new Date("2026-08-17T12:00:00.000Z");
  const prisma = summaryPrisma({
    endsAt: new Date("2026-08-17T11:59:59.000Z"),
    nonzero: 2,
    sum: 0,
    count: 2,
  });
  const tick = buildGlobalEventSummaryTick({ prisma, now: () => current });

  assert.deepEqual(await tick(), { upserts: 1 });
  assert.deepEqual(prisma.writes.map((write) => write.kind), ["job", "summary"]);
  assert.equal(prisma.writes[0].input.data.lastRanFor, "FINAL");
  assert.equal(prisma.writes[1].input.create.extraRaceSteps, 0);
  assert.equal(prisma.writes[1].input.create.raceCount, 2);
});
