const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  classifyTopology,
  intersectPersistentOrphans,
  isSameProcess,
  selectOverMemoryHttpWorkers,
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
  assert.equal(cron.node_args, resolution.node_args);
});

test("the production reload wrapper serializes and reapplies ecosystem config", () => {
  const wrapper = fs.readFileSync(
    path.join(__dirname, "../../scripts/pm2-safe-prod-reload.sh"),
    "utf8",
  );

  assert.match(wrapper, /flock .*steps-tracker-pm2\.lock/);
  assert.match(wrapper, /pm2 startOrReload "\$CONFIG" --only steps-tracker/);
  assert.match(wrapper, /--only steps-tracker-resolution/);
  assert.match(wrapper, /--only steps-tracker-cron/);
  assert.doesNotMatch(wrapper, /pm2 reload steps-tracker/);
  const lines = wrapper.split("\n").map((line) => line.trim());
  const httpReload = lines.findIndex((line) => line.endsWith("--only steps-tracker"));
  const sentinelCheck = lines.findIndex((line) => line.includes("--verify-live-config"));
  const resolutionReload = lines.findIndex((line) => line.endsWith("--only steps-tracker-resolution"));
  const cronReload = lines.findIndex((line) => line.endsWith("--only steps-tracker-cron"));
  assert.ok([httpReload, sentinelCheck, resolutionReload, cronReload].every((index) => index >= 0));
  assert.ok(httpReload < sentinelCheck);
  assert.ok(sentinelCheck < resolutionReload);
  assert.ok(resolutionReload < cronReload);
});
