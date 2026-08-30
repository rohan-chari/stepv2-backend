const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const secretUrl = "postgresql://secret-user:never-print-this@127.0.0.1:1/pool_config_test";

function loadDb(overrides = {}, options = {}) {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    DOTENV_CONFIG_QUIET: "true",
    DATABASE_URL: secretUrl,
    STEPS_PROCESS_ROLE: "http",
    DATABASE_POOL_MAX_HTTP: "10",
    ...overrides,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete env[name];
  }
  const entrySetup = options.entry
    ? `process.argv[1] = ${JSON.stringify(path.join(repoRoot, options.entry))};`
    : "";
  return spawnSync(process.execPath, ["-e", `${entrySetup}process.stdout.write(JSON.stringify(require('./src/db').databasePoolConfig))`], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function assertStartupRejected(overrides, variable) {
  const result = loadDb(overrides);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, new RegExp(variable));
  assert.doesNotMatch(output, /never-print-this|secret-user/);
  assert.doesNotMatch(output, /ECONNREFUSED|connection refused/i);
}

test("production role-specific max reaches the constructed pg pool", () => {
  const result = loadDb();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    role: "http",
    max: 10,
    source: "DATABASE_POOL_MAX_HTTP",
  });
});

test("audited unprefixed production deploy commands use a bounded maintenance pool", () => {
  for (const [command, entry] of [
    ["powerups:copy:sync", "scripts/powerup-copy-sync.js"],
    ["balance:drift", "scripts/balance-drift-report.js"],
    ["referral-contest:catch-up", "scripts/referral-contest-ledger-catch-up.js"],
  ]) {
    const result = loadDb({
      STEPS_PROCESS_ROLE: null,
      DATABASE_POOL_MAX_HTTP: null,
      npm_lifecycle_event: command,
    }, { entry });
    assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      role: "maintenance",
      max: 2,
      source: "maintenance-default",
      command,
    });
  }
});

test("real npm deploy commands pass pool authorization before reaching the test-only database", () => {
  for (const command of [
    "powerups:copy:sync",
    "balance:drift",
    "referral-contest:catch-up",
  ]) {
    const env = {
      ...process.env,
      NODE_ENV: "production",
      DOTENV_CONFIG_QUIET: "true",
      DATABASE_URL: secretUrl,
      DATABASE_POOL_MAX_MAINTENANCE: "1",
    };
    delete env.STEPS_PROCESS_ROLE;
    const result = spawnSync("npm", ["run", command], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.error?.code, "ETIMEDOUT", `${command}: ${output}`);
    assert.doesNotMatch(output, /STEPS_PROCESS_ROLE|DATABASE_POOL_MAX_MAINTENANCE/);
    assert.match(output, /ECONNREFUSED|connection refused|Can't reach database|could not read balance_config/i);
    assert.doesNotMatch(output, /never-print-this|secret-user/);
  }
});

test("production missing and unknown roles fail before a connection attempt", () => {
  assertStartupRejected({ STEPS_PROCESS_ROLE: "" }, "STEPS_PROCESS_ROLE");
  assertStartupRejected({ STEPS_PROCESS_ROLE: "unknown" }, "STEPS_PROCESS_ROLE");
});

test("deployment B production missing and malformed role values fail before a connection attempt", () => {
  assertStartupRejected({ DATABASE_POOL_MAX_HTTP: null }, "DATABASE_POOL_MAX_HTTP");
  assertStartupRejected({ DATABASE_POOL_MAX_HTTP: "" }, "DATABASE_POOL_MAX_HTTP");
  assertStartupRejected({ DATABASE_POOL_MAX_HTTP: "20.0" }, "DATABASE_POOL_MAX_HTTP");
});

test("capacity startup validates a production-shaped target before using the default pool maximum", () => {
  const result = loadDb({
    CAPACITY_MODE: "true",
    DB_POOL_MAX: null,
    DATABASE_URL: "postgresql://prod-user:never-print-this@127.0.0.1:1/step-tracker-pool",
    CAPACITY_RUN_ID: "pool-isolation-regression",
    CAPACITY_DB_MARKER: "pool-isolation-regression-marker",
    CAPACITY_DB_HOST_ALLOWLIST: "127.0.0.1",
    CAPACITY_DB_NAME: "step-tracker-pool",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /CAPACITY_DB_NAME.*capacity or test token/);
  assert.doesNotMatch(output, /never-print-this|prod-user|ECONNREFUSED/i);
});
