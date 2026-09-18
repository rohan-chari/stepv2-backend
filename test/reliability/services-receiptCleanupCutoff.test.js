const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  markReceiptCleanupCutoffObserved,
  acceptReceiptCleanupCutoff,
} = require("../../src/shared/queues/receiptCleanupCutoff");

test("observation marker and accepted marker are distinct durable states", async () => {
  const writes = [];
  const prisma = { jobRun: { async upsert(args) { writes.push(args); return args; } } };
  const at = new Date("2026-09-02T12:00:00Z");
  await markReceiptCleanupCutoffObserved({ observedAt: at, prisma });
  await acceptReceiptCleanupCutoff({ acceptedAt: at, prisma });
  assert.notEqual(writes[0].where.jobName, writes[1].where.jobName);
  assert.equal(writes[0].create.lastRanFor, at.toISOString());
  assert.equal(writes[1].create.lastRanFor, at.toISOString());
});

test("cutoff script atomically records observation with its first destructive page", () => {
  const source = fs.readFileSync(path.resolve(__dirname,
    "../../scripts/postgresql-receipt-cleanup-cutoff.js"), "utf8");
  assert.match(source,
    /prisma\.\$transaction\([\s\S]*operation\.run\(tx\)[\s\S]*markReceiptCleanupCutoffObserved/);
  assert.match(source, /if \(!pages\.length \|\| !evidenceGatePassed\)[\s\S]*acceptReceiptCleanupCutoff/);
});
