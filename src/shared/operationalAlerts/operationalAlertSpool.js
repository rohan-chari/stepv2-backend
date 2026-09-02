const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DIRECTORY = "/var/lib/step-tracker/operational-alert-spool";
const MAX_MARKER_BYTES = 8 * 1024;
const MAX_MARKERS = 1_000;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);
const INCIDENT_FILENAME_RE = new RegExp(`^v1-(slow|watchdog)-(${UUID_PATTERN})-(${UUID_PATTERN})\\.json$`);
const BOOT_FILENAME_RE = new RegExp(`^resolution-boot-v1-(${UUID_PATTERN})\\.json$`);
const BOOT_FIELDS = new Set(["schemaVersion", "bootId", "pid", "bootedAt"]);

const INCIDENT_FIELDS = new Set([
  "schemaVersion", "alertType", "bootId", "attemptUuid", "attemptId",
  "environment", "observedAt", "jobId", "raceId", "leaseExpiresAt",
  "activePhase", "parentPhase", "phaseElapsedMs", "attemptElapsedMs",
  "queueLagMs", "workLaneActive", "workLaneQueuedCore", "workLaneQueuedPost",
  "expiredLeaseCount", "workerPid", "lastCompletedPhase",
  "authoritativeCommitCompleted",
]);

function assertPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("operational alert marker must be an object");
  }
}

function isCanonicalIsoInstant(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validateBootMarker(marker) {
  assertPlainObject(marker);
  const keys = Object.keys(marker);
  if (keys.length !== BOOT_FIELDS.size || keys.some((key) => !BOOT_FIELDS.has(key))) {
    throw new Error("unexpected field in resolution boot marker");
  }
  if (marker.schemaVersion !== 1) throw new Error("unsupported resolution boot marker schema");
  if (!UUID_RE.test(marker.bootId || "")) throw new Error("invalid boot id");
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0) throw new Error("invalid boot pid");
  if (!isCanonicalIsoInstant(marker.bootedAt)) throw new Error("invalid boot time");
  return true;
}

function validateIncidentMarker(marker) {
  assertPlainObject(marker);
  for (const key of Object.keys(marker)) {
    if (!INCIDENT_FIELDS.has(key)) throw new Error(`unexpected field in operational alert marker: ${key}`);
  }
  if (marker.schemaVersion !== 1) throw new Error("unsupported operational alert marker schema");
  if (marker.alertType !== "slow" && marker.alertType !== "watchdog") {
    throw new Error("invalid operational alert type");
  }
  if (!UUID_RE.test(marker.bootId || "")) throw new Error("invalid boot id");
  if (!UUID_RE.test(marker.attemptUuid || "")) throw new Error("invalid attempt uuid");
  if (marker.attemptId !== `${marker.bootId}:${marker.attemptUuid}`) {
    throw new Error("attempt id does not match marker identity");
  }
  if (typeof marker.environment !== "string" || marker.environment.length === 0) {
    throw new Error("invalid operational alert environment");
  }
  if (!isCanonicalIsoInstant(marker.observedAt)) throw new Error("invalid observed time");
  if (typeof marker.jobId !== "string" || marker.jobId.length === 0) throw new Error("invalid job id");
  if (typeof marker.raceId !== "string" || marker.raceId.length === 0) throw new Error("invalid race id");
  if (!Number.isSafeInteger(marker.workerPid) || marker.workerPid <= 0) {
    throw new Error("invalid worker pid");
  }
  if (marker.leaseExpiresAt != null && !isCanonicalIsoInstant(marker.leaseExpiresAt)) {
    throw new Error("invalid lease expiry time");
  }
  for (const [key, value] of Object.entries(marker)) {
    if (value == null) continue;
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`non-scalar operational alert field: ${key}`);
    }
    if (typeof value === "string" && (value.includes("/") || value.includes("\\"))) {
      throw new Error(`path separator in operational alert field: ${key}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`non-finite operational alert field: ${key}`);
    }
  }
  return true;
}

function sanitizeIncidentMarker(input) {
  const workBudget = input.workBudget || {};
  const [bootId, attemptUuid] = String(input.attemptId || ":").split(":");
  const marker = {
    schemaVersion: 1,
    alertType: input.alertType,
    bootId: input.bootId || bootId,
    attemptUuid: input.attemptUuid || attemptUuid,
    attemptId: input.attemptId,
    environment: input.environment || "unknown",
    observedAt: input.observedAt,
    jobId: input.jobId || null,
    raceId: input.raceId || null,
    leaseExpiresAt: input.leaseExpiresAt || null,
    activePhase: input.activePhase || null,
    parentPhase: input.parentPhase || null,
    phaseElapsedMs: Number(input.phaseElapsedMs || 0),
    attemptElapsedMs: Number(input.attemptElapsedMs || 0),
    queueLagMs: Number(input.queueLagMs || 0),
    workLaneActive: Number(workBudget.active ?? input.workLaneActive ?? 0),
    workLaneQueuedCore: Number(workBudget.queuedCore ?? input.workLaneQueuedCore ?? 0),
    workLaneQueuedPost: Number(workBudget.queuedPost ?? input.workLaneQueuedPost ?? 0),
    expiredLeaseCount: input.expiredLeaseCount == null ? null : Number(input.expiredLeaseCount),
    workerPid: Number(input.workerPid || process.pid),
    lastCompletedPhase: input.lastCompletedPhase || null,
    authoritativeCommitCompleted: input.authoritativeCommitCompleted === true,
  };
  if (Buffer.byteLength(`${JSON.stringify(marker)}\n`, "utf8") > MAX_MARKER_BYTES) {
    throw new Error("operational alert marker exceeds 8 KiB");
  }
  validateIncidentMarker(marker);
  return marker;
}

function createOperationalAlertSpool({ directory = DEFAULT_DIRECTORY, fsModule = fs } = {}) {
  const noFollow = fsModule.constants.O_NOFOLLOW || 0;

  function ensureDirectory() {
    fsModule.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fsModule.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("operational alert spool is not a directory");
    fsModule.chmodSync(directory, 0o700);
  }

  function syncDirectory() {
    const fd = fsModule.openSync(directory, fsModule.constants.O_RDONLY | noFollow);
    try { fsModule.fsyncSync(fd); } finally { fsModule.closeSync(fd); }
  }

  function atomicWrite(filename, payload) {
    ensureDirectory();
    if (path.basename(filename) !== filename || filename.includes("/") || filename.includes("\\")) {
      throw new Error("invalid operational alert marker filename");
    }
    if (fsModule.readdirSync(directory).length >= MAX_MARKERS) {
      const error = new Error("operational alert spool is full");
      error.code = "SPOOL_FULL";
      throw error;
    }
    const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    if (body.length > MAX_MARKER_BYTES) throw new Error("operational alert marker exceeds 8 KiB");
    const finalPath = path.join(directory, filename);
    if (fsModule.existsSync(finalPath)) throw new Error("operational alert marker already exists");
    const temporary = path.join(directory, `.tmp-${process.pid}-${crypto.randomUUID()}`);
    const fd = fsModule.openSync(
      temporary,
      fsModule.constants.O_CREAT | fsModule.constants.O_EXCL | fsModule.constants.O_WRONLY | noFollow,
      0o600
    );
    try {
      const written = fsModule.writeSync(fd, body, 0, body.length, null);
      if (written !== body.length) throw new Error("short operational alert marker write");
      fsModule.fsyncSync(fd);
    } finally {
      fsModule.closeSync(fd);
    }
    try {
      fsModule.renameSync(temporary, finalPath);
      fsModule.chmodSync(finalPath, 0o600);
      syncDirectory();
    } catch (error) {
      try { fsModule.unlinkSync(temporary); } catch (_) {}
      throw error;
    }
    return filename;
  }

  function writeIncident(input) {
    const marker = sanitizeIncidentMarker(input);
    return atomicWrite(
      `v1-${marker.alertType}-${marker.bootId}-${marker.attemptUuid}.json`,
      marker
    );
  }

  function writeBoot({ bootId, pid, bootedAt }) {
    const marker = {
      schemaVersion: 1,
      bootId,
      pid: Number(pid),
      bootedAt,
    };
    validateBootMarker(marker);
    return atomicWrite(`resolution-boot-v1-${bootId}.json`, marker);
  }

  function readMarkerFile(filename) {
    if (!INCIDENT_FILENAME_RE.test(filename) && !BOOT_FILENAME_RE.test(filename)) {
      throw new Error("invalid operational alert marker filename");
    }
    const fullPath = path.join(directory, filename);
    const stat = fsModule.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("marker is not a regular file or is a symlink");
    if (stat.nlink !== 1) throw new Error("operational alert marker is a hard link");
    if (stat.size > MAX_MARKER_BYTES) throw new Error("operational alert marker exceeds 8 KiB");
    const fd = fsModule.openSync(fullPath, fsModule.constants.O_RDONLY | noFollow);
    try {
      // Re-check the opened inode so a rename between lstat/open cannot swap in
      // a symlink target, hard link, or oversized file after validation.
      const opened = fsModule.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new Error("opened operational alert marker is not a regular single-link file");
      }
      if (opened.size > MAX_MARKER_BYTES) {
        throw new Error("operational alert marker exceeds 8 KiB");
      }
      const marker = JSON.parse(fsModule.readFileSync(fd, "utf8"));
      const incidentMatch = filename.match(INCIDENT_FILENAME_RE);
      const bootMatch = filename.match(BOOT_FILENAME_RE);
      if (incidentMatch) {
        validateIncidentMarker(marker);
        if (
          marker.alertType !== incidentMatch[1] ||
          marker.bootId !== incidentMatch[2] ||
          marker.attemptUuid !== incidentMatch[3]
        ) {
          throw new Error("operational alert filename does not match contents identity");
        }
      } else if (bootMatch) {
        validateBootMarker(marker);
        if (marker.bootId !== bootMatch[1]) {
          throw new Error("resolution boot filename does not match contents identity");
        }
      }
      return marker;
    } finally {
      fsModule.closeSync(fd);
    }
  }

  return { directory, ensureDirectory, writeIncident, writeBoot, readMarkerFile, syncDirectory };
}

module.exports = {
  DEFAULT_DIRECTORY,
  MAX_MARKER_BYTES,
  MAX_MARKERS,
  createOperationalAlertSpool,
  validateIncidentMarker,
  validateBootMarker,
  sanitizeIncidentMarker,
  INCIDENT_FILENAME_RE,
  BOOT_FILENAME_RE,
};
