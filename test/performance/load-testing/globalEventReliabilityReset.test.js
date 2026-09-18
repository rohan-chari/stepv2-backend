const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  resetGlobalEventDerivedState,
} = require("../../../src/modules/loadTesting/globalEventReliabilityFixtures");

test("a restored capacity clone drops pre-run race work before fixture timing begins", async () => {
  const statements = [];
  const prisma = {
    async $transaction(callback) {
      return callback({
        async $executeRawUnsafe(sql) {
          statements.push(sql);
          return 0;
        },
      });
    },
  };

  await resetGlobalEventDerivedState(prisma);

  const sql = statements.join("\n");
  assert.match(sql, /DELETE FROM race_resolution_full_triggers/);
  assert.match(sql, /DELETE FROM race_resolution_jobs_v2/);
});

test("global-event entitlement pages coalesce one race generation across the boundary drain", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/modules/steps/services/globalStepEventEntitlement.js"),
    "utf8",
  );
  const enqueueStart = source.lastIndexOf("await RaceResolutionJobV2.enqueueMany");
  const enqueue = source.slice(enqueueStart, enqueueStart + 1_300);

  assert.match(enqueue, /reason: "GLOBAL_EVENT_BOUNDARY"/);
  assert.match(enqueue, /priority: "COALESCE"/);
  assert.match(enqueue, /burstCoalescing: true/);
  assert.doesNotMatch(enqueue, /bypassDebounce: true/);
});
