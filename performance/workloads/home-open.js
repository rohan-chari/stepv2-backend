const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Pool } = require("pg");
const { PROFILES } = require("../../src/modules/loadTesting/contract");
const { cleanupHomeOpenFixtures, createHomeOpenFixtures } = require("../../src/modules/loadTesting/homeOpenFixtures");
const { discoverResetPlan, targetedReset } = require("../lib/reset");
const { createCollector } = require("../../scripts/capacity-metrics");
const { captureCapacityBackendLog } = require("../../scripts/k6-home-open");

function domainEventEvidenceFromRows(rows = []) {
  const groups = rows.map((row) => ({
    eventType: String(row.eventType),
    aggregateType: String(row.aggregateType),
    eventCount: Number(row.eventCount || 0),
    audienceRows: Number(row.audienceRows || 0),
  }));
  return {
    schema: "home-open-domain-event-evidence-v1",
    totalEvents: groups.reduce((sum, row) => sum + row.eventCount, 0),
    totalAudienceRows: groups.reduce((sum, row) => sum + row.audienceRows, 0),
    groups,
  };
}

async function captureMeasurementDiagnostics({ config, outputDirectory, stem, runId,
  startedAt, endedAt, pool, captureBackendLog = captureCapacityBackendLog } = {}) {
  const backendLog = path.join(outputDirectory, `${stem}.backend.log`);
  const resolutionEvidence = path.join(outputDirectory, `${stem}.resolution.json`);
  const domainEventEvidence = path.join(outputDirectory, `${stem}.domain-events.json`);
  captureBackendLog(config, startedAt, backendLog, resolutionEvidence, {
    runId, window: { endedAt },
  });
  const result = await pool.query(`
    SELECT event.event_type AS "eventType",
           event.aggregate_type AS "aggregateType",
           count(*)::bigint AS "eventCount",
           COALESCE(sum(audience.rows), 0)::bigint AS "audienceRows"
      FROM domain_event_outbox event
      LEFT JOIN LATERAL (
        SELECT count(*)::bigint AS rows
          FROM domain_event_audiences audience
         WHERE audience.domain_event_id = event.id
      ) audience ON true
     WHERE event.created_at >= ($1::timestamptz AT TIME ZONE 'UTC')
       AND event.created_at <= ($2::timestamptz AT TIME ZONE 'UTC')
     GROUP BY event.event_type, event.aggregate_type
     ORDER BY count(*) DESC, event.event_type, event.aggregate_type`,
  [startedAt, endedAt]);
  const domainEvents = domainEventEvidenceFromRows(result.rows);
  domainEvents.window = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
  };
  fs.writeFileSync(domainEventEvidence, `${JSON.stringify(domainEvents, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  return {
    paths: { backendLog, resolutionEvidence, domainEventEvidence },
    resolution: JSON.parse(fs.readFileSync(resolutionEvidence, "utf8")),
    domainEvents,
  };
}

function metric(summary, name, key, fallback = Number.NaN) {
  const value = summary?.metrics?.[name]?.values?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeK6Evidence({ summary, rate, measurementSeconds } = {}) {
  const phase = "phase:measurement";
  const started = metric(summary, `home_open_sessions_started{${phase}}`, "count", 0);
  const completed = metric(summary, `home_open_sessions_critical_complete{${phase}}`, "count", 0);
  return {
    homeP95Ms: metric(summary, `home_open_critical_ms{${phase}}`, "p(95)"),
    homeP99Ms: metric(summary, `home_open_critical_ms{${phase}}`, "p(99)"),
    httpErrorRate: metric(summary, `http_req_failed{${phase},telemetry:sut}`, "rate"),
    networkErrors: metric(summary, `home_open_network_errors{${phase}}`, "count"),
    incompleteHomeTransactions: Math.max(0, started - completed),
    droppedArrivals: Math.max(metric(summary, `dropped_iterations{${phase}}`, "count", 0),
      Math.max(0, Number(rate) * Number(measurementSeconds) - started)),
  };
}

function percent(value) {
  const parsed = Number(String(value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRuntimeMetrics({ samples = [], measurementSeconds = 1,
  expectedRunId = null, expectedPids = null } = {}) {
  const processes = new Map();
  let workerRestarts = 0;
  const connectionFailuresByProcess = new Map();
  let dbPoolWaitP99Ms = 0;
  let eventLoopP99Ms = 0;
  let targetIdentityValid = samples.length > 0;
  for (const sample of samples) {
    const seen = new Set();
    for (const body of Object.values(sample.health || {})) {
    const capacity = body?.capacity;
    if (!capacity?.process) { targetIdentityValid = false; continue; }
    const identity = `${capacity.process.role}:${capacity.process.instance}`;
    seen.add(identity);
    if (expectedRunId && capacity.runId !== expectedRunId) targetIdentityValid = false;
    if (expectedPids?.[identity] != null && Number(capacity.process.pid) !== Number(expectedPids[identity])) {
      targetIdentityValid = false;
      workerRestarts += 1;
    }
    const previous = processes.get(identity);
    if (previous && previous.pid !== capacity.process.pid) workerRestarts += 1;
    processes.set(identity, { identity, pid: capacity.process.pid,
      role: capacity.process.role, instance: capacity.process.instance,
      eventLoopMaxMs: Number(capacity.eventLoop?.maxMs || 0),
      dbPoolWaitP99Ms: Number(capacity.dbPool?.waitMsP99 || 0),
      dbConnectionFailures: Number(capacity.dbPool?.connectionFailures || 0) });
    connectionFailuresByProcess.set(identity, Math.max(connectionFailuresByProcess.get(identity) || 0,
      Number(capacity.dbPool?.connectionFailures || 0)));
    dbPoolWaitP99Ms = Math.max(dbPoolWaitP99Ms, Number(capacity.dbPool?.waitMsP99 || 0));
    eventLoopP99Ms = Math.max(eventLoopP99Ms, Number(capacity.eventLoop?.maxMs || 0));
    }
    if (expectedPids && Object.keys(expectedPids).some((identity) => !seen.has(identity))) {
      targetIdentityValid = false;
    }
  }
  const containerPeak = (suffix) => Math.max(0, ...samples.flatMap((sample) =>
    (sample.containers || []).filter((row) => String(row.Name || row.Container).endsWith(suffix))
      .map((row) => percent(row.CPUPerc ?? row.CPUPercent))));
  const firstDepth = Number(samples[0]?.resolutionQueueDepth || 0);
  const lastDepth = Number(samples.at(-1)?.resolutionQueueDepth || 0);
  const databaseConnectionsExhausted = [...connectionFailuresByProcess.values()]
    .reduce((sum, value) => sum + value, 0);
  return { workerRestarts, databaseConnectionsExhausted, targetIdentityValid,
    queueGrowth: (lastDepth - firstDepth) / Math.max(1, Number(measurementSeconds)),
    resources: { postgresCpuPercent: containerPeak("-postgres"),
      nodeCpuPercent: containerPeak("-backend"), redisCpuPercent: containerPeak("-redis"),
      dbPoolWaitP99Ms, eventLoopP99Ms, processes: [...processes.values()],
      queueInsertRate: null, queueProcessRate: null, generatorSaturated: false,
      topSqlMaterial: false } };
}

function buildFixtureFile({ runId, fixture, now = new Date() } = {}) {
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const sampleEnd = new Date(now.getTime() - 10 * 60_000);
  const sampleStart = new Date(sampleEnd.getTime() - 10 * 60_000);
  return {
    schema: "home-open-k6-fixture-v2", runId,
    runHash: crypto.createHash("sha256").update(runId).digest("hex"),
    client: { appVersion: "2.3.11", timezone: "America/New_York", releaseChannel: "prod",
      platform: "ios", localDate,
      headerProfile: PROFILES["home-open"].homeOpen.clientHeaderProfile,
      features: PROFILES["home-open"].homeOpen.clientFeatures },
    users: fixture.users.map((user, userIndex) => ({ userIndex, token: user.token,
      ...(user.loadProfile || {}), sampleStart: user.sampleStart || sampleStart.toISOString(),
      sampleEnd: user.sampleEnd || sampleEnd.toISOString() })),
  };
}

function wait(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal: signal || null }));
  });
}

function classifyK6Exit({ code, signal = null, summaryExists } = {}) {
  if (!summaryExists) throw new Error("k6 did not produce its summary");
  if (code === 0 && signal == null) return { thresholdsFailed: false, code: 0, signal: null };
  // k6 reserves 99 for a completed run whose configured thresholds failed.
  // That is application capacity evidence, not a harness/infrastructure crash.
  if (code === 99 && signal == null) return { thresholdsFailed: true, code: 99, signal: null };
  throw new Error(`k6 script/infrastructure exit (${signal || code})`);
}

async function runRawK6({ repository, phase, rate, measurementSeconds, fixturePath,
  baseUrl, outputDirectory, environment = process.env, metricsConfig, databaseUrl,
  runId, metricEpoch, cacheOnly = false, expectedPids = null,
  userOffset = 0,
  captureBackendLog = captureCapacityBackendLog } = {}) {
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const summaryPath = path.join(outputDirectory, `${phase}-${rate}-${crypto.randomUUID()}.k6.json`);
  const variables = {
    K6_BASE_URL: baseUrl, K6_FIXTURE_PATH: fixturePath, K6_SUMMARY_PATH: summaryPath,
    K6_HOME_RATE: String(rate), K6_HOME_WARMUP_RATE: String(rate),
    K6_HOME_WARMUP_SECONDS: "0", K6_HOME_MEASUREMENT_SECONDS: String(measurementSeconds),
    K6_HOME_CACHE_ONLY: cacheOnly ? "1" : "0",
    K6_HOME_USER_OFFSET: String(userOffset),
    K6_HOME_TRAFFIC_EPOCH_HASH: crypto.createHash("sha256")
      .update(`${runId}:${phase}:${rate}:${crypto.randomUUID()}`).digest("hex").slice(0, 12),
  };
  const args = Object.entries(variables).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  const metricsPath = path.join(outputDirectory, `${phase}-${rate}-${crypto.randomUUID()}.metrics.json`);
  const collector = metricsConfig ? createCollector({ config: metricsConfig, output: metricsPath,
    databaseUrl, provenance: { runId, profile: "home-open", repeat: 1 } }) : null;
  const startedAt = new Date();
  collector?.start();
  let exit;
  let endedAt;
  try {
    exit = await wait(spawn("k6", ["run", ...(phase === "measurement" ? [] : ["--no-thresholds"]),
      ...args, path.join(repository, "scripts/k6/home-open.js")], {
      cwd: repository, env: { ...environment, ...variables }, stdio: "inherit",
    }));
    endedAt = new Date();
  } finally { if (collector) await collector.finish(); }
  const k6Exit = classifyK6Exit({ ...exit, summaryExists: fs.existsSync(summaryPath) });
  let topSql = [];
  let diagnostics = null;
  if (phase === "measurement" && databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1,
      connectionTimeoutMillis: 2_000, statement_timeout: 3_000, query_timeout: 3_000 });
    try {
      diagnostics = await captureMeasurementDiagnostics({ config: metricsConfig,
        outputDirectory, stem: path.basename(summaryPath, ".k6.json"), runId,
        startedAt, endedAt, pool, captureBackendLog });
      const result = await pool.query(`SELECT queryid::text AS "queryId", calls::float,
        total_exec_time::float AS "totalExecMs", mean_exec_time::float AS "meanExecMs", rows::float,
        shared_blks_hit::float AS "sharedBlocksHit", shared_blks_read::float AS "sharedBlocksRead",
        temp_blks_written::float AS "tempBlocksWritten", query AS "normalizedQuery"
        FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20`);
      topSql = result.rows;
    } finally { await pool.end(); }
  }
  const runtime = normalizeRuntimeMetrics({ samples: collector?.samples || [], measurementSeconds,
    expectedRunId: runId, expectedPids });
  runtime.resources.topSqlMaterial = topSql.length > 0;
  runtime.resources.topSql = topSql;
  runtime.resources.diagnostics = diagnostics;
  return { summary: JSON.parse(fs.readFileSync(summaryPath, "utf8")), generator: { k6Exit },
    binding: metricEpoch ? { measurementId: metricEpoch.measurementId } : null,
    metrics: runtime, resources: runtime.resources, summaryPath, metricsPath };
}

function createHomeOpenWorkload(dependencies = {}) {
  const createFixtures = dependencies.createFixtures || createHomeOpenFixtures;
  const discoverPlan = dependencies.discoverPlan || discoverResetPlan;
  const resetFixtures = dependencies.resetFixtures || targetedReset;
  const cleanupFixtures = dependencies.cleanupFixtures || cleanupHomeOpenFixtures;
  const runK6 = dependencies.runK6 || runRawK6;
  const execute = ({ phase, rate, seconds, environment, fixtures, config, cacheOnly = false,
    userOffset = 0 }) => runK6({
    repository: environment.repository, phase, rate, warmupSeconds: 0,
    measurementSeconds: seconds, fixturePath: fixtures.fixturePath,
    baseUrl: environment.baseUrl, outputDirectory: environment.levelOutputDirectory,
    environment: environment.processEnvironment, cacheOnly, userOffset,
    ...(phase === "measurement" ? { metricsConfig: environment.metricsConfig,
      databaseUrl: environment.databaseUrl, runId: environment.runId,
      metricEpoch: environment.metricEpoch, expectedPids: environment.expectedPids } : {}),
  });
  return {
    async prepareFixtures({ runId, environment, config }) {
      const fixtureBaselineAt = new Date();
      const fixture = await createFixtures({ prisma: environment.prisma, runId,
        users: config.workload.cohortSize || 5000,
        scoreShape: config.workload.scoreShape || "production",
        arrivalRate: Math.max(...(config.scan?.rates || [config.smoke?.rate || 1])),
        env: environment.processEnvironment || process.env, now: fixtureBaselineAt });
      fixture.manifest.participantBaselineAt = fixtureBaselineAt.toISOString();
      fixture.manifest.userBaselineLastSeenAt = new Date(
        fixtureBaselineAt.getTime() - 24 * 60 * 60_000).toISOString();
      const plan = await discoverPlan(environment.prisma, config.reset?.selectors || []);
      const directory = environment.credentialDirectory ||
        fs.mkdtempSync(path.join(os.tmpdir(), "bara-perf-home-"));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const fixturePath = path.join(directory, "fixture.json");
      fs.writeFileSync(fixturePath, `${JSON.stringify(buildFixtureFile({ runId, fixture }), null, 2)}\n`,
        { flag: "wx", mode: 0o600 });
      return { ...fixture, fixturePath, resetPlan: plan };
    },
    async initialPrewarm({ environment, fixtures, config, seconds }) {
      const rate = config.cache.initialPrewarmRate;
      const users = Math.min(
        fixtures.users.length,
        config.cache.initialPrewarmMaxUsers,
      );
      const boundedSeconds = Math.min(seconds, Math.max(1, Math.ceil(users / rate)));
      return execute({ phase: "initial-prewarm", rate, seconds: boundedSeconds,
        environment, fixtures, config, cacheOnly: true, userOffset: 0 });
    },
    async warmup({ rate, warmupSeconds, measurementSeconds, environment, fixtures, config }) {
      measurementSeconds ??= config.scan.measurementSeconds;
      return execute({ phase: "level-warmup", rate, seconds: warmupSeconds,
        environment, fixtures, config,
        userOffset: rate * Number(measurementSeconds) });
    },
    async measure({ rate, measurementSeconds,
      environment, fixtures, config }) {
      measurementSeconds ??= config.scan.measurementSeconds;
      const result = await execute({ phase: "measurement", rate, seconds: measurementSeconds,
        environment, fixtures, config, userOffset: 0 });
      const normalized = normalizeK6Evidence({ summary: result.summary, rate, measurementSeconds });
      environment.lastMeasurementMetrics = result.metrics || {};
      return { ...normalized, workerRestarts: Number(result.metrics?.workerRestarts || 0),
        databaseConnectionsExhausted: Number(result.metrics?.databaseConnectionsExhausted || 0),
        targetIdentityValid: result.metrics?.targetIdentityValid === true,
        queueGrowth: Number(result.metrics?.queueGrowth || 0),
        timedOut: false, safeCapacityGatesPassed: result.metrics?.targetIdentityValid === true &&
          Object.values(normalized).every((value) => Number.isFinite(value)),
        binding: result.binding || environment.binding,
        resources: result.resources || {} };
    },
    targetedReset({ environment, fixtures }) {
      return resetFixtures({ prisma: environment.prisma, fixture: fixtures.manifest,
        plan: fixtures.resetPlan, env: environment.processEnvironment || process.env });
    },
    async cleanup({ environment, fixtures }) {
      if (fixtures?.manifest) await cleanupFixtures({ prisma: environment.prisma,
        manifest: fixtures.manifest });
      if (fixtures?.fixturePath) fs.rmSync(path.dirname(fixtures.fixturePath),
        { recursive: true, force: true });
    },
  };
}

module.exports = { buildFixtureFile, captureMeasurementDiagnostics, classifyK6Exit,
  createHomeOpenWorkload, domainEventEvidenceFromRows, normalizeK6Evidence,
  normalizeRuntimeMetrics, runRawK6 };
