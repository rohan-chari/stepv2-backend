const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createLimaProvider } = require("../../../performance/providers/lima");
const { environmentRelevantPerformanceConfig, ownedRedisCommand,
  readReusableSnapshotMarker,
  requestTargetIdentity } = require("../../../performance/providers/lima-runtime");

test("prepared environment binding excludes per-run workload selection", () => {
  const shared = {
    schema: "bara-perf-config-v1",
    provider: { name: "lima", target: "capacity-vm" },
    topology: { httpWorkers: 2, resolutionWorkers: 1, cronWorkersNormal: 1 },
    background: { mode: "normal" },
    reset: { selectors: [{ table: "owned", column: "run_id", scope: "run" }] },
  };
  const home = environmentRelevantPerformanceConfig({ ...shared,
    workload: { name: "authenticated-home-reveal-v1" },
    thresholds: { homeP95Ms: 1000 },
    cache: { mode: "warm", raceListTargetMix: "calibration-required" },
  });
  const races = environmentRelevantPerformanceConfig({ ...shared,
    workload: { name: "authenticated-races-tab-reveal-v1" },
    thresholds: { racesCoreP95Ms: 1000 },
    cache: { mode: "warm", raceListTargetMix: { redis: 0.5 } },
  });
  assert.deepEqual(home, races);
  assert.equal(Object.hasOwn(home, "workload"), false);
  assert.equal(Object.hasOwn(home, "thresholds"), false);
});

test("Lima provider prepares one disposable environment and never recreates it between levels", async () => {
  const calls = [];
  const adapter = {
    prepareOnce: async () => (calls.push("prepareOnce"), {
      datasetId: "sanitized-test", binding: { code: "a", dataset: "b", hardware: "c" },
      baseUrl: "http://127.0.0.1:3000", databaseUrl: "postgresql://x@127.0.0.1/steps_tracker_capacity",
      runId: "bara-perf-environment", marker: { owner: "bara-perf", disposable: true },
      expectedRunId: "bara-perf-environment", expectedAddress: "127.0.0.1",
      resolvedAddresses: ["127.0.0.1"],
    }),
    validate: async () => (calls.push("validate"), { targetResponses: [{ status: 200,
      address: "127.0.0.1", body: { capacity: { runId: "bara-perf-environment" } } }] }),
    settle: async () => calls.push("settle"),
    liveness: async () => (calls.push("liveness"), { targetResponses: [{ status: 200,
      address: "127.0.0.1", body: { capacity: { runId: "bara-perf-environment" } } }] }),
    resetMetrics: async () => calls.push("resetMetrics"),
    collectMetrics: async () => (calls.push("collectMetrics"), {}),
    clearOwnedCache: async () => calls.push("clearOwnedCache"),
    verifyOwnedCacheEmpty: async () => calls.push("verifyOwnedCacheEmpty"),
    cleanup: async () => calls.push("cleanup"),
  };
  const provider = createLimaProvider({ adapter });
  const environment = await provider.prepare({ runId: "perf-run", cli: { target: "lima" }, config: {} });
  await provider.validate({ environment });
  for (let level = 0; level < 2; level += 1) {
    await provider.settle({ environment }); await provider.liveness({ environment });
    await provider.resetMetrics({ environment }); await provider.collectMetrics({ environment });
  }
  assert.equal(calls.filter((row) => row === "prepareOnce").length, 1);
  assert.equal(calls.some((row) => /restore|recreate/i.test(row)), false);
});

test("Lima provider validates traffic/database identity before delegating any load operation", async () => {
  let validated = false;
  const provider = createLimaProvider({ adapter: {
    prepareOnce: async () => ({ datasetId: "test", binding: {}, baseUrl: "https://steptracker-api.org",
      databaseUrl: "postgresql://x@127.0.0.1/steps_tracker_capacity",
      marker: { owner: "bara-perf", disposable: true }, runId: "capacity" }),
    validate: async () => { validated = true; },
  } });
  const environment = await provider.prepare({ runId: "perf-run", cli: { target: "lima" }, config: {} });
  await assert.rejects(provider.validate({ environment, cli: { target: "lima" } }), /production|staging/i);
  assert.equal(validated, false);
});

test("provider validates actual target identity and continuously rechecks it", async () => {
  const target = { status: 200, address: "127.0.0.1",
    body: { capacity: { runId: "owned-run" } } };
  let drifted = false;
  const adapter = {
    prepareOnce: async () => ({ baseUrl: "http://127.0.0.1:3000",
      databaseUrl: "postgresql://x@127.0.0.1/steps_tracker_capacity",
      marker: { owner: "bara-perf", disposable: true }, expectedRunId: "owned-run",
      expectedAddress: "127.0.0.1", resolvedAddresses: ["127.0.0.1"] }),
    validate: async () => ({ targetResponses: [target] }),
    liveness: async () => ({ targetResponses: [{ ...target,
      address: drifted ? "10.0.0.2" : "127.0.0.1" }] }),
  };
  const provider = createLimaProvider({ adapter });
  const environment = await provider.prepare({ cli: { target: "lima" } });
  await provider.validate({ environment });
  await provider.liveness({ environment });
  drifted = true;
  await assert.rejects(provider.liveness({ environment }), /address drift/i);
});

test("owned cache reset executes inside the labeled Lima Redis container", () => {
  const args = ownedRedisCommand({ instance: "step-capacity", container: "owned-redis",
    password: "secret", prefix: "capacity:child:", operation: "clear" });
  assert.deepEqual(args.slice(0, 7), ["shell", "step-capacity", "--", "docker", "exec",
    "-e", "REDISCLI_AUTH=secret"]);
  assert.equal(args.includes("owned-redis"), true);
  assert.equal(args.includes("capacity:child:"), true);
  assert.throws(() => ownedRedisCommand({ instance: "step-capacity", container: "owned-redis",
    password: "secret", prefix: "other:", operation: "clear" }), /prefix/i);
});

test("target identity request exposes the actual socket address and never follows redirects", async (context) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/health" }); response.end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ capacity: { runId: "owned-run" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await requestTargetIdentity(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.address, "127.0.0.1");
  assert.equal(health.body.capacity.runId, "owned-run");
  const redirect = await requestTargetIdentity(`${base}/redirect`);
  assert.equal(redirect.status, 302);
});

test("unchanged prepared-environment check reads persisted markers without hashing dump bytes", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-perf-marker-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dump = path.join(directory, "snapshot.dump");
  fs.writeFileSync(dump, "bytes deliberately not matching recorded digest");
  const metadata = path.join(directory, "metadata.json");
  fs.writeFileSync(metadata, JSON.stringify({ schema: "capacity-snapshot-v1",
    sourceSnapshotPath: dump, sourceSnapshotHash: "f".repeat(64), snapshotHash: "a".repeat(64),
    scrubAttestationPath: "attestation.json" }));
  fs.writeFileSync(path.join(directory, "attestation.json"), JSON.stringify({
    schema: "capacity-scrub-attestation-v1", snapshotHash: "f".repeat(64), status: "passed" }));
  const marker = readReusableSnapshotMarker({ snapshot: metadata });
  assert.deepEqual({ snapshotHash: marker.snapshotHash, sourceSnapshotHash: marker.sourceSnapshotHash,
    attestationStatus: marker.attestationStatus }, {
    snapshotHash: "a".repeat(64), sourceSnapshotHash: "f".repeat(64),
    attestationStatus: "passed",
  });
});
