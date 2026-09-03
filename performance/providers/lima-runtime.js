const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const workflow = require("../../scripts/home-capacity-workflow");
const lima = require("../../scripts/lima-capacity");
const { resetCapacityDbPoolMeasurements } = require("../../scripts/k6-home-open");
const { roleUrls } = require("../../scripts/capacity-metrics");
const { assertCapacityDatabaseMarker } = require("../../src/localCapacitySafety");

const ENVIRONMENT_ID = "bara-perf-lima-environment-v1";
const CHILD_ID = `${ENVIRONMENT_ID}-level-r1`;
const REQUIRED_SECRETS = ["CAPACITY_DB_PASSWORD", "CAPACITY_REDIS_PASSWORD", "CAPACITY_AUTH_SECRET",
  "CAPACITY_DB_MARKER", "CAPACITY_SCRUB_ATTESTATION_SECRET"];
const SAFE_RESOURCE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

function ownedRedisCommand({ instance, container, password, prefix, operation } = {}) {
  if (!/^step-capacity[a-z0-9_.-]*$/.test(instance || "") || !SAFE_RESOURCE.test(container || "") ||
      !String(password || "") || !/^capacity:[a-z0-9_.:-]+:$/.test(prefix || "") ||
      !["clear", "count"].includes(operation)) {
    throw new Error("owned Redis command requires safe Lima resources and a capacity prefix");
  }
  const script = operation === "clear"
    ? "local k=redis.call('KEYS',ARGV[1]..'*'); for _,v in ipairs(k) do redis.call('UNLINK',v) end; return #k"
    : "return #redis.call('KEYS',ARGV[1]..'*')";
  return ["shell", instance, "--", "docker", "exec", "-e", `REDISCLI_AUTH=${password}`,
    container, "redis-cli", "--no-auth-warning", "--raw", "EVAL", script, "0", prefix];
}

function exactRaceListRedisCommand({ instance, container, password, prefix, userIds,
  variant, initializeGeneration = false } = {}) {
  if (!/^step-capacity[a-z0-9_.-]*$/.test(instance || "") || !SAFE_RESOURCE.test(container || "") ||
      !String(password || "") || !/^capacity:[a-z0-9_.:-]+:$/.test(prefix || "") ||
      !Array.isArray(userIds) || userIds.length > 5000 ||
      userIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id)) ||
      !/^[a-z0-9:._-]{1,128}$/i.test(variant || "")) {
    throw new Error("exact race-list Redis cleanup requires bounded owned identities");
  }
  const script = "local ids=cjson.decode(ARGV[1]); local n=0; for _,id in ipairs(ids) do " +
    "local gk=ARGV[2]..'v1:user:races:generation:'..id; local g=redis.call('GET',gk) or '0'; " +
    "local keys={gk,ARGV[2]..'v1:user:races:membership:'..id," +
    "ARGV[2]..'v1:user:races:completed:'..id..':'..g..':'..ARGV[3]," +
    "ARGV[2]..'v1:user:races:pending:'..id..':'..g..':'..ARGV[3]}; " +
    "for _,k in ipairs(keys) do n=n+redis.call('UNLINK',k) end " +
    "if ARGV[4]=='1' then redis.call('SET',gk,'0') end end; return n";
  return ["shell", instance, "--", "docker", "exec", "-e", `REDISCLI_AUTH=${password}`,
    container, "redis-cli", "--no-auth-warning", "--raw", "EVAL", script, "0",
    JSON.stringify(userIds), prefix, variant, initializeGeneration ? "1" : "0"];
}

function requestTargetIdentity(url, { timeoutMs = 2_000 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    return Promise.reject(new Error("target identity request requires the loopback HTTP target"));
  }
  return new Promise((resolve, reject) => {
    const request = http.get(parsed, { agent: false, headers: { Connection: "close" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const rawAddress = response.socket.remoteAddress || "";
        resolve({ status: response.statusCode, address: rawAddress.replace(/^::ffff:/, ""), body });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("target identity request timed out")));
    request.once("error", reject);
  });
}

async function targetIdentityCensus(environment, { timeoutMs = 5_000 } = {}) {
  const urls = roleUrls(environment.metricsConfig);
  const byIdentity = new Map();
  const responses = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (!byIdentity.has("http:0") || !byIdentity.has("http:1"))) {
    const response = await requestTargetIdentity(urls.http, { timeoutMs: Math.min(1_000,
      Math.max(100, deadline - Date.now())) });
    responses.push(response);
    const process = response.body?.capacity?.process;
    if (process?.role === "http" && ["0", "1"].includes(String(process.instance))) {
      byIdentity.set(`http:${process.instance}`, Number(process.pid));
    }
  }
  for (const [role, url] of [["resolution", urls.resolution], ["cron", urls.cron]]) {
    const response = await requestTargetIdentity(url, { timeoutMs: 1_000 });
    responses.push(response);
    const process = response.body?.capacity?.process;
    if (process?.role === role && String(process.instance) === "0") {
      byIdentity.set(`${role}:0`, Number(process.pid));
    }
  }
  const required = ["http:0", "http:1", "resolution:0", "cron:0"];
  if (!required.every((identity) => Number.isInteger(byIdentity.get(identity)))) {
    throw new Error("capacity target process identity census is incomplete");
  }
  return { targetResponses: responses, pids: Object.fromEntries(byIdentity) };
}

function racesTabSettingsReadiness(census) {
  const latest = new Map();
  for (const response of census?.targetResponses || []) {
    const process = response.body?.capacity?.process;
    if (process?.role === "http") latest.set(String(process.instance), response);
  }
  for (const instance of ["0", "1"]) {
    const settings = latest.get(instance)?.body?.capacity?.racesTabSettings;
    if (!settings || ["apiRaceListCompactV1Enabled", "redisCacheRaceListEnabled",
      "raceListSqlSummaryV1Enabled"].some((key) => settings[key] !== true)) {
      throw new Error(`Races-tab pinned settings are not visible on HTTP worker ${instance}`);
    }
  }
  return { schema: "races-tab-worker-settings-readiness-v1", workers: ["http:0", "http:1"],
    intended: { apiRaceListCompactV1Enabled: true, redisCacheRaceListEnabled: true,
      raceListSqlSummaryV1Enabled: true } };
}

function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function execFileAbortable(file, args, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: timeoutMs, signal,
      stdio: ["ignore", "pipe", "inherit"] }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(stdout);
    });
  });
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function sourceSubsetHash(bundle, prefix) {
  const rows = bundle.entries.filter((row) => row.name.startsWith(`${prefix}/`))
    .map(({ name, mode, length, contentHash }) => ({ name, mode, length, contentHash }));
  return workflow.hashObject(rows.sort((a, b) => a.name.localeCompare(b.name)));
}
function hostDatabaseUrl(config, local) {
  const user = encodeURIComponent(config.db_user || "capacity");
  const password = encodeURIComponent(local.CAPACITY_DB_PASSWORD);
  return `postgresql://${user}:${password}@127.0.0.1:${config.db_host_port || 55433}/${config.db_name}`;
}
function localEnvironment(repository) {
  const file = path.join(repository, ".env.capacity.local");
  if (!fs.existsSync(file)) throw new Error("missing .env.capacity.local");
  const values = dotenv.parse(fs.readFileSync(file));
  for (const name of REQUIRED_SECRETS) if (!String(values[name] || "").trim()) {
    throw new Error(`missing local capacity secret: ${name}`);
  }
  return values;
}
function prerequisites(commands = ["k6", "limactl", "pg_restore", "psql"]) {
  for (const command of commands) {
    try { execFileSync("which", [command], { stdio: "ignore", timeout: 5_000 }); }
    catch { throw new Error(`missing capacity prerequisite: ${command}`); }
  }
}
function assertConfig(config, repository) {
  if (config.target !== "capacity-vm" || config.provider !== "lima" ||
      config.db_name !== "steps_tracker_capacity" || path.resolve(config.repository) !== repository ||
      !/^step-capacity/.test(config.lima_instance || "")) {
    throw new Error("Lima performance config is not the approved disposable target");
  }
}
function preflightLima({ repository, configPath, verifySnapshot = true,
  checkPrerequisites = prerequisites } = {}) {
  const root = path.resolve(repository);
  const resolvedConfig = path.resolve(configPath || path.join(root, "docs/capacity-load.config.json"));
  const configBytes = fs.readFileSync(resolvedConfig);
  const config = JSON.parse(configBytes);
  assertConfig(config, root); checkPrerequisites();
  const local = localEnvironment(root);
  const parityPath = path.join(root, ".env.capacity-prod-flags");
  if (!fs.existsSync(parityPath)) throw new Error("missing .env.capacity-prod-flags");
  const parity = dotenv.parse(fs.readFileSync(parityPath));
  // This validates the exact production-parity allowlist without exposing any values.
  require("../../src/modules/loadTesting/homeCapacityEnvironment")
    .assertHomeCapacityParityOverlay(parity);
  const verified = verifySnapshot ? workflow.validateSnapshotInputs({ config, localEnvironment: local }) : null;
  return { repository: root, configPath: resolvedConfig, config, configBytes, local, parity,
    parityPath, verified };
}

function readReusableSnapshotMarker(config) {
  const metadataPath = path.resolve(config.snapshot || "");
  if (!fs.existsSync(metadataPath)) throw new Error("approved capacity snapshot metadata is missing");
  const snapshot = readJson(metadataPath);
  if (snapshot.schema !== "capacity-snapshot-v1" || !/^[a-f0-9]{64}$/.test(snapshot.snapshotHash || "") ||
      !/^[a-f0-9]{64}$/.test(snapshot.sourceSnapshotHash || "") ||
      !path.isAbsolute(snapshot.sourceSnapshotPath || "") || !fs.existsSync(snapshot.sourceSnapshotPath)) {
    throw new Error("persisted capacity snapshot marker is invalid");
  }
  const attestationPath = path.resolve(path.dirname(metadataPath), snapshot.scrubAttestationPath || "");
  if (!fs.existsSync(attestationPath)) throw new Error("approved scrub attestation is missing");
  const attestation = readJson(attestationPath);
  if (attestation.snapshotHash !== snapshot.sourceSnapshotHash ||
      !["passed", "complete", "verified"].includes(String(attestation.status || "passed").toLowerCase())) {
    throw new Error("persisted scrub attestation marker is invalid");
  }
  return { snapshotHash: snapshot.snapshotHash, sourceSnapshotHash: snapshot.sourceSnapshotHash,
    attestationStatus: String(attestation.status || "passed").toLowerCase(),
    metadataPath, attestationPath };
}

function environmentRelevantPerformanceConfig(config = {}) {
  return {
    schema: config.schema,
    topology: config.topology,
    background: config.background,
  };
}

function reusableBinding({ commit, preflight, perfConfig, snapshotMarker }) {
  const liveManifestPath = path.resolve(preflight.config.live_manifest || "");
  if (!fs.existsSync(liveManifestPath)) throw new Error("approved live capacity resource manifest is missing");
  return { code: commit, dataset: snapshotMarker.snapshotHash,
    hardware: workflow.hashObject({ vps: preflight.config.vps_specs,
      database: preflight.config.database_specs }),
    profile: "shared-screen-capacity-v1",
    performanceConfig: workflow.hashObject(environmentRelevantPerformanceConfig(perfConfig)),
    providerConfig: sha(preflight.configBytes),
    parity: sha(fs.readFileSync(preflight.parityPath)),
    liveManifest: sha(fs.readFileSync(liveManifestPath)),
    scrubAttestation: sha(fs.readFileSync(snapshotMarker.attestationPath)) };
}

function prismaFor(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return { prisma, pool };
}

function gracefulStop(instance) {
  execFileSync("limactl", ["shell", instance, "--", "sync"],
    { stdio: "inherit", timeout: 30_000 });
  execFileSync("limactl", ["stop", instance],
    { stdio: "inherit", timeout: 120_000 });
}

function createLegacyLimaRuntime({ repository, configPath } = {}) {
  const root = path.resolve(repository);
  const stateRoot = path.join(root, "performance", ".state");
  const statePath = path.join(stateRoot, "lima-environment.json");
  let lock = null;
  const command = (args) => execFileSync("limactl", args, { stdio: "inherit", timeout: 120_000 });
  const writableTree = (target) => {
    if (!fs.existsSync(target)) return;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory()) writableTree(path.join(target, entry.name));
    }
    fs.chmodSync(target, 0o700);
  };
  const removeOwnedChildState = () => {
    for (const category of ["children", "credentials"]) {
      const parent = path.join(stateRoot, category);
      const target = path.join(parent, CHILD_ID);
      if (path.dirname(target) !== parent) throw new Error("owned child state path escaped its root");
      if (!fs.existsSync(target)) continue;
      writableTree(target);
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(target)) throw new Error("owned child state cleanup could not be proven");
    }
  };
  const startExisting = (state, local) => {
    const expected = lima.providerResourceNames({ instance: state.config.lima_instance,
      workflowId: ENVIRONMENT_ID, childId: CHILD_ID });
    if (JSON.stringify(state.reset?.names) !== JSON.stringify(expected)) {
      throw new Error("persisted Lima resource names do not match the owned environment");
    }
    command(["start", state.config.lima_instance]);
    const names = state.reset.names;
    command(["shell", state.config.lima_instance, "--", "docker", "start",
      names.postgresContainer, names.redisContainer]);
    execFileSync("limactl", ["shell", state.config.lima_instance, "--", "bash", "-lc",
      `for n in $(seq 1 120); do docker exec ${names.postgresContainer} pg_isready -U capacity -d steps_tracker_capacity >/dev/null 2>&1 && docker exec ${names.redisContainer} redis-cli -a '${String(local.CAPACITY_REDIS_PASSWORD).replaceAll("'", "'\\''")}' ping 2>/dev/null | grep -qx PONG && exit 0; sleep 1; done; exit 1`],
    { stdio: "inherit", timeout: 125_000 });
    command(["shell", state.config.lima_instance, "--", "docker", "start", names.backendContainer]);
  };
  const runtimeEnvironment = (state, preflight) => {
    const databaseUrl = hostDatabaseUrl(state.config, preflight.local);
    const database = prismaFor(databaseUrl);
    const processEnvironment = { ...process.env, ...preflight.local, ...preflight.parity,
      CAPACITY_MODE: "true", CAPACITY_OUTBOUND_DISABLED: "true", CAPACITY_RUN_ID: CHILD_ID,
      CAPACITY_GLOBAL_EVENT_PROFILE: "home-open", CAPACITY_DATABASE_POOL_PROFILE: "role-budget",
      CAPACITY_DB_NAME: "steps_tracker_capacity", CAPACITY_DB_HOST_ALLOWLIST: "127.0.0.1",
      CAPACITY_REDIS_HOST_ALLOWLIST: "127.0.0.1", CACHE_ENV_PREFIX: `capacity:${CHILD_ID}:`,
      DATABASE_URL: databaseUrl,
      REDIS_URL: `redis://:${encodeURIComponent(preflight.local.CAPACITY_REDIS_PASSWORD)}@127.0.0.1:6379/0`,
      SESSION_TOKEN_SECRET: preflight.local.CAPACITY_AUTH_SECRET,
      PROD_DATABASE_URL: "", STAGING_DATABASE_URL: "", PEER_DATABASE_URL: "",
      APNS_KEY_PATH: "", APNS_SIGNING_KEY: "", APNS_KEY_ID: "", APNS_TEAM_ID: "",
      APNS_BUNDLE_ID: "", FCM_SERVICE_ACCOUNT: "", FCM_SERVICE_ACCOUNT_PATH: "",
      GOOGLE_APPLICATION_CREDENTIALS: "", S3_BUCKET: "", S3_ACCESS_KEY_ID: "",
      S3_SECRET_ACCESS_KEY: "", S3_SESSION_TOKEN: "" };
    return { repository: root, runId: CHILD_ID, datasetId: state.datasetId,
      binding: state.binding, baseUrl: state.config.base_url, resolvedAddresses: ["127.0.0.1"],
      expectedRunId: CHILD_ID, expectedAddress: "127.0.0.1",
      databaseUrl, marker: { owner: "bara-perf", disposable: true }, processEnvironment,
      prisma: database.prisma, prismaPool: database.pool, metricsConfig: { ...state.config,
        backend_container: state.reset.names.backendContainer,
        postgres_container: state.reset.names.postgresContainer,
        redis_container: state.reset.names.redisContainer },
      levelOutputDirectory: path.join(root, "performance", "results", state.activeRunId, "levels"),
      credentialDirectory: path.join(root, "performance", ".state", "credentials", state.activeRunId), state };
  };
  return {
    async runExclusive(input, operation) {
      const resolvedConfig = path.resolve(configPath || path.join(root, "docs/capacity-load.config.json"));
      const providerConfig = readJson(resolvedConfig);
      assertConfig(providerConfig, root);
      const workflowsRoot = path.join(stateRoot, "locks");
      fs.mkdirSync(workflowsRoot, { recursive: true, mode: 0o700 });
      return lima.withProviderLock({ directory: workflowsRoot, instance: providerConfig.lima_instance,
        workflowId: ENVIRONMENT_ID, resourceCensus: lima.providerResourceCensus },
      async (providerLock) => { lock = providerLock; try { return await operation(); } finally { lock = null; } });
    },
    async prepareOnce({ runId, cli, config: perfConfig }) {
      if (!lock) throw new Error("Lima environment preparation requires the provider lock");
      if (cli.background !== "normal") {
        throw new Error("background=off is not first-run ready; normal preserves production topology");
      }
      let preflight = preflightLima({ repository: root, configPath, verifySnapshot: false });
      const commit = workflow.assertCleanSource(root, null);
      const snapshotMarker = readReusableSnapshotMarker(preflight.config);
      const quickBinding = reusableBinding({ commit, preflight, perfConfig, snapshotMarker });
      if (fs.existsSync(statePath)) {
        const state = readJson(statePath);
        if (JSON.stringify(state.binding) === JSON.stringify(quickBinding)) {
          state.activeRunId = runId;
          startExisting(state, preflight.local);
          return runtimeEnvironment(state, preflight);
        }
        throw new Error("prepared Lima binding changed; run ./perf reset before rebuilding the environment");
      }
      // Only first construction performs the expensive dump-byte and full
      // sanitization evidence validation. An unchanged prepared binding uses
      // the cheap persisted markers above.
      preflight = preflightLima({ repository: root, configPath, verifySnapshot: true });
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const bundlePath = path.join(stateRoot, `source-${commit.slice(0, 12)}`);
      const manifestPath = path.join(stateRoot, "environment-manifest.json");
      let manifest = null;
      try {
        const sourceBundle = workflow.createSourceBundle({ repository: root, output: bundlePath });
        const effective = workflow.buildEffectiveEnvironment({ capacity: {
          CAPACITY_MODE: "true", CAPACITY_OUTBOUND_DISABLED: "true",
          CAPACITY_GLOBAL_EVENT_PROFILE: "home-open", CAPACITY_DATABASE_POOL_PROFILE: "role-budget",
          NODE_ENV: "production", PATH: process.env.PATH,
        }, parity: preflight.parity, secrets: Object.fromEntries(REQUIRED_SECRETS
          .map((name) => [name, preflight.local[name]])),
        hmacKey: preflight.local.CAPACITY_SCRUB_ATTESTATION_SECRET });
        manifest = workflow.buildWorkflowManifest({ workflowId: ENVIRONMENT_ID, mode: "level",
          rate: 1, commit, sourceBundleHash: sourceBundle.hash,
          snapshotHash: preflight.verified.snapshot.snapshotHash,
          scrubAttestationHash: sha(fs.readFileSync(preflight.verified.attestationPath)),
          parityHash: sha(fs.readFileSync(preflight.parityPath)),
          resourceManifestHash: workflow.hashObject(preflight.verified.liveManifest),
          effectiveEnvironmentHash: effective.report.hash, configHash: sha(preflight.configBytes),
          snapshotMetadataHash: sha(fs.readFileSync(preflight.verified.metadataPath)),
          migrationHash: sourceSubsetHash(sourceBundle, "prisma/migrations"),
          topologyHash: workflow.hashObject({ processes: { http: 2, resolution: 1, cron: 1 },
            resolutionConcurrency: 2 }), profileVersion: "shared-screen-capacity-v1",
          startRate: 2, maxRate: 500,
          provider: { instance: preflight.config.lima_instance, target: preflight.config.target,
            database: preflight.config.db_name, dbHostPort: Number(preflight.config.db_host_port) } });
        const preparation = lima.prepareWorkflowEnvironment({ configPath: preflight.configPath,
          manifest, sourceBundle, environment: { ...effective.environment,
            CAPACITY_WORKFLOW_MANIFEST: manifestPath }, providerLock: lock });
        fs.writeFileSync(manifestPath,
          `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        removeOwnedChildState();
        const reset = lima.resetWorkflowChild({ configPath: preflight.configPath, manifest,
          child: { runId: CHILD_ID }, sourceBundle, environment: effective.environment,
          providerLock: lock });
        const state = { schema: "bara-perf-lima-environment-v1", binding: quickBinding,
          activeRunId: runId,
          datasetId: `sanitized-${preflight.verified.snapshot.capturedAt ||
            preflight.verified.snapshot.createdAt || quickBinding.dataset.slice(0, 12)}`,
          config: preflight.config, manifest, sourceBundle, preparation, reset };
        fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        return runtimeEnvironment(state, preflight);
      } catch (error) {
        const cleanupErrors = [];
        const attempt = (operation) => { try { operation(); } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        } };
        if (manifest) attempt(() => lima.removeWorkflowChildResources(preflight.config, manifest,
          { runId: CHILD_ID }, lock));
        attempt(() => removeOwnedChildState());
        attempt(() => gracefulStop(preflight.config.lima_instance));
        attempt(() => { if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath); });
        attempt(() => { writableTree(bundlePath); fs.rmSync(bundlePath, { recursive: true, force: true }); });
        if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors],
          `partial Lima environment cleanup failed: ${error.message}`);
        throw error;
      }
    },
    async resetEnvironment() {
      if (!lock) throw new Error("Lima environment reset requires the provider lock");
      if (!fs.existsSync(statePath)) return { reset: false, reason: "not-prepared" };
      const state = readJson(statePath);
      if (state.schema !== "bara-perf-lima-environment-v1" ||
          state.manifest?.workflowId !== ENVIRONMENT_ID ||
          state.reset?.childId !== CHILD_ID) {
        throw new Error("refusing to reset an unowned Lima environment state");
      }
      const preflight = preflightLima({ repository: root, configPath, verifySnapshot: false });
      startExisting(state, preflight.local);
      const cleanupErrors = [];
      const attempt = (operation) => { try { operation(); } catch (error) { cleanupErrors.push(error); } };
      attempt(() => lima.removeWorkflowChildResources(state.config, state.manifest,
        { runId: CHILD_ID }, lock));
      attempt(() => removeOwnedChildState());
      attempt(() => gracefulStop(state.config.lima_instance));
      const sourcePath = path.resolve(state.sourceBundle.path);
      if (sourcePath !== stateRoot && sourcePath.startsWith(`${stateRoot}${path.sep}source-`)) {
        attempt(() => { writableTree(sourcePath); fs.rmSync(sourcePath, { recursive: true, force: true }); });
      } else cleanupErrors.push(new Error("prepared source path is outside the performance state root"));
      for (const file of [statePath, path.join(stateRoot, "environment-manifest.json")]) {
        attempt(() => { if (fs.existsSync(file)) fs.unlinkSync(file); });
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors,
        "Lima environment reset cleanup failed");
      return { reset: true };
    },
    async validate({ environment }) {
      await assertCapacityDatabaseMarker({ env: environment.processEnvironment });
      const census = await targetIdentityCensus(environment);
      if (census.targetResponses.some((response) => response.body?.capacity?.runId !== CHILD_ID)) {
        throw new Error("Lima HTTP worker identity does not match the prepared environment");
      }
      environment.expectedPids = census.pids;
      return census;
    },
    async settle({ environment }) {
      const deadline = Date.now() + 10_000;
      do {
        const rows = await environment.prisma.raceResolutionJobV2.count({
          where: { state: { in: ["QUEUED", "RUNNING"] } } });
        if (rows === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      throw new Error("resolution queue did not settle within its configured budget");
    },
    async liveness({ environment }) {
      const census = await targetIdentityCensus(environment);
      if (census.targetResponses.some((response) => response.body?.capacity?.runId !== CHILD_ID)) {
        throw new Error("capacity process identity drifted");
      }
      if (environment.expectedPids && Object.entries(environment.expectedPids)
        .some(([identity, pid]) => census.pids[identity] !== pid)) {
        throw new Error("capacity process restarted during the workflow");
      }
      return census;
    },
    async verifyRacesTabSettings({ environment }) {
      return racesTabSettingsReadiness(await targetIdentityCensus(environment));
    },
    async resetMetrics({ environment }) {
      const measurementId = `${Date.now()}-${crypto.randomUUID()}`;
      environment.metricEpoch = await resetCapacityDbPoolMeasurements(
        environment.metricsConfig, CHILD_ID, measurementId);
      await environment.prisma.$queryRawUnsafe("SELECT pg_stat_statements_reset()");
      return environment.metricEpoch;
    },
    async collectMetrics({ environment }) { return environment.lastMeasurementMetrics || {}; },
    async deleteExactRaceListCache({ environment, userIds, variant, initializeGeneration = false,
      deadlineMillis, timeoutMs, signal }) {
      const remaining = Math.min(Number(timeoutMs), Number(deadlineMillis) - Date.now());
      if (!Number.isFinite(remaining) || remaining <= 0 || signal?.aborted) {
        throw signal?.reason || new Error("Races-tab Redis deletion deadline expired");
      }
      const output = await execFileAbortable("limactl", exactRaceListRedisCommand({
        instance: environment.state.config.lima_instance,
        container: environment.state.reset.names.redisContainer,
        password: environment.processEnvironment.CAPACITY_REDIS_PASSWORD,
        prefix: environment.processEnvironment.CACHE_ENV_PREFIX, userIds, variant,
        initializeGeneration,
      }), { timeoutMs: Math.max(1, remaining), signal });
      return Number(output.trim());
    },
    async clearOwnedCache({ environment }) {
      execFileSync("limactl", ownedRedisCommand({ instance: environment.state.config.lima_instance,
        container: environment.state.reset.names.redisContainer,
        password: environment.processEnvironment.CAPACITY_REDIS_PASSWORD,
        prefix: environment.processEnvironment.CACHE_ENV_PREFIX, operation: "clear" }),
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30_000 });
    },
    async verifyOwnedCacheEmpty({ environment }) {
      const count = Number(execFileSync("limactl", ownedRedisCommand({
        instance: environment.state.config.lima_instance,
        container: environment.state.reset.names.redisContainer,
        password: environment.processEnvironment.CAPACITY_REDIS_PASSWORD,
        prefix: environment.processEnvironment.CACHE_ENV_PREFIX, operation: "count" }),
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30_000 }).trim());
      if (count !== 0) throw new Error(`owned cache was not empty after reset (${count} keys)`);
    },
    async cleanup({ environment }) {
      const errors = [];
      try { await environment.prisma.$disconnect(); } catch (error) { errors.push(error); }
      try { await environment.prismaPool.end(); } catch (error) { errors.push(error); }
      try { gracefulStop(environment.state.config.lima_instance); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Lima capacity cleanup failed");
    },
  };
}

module.exports = { CHILD_ID, ENVIRONMENT_ID, createLegacyLimaRuntime,
  environmentRelevantPerformanceConfig, exactRaceListRedisCommand, ownedRedisCommand,
  preflightLima, readReusableSnapshotMarker, requestTargetIdentity, reusableBinding,
  racesTabSettingsReadiness, targetIdentityCensus };
