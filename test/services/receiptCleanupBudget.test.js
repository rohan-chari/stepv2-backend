const assert = require("node:assert/strict");
const test = require("node:test");

const { createReceiptCleanupBudget } = require("../../src/shared/queues/receiptCleanupBudget");
const {
  buildDomainEventRetention,
  MAX_PAGES,
} = require("../../src/modules/domainEvents/jobs/domainEventRetention");

test("recurring cleanup stops on page WAL, cumulative WAL, latency, or replica lag", async () => {
  const samples = [
    { lsn: "0/1", replicaLagSeconds: 0 },
    { lsn: "0/2", replicaLagSeconds: 0 },
    { lsn: "0/3", replicaLagSeconds: 6 },
  ];
  const budget = createReceiptCleanupBudget({
    snapshot: async () => samples.shift(),
    walBytesBetween: async () => 1024,
    nowMs: (() => { let value = 0; return () => (value += 10); })(),
  });
  assert.deepEqual(await budget.runPage(async () => 5), {
    rows: 5, allowedContinue: true, durationMs: 10, walBytes: 1024,
    totalWalBytes: 1024, replicaLagSeconds: 0,
  });
  assert.equal((await budget.runPage(async () => 5)).allowedContinue, false);
});

test("cleanup budget fails closed when evidence is unavailable", async () => {
  const budget = createReceiptCleanupBudget({ snapshot: async () => { throw new Error("down"); } });
  const result = await budget.runPage(async () => assert.fail("deletion must not start"));
  assert.equal(result.allowedContinue, false);
  assert.equal(result.rows, 0);
  assert.equal(result.evidenceUnavailable, true);
});

test("a failed evidence gate latches the whole cleanup run across table families", async () => {
  let snapshots = 0;
  let operations = 0;
  const budget = createReceiptCleanupBudget({
    snapshot: async () => ({
      lsn: `0/${++snapshots}`,
      replicaLagSeconds: snapshots === 2 ? 6 : 0,
    }),
    walBytesBetween: async () => 1,
    nowMs: (() => { let value = 0; return () => (value += 1); })(),
  });
  assert.equal((await budget.runPage(async () => { operations += 1; return 5; })).allowedContinue, false);
  const nextFamily = await budget.runPage(async () => { operations += 1; return 5; });
  assert.equal(nextFamily.allowedContinue, false);
  assert.equal(nextFamily.stopped, true);
  assert.equal(operations, 1, "a later cleanup family must not delete after the latch trips");
});

test("retention shares one ten-page destructive budget across every cleanup family", async () => {
  let pages = 0;
  let eventPages = 0;
  let schedulePayloadPages = 0;
  let eventReceiptPages = 0;
  let scheduleReceiptPages = 0;
  const cleanupBudget = {
    async runPage(operation) {
      pages += 1;
      return { rows: await operation(), allowedContinue: true, durationMs: 1, walBytes: 1 };
    },
  };
  const run = buildDomainEventRetention({
    prisma: {},
    now: () => new Date("2026-09-02T12:00:00Z"),
    JobRun: { async lastRanFor() { return null; }, async claimRun() { return true; } },
    isReceiptCleanupCutoffAccepted: async () => true,
    cleanupBudget,
    repository: {
      async deleteRetentionPage() {
        eventPages += 1;
        return eventPages <= 3 ? 500 : 0;
      },
    },
    eventReceipts: {
      async backfillPage() { return 0; },
      async cleanupDeletedSources() { eventReceiptPages += 1; return 500; },
    },
    scheduleReceipts: {
      async backfillPage() { return 0; },
      async cleanupTerminalPayloads() { schedulePayloadPages += 1; return 500; },
      async cleanupEligible() { scheduleReceiptPages += 1; return 500; },
    },
    logger: { log() {}, error() {} },
  });
  await run();
  assert.equal(pages, MAX_PAGES);
  assert.equal(eventPages, 4);
  assert.equal(schedulePayloadPages, 6);
  assert.equal(eventReceiptPages, 0);
  assert.equal(scheduleReceiptPages, 0);
});
