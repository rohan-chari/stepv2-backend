const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fixtureCensus,
  assertGlobalEventSyncFixtureDatabase,
  buildRunMarker,
  cleanupOrder,
  assertCapacityVmEndpoint,
  normalizeGlobalEventSyncManifest,
} = require("../../../src/modules/loadTesting/globalEventSyncFixture");

test("fixture census is deterministic and exposes overlap/sample cardinality", () => {
  const census = fixtureCensus({ users: 10, participantsPerRace: 50, racesPerUser: 2, overlap: 0.8, samplesPerParticipant: 6, eligibleSummaryCount: 7 });
  assert.equal(census.users, 10);
  assert.equal(census.eligibleSummaryWork, 7);
  assert.equal(census.samples, census.participants * 6);
  assert.equal(census.races, 2);
  assert.equal(census.overlap, 0.8);
});

test("fixture census supports the documented race-size ladder", () => {
  const census = fixtureCensus({ users: 500, participantsPerRace: 50, racesPerUser: 5, raceSizes: [10, 50, 100, 250, 500], overlap: 0.5, samplesPerParticipant: 1, eligibleSummaryCount: 10 });
  assert.deepEqual(census.raceSizes, [10, 50, 100, 250, 500]);
  assert.equal(census.participants, 910);
  assert.equal(census.samples, 910);
});

test("fixture database guard rejects production and public targets", () => {
  assert.throws(() => assertGlobalEventSyncFixtureDatabase({
    DATABASE_URL: "postgresql://u:pw@167.172.225.16/steptracker",
  }), /production|public|capacity/i);
  assert.throws(() => assertGlobalEventSyncFixtureDatabase({
    CAPACITY_MODE: "true", CAPACITY_DB_HOST_ALLOWLIST: "127.0.0.1", CAPACITY_DB_NAME: "steps_tracker_capacity",
    DATABASE_URL: "postgresql://u:pw@127.0.0.1/steps_tracker_capacity", CAPACITY_RUN_ID: "sync-run-1",
    CAPACITY_DB_MARKER: "marker-with-at-least-16",
  }), /scrub|attestation|outbound/i);
});

test("run marker and cleanup order are manifest scoped", () => {
  assert.equal(buildRunMarker("sync-run-1"), "global-event-step-sync:sync-run-1");
  assert.deepEqual(cleanupOrder(), ["domain_event_audience", "domain_event_outbox", "global_event_capture_artifacts", "global_event_summary_work", "global_event_race_impacts", "global_step_event_entitlements", "global_step_events", "race_active_effects", "race_powerup_events", "step_samples", "steps", "race_participants", "races", "user_scoring_input_versions", "users"]);
});

test("capacity endpoint guard verifies private URL and run identity", async () => {
  await assert.rejects(() => assertCapacityVmEndpoint("https://steptracker-api.org", { runId: "sync-run-1" }), /private|production/i);
  await assert.rejects(() => assertCapacityVmEndpoint("http://127.0.0.1:3000", { runId: "sync-run-1", fetchImpl: async () => ({ ok: true, json: async () => ({ capacity: { runId: "other", globalEventProfile: "eligible-overlap" } }) }) }), /identity/i);
});

test("manifest normalization accepts wrapped and canonical fixture artifacts", () => {
  const canonical = { schema: "global-event-step-sync-fixture-v1", runId: "sync-run-1", users: [{ id: "u-1" }], ids: { users: ["u-1"] } };
  assert.deepEqual(normalizeGlobalEventSyncManifest(canonical), canonical);
  assert.deepEqual(normalizeGlobalEventSyncManifest({ manifest: { ...canonical, users: undefined }, users: canonical.users }), canonical);
});
