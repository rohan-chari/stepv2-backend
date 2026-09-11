const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cleanupExpiredEntitlements,
} = require("../../src/modules/steps/services/globalStepEventRetention");

test("retention deletes complete lifecycle dependents and reports old blockers", async () => {
  const statements = [];
  const client = {
    async $transaction(callback) {
      return callback({
        async $queryRawUnsafe(sql, at) {
          statements.push({ sql, at });
          if (/SELECT e\.id/.test(sql)) {
            return [{ id: "ent-1", event_id: "event-1", user_id: "user-1" }];
          }
          return [{ blocked: 0n }];
        },
        eventRecap: { async deleteMany() { return { count: 1 }; } },
        globalEventRaceImpact: { async deleteMany() { return { count: 2 }; } },
        globalStepEventEntitlement: { async deleteMany() { return { count: 1 }; } },
        jobRun: { async findUnique() { return null; }, async deleteMany() { return { count: 1 }; } },
      });
    },
  };
  const result = await cleanupExpiredEntitlements({
    client,
    now: new Date("2026-08-19T00:00:00Z"),
  });
  assert.deepEqual(result, {
    deletedEntitlements: 1, deletedImpacts: 2, deletedSummaries: 1,
    blockedEntitlements: 0, healthy: true,
  });
  assert.equal(statements[0].at.toISOString(), "2026-07-20T00:00:00.000Z");
  assert.match(statements[0].sql, /start_processed_at IS NOT NULL/);
  assert.doesNotMatch(statements[0].sql, /i\.status|global_event_summary_work/);
  assert.match(statements[0].sql, /r\.status='active'/);
  assert.match(statements[0].sql, /e\.ends_at<\$1/);
});
