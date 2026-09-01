const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../src/modules/domainEvents/models/domainEventOutbox.js",
  ),
  "utf8",
);

test("bulk scheduled-entitlement projection does not hold the provider admission lane", () => {
  const start = source.indexOf("async function projectScheduledEntitlementEventsBatch");
  const end = source.indexOf("async function completeNoDevicePlacementProjectionsBatch", start);
  assert.ok(start >= 0 && end > start);
  const implementation = source.slice(start, end);

  assert.doesNotMatch(implementation, /lockNotificationAdmissionLane/);
  assert.match(implementation, /pg_try_advisory_xact_lock/);
  assert.match(implementation, /if \(!gate\?\.acquired\)/);
  assert.doesNotMatch(implementation, /projector_gate AS/);
  assert.match(implementation, /due_ids AS MATERIALIZED/);
  assert.match(implementation, /JOIN due_ids due ON due\.id=event\.id/);
  assert.match(implementation, /LIMIT \$3[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.match(implementation, /Math\.max\(500, limit \* 5\)/);
  assert.match(implementation, /'ADMISSION_PENDING'/);
  assert.match(implementation, /admission_sequence/);
});
