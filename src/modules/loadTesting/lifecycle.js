const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const {
  assertSnapshotAttestation,
  compareLiveManifest,
  confirmCapacityStart,
  manifestLines,
  snapshotManifestHash,
} = require("./safety");

const execFileAsync = promisify(execFile);
const DEFAULT_STATE_DIR = path.resolve(process.env.CAPACITY_STATE_DIR || path.join(process.cwd(), "results", "capacity"));

function stateDir(directory = DEFAULT_STATE_DIR) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory; }
function statePath(runId, directory) { return path.join(stateDir(directory), `${runId}.json`); }
function lockPath(runId, directory) { return path.join(stateDir(directory), `${runId}.lock`); }
function safeRunId(runId) { if (!/^[a-z0-9][a-z0-9._-]{5,63}$/.test(runId || "")) throw new Error("runId must be 6-64 lowercase safe characters"); return runId; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function sha256File(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function writeJson(file, value) { const temp = `${file}.tmp-${process.pid}`; fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "w" }); fs.renameSync(temp, file); }

function readSnapshot(snapshotPath, { requireAttestation = true } = {}) {
  if (!snapshotPath || !path.isAbsolute(snapshotPath)) throw new Error("verified snapshot path must be absolute");
  const snapshot = readJson(snapshotPath);
  if (snapshot.schema !== "capacity-snapshot-v1" || !snapshot.approvedManifest) throw new Error("verified snapshot must use capacity-snapshot-v1 and contain an approved manifest");
  const computed = snapshotManifestHash(snapshot.approvedManifest);
  if (snapshot.snapshotHash !== computed && snapshot.snapshotHash !== snapshot.sourceSnapshotHash) throw new Error("snapshot hash does not match the approved manifest or source snapshot");
  if (!snapshot.sourceSnapshotPath || !path.isAbsolute(snapshot.sourceSnapshotPath) || !fs.existsSync(snapshot.sourceSnapshotPath)) throw new Error("snapshot source bytes are required for capacity preflight");
  if (snapshot.sourceSnapshotHash !== sha256File(snapshot.sourceSnapshotPath)) throw new Error("snapshot hash does not match source snapshot bytes");
  for (const section of ["vps", "database", "redis", "network", "backend", "queue"]) if (!snapshot.approvedManifest[section]) throw new Error(`approved manifest is missing ${section}`);
  const attestationPath = snapshot.scrubAttestationPath && path.resolve(path.dirname(snapshotPath), snapshot.scrubAttestationPath);
  if (!attestationPath || !fs.existsSync(attestationPath)) {
    if (requireAttestation) throw new Error("snapshot-bound scrub attestation is missing");
    return { ...snapshot, snapshotPath, attestationPath };
  }
  const attestation = readJson(attestationPath);
  const verified = assertSnapshotAttestation({ manifest: { snapshotHash: snapshot.snapshotHash }, attestation, secret: process.env.CAPACITY_SCRUB_ATTESTATION_SECRET });
  if (attestation.snapshotHash !== snapshot.sourceSnapshotHash) throw new Error("scrub attestation is not bound to source snapshot bytes");
  if (snapshot.scrubScriptPath) {
    if (!path.isAbsolute(snapshot.scrubScriptPath) || !fs.existsSync(snapshot.scrubScriptPath) || sha256File(snapshot.scrubScriptPath) !== attestation.scrubScriptHash) throw new Error("scrub script hash does not match the attested scrub script");
  }
  return { ...snapshot, snapshotPath, attestationPath, attestation, attestationVerification: verified };
}

async function withRunLock(runId, directory, operation) {
  safeRunId(runId);
  const file = lockPath(runId, directory);
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); fs.writeSync(fd, `${process.pid}\n`); return await operation(); }
  catch (error) { if (error?.code === "EEXIST") throw new Error(`capacity run ${runId} is locked by another operation`); throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}

function loadState(runId, directory) { safeRunId(runId); const file = statePath(runId, directory); if (!fs.existsSync(file)) throw new Error(`capacity run ${runId} does not exist`); return readJson(file); }
function saveState(state, directory) { writeJson(statePath(state.runId, directory), state); return state; }

function assertCapacityRunProfile(state, expectedProfile) {
  if (!expectedProfile || state?.profile !== expectedProfile) {
    throw new Error(`capacity run profile mismatch: ${state?.profile || "missing"} started, ${expectedProfile || "missing"} requested`);
  }
  return true;
}

async function preflight({ snapshotPath, profile, target = "capacity-vm", directory, runId }) {
  if (target !== "capacity-vm") throw new Error("capacity preflight requires target capacity-vm");
  safeRunId(runId);
  const snapshot = readSnapshot(snapshotPath, { requireAttestation: false });
  const state = { schema: "capacity-run-state-v1", state: "verified", target, profile, snapshotPath: snapshot.snapshotPath, sourceSnapshotPath: snapshot.sourceSnapshotPath, sourceSnapshotHash: snapshot.sourceSnapshotHash, scrubScriptPath: snapshot.scrubScriptPath, scrubAttestationPath: snapshot.attestationPath, snapshotHash: snapshot.snapshotHash, scrubAttestationHash: snapshot.attestationVerification?.attestationHash || null, approvedManifest: snapshot.approvedManifest, verifiedAt: new Date().toISOString() };
  saveState({ ...state, runId: `verified-${runId || snapshot.snapshotHash.slice(0, 12)}`, capacityRunId: runId || null }, directory);
  return state;
}

async function restore({ runId, directory, snapshotPath, env = process.env }) {
  return withRunLock(runId, directory, async () => {
    const existingFile = statePath(runId, directory);
    if (fs.existsSync(existingFile)) {
      const existing = readJson(existingFile);
      if (["restored", "started", "stopped", "destroyed"].includes(existing.state)) return existing;
      throw new Error(`capacity run ${runId} cannot be restored from state ${existing.state}`);
    }
    const verifiedFile = path.join(stateDir(directory), `verified-${runId}.json`);
    const verified = fs.existsSync(verifiedFile) ? readJson(verifiedFile) : null;
    if (!verified) throw new Error("capacity restore requires a successful capacity preflight");
    if (verified.capacityRunId && verified.capacityRunId !== runId) throw new Error("capacity preflight run does not match restore run");
    if (snapshotPath && path.resolve(snapshotPath) !== path.resolve(verified.snapshotPath)) throw new Error("restore snapshot differs from the verified preflight snapshot");
    const sourceEnv = {
      CAPACITY_RUN_ID: runId,
      CAPACITY_SNAPSHOT_PATH: verified.sourceSnapshotPath,
      CAPACITY_SNAPSHOT_METADATA_PATH: verified.snapshotPath,
      CAPACITY_SCRUB_ATTESTATION_PATH: verified.scrubAttestationPath,
    };
    const restoreHook = await runHook("restore", env, sourceEnv, true);
    const scrubHook = await runHook("scrub", env, sourceEnv, true);
    const refreshed = readSnapshot(verified.snapshotPath);
    const state = { ...verified, ...refreshed, runId, state: "restored", restoredAt: new Date().toISOString(), operationTimeoutSeconds: 300, restoreHook, scrubHook };
    return saveState(state, directory);
  });
}

async function runHook(name, env = process.env, extraEnv = {}, required = false) {
  const hookByName = {
    restore: env.CAPACITY_RESTORE_HOOK,
    scrub: env.CAPACITY_SCRUB_HOOK,
    start: env.CAPACITY_START_HOOK,
    stop: env.CAPACITY_STOP_HOOK,
    destroy: env.CAPACITY_DESTROY_HOOK,
  };
  const command = String(hookByName[name] || "").trim();
  if (!command) {
    if (required) throw new Error(`capacity ${name} requires CAPACITY_${name.toUpperCase()}_HOOK`);
    return { hookConfigured: false, completed: true };
  }
  await execFileAsync("sh", ["-c", command], { timeout: 600000, windowsHide: true, env: { ...env, ...extraEnv } });
  return { hookConfigured: true, completed: true };
}

async function probeHealth(url, timeoutMs = 10000, expected = {}) {
  if (!url) throw new Error("CAPACITY_HEALTH_URL is required for capacity start health verification");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`capacity health probe returned HTTP ${response.status}`);
    const body = await response.json();
    if (body?.capacity?.runId !== expected.runId ||
        body?.capacity?.globalEventProfile !== expected.profile) {
      throw new Error("capacity health identity does not match the guarded run id/profile");
    }
    return {
      url: new URL(url).origin,
      status: response.status,
      runId: body.capacity.runId,
      profile: body.capacity.globalEventProfile,
    };
  } finally { clearTimeout(timer); }
}

async function start({ runId, directory, env = process.env, input, interactive = false, liveManifestPath = env.CAPACITY_LIVE_MANIFEST_PATH, output = process.stdout }) {
  return withRunLock(runId, directory, async () => {
    const state = loadState(runId, directory);
    if (!["restored", "started", "stopped"].includes(state.state)) throw new Error(`capacity run ${runId} cannot start from state ${state.state}`);
    const attestation = assertSnapshotAttestation({ manifest: { snapshotHash: state.snapshotHash }, attestation: readJson(state.scrubAttestationPath || state.attestationPath), secret: env.CAPACITY_SCRUB_ATTESTATION_SECRET });
    if (!liveManifestPath || !path.isAbsolute(liveManifestPath) || !fs.existsSync(liveManifestPath)) throw new Error("live capacity manifest is required for start drift checks");
    const live = readJson(liveManifestPath);
    const drift = compareLiveManifest(state.approvedManifest, live);
    if (!drift.ok) throw new Error(`capacity manifest drift detected: ${drift.differences.map((item) => item.path).join(", ")}`);
    for (const line of manifestLines(state.approvedManifest)) output.write(`${line}\n`);
    const confirmation = confirmCapacityStart({ runId, snapshotHash: state.snapshotHash, manifest: state.approvedManifest, input, interactive });
    const hook = await runHook("start", env);
    if (!hook.hookConfigured) throw new Error("capacity start requires CAPACITY_START_HOOK to start the VM/application");
    const health = await probeHealth(env.CAPACITY_HEALTH_URL, 10000, {
      runId,
      profile: state.profile,
    });
    const next = { ...state, state: "started", startedAt: new Date().toISOString(), liveManifestPath, scrubAttestationHash: attestation.attestationHash, startHook: hook, health, reconfirmedAt: state.state === "started" ? new Date().toISOString() : undefined };
    return saveState(next, directory);
  });
}

async function stop({ runId, directory, env = process.env }) {
  return withRunLock(runId, directory, async () => {
    const state = loadState(runId, directory);
    if (["stopped", "destroyed"].includes(state.state)) return state;
    if (state.state !== "started") throw new Error(`capacity run ${runId} cannot stop from state ${state.state}`);
    const hook = await runHook("stop", env, {}, true);
    return saveState({ ...state, state: "stopped", stoppedAt: new Date().toISOString(), stopHook: hook }, directory);
  });
}

async function destroy({ runId, directory, env = process.env }) {
  return withRunLock(runId, directory, async () => {
    const state = loadState(runId, directory);
    if (state.state === "destroyed") return state;
    if (!["stopped", "restored", "started"].includes(state.state)) throw new Error(`capacity run ${runId} cannot destroy from state ${state.state}`);
    const hook = await runHook("destroy", env, {}, true);
    return saveState({ ...state, state: "destroyed", destroyedAt: new Date().toISOString(), destroyHook: hook }, directory);
  });
}

function status({ runId, directory }) { return loadState(runId, directory); }

function assertStartedRun({ runId, directory, env = process.env }) {
  const state = loadState(runId, directory);
  if (state.state !== "started") throw new Error(`capacity run ${runId} must be started before load traffic (state: ${state.state})`);
  if (!state.snapshotHash || !state.scrubAttestationHash || !state.liveManifestPath) {
    throw new Error("capacity run is missing snapshot, scrub attestation, or live-manifest verification");
  }
  const attestation = readJson(state.scrubAttestationPath);
  const verified = assertSnapshotAttestation({ manifest: { snapshotHash: state.snapshotHash }, attestation, secret: env.CAPACITY_SCRUB_ATTESTATION_SECRET });
  if (verified.attestationHash !== state.scrubAttestationHash) throw new Error("capacity scrub attestation changed after start verification");
  return state;
}

module.exports = { DEFAULT_STATE_DIR, assertCapacityRunProfile, assertStartedRun, destroy, loadState, preflight, readSnapshot, restore, start, stateDir, status, stop, withRunLock };
