const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveDatabasePoolConfig,
} = require("../../src/shared/config/databasePoolConfig");

const ROLE_CASES = [
  ["http", "DATABASE_POOL_MAX_HTTP", "10"],
  ["resolution", "DATABASE_POOL_MAX_RESOLUTION", "8"],
  ["cron", "DATABASE_POOL_MAX_CRON", "4"],
  ["all", "DATABASE_POOL_MAX_ALL", "10"],
];

test("every known role resolves its exact role-specific value and source", () => {
  for (const [role, source, raw] of ROLE_CASES) {
    assert.deepEqual(resolveDatabasePoolConfig({
      NODE_ENV: "test",
      STEPS_PROCESS_ROLE: role,
      [source]: raw,
      DATABASE_POOL_MAX_DEFAULT: "19",
    }), { role, max: Number(raw), source });
  }
});

test("non-production falls through to the generic and compatibility defaults", () => {
  assert.deepEqual(resolveDatabasePoolConfig({
    NODE_ENV: "test",
    STEPS_PROCESS_ROLE: "http",
    DATABASE_POOL_MAX_DEFAULT: "17",
  }), { role: "http", max: 17, source: "DATABASE_POOL_MAX_DEFAULT" });
  assert.deepEqual(resolveDatabasePoolConfig({ NODE_ENV: "development" }), {
    role: "all",
    max: 20,
    source: "compatibility-default",
  });
  assert.deepEqual(resolveDatabasePoolConfig({
    NODE_ENV: "test",
    STEPS_PROCESS_ROLE: "one-off-tool",
  }), { role: "one-off-tool", max: 20, source: "compatibility-default" });
});

test("deployment A production requires a known role and safely defaults until role values land", () => {
  assert.throws(
    () => resolveDatabasePoolConfig({
      NODE_ENV: "production",
      DATABASE_POOL_MAX_ALL: "10",
    }),
    /STEPS_PROCESS_ROLE/,
  );
  assert.throws(
    () => resolveDatabasePoolConfig({ NODE_ENV: "production", STEPS_PROCESS_ROLE: "worker" }),
    /STEPS_PROCESS_ROLE/,
  );
  assert.deepEqual(resolveDatabasePoolConfig({
    NODE_ENV: "production",
    STEPS_PROCESS_ROLE: "http",
    DATABASE_POOL_MAX_DEFAULT: "10",
  }), { role: "http", max: 20, source: "compatibility-default" });
});

test("every supplied role/default value uses canonical base-10 parsing from 1 through 50", () => {
  const malformed = ["", " 10", "10 ", "+10", "-1", "0", "1.0", "0x10", "01", "51", "Infinity", "NaN"];
  for (const value of malformed) {
    assert.throws(
      () => resolveDatabasePoolConfig({
        NODE_ENV: "test",
        STEPS_PROCESS_ROLE: "http",
        DATABASE_POOL_MAX_HTTP: value,
      }),
      /DATABASE_POOL_MAX_HTTP.*1 through 50/,
      `value=${JSON.stringify(value)}`,
    );
  }
  assert.equal(resolveDatabasePoolConfig({
    NODE_ENV: "test",
    STEPS_PROCESS_ROLE: "http",
    DATABASE_POOL_MAX_HTTP: "1",
  }).max, 1);
  assert.equal(resolveDatabasePoolConfig({
    NODE_ENV: "test",
    STEPS_PROCESS_ROLE: "http",
    DATABASE_POOL_MAX_HTTP: "50",
  }).max, 50);
});

test("malformed supplied values fail even when they belong to another ordinary role", () => {
  assert.throws(
    () => resolveDatabasePoolConfig({
      NODE_ENV: "test",
      STEPS_PROCESS_ROLE: "http",
      DATABASE_POOL_MAX_HTTP: "10",
      DATABASE_POOL_MAX_CRON: "4 ",
    }),
    /DATABASE_POOL_MAX_CRON/,
  );
  assert.throws(
    () => resolveDatabasePoolConfig({
      NODE_ENV: "test",
      DATABASE_POOL_TOTAL_BUDGET: "32.0",
    }),
    /DATABASE_POOL_TOTAL_BUDGET/,
  );
});

test("validated capacity mode keeps isolated DB_POOL_MAX precedence", () => {
  const seen = [];
  const env = {
    NODE_ENV: "production",
    CAPACITY_MODE: "true",
    DB_POOL_MAX: "7",
    STEPS_PROCESS_ROLE: "http",
    DATABASE_POOL_MAX_HTTP: "not-active-in-capacity-mode",
  };
  assert.deepEqual(resolveDatabasePoolConfig(env, {
    capacityDatabasePoolMax(injected) {
      seen.push(injected);
      return 7;
    },
  }), { role: "http", max: 7, source: "DB_POOL_MAX" });
  assert.deepEqual(seen, [env]);
});
