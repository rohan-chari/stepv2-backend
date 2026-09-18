const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  classifyTopology,
  intersectPersistentOrphans,
  isSameProcess,
  selectOverMemoryHttpWorkers,
  validateLivePoolBudget,
  validateStaticPoolBudget,
} = require("../../scripts/pm2-topology-guard");

const PROD_DIR = "/var/www/step-tracker-backend";
const SCRIPT = `${PROD_DIR}/src/index.js`;

const TARGET = Object.freeze({
  "steps-tracker": 2,
  "steps-tracker-step": 1,
  "steps-tracker-resolution": 1,
  "steps-tracker-event": 1,
  "steps-tracker-notification": 1,
  "steps-tracker-cron": 1,
});

const LEGACY = Object.freeze({
  "steps-tracker": 2,
  "steps-tracker-resolution": 1,
  "steps-tracker-cron": 1,
});

const ROLE_BY_NAME = {
  "steps-tracker": "http",
  "steps-tracker-step": "step",
  "steps-tracker-resolution": "resolution",
  "steps-tracker-event": "event",
  "steps-tracker-notification": "notification",
  "steps-tracker-cron": "cron",
};

const POOL_BY_ROLE = {
  http: ["DATABASE_POOL_MAX_HTTP", 10],
  step: ["DATABASE_POOL_MAX_STEP", 3],
  resolution: ["DATABASE_POOL_MAX_RESOLUTION", 6],
  event: ["DATABASE_POOL_MAX_EVENT", 3],
  notification: ["DATABASE_POOL_MAX_NOTIFICATION", 4],
  cron: ["DATABASE_POOL_MAX_CRON", 3],
};

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

function processInfo(pid, ppid = 100) {
  return {
    pid,
    ppid,
    cwd: PROD_DIR,
    executable: "/usr/bin/node",
    argv: ["/usr/bin/node", SCRIPT],
    startTimeTicks: 12345 + pid,
  };
}

function targetPm2() {
  return [
    registered(201, "steps-tracker", 5),
    registered(202, "steps-tracker", 6),
    registered(203, "steps-tracker-step", 7),
    registered(204, "steps-tracker-resolution", 8),
    registered(205, "steps-tracker-event", 9),
    registered(206, "steps-tracker-notification", 10),
    registered(207, "steps-tracker-cron", 11),
  ];
}

function legacyPm2() {
  return [
    registered(201, "steps-tracker", 5),
    registered(202, "steps-tracker", 6),
    registered(204, "steps-tracker-resolution", 8),
    registered(207, "steps-tracker-cron", 11),
  ];
}

function configured(pid, name, id, valueOverride = undefined) {
  const role = ROLE_BY_NAME[name];
  const [variable, target] = POOL_BY_ROLE[role];
  const value = valueOverride === undefined ? target : valueOverride;
  const instance = role === "http" ? String(id - 5) : "0";
  return {
    ...registered(pid, name, id),
    role,
    environment: {
      STEPS_PROCESS_ROLE: role,
      NODE_APP_INSTANCE: instance,
      [variable]: String(value),
      DATABASE_POOL_TOTAL_BUDGET: "39",
    },
  };
}

function livePools() {
  return [
    configured(201, "steps-tracker", 5),
    configured(202, "steps-tracker", 6),
    configured(203, "steps-tracker-step", 7),
    configured(204, "steps-tracker-resolution", 8),
    configured(205, "steps-tracker-event", 9),
    configured(206, "steps-tracker-notification", 10),
    configured(207, "steps-tracker-cron", 11),
  ];
}

test("target topology is exactly 2 HTTP plus five isolated background owners", () => {
  const pm2 = targetPm2();
  const result = classifyTopology({
    pm2,
    processes: pm2.map(({ pid }) => processInfo(pid)),
  });

  assert.equal(result.healthy, true);
  assert.deepEqual(result.counts, TARGET);
  assert.deepEqual(result.orphans, []);
});

test("reviewed legacy topology is recognizable only when explicitly requested", () => {
  const pm2 = legacyPm2();
  const snapshot = {
    pm2,
    processes: pm2.map(({ pid }) => processInfo(pid)),
  };

  assert.equal(classifyTopology(snapshot).healthy, false);
  assert.equal(classifyTopology({ ...snapshot, expected: LEGACY }).healthy, true);
});

test("PID reuse cannot pass process identity checks", () => {
  const original = processInfo(999);
  assert.equal(isSameProcess(original, { ...original }), true);
  assert.equal(isSameProcess(original, { ...original, startTimeTicks: 1 }), false);
  assert.deepEqual(intersectPersistentOrphans([original], [{ ...original }]), [original]);
});

test("a production child missing from PM2 is an orphan", () => {
  const pm2 = targetPm2();
  const result = classifyTopology({
    pm2,
    processes: [...pm2.map(({ pid }) => processInfo(pid)), processInfo(999)],
  });
  assert.equal(result.healthy, false);
  assert.deepEqual(result.orphans.map(({ pid }) => pid), [999]);
});

test("memory watchdog selection remains HTTP-only", () => {
  const pm2 = [
    registered(201, "steps-tracker", 5, 1300),
    registered(202, "steps-tracker", 6, 900),
    registered(204, "steps-tracker-resolution", 8, 1400),
  ];
  assert.deepEqual(
    selectOverMemoryHttpWorkers(pm2, 1200 * 1024 * 1024).map(({ pid }) => pid),
    [201],
  );
});

test("ecosystem config declares the reviewed split topology and pool budget", () => {
  const config = require("../../ecosystem.config");
  const production = Object.fromEntries(
    config.apps
      .filter((entry) => entry.cwd === PROD_DIR && entry.name !== "steps-tracker-staging")
      .map((entry) => [entry.name, entry]),
  );

  assert.deepEqual(
    Object.fromEntries(Object.entries(production).map(([name, entry]) => [name, entry.instances])),
    TARGET,
  );

  for (const [name, role] of Object.entries(ROLE_BY_NAME)) {
    const entry = production[name];
    const [variable, target] = POOL_BY_ROLE[role];
    assert.equal(entry.env.STEPS_PROCESS_ROLE, role);
    assert.equal(entry.env[variable], String(target));
    assert.equal(entry.env.DATABASE_POOL_TOTAL_BUDGET, "39");
  }

  assert.equal(production["steps-tracker"].max_memory_restart, "100G");
  for (const name of [
    "steps-tracker-step",
    "steps-tracker-resolution",
    "steps-tracker-event",
    "steps-tracker-notification",
  ]) {
    assert.equal(
      production[name].node_args,
      "--max-old-space-size=320 --max-semi-space-size=8",
    );
  }
  assert.equal(
    production["steps-tracker-cron"].node_args,
    "--max-old-space-size=1024 --max-semi-space-size=16",
  );

  const staging = config.apps.find(({ name }) => name === "steps-tracker-staging");
  assert.equal(staging.instances, 1);
  assert.equal(staging.autostart, false);
  assert.equal(staging.env.STEPS_PROCESS_ROLE, "staging_all");
});

test("static pool preflight locks the reviewed aggregate at 39", () => {
  const config = require("../../ecosystem.config");
  const result = validateStaticPoolBudget(config.apps);
  assert.deepEqual(result.roleTotals, {
    http: 20,
    step: 3,
    resolution: 6,
    event: 3,
    notification: 4,
    cron: 3,
  });
  assert.equal(result.aggregate, 39);
  assert.equal(result.totalBudget, 39);
  assert.equal(result.productionProcesses, 7);
  assert.equal(result.stage, "role-budget");
});

test("static pool preflight rejects missing role values, total drift, and extra processes", () => {
  const copy = () => structuredClone(require("../../ecosystem.config").apps);

  const missing = copy();
  delete missing.find(({ name }) => name === "steps-tracker-notification")
    .env.DATABASE_POOL_MAX_NOTIFICATION;
  assert.throws(() => validateStaticPoolBudget(missing), /DATABASE_POOL_MAX_NOTIFICATION/);

  const mismatch = copy();
  mismatch.find(({ name }) => name === "steps-tracker-event")
    .env.DATABASE_POOL_TOTAL_BUDGET = "40";
  assert.throws(() => validateStaticPoolBudget(mismatch), /DATABASE_POOL_TOTAL_BUDGET/);

  const extra = copy();
  extra.push({
    name: "steps-tracker-extra",
    cwd: PROD_DIR,
    script: SCRIPT,
    instances: 1,
    env: { STEPS_PROCESS_ROLE: "cron", DATABASE_POOL_MAX_CRON: "3" },
  });
  assert.throws(() => validateStaticPoolBudget(extra), /Unexpected production/);
});

test("live final pool validation requires exact split values and aggregate 39", () => {
  const config = require("../../ecosystem.config").apps;
  assert.equal(validateLivePoolBudget(livePools(), {
    mode: "final",
    apps: config,
  }).aggregate, 39);

  const wrong = livePools();
  wrong.find(({ role }) => role === "notification")
    .environment.DATABASE_POOL_MAX_NOTIFICATION = "5";
  assert.throws(
    () => validateLivePoolBudget(wrong, { mode: "final", apps: config }),
    /notification.*4/i,
  );
});

test("production reload wrapper supports legacy source then starts every split owner", () => {
  const wrapper = fs.readFileSync(
    path.join(__dirname, "../../scripts/pm2-safe-prod-reload.sh"),
    "utf8",
  );

  assert.match(wrapper, /flock .*steps-tracker-pm2\.lock/);
  assert.match(wrapper, /--pool-budget-mode=static/);
  assert.match(wrapper, /--source-topology/);
  assert.match(wrapper, /pm2 startOrReload "\$CONFIG" --only steps-tracker --update-env/);

  const lines = wrapper.split("\n").map((line) => line.trim());
  const stopCron = lines.indexOf("stop_and_wait_if_present steps-tracker-cron");
  const stopNotification = lines.indexOf("stop_and_wait_if_present steps-tracker-notification");
  const stopEvent = lines.indexOf("stop_and_wait_if_present steps-tracker-event");
  const stopStep = lines.indexOf("stop_and_wait_if_present steps-tracker-step");
  const stopResolution = lines.indexOf("stop_and_wait_if_present steps-tracker-resolution");
  const sleep = lines.indexOf("sleep 30");
  const startStep = lines.indexOf('pm2 start "$CONFIG" --only steps-tracker-step');
  const startResolution = lines.indexOf('pm2 start "$CONFIG" --only steps-tracker-resolution');
  const startEvent = lines.indexOf('pm2 start "$CONFIG" --only steps-tracker-event');
  const startNotification = lines.indexOf('pm2 start "$CONFIG" --only steps-tracker-notification');
  const startCron = lines.indexOf('pm2 start "$CONFIG" --only steps-tracker-cron');
  const finalPool = lines.findIndex((line) => line.includes("--pool-budget-mode=final"));
  const save = lines.indexOf("pm2 save");

  assert.ok([
    stopCron, stopNotification, stopEvent, stopStep, stopResolution, sleep,
    startStep, startResolution, startEvent, startNotification, startCron,
    finalPool, save,
  ].every((index) => index >= 0));

  assert.ok(stopCron < stopNotification);
  assert.ok(stopNotification < stopEvent);
  assert.ok(stopEvent < stopStep);
  assert.ok(stopStep < stopResolution);
  assert.ok(stopResolution < sleep);
  assert.ok(sleep < startStep);
  assert.ok(startStep < startResolution);
  assert.ok(startResolution < startEvent);
  assert.ok(startEvent < startNotification);
  assert.ok(startNotification < startCron);
  assert.ok(startCron < finalPool);
  assert.ok(finalPool < save);

  assert.doesNotMatch(wrapper, /pm2 reload steps-tracker/);
  assert.doesNotMatch(wrapper, /pm2 restart \d+/);
});
