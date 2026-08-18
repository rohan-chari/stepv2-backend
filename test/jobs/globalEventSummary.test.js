const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGlobalEventSummaryTick,
} = require("../../src/modules/steps/jobs/globalEventSummary");

function summaryPrisma({ endsAt, pending = 0 }) {
  const writes = [];
  return {
    writes,
    globalEventRaceImpact: {
      async groupBy() {
        return [{ eventId: "event-1", userId: "user-1", _sum: { deltaSteps: 12 }, _count: { _all: 1 } }];
      },
      async count() { return pending; },
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
