const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGlobalEventEntitlementEventReconciler,
} = require("../../src/modules/steps/jobs/globalEventEntitlementEventReconciler");

test("entitlement-event reconciliation repairs one bounded page set-wise", async () => {
  const ids = Array.from({ length: 500 }, (_, index) => `entitlement-${index}`);
  const entitlements = ids.map((id, index) => ({
    id,
    userId: `user-${index}`,
    endsAt: new Date("2098-08-27T10:30:00.000Z"),
    scheduleRevision: 0,
    event: { id: "event-1", multiplier: 2 },
  }));
  let transactions = 0;
  let batch;
  const tx = {
    async $queryRawUnsafe(sql, values, current) {
      assert.deepEqual(values, ids);
      assert.equal(current.toISOString(), "2098-08-27T10:00:00.000Z");
      assert.match(sql, /FROM global_step_event_entitlements/);
      assert.match(sql, /FROM domain_event_outbox/);
      assert.match(sql, /terminal_status IS NOT NULL/);
      return ids.map(id => ({ id }));
    },
    globalStepEventEntitlement: {
      async findMany(input) {
        assert.deepEqual(input.where.id.in, ids);
        assert.equal(input.include.event, true);
        return entitlements;
      },
    },
  };
  const prisma = {
    async $queryRawUnsafe() { return ids.map((id) => ({ id })); },
    async $transaction(work) {
      transactions += 1;
      return work(tx);
    },
  };
  const reconcile = buildGlobalEventEntitlementEventReconciler({
    prisma,
    now: () => new Date("2098-08-27T10:00:00.000Z"),
    generationUsable: async () => true,
    appendBatch: async (_tx, input) => { batch = input.entitlements; },
  });

  assert.deepEqual(await reconcile(), {
    published: 500,
    generationReady: true,
    fullPage: true,
  });
  assert.equal(transactions, 1);
  assert.equal(batch.length, 500);
});
