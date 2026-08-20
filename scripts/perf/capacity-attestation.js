const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  capacityAuthSecret,
  capacityIdentity,
} = require("../../src/localCapacitySafety");

const ATTESTATION_SCHEMA = "capacity-worker-attestation-v1";
const WORKER_INSTANCE_RE = /^(0|[1-9]\d?)$/;
const COMMIT_RE = /^[a-f0-9]{40,64}$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function effectiveEnvironmentSha256(env = process.env) {
  const filePath = env.CAPACITY_EFFECTIVE_ENV_PATH;
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new Error("CAPACITY_EFFECTIVE_ENV_PATH must be absolute for attestation");
  }
  return sha256(fs.readFileSync(filePath));
}

function checkoutCommitSha(env = process.env) {
  const checkout = path.resolve(__dirname, "../..");
  let commitSha;
  try {
    commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().toLowerCase();
  } catch {
    throw new Error("capacity checkout commit could not be resolved");
  }
  if (!COMMIT_RE.test(commitSha)) {
    throw new Error("capacity checkout commit is not a full SHA");
  }
  const expected = String(env.CAPACITY_EXPECTED_COMMIT_SHA || "")
    .trim()
    .toLowerCase();
  if (expected && (!COMMIT_RE.test(expected) || expected !== commitSha)) {
    throw new Error("capacity checkout commit does not match CAPACITY_EXPECTED_COMMIT_SHA");
  }
  return commitSha;
}

function attestationDirectory(env = process.env, { create = false } = {}) {
  const directory = env.CAPACITY_ATTESTATION_DIR;
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error("CAPACITY_ATTESTATION_DIR must be an absolute path");
  }
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) throw new Error("CAPACITY_ATTESTATION_DIR must be a directory");
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("capacity attestation directory must not be group/world accessible");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("capacity attestation directory must be owned by the current user");
  }
  return directory;
}

function workerInstance(env = process.env) {
  const value = String(env.NODE_APP_INSTANCE || "");
  if (!WORKER_INSTANCE_RE.test(value)) {
    throw new Error("NODE_APP_INSTANCE must identify a capacity PM2 worker");
  }
  return value;
}

function runtimeFingerprint({ runId, commitSha, effectiveEnvSha256, workerInstance: instance }) {
  return sha256([
    ATTESTATION_SCHEMA,
    runId,
    commitSha,
    effectiveEnvSha256,
    instance,
  ].join("\0"));
}

function signedPayload(payload, env = process.env) {
  return crypto
    .createHmac("sha256", capacityAuthSecret(env))
    .update(JSON.stringify(payload))
    .digest("hex");
}

function buildWorkerAttestation(env = process.env) {
  const { runId } = capacityIdentity(env);
  const instance = workerInstance(env);
  const commitSha = checkoutCommitSha(env);
  const envSha = effectiveEnvironmentSha256(env);
  const payload = {
    schemaVersion: ATTESTATION_SCHEMA,
    runId,
    workerInstance: instance,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    commitSha,
    effectiveEnvSha256: envSha,
    runtimeFingerprint: runtimeFingerprint({
      runId,
      commitSha,
      effectiveEnvSha256: envSha,
      workerInstance: instance,
    }),
    entrypoint: "capacity-server.js",
  };
  return { ...payload, signature: signedPayload(payload, env) };
}

function writeWorkerAttestation(env = process.env) {
  const directory = attestationDirectory(env, { create: true });
  const attestation = buildWorkerAttestation(env);
  const output = path.join(directory, `worker-${attestation.workerInstance}.json`);
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(attestation)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, output);
  fs.chmodSync(output, 0o600);
  return { output, attestation };
}

function removeOwnWorkerAttestation(output, pid = process.pid) {
  try {
    const current = JSON.parse(fs.readFileSync(output, "utf8"));
    if (current.pid === pid) fs.unlinkSync(output);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(`${JSON.stringify({
        event: "capacity_worker_attestation_cleanup_failed",
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
    }
  }
}

function verifySignature(document, env = process.env) {
  const { signature, ...payload } = document;
  if (!/^[a-f0-9]{64}$/.test(String(signature || ""))) return false;
  const expected = signedPayload(payload, env);
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

function processCommand(pid) {
  const procPath = `/proc/${pid}/cmdline`;
  try {
    if (fs.existsSync(procPath)) {
      return fs.readFileSync(procPath, "utf8").replaceAll("\0", " ");
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function attestWorkers({ expectedWorkers, env = process.env }) {
  const directory = attestationDirectory(env);
  const { runId } = capacityIdentity(env);
  const commitSha = checkoutCommitSha(env);
  const envSha = effectiveEnvironmentSha256(env);
  const expectedInstances = Array.from(
    { length: expectedWorkers },
    (_, index) => String(index),
  );
  const observedInstances = fs.readdirSync(directory)
    .map((name) => name.match(/^worker-(0|[1-9]\d?)\.json$/)?.[1] || null)
    .filter(Boolean)
    .sort((left, right) => Number(left) - Number(right));
  if (
    observedInstances.length !== expectedInstances.length ||
    observedInstances.some((instance, index) => instance !== expectedInstances[index])
  ) {
    throw new Error("capacity worker attestation set does not match expected workers");
  }
  const workers = expectedInstances.map((instance) => {
    const file = path.join(directory, `worker-${instance}.json`);
    let document;
    try {
      document = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`capacity worker ${instance} attestation is missing or unreadable`);
    }
    const authenticated = verifySignature(document, env);
    let live = false;
    try {
      process.kill(Number(document.pid), 0);
      live = true;
    } catch {
      live = false;
    }
    const command = live ? processCommand(Number(document.pid)) : "";
    const capacityEntrypoint =
      command.includes("capacity-server.js") ||
      command.includes(`steptracker-capacity-worker-${instance}`);
    const expectedFingerprint = runtimeFingerprint({
      runId,
      commitSha,
      effectiveEnvSha256: envSha,
      workerInstance: instance,
    });
    const matchesRuntime =
      document.schemaVersion === ATTESTATION_SCHEMA &&
      document.runId === runId &&
      document.workerInstance === instance &&
      document.commitSha === commitSha &&
      document.effectiveEnvSha256 === envSha &&
      document.runtimeFingerprint === expectedFingerprint &&
      document.entrypoint === "capacity-server.js";
    if (!authenticated || !live || !capacityEntrypoint || !matchesRuntime) {
      throw new Error(`capacity worker ${instance} runtime attestation failed`);
    }
    return {
      workerInstance: instance,
      pid: Number(document.pid),
      startedAt: document.startedAt,
      commitSha,
      effectiveEnvSha256: envSha,
      runtimeFingerprint: expectedFingerprint,
      authenticated,
      live,
      capacityEntrypoint,
      matchesRuntime,
    };
  });
  if (new Set(workers.map((worker) => worker.pid)).size !== workers.length) {
    throw new Error("capacity worker attestations do not identify distinct processes");
  }
  return {
    schemaVersion: ATTESTATION_SCHEMA,
    runId,
    expectedWorkers,
    observedWorkers: observedInstances.length,
    commitSha,
    effectiveEnvSha256: envSha,
    authenticated: workers.every((worker) => worker.authenticated),
    allLive: workers.every((worker) => worker.live),
    allMatched: workers.every((worker) => worker.matchesRuntime),
    workers,
  };
}

module.exports = {
  ATTESTATION_SCHEMA,
  attestWorkers,
  buildWorkerAttestation,
  checkoutCommitSha,
  effectiveEnvironmentSha256,
  removeOwnWorkerAttestation,
  runtimeFingerprint,
  writeWorkerAttestation,
};
