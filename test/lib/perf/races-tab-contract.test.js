const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const repository = path.resolve(__dirname, "../../..");
const { parseCli } = require("../../../performance/lib/cli");
const { loadConfig } = require("../../../performance/lib/config");
const { buildManifest } = require("../../../performance/lib/report");

test("Races-tab workload selection is explicit while Home remains the default", () => {
  assert.equal(parseCli(["smoke"]).workload, "home-open");
  assert.equal(parseCli(["scan", "--workload=races-tab-open"]).workload,
    "races-tab-open");
  assert.throws(() => parseCli(["scan", "--workload=races"]), /workload/i);
});

test("Races-tab config locks the versioned workload and threshold contract", () => {
  const config = loadConfig({ repository, mode: "scan", workload: "races-tab-open" });
  assert.deepEqual(config.workload, {
    name: "authenticated-races-tab-reveal-v1",
    profileVersion: "1.0.0",
    scoreShape: "production",
    cohortWeight: 1,
    cohortSize: 5000,
    friendsCacheAgeSeconds: 5,
    sessionDeadlineSeconds: 31,
    gracefulStopSeconds: 32,
  });
  assert.equal(config.thresholds.racesCoreP95Ms, 1000);
  assert.equal(config.thresholds.racesCoreP99Ms, 2000);
  assert.equal(config.thresholds.incompleteRacesDiscovery, 0);
  assert.equal(config.thresholds.incompleteRacesFriends, 0);
});

test("manifest binds the selected workload profile immutably", () => {
  const workload = { name: "authenticated-races-tab-reveal-v1", profileVersion: "1.0.0" };
  const manifest = buildManifest({ runId: "races-run", mode: "scan", workload });
  assert.deepEqual(manifest.workload, workload);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "workload"), true);
});
