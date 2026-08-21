const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildResult, classifyTarget, parseLoadParameters, PROFILES } = require("./contract");
const { createSyntheticFixtures, cleanupSyntheticRun } = require("./fixtures");
const { assertStartedRun } = require("./lifecycle");

function uuidFor(runId, userIndex, sequence) {
  const hex = crypto.createHash("sha256").update(`${runId}:${userIndex}:${sequence}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
function sleep(ms, signal) { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); if (signal) { if (signal.aborted) { clearTimeout(timer); reject(new Error("load run interrupted")); } else signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("load run interrupted")); }, { once: true }); } }); }
function replaceTemplate(value, context) { return value.replace(/:raceId/g, context.raceId || "missing-race").replace(/:jobId/g, context.jobId || "missing-job").replace(/:userId/g, context.userId || "missing-user").replace(/\{\{today\}\}/g, context.today).replace(/\{\{generation\}\}/g, String(context.generation || 1)); }
function weightedChoice(entries, random) { const eligible = entries.filter((item) => item.weight > 0); const total = eligible.reduce((sum, item) => sum + item.weight, 0); let needle = random() * total; for (const item of eligible) { needle -= item.weight; if (needle <= 0) return item; } return eligible[eligible.length - 1]; }
function textReport(result) {
  const endpoints = Object.entries(result.endpoints || {});
  const worstLatency = endpoints.sort(([, left], [, right]) => right.latencyMs.p95 - left.latencyMs.p95)[0];
  const worstErrors = Object.entries(result.endpoints || {}).sort(([, left], [, right]) => (right.status["5xx"] + right.status.timeout) - (left.status["5xx"] + left.status.timeout))[0];
  return [
    `run=${result.runId} target=${result.target} profile=${result.profile}@${result.profileVersion}`,
    `coverageRequests=${result.parameters.coverageRequests || 0}`,
    `offered=${result.parameters.arrivalRatePerSecond}/s achieved=${Number(result.summary.throughputPerSecond).toFixed(2)}/s requests=${result.summary.requests} errorRate=${(result.summary.errorRate * 100).toFixed(2)}%`,
    `latency p50/p95/p99=${result.summary.latencyMs.p50}/${result.summary.latencyMs.p95}/${result.summary.latencyMs.p99}ms stop=${result.summary.stopReason}`,
    `worstP95=${worstLatency ? `${worstLatency[0]} (${worstLatency[1].latencyMs.p95}ms)` : "none"}`,
    `worstErrors=${worstErrors ? `${worstErrors[0]} (${worstErrors[1].status["5xx"] + worstErrors[1].status.timeout})` : "none"}`,
  ].join("\n") + "\n";
}
function payloadFor(entry, context, sequence) {
  const date = context.today;
  const start = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const end = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  if (entry.path === "/steps/samples") return { samples: [{ periodStart: start, periodEnd: end, steps: 100 + (sequence % 50), recordingMethod: "automatic", sourceName: "synthetic-health", sourceId: `load:${context.runId}:${context.userIndex}` }] };
  if (entry.path === "/steps") return { steps: 1000 + sequence, date, skipRaceResolution: true };
  if (entry.path === "/steps/sync-v2") return { date, steps: 1000 + sequence, samples: [{ periodStart: start, periodEnd: end, steps: 100 + (sequence % 50), recordingMethod: "automatic", sourceName: "synthetic-health", sourceId: `load:${context.runId}:${context.userIndex}` }] };
  return undefined;
}
function requestUrl(baseUrl, entry, context) { const pathName = replaceTemplate(entry.path, context); return `${baseUrl}${pathName}${entry.query ? `?${replaceTemplate(entry.query, context)}` : ""}`; }

async function oneRequest({ fetchImpl, baseUrl, entry, context, sequence, timeoutMs }) {
  const headers = { Accept: "application/json", "X-Load-Run-Id": context.runId, "X-Synthetic-User": `load:${context.runId}:user:${context.userIndex}`, "X-App-Version": entry.persona === "legacy" ? "1.1.0" : "2.3.8", ...entry.headers, Authorization: `Bearer ${context.token}` };
  if (!entry.readOnly) headers["Content-Type"] = "application/json";
  if (entry.path === "/steps/sync-v2") headers["Idempotency-Key"] = uuidFor(context.runId, context.userIndex, sequence);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = process.hrtime.bigint();
  try {
    const response = await fetchImpl(requestUrl(baseUrl, entry, context), { method: entry.method, headers, body: entry.readOnly ? undefined : JSON.stringify(payloadFor(entry, context, sequence)), signal: controller.signal });
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    let body = null;
    if (entry.queue || entry.path === "/steps/sync-v2") { try { body = await response.json(); } catch {} }
    return { endpoint: `${entry.method} ${entry.path}`, status: response.status, latencyMs, persona: entry.persona, userIndex: context.userIndex, queueJobId: body?.raceResolution?.jobId || body?.jobId || null, queueGeneration: body?.raceResolution?.generation || body?.generation || 1, queueState: body?.state || body?.raceResolution?.state || null, allowedStatuses: entry.allowedStatuses, unexpectedStatus: !entry.allowedStatuses.includes(response.status), timeout: false };
  } catch (error) {
    return { endpoint: `${entry.method} ${entry.path}`, status: 0, latencyMs: Number(process.hrtime.bigint() - started) / 1e6, persona: entry.persona, userIndex: context.userIndex, allowedStatuses: entry.allowedStatuses, unexpectedStatus: true, timeout: error.name === "AbortError" || error.message.includes("timeout") };
  } finally { clearTimeout(timer); }
}

async function runLoad({ target = "capacity-vm", baseUrl, databaseUrl, profile, users, arrivalRate, duration, timeoutMs, concurrency, runId, capacityStateDirectory, confirmCapacityVm = false, dryRun = false, fetchImpl = globalThis.fetch, prisma, fixtureFactory = createSyntheticFixtures, cleanup = cleanupSyntheticRun, outputDir = path.resolve("results"), now = () => new Date(), signal, max5xxRate = 0.05, maxTimeoutRate = 0.05, random = Math.random, environment = process.env }) {
  const targetInfo = classifyTarget({ target, baseUrl, databaseUrl });
  if (!confirmCapacityVm && dryRun) throw new Error("dry-run capacity plans require --confirm-capacity-vm");
  if (!dryRun && (!runId || !capacityStateDirectory)) throw new Error("load runs require --run-id and --capacity-state-dir after a verified capacity start");
  const capacityState = !dryRun ? assertStartedRun({ runId, directory: capacityStateDirectory, env: environment }) : null;
  const params = parseLoadParameters({ profile, users, arrivalRate, duration, timeoutMs, concurrency });
  let startedAt;
  const profileConfig = PROFILES[params.profile];
  if (dryRun) return { schema: "load-test-plan-v1", target: targetInfo.kind, baseUrl: targetInfo.baseUrl, profile: params.profile, profileVersion: profileConfig.version, parameters: params, entries: profileConfig.entries.map(({ method, path: requestPath, query, headers, payloadShape, fixturePrerequisites, allowedStatuses, weight, persona, readOnly, disposableWrite }) => ({ method, path: requestPath, query, headers, payloadShape, fixturePrerequisites, allowedStatuses, weight, persona, readOnly, disposableWrite })) };
  if (!prisma) throw new Error("load run requires an injected Prisma client for synthetic fixture setup");
  let fixture = null;
  const samples = [];
  const jobs = [];
  const queueLatencies = [];
  let coverageRequests = 0;
  let queueDrainCompleted = true;
    let stopReason = "completed";
  let sequence = 0;
  const coverageEntries = profileConfig.entries.filter((entry) => !entry.path.includes(":jobId"));
  try {
    fixture = await fixtureFactory({ prisma, runId, users: params.users, races: 1, env: environment });
    const contexts = fixture.users.map((user, userIndex) => ({ runId, userIndex, userId: user.id, token: user.token, raceId: fixture.manifest.ids.races[0], today: new Date().toISOString().slice(0, 10) }));
    // Always touch every screen endpoint once before the sustained-rate phase.
    // This makes a short smoke run useful for endpoint coverage instead of
    // relying on probability to select a route.
    for (const [coverageSequence, entry] of coverageEntries.entries()) {
      if (signal?.aborted) { stopReason = "operator"; break; }
      const context = contexts[coverageSequence % contexts.length];
      const sample = await oneRequest({ fetchImpl, baseUrl: targetInfo.baseUrl, entry, context, sequence: coverageSequence, timeoutMs: params.timeoutMs });
      samples.push(sample);
      coverageRequests += 1;
      if (sample.queueJobId) jobs.push({ id: sample.queueJobId, generation: sample.queueGeneration || 1, userIndex: sample.userIndex, enqueuedAt: Date.now() });
    }
    // Start the offered-rate window after fixture setup and coverage traffic so
    // setup time does not dilute the sustained throughput measurement.
    startedAt = now().toISOString();
    const sustainedStartedMs = Date.now();
    const endAt = sustainedStartedMs + params.durationSeconds * 1000;
    const launchIntervalMs = 1000 / params.arrivalRatePerSecond;
    let nextLaunchAt = sustainedStartedMs;
    let active = new Set();
    while (Date.now() < endAt || active.size > 0) {
      if (signal?.aborted) { stopReason = "operator"; break; }
      const fiveHundreds = samples.filter((item) => item.status >= 500).length;
      const timeouts = samples.filter((item) => item.timeout).length;
      if (samples.length && (fiveHundreds / samples.length > max5xxRate || timeouts / samples.length > maxTimeoutRate)) { stopReason = "threshold"; break; }
      if (Date.now() < endAt && sequence < Math.ceil(params.arrivalRatePerSecond * params.durationSeconds)) {
        if (active.size >= params.concurrency) {
          await Promise.race(active);
          continue;
        }
        const untilNextLaunchMs = nextLaunchAt - Date.now();
        if (untilNextLaunchMs > 0) {
          await sleep(untilNextLaunchMs, signal);
          continue;
        }
        const context = contexts[sequence % contexts.length];
        const entry = sequence < coverageEntries.length ? coverageEntries[sequence] : weightedChoice(profileConfig.entries, random);
        if ((entry.path.includes(":jobId") && !jobs.some((job) => job.userIndex === context.userIndex))) { sequence += 1; continue; }
        if (entry.path.includes(":jobId")) { const job = jobs.find((item) => item.userIndex === context.userIndex); context.jobId = job.id; context.generation = job.generation; }
        const promise = oneRequest({ fetchImpl, baseUrl: targetInfo.baseUrl, entry, context, sequence, timeoutMs: params.timeoutMs }).then((sample) => { samples.push(sample); if (sample.queueJobId) jobs.push({ id: sample.queueJobId, generation: sample.queueGeneration || 1, userIndex: sample.userIndex, enqueuedAt: Date.now() }); }).finally(() => active.delete(promise));
        active.add(promise); sequence += 1;
        // Advance from the scheduled time. If concurrency temporarily blocks
        // the schedule, resume from now instead of emitting a catch-up burst.
        nextLaunchAt += launchIntervalMs;
        if (nextLaunchAt < Date.now()) nextLaunchAt = Date.now();
        continue;
      }
      if (active.size) await Promise.race(active); else await sleep(Math.max(1, Math.floor(1000 / params.arrivalRatePerSecond)), signal);
    }
    await Promise.all(active);
    const queueStartedAt = Date.now();
    let queueCompleted = 0;
    const queueEntry = profileConfig.entries.find((entry) => entry.path.includes(":jobId"));
    if (queueEntry && jobs.length) {
      const pending = new Map(jobs.map((job) => [`${job.userIndex}:${job.id}`, job]));
      while (pending.size && Date.now() - queueStartedAt < 30000) {
        const checks = await Promise.all([...pending.values()].map(async (job) => {
          const context = contexts[job.userIndex];
          context.jobId = job.id;
          context.generation = job.generation;
          const sample = await oneRequest({ fetchImpl, baseUrl: targetInfo.baseUrl, entry: queueEntry, context, sequence, timeoutMs: params.timeoutMs });
          samples.push(sample);
          return { job, sample };
        }));
        for (const { job, sample } of checks) {
          if (sample.queueState === "SUCCEEDED" || sample.queueState === "FAILED" || sample.status === 404) {
            pending.delete(`${job.userIndex}:${job.id}`);
            queueCompleted += 1;
            queueLatencies.push(Math.max(0, Date.now() - job.enqueuedAt));
          }
        }
        if (pending.size) await sleep(250, signal);
      }
      queueDrainCompleted = pending.size === 0;
    }
    const endedAt = now().toISOString();
    const queueP95 = queueLatencies.length ? queueLatencies.sort((a, b) => a - b)[Math.min(queueLatencies.length - 1, Math.ceil(queueLatencies.length * 0.95) - 1)] : 0;
    const redisConfigured = Boolean(environment.REDIS_URL || environment.CAPACITY_REDIS_ENABLED === "true");
    const result = buildResult({ runId, target: targetInfo.kind, baseUrl: targetInfo.baseUrl, commit: environment.CAPACITY_EXPECTED_COMMIT_SHA || capacityState?.approvedManifest?.backend?.commit || null, profile: params.profile, profileVersion: profileConfig.version, startedAt, endedAt, parameters: { ...params, coverageRequests }, samples, queue: { enqueued: jobs.length, completed: queueCompleted, drainCompleted: queueDrainCompleted, lagMs: { p95: queueP95 }, drainSeconds: (Date.now() - queueStartedAt) / 1000 }, infrastructure: { redis: { mode: redisConfigured ? "configured" : "unset", fallbackMode: redisConfigured ? "cache" : "postgres" }, queue: { mode: redisConfigured ? "postgres-backed-dedicated-resolution-process" : "in-process-local-capacity" } }, safety: { targetConfirmed: true, databaseCheck: "scrub-attested", snapshotHash: capacityState?.snapshotHash || environment.CAPACITY_SNAPSHOT_HASH, scrubAttestationHash: capacityState?.scrubAttestationHash || environment.CAPACITY_SCRUB_ATTESTATION_HASH } });
    result.summary.stopReason = stopReason;
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(outputDir, `${runId}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(outputDir, `${runId}.txt`), textReport(result), { mode: 0o600 });
    return result;
  } finally {
    if (fixture) await cleanup({ prisma, manifest: fixture.manifest });
  }
}

module.exports = { oneRequest, payloadFor, requestUrl, runLoad, uuidFor, weightedChoice };
