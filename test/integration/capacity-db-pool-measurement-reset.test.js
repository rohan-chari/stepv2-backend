const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);

test("real capacity endpoint resets one idempotent pool epoch and excludes a crossing checkout", async () => {
  const databaseUrl = process.env.DATABASE_URL || "";
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  assert.match(databaseName, /_test$/, "capacity reset integration requires confirmed test DB");
  const runId = "pool-reset-integration";
  const child = path.join(__dirname, "fixtures/capacity-db-pool-reset-child.js");
  const { stdout } = await execFileAsync(process.execPath, [child], {
    cwd: path.resolve(__dirname, "../.."),
    timeout: 15_000,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      CAPACITY_MODE: "true",
      CAPACITY_RUN_ID: runId,
      CAPACITY_DB_MARKER: "integration-marker-material",
      CAPACITY_DB_NAME: databaseName,
      CAPACITY_DB_HOST_ALLOWLIST: parsed.hostname,
      CAPACITY_GLOBAL_EVENT_PROFILE: "home-open",
      CAPACITY_OUTBOUND_DISABLED: "true",
      CAPACITY_AUTH_SECRET: "integration-capacity-auth-secret-material",
      SESSION_TOKEN_SECRET: "integration-capacity-auth-secret-material",
      STEPS_PROCESS_ROLE: "cron",
      NODE_APP_INSTANCE: "0",
      DB_POOL_MAX: "1",
      NODE_ENV: "test",
      REDIS_URL: "",
    },
  });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.nonCapacityStatus, 404);
  assert.equal(result.wrongRunStatus, 403);
  assert.equal(result.firstStatus, 200);
  assert.equal(result.secondStatus, 200);
  assert.deepEqual(result.firstMeasurement, result.secondMeasurement,
    "repeating one measurement id must not clear or advance it again");
  assert.equal(result.afterCrossing.waitCount, 0,
    "checkout begun before reset and completed after must stay outside the epoch");
  assert.equal(result.afterCrossing.waitMsTotal, 0);
  assert.equal(result.afterCrossing.waitMsMax, 0);
  assert.equal(result.afterCrossing.waitMsP99, 0);
  assert.equal(result.afterCrossing.connectionFailures, 0);
  assert.equal(result.afterNewCheckout.waitCount, 1,
    "a checkout begun after reset must be measured");
  assert.equal(result.healthMeasurement.id, result.firstMeasurement.id);
  assert.equal(result.healthMeasurement.generation, result.firstMeasurement.generation);
});
