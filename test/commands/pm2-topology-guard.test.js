const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  classifyTopology,
  intersectPersistentOrphans,
  isSameProcess,
  selectOverMemoryHttpWorkers,
  captureLivePoolBaseline,
  validateLivePoolBudget,
  validateStaticPoolBudget,
} = require("../../scripts/pm2-topology-guard");

const PROD_DIR = "/var/www/step-tracker-backend";
const SCRIPT = `${PROD_DIR}/src/index.js`;

function registered(pid, name, id, memoryMb = 300) {
  return {
    pid,
    name,
    pmId: id,
    status: "online",
    cwd: PROD_DIR,
    memoryBytes: memoryMb * 1024 * 1024,
  };
}

function configured(pid, name, id, role, value) {
  const variable = {
    http: "DATABASE_POOL_MAX_HTTP",
    resolution: "DATABASE_POOL_MAX_RESOLUTION",
    cron: "DATABASE_POOL_MAX_CRON",
  }[role];
  const instance = role === "http" ? String(id - 5) : "0";
  return {
    ...registered(pid, name, id),
    role,
    environment: value == null ? { STEPS_PROCESS_ROLE: role, NODE_APP_INSTANCE: instance } : {
      STEPS_PROCESS_ROLE: role,
      NODE_APP_INSTANCE: instance,
      [variable]: String(value),
      ...(value === 20 ? {} : { DATABASE_POOL_TOTAL_BUDGET: "32" }),
    },
  };
}

function livePools(values = {}) {
  const value = (name, fallback) => Object.hasOwn(values, name) ? values[name] : fallback;
  return [
    configured(201, "steps-tracker", 5, "http", value("http0", 10)),
    configured(202, "steps-tracker", 6, "http", value("http1", 10)),
    configured(203, "steps-tracker-resolution", 3, "resolution", value("resolution", 8)),
    configured(204, "steps-tracker-cron", 4, "cron", value("cron", 4)),
  ];
}

function candidateApps() {
  const apps = structuredClone(require("../../ecosystem.config").apps);
  const targets = {
    "steps-tracker": ["DATABASE_POOL_MAX_HTTP", "10"],
    "steps-tracker-resolution": ["DATABASE_POOL_MAX_RESOLUTION", "8"],
    "steps-tracker-cron": ["DATABASE_POOL_MAX_CRON", "4"],
  };
  for (const [name, [variable, value]] of Object.entries(targets)) {
    const env = apps.find((entry) => entry.name === name).env;
    env[variable] = value;
    env.DATABASE_POOL_TOTAL_BUDGET = "32";
  }
  return apps;
}

function process(pid, ppid = 100) {
  return {
    pid,
    ppid,
    cwd: PROD_DIR,
    executable: "/usr/bin/node",
    argv: ["/usr/bin/node", SCRIPT],
    startTimeTicks: 12345 + pid,
  };
}

function pm2ContainerProcess(pid, ppid = 100) {
  return {
    ...process(pid, ppid),
    argv: [`node ${SCRIPT}`],
    pmExecPath: SCRIPT,
  };
}

test("accepts exactly the registered production topology", () => {
  const pm2 = [
    registered(201, "steps-tracker", 5),
    registered(202, "steps-tracker", 6),
    registered(203, "steps-tracker-resolution", 3),
    registered(204, "steps-tracker-cron", 4),
  ];

  const result = classifyTopology({ pm2, processes: pm2.map(({ pid }) => process(pid)) });

  assert.equal(result.healthy, true);
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.counts, {
    "steps-tracker": 2,
    "steps-tracker-resolution": 1,
    "steps-tracker-cron": 1,
  });
});

test("PID reuse cannot pass the final process-identity check", () => {
  const original = process(999);

  assert.equal(isSameProcess(original, { ...original }), true);
  assert.equal(isSameProcess(original, { ...original, startTimeTicks: 999999 }), false);
});

test("accepts the combined argv emitted by real PM2 containers", () => {
  const pm2 = [
    registered(201, "steps-tracker", 5),
    registered(202, "steps-tracker", 6),
    registered(203, "steps-tracker-resolution", 3),
    registered(204, "steps-tracker-cron", 4),
  ];

  const result = classifyTopology({
    pm2,
    processes: pm2.map(({ pid }) => pm2ContainerProcess(pid)),
  });

  assert.equal(result.healthy, true);
});

test("only an orphan surviving both snapshots is persistent", () => {
  const old = process(900);
  const replacement = process(901);

  assert.deepEqual(intersectPersistentOrphans([old], [replacement]), []);
  assert.deepEqual(intersectPersistentOrphans([old], [{ ...old }]), [old]);
  assert.deepEqual(
    intersectPersistentOrphans([old], [{ ...old, startTimeTicks: 999999 }]),
    [],
  );
});

test("detects a persistent production child missing from PM2's registry", () => {
  const pm2 = [
    registered(201, "steps-tracker", 5),
    registered(202, "steps-tracker", 6),
    registered(203, "steps-tracker-resolution", 3),
    registered(204, "steps-tracker-cron", 4),
  ];

  const result = classifyTopology({
    pm2,
    processes: [...pm2.map(({ pid }) => process(pid)), process(999)],
  });

  assert.equal(result.healthy, false);
  assert.deepEqual(result.orphans.map(({ pid }) => pid), [999]);
});

test("never treats unrelated or staging Node processes as production orphans", () => {
  const pm2 = [
    registered(201, "steps-tracker", 5),
    registered(202, "steps-tracker", 6),
    registered(203, "steps-tracker-resolution", 3),
    registered(204, "steps-tracker-cron", 4),
  ];
  const unrelated = {
    ...process(998),
    cwd: "/var/www/step-tracker-backend-staging",
    argv: ["/usr/bin/node", "/var/www/step-tracker-backend-staging/src/index.js"],
  };

  const result = classifyTopology({
    pm2,
    processes: [...pm2.map(({ pid }) => process(pid)), unrelated],
  });

  assert.equal(result.healthy, true);
  assert.deepEqual(result.orphans, []);
});

test("selects only registered HTTP workers above the external memory ceiling", () => {
  const pm2 = [
    registered(201, "steps-tracker", 5, 1300),
    registered(202, "steps-tracker", 6, 900),
    registered(203, "steps-tracker-resolution", 3, 1400),
  ];

  assert.deepEqual(
    selectOverMemoryHttpWorkers(pm2, 1200 * 1024 * 1024).map(({ pid }) => pid),
    [201],
  );
});

test("production config delegates clustered HTTP memory enforcement to the watchdog", () => {
  const config = require("../../ecosystem.config");
  const http = config.apps.find(({ name }) => name === "steps-tracker");
  const resolution = config.apps.find(({ name }) => name === "steps-tracker-resolution");
  const cron = config.apps.find(({ name }) => name === "steps-tracker-cron");

  assert.equal(http.instances, 2);
  assert.equal(http.max_memory_restart, "100G");
  assert.equal(resolution.max_memory_restart, "600M");
  assert.equal(
    resolution.node_args,
    "--max-old-space-size=320 --max-semi-space-size=8",
  );
  assert.equal(
    cron.node_args,
    "--max-old-space-size=1024 --max-semi-space-size=16",
  );
  assert.equal(resolution.exp_backoff_restart_delay, 1000);
  assert.equal(cron.exp_backoff_restart_delay, undefined);
  assert.equal(http.exp_backoff_restart_delay, undefined);
});

test("the stopped single-process staging app uses its explicit combined role", () => {
  const config = require("../../ecosystem.config");
  const staging = config.apps.find(({ name }) => name === "steps-tracker-staging");

  assert.equal(staging.instances, 1);
  assert.equal(staging.autostart, false);
  assert.equal(staging.env.STEPS_PROCESS_ROLE, "staging_all");
});

test("deployment B static preflight locks the production 2x10 + 8 + 4 = 32 budget", () => {
  const config = require("../../ecosystem.config");
  const result = validateStaticPoolBudget(config.apps);
  assert.deepEqual(result.roleTotals, { http: 20, resolution: 8, cron: 4 });
  assert.equal(result.aggregate, 32);
  assert.equal(result.totalBudget, 32);
  assert.equal(result.stage, "role-budget");
  assert.equal(result.productionProcesses, 4);
});

test("static pool preflight rejects missing values, mismatched totals, and extra HTTP workers", () => {
  const config = require("../../ecosystem.config");
  const copy = () => structuredClone(config.apps);
  const partial = copy();
  delete partial.find(({ name }) => name === "steps-tracker-resolution").env.DATABASE_POOL_MAX_RESOLUTION;
  assert.throws(() => validateStaticPoolBudget(partial), /DATABASE_POOL_MAX_RESOLUTION/);
  const mismatched = candidateApps();
  mismatched.find(({ name }) => name === "steps-tracker").env.DATABASE_POOL_TOTAL_BUDGET = "31";
  assert.throws(() => validateStaticPoolBudget(mismatched), /DATABASE_POOL_TOTAL_BUDGET/);
  const extra = copy();
  extra.find(({ name }) => name === "steps-tracker").instances = 3;
  assert.throws(() => validateStaticPoolBudget(extra), /steps-tracker.*2/);
  const unexpected = copy();
  unexpected.push({
    name: "steps-tracker-extra",
    cwd: PROD_DIR,
    instances: 1,
    env: { STEPS_PROCESS_ROLE: "cron", DATABASE_POOL_MAX_CRON: "4" },
  });
  assert.throws(() => validateStaticPoolBudget(unexpected), /Unexpected production/);
});

test("static pool preflight rejects an expected app outside the reviewed cwd or script", () => {
  const config = require("../../ecosystem.config");
  const wrongCwd = structuredClone(config.apps);
  wrongCwd.find(({ name }) => name === "steps-tracker").cwd = "/tmp/lookalike-production";
  assert.throws(() => validateStaticPoolBudget(wrongCwd), /steps-tracker.*cwd/);

  const wrongScript = structuredClone(config.apps);
  wrongScript.find(({ name }) => name === "steps-tracker-cron").script = "/tmp/lookalike-index.js";
  assert.throws(() => validateStaticPoolBudget(wrongScript), /steps-tracker-cron.*script/);
});

test("static and live guards derive reviewed values from environment source of truth", () => {
  const config = structuredClone(require("../../ecosystem.config").apps);
  const byName = Object.fromEntries(config.map((entry) => [entry.name, entry]));
  byName["steps-tracker"].env.DATABASE_POOL_MAX_HTTP = "9";
  byName["steps-tracker-resolution"].env.DATABASE_POOL_MAX_RESOLUTION = "7";
  byName["steps-tracker-cron"].env.DATABASE_POOL_MAX_CRON = "3";
  for (const name of ["steps-tracker", "steps-tracker-resolution", "steps-tracker-cron"]) {
    byName[name].env.DATABASE_POOL_TOTAL_BUDGET = "28";
  }
  const staticResult = validateStaticPoolBudget(config);
  assert.deepEqual(staticResult.targets, { http: 9, resolution: 7, cron: 3 });
  assert.equal(staticResult.aggregate, 28);

  const live = livePools().map((entry) => ({ ...entry, environment: { ...entry.environment } }));
  for (const entry of live) {
    const target = { http: "9", resolution: "7", cron: "3" }[entry.role];
    entry.environment[{
      http: "DATABASE_POOL_MAX_HTTP",
      resolution: "DATABASE_POOL_MAX_RESOLUTION",
      cron: "DATABASE_POOL_MAX_CRON",
    }[entry.role]] = target;
    entry.environment.DATABASE_POOL_TOTAL_BUDGET = "28";
  }
  assert.equal(validateLivePoolBudget(live, { mode: "final", apps: config }).aggregate, 28);
});

test("role-scoped pool validation accepts only the safe HTTP then cron then resolution transitions", () => {
  const initial = livePools({ http0: null, http1: null, resolution: null, cron: null });
  const baseline = captureLivePoolBaseline(initial);
  assert.equal(validateLivePoolBudget(livePools({ resolution: null, cron: null }), {
    mode: "transition",
    transitionedRoles: ["http"],
    baseline,
    apps: candidateApps(),
  }).aggregate, 60);
  assert.equal(validateLivePoolBudget(livePools({ resolution: null }), {
    mode: "transition",
    transitionedRoles: ["http", "cron"],
    baseline,
    apps: candidateApps(),
  }).aggregate, 44);
  assert.equal(validateLivePoolBudget(livePools(), {
    mode: "transition",
    transitionedRoles: ["http", "cron", "resolution"],
    baseline,
    apps: candidateApps(),
  }).aggregate, 32);
});

test("role-scoped validation rejects missing values and unexpected mixed states", () => {
  const baseline = captureLivePoolBaseline(livePools({
    http0: null, http1: null, resolution: null, cron: null,
  }));
  assert.throws(() => validateLivePoolBudget(livePools({
    http0: 9, http1: 10, resolution: null, cron: null,
  }), {
    mode: "transition",
    transitionedRoles: ["http"],
    baseline,
    apps: candidateApps(),
  }), /http.*10/);
  const missing = livePools({ resolution: 20 });
  delete missing[0].environment.DATABASE_POOL_MAX_HTTP;
  assert.throws(() => validateLivePoolBudget(missing, {
    mode: "transition",
    transitionedRoles: ["http", "cron", "resolution"],
    baseline,
    apps: candidateApps(),
  }), /DATABASE_POOL_MAX_HTTP/);
  assert.throws(() => validateLivePoolBudget(livePools({
    http0: 10, http1: null, resolution: null, cron: null,
  }), {
    mode: "transition",
    transitionedRoles: ["http"],
    baseline,
    apps: candidateApps(),
  }), /http PID 202.*10/);
});

test("final strict pool validation requires every PID and exact aggregate 32", () => {
  assert.equal(validateLivePoolBudget(livePools(), { mode: "final", apps: candidateApps() }).aggregate, 32);
  assert.throws(
    () => validateLivePoolBudget(livePools({ http1: 20 }), { mode: "final", apps: candidateApps() }),
    /DATABASE_POOL_MAX_HTTP/,
  );
});

test("the production reload wrapper serializes and reapplies ecosystem config", () => {
  const wrapper = fs.readFileSync(
    path.join(__dirname, "../../scripts/pm2-safe-prod-reload.sh"),
    "utf8",
  );

  assert.match(wrapper, /flock .*steps-tracker-pm2\.lock/);
  assert.match(wrapper, /--pool-budget-mode=static/);
  assert.match(wrapper, /--pool-budget-mode=baseline/);
  assert.match(wrapper, /--baseline-file=/);
  assert.match(wrapper, /dotenv\.parse\(fs\.readFileSync\("\.env"\)\)/);
  assert.match(
    wrapper,
    /export CONFIG GUARD MIN_SUPPORTED_APP_VERSION LATEST_APP_VERSION/,
  );
  const ecosystem = fs.readFileSync(
    path.join(__dirname, "../../ecosystem.config.js"),
    "utf8",
  );
  assert.match(
    ecosystem,
    /MIN_SUPPORTED_APP_VERSION: process\.env\.MIN_SUPPORTED_APP_VERSION/,
  );
  assert.match(
    ecosystem,
    /LATEST_APP_VERSION: process\.env\.LATEST_APP_VERSION/,
  );
  assert.match(
    wrapper,
    /pm2 startOrReload "\$CONFIG" --only steps-tracker --update-env/,
  );
  assert.match(wrapper, /--only steps-tracker-resolution/);
  assert.match(wrapper, /--only steps-tracker-cron/);
  assert.match(wrapper, /OLD_CRON_PID=.*pm2 pid steps-tracker-cron/);
  assert.match(wrapper, /pm2 stop steps-tracker-cron/);
  assert.match(wrapper, /kill -0 "\$OLD_CRON_PID"/);
  assert.match(wrapper, /sleep 30/);
  assert.match(wrapper, /pm2 start "\$CONFIG" --only steps-tracker-cron/);
  assert.doesNotMatch(wrapper, /startOrReload "\$CONFIG" --only steps-tracker-cron/);
  assert.doesNotMatch(wrapper, /pm2 reload steps-tracker/);
  const lines = wrapper.split("\n").map((line) => line.trim());
  const httpReload = lines.findIndex((line) =>
    line.endsWith("--only steps-tracker --update-env"),
  );
  const sentinelCheck = lines.findIndex((line) => line.includes("--verify-live-config"));
  const resolutionReload = lines.findIndex((line) => line.endsWith("--only steps-tracker-resolution"));
  const cronReload = lines.findIndex((line) => line.endsWith("--only steps-tracker-cron"));
  assert.ok([httpReload, sentinelCheck, resolutionReload, cronReload].every((index) => index >= 0));
  const finalStrict = lines.findIndex((line) => line.includes("--pool-budget-mode=final"));
  assert.ok(httpReload < cronReload);
  assert.ok(cronReload < resolutionReload);
  assert.ok(resolutionReload < sentinelCheck);
  assert.ok(sentinelCheck < finalStrict);
});

test("runbook cannot bypass the serialized production wrapper for HTTP reload/save", () => {
  const runbook = fs.readFileSync(path.join(__dirname, "../../DEPLOY_RUNBOOK.md"), "utf8");
  assert.doesNotMatch(runbook, /^\s*pm2 startOrReload ecosystem\.config\.js --only steps-tracker\s*$/m);
  assert.doesNotMatch(runbook, /^\s*pm2 save(?:\s|$)/m);
  assert.doesNotMatch(runbook, /^\s*pm2 scale steps-tracker(?:\s|$)/m);
});

test("stall-recovery rollout and rollback reload the changed HTTP workers too", () => {
  const runbook = fs.readFileSync(path.join(__dirname, "../../DEPLOY_RUNBOOK.md"), "utf8");
  const section = runbook.slice(runbook.indexOf("Race-resolution stall recovery"));
  assert.match(section, /pm2-safe-prod-reload\.sh/);
  assert.doesNotMatch(section, /restart of only\s+`steps-tracker-resolution` and `steps-tracker-cron`/);
  assert.doesNotMatch(section, /Do not restart the two HTTP\s+workers for this rollback/);
});

test("stall-recovery deploy applies its additive migration before any process reload", () => {
  const runbook = fs.readFileSync(path.join(__dirname, "../../DEPLOY_RUNBOOK.md"), "utf8");
  const section = runbook.slice(runbook.indexOf("Race-resolution stall recovery"));
  const migrate = section.indexOf("npx prisma migrate deploy");
  const reload = section.indexOf("./scripts/pm2-safe-prod-reload.sh");

  assert.ok(migrate >= 0, "the outbox migration command must be explicit");
  assert.ok(reload >= 0, "the serialized reload command must be explicit");
  assert.ok(migrate < reload, "the outbox table must exist before new processes start");
});

test("resolution reload never overlaps old and new post-task runners", () => {
  const wrapper = fs.readFileSync(
    path.join(__dirname, "../../scripts/pm2-safe-prod-reload.sh"),
    "utf8",
  );
  const lines = wrapper.split("\n").map((line) => line.trim());
  const oldPid = lines.findIndex((line) => line.startsWith("OLD_RESOLUTION_PID="));
  const stop = lines.findIndex((line) => line === "pm2 stop steps-tracker-resolution");
  const gone = lines.findIndex((line) => line.includes("old resolution PID did not exit"));
  const start = lines.findIndex((line) =>
    line === 'pm2 start "$CONFIG" --only steps-tracker-resolution'
  );

  assert.ok([oldPid, stop, gone, start].every((index) => index >= 0));
  assert.ok(oldPid < stop && stop < gone && gone < start);
  assert.doesNotMatch(
    wrapper,
    /pm2 startOrReload "\$CONFIG" --only steps-tracker-resolution/,
  );
});

test("stall-recovery rollout removes old HTTP and cron claimers before new resolution starts", () => {
  const wrapper = fs.readFileSync(
    path.join(__dirname, "../../scripts/pm2-safe-prod-reload.sh"),
    "utf8",
  );
  const lines = wrapper.split("\n").map((line) => line.trim());
  const httpReload = lines.findIndex((line) =>
    line.endsWith("--only steps-tracker --update-env")
  );
  const cronStop = lines.findIndex((line) => line === "pm2 stop steps-tracker-cron");
  const cronGone = lines.findIndex((line) => line.includes("old cron PID did not exit"));
  const resolutionStop = lines.findIndex(
    (line) => line === "pm2 stop steps-tracker-resolution",
  );
  const resolutionStart = lines.findIndex((line) =>
    line === 'pm2 start "$CONFIG" --only steps-tracker-resolution'
  );

  assert.ok(
    [httpReload, cronStop, cronGone, resolutionStop, resolutionStart]
      .every((index) => index >= 0),
  );
  assert.ok(httpReload < cronStop);
  assert.ok(cronStop < cronGone);
  assert.ok(cronGone < resolutionStop);
  assert.ok(resolutionStop < resolutionStart);
});

test("stall-recovery rollback drains new-format work before restoring old code", () => {
  const runbook = fs.readFileSync(path.join(__dirname, "../../DEPLOY_RUNBOOK.md"), "utf8");
  const section = runbook.slice(runbook.indexOf("Race-resolution stall recovery"));
  const rollback = section.slice(section.indexOf("Rollback"));
  const stopClaims = rollback.indexOf("ROLLBACK STEP 1 — STOP NEW CORE CLAIMS");
  const coreDrain = rollback.indexOf(
    "ROLLBACK STEP 2 — QUIESCE EVERY PRE-DISABLE CORE ATTEMPT",
  );
  const postTaskDrain = rollback.indexOf("ROLLBACK STEP 3 — DRAIN NEW-FORMAT POST-TASKS");
  const verifyZero = rollback.indexOf("ROLLBACK STEP 4 — VERIFY BOTH COUNTS ARE ZERO");
  const restoreOldCode = rollback.indexOf("ROLLBACK STEP 5 — RESTORE OLD CODE");
  const resumeClaims = rollback.indexOf("ROLLBACK STEP 6 — RESUME CORE CLAIMS");

  assert.ok(
    [stopClaims, coreDrain, postTaskDrain, verifyZero, restoreOldCode, resumeClaims]
      .every((index) => index >= 0),
    "rollback must spell out every compatibility boundary",
  );
  assert.ok(stopClaims < coreDrain);
  assert.ok(coreDrain < postTaskDrain);
  assert.ok(postTaskDrain < verifyZero);
  assert.ok(verifyZero < restoreOldCode);
  assert.ok(restoreOldCode < resumeClaims);
  assert.match(rollback, /raceQueueV2ClaimingDisabled/);
  assert.match(rollback, /effectExpiryParticipantSteps/);
  assert.match(rollback, /snapshot_command\s+\?\s+'effectExpiryParticipantSteps'/);
  assert.match(rollback, /state\s+IN\s+\('queued',\s*'running'\)/i);
  assert.match(rollback, /abort the rollback/i);
});

test("stall-recovery rollback outwaits an expired lease's still-live watchdog attempt", () => {
  const runbook = fs.readFileSync(path.join(__dirname, "../../DEPLOY_RUNBOOK.md"), "utf8");
  const section = runbook.slice(runbook.indexOf("Race-resolution stall recovery"));
  const rollback = section.slice(section.indexOf("Rollback"));
  const cacheWait = rollback.indexOf("sleep 3");
  const barrierDeclaration = rollback.match(
    /ROLLBACK_WATCHDOG_QUIESCENCE_SECONDS="(\d+)"/,
  );
  const barrierWait = rollback.indexOf(
    'sleep "$ROLLBACK_WATCHDOG_QUIESCENCE_SECONDS"',
  );
  const postTaskDrain = rollback.indexOf(
    "ROLLBACK STEP 3 — DRAIN NEW-FORMAT POST-TASKS",
  );
  const finalCoreCheck = rollback.lastIndexOf(
    "state='running' AND lease_expires_at > NOW()",
  );
  const restoreOldCode = rollback.indexOf("ROLLBACK STEP 5 — RESTORE OLD CODE");

  assert.ok(barrierDeclaration, "rollback must declare an explicit watchdog barrier");
  assert.ok(
    Number(barrierDeclaration[1]) >= 65,
    "barrier must exceed the 60-second watchdog after the claim-cache wait",
  );
  assert.ok(cacheWait < barrierWait);
  assert.ok(barrierWait < postTaskDrain);
  assert.ok(postTaskDrain < finalCoreCheck);
  assert.ok(finalCoreCheck < restoreOldCode);

  // A lease expiring at t=30 does not stop its JavaScript attempt: it can still
  // commit at t=55. The enforced t>=65 barrier must precede the first post-task
  // zero observation, otherwise rollback can miss that late durable handoff.
  const leaseExpirySeconds = 30;
  const possibleCommitSeconds = 55;
  const watchdogSeconds = 60;
  const barrierSeconds = Number(barrierDeclaration[1]);
  assert.ok(leaseExpirySeconds < possibleCommitSeconds);
  assert.ok(possibleCommitSeconds < watchdogSeconds);
  assert.ok(watchdogSeconds < barrierSeconds);
});

test("stall-recovery rollback final go/no-go shell is executable and runs both checks", () => {
  const runbook = fs.readFileSync(path.join(__dirname, "../../DEPLOY_RUNBOOK.md"), "utf8");
  const stepFour = runbook.slice(
    runbook.indexOf("ROLLBACK STEP 4 — VERIFY BOTH COUNTS ARE ZERO"),
    runbook.indexOf("**ROLLBACK STEP 5 — RESTORE OLD CODE"),
  );
  const shellBlock = stepFour.match(/```bash\n([\s\S]*?)\n```/);

  assert.ok(shellBlock, "step 4 must contain an auditable bash block");
  assert.equal((shellBlock[1].match(/psql "\$DBU"/g) || []).length, 2);
  assert.match(shellBlock[1], /active_core_jobs/);
  assert.match(shellBlock[1], /pending_new_format_post_tasks/);
  assert.match(shellBlock[1], /FINAL_ACTIVE_CORE_JOBS=/);
  assert.match(shellBlock[1], /FINAL_NEW_FORMAT_POST_TASKS=/);
  assert.match(
    shellBlock[1],
    /\[ "\$FINAL_ACTIVE_CORE_JOBS" = "0" \] \|\| .*abort the rollback/,
  );
  assert.match(
    shellBlock[1],
    /\[ "\$FINAL_NEW_FORMAT_POST_TASKS" = "0" \] \|\| .*abort the rollback/,
  );

  const syntax = spawnSync("sh", ["-n"], {
    input: shellBlock[1],
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});
