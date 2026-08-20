const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");

test("production refuses PRISMA_QUERY_EVENTS_ENABLED before Prisma construction", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", "require('./src/db')"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PRISMA_QUERY_EVENTS_ENABLED: "true",
        DATABASE_URL:
          "postgresql://integration-test-only@127.0.0.1:1/not_contacted_test",
      },
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /PRISMA_QUERY_EVENTS_ENABLED.*production/i,
  );
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /ECONNREFUSED|connection refused/i,
    "the guard must throw before Prisma or pg attempts a connection",
  );
});
