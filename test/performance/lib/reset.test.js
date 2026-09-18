const assert = require("node:assert/strict");
const test = require("node:test");

const { DEFAULT_SELECTORS, buildResetPlan, targetedReset } = require("../../../performance/lib/reset");

test("reset plan is allowlisted from schema columns and preserves fixture parents", () => {
  const plan = buildResetPlan([
    { table_name: "users", column_name: "id" },
    { table_name: "races", column_name: "id" },
    { table_name: "race_participants", column_name: "user_id" },
    { table_name: "step_sync_requests", column_name: "user_id" },
    { table_name: "race_resolution_jobs_v2", column_name: "race_id" },
    { table_name: "notifications", column_name: "user_id" },
  ], [
    { table: "step_sync_requests", column: "user_id", scope: "user" },
    { table: "race_resolution_jobs_v2", column: "race_id", scope: "race" },
    { table: "notifications", column: "user_id", scope: "user" },
  ]);
  assert.deepEqual(plan.tables, [
    { table: "notifications", userColumn: true, raceColumn: false,
      userColumns: ["user_id"], raceColumns: [] },
    { table: "race_resolution_jobs_v2", userColumn: false, raceColumn: true,
      userColumns: [], raceColumns: ["race_id"] },
    { table: "step_sync_requests", userColumn: true, raceColumn: false,
      userColumns: ["user_id"], raceColumns: [] },
  ]);
  assert.deepEqual(plan.preservedTables, ["race_participants", "races", "users"]);
});

test("reset selectors cover durable receipt columns without coupling to queue model files", () => {
  const selectors = [
    { table: "notification_schedule_receipts", column: "recipient_user_id", scope: "user" },
    { table: "domain_event_receipts", column: "aggregate_id", scope: "race" },
  ];
  const plan = buildResetPlan([
    { table_name: "notification_schedule_receipts", column_name: "recipient_user_id" },
    { table_name: "domain_event_receipts", column_name: "aggregate_id" },
  ], selectors);
  assert.deepEqual(plan.tables, [
    { table: "domain_event_receipts", userColumn: false, raceColumn: true,
      userColumns: [], raceColumns: ["aggregate_id"] },
    { table: "notification_schedule_receipts", userColumn: true, raceColumn: false,
      userColumns: ["recipient_user_id"], raceColumns: [] },
  ]);
});

test("reset discovery has no delete-every-user/race-column wildcard", () => {
  assert.equal(DEFAULT_SELECTORS.some((row) => row.table === "*"), false);
  assert.throws(() => buildResetPlan([
    { table_name: "unreviewed_table", column_name: "user_id" },
  ], []), /selector|allowlist/i);
});

test("targeted reset is bounded to fixture IDs, retries FK order, and never truncates", async () => {
  const statements = [];
  const tx = {
    $executeRawUnsafe: async (sql) => { statements.push(sql); return 1; },
    $queryRawUnsafe: async (sql) => {
      statements.push(sql);
      if (sql.includes("AS remaining")) return [{ remaining: 0 }];
      return [];
    },
  };
  const result = await targetedReset({
    prisma: { $transaction: async (operation) => operation(tx) },
    fixture: { runId: "perf-fixture", ids: { users: ["user-1"], races: ["race-1"],
      raceParticipants: ["participant-1"] }, participantBaselineAt: "2026-09-02T00:00:00.000Z",
      participantBaselines: [{ id: "participant-1", totalSteps: 1234,
        lastNotifiedPlacement: 1 }] },
    plan: { schema: "bara-perf-reset-plan-v1", tables: [
      { table: "step_sync_requests", userColumn: true, raceColumn: false },
      { table: "race_resolution_jobs_v2", userColumn: false, raceColumn: true },
    ] },
    verifyMarker: async () => ({ runId: "perf-fixture" }),
  });
  assert.equal(result.schema, "bara-perf-targeted-reset-v1");
  assert.equal(result.proof.remainingRunOwnedRows, 0);
  assert.equal(statements.some((sql) => /\bTRUNCATE\b/i.test(sql)), false);
  assert.equal(statements.every((sql) => !/DELETE FROM "users"|DELETE FROM "races"/i.test(sql)), true);
  assert.ok(statements.some((sql) => /DELETE FROM "step_sync_requests".*user_id/i.test(sql)));
  assert.ok(statements.some((sql) => /UPDATE\s+"?race_participants"?/i.test(sql)));
  assert.ok(statements.some((sql) => /jsonb_to_recordset/i.test(sql)));
  assert.ok(statements.some((sql) => /UPDATE "users"[\s\S]*"last_step_sync_at" = NULL/i.test(sql)));
});

test("targeted reset refuses a missing durable database marker before transaction", async () => {
  let transacted = false;
  await assert.rejects(targetedReset({
    prisma: { $transaction: async () => { transacted = true; } },
    fixture: { runId: "perf-fixture", ids: { users: [], races: [], raceParticipants: [] } },
    plan: { schema: "bara-perf-reset-plan-v1", tables: [] },
    verifyMarker: async () => { throw new Error("marker absent"); },
  }), /marker absent/);
  assert.equal(transacted, false);
});
