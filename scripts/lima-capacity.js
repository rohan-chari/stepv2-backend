#!/usr/bin/env node

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

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

function capacityRunId(settings, environment = process.env) {
  return required(environment.CAPACITY_RUN_ID || settings.run_id, "run_id");
}

function isPresent(name) {
  return output("limactl", ["list", "-q"]).split(/\r?\n/).filter(Boolean).includes(name);
}

function startVm(settings) {
  const name = limaName(settings);
  if (isPresent(name)) {
    run("limactl", ["start", "--yes", name]);
    return;
  }
  run("limactl", [
    "start", "--yes", `--name=${name}`, `--cpus=${settings.vps_specs.vcpu}`,
    `--memory=${settings.vps_specs.ram_gb}`, `--disk=${settings.vps_specs.disk_gb}`,
    `--mount=${repo(settings)}:w`, "--port-forward=3000:3000",
    "--port-forward=3010:3010", "--port-forward=3011:3011",
    `--port-forward=${settings.db_host_port || 55433}:5432`, "template:docker",
  ]);
}

function shell(settings, command) {
  run("limactl", ["shell", limaName(settings), "--", "bash", "-lc", command]);
}

function startDatabase(settings) {
  const name = `${limaName(settings)}-postgres`;
  const password = dbPassword().replaceAll("'", "'\\''");
  const database = settings.db_name || "steps_tracker_capacity";
  shell(settings, [
    `docker rm -f ${name} >/dev/null 2>&1 || true`,
    `docker volume rm -f ${name}-data >/dev/null 2>&1 || true`,
    `docker volume create ${name}-data >/dev/null`,
    `docker run -d --name ${name} --restart unless-stopped --cpus=1 --memory=2g -p 5432:5432 -e POSTGRES_DB=${database} -e POSTGRES_USER=capacity -e POSTGRES_PASSWORD='${password}' -v ${name}-data:/var/lib/postgresql postgres:18 -c max_connections=47`,
  ].join(" && "));
  shell(settings, `until docker exec ${name} pg_isready -U capacity -d ${database}; do sleep 1; done`);
  const redis = `${limaName(settings)}-redis`;
  const redisSecret = redisPassword().replaceAll("'", "'\\''");
  shell(settings, [
    `docker rm -f ${redis} >/dev/null 2>&1 || true`,
    `docker run -d --name ${redis} --restart unless-stopped --network host --memory=128m --cpus=1 redis:7.0.15 redis-server --bind 127.0.0.1 ::1 --port 6379 --requirepass '${redisSecret}' --maxmemory 100mb --maxmemory-policy allkeys-lru --appendonly no --save \"\"`,
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
  const runId = capacityRunId(settings);
  const env = [
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
    `-e CAPACITY_PROVIDER_ATTEMPT_COUNT=12000`,
    `-e DB_POOL_MAX=20`,
    `-e CAPACITY_AUTH_SECRET=${JSON.stringify(required(process.env.CAPACITY_AUTH_SECRET, "CAPACITY_AUTH_SECRET"))}`,
    `-e SESSION_TOKEN_SECRET=${JSON.stringify(required(process.env.CAPACITY_AUTH_SECRET, "CAPACITY_AUTH_SECRET"))}`,
    `-e PORT=3000`, `-e NODE_ENV=production`,
    `-e APNS_PRODUCTION=false`, `-e PROD_DATABASE_URL=`, `-e STAGING_DATABASE_URL=`, `-e PEER_DATABASE_URL=`,
    `-e APNS_KEY_PATH=`, `-e APNS_SIGNING_KEY=`, `-e APNS_KEY_ID=`, `-e APNS_TEAM_ID=`, `-e APNS_BUNDLE_ID=`,
    `-e FCM_SERVICE_ACCOUNT=`, `-e FCM_SERVICE_ACCOUNT_PATH=`, `-e GOOGLE_APPLICATION_CREDENTIALS=`,
    `-e S3_BUCKET=`, `-e S3_ACCESS_KEY_ID=`, `-e S3_SECRET_ACCESS_KEY=`, `-e S3_SESSION_TOKEN=`,
  ].join(" ");
  const root = repo(settings);
  // Recreate on every guarded start. Reusing a same-profile container could
  // preserve a prior CAPACITY_RUN_ID while lifecycle state names a new run.
  shell(settings, `docker rm -f ${name} >/dev/null 2>&1 || true && docker volume create ${name}-node-modules >/dev/null && docker run -d --name ${name} --restart unless-stopped --network host --cpus=3 --memory=6g -v ${JSON.stringify(root)}:/workspace:ro -v ${name}-node-modules:/workspace/node_modules -w /workspace ${env} node:22 bash -lc 'npm ci --ignore-scripts && npx prisma generate && npx prisma migrate deploy && node scripts/capacity-cluster.js' && for attempt in $(seq 1 120); do curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`);
}

function stopBackend(settings) {
  shell(settings, `docker rm -f ${limaName(settings)}-backend >/dev/null 2>&1 || true`);
}

function destroy(settings) {
  if (isPresent(limaName(settings))) run("limactl", ["delete", "--force", "--yes", limaName(settings)]);
}

function main() {
  const [command] = process.argv.slice(2);
  const settings = config(parseArgs(process.argv.slice(3)));
  if (command === "restore") { startVm(settings); startDatabase(settings); runCapacityDb(settings, "restore", ["--snapshot", required(process.env.CAPACITY_SNAPSHOT_PATH, "CAPACITY_SNAPSHOT_PATH")]); return; }
  if (command === "scrub") { runCapacityDb(settings, "scrub", ["--snapshot", required(process.env.CAPACITY_SNAPSHOT_PATH, "CAPACITY_SNAPSHOT_PATH"), "--attestation", required(process.env.CAPACITY_SCRUB_ATTESTATION_PATH, "CAPACITY_SCRUB_ATTESTATION_PATH")]); return; }
  if (command === "start") { startBackend(settings); return; }
  if (command === "stop") { stopBackend(settings); return; }
  if (command === "destroy") { destroy(settings); return; }
  throw new Error("usage: node scripts/lima-capacity.js <restore|scrub|start|stop|destroy> --config <file>");
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = { capacityRunId, globalEventProfile };
