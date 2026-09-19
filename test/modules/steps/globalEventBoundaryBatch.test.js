const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildGlobalEventBoundaryStreamWorker } = require("../../../src/modules/steps/jobs/globalEventBoundaryStreamWorker");

// Model doubles protect batching and handoff. The integration companion uses
// the real Postgres models to check the same entrypoint and transaction boundary.
function fixture(count) {
  let current = new Date("2098-09-19T12:00:00Z");
  const startsAt = new Date(current.getTime() - 60_000);
  const endsAt = new Date(current.getTime() + 29 * 60_000);
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `entitlement-${i}`, userId: `user-${i}`, eventId: "event",
    startsAt, endsAt, scheduleRevision: 0, startOutcome: "PENDING",
  }));
  const participants = rows.map((row, i) => ({
    id: `participant-${i}`, userId: row.userId, raceId: "shared-race",
    joinedAt: new Date(startsAt.getTime() - 1000),
    race: { startedAt: new Date(startsAt.getTime() - 1000), endsAt: null },
  }));
  const impacts = new Map();
  const receipts = new Map();
  const messages = [];
  const acknowledged = [];
  const scopes = [];
  const invalidations = [];
  let transactions = 0;
  let inTransaction = false;
  let failFanout = false;
  const prisma = {
    globalStepEventEntitlement: {
      async findMany({ where }) { return rows.filter((row) => where.id.in.includes(row.id)); },
      async updateMany({ where, data }) {
        for (const row of rows) if (where.id.in.includes(row.id)) Object.assign(row, data);
      },
    },
    raceParticipant: {
      async findMany({ where }) { return participants.filter((row) => where.userId.in.includes(row.userId)); },
    },
    globalEventRaceImpact: {
      async findMany({ where }) {
        return [...impacts.values()].filter((row) => where.OR.some((source) => source.eventId === row.eventId && source.userId === row.userId));
      },
      async createMany({ data }) { for (const row of data) impacts.set(`${row.raceId}:${row.userId}`, row); },
    },
    async $transaction(fn) {
      transactions += 1;
      inTransaction = true;
      try { return await fn(prisma); } finally { inTransaction = false; }
    },
  };
  const queue = {
    STREAMS: { GLOBAL_EVENT_BOUNDARY: "boundary", RACE_DIRTY: "race", NOTIFICATION_DELIVERY: "notification" },
    GROUPS: { GLOBAL_EVENT_BOUNDARY: "boundary-workers" },
    async publish(stream, fields) {
      assert.equal(inTransaction, false, "fanout must follow the database commit");
      if (failFanout && stream === "notification") throw new Error("publish unavailable");
      messages.push({ stream, fields });
    },
    async ack(_stream, _group, id) { acknowledged.push(id); },
    async withCommandClient(fn) {
      return fn({
        async mget(...keys) { return keys.map((key) => receipts.get(key) || null); },
        async set(key, value) { receipts.set(key, value); },
      });
    },
  };
  const worker = buildGlobalEventBoundaryStreamWorker({
    prisma, queue, now: () => current,
    acquireRaceWriteFencesSetBased: async () => {},
    acquireGlobalEnrollmentLock: async () => {},
    stampEventRecapStartCounts: async () => {},
    invalidateHomeActiveGlobalEvent: async (ids) => {
      assert.equal(inTransaction, false);
      invalidations.push(ids);
    },
    RaceResolutionJobV2: {
      async enqueueMany(input, tx) {
        assert.equal(tx, prisma);
        assert.equal(inTransaction, true, "race scope must be persisted with entitlement changes");
        scopes.push(input);
        return input.raceIds.map((raceId) => ({ raceId, generation: scopes.length }));
      },
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  const entries = (boundaryType) => rows.map((row, index) => ({
    id: `${boundaryType}-${index}`,
    fields: {
      schemaVersion: "1", boundaryType, entitlementId: row.id, scheduleRevision: "0",
      scheduledAt: (boundaryType === "START" ? startsAt : endsAt).toISOString(),
      enqueuedAt: current.toISOString(),
    },
  }));
  return {
    worker, rows, messages, scopes, invalidations, acknowledged, impacts, entries,
    transactions: () => transactions,
    end() { current = new Date(endsAt.getTime() + 1); },
    fail(value) { failFanout = value; },
  };
}

test("START and END group shared-race users without dropping scope", async () => {
  const f = fixture(5);
  assert.equal(await f.worker.processEntries(f.entries("START")), 5);
  assert.equal(f.transactions(), 1);
  assert.equal(f.impacts.size, 5);
  assert.deepEqual(f.scopes[0].triggeredUserIdsByRaceId.get("shared-race"), f.rows.map((row) => row.userId).sort());
  assert.equal(f.messages.filter((message) => message.stream === "race").length, 1);
  assert.equal(f.messages.filter((message) => message.stream === "notification").length, 5);
  assert.equal(f.invalidations.length, 1);
  assert.equal(f.invalidations[0].length, 5);
  f.end();
  assert.equal(await f.worker.processEntries(f.entries("END")), 5);
  assert.equal(f.transactions(), 2);
  assert.ok(f.rows.every((row) => row.endProcessedAt));
  assert.equal(f.messages.filter((message) => message.stream === "race").length, 2);
  assert.equal(f.messages.filter((message) => message.stream === "notification").length, 5);
});

test("large input is processed in bounded batches without waiting for a full last batch", async () => {
  const f = fixture(101);
  assert.equal(await f.worker.processEntries(f.entries("START")), 101);
  assert.equal(f.transactions(), 2);
  assert.equal(f.impacts.size, 101);
  assert.equal(f.messages.filter((message) => message.stream === "race").length, 2);
  assert.equal(f.messages.filter((message) => message.stream === "notification").length, 101);
});

test("failed fanout stays unacknowledged and completed receipts suppress replay", async () => {
  const f = fixture(3);
  const entries = f.entries("START");
  f.fail(true);
  assert.equal(await f.worker.processEntries(entries), 0);
  assert.equal(f.acknowledged.length, 0);
  assert.equal(f.impacts.size, 3);
  f.fail(false);
  assert.equal(await f.worker.processEntries(entries), 3);
  assert.equal(f.impacts.size, 3);
  const sent = f.messages.length;
  const transactions = f.transactions();
  assert.equal(await f.worker.processEntries(entries), 3);
  assert.equal(f.messages.length, sent);
  assert.equal(f.transactions(), transactions);
});
