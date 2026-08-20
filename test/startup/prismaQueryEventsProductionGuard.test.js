const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const stagingUrl =
  "postgresql://staging-query-events@127.0.0.1:1/bara-staging-pool";

function loadDb(overrides = {}, source = "require('./src/db')") {
  return spawnSync(process.execPath, ["-e", source], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PRISMA_QUERY_EVENTS_ENABLED: "true",
      PORT: "3003",
      DATABASE_URL: stagingUrl,
      ...overrides,
    },
    encoding: "utf8",
  });
}

function assertRejectedBeforePrisma(overrides, label) {
  const result = loadDb(overrides);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, label);
  assert.match(output, /PRISMA_QUERY_EVENTS_ENABLED.*staging/i, label);
  assert.doesNotMatch(
    output,
    /ECONNREFUSED|connection refused/i,
    `${label}: guard must throw before Prisma or pg attempts a connection`,
  );
}

test("production-mode staging explicitly allows Prisma query events", () => {
  const result = loadDb();
  assert.equal(
    result.status,
    0,
    `${result.stdout}\n${result.stderr}`,
  );
});

test("capacity-only database pool sizing survives the staging query-event guard", () => {
  const result = loadDb(
    {
      NODE_ENV: "test",
      PRISMA_QUERY_EVENTS_ENABLED: "false",
      CAPACITY_MODE: "true",
      CAPACITY_RUN_ID: "phase2-pool-check",
      CAPACITY_DB_MARKER: "phase2-pool-marker-proof",
      CAPACITY_DB_HOST_ALLOWLIST: "127.0.0.1",
      CAPACITY_DB_NAME: "capacity_pool_test",
      DATABASE_URL:
        "postgresql://capacity-pool@127.0.0.1:1/capacity_pool_test",
      DB_POOL_MAX: "7",
    },
    "process.stdout.write(String(require('./src/db').getDbPoolPressure().max))",
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout.trim(), /(?:^|\n)7$/);
});

test("production database identity is rejected even on the staging port", () => {
  assertRejectedBeforePrisma(
    {
      DATABASE_URL:
        "postgresql://production-query-events@127.0.0.1:1/step-tracker-pool",
    },
    "production database",
  );
});

test("staging database identity is rejected on the production port", () => {
  assertRejectedBeforePrisma({ PORT: "3002" }, "production port");
});

test("missing and malformed database identities fail closed", () => {
  for (const DATABASE_URL of ["", "not a database url", "://bad"]) {
    assertRejectedBeforePrisma({ DATABASE_URL }, `DATABASE_URL=${DATABASE_URL}`);
  }
});

test("lookalike staging database names and query-string spoofs are rejected", () => {
  for (const DATABASE_URL of [
    "postgresql://query-events@127.0.0.1:1/bara-staging-pool-copy",
    "postgresql://query-events@127.0.0.1:1/step-tracker-pool?database=bara-staging-pool",
    "postgresql://query-events@127.0.0.1:1/staging/bara-staging-pool",
    "postgresql://query-events@127.0.0.1:1/step-tracker-staging",
  ]) {
    assertRejectedBeforePrisma({ DATABASE_URL }, DATABASE_URL);
  }
});
