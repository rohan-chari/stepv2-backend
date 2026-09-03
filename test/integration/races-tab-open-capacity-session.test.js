const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, beforeEach, describe, it } = require("node:test");

const { buildRacesTabFixtureFile, captureExpectedProjections, normalizeRacesTabEvidence } =
  require("../../performance/workloads/races-tab-open");
const { runRacesTabOpenSession } = require("../../src/modules/loadTesting/racesTabOpenSession");
const { cleanupRacesTabOpenFixtures, createRacesTabOpenFixtures } =
  require("../../src/modules/loadTesting/racesTabOpenFixtures");
const { appSettings } = require("../../src/shared/config/appSettings");
const { projectRacesTabPayload } = require(
  "../../src/modules/loadTesting/racesTabOpenProjection");
const { REQUIRED_COVERAGE_VARIANTS, observedCoverageVariants } = require(
  "../../src/modules/loadTesting/racesTabOpenProjection");
const { cleanDatabase, createTestUser, getSharedServer, prisma } = require("./setup");

let server;

async function durableCensus() {
  const [row] = await prisma.$queryRawUnsafe(`SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM races) AS races,
    (SELECT count(*)::int FROM race_participants) AS participants,
    (SELECT count(*)::int FROM friendships) AS friendships,
    (SELECT count(*)::int FROM steps) AS steps,
    (SELECT count(*)::int FROM step_samples) AS samples,
    (SELECT count(*)::int FROM race_resolution_jobs_v2) AS queue_jobs,
    (SELECT count(*)::int FROM domain_event_outbox) AS domain_events`);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

describe("Races-tab capacity session public HTTP contract", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("apiRaceListCompactV1Enabled", true);
    await appSettings.setFlag("apiFriendsSummaryV1Enabled", true);
  });

  it("runs the current zero-friends reveal through real HTTP without durable writes", async () => {
    const viewer = await createTestUser({ displayName: "Races Capacity Viewer" });
    const before = await durableCensus();
    const result = await runRacesTabOpenSession({
      baseUrl: server.baseUrl,
      context: { userIndex: 0, zeroFriends: true },
      requestOne: async ({ baseUrl, entry }) => {
        const query = entry.query ? `?${entry.query}` : "";
        const response = await fetch(`${baseUrl}${entry.path}${query}`, {
          headers: { ...entry.headers, Authorization: `Bearer ${viewer.token}` },
        });
        let body = null;
        try { body = await response.json(); } catch {}
        return { status: response.status, body, timeout: false,
          unexpectedStatus: response.status !== 200, latencyMs: 1 };
      },
    });
    assert.equal(result.coreComplete, true);
    assert.equal(result.discovery.complete, true);
    assert.equal(result.friends.selected, true);
    assert.equal(result.friends.complete, true);
    assert.deepEqual(result.endpointCounts, {
      "GET /races": 1,
      "GET /races/discovery-summary": 1,
      "GET /friends": 1,
    });
    assert.deepEqual(await durableCensus(), before);
  });

  it("materializes authenticated production-shaped zero/nonzero friends branches", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : "";
    assert.match(databaseName, /_test$/,
      "Races-tab fixture integration test requires the actual Prisma database to end in _test");
    const source = await Promise.all([0, 1, 2].map((index) =>
      createTestUser({ displayName: `Source ${index}` })));
    await prisma.friendship.create({ data: { requesterId: source[0].user.id,
      addresseeId: source[1].user.id, status: "ACCEPTED" } });
    const fixture = await createRacesTabOpenFixtures({ prisma,
      runId: "races-fixture-integration", users: 12, arrivalRate: 5,
      env: { ...process.env, DATABASE_URL: databaseUrl }, minimumMeasuredSessions: 12,
      maximumCoverageAugmentationShare: 1,
      requiredCoverageVariants: ["ordinary_classic_active"],
      materializeFullPageFixtures: async () => ({ manifestIds: {}, naturallyGenerated: {},
        augmented: {}, sourceZeroVariants: [] }) });
    try {
      assert.equal(fixture.users.filter((user) => user.zeroFriends).length, 4);
      for (const zeroFriends of [true, false]) {
        const user = fixture.users.find((candidate) => candidate.zeroFriends === zeroFriends);
        const result = await runRacesTabOpenSession({ baseUrl: server.baseUrl,
          context: { userIndex: 0, zeroFriends },
          requestOne: async ({ baseUrl, entry }) => {
            const response = await fetch(`${baseUrl}${entry.path}${entry.query ? `?${entry.query}` : ""}`, {
              headers: { ...entry.headers, Authorization: `Bearer ${user.token}` },
            });
            return { status: response.status, body: await response.json(), timeout: false,
              unexpectedStatus: response.status !== 200, latencyMs: 1 };
          } });
        assert.equal(result.coreComplete, true);
        assert.equal(result.discovery.complete, true);
        assert.equal(result.friends.selected, zeroFriends);
        assert.equal(result.friends.complete, true);
      }
    } finally {
      await cleanupRacesTabOpenFixtures({ prisma, manifest: fixture.manifest });
    }
    assert.equal(await prisma.user.count(), 3);
  });

  it("materializes and reconciles the complete v2 API-backed page graph", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    assert.match(new URL(databaseUrl).pathname.slice(1), /_test$/);
    const source = await Promise.all([0, 1, 2].map((index) =>
      createTestUser({ displayName: `V2 source ${index}` })));
    await prisma.friendship.create({ data: { requesterId: source[0].user.id,
      addresseeId: source[1].user.id, status: "ACCEPTED" } });
    const fixture = await createRacesTabOpenFixtures({ prisma,
      runId: "races-v2-graph-integration", users: 28, arrivalRate: 5,
      env: { ...process.env, DATABASE_URL: databaseUrl }, minimumMeasuredSessions: 28,
      maximumCoverageAugmentationShare: 1 });
    try {
      await captureExpectedProjections({ fixture, baseUrl: server.baseUrl,
        runId: "races-v2-graph-integration", concurrency: 8 });
      assert.deepEqual(new Set(fixture.users.flatMap((row) => row.coverageVariants)),
        new Set(REQUIRED_COVERAGE_VARIANTS));
      const projections = fixture.users.map((row) => row.expectedProjection);
      const tournamentStates = new Set(projections.flatMap((projection) =>
        Object.values(projection.tournaments).flat().map((row) => row.renderState)));
      assert.deepEqual(tournamentStates,
        new Set(["invite", "lobby", "between_rounds", "live_match", "eliminated",
          "champion", "completed_non_champion"]));
      assert.ok(projections.some((projection) => Object.values(projection.ordinary).flat()
        .some((row) => row.kind === "team" && row.maxDurationDays === 14)));
      assert.ok(projections.some((projection) => projection.ordinaryInventoryByRace
        .some((row) => row.heldTypedItems.length > 0)));
      assert.ok(projections.some((projection) => projection.ordinaryEffectsByRace
        .some((row) => Object.keys(row.positive).length > 0)));
      assert.ok(projections.some((projection) => projection.ordinaryEffectsByRace
        .some((row) => Object.keys(row.negative).length > 0)));
      for (const [userIndex, user] of fixture.users.entries()) {
        const observedVariants = new Set(observedCoverageVariants(user.expectedProjection));
        for (const assigned of user.coverageVariants) assert.ok(observedVariants.has(assigned),
          `assigned fixture label ${assigned} must be proven by the actual HTTP response`);
        if (user.coverageVariants.some((variant) => variant.startsWith("tournament_") ||
            variant === "pinned_tournament")) {
          const tournamentRows = Object.values(user.expectedProjection.tournaments).flat();
          assert.ok(tournamentRows.some((row) => row.callerIdentity.equippedAccessories
            .some((item) => item.assetId === "cowboy_hat")),
          "real equipped accessory must be projected through GET /races");
        }
        if (user.coverageVariants.includes("tournament_live_match")) {
          assert.ok(user.expectedProjection.tournaments.active
            .some((row) => row.hasCurrentMatchRaceId && row.renderState === "live_match"));
        }
        const result = await runRacesTabOpenSession({ baseUrl: server.baseUrl,
          context: user, sequence: userIndex,
          requestOne: async ({ baseUrl, entry }) => {
            const response = await fetch(`${baseUrl}${entry.path}${entry.query ? `?${entry.query}` : ""}`, {
              headers: { ...entry.headers, Authorization: `Bearer ${user.token}` },
            });
            return { status: response.status, body: await response.json(), timeout: false,
              unexpectedStatus: response.status !== 200, latencyMs: 1 };
          } });
        assert.equal(result.content.matches, true,
          `fixture projection mismatch for ${user.coverageVariants.join(",")}: ${JSON.stringify(result.content.samples)}`);
      }
    } finally {
      await cleanupRacesTabOpenFixtures({ prisma, manifest: fixture.manifest });
    }
    assert.equal(await prisma.user.count(), 3);
  });

  it("executes the real k6 session and emits exact endpoint/branch metrics", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "races-tab-k6-integration-"));
    const fixturePath = path.join(directory, "fixture.json");
    const summaryPath = path.join(directory, "summary.json");
    try {
      const users = await Promise.all([0, 1].map((index) =>
        createTestUser({ displayName: `k6 Viewer ${index}` })));
      const fixture = buildRacesTabFixtureFile({ runId: "races-tab-k6-integration", fixture: {
        users: users.map((row, index) => ({ id: row.user.id, token: row.token,
          zeroFriends: index === 0,
          expectedProjectionVersion: "races-tab-open-projection-v2",
          expectedProjection: projectRacesTabPayload({
            core: { active: [], pending: [], completed: [], tournaments: [] },
            discovery: { publicRaceCount: 0 },
            friends: index === 0 ? { contract: "friends-summary-v1", friends: [] } : null,
            friendsShouldRequest: index === 0, viewerUserId: row.user.id,
          }), coverageVariants: [] })),
        topology: { zeroFriendsShare: 0.5, friendDistributionSourceHash: "a".repeat(64) },
      } });
      fs.writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
      const args = ["run", "--quiet", "--no-thresholds",
        "-e", `K6_BASE_URL=${server.baseUrl}`,
        "-e", `K6_FIXTURE_PATH=${fixturePath}`,
        "-e", `K6_SUMMARY_PATH=${summaryPath}`,
        "-e", "K6_RACES_TAB_RATE=2",
        "-e", "K6_RACES_TAB_MEASUREMENT_SECONDS=1",
        "-e", "K6_RACES_TAB_CORE_P95_MS=10000",
        "-e", "K6_RACES_TAB_CORE_P99_MS=10000",
        "-e", "K6_RACES_TAB_HTTP_ERROR_RATE=0.001",
        path.resolve(__dirname, "../../scripts/k6/races-tab-open.js")];
      const run = spawn("k6", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      run.stdout.on("data", (chunk) => { stdout += chunk; });
      run.stderr.on("data", (chunk) => { stderr += chunk; });
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { run.kill("SIGTERM"); reject(new Error("k6 timed out")); }, 45_000);
        run.once("error", reject);
        run.once("close", (code) => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      const count = (name) => summary.metrics[name]?.values?.count;
      assert.equal(count("races_tab_sessions_started{phase:measurement}"), 2);
      assert.equal(count("races_tab_sessions_core_refresh_complete{phase:measurement}"), 2);
      assert.equal(count("races_tab_discovery_completed{phase:measurement}"), 2);
      assert.equal(count("races_tab_friends_completed{phase:measurement}"), 1);
      assert.equal(count("http_reqs{endpoint:compact-races,phase:measurement,telemetry:sut}"), 2);
      assert.equal(count("http_reqs{endpoint:discovery-summary,phase:measurement,telemetry:sut}"), 2);
      assert.equal(count("http_reqs{endpoint:friends-summary,phase:measurement,telemetry:sut}"), 1);
      assert.equal(Number.isFinite(summary.metrics[
        "races_tab_endpoint_response_bytes{endpoint:compact-races,phase:measurement}"
      ]?.values?.["p(95)"]), true);
      const normalized = normalizeRacesTabEvidence({ summary, rate: 2,
        measurementSeconds: 1, fixture: { users: fixture.users,
          topology: { zeroFriendsShare: 0.5 } } });
      assert.equal(Number.isFinite(normalized.racesTabOpen.discovery.latencyMs.p95), true);
      assert.equal(Number.isFinite(normalized.racesTabOpen.discovery.latencyMs.p99), true);
      assert.equal(Number.isFinite(normalized.racesTabOpen.friends.latencyMs.p95), true);
      assert.equal(Number.isFinite(normalized.racesTabOpen.friends.latencyMs.p99), true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
