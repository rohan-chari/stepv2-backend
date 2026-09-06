#!/usr/bin/env node

const dotenv = require("dotenv");
dotenv.config();

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");
const { capacityPoolProfile } = require("./capacity-cluster");
const { assertSnapshotAttestation } = require("../src/modules/loadTesting/safety");
const { HOME_CAPACITY_PARITY_ENV_NAMES,
  assertHomeCapacityParityOverlay } = require("../src/modules/loadTesting/homeCapacityEnvironment");

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

const PROVIDER_OPERATION_TIMEOUT_MS = 15 * 60_000;
const PHASE_TIMEOUT_MS = Object.freeze({ prepare: 900_000, reset: 600_000, cleanup: 180_000 });

function run(command, args = [], options = {}) {
  return execFileSync(command, args, { stdio: "inherit", timeout: PROVIDER_OPERATION_TIMEOUT_MS,
    killSignal: "SIGKILL", ...options });
}

function output(command, args = [], options = {}) {
  return execFileSync(command, args, { encoding: "utf8", timeout: PROVIDER_OPERATION_TIMEOUT_MS,
    killSignal: "SIGKILL", ...options }).trim();
}

function limaName(settings) { return settings.lima_instance || `step-capacity-${settings.run_id}`; }
function repo(settings) { return path.resolve(required(settings.repository, "repository")); }
function dbPassword(environment = process.env) { return required(environment.CAPACITY_DB_PASSWORD, "CAPACITY_DB_PASSWORD"); }
function redisPassword() { return required(process.env.CAPACITY_REDIS_PASSWORD, "CAPACITY_REDIS_PASSWORD"); }
function dbUrl(settings, environment = process.env) {
  const user = encodeURIComponent(settings.db_user || "capacity");
  const password = encodeURIComponent(dbPassword(environment));
  const port = settings.db_host_port || 55433;
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${settings.db_name || "steps_tracker_capacity"}`;
}

function globalEventProfile(settings, environment = process.env) {
  return environment.CAPACITY_GLOBAL_EVENT_PROFILE || settings.profile || "";
}

function capacityParityOverlay() {
  const overlayPath = path.resolve(__dirname, "../.env.capacity-prod-flags");
  const parsed = dotenv.parse(fs.readFileSync(overlayPath));
  assertHomeCapacityParityOverlay(parsed);
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

function isRunning(name) {
  if (!isPresent(name)) return false;
  const row = JSON.parse(output("limactl", ["list", "--format", "json", name]).split(/\r?\n/)
    .filter(Boolean).at(-1));
  return String(row.status || row.Status || "").toLowerCase() === "running";
}

const SAFE_PROVIDER_NAME = /^[a-z0-9][a-z0-9_.-]{2,62}$/;
const WORKFLOW_LABEL = "com.bara.capacity.workflow";
const CHILD_LABEL = "com.bara.capacity.child";
const OWNER_LABEL = "com.bara.capacity.owner";
const OWNER_VALUE = "home-capacity-workflow-v1";

function safeProviderName(value, label = "provider resource") {
  if (!SAFE_PROVIDER_NAME.test(String(value || ""))) {
    throw new Error(`${label} requires a safe 3-63 character capacity-only name`);
  }
  return String(value);
}

function providerResourceNames({ instance, workflowId, childId } = {}) {
  safeProviderName(instance, "Lima instance");
  if (!/^step-capacity(?:[a-z0-9_.-]*)$/.test(instance)) {
    throw new Error("Lima instance must use the step-capacity prefix");
  }
  if (!/^[a-z0-9][a-z0-9_.-]{5,63}$/.test(workflowId || "") ||
      !String(childId || "").startsWith(`${workflowId}-`) ||
      !/^[a-z0-9][a-z0-9_.-]{5,63}$/.test(childId || "")) {
    throw new Error("provider child must be a safe workflow descendant");
  }
  const token = crypto.createHash("sha256").update(childId).digest("hex").slice(0, 12);
  const prefix = safeProviderName(`${instance}-home-${token}`);
  return {
    postgresContainer: safeProviderName(`${prefix}-postgres`),
    postgresVolume: safeProviderName(`${prefix}-pgdata`),
    redisContainer: safeProviderName(`${prefix}-redis`),
    backendContainer: safeProviderName(`${prefix}-backend`),
  };
}

function workflowLabels(workflowId, childId = null) {
  const labels = { [WORKFLOW_LABEL]: workflowId, [OWNER_LABEL]: OWNER_VALUE };
  if (childId) labels[CHILD_LABEL] = childId;
  return labels;
}

function assertOwnedResource({ name, labels, workflowId, childId = null } = {}) {
  safeProviderName(name);
  if (labels?.[OWNER_LABEL] !== OWNER_VALUE || labels?.[WORKFLOW_LABEL] !== workflowId ||
      childId != null && labels?.[CHILD_LABEL] !== childId) {
    throw new Error(`capacity resource ownership proof failed for ${name}`);
  }
  return true;
}

function processStartIdentity(pid = process.pid) {
  try { return output("ps", ["-o", "lstart=", "-p", String(pid)]).replace(/\s+/g, " ").trim(); }
  catch { return null; }
}

function processMatches(pid, startIdentity) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0 || !startIdentity) return false;
  try { process.kill(Number(pid), 0); } catch { return false; }
  return processStartIdentity(Number(pid)) === startIdentity;
}

async function withProviderLock({ directory, instance, workflowId, resourceCensus = null } = {}, operation) {
  if (typeof operation !== "function") throw new Error("provider lock requires an operation");
  safeProviderName(instance, "Lima instance");
  if (!/^[a-z0-9][a-z0-9_.-]{5,63}$/.test(workflowId || "")) throw new Error("provider lock requires a safe workflow ID");
  const root = path.resolve(directory || path.join(os.tmpdir(), "step-capacity-locks"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${instance}.provider.lock.json`);
  const owner = { schema: "home-capacity-provider-lock-v1", pid: process.pid,
    processStartIdentity: processStartIdentity(), workflowId, instance,
    token: crypto.randomUUID(), acquiredAt: new Date().toISOString(), file };
  let handle;
  let retain = false;
  try {
    try {
      handle = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try { existing = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { throw new Error(`capacity provider ${instance} is locked by an unreadable owner record`); }
      if (processMatches(existing.pid, existing.processStartIdentity)) {
        throw new Error(`capacity provider ${instance} is locked by live workflow ${existing.workflowId}`);
      }
      if (typeof resourceCensus !== "function") {
        throw new Error(`capacity provider ${instance} stale lock cannot be recovered without resource proof`);
      }
      const resources = await resourceCensus({ instance, workflowId: existing.workflowId });
      if (!Array.isArray(resources) || resources.length > 0) {
        throw new Error(`capacity provider ${instance} stale owner still has workflow resources`);
      }
      const stale = `${file}.stale-${Date.now()}-${crypto.randomUUID()}`;
      fs.renameSync(file, stale);
      fs.writeFileSync(`${stale}.recovery.json`, `${JSON.stringify({ schema: "home-capacity-lock-recovery-v1",
        recoveredAt: new Date().toISOString(), recoveredBy: owner, staleOwner: existing }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" });
      handle = fs.openSync(file, "wx", 0o600);
    }
    fs.writeFileSync(handle, `${JSON.stringify(owner, null, 2)}\n`);
    try { return await operation(owner); }
    catch (error) { retain = error?.retainProviderLock === true; throw error; }
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (!retain && fs.existsSync(file)) {
      let current = null;
      try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      if (current?.token === owner.token) fs.unlinkSync(file);
    }
  }
}

function assertProviderLock(lock) {
  const file = path.resolve(required(lock?.file, "provider lock file"));
  let current;
  try { current = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("provider lock changed or disappeared before mutation"); }
  if (current.token !== lock.token || current.workflowId !== lock.workflowId ||
      current.instance !== lock.instance) throw new Error("provider lock token/owner changed before mutation");
  return true;
}

function assertLegacyProviderAvailable({ instance, directory = path.join(os.tmpdir(), "step-capacity-locks") } = {}) {
  safeProviderName(instance, "Lima instance");
  const file = path.join(path.resolve(directory), `${instance}.provider.lock.json`);
  if (fs.existsSync(file)) throw new Error(`workflow owns provider ${instance}; legacy lifecycle mutation refused`);
  return true;
}

function validatedWorkflowRoot({ repository, configPath } = {}) {
  const root = path.resolve(__dirname, "..");
  const suppliedRepository = path.resolve(required(repository, "validated repository"));
  const resolvedConfig = path.resolve(required(configPath, "capacity config"));
  if (suppliedRepository !== root) {
    throw new Error("capacity lifecycle repository is not the canonical repository");
  }
  if (resolvedConfig !== root && !resolvedConfig.startsWith(`${root}${path.sep}`)) {
    throw new Error("capacity config is outside the canonical repository");
  }
  return path.join(root, "results", "capacity", "home-open", "workflows");
}

function assertDeleteVmConfirmation({ instance, confirmation } = {}) {
  const name = safeProviderName(instance, "Lima instance");
  if (!/^step-capacity(?:[a-z0-9_.-]*)$/.test(name)) {
    throw new Error("delete-vm is restricted to a step-capacity provider");
  }
  if (String(confirmation || "") !== `DELETE ${name}`) {
    throw new Error(`delete-vm requires exact destructive confirmation: DELETE ${name}`);
  }
  return true;
}

function normalizedEnvironmentBinding(environment = {}) {
  const child = Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)));
  const normalized = Object.fromEntries(Object.entries(child).filter(([name]) =>
    !["CAPACITY_RUN_ID", "CACHE_ENV_PREFIX"].includes(name)));
  const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { schema: "home-capacity-normalized-environment-v1", excluded: ["CACHE_ENV_PREFIX", "CAPACITY_RUN_ID"],
    hash: digest(normalized), childHash: digest(child) };
}

function validateAppliedMigrations(expectedNames = [], rows = [], options = {}) {
  const expected = [...expectedNames].sort();
  if (new Set(expected).size !== expected.length || !Array.isArray(rows)) {
    throw new Error("applied migration evidence requires an exact expected set");
  }
  const expectedSet = new Set(expected);
  const expectedChecksums = options.expectedChecksums || null;
  if (expectedChecksums && (Object.keys(expectedChecksums).sort().join("\0") !== expected.join("\0") ||
      Object.values(expectedChecksums).some((checksum) => !/^[a-f0-9]{64}$/.test(checksum)))) {
    throw new Error("expected migration checksums do not exactly bind the source migration set");
  }
  const contradictory = rows.filter((row) => row.finished_at && row.rolled_back_at);
  const unresolved = rows.filter((row) => !row.finished_at && !row.rolled_back_at);
  const successful = rows.filter((row) => row.finished_at && !row.rolled_back_at);
  const historical = rows.filter((row) => !row.finished_at && row.rolled_back_at);
  const successfulNames = successful.map((row) => row.migration_name).sort();
  const successfulSet = new Set(successfulNames);
  const duplicateNames = successfulNames.filter((name, index) => successfulNames.indexOf(name) !== index);
  const missingNames = options.requireExactSuccessful === false ? [] :
    expected.filter((name) => !successfulSet.has(name));
  const extraNames = successfulNames.filter((name) => !expectedSet.has(name));
  const badSuccessfulChecksums = successful.filter((row) => !/^[a-f0-9]{64}$/.test(row.checksum || ""))
    .map((row) => row.migration_name);
  const badHistorical = historical.filter((row) => !expectedSet.has(row.migration_name) ||
    successfulNames.filter((name) => name === row.migration_name).length !== 1 ||
    !/^[a-f0-9]{64}$/.test(row.checksum || ""))
    .map((row) => row.migration_name);
  if (contradictory.length || unresolved.length || duplicateNames.length || missingNames.length ||
      extraNames.length || badSuccessfulChecksums.length || badHistorical.length) {
    const facts = [
      `missing=${missingNames.join(",") || "none"}`,
      `extra=${extraNames.join(",") || "none"}`,
      `duplicates=${[...new Set(duplicateNames)].join(",") || "none"}`,
      `checksum=${badSuccessfulChecksums.join(",") || "none"}`,
      `unresolved=${unresolved.map((row) => row.migration_name).join(",") || "none"}`,
      `contradictory=${contradictory.map((row) => row.migration_name).join(",") || "none"}`,
      `invalid-rolled-back=${badHistorical.join(",") || "none"}`,
    ].join("; ");
    throw new Error(`migration ledger is not the exact successful source set with resolved history (${facts})`);
  }
  const stable = successful.map((row) => ({ migration_name: row.migration_name,
    checksum: row.checksum })).sort((a, b) => a.migration_name.localeCompare(b.migration_name));
  const historicalRows = historical.map((row) => ({ migration_name: row.migration_name,
    checksum: row.checksum })).sort((left, right) => left.migration_name.localeCompare(right.migration_name) ||
      left.checksum.localeCompare(right.checksum));
  const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const checksumDriftRows = expectedChecksums ? successful.filter((row) =>
    expectedChecksums[row.migration_name] !== row.checksum).map((row) => ({
    migration_name: row.migration_name, source_checksum: expectedChecksums[row.migration_name],
    applied_checksum: row.checksum })).sort((left, right) =>
    left.migration_name.localeCompare(right.migration_name)) : [];
  return { rows: stable, hash: digest(stable), unresolvedCount: 0,
    checksumDrift: { count: checksumDriftRows.length,
      names: checksumDriftRows.map((row) => row.migration_name), rows: checksumDriftRows,
      hash: digest(checksumDriftRows) },
    historicalRollbacks: { count: historicalRows.length,
      names: historicalRows.map((row) => row.migration_name),
      checksums: historicalRows.map((row) => row.checksum), rows: historicalRows,
      hash: digest(historicalRows) } };
}

function removeHostCredentialPaths(paths = []) {
  for (const item of paths) {
    const resolved = path.resolve(item);
    if (!resolved.startsWith(`${os.tmpdir()}${path.sep}home-open-`)) throw new Error("unsafe host credential cleanup path");
    fs.rmSync(resolved, { recursive: true, force: true });
    if (fs.existsSync(resolved)) throw new Error("host credential cleanup absence proof failed");
  }
  return { credentialPathsRemoved: paths.length, credentialsRetained: false };
}

function providerResourceCensus({ instance, workflowId } = {}) {
  safeProviderName(instance, "Lima instance");
  if (!isPresent(instance)) return [];
  const settings = { lima_instance: instance };
  const filter = shellQuote(`label=${WORKFLOW_LABEL}=${workflowId}`);
  const containers = shellOutput(settings,
    `docker ps -a --filter ${filter} --format '{{.Names}}'`).split(/\r?\n/).filter(Boolean);
  const volumes = shellOutput(settings,
    `docker volume ls --filter ${filter} --format '{{.Name}}'`).split(/\r?\n/).filter(Boolean);
  return [...containers.map((name) => ({ type: "container", name })),
    ...volumes.map((name) => ({ type: "volume", name }))];
}

function assertProviderIsolation({ configPath, workflowId } = {}, dependencies = {}) {
  const settings = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
  const instance = limaName(settings);
  const present = dependencies.present || isPresent;
  const running = dependencies.running || isRunning;
  const list = dependencies.list || ((type) => shellOutput(settings, type === "container" ?
    "docker ps -a --format '{{.Names}}'" : "docker volume ls --format '{{.Name}}'")
    .split(/\r?\n/).filter(Boolean));
  const inspect = dependencies.inspect || ((type, name) => inspectResourceLabels(settings, type, name));
  if (!present(instance)) return { isolated: true, resources: [] };
  if (!running(instance)) return { isolated: true, deferredUntilVmStart: true, resources: [] };
  const prefix = `${instance}-`;
  const containers = list("container").filter((name) => name.startsWith(prefix));
  const volumes = list("volume").filter((name) => name.startsWith(prefix));
  for (const name of containers) {
    const labels = inspect("container", name);
    if (labels?.[OWNER_LABEL] !== OWNER_VALUE || labels?.[WORKFLOW_LABEL] !== workflowId) {
      throw new Error(`foreign or unlabeled capacity container blocks workflow: ${name}`);
    }
  }
  for (const name of volumes) {
    const labels = inspect("volume", name);
    const cache = name.startsWith(`${instance}-home-cache-`) && labels?.[OWNER_LABEL] === OWNER_VALUE &&
      typeof labels?.["com.bara.capacity.binding"] === "string";
    if (!cache && (labels?.[OWNER_LABEL] !== OWNER_VALUE || labels?.[WORKFLOW_LABEL] !== workflowId)) {
      throw new Error(`foreign or unlabeled capacity volume blocks workflow: ${name}`);
    }
  }
  return { isolated: true, resources: [...containers, ...volumes] };
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

function preparedNodeHelperCommand({ bundle, cacheVolume, script, args = [],
  environmentFile, writableMounts = [] } = {}) {
  const root = path.resolve(required(bundle, "prepared helper source bundle"));
  const dependencyVolume = safeProviderName(cacheVolume, "prepared dependency cache");
  if (!/^[a-z0-9][a-z0-9_./-]*\.js$/.test(script || "") || path.isAbsolute(script) ||
      String(script).split("/").includes("..")) {
    throw new Error("prepared helper requires a safe bundle-relative script");
  }
  const resolvedEnvironmentFile = path.resolve(required(environmentFile,
    "prepared helper environment file"));
  const mounts = writableMounts.map(({ source, target }) => {
    const resolvedSource = path.resolve(required(source, "prepared helper writable source"));
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(target || "") || String(target).includes("..")) {
      throw new Error("prepared helper writable target is unsafe");
    }
    return `-v ${shellQuote(`${resolvedSource}:${target}`)}`;
  });
  return ["docker run --rm --network host", `-v ${shellQuote(`${root}:/workspace:ro`)}`,
    `-v ${shellQuote(`${dependencyVolume}:/workspace/node_modules:ro`)}`, ...mounts,
    `--env-file ${shellQuote(resolvedEnvironmentFile)}`, "-w /workspace",
    "node:22 node", shellQuote(script),
    ...args.map((value) => shellQuote(String(value)))].join(" ");
}

function parseContainerResourceCaps(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return { cpu: Number(parsed?.NanoCpus) / 1e9,
    memoryGb: Number(parsed?.Memory) / 1024 ** 3 };
}

function assertContainerResourceCaps(actual, expected, label = "container") {
  if (actual?.cpu !== expected?.cpu || actual?.memoryGb !== expected?.memoryGb) {
    throw new Error(`${label} resource cap mismatch: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
  }
  return actual;
}

function inspectContainerResourceCaps(settings, name) {
  return parseContainerResourceCaps(shellOutput(settings,
    `docker inspect --format ${shellQuote("{{json .HostConfig}}") } ${shellQuote(name)}`));
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
  const beforeMutation = () => {
    if (settings.__providerLock) assertProviderLock(settings.__providerLock);
    else if (settings.__legacyLockDirectory) assertLegacyProviderAvailable({ instance: name,
      directory: settings.__legacyLockDirectory });
  };
  const desired = { cpu: resources.vmCpu, memoryGb: resources.vmMemoryGb,
    diskGb: Number(settings.vps_specs.disk_gb) };
  if (present(name)) {
    const before = inspect(name);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      beforeMutation();
      execute("limactl", ["stop", "--force", name], { timeout: phaseTimeout(settings) });
      beforeMutation();
      execute("limactl", ["edit", "--yes", `--cpus=${desired.cpu}`,
        `--memory=${desired.memoryGb}`, `--disk=${desired.diskGb}`, name], { timeout: phaseTimeout(settings) });
    }
    beforeMutation(); execute("limactl", ["start", "--yes", name], { timeout: phaseTimeout(settings) });
  } else { beforeMutation(); execute("limactl", [
    "start", "--yes", `--name=${name}`, `--cpus=${resources.vmCpu}`,
    `--memory=${resources.vmMemoryGb}`, `--disk=${settings.vps_specs.disk_gb}`,
    `--mount=${repo(settings)}:w`, "--port-forward=3000:3000",
    "--port-forward=3010:3010", "--port-forward=3011:3011",
    `--port-forward=${settings.db_host_port || 55433}:5432`, "template:docker",
  ], { timeout: phaseTimeout(settings) }); }
  const actual = inspect(name);
  if (JSON.stringify(actual) !== JSON.stringify(desired)) {
    throw new Error(`capacity VM resource mismatch: expected ${JSON.stringify(desired)}, actual ${JSON.stringify(actual)}`);
  }
  return actual;
}

function startVm(settings) {
  return ensureVmResources(settings);
}

function phaseTimeout(settings) {
  if (!settings.__phaseDeadlineAt) return PROVIDER_OPERATION_TIMEOUT_MS;
  const remaining = Number(settings.__phaseDeadlineAt) - Date.now();
  if (remaining <= 0) throw new Error("capacity provider phase exceeded its shared deadline");
  return Math.max(1, Math.min(PROVIDER_OPERATION_TIMEOUT_MS, remaining));
}

function shell(settings, command) {
  if (settings.__providerLock) assertProviderLock(settings.__providerLock);
  else if (settings.__legacyLockDirectory) assertLegacyProviderAvailable({ instance: limaName(settings),
    directory: settings.__legacyLockDirectory });
  run("limactl", ["shell", limaName(settings), "--", "bash", "-lc", command],
    { timeout: phaseTimeout(settings) });
}

function shellOutput(settings, command) {
  return output("limactl", ["shell", limaName(settings), "--", "bash", "-lc", command],
    { timeout: phaseTimeout(settings) });
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
  if (settings.__providerLock) assertProviderLock(settings.__providerLock);
  else if (settings.__legacyLockDirectory) assertLegacyProviderAvailable({ instance: limaName(settings),
    directory: settings.__legacyLockDirectory });
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
  const lockfilePath = path.join(root, "package-lock.json");
  if (!fs.existsSync(lockfilePath)) throw new Error(`capacity backend requires package-lock.json: ${lockfilePath}`);
  const dependencyLockHash = crypto.createHash("sha256").update(fs.readFileSync(lockfilePath)).digest("hex");
  // Recreate on every guarded start. Reusing a same-profile container could
  // preserve a prior CAPACITY_RUN_ID while lifecycle state names a new run.
  // Dependencies are immutable inputs to a capacity run. Reuse a verified
  // node_modules volume when present so a start does not spend the entire
  // lifecycle timeout reinstalling packages; an empty/corrupt volume still
  // self-heals with npm ci. This is capacity-provider behavior only and does
  // not change the production runtime.
  const dependencyBootstrap = `expected=\"${dependencyLockHash}\"; actual=$(sha256sum /workspace/package-lock.json | cut -d\" \" -f1); installed=$(cat /workspace/node_modules/.capacity-package-lock-hash 2>/dev/null || true); if [ \"$actual\" != \"$expected\" ] || [ \"$installed\" != \"$expected\" ] || [ ! -f /workspace/node_modules/@prisma/client/package.json ]; then npm ci --ignore-scripts; printf \"%s\" \"$expected\" > /workspace/node_modules/.capacity-package-lock-hash; fi`;
  shell(settings, `docker rm -f ${name} >/dev/null 2>&1 || true && docker volume create ${name}-node-modules >/dev/null && docker run -d --name ${name} --restart unless-stopped --network host --cpus=${resources.backendCpu} --memory=${resources.backendMemoryGb}g -v ${JSON.stringify(root)}:/workspace:ro -v ${name}-node-modules:/workspace/node_modules -w /workspace ${env} node:22 bash -lc '${dependencyBootstrap} && npx prisma generate && npx prisma migrate deploy && node scripts/capacity-cluster.js' && for attempt in $(seq 1 120); do curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`);
}

function stopBackend(settings) {
  shell(settings, `docker rm -f ${limaName(settings)}-backend >/dev/null 2>&1 || true`);
}

function destroy(settings) {
  if (isPresent(limaName(settings))) {
    if (settings.__providerLock) assertProviderLock(settings.__providerLock);
    else assertLegacyProviderAvailable({ instance: limaName(settings), directory: settings.__legacyLockDirectory });
    run("limactl", ["delete", "--force", "--yes", limaName(settings)]);
  }
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

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function dockerLabels(labels) {
  return Object.entries(labels).flatMap(([name, value]) => ["--label", `${name}=${value}`])
    .map(shellQuote).join(" ");
}

function inspectResourceLabels(settings, type, name) {
  safeProviderName(name);
  const collection = type === "volume" ? "volume" : "container";
  const format = type === "volume" ? "{{json .Labels}}" : "{{json .Config.Labels}}";
  const listed = shellOutput(settings, type === "volume" ?
    "docker volume ls --format '{{.Name}}'" : "docker ps -a --format '{{.Names}}'")
    .split(/\r?\n/).filter(Boolean);
  if (!listed.includes(name)) return null;
  const raw = shellOutput(settings,
    `docker ${collection} inspect --format ${shellQuote(format)} ${shellQuote(name)}`);
  const labels = JSON.parse(raw || "{}");
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error(`capacity ${type} labels are unreadable for ${name}`);
  }
  return labels;
}

function removeOwnedResource(settings, { type, name, workflowId, childId, providerLock = settings.__providerLock },
  dependencies = {}) {
  const inspect = dependencies.inspect || ((resourceType, resourceName) =>
    inspectResourceLabels(settings, resourceType, resourceName));
  const mutate = dependencies.mutate || ((command) => shell(settings, command));
  const labels = inspect(type, name);
  if (labels == null) return { name, type, existed: false, removed: true };
  assertOwnedResource({ name, labels, workflowId, childId });
  assertProviderLock(providerLock);
  const command = type === "volume" ? "docker volume rm" : "docker rm -f";
  mutate(`${command} ${shellQuote(name)}`);
  if (inspect(type, name) != null) {
    throw new Error(`capacity ${type} deletion could not be proven: ${name}`);
  }
  return { name, type, existed: true, removed: true };
}

function removeWorkflowChildResources(settings, manifest, child, providerLock = settings.__providerLock) {
  const names = providerResourceNames({ instance: limaName(settings), workflowId: manifest.workflowId,
    childId: child.runId });
  const removals = [];
  // Containers must be gone before the backing volume can be deleted.
  for (const [type, name] of [["container", names.backendContainer],
    ["container", names.redisContainer], ["container", names.postgresContainer],
    ["volume", names.postgresVolume]]) {
    removals.push(removeOwnedResource(settings, { type, name, workflowId: manifest.workflowId,
      childId: child.runId, providerLock }));
  }
  return { names, removals };
}

function preparationBinding(settings, manifest, sourceBundle) {
  const root = path.resolve(sourceBundle.path);
  const bytes = (name) => fs.readFileSync(path.join(root, name));
  const migrations = fs.readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const migrationChecksums = Object.fromEntries(migrations.map((name) => [name,
    crypto.createHash("sha256").update(bytes(path.join("prisma", "migrations", name,
      "migration.sql"))).digest("hex")]));
  const values = {
    schema: "home-capacity-dependency-binding-v1",
    sourceBundleHash: sourceBundle.hash,
    packageLockHash: crypto.createHash("sha256").update(bytes("package-lock.json")).digest("hex"),
    nodeImage: "node:22",
    prismaSchemaHash: crypto.createHash("sha256").update(bytes("prisma/schema.prisma")).digest("hex"),
    migrationHash: manifest.migrationHash,
    resourceManifestHash: manifest.resourceManifestHash,
    parityHash: manifest.parityHash,
  };
  return { ...values, hash: crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex"),
    migrations, migrationChecksums };
}

function prepareWorkflowEnvironment({ configPath, manifest, sourceBundle, environment = {}, providerLock } = {}) {
  const preparationStartedAt = Date.now();
  const configBytes = fs.readFileSync(path.resolve(configPath));
  if (crypto.createHash("sha256").update(configBytes).digest("hex") !== manifest.configHash) {
    throw new Error("capacity workflow config changed after confirmation");
  }
  const settings = JSON.parse(configBytes.toString("utf8"));
  Object.defineProperty(settings, "__providerLock", { value: providerLock, enumerable: false });
  Object.defineProperty(settings, "__phaseDeadlineAt", { value: preparationStartedAt +
    PHASE_TIMEOUT_MS.prepare, enumerable: false });
  assertProviderLock(providerLock);
  settings.run_id = manifest.workflowId;
  const actualVmResources = ensureVmResources(settings);
  assertProviderIsolation({ configPath, workflowId: manifest.workflowId });
  const binding = preparationBinding(settings, manifest, sourceBundle);
  const cacheVolume = safeProviderName(`${limaName(settings)}-home-cache-${binding.hash.slice(0, 12)}`);
  const existing = inspectResourceLabels(settings, "volume", cacheVolume);
  let cacheHit = false;
  if (existing) {
    if (existing[OWNER_LABEL] !== OWNER_VALUE || existing["com.bara.capacity.binding"] !== binding.hash) {
      throw new Error(`dependency cache ownership/binding proof failed for ${cacheVolume}`);
    }
    let marker = null;
    try { marker = shellOutput(settings, `docker run --rm -v ${shellQuote(cacheVolume)}:/cache:ro node:22 cat /cache/.home-capacity-cache-ready`); }
    catch {}
    if (marker === binding.hash) cacheHit = true;
    else {
      shell(settings, `docker volume rm ${shellQuote(cacheVolume)}`);
      if (inspectResourceLabels(settings, "volume", cacheVolume) != null) {
        throw new Error("incomplete dependency cache deletion could not be proven");
      }
    }
  }
  if (!cacheHit) {
    shell(settings, `docker volume create ${dockerLabels({ [OWNER_LABEL]: OWNER_VALUE,
      "com.bara.capacity.binding": binding.hash })} ${shellQuote(cacheVolume)} >/dev/null`);
    const bundle = shellQuote(path.resolve(sourceBundle.path));
    shell(settings, [
      `docker run --rm -v ${bundle}:/workspace:ro`,
      `-v ${shellQuote(cacheVolume)}:/workspace/node_modules -w /workspace node:22`,
      "bash -lc 'npm ci --ignore-scripts && npx prisma generate && npx prisma validate'",
    ].join(" "));
    shell(settings, `docker run --rm -v ${shellQuote(cacheVolume)}:/cache node:22 sh -c ${shellQuote(`printf %s ${binding.hash} > /cache/.home-capacity-cache-ready`)}`);
    const marker = shellOutput(settings,
      `docker run --rm -v ${shellQuote(cacheVolume)}:/cache:ro node:22 cat /cache/.home-capacity-cache-ready`);
    if (marker !== binding.hash) throw new Error("dependency cache readiness marker mismatch");
  }
  return { schema: "home-capacity-preparation-v1", workflowId: manifest.workflowId,
    binding, cacheVolume, cacheHit, actualVmResources, preparedAt: new Date().toISOString(),
    preparationDurationSeconds: (Date.now() - preparationStartedAt) / 1000 };
}

function workflowChildEnvironment(settings, manifest, child, environment) {
  const databaseUrl = dbUrl({ ...settings, db_host_port: 5432 }, environment)
    .replace(`127.0.0.1:${settings.db_host_port || 55433}`, "127.0.0.1:5432");
  const requiredSecrets = ["CAPACITY_DB_PASSWORD", "CAPACITY_REDIS_PASSWORD",
    "CAPACITY_AUTH_SECRET", "CAPACITY_DB_MARKER"];
  for (const name of requiredSecrets) required(environment[name], name);
  return {
    ...environment,
    DATABASE_URL: databaseUrl,
    REDIS_URL: `redis://:${encodeURIComponent(environment.CAPACITY_REDIS_PASSWORD)}@127.0.0.1:6379/0`,
    CAPACITY_MODE: "true", CAPACITY_OUTBOUND_DISABLED: "true",
    CAPACITY_RUN_ID: child.runId, CAPACITY_GLOBAL_EVENT_PROFILE: "home-open",
    CAPACITY_DATABASE_POOL_PROFILE: "role-budget", CAPACITY_DB_NAME: "steps_tracker_capacity",
    CAPACITY_DB_HOST_ALLOWLIST: "127.0.0.1", CAPACITY_REDIS_HOST_ALLOWLIST: "127.0.0.1",
    CACHE_ENV_PREFIX: `capacity:${child.runId}:`, SESSION_TOKEN_SECRET: environment.CAPACITY_AUTH_SECRET,
    PORT: "3000", NODE_ENV: "production", APNS_PRODUCTION: "false",
    PROD_DATABASE_URL: "", STAGING_DATABASE_URL: "", PEER_DATABASE_URL: "",
    APNS_KEY_PATH: "", APNS_SIGNING_KEY: "", APNS_KEY_ID: "", APNS_TEAM_ID: "",
    APNS_BUNDLE_ID: "", FCM_SERVICE_ACCOUNT: "", FCM_SERVICE_ACCOUNT_PATH: "",
    GOOGLE_APPLICATION_CREDENTIALS: "", S3_BUCKET: "", S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "", S3_SESSION_TOKEN: "",
  };
}

function backendEnvironmentEntries(environment) {
  const allowed = new Set([
    "DATABASE_URL", "REDIS_URL", "CAPACITY_MODE", "CAPACITY_OUTBOUND_DISABLED", "CAPACITY_RUN_ID",
    "CAPACITY_GLOBAL_EVENT_PROFILE", "CAPACITY_DATABASE_POOL_PROFILE", "CAPACITY_DB_NAME",
    "CAPACITY_DB_HOST_ALLOWLIST", "CAPACITY_REDIS_HOST_ALLOWLIST", "CAPACITY_DB_MARKER",
    "CACHE_ENV_PREFIX", "SESSION_TOKEN_SECRET", "CAPACITY_AUTH_SECRET", "PORT", "NODE_ENV",
    "APNS_PRODUCTION", "PROD_DATABASE_URL", "STAGING_DATABASE_URL", "PEER_DATABASE_URL",
    "APNS_KEY_PATH", "APNS_SIGNING_KEY", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID",
    "FCM_SERVICE_ACCOUNT", "FCM_SERVICE_ACCOUNT_PATH", "GOOGLE_APPLICATION_CREDENTIALS",
    "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN",
    "ASYNC_RACE_RESOLUTION_CONCURRENCY", "RACE_RESOLVE_DEBOUNCE_MS",
    "SYNC_V2_INLINE_UPLOADER_RECONCILIATION", "CAPACITY_PROVIDER_ATTEMPT_COUNT",
  ]);
  for (const name of HOME_CAPACITY_PARITY_ENV_NAMES) allowed.add(name);
  return Object.fromEntries(Object.entries(environment).filter(([name]) => allowed.has(name))
    .sort(([left], [right]) => left.localeCompare(right)));
}

function backendEnvironmentFlags(environment) {
  return Object.entries(backendEnvironmentEntries(environment))
    .map(([name, value]) => `-e ${shellQuote(`${name}=${String(value)}`)}`).join(" ");
}

function resetWorkflowChild({ configPath, manifest, child, sourceBundle, environment = {},
  previousChild = null, providerLock } = {}) {
  const resetStartedAt = Date.now();
  const phaseTimings = {};
  const timePhase = (name, startedAt) => { phaseTimings[`${name}Seconds`] = (Date.now() - startedAt) / 1000; };
  const configBytes = fs.readFileSync(path.resolve(configPath));
  if (crypto.createHash("sha256").update(configBytes).digest("hex") !== manifest.configHash) {
    throw new Error("capacity workflow config changed after confirmation");
  }
  const settings = JSON.parse(configBytes.toString("utf8"));
  Object.defineProperty(settings, "__providerLock", { value: providerLock, enumerable: false });
  Object.defineProperty(settings, "__phaseDeadlineAt", { value: resetStartedAt +
    PHASE_TIMEOUT_MS.reset, enumerable: false });
  assertProviderLock(providerLock);
  settings.run_id = child.runId;
  if (settings.target !== "capacity-vm" || settings.db_name !== "steps_tracker_capacity") {
    throw new Error("workflow reset requires the approved disposable capacity target");
  }
  if (previousChild) removeWorkflowChildResources(settings, manifest, previousChild);
  const names = providerResourceNames({ instance: limaName(settings), workflowId: manifest.workflowId,
    childId: child.runId });
  // A name collision is never freshness proof: inspect, prove exact ownership, delete, then prove absence.
  removeWorkflowChildResources(settings, manifest, child);
  const labels = workflowLabels(manifest.workflowId, child.runId);
  const resources = capacityResourcePlan(settings);
  shell(settings, `docker volume create ${dockerLabels(labels)} ${shellQuote(names.postgresVolume)} >/dev/null`);
  const password = required(environment.CAPACITY_DB_PASSWORD, "CAPACITY_DB_PASSWORD");
  shell(settings, [
    "docker run -d", dockerLabels(labels), `--name ${shellQuote(names.postgresContainer)}`,
    `--cpus=${resources.databaseCpu} --memory=${resources.databaseMemoryGb}g -p 5432:5432`,
    `-e ${shellQuote("POSTGRES_DB=steps_tracker_capacity")} -e ${shellQuote("POSTGRES_USER=capacity")}`,
    `-e ${shellQuote(`POSTGRES_PASSWORD=${password}`)}`,
    `-v ${shellQuote(names.postgresVolume)}:/var/lib/postgresql postgres:18`,
    `-c max_connections=${Number(settings.database_specs.connection_limit)}`,
    "-c shared_preload_libraries=pg_stat_statements",
  ].join(" "));
  shell(settings, `for attempt in $(seq 1 120); do docker exec ${shellQuote(names.postgresContainer)} pg_isready -U capacity -d steps_tracker_capacity >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`);
  const postgresResourceCaps = assertContainerResourceCaps(
    inspectContainerResourceCaps(settings, names.postgresContainer),
    { cpu: resources.databaseCpu, memoryGb: resources.databaseMemoryGb }, "PostgreSQL");
  const snapshotMetadata = JSON.parse(fs.readFileSync(path.resolve(settings.snapshot), "utf8"));
  if (crypto.createHash("sha256").update(fs.readFileSync(path.resolve(settings.snapshot))).digest("hex") !==
      manifest.snapshotMetadataHash ||
      crypto.createHash("sha256").update(fs.readFileSync(snapshotMetadata.sourceSnapshotPath)).digest("hex") !==
      manifest.snapshotHash) {
    throw new Error("capacity snapshot input changed after confirmation");
  }
  const childRoot = path.join(path.dirname(sourceBundle.path), "children", child.runId);
  fs.mkdirSync(childRoot, { recursive: true, mode: 0o700 });
  const childAttestation = path.join(childRoot, "scrub-attestation.json");
  const hostEnvironment = { ...environment, CAPACITY_RUN_ID: child.runId,
    PATH: ["/opt/homebrew/opt/postgresql@18/bin", "/usr/local/opt/postgresql@18/bin",
      process.env.PATH].filter(Boolean).join(path.delimiter),
    CAPACITY_MODE: "true", CAPACITY_OUTBOUND_DISABLED: "true",
    CAPACITY_DB_NAME: "steps_tracker_capacity", CAPACITY_DB_HOST_ALLOWLIST: "127.0.0.1",
    PROD_DATABASE_URL: "", STAGING_DATABASE_URL: "", PEER_DATABASE_URL: "",
    APNS_KEY_PATH: "", APNS_SIGNING_KEY: "", APNS_KEY_ID: "", APNS_TEAM_ID: "",
    APNS_BUNDLE_ID: "", FCM_SERVICE_ACCOUNT: "", FCM_SERVICE_ACCOUNT_PATH: "",
    GOOGLE_APPLICATION_CREDENTIALS: "", S3_BUCKET: "", S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "", S3_SESSION_TOKEN: "" };
  const preparation = preparationBinding(settings, manifest, sourceBundle);
  const cacheVolume = safeProviderName(`${limaName(settings)}-home-cache-${preparation.hash.slice(0, 12)}`);
  const cacheLabels = inspectResourceLabels(settings, "volume", cacheVolume);
  if (cacheLabels?.[OWNER_LABEL] !== OWNER_VALUE ||
      cacheLabels?.["com.bara.capacity.binding"] !== preparation.hash ||
      shellOutput(settings, `docker run --rm -v ${shellQuote(cacheVolume)}:/cache:ro node:22 cat /cache/.home-capacity-cache-ready`) !== preparation.hash) {
    throw new Error("dependency cache changed after preparation");
  }
  const restoreUrl = new URL(dbUrl(settings, environment));
  if (restoreUrl.hostname !== "127.0.0.1" || restoreUrl.port !== String(settings.db_host_port || 55433) ||
      decodeURIComponent(restoreUrl.pathname.slice(1)) !== "steps_tracker_capacity") {
    throw new Error("capacity restore target identity changed");
  }
  const restoreEnvironment = { ...hostEnvironment, PGHOST: restoreUrl.hostname,
    PGPORT: restoreUrl.port, PGUSER: decodeURIComponent(restoreUrl.username),
    PGPASSWORD: decodeURIComponent(restoreUrl.password), PGDATABASE: "steps_tracker_capacity" };
  let phaseStartedAt = Date.now();
  run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--exit-on-error",
    "--dbname", "steps_tracker_capacity", snapshotMetadata.sourceSnapshotPath],
  { env: restoreEnvironment, timeout: phaseTimeout(settings) });
  timePhase("restore", phaseStartedAt); phaseStartedAt = Date.now();
  const guestDbUrl = `postgresql://capacity:${encodeURIComponent(password)}@127.0.0.1:5432/steps_tracker_capacity`;
  const helperEnvironment = { DATABASE_URL: guestDbUrl, CAPACITY_MODE: "true",
      CAPACITY_OUTBOUND_DISABLED: "true", CAPACITY_RUN_ID: child.runId,
      CAPACITY_DB_NAME: "steps_tracker_capacity", CAPACITY_DB_HOST_ALLOWLIST: "127.0.0.1",
      CAPACITY_DB_MARKER: environment.CAPACITY_DB_MARKER,
      CAPACITY_SCRUB_ATTESTATION_SECRET: environment.CAPACITY_SCRUB_ATTESTATION_SECRET,
      PROD_DATABASE_URL: "", STAGING_DATABASE_URL: "", PEER_DATABASE_URL: "" };
  const helperCredentialRoot = path.join(path.dirname(sourceBundle.path), "credentials", child.runId);
  const helperEnvironmentFile = path.join(helperCredentialRoot, "capacity-db.env");
  fs.mkdirSync(helperCredentialRoot, { recursive: true, mode: 0o700 });
  const helperEnvironmentLines = Object.entries(helperEnvironment).map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n\0]/.test(String(value))) {
      throw new Error("capacity helper environment cannot be represented safely");
    }
    return `${name}=${String(value)}`;
  });
  fs.writeFileSync(helperEnvironmentFile, `${helperEnvironmentLines.join("\n")}\n`,
    { flag: "wx", mode: 0o600 });
  try {
    shell(settings, preparedNodeHelperCommand({ bundle: sourceBundle.path, cacheVolume,
      script: "scripts/capacity-db.js", environmentFile: helperEnvironmentFile,
      args: ["scrub", "--snapshot-hash", manifest.snapshotHash,
        "--attestation", "/evidence/scrub-attestation.json"],
      writableMounts: [{ source: childRoot, target: "/evidence" }] }));
  } finally {
    fs.rmSync(helperCredentialRoot, { recursive: true, force: true });
  }
  timePhase("scrub", phaseStartedAt);
  const bundle = shellQuote(path.resolve(sourceBundle.path));
  const migrationLedgerQuery = "SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.migration_name, m.checksum, m.finished_at, m.rolled_back_at)::text, '[]') FROM (SELECT migration_name, checksum, finished_at::text, rolled_back_at::text FROM _prisma_migrations) m";
  const readMigrationLedger = () => JSON.parse(shellOutput(settings,
    `docker exec ${shellQuote(names.postgresContainer)} psql -U capacity -d steps_tracker_capacity -At -c ${shellQuote(migrationLedgerQuery)}`) || "[]");
  phaseStartedAt = Date.now();
  const migrationLedgerBeforeDeploy = validateAppliedMigrations(preparation.migrations,
    readMigrationLedger(), { expectedChecksums: preparation.migrationChecksums,
      requireExactSuccessful: false });
  shell(settings, `docker run --rm --network host -v ${bundle}:/workspace:ro -v ${shellQuote(cacheVolume)}:/workspace/node_modules -w /workspace -e ${shellQuote(`DATABASE_URL=${guestDbUrl}`)} node:22 npx prisma migrate deploy`);
  // pg_stat_statements is operational evidence, not application schema. The
  // restored snapshot may omit the extension even though PostgreSQL preloads
  // it, so install it once after restore/migrations for the reusable child.
  shell(settings, `docker exec ${shellQuote(names.postgresContainer)} psql -U capacity -d steps_tracker_capacity -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' >/dev/null`);
  const { hashObject } = require("./home-capacity-workflow");
  const appliedMigrationEvidence = validateAppliedMigrations(preparation.migrations,
    readMigrationLedger(), { expectedChecksums: preparation.migrationChecksums });
  if (migrationLedgerBeforeDeploy.historicalRollbacks.hash !==
      appliedMigrationEvidence.historicalRollbacks.hash ||
      migrationLedgerBeforeDeploy.historicalRollbacks.count !==
      appliedMigrationEvidence.historicalRollbacks.count) {
    throw new Error("Prisma migrate deploy changed the resolved historical rollback ledger");
  }
  timePhase("migration", phaseStartedAt);
  const schemaFingerprint = shellOutput(settings,
    `set -o pipefail; docker exec ${shellQuote(names.postgresContainer)} pg_dump -U capacity -d steps_tracker_capacity --schema-only --no-owner --no-privileges --restrict-key=homecapacityschemafingerprintv1 | sha256sum | awk '{print $1}'`);
  if (!/^[a-f0-9]{64}$/.test(schemaFingerprint)) throw new Error("applied schema fingerprint is invalid");
  const redisSecret = required(environment.CAPACITY_REDIS_PASSWORD, "CAPACITY_REDIS_PASSWORD");
  phaseStartedAt = Date.now();
  shell(settings, ["docker run -d", dockerLabels(labels), `--name ${shellQuote(names.redisContainer)}`,
    "--network host --memory=256m --cpus=1 redis:7.0.15 redis-server --bind 127.0.0.1 ::1",
    `--port 6379 --requirepass ${shellQuote(redisSecret)}`,
    "--maxmemory 100mb --maxmemory-policy allkeys-lru --appendonly no --save ''",
  ].join(" "));
  shell(settings, `for attempt in $(seq 1 60); do docker exec ${shellQuote(names.redisContainer)} redis-cli -a ${shellQuote(redisSecret)} ping 2>/dev/null | grep -qx PONG && exit 0; sleep 1; done; exit 1`);
  const redisKeys = Number(shellOutput(settings,
    `docker exec ${shellQuote(names.redisContainer)} redis-cli -a ${shellQuote(redisSecret)} --raw DBSIZE 2>/dev/null`));
  if (redisKeys !== 0) throw new Error("fresh workflow Redis child did not have a zero-key census");
  timePhase("redisReadiness", phaseStartedAt);
  const childEnvironment = workflowChildEnvironment(settings, manifest, child, environment);
  const effectiveBackendEnvironment = backendEnvironmentEntries(childEnvironment);
  const secretNames = new Set(["DATABASE_URL", "REDIS_URL", "CAPACITY_DB_PASSWORD",
    "CAPACITY_REDIS_PASSWORD", "CAPACITY_AUTH_SECRET", "SESSION_TOKEN_SECRET",
    "CAPACITY_DB_MARKER", "CAPACITY_SCRUB_ATTESTATION_SECRET"]);
  const nonSecret = Object.fromEntries(Object.entries(effectiveBackendEnvironment).filter(([name]) =>
    !secretNames.has(name)).sort(([a], [b]) => a.localeCompare(b)));
  const secretFingerprints = Object.fromEntries(Object.entries(effectiveBackendEnvironment).filter(([name]) =>
    secretNames.has(name)).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name,
    crypto.createHmac("sha256", environment.CAPACITY_SCRUB_ATTESTATION_SECRET)
      .update(String(value)).digest("hex")]));
  const childEffectiveUnsigned = { schema: "home-capacity-child-effective-environment-v1",
    workflowId: manifest.workflowId, childId: child.runId, nonSecret, secretFingerprints };
  const childEffectiveEnvironment = { ...childEffectiveUnsigned, hash: hashObject(childEffectiveUnsigned) };
  const normalizedEffectiveEnvironment = normalizedEnvironmentBinding(effectiveBackendEnvironment);
  const childEffectiveEnvironmentPath = path.join(childRoot, "effective-environment.json");
  fs.writeFileSync(childEffectiveEnvironmentPath, `${JSON.stringify(childEffectiveEnvironment, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  phaseStartedAt = Date.now();
  shell(settings, ["docker run -d", dockerLabels(labels), `--name ${shellQuote(names.backendContainer)}`,
    "--network host", `--cpus=${resources.backendCpu}`, `--memory=${resources.backendMemoryGb}g`,
    `-v ${bundle}:/workspace:ro`, `-v ${shellQuote(cacheVolume)}:/workspace/node_modules`,
    "-w /workspace", backendEnvironmentFlags(childEnvironment), "node:22",
    "node scripts/capacity-cluster.js",
  ].join(" "));
  shell(settings, "for attempt in $(seq 1 120); do curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1 && curl -fsS --max-time 2 http://127.0.0.1:3010/health >/dev/null 2>&1 && curl -fsS --max-time 2 http://127.0.0.1:3011/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1");
  const backendResourceCaps = assertContainerResourceCaps(
    inspectContainerResourceCaps(settings, names.backendContainer),
    { cpu: resources.backendCpu, memoryGb: resources.backendMemoryGb }, "backend");
  timePhase("backendReadiness", phaseStartedAt);
  const containerIdentities = Object.fromEntries([
    ["postgres", names.postgresContainer], ["redis", names.redisContainer],
    ["backend", names.backendContainer],
  ].map(([role, name]) => [role, shellOutput(settings,
    `docker inspect --format ${shellQuote("{{.Id}}") } ${shellQuote(name)}`)]));
  if (Object.values(containerIdentities).some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(Object.values(containerIdentities)).size !== 3) {
    throw new Error("workflow child container identity census is invalid");
  }
  const resetEvidencePath = path.join(childRoot, "reset-evidence.json");
  const childConfig = { ...settings, repository: sourceBundle.path, run_id: child.runId,
    profile: "home-open", backend_container: names.backendContainer,
    postgres_container: names.postgresContainer, redis_container: names.redisContainer,
    workflow_manifest: path.join(path.dirname(sourceBundle.path), "confirmed-manifest.json"),
    workflow_reset_evidence: resetEvidencePath };
  const childConfigPath = path.join(childRoot, "capacity-config.json");
  const childConfigBytes = Buffer.from(`${JSON.stringify(childConfig, null, 2)}\n`);
  fs.writeFileSync(childConfigPath, childConfigBytes, { flag: "wx", mode: 0o600 });
  const attestationBytes = fs.readFileSync(childAttestation);
  const childAttestationValue = JSON.parse(attestationBytes.toString("utf8"));
  assertSnapshotAttestation({ manifest: { snapshotHash: manifest.snapshotHash },
    attestation: childAttestationValue, secret: environment.CAPACITY_SCRUB_ATTESTATION_SECRET });
  if (childAttestationValue.snapshotHash !== manifest.snapshotHash ||
      childAttestationValue.verification !== "passed") {
    throw new Error("child scrub attestation does not prove the confirmed snapshot");
  }
  const evidence = { schema: "home-capacity-child-reset-v1", workflowId: manifest.workflowId,
    childId: child.runId, names, labels, configPath: childConfigPath,
    childConfigHash: crypto.createHash("sha256").update(childConfigBytes).digest("hex"),
    snapshotHash: manifest.snapshotHash,
    scrubAttestationHash: crypto.createHash("sha256").update(attestationBytes).digest("hex"),
    approvedScrubAttestationHash: manifest.scrubAttestationHash,
    migrations: preparation.migrations, migrationHash: preparation.migrationHash,
    appliedMigrations: appliedMigrationEvidence.rows,
    appliedMigrationHash: appliedMigrationEvidence.hash, schemaFingerprint,
    migrationChecksumDrift: appliedMigrationEvidence.checksumDrift,
    migrationChecksumDriftHash: appliedMigrationEvidence.checksumDrift.hash,
    historicalRollbacksBeforeDeploy: migrationLedgerBeforeDeploy.historicalRollbacks,
    historicalRollbacksAfterDeploy: appliedMigrationEvidence.historicalRollbacks,
    historicalRollbackHash: appliedMigrationEvidence.historicalRollbacks.hash,
    unresolvedMigrationsBeforeDeploy: migrationLedgerBeforeDeploy.unresolvedCount,
    unresolvedMigrationsAfterDeploy: appliedMigrationEvidence.unresolvedCount,
    childEffectiveEnvironmentPath, childEffectiveEnvironmentHash: childEffectiveEnvironment.hash,
    normalizedEffectiveEnvironmentHash: normalizedEffectiveEnvironment.hash,
    containerIdentities, resourceCaps: { postgres: postgresResourceCaps,
      backend: backendResourceCaps },
    prismaSchemaHash: preparation.prismaSchemaHash, redisKeysBeforeBackend: redisKeys,
    phaseTimings, resetAt: new Date().toISOString(), resetDurationSeconds: (Date.now() - resetStartedAt) / 1000 };
  fs.writeFileSync(resetEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return evidence;
}

function cleanupWorkflowEnvironment({ configPath, manifest, children = [], activeChild = null,
  retainCache = true, providerLock, credentialPaths = [], cacheVolume = null,
  cacheBindingHash = null } = {}) {
  const settings = { lima_instance: safeProviderName(manifest?.provider?.instance,
    "confirmed Lima instance"), run_id: manifest.workflowId, __providerLock: providerLock,
    __phaseDeadlineAt: Date.now() + PHASE_TIMEOUT_MS.cleanup };
  assertProviderLock(providerLock);
  const byId = new Map([...children, activeChild].filter(Boolean).map((child) => [child.runId, child]));
  const removals = [];
  for (const child of byId.values()) removals.push(removeWorkflowChildResources(settings, manifest, child));
  const credentialCleanup = removeHostCredentialPaths(credentialPaths);
  let cacheRetained = retainCache !== true;
  if (retainCache === true && cacheVolume) {
    const labels = inspectResourceLabels(settings, "volume", cacheVolume);
    assertProviderLock(providerLock);
    cacheRetained = labels?.[OWNER_LABEL] === OWNER_VALUE &&
      labels?.["com.bara.capacity.binding"] === cacheBindingHash &&
      shellOutput(settings, `docker run --rm -v ${shellQuote(cacheVolume)}:/cache:ro node:22 cat /cache/.home-capacity-cache-ready`) === cacheBindingHash;
    if (!cacheRetained) throw new Error("retained dependency cache proof failed");
  }
  if (isPresent(limaName(settings))) { assertProviderLock(providerLock);
    run("limactl", ["stop", "--force", limaName(settings)], { timeout: phaseTimeout(settings) }); }
  return { resetData: true, stopped: !isRunning(limaName(settings)), cacheRetained,
    ...credentialCleanup, childrenRemoved: removals.length };
}

async function recoverWorkflowData({ configPath, manifestPath, input = null,
  interactive = process.stdin.isTTY, output: stream = process.stdout } = {}) {
  const resolvedManifest = path.resolve(required(manifestPath, "workflow manifest"));
  const manifest = JSON.parse(fs.readFileSync(resolvedManifest, "utf8"));
  const { hash: manifestHash, ...unsigned } = manifest;
  const { hashObject, verifyJournal } = require("./home-capacity-workflow");
  if (manifest.schema !== "home-capacity-workflow-manifest-v1" || hashObject(unsigned) !== manifestHash) {
    throw new Error("recovery workflow manifest hash is invalid");
  }
  const workflowDirectory = path.dirname(resolvedManifest);
  const workflowsRoot = path.dirname(workflowDirectory);
  const journal = verifyJournal({ directory: workflowDirectory, manifest });
  const selected = journal.events.filter((event) => event.type === "child-selected")
    .map((event) => ({ runId: event.payload.childId }));
  const instance = safeProviderName(manifest.provider?.instance, "confirmed Lima instance");
  const expected = new Set(selected.flatMap((child) =>
    Object.values(providerResourceNames({ instance, workflowId: manifest.workflowId,
      childId: child.runId }))));
  const observed = providerResourceCensus({ instance, workflowId: manifest.workflowId });
  const unexpected = observed.filter((row) => !expected.has(row.name));
  if (unexpected.length) throw new Error(`recovery found unconfirmed workflow resources: ${unexpected.map((row) => row.name).join(", ")}`);
  const lockFile = path.join(workflowsRoot, `${instance}.provider.lock.json`);
  if (!fs.existsSync(lockFile)) throw new Error("recovery requires the exact stale provider lock");
  const staleOwner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  if (staleOwner.workflowId !== manifest.workflowId || staleOwner.instance !== instance ||
      processMatches(staleOwner.pid, staleOwner.processStartIdentity)) {
    throw new Error("recovery provider lock is foreign or still live");
  }
  const expectedConfirmation = `CLEAN ${manifest.workflowId} ${manifest.hash}`;
  stream.write(`Disposable workflow: ${manifest.workflowId}\nResources: ${observed.map((row) => row.name).join(", ") || "none"}\n`);
  stream.write(`Type ${expectedConfirmation} to delete only these resources: `);
  let answer = input;
  if (answer == null) {
    if (!interactive) throw new Error("workflow recovery requires exact interactive confirmation");
    const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
    answer = await new Promise((resolve) => interface_.question("", resolve)); interface_.close();
  }
  if (String(answer).trim() !== expectedConfirmation) {
    throw new Error("workflow recovery confirmation did not match manifest identity");
  }
  const stalePath = `${lockFile}.stale-${Date.now()}-${crypto.randomUUID()}`;
  fs.renameSync(lockFile, stalePath);
  let recoveryHandle;
  const recoveryOwner = { schema: "home-capacity-provider-lock-v1", pid: process.pid,
    processStartIdentity: processStartIdentity(), workflowId: manifest.workflowId, instance,
    token: crypto.randomUUID(), acquiredAt: new Date().toISOString(), recovery: true };
  try {
    recoveryHandle = fs.openSync(lockFile, "wx", 0o600);
    fs.writeFileSync(recoveryHandle, `${JSON.stringify(recoveryOwner, null, 2)}\n`);
    recoveryOwner.file = lockFile;
    fs.writeFileSync(lockFile, `${JSON.stringify(recoveryOwner, null, 2)}\n`);
    const settings = { lima_instance: instance, __providerLock: recoveryOwner };
    const removals = selected.map((child) => removeWorkflowChildResources(settings, manifest, child, recoveryOwner));
    const credentialPaths = journal.events.flatMap((event) => event.payload?.credentialPaths || []);
    const credentialCleanup = removeHostCredentialPaths(credentialPaths);
    if (isPresent(instance)) { assertProviderLock(recoveryOwner);
      run("limactl", ["stop", "--force", instance]); }
    const recovery = { schema: "home-capacity-workflow-recovery-v1", workflowId: manifest.workflowId,
      manifestHash: manifest.hash, staleOwner, recoveredBy: recoveryOwner,
      resources: observed, removals, resetData: true, stopped: !isRunning(instance),
      ...credentialCleanup,
      recoveredAt: new Date().toISOString() };
    const recoveryPath = path.join(workflowDirectory, `recovery-${Date.now()}.json`);
    fs.writeFileSync(recoveryPath, `${JSON.stringify({ ...recovery,
      hash: hashObject(recovery) }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { ...recovery, recoveryPath };
  } finally {
    if (recoveryHandle !== undefined) fs.closeSync(recoveryHandle);
    if (fs.existsSync(lockFile)) {
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (current.token === recoveryOwner.token) fs.unlinkSync(lockFile);
    }
  }
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
  const parsedArgs = parseArgs(process.argv.slice(3));
  const settings = config(parsedArgs);
  const legacyLocks = validatedWorkflowRoot({ repository: repo(settings), configPath: parsedArgs.config });
  if (["restore", "scrub", "start", "stop", "destroy", "delete-vm", "fault"].includes(command)) {
    assertLegacyProviderAvailable({ instance: limaName(settings), directory: legacyLocks });
    settings.__legacyLockDirectory = legacyLocks;
  }
  if (command === "restore") { startVm(settings); startDatabase(settings); runCapacityDb(settings, "restore", ["--snapshot", required(process.env.CAPACITY_SNAPSHOT_PATH, "CAPACITY_SNAPSHOT_PATH")]); return; }
  if (command === "scrub") { runCapacityDb(settings, "scrub", ["--snapshot", required(process.env.CAPACITY_SNAPSHOT_PATH, "CAPACITY_SNAPSHOT_PATH"), "--attestation", required(process.env.CAPACITY_SCRUB_ATTESTATION_PATH, "CAPACITY_SCRUB_ATTESTATION_PATH")]); return; }
  if (command === "start") { startBackend(settings); return; }
  if (command === "stop") { stopBackend(settings); return; }
  if (command === "destroy") { destroy(settings); return; }
  if (command === "delete-vm") {
    assertDeleteVmConfirmation({ instance: limaName(settings), confirmation: parsedArgs.confirm });
    destroy(settings); return;
  }
  if (command === "reset-data") {
    await recoverWorkflowData({ configPath: parsedArgs.config,
      manifestPath: required(parsedArgs.workflow_manifest, "workflow manifest") }); return;
  }
  if (command === "fault") { await executeFault(settings, parseArgs(process.argv.slice(3))); return; }
  throw new Error("usage: node scripts/lima-capacity.js <restore|scrub|start|stop|destroy|reset-data|delete-vm|fault> --config <file>");
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}

module.exports = { PROVIDER_OPERATION_TIMEOUT_MS, assertContainerResourceCaps,
  assertDeleteVmConfirmation,
  assertLegacyProviderAvailable, assertOwnedResource,
  assertProviderIsolation, assertProviderLock,
  capacityParityOverlay, capacityResourcePlan, capacityRunId,
  cleanupWorkflowEnvironment, ensureVmResources, executeFault, faultPlan, globalEventProfile,
  homeOpenResolutionConcurrency, inspectVmResources, parseContainerResourceCaps, parseLimaResources,
  preparedNodeHelperCommand,
  prepareWorkflowEnvironment, providerResourceCensus, providerResourceNames, removeHostCredentialPaths,
  normalizedEnvironmentBinding, removeOwnedResource,
  removeWorkflowChildResources,
  recoverWorkflowData, resetWorkflowChild, validateAppliedMigrations, validatedWorkflowRoot,
  withProviderLock, workflowLabels };
