const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createOperationalAlertSpool,
  validateIncidentMarker,
} = require("../../src/shared/operationalAlerts/operationalAlertSpool");

const BOOT_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";

test("operational alert spool atomically writes bounded private markers", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-alert-spool-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spool = createOperationalAlertSpool({ directory });
  spool.ensureDirectory();
  const filename = spool.writeIncident({
    schemaVersion: 1,
    alertType: "watchdog",
    bootId: BOOT_ID,
    attemptUuid: ATTEMPT_ID,
    attemptId: `${BOOT_ID}:${ATTEMPT_ID}`,
    environment: "production",
    observedAt: "2026-09-01T00:01:00.000Z",
    jobId: "job-id",
    raceId: "race-id",
    workerPid: 123,
    authoritativeCommitCompleted: false,
  });

  assert.equal(filename, `v1-watchdog-${BOOT_ID}-${ATTEMPT_ID}.json`);
  const stat = fs.lstatSync(path.join(directory, filename));
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(directory).some((name) => name.includes(".tmp")), false);
  assert.equal(validateIncidentMarker(JSON.parse(fs.readFileSync(path.join(directory, filename)))), true);
});

test("spool rejects privacy leaks, oversized markers, symlinks, and hard links", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-alert-spool-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spool = createOperationalAlertSpool({ directory });
  spool.ensureDirectory();
  assert.throws(() => validateIncidentMarker({ schemaVersion: 1, alertType: "slow", displayName: "Shar" }), /unexpected field/);
  assert.throws(() => spool.writeIncident({ schemaVersion: 1, alertType: "slow", bootId: BOOT_ID, attemptUuid: ATTEMPT_ID, attemptId: `${BOOT_ID}:${ATTEMPT_ID}`, environment: "production", observedAt: "x".repeat(9000) }), /8 KiB/);

  const target = path.join(directory, "target.json");
  fs.writeFileSync(target, "{}", { mode: 0o600 });
  const symlink = path.join(directory, `v1-slow-${BOOT_ID}-${ATTEMPT_ID}.json`);
  fs.symlinkSync(target, symlink);
  assert.throws(() => spool.readMarkerFile(path.basename(symlink)), /regular file|symlink/);
  fs.unlinkSync(symlink);
  fs.linkSync(target, symlink);
  assert.throws(() => spool.readMarkerFile(path.basename(symlink)), /hard link/);
});

test("boot marker is immutable and uses the same atomic protocol", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-alert-spool-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spool = createOperationalAlertSpool({ directory });
  spool.ensureDirectory();
  const filename = spool.writeBoot({ bootId: BOOT_ID, pid: 456, bootedAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(filename, `resolution-boot-v1-${BOOT_ID}.json`);
  assert.throws(() => spool.writeBoot({ bootId: BOOT_ID, pid: 789, bootedAt: "2026-09-01T00:00:01.000Z" }), /exists/);
});

test("marker contents must carry complete identity and match their filename", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-alert-spool-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spool = createOperationalAlertSpool({ directory });
  spool.ensureDirectory();

  assert.throws(() => validateIncidentMarker({
    schemaVersion: 1,
    alertType: "slow",
    environment: "production",
    observedAt: "2026-09-01T00:00:30.000Z",
  }), /boot id|attempt uuid|attempt id/i);

  const filename = `v1-watchdog-${BOOT_ID}-${ATTEMPT_ID}.json`;
  fs.writeFileSync(path.join(directory, filename), JSON.stringify({
    schemaVersion: 1,
    alertType: "slow",
    bootId: BOOT_ID,
    attemptUuid: ATTEMPT_ID,
    attemptId: `${BOOT_ID}:${ATTEMPT_ID}`,
    environment: "production",
    observedAt: "2026-09-01T00:01:00.000Z",
    jobId: "job",
    raceId: "race",
    workerPid: 123,
  }), { mode: 0o600 });
  assert.throws(() => spool.readMarkerFile(filename), /filename.*contents|identity/i);

  const bootFilename = `resolution-boot-v1-${BOOT_ID}.json`;
  fs.writeFileSync(path.join(directory, bootFilename), JSON.stringify({
    schemaVersion: 1,
    bootId: ATTEMPT_ID,
    pid: 0,
    bootedAt: "not-a-time",
  }), { mode: 0o600 });
  assert.throws(() => spool.readMarkerFile(bootFilename), /boot/i);
});
