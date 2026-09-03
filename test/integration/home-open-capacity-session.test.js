const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");
const { PROFILES } = require("../../src/modules/loadTesting/contract");
const { cleanupHomeOpenFixtures, createHomeOpenFixtures } = require("../../src/modules/loadTesting/homeOpenFixtures");
const { runHomeOpenSession } = require("../../src/modules/loadTesting/runner");
const { buildRaceResolutionWorkerV2 } = require(
  "../../src/modules/races/jobs/raceResolutionQueueV2");
const { buildVerification } = require("../../scripts/k6-home-open");
const { targetedReset } = require("../../performance/lib/reset");
const { cleanDatabase, getSharedServer, prisma } = require("./setup");

describe("home-open capacity session public HTTP contract", () => {
  let server;
  before(async () => {
    const databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL || "").pathname.slice(1));
    assert.match(databaseName, /_test$/, "real-HTTP capacity integration must use confirmed test DB");
    server = await getSharedServer();
  });
  beforeEach(cleanDatabase);

  it("returns the exact integrity-table drift when cleanup detects baseline mutation", async () => {
    const snapshotUser = await prisma.user.create({ data: {
      appleId: `drift-${crypto.randomUUID()}`,
      email: `drift-${crypto.randomUUID()}@example.com`,
      displayName: "Before load",
    } });
    const runId = `home-drift-${crypto.randomUUID()}`.slice(0, 63);
    const fixture = await createHomeOpenFixtures({ prisma, runId, users: 2,
      arrivalRate: 1, env: process.env });
    await prisma.user.update({ where: { id: snapshotUser.id },
      data: { displayName: "Changed during load" } });

    const cleanup = await cleanupHomeOpenFixtures({ prisma, manifest: fixture.manifest });

    assert.equal(cleanup.cleaned, true);
    assert.equal(cleanup.noSyntheticRows, true);
    assert.equal(cleanup.baselineDriftObserved, true);
    assert.deepEqual(cleanup.baselineDrift.tables.map((row) => row.table), ["users"]);
    assert.deepEqual(cleanup.baselineDrift.tables[0].beforeCount, 1);
    assert.deepEqual(cleanup.baselineDrift.tables[0].afterCount, 1);
    assert.deepEqual(cleanup.baselineDrift.tables[0].countDelta, 0);
    assert.notEqual(cleanup.baselineDrift.tables[0].beforeChecksum,
      cleanup.baselineDrift.tables[0].afterChecksum);
  });

  it("creates the real fixture, runs the coherent session, verifies its report, and cleans up", async () => {
    const runId = `home-http-${crypto.randomUUID()}`.slice(0, 63);
    const metricsEpoch = await prisma.adminMetricsCollectionEpoch.create({
      data: { startedAt: new Date(Date.now() - 60_000) },
    });
    const snapshotUser = await prisma.user.create({ data: {
      appleId: `snapshot-${crypto.randomUUID()}`, email: `snapshot-${crypto.randomUUID()}@example.com`,
      displayName: "Snapshot Event User",
    } });
    const snapshotPeer = await prisma.user.create({ data: {
      appleId: `snapshot-${crypto.randomUUID()}`, email: `snapshot-${crypto.randomUUID()}@example.com`,
      displayName: "Snapshot Race Peer",
    } });
    const snapshotRace = await prisma.race.create({ data: {
      creatorId: snapshotUser.id, name: "Snapshot active race", targetSteps: 100000,
      status: "ACTIVE", startedAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 86_400_000), maxDurationDays: 2,
      maxParticipants: 100, isPublic: false,
    } });
    await prisma.raceParticipant.createMany({ data: [
      { raceId: snapshotRace.id, userId: snapshotUser.id, status: "ACCEPTED",
        joinedAt: new Date(Date.now() - 3_500_000), rawSteps: 12000, totalSteps: 12000,
        lastNotifiedPlacement: 1 },
      { raceId: snapshotRace.id, userId: snapshotPeer.id, status: "ACCEPTED",
        joinedAt: new Date(Date.now() - 3_400_000), rawSteps: 7000, totalSteps: 7000,
        lastNotifiedPlacement: 2 },
    ] });
    const activeEvent = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000),
      multiplier: 2, label: "snapshot-active-event",
    } });
    await prisma.globalEventSummaryWork.create({ data: {
      eventId: activeEvent.id, userId: snapshotUser.id, status: "WAITING_SYNC",
      expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const fixture = await createHomeOpenFixtures({ prisma, runId, users: 10, arrivalRate: 1, env: process.env });
    const fixtureParticipants = await prisma.raceParticipant.findMany({
      where: { id: { in: fixture.manifest.ids.raceParticipants } },
      select: { totalSteps: true, lastNotifiedPlacement: true },
    });
    assert.ok(fixtureParticipants.length > 0,
      "the real-HTTP fixture must exercise active race resolution");
    assert.ok(await prisma.raceParticipant.findFirst({ where: {
      userId: fixture.users[0].id, raceId: { in: fixture.manifest.ids.races },
    } }), "the uploaded fixture user must be an active race participant");
    assert.ok(new Set(fixture.users.map((row) => row.loadProfile.baselineSteps)).size > 1);
    assert.ok(fixtureParticipants.every((row) => Number.isInteger(row.lastNotifiedPlacement)));
    assert.equal(await prisma.step.count({ where: { id: { in: fixture.manifest.ids.steps } } }), 10);
    assert.equal(await prisma.stepSample.count({
      where: { id: { in: fixture.manifest.ids.stepSamples } },
    }), 10);
    assert.equal(fixture.topology.productionShapedScores.source,
      "sanitized-snapshot-aggregates");
    const fixtureUserBefore = await prisma.user.findUniqueOrThrow({
      where: { id: fixture.users[0].id },
      select: { metricsV2EligibleEpochId: true, metricsV2EligibleAt: true },
    });
    assert.equal(fixtureUserBefore.metricsV2EligibleEpochId, metricsEpoch.id);
    assert.ok(fixtureUserBefore.metricsV2EligibleAt instanceof Date);
    assert.equal(await prisma.globalStepEvent.count(), 0);
    assert.equal(await prisma.globalEventSummaryWork.count(), 0);
    assert.deepEqual(fixture.topology.globalEventIsolation, {
      snapshotActiveEventCount: 1, removedEventCount: 1,
      removedSummaryWorkCount: 1, activeEventCountAfterIsolation: 0,
      summaryWorkCountAfterIsolation: 0,
    });
    let cleanup; let session;
    try {
      const now = new Date();
      const profile = fixture.users[0].loadProfile;
      const requestBodies = new Map([["/steps/sync-v2:0", JSON.stringify({
        date: now.toISOString().slice(0, 10), steps: profile.steps,
        samples: [{ periodStart: new Date(now.getTime() - 20 * 60_000).toISOString(),
          periodEnd: new Date(now.getTime() - 10 * 60_000).toISOString(),
          steps: profile.sampleSteps, recordingMethod: "automatic",
          sourceName: "synthetic-health", sourceId: `capacity:${runId}:0` }],
      })]]);
      let processedResolution = false;
      session = await runHomeOpenSession({ baseUrl: server.baseUrl, fetchImpl: fetch, sequence: 0, timeoutMs: 5000,
        wait: async () => {
          if (!processedResolution) {
            processedResolution = true;
            await buildRaceResolutionWorkerV2({ bootAt: 0,
              buildRaceResolutionInputFingerprint: async () => ({
                digest: "integration-home-open-stable-input",
                race: { timezone: "UTC", endsAt: new Date(Date.now() + 86_400_000) },
                nextSampleBoundary: new Date(Date.now() + 600_000),
                activeEffects: [], globalEvents: [],
              }),
            }).processRace({
              raceId: fixture.races[0].id,
            });
          }
        },
        context: { runId, repeat: "1", userCount: fixture.users.length,
          userIndex: 0, userId: fixture.users[0].id, token: fixture.users[0].token,
          raceId: fixture.races[0].id, today: now.toISOString().slice(0, 10),
          sampleStart: new Date(now.getTime() - 20 * 60_000).toISOString(),
          sampleEnd: new Date(now.getTime() - 10 * 60_000).toISOString(), requestBodies } });
      assert.equal(session.criticalComplete, true);
      assert.equal(session.allSettled, true);
      assert.equal(session.samples[0].endpoint, "POST /steps/sync-v2");
      const fixtureUserAfter = await prisma.user.findUniqueOrThrow({
        where: { id: fixture.users[0].id },
        select: { metricsV2EligibleEpochId: true, metricsV2EligibleAt: true },
      });
      assert.deepEqual(fixtureUserAfter, fixtureUserBefore,
        "Home traffic must not perform an artificial first-touch metrics stamp");
      const writtenStep = await prisma.step.findFirstOrThrow({
        where: { userId: fixture.users[0].id }, orderBy: { createdAt: "desc" },
      });
      assert.equal(writtenStep.steps, profile.steps);
      const resolvedParticipant = await prisma.raceParticipant.findFirstOrThrow({ where: {
        userId: fixture.users[0].id, raceId: { in: fixture.manifest.ids.races },
      } });
      assert.equal(resolvedParticipant.totalSteps, profile.steps);
      await prisma.raceParticipant.updateMany({
        where: { id: { in: fixture.manifest.ids.raceParticipants } },
        data: { totalSteps: 999999, rawSteps: 999999, lastNotifiedPlacement: null },
      });
      await targetedReset({ prisma,
        fixture: { runId, ...fixture.manifest },
        plan: { schema: "bara-perf-reset-plan-v1", tables: [] },
        verifyMarker: async () => true });
      const resetParticipants = await prisma.raceParticipant.findMany({
        where: { id: { in: fixture.manifest.ids.raceParticipants } },
        orderBy: { id: "asc" }, select: { id: true, totalSteps: true,
          rawSteps: true, lastNotifiedPlacement: true },
      });
      const expectedParticipants = [...fixture.manifest.participantBaselines]
        .sort((left, right) => left.id.localeCompare(right.id));
      assert.deepEqual(resetParticipants, expectedParticipants.map((row) => ({
        id: row.id, totalSteps: row.totalSteps, rawSteps: row.rawSteps,
        lastNotifiedPlacement: row.lastNotifiedPlacement,
      })));
      assert.equal(await prisma.step.count({
        where: { id: { in: fixture.manifest.ids.steps } },
      }), fixture.manifest.baselineStepRows.length);
      assert.equal(await prisma.stepSample.count({
        where: { id: { in: fixture.manifest.ids.stepSamples } },
      }), fixture.manifest.baselineSampleRows.length);
    } finally {
      cleanup = await cleanupHomeOpenFixtures({ prisma, manifest: fixture.manifest });
    }
    assert.deepEqual(cleanup, { cleaned: true, baselineUnchanged: true,
      globalEventIsolation: { totalEventCount: 0, activeEventCount: 0, summaryWorkCount: 0 } });

    const summary = { metrics: {} };
    const put = (name, values) => { summary.metrics[name] = { values }; };
    const phase = "phase:measurement";
    for (const [name, count] of [["home_open_sessions_started", 1],
      ["home_open_sessions_critical_complete", 1], ["home_open_sessions_all_settled", 1],
      ["home_open_sessions_failed_count", 0], ["home_open_sessions_late", 0],
      ["home_open_sessions_quota_rejected", 0], ["dropped_iterations", 0],
      ["iterations", 1], ["home_open_network_errors", 0]]) {
      put(`${name}{${phase}}`, { count });
    }
    put(`http_req_failed{${phase},telemetry:sut}`, { rate: 0 });
    put("vus_max", { max: 1 });
    for (const [name, value] of [["home_open_critical_ms", session.criticalHomeMs],
      ["home_open_all_ms", session.allHomeMs], ["home_open_scheduler_lag_ms", 0]]) {
      put(`${name}{${phase}}`, { med: value, avg: value, "p(95)": value, "p(99)": value, max: value });
    }
    const endpointNames = { "POST /steps/sync-v2": "sync-v2", "POST /steps": "legacy-steps",
      "POST /steps/samples": "legacy-samples", "GET /home/race-card": "home-race-card",
      "GET /races": "compact-races", "GET /home/suggested-races": "suggested-races",
      "GET /shop/catalog": "shop-catalog", "GET /friends": "friends-summary",
      "GET /auth/me": "auth-me", "GET /assets/manifest": "assets-manifest",
      "GET /steps/race-resolution/:jobId": "race-resolution" };
    for (const entry of PROFILES["home-open"].entries) {
      const label = `${entry.method} ${entry.path}`;
      const samples = session.samples.filter((sample) => sample.endpoint === label);
      const endpoint = endpointNames[label];
      put(`http_reqs{endpoint:${endpoint},${phase}}`, { count: samples.length });
      if (samples.length) {
        const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
        put(`http_req_duration{endpoint:${endpoint},${phase}}`, { med: latencies[0],
          "p(95)": latencies.at(-1), "p(99)": latencies.at(-1) });
      }
      const counts = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, timeout: 0 };
      for (const sample of samples) counts[sample.timeout ? "timeout" : `${Math.floor(sample.status / 100)}xx`] += 1;
      for (const [status, count] of Object.entries(counts)) {
        put(`home_open_endpoint_status{endpoint:${endpoint},status:${status},${phase}}`, { count });
      }
    }
    const verificationInput = { summary, metrics: { samples: [{ resolutionQueueLagMs: 0 }] },
      generatorSamples: [{ cpuPercent: 1, rssBytes: 1024 }], rate: 1, measurementSeconds: 1,
      warmupSeconds: 0, queue: { drained: true, drainSeconds: 0 },
      infrastructure: { telemetryComplete: true, processCensusStable: true,
        processMemoryWithinLimits: true, dbPoolWaitP99Ms: 0, poolCheckoutFailures: 0,
        maxEventLoopDelayMs: 1, recoveredAfterLoad: true },
      provenance: { runId, k6ExitError: null }, topology: fixture.topology, cleanup,
      inFlightEvidence: { source: "session-start-completion-counters", started: 1,
        completed: 1, activeAtClose: 0, invalidEvents: 0, average: 1, peak: 1 } };
    const futureEvent = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000),
      multiplier: 2, label: "reappeared-future-event",
    } });
    const contaminatedCleanup = await cleanupHomeOpenFixtures({ prisma, manifest: fixture.manifest });
    assert.deepEqual(contaminatedCleanup.globalEventIsolation,
      { totalEventCount: 1, activeEventCount: 0, summaryWorkCount: 0 });
    const contaminatedReport = buildVerification({ ...verificationInput, cleanup: contaminatedCleanup });
    assert.equal(contaminatedReport.gates.passed, false);
    assert.match(contaminatedReport.gates.failures.join("; "), /global-event isolation/);
    await prisma.globalStepEvent.delete({ where: { id: futureEvent.id } });
    cleanup = await cleanupHomeOpenFixtures({ prisma, manifest: fixture.manifest });
    const report = buildVerification({ ...verificationInput, cleanup });
    assert.equal(report.schema, "home-open-capacity-result-v1");
    assert.equal(report.gates.passed, true, report.gates.failures.join("; "));
    assert.ok(report.endpoints["GET /auth/me"].requests >= 1);
    assert.equal(report.cleanup.baselineUnchanged, true);
    assert.deepEqual(report.cleanup.globalEventIsolation,
      { totalEventCount: 0, activeEventCount: 0, summaryWorkCount: 0 });
  });
});
