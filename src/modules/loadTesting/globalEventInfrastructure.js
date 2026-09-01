function percentile(values, quantile) {
  const finite = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return Number.NaN;
  return finite[Math.min(finite.length - 1, Math.ceil(finite.length * quantile) - 1)];
}

function periodicSpikes(values, periodSeconds) {
  const finite = values.filter((row) => Number.isFinite(Number(row.value)));
  if (finite.length < periodSeconds * 3) return false;
  const baseline = percentile(finite.map((row) => row.value), 0.5);
  const p95 = percentile(finite.map((row) => row.value), 0.95);
  const threshold = Math.max(baseline * 1.2, p95);
  const spikes = finite.filter((row) => Number(row.value) >= threshold && Number(row.value) > baseline);
  if (spikes.length < 3) return false;
  let matching = 0;
  for (let index = 1; index < spikes.length; index += 1) {
    const gap = (new Date(spikes[index].at).getTime() - new Date(spikes[index - 1].at).getTime()) / 1000;
    if (Math.abs(gap - periodSeconds) <= 2) matching += 1;
  }
  return matching >= 2;
}

function normalizeGlobalEventInfrastructure({
  metrics,
  requestSamples,
  eventStartsAt,
  expectedProfile,
  expectedRunId,
  expectedRepeat,
  measurementSeconds = 600,
} = {}) {
  if (metrics?.schema !== "capacity-metrics-v2" || !Array.isArray(metrics.samples)) {
    throw new Error("global-event infrastructure requires capacity-metrics-v2 evidence");
  }
  if (metrics.runId !== expectedRunId || metrics.profile !== expectedProfile ||
      Number(metrics.repeat) !== Number(expectedRepeat)) {
    throw new Error("global-event infrastructure metrics provenance does not match the requested run/profile/repeat");
  }
  const boundaryMs = new Date(eventStartsAt).getTime();
  if (!Number.isFinite(boundaryMs)) throw new Error("global-event infrastructure requires eventStartsAt");
  const warmupStartMs = boundaryMs - 120_000;
  const measuredEndMs = boundaryMs + Number(measurementSeconds) * 1000;
  const windowSamples = metrics.samples
    .filter((sample) => {
      const at = new Date(sample.at).getTime();
      return at >= warmupStartMs && at <= measuredEndMs + 1_500;
    })
    .sort((left, right) => new Date(left.at) - new Date(right.at));
  const warmupSamples = windowSamples.filter((sample) => new Date(sample.at).getTime() < boundaryMs);
  const measuredSamples = windowSamples.filter((sample) => new Date(sample.at).getTime() >= boundaryMs);
  if (warmupSamples.length < 118 || measuredSamples.length < Math.max(1, Number(measurementSeconds) - 2)) {
    throw new Error("global-event infrastructure health telemetry does not cover the full warmup/measured windows");
  }
  for (let index = 1; index < windowSamples.length; index += 1) {
    if (new Date(windowSamples[index].at).getTime() - new Date(windowSamples[index - 1].at).getTime() > 2_500) {
      throw new Error("global-event infrastructure health telemetry has a missing interval");
    }
  }
  for (const sample of windowSamples) {
    if (sample.databaseError) throw new Error("global-event infrastructure database telemetry failed");
    for (const role of ["http", "resolution", "cron"]) {
      if (!sample.health?.[role]?.capacity) {
        throw new Error(`global-event infrastructure ${role} health telemetry failed`);
      }
    }
  }
  const health = windowSamples.flatMap((sample) =>
    Object.values(sample.health || {}).filter((value) => value?.capacity)
      .map((value) => ({ at: sample.at, ...value.capacity })));
  const identities = new Set(health.map((row) =>
    `${row.process?.role || "unknown"}:${row.process?.instance ?? "unknown"}`));
  const ceilings = { http: 1200 * 1024 * 1024, resolution: 600 * 1024 * 1024, cron: 600 * 1024 * 1024 };
  const processCeilingsOk = ["http:0", "http:1", "resolution:0", "cron:0"]
    .every((identity) => identities.has(identity)) && health.every((row) =>
      Number(row.memory?.rss) < (ceilings[row.process?.role] || 0));
  if (!expectedProfile || !expectedRunId || health.length === 0 ||
      health.some((row) => row.globalEventProfile !== expectedProfile || row.runId !== expectedRunId)) {
    throw new Error("global-event infrastructure backend run/profile wiring does not match the requested identity");
  }
  for (const segment of [warmupSamples, measuredSamples]) {
    const segmentIdentities = new Set(segment.flatMap((sample) =>
      Object.values(sample.health || {}).filter((value) => value?.capacity)
        .map((value) => `${value.capacity.process?.role}:${value.capacity.process?.instance}`)));
    if (!["http:0", "http:1", "resolution:0", "cron:0"].every((identity) => segmentIdentities.has(identity))) {
      throw new Error("global-event infrastructure process census is incomplete in a measurement window");
    }
  }
  const cronRss = health.filter((row) => row.process?.role === "cron").map((row) => Number(row.memory?.rss));
  const waits = health.map((row) => Number(row.dbPool?.waitMsP99));
  const failures = health.map((row) => Number(row.dbPool?.connectionFailures));
  const stalls = health.map((row) => Number(row.eventLoop?.maxMs));
  const requests = (requestSamples || []).filter((row) => Number.isFinite(Number(row.completedAtMs)));
  const warmup = requests.filter((row) => Number(row.completedAtMs) < boundaryMs).map((row) => row.latencyMs);
  const measured = requests.filter((row) => Number(row.completedAtMs) >= boundaryMs).map((row) => row.latencyMs);
  const lagRows = windowSamples.map((row) => ({ at: row.at, value: Number(row.resolutionQueueLagMs) }));
  const warmupLag = lagRows.filter((row) => new Date(row.at).getTime() < boundaryMs).map((row) => row.value);
  const measuredLag = lagRows.filter((row) => new Date(row.at).getTime() >= boundaryMs).map((row) => row.value);
  const series = [
    lagRows,
    health.filter((row) => row.process?.role === "cron").map((row) => ({ at: row.at, value: row.memory?.rss })),
    health.map((row) => ({ at: row.at, value: row.eventLoop?.maxMs })),
  ];
  const providerCensus = health
    .filter((row) => row.process?.role === "cron" && row.providerCensus)
    .map((row) => row.providerCensus)
    .sort((left, right) => Number(right.initialCycle?.total) - Number(left.initialCycle?.total))[0] || null;
  return {
    cronRssBytes: Math.max(...cronRss),
    processCeilingsOk,
    dbPoolWaitP99Ms: Math.max(...waits),
    lockWaitP99Ms: windowSamples.some((row) => (row.lockWaitMs || []).length)
      ? percentile(windowSamples.flatMap((row) => row.lockWaitMs || []), 0.99)
      : 0,
    warmupHttpP95Ms: percentile(warmup, 0.95),
    measuredHttpP95Ms: percentile(measured, 0.95),
    unrelatedQueueLagIncreaseMs: Math.max(0, percentile(measuredLag, 0.95) - percentile(warmupLag, 0.95)),
    poolExhaustions: Math.max(...failures),
    maxEventLoopStallMs: Math.max(...stalls),
    sawtoothDetected: series.some((rows) => periodicSpikes(rows, 15) || periodicSpikes(rows, 60)),
    providerCensus,
    metricsProvenance: {
      runId: metrics.runId,
      profile: metrics.profile,
      repeat: Number(metrics.repeat),
    },
  };
}

module.exports = { normalizeGlobalEventInfrastructure, periodicSpikes };
