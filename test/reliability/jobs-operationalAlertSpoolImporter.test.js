const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BOOT_FILENAME_RE,
  createOperationalAlertSpool,
} = require("../../src/shared/operationalAlerts/operationalAlertSpool");
const { buildOperationalAlertSpoolImporter } = require("../../src/shared/operationalAlerts/operationalAlertSpoolImporter");

const BOOT1 = "11111111-1111-4111-8111-111111111111";
const BOOT2 = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";

test("cron importer waits for the next boot then durably admits and unlinks watchdog marker", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-import-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spool = createOperationalAlertSpool({ directory });
  spool.ensureDirectory();
  spool.writeIncident({
    schemaVersion: 1, alertType: "watchdog", bootId: BOOT1, attemptUuid: ATTEMPT,
    attemptId: `${BOOT1}:${ATTEMPT}`, environment: "production",
    observedAt: "2026-09-01T00:01:00.000Z", jobId: "job", raceId: "race", workerPid: 100,
  });
  const admitted = [];
  const importer = buildOperationalAlertSpoolImporter({
    spool, processRole: "cron", nodeEnv: "production",
    model: { async admit(value) { admitted.push(value); return { admitted: true }; } },
  });
  assert.equal(await importer(), 0);
  assert.equal(admitted.length, 0);

  spool.writeBoot({ bootId: BOOT2, pid: 101, bootedAt: "2026-09-01T00:01:01.000Z" });
  assert.equal(await importer(), 1);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].payload.previousPid, 100);
  assert.equal(admitted[0].payload.newPid, 101);
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith("v1-watchdog-")), false);
});

test("non-cron roles never inspect or import the spool", async () => {
  for (const processRole of ["http", "resolution", "all", "migration"]) {
    let admitted = 0;
    const run = buildOperationalAlertSpoolImporter({
      processRole,
      nodeEnv: "production",
      spool: { ensureDirectory() { throw new Error("must not inspect"); } },
      model: { async admit() { admitted += 1; } },
    });
    assert.equal(await run(), 0);
    assert.equal(admitted, 0);
  }
});

test("cron importer quarantines malformed marker names in a bounded same-directory pass", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-import-invalid-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "not-a-marker.json"), "{}\n", { mode: 0o600 });
  const spool = createOperationalAlertSpool({ directory });
  const run = buildOperationalAlertSpoolImporter({
    spool, processRole: "cron", nodeEnv: "production",
    model: { async admit() { throw new Error("must not admit malformed input"); } },
    logger: { log() {}, error() {} },
  });
  assert.equal(await run(), 0);
  const names = fs.readdirSync(directory);
  assert.equal(names.includes("not-a-marker.json"), false);
  assert.equal(names.filter((name) => name.startsWith(".quarantine-")).length, 1);
});

test("cron importer quarantines a validly-named marker whose contents do not match", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-import-invalid-body-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = `v1-watchdog-${BOOT1}-${ATTEMPT}.json`;
  fs.writeFileSync(path.join(directory, filename), JSON.stringify({
    schemaVersion: 1,
    alertType: "slow",
    bootId: BOOT1,
    attemptUuid: ATTEMPT,
    attemptId: `${BOOT1}:${ATTEMPT}`,
    environment: "production",
    observedAt: "2026-09-01T00:01:00.000Z",
    jobId: "job",
    raceId: "race",
    workerPid: 100,
  }), { mode: 0o600 });
  const spool = createOperationalAlertSpool({ directory });
  const run = buildOperationalAlertSpoolImporter({
    spool, processRole: "cron", nodeEnv: "production",
    model: { async admit() { throw new Error("must not admit invalid marker"); } },
    logger: { log() {}, error() {} },
  });
  assert.equal(await run(), 0);
  const names = fs.readdirSync(directory);
  assert.equal(names.includes(filename), false);
  assert.equal(names.filter((name) => name.startsWith(".quarantine-")).length, 1);
});

test("crafted boot marker name field cannot replace the safe directory entry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bara-import-boot-name-"));
  const directory = path.join(root, "spool");
  fs.mkdirSync(directory, { mode: 0o700 });
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "keep", { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bootFilename = `resolution-boot-v1-${BOOT2}.json`;
  fs.writeFileSync(path.join(directory, bootFilename), JSON.stringify({
    schemaVersion: 1,
    bootId: BOOT2,
    pid: 101,
    bootedAt: "2025-01-01T00:00:00.000Z",
    name: "../../outside.txt",
  }), { mode: 0o600 });
  const spool = createOperationalAlertSpool({ directory });
  const run = buildOperationalAlertSpoolImporter({
    spool, processRole: "cron", nodeEnv: "production",
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    model: { async admit() { throw new Error("must not admit boot marker"); } },
    logger: { log() {}, error() {} },
  });
  assert.equal(await run(), 0);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith(".quarantine-")), true);
});

test("cron importer reads at most one bounded marker batch per tick", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-import-bounded-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const realSpool = createOperationalAlertSpool({ directory });
  for (let index = 1; index <= 40; index += 1) {
    realSpool.writeBoot({
      bootId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      pid: 100 + index,
      bootedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
    });
  }
  let markerReads = 0;
  const spool = {
    ...realSpool,
    readMarkerFile(name) {
      markerReads += 1;
      return realSpool.readMarkerFile(name);
    },
  };
  const run = buildOperationalAlertSpoolImporter({
    spool, processRole: "cron", nodeEnv: "production",
    model: { async admit() { throw new Error("must not admit boot markers"); } },
    logger: { log() {}, error() {} },
  });

  assert.equal(await run(), 0);
  assert.ok(markerReads <= 25, `marker reads must be bounded, observed ${markerReads}`);
});

test("cron importer fsyncs a deletion-only old-boot cleanup tick", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-import-cleanup-sync-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const realSpool = createOperationalAlertSpool({ directory });
  realSpool.writeBoot({
    bootId: BOOT1,
    pid: 100,
    bootedAt: "2025-01-01T00:00:00.000Z",
  });
  let directorySyncs = 0;
  const spool = {
    ...realSpool,
    syncDirectory() {
      directorySyncs += 1;
      return realSpool.syncDirectory();
    },
  };
  const run = buildOperationalAlertSpoolImporter({
    spool,
    processRole: "cron",
    nodeEnv: "production",
    now: () => new Date("2026-09-02T00:00:00.000Z"),
    model: { async admit() { throw new Error("must not admit boot markers"); } },
    logger: { log() {}, error() {} },
  });

  assert.equal(await run(), 0);
  assert.equal(fs.readdirSync(directory).some((name) => BOOT_FILENAME_RE.test(name)), false);
  assert.equal(directorySyncs, 1);
});
