const HEALTHY_PROFILE = "event_boundary_10000";
const OUTAGE_PROFILE = "event_provider_outage_10000";
const PROVISIONING_PROFILE = "event_provisioning_10000";
const EVENT_OPEN_PROFILE = "event-open-surge";

function boundedIndex(index, count) {
  const total = Number(count);
  const value = Number(index);
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(value) || value < 0) {
    throw new Error("capacity provider attempt index/count must be positive integers");
  }
  return value % total;
}

function raceCountForUser(index, count = 10_000) {
  const ordinal = boundedIndex(index, count);
  if (ordinal < Math.floor(count * 0.7)) return 1;
  if (ordinal < Math.floor(count * 0.9)) return 2;
  return 3;
}

function installationCountForUser(index, count = 10_000) {
  const ordinal = boundedIndex(index, count);
  if (ordinal < Math.floor(count * 0.2)) return 0;
  if (ordinal < Math.floor(count * 0.8)) return 1;
  if (ordinal < Math.floor(count * 0.95)) return 2;
  if (ordinal < Math.floor(count * 0.99)) return 5;
  return 10;
}

function globalEventFixtureCensus(count = 10_000) {
  const usersByRaceCount = {};
  const usersByInstallationCount = {};
  let participants = 0;
  let installations = 0;
  for (let index = 0; index < count; index += 1) {
    const raceCount = raceCountForUser(index, count);
    const installationCount = installationCountForUser(index, count);
    participants += raceCount;
    installations += installationCount;
    usersByRaceCount[raceCount] = (usersByRaceCount[raceCount] || 0) + 1;
    usersByInstallationCount[installationCount] =
      (usersByInstallationCount[installationCount] || 0) + 1;
  }
  return {
    users: count,
    races: 3,
    participants,
    installations,
    usersByRaceCount,
    usersByInstallationCount,
  };
}

function latencyForAttempt(index, count) {
  const ordinal = boundedIndex(index, count);
  const fraction = (ordinal + 1) / count;
  if (fraction <= 0.5) return 40;
  if (fraction <= 0.95) return 120;
  if (fraction <= 0.99) return 300;
  return 450;
}

function providerResultForAttempt({ profile, attemptIndex, attemptCount, elapsedMs = 0 }) {
  if (![HEALTHY_PROFILE, OUTAGE_PROFILE, EVENT_OPEN_PROFILE].includes(profile)) {
    throw new Error(`provider stub is unavailable for ${profile}`);
  }
  const latencyMs = latencyForAttempt(attemptIndex, attemptCount);
  if (profile === OUTAGE_PROFILE && Number(elapsedMs) < 60_000) {
    return { kind: "TRANSIENT", latencyMs, reason: "CAPACITY_PROVIDER_OUTAGE" };
  }
  const ordinal = boundedIndex(attemptIndex, attemptCount);
  const throttled = Math.floor(attemptCount * 0.005);
  const transient = Math.floor(attemptCount * 0.002);
  const invalid = Math.floor(attemptCount * 0.001);
  if (ordinal < throttled) {
    return { kind: "THROTTLED", latencyMs, reason: "HTTP_429", retryAfterMs: 250 };
  }
  if (ordinal < throttled + transient) {
    return { kind: "TRANSIENT", latencyMs, reason: "HTTP_503" };
  }
  if (ordinal < throttled + transient + invalid) {
    return { kind: "INVALID", latencyMs, reason: "INVALID_TOKEN" };
  }
  return { kind: "ACCEPTED", latencyMs };
}

function buildCapacityProviderSender({
  profile,
  attemptCount = 10_000,
  elapsedMs = () => 0,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  nextAttemptIndex = (() => {
    let index = 0;
    return () => index++;
  })(),
  observeResult = () => {},
} = {}) {
  return async function sendCapacityNotification() {
    const attemptIndex = nextAttemptIndex();
    const result = providerResultForAttempt({
      profile,
      attemptIndex,
      attemptCount,
      elapsedMs: elapsedMs(),
    });
    observeResult({ attemptIndex, attemptCount, result });
    await sleep(result.latencyMs);
    if (result.kind === "ACCEPTED") {
      return {
        success: true,
        providerMessageId: `capacity-${attemptIndex}`,
        environment: "capacity",
      };
    }
    if (result.kind === "INVALID") {
      return {
        success: false,
        statusCode: 410,
        reason: "Unregistered",
        unregistered: true,
        invalidToken: true,
        permanent: true,
        environment: "capacity",
      };
    }
    return {
      success: false,
      statusCode: result.kind === "THROTTLED" ? 429 : 503,
      reason: result.reason,
      ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
      environment: "capacity",
    };
  };
}

function assertPercentiles(name, actual, limits) {
  if (!actual || actual.p95 == null || actual.p99 == null ||
      !Number.isFinite(Number(actual.p95)) || !Number.isFinite(Number(actual.p99)) ||
      Number(actual.p95) > limits.p95 || Number(actual.p99) > limits.p99) {
    throw new Error(`global-event capacity gate failed: ${name}`);
  }
}

function assertSustainedBackgroundLoad(background, durationSeconds = 720) {
  for (const [name, expectedRate] of [["authenticatedHttp", 25], ["resolutionJobs", 50]]) {
    const producer = background?.[name];
    if (!producer || !Array.isArray(producer.buckets) || producer.buckets.length !== durationSeconds) {
      throw new Error(`global-event capacity gate failed: ${name} per-second evidence`);
    }
    for (let second = 0; second < durationSeconds; second += 1) {
      const bucket = producer.buckets[second];
      if (Number(bucket?.second) !== second || Number(bucket?.offered) !== expectedRate ||
          Number(bucket?.completedSuccessful) !== expectedRate || Number(bucket?.failed) !== 0) {
        throw new Error(`global-event capacity gate failed: ${name} second ${second}`);
      }
    }
  }
  return true;
}

function assertGlobalEventCapacityGates(evidence = {}) {
  if (![HEALTHY_PROFILE, OUTAGE_PROFILE, PROVISIONING_PROFILE].includes(evidence.profile)) {
    throw new Error("global-event capacity gate failed: unknown profile");
  }
  if (evidence.fixtureUsers !== 10_000 || evidence.repetitions !== 3) {
    throw new Error("global-event capacity gate failed: incomplete fixture/repetitions");
  }
  assertSustainedBackgroundLoad(evidence.background);
  const infra = evidence.infrastructure || {};
  const requiredInfrastructure = [
    "cronRssBytes", "dbPoolWaitP99Ms", "lockWaitP99Ms", "warmupHttpP95Ms",
    "measuredHttpP95Ms", "unrelatedQueueLagIncreaseMs", "poolExhaustions",
    "maxEventLoopStallMs",
  ];
  if (requiredInfrastructure.some((name) => infra[name] == null || !Number.isFinite(Number(infra[name])))) {
    throw new Error("global-event capacity gate failed: incomplete infrastructure telemetry");
  }
  if (Number(infra.cronRssBytes) >= 512 * 1024 * 1024) throw new Error("global-event capacity gate failed: cron RSS");
  if (infra.processCeilingsOk !== true) throw new Error("global-event capacity gate failed: process RSS ceiling");
  if (Number(infra.dbPoolWaitP99Ms) > 100) throw new Error("global-event capacity gate failed: DB pool wait");
  if (Number(infra.lockWaitP99Ms) > 100) throw new Error("global-event capacity gate failed: lock wait");
  if (Number(infra.measuredHttpP95Ms) > Number(infra.warmupHttpP95Ms) * 1.2) throw new Error("global-event capacity gate failed: HTTP p95 degradation");
  if (Number(infra.unrelatedQueueLagIncreaseMs) > 2_000) throw new Error("global-event capacity gate failed: unrelated queue lag");
  if (Number(infra.poolExhaustions) !== 0) throw new Error("global-event capacity gate failed: pool exhaustion");
  if (Number(infra.maxEventLoopStallMs) > 250) throw new Error("global-event capacity gate failed: event-loop stall");
  if (infra.sawtoothDetected !== false) throw new Error("global-event capacity gate failed: one-minute/15-second sawtooth");

  if (evidence.profile === PROVISIONING_PROFILE) {
    const provisioning = evidence.provisioning || {};
    if (Number(provisioning.entitlements) !== 10_000 ||
        Number(provisioning.domainEvents) !== 10_000 ||
        Number(provisioning.schedules) !== 10_000) {
      throw new Error("global-event capacity gate failed: provisioning census");
    }
    if (Number(provisioning.completedSeconds) > 600) throw new Error("global-event capacity gate failed: provisioning deadline");
    if (Number(provisioning.maxProjectionDelaySeconds) > 300) throw new Error("global-event capacity gate failed: projection deadline");
    if (Number(provisioning.minimumLeadSeconds) < 43_200) throw new Error("global-event capacity gate failed: planning lead time");
    return true;
  }

  assertPercentiles("activation latency", evidence.stages?.activationMs, { p95: 2_000, p99: 5_000 });
  assertPercentiles("materialization latency", evidence.stages?.materializationMs, { p95: 1_000, p99: 3_000 });
  assertPercentiles("submission latency", evidence.stages?.submissionMs, { p95: 5_000, p99: 10_000 });
  if (evidence.profile === HEALTHY_PROFILE) {
    const provider = evidence.providerCensus || {};
    const initial = provider.initialCycle || {};
    if (provider.profile !== HEALTHY_PROFILE || Number(provider.attemptCount) !== 12_000 ||
        Number(provider.totalCalls) < 12_000 || Number(initial.total) !== 12_000 ||
        Number(initial.accepted) !== 11_904 || Number(initial.throttled) !== 60 ||
        Number(initial.transient) !== 24 || Number(initial.invalid) !== 12) {
      throw new Error("global-event capacity gate failed: deterministic provider disposition census");
    }
    assertPercentiles("adapter acceptance latency", evidence.stages?.adapterMs, { p95: 500, p99: 2_000 });
    assertPercentiles("provider acceptance latency", evidence.stages?.acceptanceMs, { p95: 5_000, p99: 10_000 });
  } else if (evidence.outage?.recovered !== true) {
    throw new Error("global-event capacity gate failed: outage recovery");
  }
  const complete = evidence.completeness || {};
  if (Number(complete.eligible) !== 10_000) throw new Error("global-event capacity gate failed: eligible census");
  if (Number(complete.eligible) !== Number(complete.materializedSchedules)) throw new Error("global-event capacity gate failed: materialized schedule completeness");
  if (Number(complete.eligible) !== Number(complete.alerts)) throw new Error("global-event capacity gate failed: alert completeness");
  if (Number(complete.eligible) !== Number(complete.outboxes)) throw new Error("global-event capacity gate failed: push outbox completeness");
  if (Number(complete.cancelledEligible) !== 0) throw new Error("global-event capacity gate failed: eligible schedule cancellation");
  if (Number(complete.snappedTargets) !== 12_000) throw new Error("global-event capacity gate failed: target census");
  if (Number(complete.snappedTargets) !== Number(complete.terminalTargets)) throw new Error("global-event capacity gate failed: target completeness");
  if (Number(complete.rowLocalFailures) !== 0) throw new Error("global-event capacity gate failed: row-local corruption");
  if (Number(complete.oldestPendingMs) > 30_000) throw new Error("global-event capacity gate failed: oldest pending work");
  return true;
}

function aggregateGlobalEventCapacityEvidence(repetitions = []) {
  if (!Array.isArray(repetitions) || repetitions.length !== 3) {
    throw new Error("global-event capacity evidence requires three clean repetitions");
  }
  const profile = repetitions[0]?.profile;
  const runId = repetitions[0]?.runId;
  const repeats = repetitions.map((item) => Number(item?.repeat)).sort((left, right) => left - right);
  if (!runId || new Set(repetitions.map((item) => item?.runId)).size !== 1 ||
      repeats.join(",") !== "1,2,3") {
    throw new Error("global-event capacity repetitions have invalid run/repeat provenance");
  }
  for (const evidence of repetitions) {
    if (evidence?.profile !== profile) throw new Error("global-event capacity repetitions must use one profile");
    const metrics = evidence.infrastructure?.metricsProvenance;
    if (metrics?.runId !== runId || metrics?.profile !== profile ||
        Number(metrics?.repeat) !== Number(evidence.repeat)) {
      throw new Error("global-event capacity repetition metrics provenance mismatch");
    }
    assertGlobalEventCapacityGates({ ...evidence, repetitions: 3 });
  }
  const maximum = (path) => Math.max(...repetitions.map((item) => {
    let value = item;
    for (const key of path) value = value?.[key];
    return Number(value);
  }));
  const minimum = (path) => Math.min(...repetitions.map((item) => {
    let value = item;
    for (const key of path) value = value?.[key];
    return Number(value);
  }));
  const latency = (name) => repetitions[0].stages?.[name] == null ? null : ({
    p95: maximum(["stages", name, "p95"]),
    p99: maximum(["stages", name, "p99"]),
  });
  const ratioEvidence = [...repetitions].sort((left, right) =>
    Number(right.infrastructure.measuredHttpP95Ms) / Number(right.infrastructure.warmupHttpP95Ms) -
    Number(left.infrastructure.measuredHttpP95Ms) / Number(left.infrastructure.warmupHttpP95Ms)
  )[0];
  return {
    profile,
    runId,
    fixtureUsers: 10_000,
    repetitions: 3,
    background: repetitions[0].background,
    stages: {
      activationMs: latency("activationMs"),
      materializationMs: latency("materializationMs"),
      submissionMs: latency("submissionMs"),
      adapterMs: latency("adapterMs"),
      acceptanceMs: latency("acceptanceMs"),
    },
    provisioning: {
      entitlements: minimum(["provisioning", "entitlements"]),
      domainEvents: minimum(["provisioning", "domainEvents"]),
      schedules: minimum(["provisioning", "schedules"]),
      completedSeconds: maximum(["provisioning", "completedSeconds"]),
      maxProjectionDelaySeconds: maximum(["provisioning", "maxProjectionDelaySeconds"]),
      minimumLeadSeconds: minimum(["provisioning", "minimumLeadSeconds"]),
    },
    completeness: {
      eligible: maximum(["completeness", "eligible"]),
      materializedSchedules: minimum(["completeness", "materializedSchedules"]),
      alerts: minimum(["completeness", "alerts"]),
      outboxes: minimum(["completeness", "outboxes"]),
      cancelledEligible: maximum(["completeness", "cancelledEligible"]),
      snappedTargets: maximum(["completeness", "snappedTargets"]),
      terminalTargets: minimum(["completeness", "terminalTargets"]),
      rowLocalFailures: maximum(["completeness", "rowLocalFailures"]),
      oldestPendingMs: maximum(["completeness", "oldestPendingMs"]),
    },
    infrastructure: {
      cronRssBytes: maximum(["infrastructure", "cronRssBytes"]),
      processCeilingsOk: repetitions.every((item) => item.infrastructure.processCeilingsOk === true),
      dbPoolWaitP99Ms: maximum(["infrastructure", "dbPoolWaitP99Ms"]),
      lockWaitP99Ms: maximum(["infrastructure", "lockWaitP99Ms"]),
      warmupHttpP95Ms: Number(ratioEvidence.infrastructure.warmupHttpP95Ms),
      measuredHttpP95Ms: Number(ratioEvidence.infrastructure.measuredHttpP95Ms),
      unrelatedQueueLagIncreaseMs: maximum(["infrastructure", "unrelatedQueueLagIncreaseMs"]),
      poolExhaustions: maximum(["infrastructure", "poolExhaustions"]),
      maxEventLoopStallMs: maximum(["infrastructure", "maxEventLoopStallMs"]),
      sawtoothDetected: repetitions.some((item) => item.infrastructure.sawtoothDetected === true),
    },
    outage: {
      recovered: repetitions.every((item) => item.outage?.recovered === true),
      expiredExplicitly: maximum(["outage", "expiredExplicitly"]),
    },
    providerCensus: repetitions[0].providerCensus || null,
    repeatEvidence: repetitions,
  };
}

module.exports = {
  EVENT_OPEN_PROFILE,
  HEALTHY_PROFILE,
  OUTAGE_PROFILE,
  PROVISIONING_PROFILE,
  assertGlobalEventCapacityGates,
  assertSustainedBackgroundLoad,
  aggregateGlobalEventCapacityEvidence,
  buildCapacityProviderSender,
  globalEventFixtureCensus,
  installationCountForUser,
  providerResultForAttempt,
  raceCountForUser,
};
