const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  AUTHORIZED_PRODUCTION_DATABASE_COMMANDS,
  resolveProductionCliDatabasePoolConfig,
} = require("../../src/shared/config/productionCliDatabasePoolConfig");

const repoRoot = path.resolve(__dirname, "../..");

test("only audited deploy-time database commands receive the bounded maintenance pool", () => {
  assert.deepEqual(AUTHORIZED_PRODUCTION_DATABASE_COMMANDS, {
    "balance:drift": "scripts/balance-drift-report.js",
    "powerups:copy:sync": "scripts/powerup-copy-sync.js",
    "referral-contest:catch-up": "scripts/referral-contest-ledger-catch-up.js",
  });
  const packageScripts = require("../../package.json").scripts;
  for (const [command, relativeEntry] of Object.entries(AUTHORIZED_PRODUCTION_DATABASE_COMMANDS)) {
    assert.equal(packageScripts[command], `node ${relativeEntry}`);
    assert.deepEqual(resolveProductionCliDatabasePoolConfig({
      NODE_ENV: "production",
      npm_lifecycle_event: command,
    }, path.join(repoRoot, relativeEntry)), {
      role: "maintenance",
      max: 2,
      source: "maintenance-default",
      command,
    });
  }
});

test("maintenance maximum is configurable, canonical, and bounded to 1 through 5", () => {
  const entry = path.join(repoRoot, "scripts/powerup-copy-sync.js");
  assert.deepEqual(resolveProductionCliDatabasePoolConfig({
    NODE_ENV: "production",
    npm_lifecycle_event: "powerups:copy:sync",
    DATABASE_POOL_MAX_MAINTENANCE: "5",
  }, entry), {
    role: "maintenance",
    max: 5,
    source: "DATABASE_POOL_MAX_MAINTENANCE",
    command: "powerups:copy:sync",
  });
  for (const value of ["", "0", "01", "1.0", "6", " 2"] ) {
    assert.throws(() => resolveProductionCliDatabasePoolConfig({
      NODE_ENV: "production",
      npm_lifecycle_event: "powerups:copy:sync",
      DATABASE_POOL_MAX_MAINTENANCE: value,
    }, entry), /DATABASE_POOL_MAX_MAINTENANCE.*1 through 5/);
  }
});

test("unknown, mismatched, non-production, and role-bearing processes are never authorized", () => {
  const copyEntry = path.join(repoRoot, "scripts/powerup-copy-sync.js");
  assert.equal(resolveProductionCliDatabasePoolConfig({
    NODE_ENV: "production",
    npm_lifecycle_event: "unknown",
  }, copyEntry), null);
  assert.equal(resolveProductionCliDatabasePoolConfig({
    NODE_ENV: "production",
    npm_lifecycle_event: "balance:drift",
  }, copyEntry), null);
  assert.equal(resolveProductionCliDatabasePoolConfig({
    NODE_ENV: "test",
    npm_lifecycle_event: "powerups:copy:sync",
  }, copyEntry), null);
  assert.equal(resolveProductionCliDatabasePoolConfig({
    NODE_ENV: "production",
    STEPS_PROCESS_ROLE: "http",
    npm_lifecycle_event: "powerups:copy:sync",
  }, copyEntry), null);
});
