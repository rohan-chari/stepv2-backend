const assert = require("node:assert/strict");
const test = require("node:test");

const { MIGRATIONS, teamOnlyRallyFlag, diff } = require("../../scripts/balance-apply");
const { validateConfig } = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

// docs/team-only-drop-pool-requirements.md §5.3. The script's transform is a
// pure function precisely so the risky part (what it writes) can be proved
// without pointing anything at a database — the DB half is dry-run by default
// and reviewed by hand.

// A stored config as it exists in prod TODAY: RALLY_FLAG store-only, absent from
// the drop pool, and no `teamOnlyTypes` key at all.
function preMigrationStoredConfig() {
  const config = defaultConfig();
  delete config.teamOnlyTypes;
  config.storeOnlyTypes = [...config.storeOnlyTypes, "RALLY_FLAG"];
  config.dropPool.UNCOMMON = config.dropPool.UNCOMMON.filter((t) => t !== "RALLY_FLAG");
  return config;
}

test("the migration performs exactly the three §5.1 edits", () => {
  const before = preMigrationStoredConfig();
  const after = teamOnlyRallyFlag(before);

  assert.deepEqual(after.teamOnlyTypes, ["RALLY_FLAG"]);
  assert.ok(!after.storeOnlyTypes.includes("RALLY_FLAG"));
  assert.ok(after.dropPool.UNCOMMON.includes("RALLY_FLAG"));
  assert.ok(
    after.dailyBoxExcludedTypes.includes("RALLY_FLAG"),
    "the daily box must still never award it"
  );
});

test("the migration does not mutate its input", () => {
  const before = preMigrationStoredConfig();
  const snapshot = JSON.stringify(before);
  teamOnlyRallyFlag(before);
  assert.equal(JSON.stringify(before), snapshot);
});

test("the migrated config passes validateConfig — it must not bypass validation", () => {
  const errors = validateConfig(teamOnlyRallyFlag(preMigrationStoredConfig()));
  assert.deepEqual(
    errors,
    [],
    `the script would refuse to write: ${errors.map((e) => e.message).join(" | ")}`
  );
});

test("the migration is idempotent — re-running produces an empty diff", () => {
  const once = teamOnlyRallyFlag(preMigrationStoredConfig());
  const twice = teamOnlyRallyFlag(once);
  assert.deepEqual(diff(once, twice), []);
});

test("the migration leaves every other key alone", () => {
  const before = preMigrationStoredConfig();
  const changed = diff(before, teamOnlyRallyFlag(before)).map((c) => c.path);
  for (const path of changed) {
    assert.ok(
      path === "teamOnlyTypes" ||
        path === "storeOnlyTypes" ||
        path === "dropPool.UNCOMMON",
      `unexpected key touched by the migration: ${path}`
    );
  }
  assert.ok(changed.length > 0, "the migration must actually do something");
});

test("the migration is registered under the documented name", () => {
  assert.ok(MIGRATIONS["team-only-rally-flag"]);
  assert.equal(typeof MIGRATIONS["team-only-rally-flag"].apply, "function");
});
