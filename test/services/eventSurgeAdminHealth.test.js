const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetSystemHealth } = require("../../src/modules/admin/queries/getSystemHealth");

test("admin health surfaces fresh event_surge_v1 Redis mirrors without making Redis authoritative", async () => {
  const now = new Date("2098-08-26T10:01:10.000Z");
  const surge = { schema: "event_surge_v1", role: "http", instance: "0", capturedAt: "2098-08-26T10:01:00.000Z" };
  const read = buildGetSystemHealth({
    now: () => now,
    snapshotReader: async () => ({ ok: false, values: [] }),
    historyReader: async () => ({ status: "unavailable", minutes: [] }),
    eventSurgeReader: async () => ({ ok: true, values: [surge, null, null, null] }),
  });
  const result = await read({ window: "60m" });
  assert.deepEqual(result.eventSurge, {
    status: "partial",
    freshProcesses: 1,
    snapshots: [surge],
  });
  assert.equal(result.overall, "unknown", "event telemetry cannot replace authoritative health inputs");
});
