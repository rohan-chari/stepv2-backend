#!/usr/bin/env node

const dotenv = require("dotenv");
dotenv.config();

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { capacityPoolProfile } = require("./capacity-cluster");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    result[key] = !next || next.startsWith("--") ? true : argv[++index];
  }
  return result;
}

function config(args) {
  if (!args.config) throw new Error("--config is required");
  return JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
}

function required(value, name) {
  if (!String(value || "").trim()) throw new Error(`${name} is required`);
  return String(value);
}

function run(command, args = [], options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

function output(command, args = []) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function limaName(settings) { return settings.lima_instance || `step-capacity-${settings.run_id}`; }
function repo(settings) { return path.resolve(required(settings.repository, "repository")); }
function dbPassword() { return required(process.env.CAPACITY_DB_PASSWORD, "CAPACITY_DB_PASSWORD"); }
function redisPassword() { return required(process.env.CAPACITY_REDIS_PASSWORD, "CAPACITY_REDIS_PASSWORD"); }
function dbUrl(settings) {
  const user = encodeURIComponent(settings.db_user || "capacity");
  const password = encodeURIComponent(dbPassword());
  const port = settings.db_host_port || 55433;
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${settings.db_name || "steps_tracker_capacity"}`;
}

function globalEventProfile(settings, environment = process.env) {
  return environment.CAPACITY_GLOBAL_EVENT_PROFILE || settings.profile || "";
}

function capacityParityOverlay() {
  const overlayPath = path.resolve(__dirname, "../.env.capacity-prod-flags");
  const parsed = dotenv.parse(fs.readFileSync(overlayPath));
  for (const name of ["NODE_ENV", "ASYNC_RACE_RESOLUTION_CONCURRENCY",
    "RACE_RESOLVE_DEBOUNCE_MS", "SYNC_V2_INLINE_UPLOADER_RECONCILIATION"]) {
    if (!String(parsed[name] || "").trim()) {
      throw new Error(`capacity production parity overlay is missing ${name}`);
    }
  }
  return parsed;
}

function homeOpenResolutionConcurrency(settings, environment = process.env) {
  if (globalEventProfile(settings, environment) !== "home-open") return null;
  const parity = capacityParityOverlay();
  const concurrency = String(environment.ASYNC_RACE_RESOLUTION_CONCURRENCY ||
    parity.ASYNC_RACE_RESOLUTION_CONCURRENCY || "").trim();
  if (concurrency !== "2") {
    throw new Error("home-open capacity requires ASYNC_RACE_RESOLUTION_CONCURRENCY=2 for production parity");
  }
  return concurrency;
}

function capacityRunId(settings, environment = process.env) {
  return required(environment.CAPACITY_RUN_ID || settings.run_id, "run_id");
}

function isPresent(name) {
  return output("limactl", ["list", "-q"]).split(/\r?\n/).filter(Boolean).includes(name);
}

function capacityResourcePlan(settings) {
  const vps = settings.vps_specs || {};
  const database = settings.database_specs || {};
  const backendCpu = Number(vps.vcpu);
  const backendMemoryGb = Number(vps.ram_gb);
  const databaseCpu = Number(database.vcpu);
  const databaseMemoryGb = Number(database.ram_gb);
  for (const [name, value] of Object.entries({ backendCpu, backendMemoryGb, databaseCpu, databaseMemoryGb })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`capacity config requires positive ${name}`);
  }
  return {
    // The generator runs on the host. The containing VM reserves explicit
    // capacity for Redis and for the guest/container/telemetry overhead while
    // the backend and database retain their production-shaped cgroup caps.
    vmCpu: backendCpu + databaseCpu + 2,
    vmMemoryGb: backendMemoryGb + databaseMemoryGb + 2,
    backendCpu,
    backendMemoryGb,
    databaseCpu,
    databaseMemoryGb,
    redisCpu: 1,
    redisMemoryMb: 256,
    overheadCpu: 1,
    overheadMemoryMb: 1792,
  };
}

function parseLimaResources(raw) {
  const value = typeof raw === "string" ? JSON.parse(raw.trim().split(/\r?\n/).filter(Boolean).at(-1)) : raw;
  const bytesToGiB = (bytes) => Number(bytes) / 1024 ** 3;
  return {
    cpu: Number(value.cpus ?? value.CPUs ?? value.cpu),
    memoryGb: Number(value.memoryGiB ?? value.memory_gib ?? (value.memory ? bytesToGiB(value.memory) : NaN)),
    diskGb: Number(value.diskGiB ?? value.disk_gib ?? (value.disk ? bytesToGiB(value.disk) : NaN)),
  };
}

function inspectVmResources(name) {
  return parseLimaResources(output("limactl", ["list", "--format", "json", name]));
}

function ensureVmResources(settings, dependencies = {}) {
  const name = limaName(settings);
  const present = dependencies.present || isPresent;
  const execute = dependencies.execute || run;
  const inspect = dependencies.inspect || inspectVmResources;
  const resources = capacityResourcePlan(settings);
  const desired = { cpu: resources.vmCpu, memoryGb: resources.vmMemoryGb,
    diskGb: Number(settings.vps_specs.disk_gb) };
  if (present(name)) {
    const before = inspect(name);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      execute("limactl", ["stop", "--force", name]);
      execute("limactl", ["edit", "--yes", `--cpus=${desired.cpu}`,
        `--memory=${desired.memoryGb}`, `--disk=${desired.diskGb}`, name]);
    }
    execute("limactl", ["start", "--yes", name]);
  } else execute("limactl", [
    "start", "--yes", `--name=${name}`, `--cpus=${resources.vmCpu}`,
    `--memory=${resources.vmMemoryGb}`, `--disk=${settings.vps_specs.disk_gb}`,
    `--mount=${repo(settings)}:w`, "--port-forward=3000:3000",
    "--port-forward=3010:3010", "--port-forward=3011:3011",
    `--port-forward=${settings.db_host_port || 55433}:5432`, "template:docker",
  ]);
  const actual = inspect(name);
  if (JSON.stringify(actual) !== JSON.stringify(desired)) {
    throw new Error(`capacity VM resource mismatch: expected ${JSON.stringify(desired)}, actual ${JSON.stringify(actual)}`);
  }
  return actual;
}

function startVm(settings) {
  return ensureVmResources(settings);
}

function shell(settings, command) {
  run("limactl", ["shell", limaName(settings), "--", "bash", "-lc", command]);
}

function shellOutput(settings, command) {
  return output("limactl", ["shell", limaName(settings), "--", "bash", "-lc", command]);
}

function healthCensus(settings) {
  const raw = shellOutput(settings,
    "for attempt in $(seq 1 30); do curl -fsS --max-time 2 -H 'Connection: close' http://127.0.0.1:3000/health || true; echo; done");
  const rows = raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const identities = {};
  for (const row of rows) {
    const process = row?.capacity?.process;
    if (process?.role === "http") identities[`http:${process.instance}`] = process.pid;
  }
  return { redis: rows.at(-1)?.redis || null, identities };
}

function startDatabase(settings) {
  const name = `${limaName(settings)}-postgres`;
  const password = dbPassword().replaceAll("'", "'\\''");
  const database = settings.db_name || "steps_tracker_capacity";
  const resources = capacityResourcePlan(settings);
  shell(settings, [
    `docker rm -f ${name} >/dev/null 2>&1 || true`,
    `docker volume rm -f ${name}-data >/dev/null 2>&1 || true`,
    `docker volume create ${name}-data >/dev/null`,
    `docker run -d --name ${name} --restart unless-stopped --cpus=${resources.databaseCpu} --memory=${resources.databaseMemoryGb}g -p 5432:5432 -e POSTGRES_DB=${database} -e POSTGRES_USER=capacity -e POSTGRES_PASSWORD='${password}' -v ${name}-data:/var/lib/postgresql postgres:18 -c max_connections=${settings.database_specs.connection_limit} -c shared_preload_libraries=pg_stat_statements`,
  ].join(" && "));
  shell(settings, `until docker exec ${name} pg_isready -U capacity -d ${database}; do sleep 1; done`);
  // Query-shape telemetry is confined to the disposable capacity database and
  // lets failed gates identify real SQL cost without production instrumentation.
  shell(settings, `docker exec ${name} psql -U capacity -d ${database} -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' >/dev/null`);
  const redis = `${limaName(settings)}-redis`;
  const redisSecret = redisPassword().replaceAll("'", "'\\''");
  shell(settings, [
    `docker rm -f ${redis} >/dev/null 2>&1 || true`,
    // The managed tier's 100MB limit applies to Redis data (`maxmemory`), not
    // allocator metadata, client buffers, or the server binary. A 128MB Docker
    // cgroup killed Redis under the 2,000-client shock before allkeys-lru could
    // enforce the real tier limit, turning a baseline run into an accidental
    // outage test. Reserve process overhead while keeping the exact 100MB data
    // ceiling and eviction policy under test.
    `docker run -d --name ${redis} --restart unless-stopped --network host --memory=256m --cpus=1 redis:7.0.15 redis-server --bind 127.0.0.1 ::1 --port 6379 --requirepass '${redisSecret}' --maxmemory 100mb --maxmemory-policy allkeys-lru --appendonly no --save \"\"`,
    `until docker exec ${redis} redis-cli -a '${redisSecret}' ping 2>/dev/null | grep -qx PONG; do sleep 1; done`,
  ].join(" && "));
}

function runCapacityDb(settings, command, extra = []) {
  const script = path.join(repo(settings), "scripts", "capacity-db.js");
  const outboundCleared = {
    APNS_KEY_PATH: "", APNS_SIGNING_KEY: "", APNS_KEY_ID: "", APNS_TEAM_ID: "", APNS_BUNDLE_ID: "",
    FCM_SERVICE_ACCOUNT: "", FCM_SERVICE_ACCOUNT_PATH: "", GOOGLE_APPLICATION_CREDENTIALS: "",
    S3_BUCKET: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "", S3_SESSION_TOKEN: "",
    PROD_DATABASE_URL: "", STAGING_DATABASE_URL: "", PEER_DATABASE_URL: "", APNS_PRODUCTION: "false",
  };
  run("node", [script, command, ...extra], { env: {
    ...process.env,
    ...outboundCleared,
    DATABASE_URL: dbUrl(settings),
    CAPACITY_MODE: "true",
    CAPACITY_OUTBOUND_DISABLED: "true",
    CAPACITY_DB_HOST_ALLOWLIST: "127.0.0.1",
    CAPACITY_DB_NAME: settings.db_name || "steps_tracker_capacity",
    PATH: `/opt/homebrew/opt/postgresql@18/bin:${process.env.PATH || ""}`,
  } });
}

function startBackend(settings) {
  const name = `${limaName(settings)}-backend`;
  const databaseUrl = dbUrl({ ...settings, db_host_port: 5432 }).replace("127.0.0.1:55433", "127.0.0.1:5432");
  const capacityProfile = globalEventProfile(settings);
  const databasePoolProfile = capacityPoolProfile(settings);
  const runId = capacityRunId(settings);
  const resolutionConcurrency = homeOpenResolutionConcurrency(settings);
  const parityOverlay = capacityProfile === "home-open" ? capacityParityOverlay() : {};
  const env = [
    ...Object.entries(parityOverlay).map(([name, value]) =>
      `-e ${name}=${JSON.stringify(String(value))}`),
    `-e DATABASE_URL=${JSON.stringify(databaseUrl)}`,
    `-e CAPACITY_MODE=true`, `-e CAPACITY_OUTBOUND_DISABLED=true`,
    `-e CAPACITY_RUN_ID=${JSON.stringify(runId)}`,
    `-e CAPACITY_DB_NAME=${JSON.stringify(settings.db_name || "steps_tracker_capacity")}`,
    `-e CAPACITY_DB_HOST_ALLOWLIST=127.0.0.1`,
    `-e CAPACITY_DB_MARKER=${JSON.stringify(required(process.env.CAPACITY_DB_MARKER, "CAPACITY_DB_MARKER"))}`,
    `-e CAPACITY_REDIS_HOST_ALLOWLIST=127.0.0.1`,
    `-e REDIS_URL=${JSON.stringify(`redis://:${encodeURIComponent(redisPassword())}@127.0.0.1:6379/0`)}`,
    `-e CACHE_ENV_PREFIX=${JSON.stringify(`capacity:${runId}:`)}`,
    `-e CAPACITY_GLOBAL_EVENT_PROFILE=${JSON.stringify(capacityProfile)}`,
    `-e CAPACITY_DATABASE_POOL_PROFILE=${JSON.stringify(databasePoolProfile)}`,
    ...(resolutionConcurrency == null
      ? []
      : [`-e ASYNC_RACE_RESOLUTION_CONCURRENCY=${JSON.stringify(resolutionConcurrency)}`]),
    `-e CAPACITY_PROVIDER_ATTEMPT_COUNT=12000`,
    `-e CAPACITY_AUTH_SECRET=${JSON.stringify(required(process.env.CAPACITY_AUTH_SECRET, "CAPACITY_AUTH_SECRET"))}`,
    `-e SESSION_TOKEN_SECRET=${JSON.stringify(required(process.env.CAPACITY_AUTH_SECRET, "CAPACITY_AUTH_SECRET"))}`,
    `-e PORT=3000`, `-e NODE_ENV=production`,
    `-e APNS_PRODUCTION=false`, `-e PROD_DATABASE_URL=`, `-e STAGING_DATABASE_URL=`, `-e PEER_DATABASE_URL=`,
    `-e APNS_KEY_PATH=`, `-e APNS_SIGNING_KEY=`, `-e APNS_KEY_ID=`, `-e APNS_TEAM_ID=`, `-e APNS_BUNDLE_ID=`,
    `-e FCM_SERVICE_ACCOUNT=`, `-e FCM_SERVICE_ACCOUNT_PATH=`, `-e GOOGLE_APPLICATION_CREDENTIALS=`,
    `-e S3_BUCKET=`, `-e S3_ACCESS_KEY_ID=`, `-e S3_SECRET_ACCESS_KEY=`, `-e S3_SESSION_TOKEN=`,
  ].join(" ");
  const root = repo(settings);
  const resources = capacityResourcePlan(settings);
  // Recreate on every guarded start. Reusing a same-profile container could
  // preserve a prior CAPACITY_RUN_ID while lifecycle state names a new run.
  shell(settings, `docker rm -f ${name} >/dev/null 2>&1 || true && docker volume create ${name}-node-modules >/dev/null && docker run -d --name ${name} --restart unless-stopped --network host --cpus=${resources.backendCpu} --memory=${resources.backendMemoryGb}g -v ${JSON.stringify(root)}:/workspace:ro -v ${name}-node-modules:/workspace/node_modules -w /workspace ${env} node:22 bash -lc 'npm ci --ignore-scripts && npx prisma generate && npx prisma migrate deploy && node scripts/capacity-cluster.js' && for attempt in $(seq 1 120); do curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`);
}

function stopBackend(settings) {
  shell(settings, `docker rm -f ${limaName(settings)}-backend >/dev/null 2>&1 || true`);
}

function destroy(settings) {
  if (isPresent(limaName(settings))) run("limactl", ["delete", "--force", "--yes", limaName(settings)]);
}

function faultPlan({ instance, scenario, durationSeconds = 60 } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(String(instance || ""))) {
    throw new Error("capacity fault requires a safe disposable Lima instance name");
  }
  if (scenario === "redis-outage") return {
    scenario, target: `${instance}-redis`, durationSeconds: Number(durationSeconds),
    action: "stop-start", requiresRecovery: true,
  };
  if (scenario === "worker-restart") return {
    scenario, target: `${instance}-backend`, durationSeconds: 0,
    action: "SIGUSR2", requiresRecovery: true,
  };
  if (scenario === "baseline") return {
    scenario, target: `${instance}-backend`, durationSeconds: 0,
    action: "observe-only", requiresRecovery: true,
  };
  throw new Error("capacity fault scenario must be baseline, redis-outage, or worker-restart");
}

function writeExclusiveJson(file, value) {
  const target = path.resolve(required(file, "fault artifact"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function executeFault(settings, args) {
  if (process.env.CAPACITY_MODE !== "true") throw new Error("capacity faults require CAPACITY_MODE=true");
  const instance = limaName(settings);
  const plan = faultPlan({
    instance,
    scenario: required(args.scenario, "scenario"),
    durationSeconds: Number(args.duration_seconds || 60),
  });
  const evidence = {
    schema: "capacity-fault-v1", runId: capacityRunId(settings), ...plan,
    requestedAt: new Date().toISOString(), appliedAt: null, recoveredAt: null,
    executed: false, recovered: false,
    before: healthCensus(settings), after: null,
  };
  const delaySeconds = Math.max(0, Number(args.delay_seconds || 0));
  if (delaySeconds > 0) await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
  if (plan.action === "stop-start") {
    shell(settings, `docker stop ${plan.target} >/dev/null`);
    evidence.appliedAt = new Date().toISOString();
    evidence.executed = true;
    await new Promise((resolve) => setTimeout(resolve, plan.durationSeconds * 1000));
    shell(settings, `docker start ${plan.target} >/dev/null && until docker exec ${plan.target} redis-cli -a '${redisPassword().replaceAll("'", "'\\''")}' ping 2>/dev/null | grep -qx PONG; do sleep 1; done`);
  } else if (plan.action === "SIGUSR2") {
    shell(settings, `docker kill --signal=USR2 ${plan.target} >/dev/null`);
    evidence.appliedAt = new Date().toISOString();
    evidence.executed = true;
  } else {
    evidence.appliedAt = new Date().toISOString();
    evidence.executed = true;
  }
  shell(settings, `for attempt in $(seq 1 60); do curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`);
  if (plan.action === "SIGUSR2") {
    const beforePid = evidence.before.identities["http:0"];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      evidence.after = healthCensus(settings);
      const afterPid = evidence.after.identities["http:0"];
      if (beforePid && afterPid && beforePid !== afterPid &&
          evidence.after.identities["http:1"] === evidence.before.identities["http:1"]) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!beforePid || evidence.after?.identities?.["http:0"] === beforePid ||
        evidence.after?.identities?.["http:1"] !== evidence.before.identities["http:1"]) {
      throw new Error("worker-restart fault did not prove http:0 replacement with http:1 continuity");
    }
  } else {
    evidence.after = healthCensus(settings);
  }
  evidence.recoveredAt = new Date().toISOString();
  evidence.recovered = true;
  writeExclusiveJson(args.artifact, evidence);
  return evidence;
}

async function main() {
  const [command] = process.argv.slice(2);
  const settings = config(parseArgs(process.argv.slice(3)));
  if (command === "restore") { startVm(settings); startDatabase(settings); runCapacityDb(settings, "restore", ["--snapshot", required(process.env.CAPACITY_SNAPSHOT_PATH, "CAPACITY_SNAPSHOT_PATH")]); return; }
  if (command === "scrub") { runCapacityDb(settings, "scrub", ["--snapshot", required(process.env.CAPACITY_SNAPSHOT_PATH, "CAPACITY_SNAPSHOT_PATH"), "--attestation", required(process.env.CAPACITY_SCRUB_ATTESTATION_PATH, "CAPACITY_SCRUB_ATTESTATION_PATH")]); return; }
  if (command === "start") { startBackend(settings); return; }
  if (command === "stop") { stopBackend(settings); return; }
  if (command === "destroy") { destroy(settings); return; }
  if (command === "fault") { await executeFault(settings, parseArgs(process.argv.slice(3))); return; }
  throw new Error("usage: node scripts/lima-capacity.js <restore|scrub|start|stop|destroy|fault> --config <file>");
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}

module.exports = { capacityParityOverlay, capacityResourcePlan, capacityRunId, ensureVmResources, executeFault, faultPlan,
  globalEventProfile, homeOpenResolutionConcurrency, inspectVmResources, parseLimaResources };
