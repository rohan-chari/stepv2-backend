const assert = require("node:assert/strict");
const test = require("node:test");
const { buildHistoricalRaceDiscovery, MAX_DISCOVERY_LIMIT } = require("../../src/modules/races/services/historicalRaceDiscovery");

test("historical discovery is membership-first, bounded, and keyset paginated", async () => {
  let sql = ""; let args;
  const find = buildHistoricalRaceDiscovery({ prisma: { $queryRawUnsafe: async (...values) => { sql = values[0]; args = values.slice(1); return Array.from({ length: 100 }, (_, i) => ({ raceId: `r${i}`, participantId: `p${i}`, raceStatus: "completed" })); } }, now: () => new Date("2026-09-16T12:00:00Z") });
  const result = await find({ userId: "u1", changedStart: "2026-09-16T11:00:00Z", changedEnd: "2026-09-16T12:00:00Z", cursor: { raceId: "r1", participantId: "p1" }, limit: 999 });
  assert.match(sql, /FROM race_participants participant/);
  assert.doesNotMatch(sql, /step_samples|race_active_effects/);
  assert.equal(args.at(-1), MAX_DISCOVERY_LIMIT);
  assert.deepEqual(result.nextCursor, { raceId: "r99", participantId: "p99" });
});

test("out-of-horizon changes do not query the database", async () => {
  let calls = 0;
  const find = buildHistoricalRaceDiscovery({ prisma: { $queryRawUnsafe: async () => { calls += 1; return []; } }, now: () => new Date("2026-09-16T12:00:00Z") });
  const result = await find({ userId: "u1", changedStart: "2026-07-01T00:00:00Z", changedEnd: "2026-07-01T01:00:00Z" });
  assert.equal(calls, 0);
  assert.equal(result.outOfHorizon, true);
});
