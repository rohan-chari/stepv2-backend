const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDeviceRegistrationCreateBatch,
} = require("../../src/modules/notifications/services/deviceRegistrationCreateBatch");

test("cold device registrations share one locked set-based transaction", async () => {
  const calls = [];
  const prisma = {
    async $transaction(run) {
      calls.push("transaction");
      return run({
        async $queryRawUnsafe(sql, payload) {
          calls.push(sql.includes("pg_advisory_xact_lock") ? "locks" : "insert");
          if (sql.includes("pg_advisory_xact_lock")) return [];
          return JSON.parse(payload).map((row) => ({
            requestIndex: row.requestIndex,
            id: row.id,
            userId: row.userId,
            token: row.token,
            platform: row.platform,
            installationId: row.installationId,
            providerEnvironment: row.providerEnvironment,
            lastRegisteredAt: new Date(row.now),
            status: "ACTIVE",
            statusReason: null,
            statusChangedAt: new Date(row.now),
            ownershipGeneration: 1,
            adminMetricsOpenCapable: row.adminMetricsOpenCapable,
            adminMetricsOpenEpochId: row.adminMetricsOpenEpochId,
          }));
        },
      });
    },
  };
  const batch = createDeviceRegistrationCreateBatch();
  const registrations = Array.from({ length: 40 }, (_, index) => ({
    userId: `user-${index}`,
    token: `token-${index}`,
    platform: "ios",
    installationId: `installation-${index}`,
    providerEnvironment: "sandbox",
    now: new Date("2026-08-31T14:00:00.000Z"),
    adminMetricsOpenCapable: false,
    adminMetricsOpenEpochId: null,
  }));

  const rows = await Promise.all(registrations.map((registration) =>
    batch.tryCreate({ prisma, registration })));

  assert.deepEqual(calls, ["transaction", "locks", "insert"]);
  assert.ok(rows.every((row, index) => row.userId === `user-${index}`));
});

test("stale exact registrations are refreshed inside the set-based path", () => {
  const { INSERT_SQL } = require(
    "../../src/modules/notifications/services/deviceRegistrationCreateBatch"
  );

  assert.match(INSERT_SQL, /refreshed AS \(/);
  assert.match(INSERT_SQL, /UPDATE device_tokens existing/);
  assert.match(INSERT_SQL, /last_registered_at=ranked\."now"/);
  assert.match(INSERT_SQL, /FROM refreshed/);
});
