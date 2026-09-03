const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeK6Evidence, normalizeRuntimeMetrics,
  captureMeasurementDiagnostics, classifyK6Exit, createHomeOpenWorkload,
  domainEventEvidenceFromRows } = require("../../../performance/workloads/home-open");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function metric(values) { return { values }; }

test("k6 Home summary normalizes the exact measured safe-capacity gates", () => {
  const summary = { metrics: {
    "home_open_critical_ms{phase:measurement}": metric({ "p(95)": 811, "p(99)": 1200 }),
    "http_req_failed{phase:measurement,telemetry:sut}": metric({ rate: 0.0005 }),
    "home_open_network_errors{phase:measurement}": metric({ count: 0 }),
    "home_open_sessions_started{phase:measurement}": metric({ count: 1200 }),
    "home_open_sessions_critical_complete{phase:measurement}": metric({ count: 1200 }),
    "dropped_iterations{phase:measurement}": metric({ count: 0 }),
  } };
  assert.deepEqual(normalizeK6Evidence({ summary, rate: 20, measurementSeconds: 60 }), {
    homeP95Ms: 811, homeP99Ms: 1200, httpErrorRate: 0.0005,
    networkErrors: 0, incompleteHomeTransactions: 0, droppedArrivals: 0,
  });
});

test("runtime metrics preserve process identity and separate PostgreSQL from Node pressure", () => {
  const health = (role, instance, pid, cpu = 0) => ({ capacity: { runId: "capacity",
    process: { role, instance, pid }, eventLoop: { maxMs: 10 },
    dbPool: { waitMsP99: 3, connectionFailures: 0 }, cpu } });
  const metrics = normalizeRuntimeMetrics({ measurementSeconds: 60, samples: [
    { resolutionQueueDepth: 2, health: { http: health("http", 0, 10),
      httpPeer: health("http", 1, 11), resolution: health("resolution", 0, 12),
      cron: health("cron", 0, 13) }, containers: [
      { Name: "safe-postgres", CPUPerc: "94%" }, { Name: "safe-backend", CPUPerc: "51%" },
      { Name: "safe-redis", CPUPerc: "2%" },
    ] },
    { resolutionQueueDepth: 8, health: { http: health("http", 0, 10),
      httpPeer: health("http", 1, 11), resolution: health("resolution", 0, 12),
      cron: health("cron", 0, 13) }, containers: [] },
  ] });
  assert.equal(metrics.workerRestarts, 0);
  assert.equal(metrics.queueGrowth, 0.1);
  assert.equal(metrics.resources.postgresCpuPercent, 94);
  assert.equal(metrics.resources.nodeCpuPercent, 51);
  assert.equal(metrics.resources.processes.length, 4);
});

test("runtime metrics count cumulative DB connection failures once per process", () => {
  const health = (instance, failures) => ({ capacity: {
    process: { role: "http", instance, pid: 100 + instance },
    eventLoop: { maxMs: 1 },
    dbPool: { waitMsP99: 2, connectionFailures: failures },
  } });
  const metrics = normalizeRuntimeMetrics({ measurementSeconds: 60, samples: [
    { health: { first: health(0, 1), second: health(1, 2) } },
    { health: { first: health(0, 1), second: health(1, 3) } },
  ] });
  assert.equal(metrics.databaseConnectionsExhausted, 4);
});

test("runtime metrics reject a run identity or baseline PID drift in any sample", () => {
  const sample = (pid, runId = "owned") => ({ health: { http: { capacity: {
    runId, process: { role: "http", instance: 0, pid }, dbPool: {}, eventLoop: {},
  } } } });
  const good = normalizeRuntimeMetrics({ samples: [sample(10)], expectedRunId: "owned",
    expectedPids: { "http:0": 10 } });
  assert.equal(good.targetIdentityValid, true);
  const bad = normalizeRuntimeMetrics({ samples: [sample(11, "foreign")], expectedRunId: "owned",
    expectedPids: { "http:0": 10 } });
  assert.equal(bad.targetIdentityValid, false);
  assert.equal(bad.workerRestarts, 1);
});

test("k6 threshold exit remains classifiable while script/infrastructure exits fail", () => {
  assert.deepEqual(classifyK6Exit({ code: 99, summaryExists: true }), {
    thresholdsFailed: true, code: 99, signal: null,
  });
  assert.throws(() => classifyK6Exit({ code: 107, summaryExists: true }), /infrastructure|script/i);
  assert.throws(() => classifyK6Exit({ code: 99, summaryExists: false }), /summary/i);
});

test("domain-event diagnostics remain grouped and identifier-free", () => {
  assert.deepEqual(domainEventEvidenceFromRows([
    { eventType: "race.updated", aggregateType: "race", eventCount: "12", audienceRows: "48" },
    { eventType: "steps.synced", aggregateType: "user", eventCount: 3, audienceRows: 3 },
  ]), {
    schema: "home-open-domain-event-evidence-v1",
    totalEvents: 15,
    totalAudienceRows: 51,
    groups: [
      { eventType: "race.updated", aggregateType: "race", eventCount: 12, audienceRows: 48 },
      { eventType: "steps.synced", aggregateType: "user", eventCount: 3, audienceRows: 3 },
    ],
  });
});

test("measurement diagnostics preserve raw resolution logs and grouped domain-event evidence", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "home-diagnostics-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pool = { async query(sql, values) {
    assert.match(sql, /domain_event_outbox/);
    assert.equal(values.length, 2);
    return { rows: [{ eventType: "race.updated", aggregateType: "race",
      eventCount: "2", audienceRows: "5" }] };
  } };
  const result = await captureMeasurementDiagnostics({
    config: { lima_instance: "owned", backend_container: "owned-backend" },
    outputDirectory: directory, stem: "measurement-30", runId: "owned-run",
    startedAt: new Date("2026-09-03T00:00:00Z"),
    endedAt: new Date("2026-09-03T00:01:00Z"), pool,
    captureBackendLog: (_config, _since, rawPath, evidencePath, binding) => {
      fs.writeFileSync(rawPath, '{"event":"race_resolution_v2"}\n');
      fs.writeFileSync(evidencePath, JSON.stringify({ schema: "home-open-resolution-evidence-v2",
        binding }));
    },
  });
  assert.equal(fs.existsSync(result.paths.backendLog), true);
  assert.equal(fs.existsSync(result.paths.resolutionEvidence), true);
  assert.equal(fs.existsSync(result.paths.domainEventEvidence), true);
  assert.equal(result.resolution.schema, "home-open-resolution-evidence-v2");
  assert.equal(result.domainEvents.totalEvents, 2);
  assert.deepEqual(result.domainEvents.window, {
    startedAt: "2026-09-03T00:00:00.000Z",
    endedAt: "2026-09-03T00:01:00.000Z",
  });
  assert.deepEqual(result.resolution.binding, {
    runId: "owned-run",
    window: { endedAt: "2026-09-03T00:01:00.000Z" },
  });
});

test("workload provisions fixtures once and executes warmup and measurement as separate k6 epochs", async () => {
  const calls = [];
  const workload = createHomeOpenWorkload({
    createFixtures: async () => (calls.push("fixtures"), {
      manifest: { runId: "bara-perf-fixture" }, topology: {}, races: [],
      users: Array.from({ length: 10 }, (_, index) => ({ token: `token-${index}` })),
    }),
    discoverPlan: async () => (calls.push("discover"), { schema: "bara-perf-reset-plan-v1", tables: [] }),
    resetFixtures: async () => calls.push("reset"),
    runK6: async ({ phase, warmupSeconds, measurementSeconds, cacheOnly, rate }) => {
      calls.push(`k6:${phase}:${warmupSeconds}:${measurementSeconds}:${cacheOnly === true}:${rate}`);
      return { summary: { metrics: {
        "home_open_critical_ms{phase:measurement}": metric({ "p(95)": 100, "p(99)": 200 }),
        "http_req_failed{phase:measurement,telemetry:sut}": metric({ rate: 0 }),
        "home_open_network_errors{phase:measurement}": metric({ count: 0 }),
        "home_open_sessions_started{phase:measurement}": metric({ count: 5 }),
        "home_open_sessions_critical_complete{phase:measurement}": metric({ count: 5 }),
        "dropped_iterations{phase:measurement}": metric({ count: 0 }),
      } }, generator: {}, binding: { id: "same" }, metrics: { targetIdentityValid: true } };
    },
  });
  const environment = { prisma: {}, binding: { id: "same" } };
  const config = { workload: { cohortSize: 10 }, cache: { initialPrewarmRate: 2,
    initialPrewarmMaxUsers: 6 }, scan: { measurementSeconds: 1 } };
  const fixture = await workload.prepareFixtures({ runId: "bara-perf-fixture", environment, config });
  await workload.initialPrewarm({ environment, fixtures: fixture, config, seconds: 30 });
  await workload.warmup({ rate: 5, warmupSeconds: 15, environment, fixtures: fixture, config });
  const evidence = await workload.measure({ rate: 5, environment, fixtures: fixture, config });
  await workload.targetedReset({ environment, fixtures: fixture, config });
  assert.deepEqual(calls, ["fixtures", "discover", "k6:initial-prewarm:0:3:true:2",
    "k6:level-warmup:0:15:false:5", "k6:measurement:0:1:false:5", "reset"]);
  assert.equal(evidence.safeCapacityGatesPassed, true);
  assert.deepEqual(evidence.binding, { id: "same" });
});
