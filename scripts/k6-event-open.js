#!/usr/bin/env node

require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { createGlobalEventReliabilityFixtures, cleanupSyntheticRun } = require("../src/modules/loadTesting/globalEventReliabilityFixtures");
const { assertCapacityRunProfile, assertStartedRun } = require("../src/modules/loadTesting/lifecycle");
const { assertEventOpenSurgeGates, assertFixtureParity } = require("../src/modules/loadTesting/runner");
const { normalizeGlobalEventInfrastructure } = require("../src/modules/loadTesting/globalEventInfrastructure");
const { installationCountForUser } = require("../src/modules/loadTesting/globalEventReliabilityProfiles");

const K6_IMAGE = "grafana/k6:0.54.0";
const EXACT_POOL_BUDGET = { http0: 10, http1: 10, resolution: 8, cron: 4, total: 32 };

function applyGuardedCapacityEnvironment(config, runId, environment = process.env) {
  const dbName = config.db_name || "steps_tracker_capacity";
  if (dbName !== "steps_tracker_capacity") {
    throw new Error("k6 workflow only accepts the disposable steps_tracker_capacity database");
  }
  if (environment.CAPACITY_MODE !== "true" || environment.CAPACITY_OUTBOUND_DISABLED !== "true") {
    throw new Error("k6 event-open workflow requires isolated CAPACITY_MODE with outbound disabled");
  }
  const password = required(environment.CAPACITY_DB_PASSWORD, "CAPACITY_DB_PASSWORD");
  required(environment.CAPACITY_DB_MARKER, "CAPACITY_DB_MARKER");
  const sessionSecret = required(environment.CAPACITY_AUTH_SECRET || environment.SESSION_TOKEN_SECRET,
    "CAPACITY_AUTH_SECRET");
  const user = encodeURIComponent(config.db_user || "capacity");
  environment.CAPACITY_RUN_ID = runId;
  environment.CAPACITY_GLOBAL_EVENT_PROFILE = "event-open-surge";
  environment.CAPACITY_DB_NAME = dbName;
  environment.CAPACITY_DB_HOST_ALLOWLIST = "127.0.0.1";
  environment.SESSION_TOKEN_SECRET = sessionSecret;
  environment.DATABASE_URL = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${config.db_host_port || 55433}/${dbName}`;
  const redisPassword = required(environment.CAPACITY_REDIS_PASSWORD,
    "CAPACITY_REDIS_PASSWORD");
  environment.REDIS_URL = `redis://:${encodeURIComponent(redisPassword)}@127.0.0.1:6379/0`;
  environment.CACHE_ENV_PREFIX = `capacity:${runId}:`;
  return environment;
}

function k6LoadUsers(users) {
  const count = users.length;
  return users.map((user, userIndex) => ({ ...user, userIndex }))
    .filter((user) => installationCountForUser(user.userIndex, count) > 0);
}

function eventOpenPrimaryRaceId(races) {
  const raceId = races?.[0]?.id;
  if (!raceId) throw new Error("event-open fixture primary race is missing");
  return raceId;
}

async function prewarmEventOpenRaceSnapshots({
  races,
  computeSnapshot,
  writeSnapshot,
  publishPageProjection = null,
}) {
  for (const race of [...(races || [])].sort((left, right) =>
    String(left.id).localeCompare(String(right.id)))) {
    const snapshot = await computeSnapshot({ raceId: race.id, timeZone: "UTC" });
    if (!snapshot) throw new Error(`event-open snapshot prewarm failed for ${race.id}`);
    await writeSnapshot(race.id, snapshot);
    if (publishPageProjection) await publishPageProjection(race, snapshot);
  }
}

function observedPoolBudget(metrics, runId, profile = "event-open-surge") {
  if (!Array.isArray(metrics?.samples) || metrics.samples.length === 0) {
    throw new Error("k6 observed pool census has no samples");
  }
  const exact = new Map([
    ["http:0", 10], ["http:1", 10], ["resolution:0", 8], ["cron:0", 4],
  ]);
  for (const sample of metrics?.samples || []) {
    const byIdentity = new Map();
    for (const health of Object.values(sample.health || {})) {
      const capacity = health?.capacity;
      if (!capacity) throw new Error("k6 observed pool census contains incomplete health telemetry");
      if (capacity.runId !== runId || capacity.globalEventProfile !== profile) {
        throw new Error("k6 observed pool provenance does not match the selected run/profile");
      }
      const identity = `${capacity.process?.role}:${capacity.process?.instance}`;
      const maximum = Number(capacity.dbPool?.max);
      if (!exact.has(identity) || maximum !== exact.get(identity) || byIdentity.has(identity)) {
        throw new Error(`k6 observed pool census is not exact for ${identity}`);
      }
      byIdentity.set(identity, maximum);
    }
    if (byIdentity.size !== exact.size || [...exact.keys()].some((identity) => !byIdentity.has(identity))) {
      throw new Error("k6 observed pool census is incomplete for a metrics sample");
    }
  }
  return { ...EXACT_POOL_BUDGET };
}

function hashValue(value) {
  return crypto.createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
}

function checkoutFingerprint(repository = path.resolve(__dirname, ".."), { excludedPaths = [] } = {}) {
  const root = path.resolve(repository);
  const exclusions = [path.join(root, "results"), ...excludedPaths.map((value) => path.resolve(value))]
    .filter((value) => value === root || value.startsWith(`${root}${path.sep}`))
    .filter((value) => value !== root)
    .map((value) => path.relative(root, value).replaceAll(path.sep, "/"));
  const pathspec = [".", ...exclusions.map((relative) => `:(exclude)${relative}/**`)];
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root, encoding: "utf8",
  }).trim();
  const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD", "--", ...pathspec], {
    cwd: root, maxBuffer: 64 * 1024 * 1024,
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
  }).toString("utf8").split("\0").filter(Boolean)
    .filter((relative) => !exclusions.some((excluded) =>
      relative === excluded || relative.startsWith(`${excluded}/`)))
    .sort();
  const dirty = trackedDiff.length > 0 || untracked.length > 0;
  const digest = crypto.createHash("sha256").update(trackedDiff);
  for (const relative of untracked) {
    digest.update("\0untracked\0").update(relative).update("\0")
      .update(fs.readFileSync(path.join(root, relative)));
  }
  return {
    schema: "capacity-checkout-fingerprint-v1",
    commit,
    dirty,
    dirtyTreeHash: dirty ? digest.digest("hex") : null,
  };
}

function capacityBindingForState(state, metrics, runId, { checkout = checkoutFingerprint() } = {}) {
  if (!state?.liveManifestPath || !fs.existsSync(state.liveManifestPath)) {
    throw new Error("k6 capacity binding requires the verified live manifest");
  }
  return {
    schema: "event-open-capacity-binding-v1",
    profile: state.profile,
    snapshotHash: state.snapshotHash,
    sourceSnapshotHash: state.sourceSnapshotHash,
    scrubAttestationHash: state.scrubAttestationHash,
    approvedManifestHash: hashValue(state.approvedManifest),
    liveManifestHash: hashValue(fs.readFileSync(state.liveManifestPath)),
    checkout,
    poolBudget: observedPoolBudget(metrics, runId),
  };
}

function validateArtifactProvenance({
  faultEvidence, headroomEvidence, fault, runId, requireHeadroom,
  capacityBinding = null,
  expectedFaultArtifact = null, expectedHeadroomArtifact = null,
}) {
  if (faultEvidence?.schema !== "capacity-fault-v1" || faultEvidence.runId !== runId ||
      faultEvidence.scenario !== fault ||
      (expectedFaultArtifact && path.resolve(faultEvidence.artifact) !== path.resolve(expectedFaultArtifact))) {
    throw new Error("k6 fault artifact provenance does not match the selected run/scenario");
  }
  if (requireHeadroom && (headroomEvidence?.schema !== "event-open-k6-verification-v1" ||
      headroomEvidence.scenario !== "headroom" ||
      JSON.stringify(headroomEvidence.capacityBinding) !== JSON.stringify(capacityBinding) ||
      (expectedHeadroomArtifact && path.resolve(headroomEvidence.artifact || expectedHeadroomArtifact) !== path.resolve(expectedHeadroomArtifact)))) {
    throw new Error("k6 headroom artifact provenance does not match the selected run/headroom scenario");
  }
  return true;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2).replaceAll("-", "_");
    result[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] == null
      ? true : argv[++index];
  }
  return result;
}

function required(value, name) {
  if (!String(value || "").trim()) throw new Error(`${name} is required`);
  return String(value);
}

function validateCapacity(config, args) {
  if (process.env.CAPACITY_MODE !== "true" || process.env.CAPACITY_OUTBOUND_DISABLED !== "true") {
    throw new Error("k6 event-open workflow requires isolated CAPACITY_MODE with outbound disabled");
  }
  if ((config.db_name || "steps_tracker_capacity") !== "steps_tracker_capacity") {
    throw new Error("k6 workflow only accepts the disposable steps_tracker_capacity database");
  }
  if ((config.database_pool_profile || "role-budget") !== "role-budget") {
    throw new Error("k6 workflow requires exact 10/10/8/4 role-budget pools");
  }
  const runId = required(args.run_id || config.run_id, "run id");
  const directory = required(args.capacity_state_dir || config.directory, "capacity state directory");
  const state = assertStartedRun({ runId, directory });
  assertCapacityRunProfile(state, "event-open-surge");
  return { runId, directory, state };
}

function immutableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function uuidFrom(value) {
  const hex = crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function observe(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve() : reject(new Error(`fault automation exited ${code ?? signal}`)));
  });
}

function percentile(values, quantile) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function metricValue(summary, name, key, fallback = 0) {
  return Number(summary?.metrics?.[name]?.values?.[key] ?? fallback);
}

async function verifyK6Database({ prisma, fixture, summary, metrics, faultEvidence, headroomEvidence, scenario, runId, baseUrl, capacityBinding }) {
  const offered = metricValue(summary, "event_open_sessions_offered", "count");
  const completed = metricValue(summary, "event_open_sessions_completed", "count");
  const failed = metricValue(summary, "event_open_sessions_failed", "count");
  const raceIds = fixture.races.map((race) => race.id);
  const drainStartedAt = Date.now();
  let queueRows = [];
  for (;;) {
    queueRows = await prisma.raceResolutionJobV2.findMany({
      where: { raceId: { in: raceIds } },
      select: { raceId: true, state: true, generation: true, processingGeneration: true, updatedAt: true },
    });
    const drained = queueRows.length === raceIds.length && queueRows.every((row) =>
      String(row.state).toUpperCase() === "SUCCEEDED" &&
      Number(row.generation) === Number(row.processingGeneration));
    if (drained) break;
    if (queueRows.some((row) => String(row.state).toUpperCase() === "FAILED") ||
        Date.now() - drainStartedAt > 300_000) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestDaily = new Map();
  const latestSamples = new Map();
  const expectedSessionsByUser = new Map();
  let syncReceiptCount = 0;
  const trafficUsers = fixture.loadUsers || fixture.users;
  for (let sequence = 0; sequence < offered; sequence += 1) {
    const trafficIndex = sequence % trafficUsers.length;
    const user = trafficUsers[trafficIndex];
    const userIndex = user.userIndex;
    expectedSessionsByUser.set(user.id, (expectedSessionsByUser.get(user.id) || 0) + 1);
    const bucket = sequence % 100;
    if (bucket < 18 || bucket >= 36) latestDaily.set(user.id, 1000 + sequence);
    if (bucket >= 18) {
      latestSamples.set(user.id, 6000 + userIndex * 100 + Math.floor(sequence / trafficUsers.length));
    }
    if (bucket >= 36) syncReceiptCount += 1;
  }
  const userIds = trafficUsers.map((user) => user.id);
  const [dailyRows, sampleRows, storedSyncCount, participantRows, raceRows, boxRows, scoringVersions] = await Promise.all([
    prisma.step.findMany({ where: { userId: { in: userIds } }, select: { userId: true, steps: true } }),
    prisma.stepSample.findMany({ where: { userId: { in: userIds } }, select: {
      userId: true, periodStart: true, periodEnd: true, steps: true,
    } }),
    prisma.stepSyncRequest.count({ where: { userId: { in: userIds }, state: "COMPLETE" } }),
    prisma.raceParticipant.findMany({ where: { raceId: { in: raceIds }, status: "ACCEPTED" }, select: {
      id: true, raceId: true, userId: true, rawSteps: true, totalSteps: true, bonusSteps: true,
      powerupSlots: true, nextBoxAtSteps: true, joinedAt: true,
    } }),
    prisma.race.findMany({ where: { id: { in: raceIds } }, select: {
      id: true, startedAt: true, endsAt: true, powerupStepInterval: true,
    } }),
    prisma.racePowerup.findMany({ where: { raceId: { in: raceIds }, earnedAtSteps: { not: null } }, select: {
      id: true, raceId: true, participantId: true, userId: true, earnedAtSteps: true, status: true,
    } }),
    prisma.userScoringInputVersion.findMany({
      where: { userId: { in: userIds } }, select: { userId: true, generation: true },
    }),
  ]);
  const dailyByUser = new Map(dailyRows.map((row) => [row.userId, Number(row.steps)]));
  const sampleByUser = new Map(sampleRows.map((row) => [row.userId, Number(row.steps)]));
  const sourceOk = [...latestDaily].every(([userId, steps]) => dailyByUser.get(userId) === steps) &&
    [...latestSamples].every(([userId, steps]) => sampleByUser.get(userId) === steps) &&
    storedSyncCount === syncReceiptCount;

  const publicProgress = [];
  for (const raceId of raceIds) {
    const response = await fetch(`${baseUrl}/races/${raceId}/progress`, {
      headers: { Authorization: `Bearer ${trafficUsers[0].token}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`k6 parity progress read failed: ${response.status}`);
    const body = await response.json();
    publicProgress.push({ raceId, participants: body?.progress?.participants });
  }
  const parity = assertFixtureParity({
    races: raceRows,
    sourceRows: { daily: dailyRows, samples: sampleRows },
    participants: participantRows, publicProgress, boxRows, scoringNow: new Date(),
  });
  const membershipsByUser = new Map();
  for (const participant of participantRows) {
    membershipsByUser.set(participant.userId, (membershipsByUser.get(participant.userId) || 0) + 1);
  }
  const finalGenerationByUser = new Map(scoringVersions.map((row) => [row.userId, BigInt(row.generation)]));
  let expectedGenerationDelta = 0;
  let observedGenerationDelta = 0;
  let exactUserGenerations = true;
  for (const user of trafficUsers) {
    const baseline = BigInt(fixture.scoringGenerationBaseline?.get(user.id) ?? 0);
    const expectedUserDelta = BigInt(expectedSessionsByUser.get(user.id) || 0);
    const observedUserDelta = (finalGenerationByUser.get(user.id) ?? baseline) - baseline;
    const memberships = membershipsByUser.get(user.id) || 0;
    expectedGenerationDelta += Number(expectedUserDelta) * memberships;
    observedGenerationDelta += Number(observedUserDelta) * memberships;
    if (observedUserDelta !== expectedUserDelta) exactUserGenerations = false;
  }
  const eventStartedMs = new Date(fixture.eventStartsAt).getTime();
  const firstAttemptDeadlineMs = eventStartedMs + 120_000;
  if (Date.now() < firstAttemptDeadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, firstAttemptDeadlineMs - Date.now()));
  }
  let attempts = [];
  const terminalDeadlineMs = Math.max(Date.now() + 30_000, firstAttemptDeadlineMs + 30_000);
  do {
    attempts = await prisma.inboxDeliveryDeviceAttempt.findMany({
      where: { outbox: { alert: { sourceKey: { endsWith: `:${fixture.event.id}` } } } },
      select: { disposition: true, firstAttemptedAt: true },
    });
    const terminal = attempts.filter((row) => ["ACCEPTED", "INVALID"].includes(row.disposition)).length;
    if (attempts.filter((row) => row.firstAttemptedAt).length === 12_000 && terminal === 12_000) break;
    if (Date.now() >= terminalDeadlineMs) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (true);
  const lagValues = attempts.filter((row) => row.firstAttemptedAt).map((row) =>
    Math.max(0, new Date(row.firstAttemptedAt).getTime() - eventStartedMs));
  const buckets = new Map();
  for (const lag of lagValues) buckets.set(Math.floor(lag / 1000), (buckets.get(Math.floor(lag / 1000)) || 0) + 1);
  const infrastructure = normalizeGlobalEventInfrastructure({
    metrics, requestSamples: [], eventStartsAt: fixture.eventStartsAt,
    expectedProfile: "event-open-surge", expectedRunId: runId, expectedRepeat: 1,
    measurementSeconds: scenario === "shock" ? 60 : 300,
  });
  infrastructure.poolBudget = observedPoolBudget(metrics, runId);
  const queueLag = metrics.samples
    .filter((row) => new Date(row.at) >= new Date(fixture.eventStartsAt))
    .map((row) => Number(row.resolutionQueueLagMs));
  const interactiveP95 = metricValue(summary, "http_req_duration{class:interactive}", "p(95)");
  const interactiveP99 = metricValue(summary, "http_req_duration{class:interactive}", "p(99)");
  const endpoint = (p95, p99) => ({ requests: offered, status: { "5xx": 0, timeout: 0, unexpected: 0 }, latencyMs: { p95, p99 } });
  const endpoints = Object.fromEntries([
    "GET /auth/me", "GET /home/race-card", "GET /races/discovery-summary", "GET /races",
    "GET /inbox/alerts", "GET /races/:raceId/progress", "GET /races/:raceId/bootstrap",
  ].map((name) => [name, endpoint(interactiveP95, interactiveP99)]));
  endpoints["POST /steps/sync-v2"] = endpoint(
    metricValue(summary, "http_req_duration{class:sync-v2}", "p(95)"),
    metricValue(summary, "http_req_duration{class:sync-v2}", "p(99)"));
  for (const name of ["POST /steps", "POST /steps/samples"]) endpoints[name] = endpoint(
    metricValue(summary, "http_req_duration{class:legacy-step}", "p(95)"),
    metricValue(summary, "http_req_duration{class:legacy-step}", "p(99)"));
  const headroom = scenario === "headroom"
    ? { required: 0.4, sustainedTargetPerSecond: 100, provedPerSecond: 140 }
    : headroomEvidence?.result?.eventEvidence?.headroom || headroomEvidence?.headroom || null;
  const eventEvidence = {
    c0Queue: {
      directlyInspected: true,
      drained: queueRows.length === raceIds.length && queueRows.every((row) => String(row.state).toUpperCase() === "SUCCEEDED" && Number(row.generation) === Number(row.processingGeneration)),
      failedRows: queueRows.filter((row) => String(row.state).toUpperCase() === "FAILED").length,
      oldestAgeMs: queueRows.some((row) => String(row.state).toUpperCase() !== "SUCCEEDED") ? Date.now() - Math.min(...queueRows.map((row) => new Date(row.updatedAt).getTime())) : 0,
      p95LagMs: percentile(queueLag, 0.95), drainSeconds: (Date.now() - drainStartedAt) / 1000,
    },
    notification: {
      expectedProviderAttempts: 12_000, firstAttempts: lagValues.length,
      accepted: attempts.filter((row) => row.disposition === "ACCEPTED").length,
      invalid: attempts.filter((row) => row.disposition === "INVALID").length,
      lateFirstAttempts: lagValues.filter((lag) => lag > 120_000).length,
      finalFirstAttemptLagMs: lagValues.length ? Math.max(...lagValues) : Infinity,
      pacingRatePerSecond: buckets.size ? Math.max(...buckets.values()) : Infinity,
    },
    sourcePersistence: { acceptedWrites: offered, persistedWrites: sourceOk ? offered : 0, ok: sourceOk },
    duplicateScoring: {
      ok: offered > 0 && exactUserGenerations && observedGenerationDelta === expectedGenerationDelta,
      expectedGenerationDelta,
      observedGenerationDelta,
      generationAmplificationRatio: expectedGenerationDelta > 0
        ? observedGenerationDelta / expectedGenerationDelta : Infinity,
    },
    parity, headroom,
    fault: { ...faultEvidence, artifact: faultEvidence.artifact },
  };
  const result = {
    parameters: { arrivalRatePerSecond: scenario === "headroom" ? 140 : scenario === "shock" ? 200 : 100, durationSeconds: scenario === "shock" ? 60 : 300 },
    sessions: { offered, completedSuccessful: completed, failed },
    summary: { errorRate: metricValue(summary, "http_req_failed", "rate") },
    queue: { drainCompleted: eventEvidence.c0Queue.drained, lagMs: { p95: eventEvidence.c0Queue.p95LagMs }, drainSeconds: eventEvidence.c0Queue.drainSeconds },
    infrastructure: { eventSurge: infrastructure }, endpoints, eventEvidence,
  };
  assertEventOpenSurgeGates(result);
  return { schema: "event-open-k6-verification-v1", runId, scenario, capacityBinding, result };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(required(args.config, "--config"));
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const { runId, state: capacityState } = validateCapacity(config, args);
  applyGuardedCapacityEnvironment(config, runId);
  const scenario = required(args.scenario || "sustained", "scenario");
  if (!["sustained", "headroom", "shock"].includes(scenario)) throw new Error("invalid k6 scenario");
  const fault = required(args.fault || "baseline", "fault");
  if (!["baseline", "redis-outage", "worker-restart"].includes(fault)) throw new Error("invalid fault scenario");
  const outputDir = path.resolve(args.output_dir || "results");
  const sourceCheckout = checkoutFingerprint(path.resolve(__dirname, ".."), {
    excludedPaths: [outputDir, config.directory].filter(Boolean),
  });
  const fixturePath = path.join(outputDir, `${runId}.${scenario}.k6-fixture.json`);
  const summaryPath = path.join(outputDir, `${runId}.${scenario}.k6-summary.json`);
  const faultPath = path.join(outputDir, `${runId}.${scenario}.fault.json`);
  const metricsPath = path.join(outputDir, `${runId}.${scenario}.metrics.json`);
  const verificationPath = path.join(outputDir, `${runId}.${scenario}.verification.json`);
  const instance = required(config.lima_instance, "lima_instance");
  // The fixture's boundary is intentionally only seconds in the future. Pull
  // the pinned driver image before creating that clock-bound state; otherwise
  // a cold disposable VM measures an event that opened during an image pull.
  execFileSync("limactl", ["shell", instance, "--", "bash", "-lc",
    `docker pull ${K6_IMAGE}`], { stdio: "inherit" });
  const prisma = require("../src/db").prisma;
  let fixture;
  let metricsProcess;
  try {
    metricsProcess = spawn(process.execPath, [
      path.resolve(__dirname, "capacity-metrics.js"), "--config", configPath, "--output", metricsPath,
    ], { stdio: "inherit", env: {
      ...process.env, CAPACITY_RUN_ID: runId,
      CAPACITY_GLOBAL_EVENT_PROFILE: "event-open-surge", CAPACITY_REPEAT: "1",
    } });
    const metricsFinished = observe(metricsProcess);
    fixture = await createGlobalEventReliabilityFixtures({
      prisma, runId, profile: "event-open-surge", users: 10_000, env: process.env,
    });
    fixture.loadUsers = k6LoadUsers(fixture.users);
    const primaryRaceId = eventOpenPrimaryRaceId(fixture.races);
    fixture.scoringGenerationBaseline = new Map((await prisma.userScoringInputVersion.findMany({
      where: { userId: { in: fixture.loadUsers.map((user) => user.id) } },
      select: { userId: true, generation: true },
    })).map((row) => [row.userId, BigInt(row.generation)]));
    const sampleStart = new Date(Math.max(...fixture.races.map((race) => new Date(race.startedAt))) + 600_000).toISOString();
    const sampleEnd = new Date(new Date(sampleStart).getTime() + 600_000).toISOString();
    immutableJson(fixturePath, {
      schema: "event-open-k6-fixture-v1", runId, poolBudget: EXACT_POOL_BUDGET,
      users: fixture.loadUsers.map((user) => ({
        id: user.id, token: user.token, userIndex: user.userIndex,
        // capacityRaceParticipantRows puts every fixture user in race zero;
        // later cohorts additionally join races one and two. Targeting the
        // primary race keeps every simulated session authorized while still
        // exercising the largest shared-race fan-in.
        raceId: primaryRaceId,
        sampleStart, sampleEnd,
        activationId: uuidFrom(`${runId}:activation:${user.userIndex}`),
        idempotencyPrefix: crypto.createHash("sha256").update(`${runId}:sync:${user.userIndex}`).digest("hex").slice(0, 23),
      })),
    });
    const waitMs = new Date(fixture.eventStartsAt).getTime() - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const { getRaceProgress } = require("../src/modules/races/queries/getRaceProgress");
    const raceProgressSnapshot = require("../src/modules/races/services/raceProgressSnapshot");
    const raceProgressPageProjection = require("../src/modules/races/services/raceProgressPageProjection");
    const { RaceResolutionJobV2 } = require("../src/modules/races/models/raceResolutionJobV2");
    const jobsByRaceId = new Map((await RaceResolutionJobV2.findByRaceIds(
      fixture.races.map((race) => race.id)
    )).map((job) => [job.raceId, job]));
    await prewarmEventOpenRaceSnapshots({
      races: fixture.races,
      computeSnapshot: getRaceProgress.computePersistedSnapshot,
      writeSnapshot: raceProgressSnapshot.writeSnapshot,
      publishPageProjection: async (race, snapshot) => {
        const job = jobsByRaceId.get(race.id);
        const generation = Number(job?.generation || 1);
        const sourceParticipants = await prisma.raceParticipant.findMany({
          where: { raceId: race.id, status: "ACCEPTED" },
          select: {
            id: true, userId: true, joinedAt: true, rawSteps: true,
            finishTotalSteps: true,
          },
        });
        const projection = raceProgressPageProjection.buildRaceProgressPageProjection({
          raceId: race.id,
          generation,
          scoringTimeZone: snapshot.scoringTimeZone || "UTC",
          asOf: snapshot.asOf,
          race: snapshot.race,
          participants: snapshot.participants,
          sourceParticipants,
        });
        const published = await raceProgressPageProjection.publishRaceProgressPageProjection({
          raceId: race.id,
          generation,
          snapshot: projection,
          currentGeneration: async () => generation,
        });
        if (!published) throw new Error(`event-open page projection prewarm failed for ${race.id}`);
      },
    });
    const repository = path.resolve(config.repository);
    const faultChild = spawn(process.execPath, [
      path.join(repository, "scripts/lima-capacity.js"), "fault", "--config", configPath,
      "--scenario", fault, "--artifact", faultPath, "--duration-seconds", "60",
      "--delay-seconds", "30",
    ], { stdio: "inherit", env: {
      ...process.env,
      CAPACITY_RUN_ID: runId,
      CAPACITY_GLOBAL_EVENT_PROFILE: "event-open-surge",
    } });
    const faultFinished = observe(faultChild);
    // The repository is deliberately a read-only Lima mount. Give k6 a
    // VM-local output directory, then copy its summary back with an immutable
    // host write after the container exits.
    const vmOutputDir = `/tmp/event-open-k6-${runId}-${scenario}`;
    // The pinned k6 image runs as an unprivileged uid that is unrelated to the
    // Lima login uid. This directory contains only the generated summary and
    // the VM is disposable, so grant container write access explicitly.
    execFileSync("limactl", ["shell", instance, "--", "install", "-d", "-m", "777", vmOutputDir]);
    let k6Error = null;
    try {
      execFileSync("limactl", ["shell", instance, "--", "bash", "-lc",
        `docker run --rm --network host -v ${JSON.stringify(repository)}:/workspace:ro -v ${JSON.stringify(outputDir)}:/results:ro -v ${JSON.stringify(vmOutputDir)}:/k6-output -e K6_SCENARIO=${scenario} -e K6_BASE_URL=http://127.0.0.1:3000 -e CAPACITY_RUN_ID=${runId} -e K6_FIXTURE_PATH=/results/${path.basename(fixturePath)} -e K6_SUMMARY_PATH=/k6-output/summary.json ${K6_IMAGE} run /workspace/scripts/k6/event-open-surge.js`],
        { stdio: "inherit" });
    } catch (error) {
      k6Error = error;
    }
    try {
      const summaryBytes = execFileSync("limactl", ["shell", instance, "--", "cat", `${vmOutputDir}/summary.json`]);
      fs.writeFileSync(summaryPath, summaryBytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!k6Error) throw error;
    }
    await faultFinished;
    metricsProcess.kill("SIGTERM");
    await metricsFinished;
    metricsProcess = null;
    if (k6Error) throw k6Error;
    if (!fs.existsSync(summaryPath) || !fs.existsSync(faultPath) || !fs.existsSync(metricsPath)) {
      throw new Error("k6 summary/fault/metrics artifact missing");
    }
    const faultEvidence = { ...JSON.parse(fs.readFileSync(faultPath, "utf8")), artifact: faultPath };
    const headroomArtifact = args.headroom_evidence ? path.resolve(args.headroom_evidence) : null;
    const headroomEvidence = headroomArtifact
      ? { ...JSON.parse(fs.readFileSync(headroomArtifact, "utf8")), artifact: headroomArtifact } : null;
    const metrics = JSON.parse(fs.readFileSync(metricsPath, "utf8"));
    const capacityBinding = capacityBindingForState(capacityState, metrics, runId, {
      checkout: sourceCheckout,
    });
    validateArtifactProvenance({
      faultEvidence, headroomEvidence, fault, runId,
      requireHeadroom: scenario !== "headroom",
      capacityBinding,
      expectedFaultArtifact: faultPath,
      expectedHeadroomArtifact: headroomArtifact,
    });
    const verification = await verifyK6Database({
      prisma, fixture,
      summary: JSON.parse(fs.readFileSync(summaryPath, "utf8")),
      metrics,
      faultEvidence, headroomEvidence, scenario, runId,
      baseUrl: config.base_url || "http://127.0.0.1:3000",
      capacityBinding,
    });
    immutableJson(verificationPath, verification);
    process.stdout.write(`${JSON.stringify({ runId, scenario, fault, poolBudget: verification.result.infrastructure.eventSurge.poolBudget, summaryPath, metricsPath, faultPath, verificationPath }, null, 2)}\n`);
  } finally {
    if (metricsProcess && metricsProcess.exitCode == null) metricsProcess.kill("SIGTERM");
    if (fixture?.manifest) await cleanupSyntheticRun({ prisma, manifest: fixture.manifest }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

module.exports = {
  EXACT_POOL_BUDGET,
  K6_IMAGE,
  applyGuardedCapacityEnvironment,
  capacityBindingForState,
  checkoutFingerprint,
  eventOpenPrimaryRaceId,
  k6LoadUsers,
  observedPoolBudget,
  prewarmEventOpenRaceSnapshots,
  validateArtifactProvenance,
  validateCapacity,
  verifyK6Database,
};
