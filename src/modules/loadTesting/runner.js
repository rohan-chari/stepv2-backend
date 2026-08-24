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
  const start = context.sampleStart || new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const end = context.sampleEnd || new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const sampleSteps = 6000 + context.userIndex * 100 +
    Math.floor(sequence / Math.max(1, Number(context.userCount) || 1));
  if (entry.path === "/steps/samples") return { samples: [{ periodStart: start, periodEnd: end, steps: sampleSteps, recordingMethod: "automatic", sourceName: "synthetic-health", sourceId: `load:${context.runId}:${context.userIndex}` }] };
  if (entry.path === "/steps") return { steps: 1000 + sequence, date, skipRaceResolution: true };
  if (entry.path === "/steps/sync-v2") return { date, steps: 1000 + sequence, samples: [{ periodStart: start, periodEnd: end, steps: sampleSteps, recordingMethod: "automatic", sourceName: "synthetic-health", sourceId: `load:${context.runId}:${context.userIndex}` }] };
  return undefined;
}
function requestUrl(baseUrl, entry, context) { const pathName = replaceTemplate(entry.path, context); return `${baseUrl}${pathName}${entry.query ? `?${replaceTemplate(entry.query, context)}` : ""}`; }

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p / 100) - 1)];
}

// Capacity fixtures deliberately start mid-day and submit one closed sample
// window per synthetic user. Recompute their canonical race source directly
// from those rows so persisted projections can never validate themselves.
function proratedFixtureSteps(samples, windowStartMs, windowEndMs) {
  let total = 0;
  for (const sample of samples) {
    const sampleStart = new Date(sample.periodStart).getTime();
    const sampleEnd = new Date(sample.periodEnd).getTime();
    const duration = sampleEnd - sampleStart;
    const overlap = Math.min(sampleEnd, windowEndMs) - Math.max(sampleStart, windowStartMs);
    if (duration <= 0 || overlap <= 0) continue;
    total += overlap >= duration
      ? Number(sample.steps || 0)
      : Math.round(Number(sample.steps || 0) * overlap / duration);
  }
  return total;
}

function assertFixtureParity({
  races = [],
  sourceRows = { daily: [], samples: [] },
  participants = [],
  publicProgress = [],
  boxRows = [],
  scoringNow = new Date(),
}) {
  const raceById = new Map(races.map((race) => [race.id, race]));
  const publicByRace = new Map(publicProgress.map((row) => [row.raceId, row.participants]));
  const samplesByUser = new Map();
  for (const sample of sourceRows.samples || []) {
    const rows = samplesByUser.get(sample.userId) || [];
    rows.push(sample);
    samplesByUser.set(sample.userId, rows);
  }
  const boxesByParticipant = new Map();
  const boxKeys = new Set();
  for (const box of boxRows) {
    const key = `${box.participantId}:${box.earnedAtSteps}`;
    if (boxKeys.has(key)) throw new Error(`fixture parity failed: duplicate box ${key}`);
    boxKeys.add(key);
    const rows = boxesByParticipant.get(box.participantId) || [];
    rows.push(box);
    boxesByParticipant.set(box.participantId, rows);
  }

  const expectedByRace = new Map();
  let crossedThreshold = false;
  for (const participant of participants) {
    const race = raceById.get(participant.raceId);
    if (!race) throw new Error(`fixture parity failed: missing race ${participant.raceId}`);
    const effectiveStartMs = Math.max(
      new Date(race.startedAt).getTime(),
      new Date(participant.joinedAt || race.startedAt).getTime()
    );
    const scoringEndMs = Math.min(
      new Date(scoringNow).getTime(),
      race.endsAt ? new Date(race.endsAt).getTime() : Number.POSITIVE_INFINITY
    );
    const expectedRaw = proratedFixtureSteps(
      samplesByUser.get(participant.userId) || [],
      effectiveStartMs,
      scoringEndMs
    );
    if (Number(participant.rawSteps) !== expectedRaw) {
      throw new Error(`fixture parity failed: raw source parity for ${participant.raceId}:${participant.userId}`);
    }
    const expectedTotal = expectedRaw + Number(participant.bonusSteps || 0);
    if (Number(participant.totalSteps) !== expectedTotal) {
      throw new Error(`fixture parity failed: derived total for ${participant.raceId}:${participant.userId}`);
    }

    const interval = Number(race.powerupStepInterval || 0);
    if (!(interval > 0)) throw new Error(`fixture parity failed: missing box interval for ${race.id}`);
    const crossings = Math.floor(expectedRaw / interval);
    crossedThreshold ||= crossings > 0;
    const retainedBoxes = Math.min(crossings, Number(participant.powerupSlots || 3) + 1);
    const expectedThresholds = Array.from(
      { length: retainedBoxes },
      (_, index) => (index + 1) * interval
    );
    const actualThresholds = (boxesByParticipant.get(participant.id) || [])
      .map((box) => Number(box.earnedAtSteps))
      .sort((left, right) => left - right);
    for (const threshold of expectedThresholds) {
      if (!actualThresholds.includes(threshold)) {
        throw new Error(`fixture parity failed: missing box ${participant.id}:${threshold}`);
      }
    }
    if (actualThresholds.length !== expectedThresholds.length ||
        actualThresholds.some((threshold, index) => threshold !== expectedThresholds[index])) {
      throw new Error(`fixture parity failed: unexpected box threshold for ${participant.id}`);
    }
    const expectedNextBox = (crossings + 1) * interval;
    if (Number(participant.nextBoxAtSteps) !== expectedNextBox) {
      throw new Error(`fixture parity failed: box threshold projection for ${participant.id}`);
    }

    const raceRows = expectedByRace.get(race.id) || [];
    raceRows.push({
      userId: participant.userId,
      totalSteps: expectedTotal,
      joinedAt: participant.joinedAt,
    });
    expectedByRace.set(race.id, raceRows);
  }
  if (!crossedThreshold) {
    throw new Error("fixture parity failed: deterministic cohort did not cross 5000-step threshold");
  }

  for (const [raceId, expectedRows] of expectedByRace) {
    const liveRows = publicByRace.get(raceId);
    if (!Array.isArray(liveRows) || liveRows.length !== expectedRows.length) {
      throw new Error(`fixture parity failed: public participant coverage for ${raceId}`);
    }
    const ranked = [...expectedRows].sort((left, right) =>
      right.totalSteps - left.totalSteps ||
      new Date(left.joinedAt || 0).getTime() - new Date(right.joinedAt || 0).getTime() ||
      String(left.userId).localeCompare(String(right.userId))
    );
    const expectedPlacement = new Map(ranked.map((row, index) => [row.userId, index + 1]));
    for (const live of liveRows) {
      const expected = expectedRows.find((row) => row.userId === live.userId);
      if (!expected || Number(live.totalSteps) !== expected.totalSteps ||
          Number(live.placement) !== expectedPlacement.get(live.userId)) {
        throw new Error(`fixture parity failed: public placement for ${raceId}:${live.userId}`);
      }
    }
  }
  return { ok: true, checkedParticipants: participants.length, checkedBoxes: boxRows.length };
}

function assertChangedUploadSettlement({ changedUploads = [], settledGenerations = [] }) {
  const settledByGeneration = new Map(settledGenerations.map((row) => [
    `${row.raceId}:${row.generation}`,
    Number(row.settledAtMs),
  ]));
  const latencies = changedUploads.map((upload) => {
    const settledAtMs = Number.isFinite(Number(upload.settledAtMs))
      ? Number(upload.settledAtMs)
      : settledByGeneration.get(`${upload.raceId}:${upload.generation}`);
    if (!Number.isFinite(settledAtMs)) {
      throw new Error(`burst capacity gate failed: changed upload generation did not settle ${upload.raceId}:${upload.generation}`);
    }
    return Math.max(0, settledAtMs - Number(upload.completedAtMs));
  });
  if (latencies.length === 0) {
    throw new Error("burst capacity gate failed: no changed uploads were timestamped");
  }
  if (Math.max(...latencies) > 60_000) {
    throw new Error("burst capacity gate failed: 100% changed uploads must settle within 60s");
  }
  if (percentile(latencies, 99) > 15_000) {
    throw new Error("burst capacity gate failed: 99% changed uploads must settle within 15s");
  }
  return {
    samples: latencies.length,
    p99Ms: percentile(latencies, 99),
    maxMs: Math.max(...latencies),
  };
}

function phaseEvidenceFromTelemetry(entries, { runId } = {}) {
  const sourceIntakeMs = [];
  const workerTransactionMs = [];
  const queueLagMs = [];
  const diagnostics = [];
  let measurementGateEligible = true;
  for (const entry of entries || []) {
    const fields = entry?.fields || entry;
    if (!fields || typeof fields !== "object") continue;
    const serialized = JSON.stringify(fields);
    if (/P2028|40P01|deadlock|pool.{0,20}timeout/i.test(serialized)) {
      diagnostics.push(serialized.slice(0, 160));
    }
    if (
      fields.event === "capacity_phase_metrics_v1" &&
      fields.surface === "step_source_intake" &&
      fields.dimensions?.runId === runId
    ) {
      sourceIntakeMs.push(Number(fields.durationMs) || 0);
      if (fields.queryCaptureAvailable !== true ||
          fields.measurementGateEligible !== true ||
          fields.queryCaptureSetting !== "PRISMA_QUERY_EVENTS_ENABLED=true") {
        measurementGateEligible = false;
      }
    }
    if (fields.event === "race_resolution_v2" &&
        ["commit", "superseded_commit"].includes(fields.outcome)) {
      workerTransactionMs.push(Number(fields.phaseMs?.transaction) || 0);
      queueLagMs.push(Number(fields.queueLagMs) || 0);
    }
  }
  return {
    sourceIntakeMs,
    workerTransactionMs,
    queueLagMs,
    diagnostics,
    measurementGateEligible,
  };
}

function assertBurstCapacityGates({
  samples = [],
  queueRows = [],
  drainCompleted = false,
  parity = { ok: false },
  amplification = { ratio: Infinity },
  phaseEvidence = null,
}) {
  if (samples.some((sample) => sample.status >= 500)) {
    throw new Error("burst capacity gate failed: 5xx response observed");
  }
  if (samples.some((sample) => sample.timeout)) {
    throw new Error("burst capacity gate failed: request timeout observed");
  }
  const diagnostic = [
    ...samples.map((sample) => sample.errorDiagnostic),
    ...queueRows.map((row) => row.lastErrorCode),
  ].filter(Boolean).join(" ");
  if (/P2028|40P01|deadlock|pool.{0,20}timeout|transaction.{0,20}(?:start|timeout)/i.test(diagnostic)) {
    throw new Error(`burst capacity gate failed: database contention error ${diagnostic.slice(0, 120)}`);
  }
  if (queueRows.some((row) => String(row.state).toUpperCase() === "FAILED")) {
    throw new Error("burst capacity gate failed: failed/dead-letter queue row");
  }
  const unsettled = queueRows.some((row) =>
    String(row.state).toUpperCase() !== "SUCCEEDED" ||
    Number(row.generation) !== Number(row.processingGeneration)
  );
  if (!drainCompleted || unsettled) {
    throw new Error("burst capacity gate failed: unsettled fixture generation");
  }
  if (parity.ok !== true) throw new Error("burst capacity gate failed: final-state parity");
  if (!Number.isFinite(amplification.ratio) || amplification.ratio > 1.05) {
    throw new Error("burst capacity gate failed: generation amplification");
  }
  if (amplification.repeatGenerationStable === false) {
    throw new Error("burst capacity gate failed: identical replay generation amplification");
  }
  const intakeLatencies = samples
    .filter((sample) => /POST \/steps(?:\/samples|\/sync-v2)?$/.test(sample.endpoint))
    .map((sample) => Number(sample.latencyMs) || 0);
  if (percentile(intakeLatencies, 95) > 2000 || percentile(intakeLatencies, 99) > 5000) {
    throw new Error("burst capacity gate failed: intake phase latency");
  }
  if (!phaseEvidence || phaseEvidence.sourceIntakeMs?.length === 0 ||
      phaseEvidence.workerTransactionMs?.length === 0) {
    throw new Error("burst capacity gate failed: phase telemetry unavailable");
  }
  if (phaseEvidence.measurementGateEligible !== true) {
    throw new Error("burst capacity gate failed: phase telemetry measurement ineligible");
  }
  if (phaseEvidence.diagnostics?.length) {
    throw new Error(`burst capacity gate failed: database contention telemetry ${phaseEvidence.diagnostics[0]}`);
  }
  if (percentile(phaseEvidence.sourceIntakeMs, 95) > 1000 ||
      percentile(phaseEvidence.sourceIntakeMs, 99) > 3000) {
    throw new Error("burst capacity gate failed: source-intake transaction latency");
  }
  if (percentile(phaseEvidence.workerTransactionMs, 95) > 2000 ||
      percentile(phaseEvidence.workerTransactionMs, 99) > 10000 ||
      Math.max(...phaseEvidence.workerTransactionMs) >= 15000) {
    throw new Error("burst capacity gate failed: worker fenced transaction latency");
  }
  if (percentile(phaseEvidence.queueLagMs || [], 95) > 10000 ||
      Math.max(0, ...(phaseEvidence.queueLagMs || [])) > 30000) {
    throw new Error("burst capacity gate failed: queue latency");
  }
  return true;
}

async function oneRequest({ fetchImpl, baseUrl, entry, context, sequence, requestIdentitySequence = sequence, timeoutMs, sourceChangedExpected = false }) {
  const headers = { Accept: "application/json", "X-Load-Run-Id": context.runId, "X-Capacity-Run-Id": context.runId, "X-Capacity-Repeat": context.repeat || "1", "X-Synthetic-User": `load:${context.runId}:user:${context.userIndex}`, "X-App-Version": entry.persona === "legacy" ? "1.1.0" : "2.3.8", ...entry.headers, Authorization: `Bearer ${context.token}` };
  if (!entry.readOnly) headers["Content-Type"] = "application/json";
  if (entry.path === "/steps/sync-v2") headers["Idempotency-Key"] = uuidFor(context.runId, context.userIndex, requestIdentitySequence);
  let requestBody;
  if (!entry.readOnly) {
    const cache = context.requestBodies;
    const cacheKey = `${entry.path}:${requestIdentitySequence}`;
    requestBody = cache?.get(cacheKey);
    if (requestBody === undefined) {
      requestBody = JSON.stringify(payloadFor(entry, context, requestIdentitySequence));
      cache?.set(cacheKey, requestBody);
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = process.hrtime.bigint();
  try {
    const response = await fetchImpl(requestUrl(baseUrl, entry, context), { method: entry.method, headers, body: entry.readOnly ? undefined : requestBody, signal: controller.signal });
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    let body = null;
    try { body = await response.json(); } catch {}
    return { endpoint: `${entry.method} ${entry.path}`, status: response.status, latencyMs, completedAtMs: Date.now(), sourceChangedExpected, persona: entry.persona, userIndex: context.userIndex, requestIdentitySequence, queueJobId: body?.raceResolution?.jobId || body?.jobId || null, queueGeneration: body?.raceResolution?.generation || body?.generation || 1, queueState: body?.state || body?.raceResolution?.state || null, errorDiagnostic: response.status >= 400 ? String(body?.code || body?.error || "").slice(0, 120) : null, allowedStatuses: entry.allowedStatuses, unexpectedStatus: !entry.allowedStatuses.includes(response.status), timeout: false };
  } catch (error) {
    return { endpoint: `${entry.method} ${entry.path}`, status: 0, latencyMs: Number(process.hrtime.bigint() - started) / 1e6, completedAtMs: Date.now(), sourceChangedExpected, persona: entry.persona, userIndex: context.userIndex, errorDiagnostic: String(error?.code || error?.message || "request error").slice(0, 120), allowedStatuses: entry.allowedStatuses, unexpectedStatus: true, timeout: error.name === "AbortError" || error.message.includes("timeout") };
  } finally { clearTimeout(timer); }
}

async function runLoad({ target = "capacity-vm", baseUrl, databaseUrl, profile, users, arrivalRate, duration, timeoutMs, concurrency, runId, capacityRepeat = "1", capacityStateDirectory, confirmCapacityVm = false, dryRun = false, fetchImpl = globalThis.fetch, prisma, fixtureFactory = createSyntheticFixtures, cleanup = cleanupSyntheticRun, outputDir = path.resolve("results"), now = () => new Date(), signal, max5xxRate = 0.05, maxTimeoutRate = 0.05, random = Math.random, environment = process.env, readCapacityTelemetry = null }) {
  const targetInfo = classifyTarget({ target, baseUrl, databaseUrl });
  if (!confirmCapacityVm && dryRun) throw new Error("dry-run capacity plans require --confirm-capacity-vm");
  if (!dryRun && (!runId || !capacityStateDirectory)) throw new Error("load runs require --run-id and --capacity-state-dir after a verified capacity start");
  const capacityState = !dryRun ? assertStartedRun({ runId, directory: capacityStateDirectory, env: environment }) : null;
  const params = parseLoadParameters({ profile, users, arrivalRate, duration, timeoutMs, concurrency });
  if (!/^[123]$/.test(String(capacityRepeat))) {
    throw new Error("capacity repeat must be 1, 2, or 3");
  }
  let startedAt;
  const profileConfig = PROFILES[params.profile];
  if (dryRun) return { schema: "load-test-plan-v1", target: targetInfo.kind, baseUrl: targetInfo.baseUrl, profile: params.profile, profileVersion: profileConfig.version, fixtureRaces: profileConfig.fixtureRaces, ambiguousRetryEvery: profileConfig.ambiguousRetryEvery, parameters: params, entries: profileConfig.entries.map(({ method, path: requestPath, query, headers, payloadShape, fixturePrerequisites, allowedStatuses, weight, persona, readOnly, disposableWrite }) => ({ method, path: requestPath, query, headers, payloadShape, fixturePrerequisites, allowedStatuses, weight, persona, readOnly, disposableWrite })) };
  if (!prisma) throw new Error("load run requires an injected Prisma client for synthetic fixture setup");
  let fixture = null;
  const samples = [];
  const jobs = [];
  const queueLatencies = [];
  let coverageRequests = 0;
  let queueDrainCompleted = true;
  let fixtureQueueRows = [];
  let parity = { ok: true, checkedParticipants: 0 };
  let amplification = { ratio: 0, generations: 0, successfulWrites: 0 };
  let settlement = null;
  const settlementObservations = [];
  let stopSettlementMonitor = false;
  let settlementMonitor = null;
  let phaseEvidence = null;
    let stopReason = "completed";
  let sequence = 0;
  const coverageEntries = profileConfig.entries.filter((entry) => !entry.path.includes(":jobId"));
  try {
    fixture = await fixtureFactory({ prisma, runId, users: params.users, races: profileConfig.fixtureRaces, env: environment });
    const latestRaceStartMs = Math.max(...fixture.races.map((race) => new Date(race.startedAt).getTime()));
    const sampleStart = new Date(latestRaceStartMs + 10 * 60 * 1000).toISOString();
    const sampleEnd = new Date(latestRaceStartMs + 20 * 60 * 1000).toISOString();
    const contexts = fixture.users.map((user, userIndex) => ({ runId, repeat: String(capacityRepeat), userCount: fixture.users.length, userIndex, userId: user.id, token: user.token, raceId: fixture.manifest.ids.races[userIndex % profileConfig.fixtureRaces], today: new Date().toISOString().slice(0, 10), sampleStart, sampleEnd, requestBodies: new Map() }));
    const burstProfile = ["frozen-step-sync-burst", "current-step-sync-burst"].includes(params.profile);
    const observeSettlements = (rows, observedAtMs = Date.now()) => {
      for (const row of rows || []) {
        if (String(row.state).toUpperCase() !== "SUCCEEDED" ||
            Number(row.generation) !== Number(row.processingGeneration)) continue;
        settlementObservations.push({
          raceId: row.raceId,
          generation: Number(row.generation),
          // Poll observation time is a conservative upper bound and, unlike
          // updatedAt, remains mappable when a generation settles between the
          // source commit and its HTTP response reaching the load driver.
          settledAtMs: observedAtMs,
          dbSettledAtMs: row.updatedAt ? new Date(row.updatedAt).getTime() : null,
        });
      }
    };
    if (burstProfile) {
      const raceIds = fixture.manifest.ids.races || [];
      settlementMonitor = (async () => {
        while (!stopSettlementMonitor) {
          try {
            const rows = await prisma.raceResolutionJobV2.findMany({
              where: { raceId: { in: raceIds } },
              select: {
                raceId: true,
                state: true,
                generation: true,
                processingGeneration: true,
                updatedAt: true,
              },
            });
            observeSettlements(rows);
          } catch (error) {
            samples.push({
              endpoint: "HARNESS settlement monitor",
              status: 0,
              timeout: false,
              unexpectedStatus: true,
              errorDiagnostic: String(error?.code || error?.message || "settlement monitor error").slice(0, 120),
              latencyMs: 0,
            });
            break;
          }
          await sleep(100);
        }
      })();
    }
    // Always touch every screen endpoint once before the sustained-rate phase.
    // This makes a short smoke run useful for endpoint coverage instead of
    // relying on probability to select a route.
    for (const [coverageSequence, entry] of coverageEntries.entries()) {
      if (signal?.aborted) { stopReason = "operator"; break; }
      const context = contexts[coverageSequence % contexts.length];
      const sample = await oneRequest({ fetchImpl, baseUrl: targetInfo.baseUrl, entry, context, sequence: coverageSequence, timeoutMs: params.timeoutMs, sourceChangedExpected: !entry.readOnly });
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
        const ambiguousReplay = profileConfig.ambiguousRetryEvery &&
          sequence >= params.users &&
          sequence % profileConfig.ambiguousRetryEvery === 0;
        const requestIdentitySequence = ambiguousReplay
          ? sequence - params.users
          : sequence;
        const promise = oneRequest({ fetchImpl, baseUrl: targetInfo.baseUrl, entry, context, sequence, requestIdentitySequence, timeoutMs: params.timeoutMs, sourceChangedExpected: !entry.readOnly && !ambiguousReplay && sequence >= coverageEntries.length }).then((sample) => { samples.push(sample); if (sample.queueJobId) jobs.push({ id: sample.queueJobId, generation: sample.queueGeneration || 1, userIndex: sample.userIndex, enqueuedAt: Date.now() }); }).finally(() => active.delete(promise));
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
    if (["frozen-step-sync-burst", "current-step-sync-burst"].includes(params.profile)) {
      const raceIds = fixture.manifest.ids.races || [];
      queueDrainCompleted = false;
      while (Date.now() - queueStartedAt < 60_000) {
        fixtureQueueRows = await prisma.raceResolutionJobV2.findMany({
          where: { raceId: { in: raceIds } },
          select: {
            raceId: true,
            state: true,
            generation: true,
            processingGeneration: true,
            lastErrorCode: true,
            updatedAt: true,
          },
          orderBy: { raceId: "asc" },
        });
        observeSettlements(fixtureQueueRows);
        if (fixtureQueueRows.some((row) => String(row.state).toUpperCase() === "FAILED")) break;
        queueDrainCompleted = fixtureQueueRows.length === raceIds.length &&
          fixtureQueueRows.every((row) =>
            String(row.state).toUpperCase() === "SUCCEEDED" &&
            Number(row.generation) === Number(row.processingGeneration)
          );
        if (queueDrainCompleted) {
          break;
        }
        await sleep(250, signal);
      }
      const changedUploadSamples = samples.filter((sample) =>
        sample.sourceChangedExpected === true &&
        sample.status >= 200 && sample.status < 300 &&
        /^POST \/steps/.test(sample.endpoint)
      );
      stopSettlementMonitor = true;
      if (settlementMonitor) await settlementMonitor;
      const observationsByRace = new Map();
      for (const observation of settlementObservations) {
        const rows = observationsByRace.get(observation.raceId) || [];
        rows.push(observation);
        observationsByRace.set(observation.raceId, rows);
      }
      for (const rows of observationsByRace.values()) {
        rows.sort((left, right) => left.settledAtMs - right.settledAtMs);
      }
      const changedUploads = changedUploadSamples.flatMap((sample) =>
        raceIds.map((raceId) => {
          const settled = (observationsByRace.get(raceId) || [])
            .find((row) => row.settledAtMs >= sample.completedAtMs);
          return {
            completedAtMs: sample.completedAtMs,
            raceId,
            generation: settled?.generation ?? "unsettled",
            settledAtMs: settled?.settledAtMs,
          };
        })
      );
      settlement = assertChangedUploadSettlement({
        changedUploads,
        settledGenerations: settlementObservations,
      });
      const participantRows = await prisma.raceParticipant.findMany({
        where: { raceId: { in: raceIds }, status: "ACCEPTED" },
        select: {
          raceId: true,
          userId: true,
          rawSteps: true,
          totalSteps: true,
          bonusSteps: true,
          powerupSlots: true,
          nextBoxAtSteps: true,
          joinedAt: true,
        },
      });
      const [raceRows, dailyRows, sampleRows, boxRows] = await Promise.all([
        prisma.race.findMany({
          where: { id: { in: raceIds } },
          select: { id: true, startedAt: true, endsAt: true, powerupStepInterval: true },
        }),
        prisma.step.findMany({
          where: { userId: { in: fixture.manifest.ids.users } },
          select: { userId: true, date: true, steps: true },
        }),
        prisma.stepSample.findMany({
          where: { userId: { in: fixture.manifest.ids.users } },
          select: { userId: true, periodStart: true, periodEnd: true, steps: true },
        }),
        prisma.racePowerup.findMany({
          where: { raceId: { in: raceIds }, earnedAtSteps: { not: null } },
          select: { id: true, raceId: true, participantId: true, userId: true, earnedAtSteps: true, status: true },
        }),
      ]);
      const publicProgress = [];
      for (const raceId of raceIds) {
        const progressStarted = process.hrtime.bigint();
        const response = await fetchImpl(
          `${targetInfo.baseUrl}/races/${raceId}/progress`,
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${fixture.users[0].token}`,
              "X-Capacity-Run-Id": runId,
              "X-Capacity-Repeat": String(capacityRepeat),
            },
          }
        );
        const progressLatencyMs = Number(process.hrtime.bigint() - progressStarted) / 1e6;
        samples.push({
          endpoint: "GET /races/:raceId/progress",
          status: response.status,
          latencyMs: progressLatencyMs,
          completedAtMs: Date.now(),
          allowedStatuses: [200],
          unexpectedStatus: response.status !== 200,
          timeout: false,
        });
        if (response.status !== 200) {
          publicProgress.push({ raceId, participants: null });
          continue;
        }
        let body = null;
        try { body = await response.json(); } catch {}
        const liveRows = body?.progress?.participants;
        publicProgress.push({ raceId, participants: liveRows });
      }
      parity = assertFixtureParity({
        races: raceRows,
        sourceRows: { daily: dailyRows, samples: sampleRows },
        participants: participantRows,
        publicProgress,
        boxRows,
        scoringNow: new Date(),
      });
      const successfulWrites = samples.filter((sample) =>
        sample.status >= 200 && sample.status < 300 && /^POST \/steps/.test(sample.endpoint)
      ).length;
      const generations = fixtureQueueRows.reduce(
        (sum, row) => sum + Math.max(0, Number(row.generation) || 0),
        0
      );
      const replayGenerations = new Map();
      let repeatGenerationStable = true;
      for (const sample of samples.filter((item) =>
        item.endpoint === "POST /steps/sync-v2" && item.status === 202
      )) {
        const key = `${sample.userIndex}:${sample.requestIdentitySequence}`;
        const previous = replayGenerations.get(key);
        if (previous != null && Number(previous) !== Number(sample.queueGeneration)) {
          repeatGenerationStable = false;
        }
        replayGenerations.set(key, sample.queueGeneration);
      }
      amplification = {
        generations,
        successfulWrites,
        repeatGenerationStable,
        ratio: successfulWrites > 0 && raceIds.length > 0
          ? generations / (successfulWrites * raceIds.length)
          : Infinity,
      };
      const telemetry = typeof readCapacityTelemetry === "function"
        ? await readCapacityTelemetry({ runId, startedAt })
        : [];
      phaseEvidence = phaseEvidenceFromTelemetry(telemetry, { runId });
    }
    const endedAt = now().toISOString();
    const queueP95 = queueLatencies.length ? queueLatencies.sort((a, b) => a - b)[Math.min(queueLatencies.length - 1, Math.ceil(queueLatencies.length * 0.95) - 1)] : 0;
    const redisConfigured = Boolean(environment.REDIS_URL || environment.CAPACITY_REDIS_ENABLED === "true");
    const result = buildResult({ runId, target: targetInfo.kind, baseUrl: targetInfo.baseUrl, commit: environment.CAPACITY_EXPECTED_COMMIT_SHA || capacityState?.approvedManifest?.backend?.commit || null, profile: params.profile, profileVersion: profileConfig.version, startedAt, endedAt, parameters: { ...params, coverageRequests }, samples, queue: { enqueued: jobs.length, completed: queueCompleted, drainCompleted: queueDrainCompleted, lagMs: { p95: queueP95 }, drainSeconds: (Date.now() - queueStartedAt) / 1000 }, infrastructure: { redis: { mode: redisConfigured ? "configured" : "unset", fallbackMode: redisConfigured ? "cache" : "postgres" }, queue: { mode: redisConfigured ? "postgres-backed-dedicated-resolution-process" : "in-process-local-capacity" } }, safety: { targetConfirmed: true, databaseCheck: "scrub-attested", snapshotHash: capacityState?.snapshotHash || environment.CAPACITY_SNAPSHOT_HASH, scrubAttestationHash: capacityState?.scrubAttestationHash || environment.CAPACITY_SCRUB_ATTESTATION_HASH } });
    result.summary.stopReason = stopReason;
    if (["frozen-step-sync-burst", "current-step-sync-burst"].includes(params.profile)) {
      assertBurstCapacityGates({
        samples,
        queueRows: fixtureQueueRows,
        drainCompleted: queueDrainCompleted,
        parity,
        amplification,
        phaseEvidence,
      });
      result.queue.fixtureRows = fixtureQueueRows.length;
      result.queue.parity = parity;
      result.queue.amplification = amplification;
      result.queue.changedUploadSettlement = settlement;
      result.queue.phaseGates = {
        sourceIntakeSamples: phaseEvidence.sourceIntakeMs.length,
        workerSamples: phaseEvidence.workerTransactionMs.length,
      };
    }
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(outputDir, `${runId}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(outputDir, `${runId}.txt`), textReport(result), { mode: 0o600 });
    return result;
  } finally {
    stopSettlementMonitor = true;
    if (settlementMonitor) await settlementMonitor.catch(() => {});
    if (fixture) await cleanup({ prisma, manifest: fixture.manifest });
  }
}

module.exports = { assertBurstCapacityGates, assertChangedUploadSettlement, assertFixtureParity, oneRequest, payloadFor, phaseEvidenceFromTelemetry, requestUrl, runLoad, uuidFor, weightedChoice };
