const { BOTTLENECKS, FAILURE_REASONS } = require("./contracts");

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function failure(reason, observed, threshold, unit) {
  return { reason, detail: { observed, threshold, unit } };
}

function classifyAttempt(evidence = {}, config = {}) {
  const thresholds = config.thresholds || {};
  const failures = [];
  if (evidence.timedOut === true) failures.push(failure("timeout", true, false, "boolean"));
  if (!finite(evidence.homeP95Ms) || !finite(evidence.homeP99Ms) ||
      !finite(evidence.httpErrorRate) || !finite(evidence.networkErrors) ||
      !finite(evidence.incompleteHomeTransactions) || !finite(evidence.droppedArrivals) ||
      !finite(evidence.workerRestarts) || !finite(evidence.databaseConnectionsExhausted) ||
      evidence.targetIdentityValid !== true) {
    failures.push(failure("unknown", "missing", "finite evidence", "evidence"));
  } else {
    if (evidence.homeP95Ms > thresholds.homeP95Ms) {
      failures.push(failure("home_p95_threshold", evidence.homeP95Ms, thresholds.homeP95Ms, "ms"));
    }
    if (evidence.homeP99Ms > thresholds.homeP99Ms) {
      failures.push(failure("home_p99_threshold", evidence.homeP99Ms, thresholds.homeP99Ms, "ms"));
    }
    if (evidence.httpErrorRate >= thresholds.httpErrorRate) {
      failures.push(failure("http_error_rate", evidence.httpErrorRate, thresholds.httpErrorRate, "ratio"));
    }
    if (evidence.networkErrors > thresholds.networkErrors) {
      failures.push(failure("network_errors", evidence.networkErrors, thresholds.networkErrors, "count"));
    }
    if (evidence.incompleteHomeTransactions > thresholds.incompleteHomeTransactions) {
      failures.push(failure("incomplete_home_transactions", evidence.incompleteHomeTransactions,
        thresholds.incompleteHomeTransactions, "count"));
    }
    if (evidence.droppedArrivals > thresholds.droppedArrivals) {
      failures.push(failure("dropped_arrivals", evidence.droppedArrivals,
        thresholds.droppedArrivals, "count"));
    }
    if (evidence.workerRestarts > thresholds.workerRestarts) {
      failures.push(failure("worker_restart", evidence.workerRestarts, thresholds.workerRestarts, "count"));
    }
    if (evidence.databaseConnectionsExhausted > thresholds.databaseConnectionsExhausted) {
      failures.push(failure("db_connection_exhaustion", evidence.databaseConnectionsExhausted,
        thresholds.databaseConnectionsExhausted, "count"));
    }
    if (thresholds.queueGrowth !== "baseline-required") {
      if (!finite(evidence.queueGrowth)) failures.push(failure("unknown", "missing", "finite queue growth", "evidence"));
      else if (evidence.queueGrowth > thresholds.queueGrowth) {
        failures.push(failure("queue_growth", evidence.queueGrowth, thresholds.queueGrowth, "items_per_second"));
      }
    }
    if (thresholds.resourceSafety !== "baseline-required") {
      if (!finite(evidence.resourceSafety)) failures.push(failure("unknown", "missing", "finite resource safety", "evidence"));
      else if (evidence.resourceSafety > thresholds.resourceSafety) {
        failures.push(failure("resource_safety_threshold", evidence.resourceSafety,
          thresholds.resourceSafety, "ratio"));
      }
    }
  }
  const distinct = [...new Set(failures.map((row) => row.reason))];
  const failureReason = distinct.length === 0 ? null : distinct.length === 1 ? distinct[0] : "multiple";
  if (failureReason != null && !FAILURE_REASONS.includes(failureReason)) {
    throw new Error(`unsupported failure reason: ${failureReason}`);
  }
  return {
    outcome: failures.length ? "FAIL" : "PASS",
    failedReasons: distinct,
    failureReason,
    failureReasonDetail: distinct.length === 1 ? failures.find((row) => row.reason === distinct[0]).detail : null,
    passedSafeCapacityGates: failures.length === 0 && evidence.safeCapacityGatesPassed === true,
    evidence,
  };
}

function classifyRate(attempts = []) {
  if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > 3 ||
      attempts.some((row) => !["PASS", "FAIL"].includes(row?.outcome))) {
    throw new Error("rate classification requires one through three PASS/FAIL attempts");
  }
  const passes = attempts.filter((row) => row.outcome === "PASS").length;
  const failures = attempts.length - passes;
  const unstable = passes > 0 && failures > 0;
  if (attempts.length === 1 && passes === 1) {
    return { state: "PASS", passes, failures, unstable: false, decided: true };
  }
  if (attempts.length < 2 || attempts.length === 2 && passes === failures) {
    return { state: "UNSTABLE", passes, failures, unstable, decided: false };
  }
  if (failures >= 2) return { state: "FAIL", passes, failures, unstable, decided: true };
  if (passes >= 2) return { state: "PASS", passes, failures, unstable, decided: true };
  return { state: "UNSTABLE", passes, failures, unstable, decided: false };
}

function inferPrimaryBottleneck(evidence = {}) {
  const resource = evidence.resources || {};
  const candidates = [];
  if (resource.generatorSaturated === true || Number(evidence.droppedArrivals) > 0) candidates.push("generator");
  if (Number(resource.postgresCpuPercent) >= 90 && resource.topSqlMaterial === true &&
      Number(resource.nodeCpuPercent || 0) < 85 && resource.generatorSaturated !== true) candidates.push("postgres");
  if ((Number(resource.nodeCpuPercent) >= 90 || Number(resource.eventLoopP99Ms) >= 1000) &&
      Number(resource.postgresCpuPercent || 0) < 85) candidates.push("node");
  if (Number(resource.dbPoolWaitP99Ms) >= 100 || Number(evidence.databaseConnectionsExhausted) > 0) candidates.push("db_pool");
  if (Number(resource.redisLatencyP99Ms) >= 25 || Number(resource.redisBlockedClients) > 0 ||
      Number(resource.redisEvictions) > 0) candidates.push("redis");
  if (Number(evidence.queueGrowth) > 0 && Number(resource.queueProcessRate) < Number(resource.queueInsertRate)) {
    candidates.push("queue");
  }
  const distinct = [...new Set(candidates)];
  const result = distinct.length === 0 ? "inconclusive" : distinct.length === 1 ? distinct[0] : "multiple";
  if (!BOTTLENECKS.includes(result)) throw new Error(`unsupported bottleneck: ${result}`);
  return result;
}

function aggregateFailure(attempts) {
  const failed = attempts.filter((row) => row.outcome === "FAIL");
  const reasons = [...new Set(failed.flatMap((row) => row.failedReasons || []))];
  return {
    failureReason: reasons.length === 0 ? "unknown" : reasons.length === 1 ? reasons[0] : "multiple",
    failureReasonDetail: reasons.length === 1
      ? failed.find((row) => row.failureReason === reasons[0])?.failureReasonDetail || null
      : null,
    primaryBottleneck: inferPrimaryBottleneck(failed.at(-1)?.evidence || {}),
  };
}

async function runScan({ config, executeRate, onEvent = () => {} } = {}) {
  if (!config?.scan || typeof executeRate !== "function") throw new Error("scan requires config and executor");
  const rates = config.scan.rates;
  const records = new Map();
  let highestPassingRate = null;
  let firstFailingRate = null;

  const runAttempt = async (rate, purpose) => {
    onEvent({ type: "attempt_started", rate, purpose });
    const attempt = await executeRate({ rate, purpose, attempt: (records.get(rate)?.attempts.length || 0) + 1 });
    if (!attempt || !["PASS", "FAIL"].includes(attempt.outcome)) {
      throw new Error("rate executor returned an invalid attempt");
    }
    const record = records.get(rate) || { rate, attempts: [] };
    record.attempts.push(attempt); records.set(rate, record);
    onEvent({ type: "attempt_finished", rate, purpose, outcome: attempt.outcome });
    return attempt;
  };

  const classifyBoundaryCandidate = async (rate, purpose) => {
    const record = records.get(rate) || { rate, attempts: [] }; records.set(rate, record);
    if (record.attempts.length === 0) await runAttempt(rate, purpose);
    let vote = classifyRate(record.attempts);
    if (record.attempts[0].outcome === "FAIL" && !vote.decided) {
      await runAttempt(rate, "failure_confirmation"); vote = classifyRate(record.attempts);
      if (!vote.decided) {
        onEvent({ type: "rate_unstable", rate, ...vote });
        await runAttempt(rate, "failure_confirmation"); vote = classifyRate(record.attempts);
      }
    }
    record.classification = vote;
    return vote;
  };

  for (const rate of rates) {
    const vote = await classifyBoundaryCandidate(rate, "discovery");
    if (vote.state === "PASS") { highestPassingRate = rate; continue; }
    if (vote.state === "FAIL") { firstFailingRate = rate; break; }
  }

  if (highestPassingRate != null && firstFailingRate != null) {
    while (firstFailingRate - highestPassingRate > config.scan.narrowingResolutionPerSecond) {
      const rate = Math.floor((highestPassingRate + firstFailingRate) / 2);
      const vote = await classifyBoundaryCandidate(rate, "boundary_narrowing");
      if (vote.state === "PASS") highestPassingRate = rate;
      else firstFailingRate = rate;
    }
  }

  const result = {
    highestPassingRate,
    firstFailingRate,
    rateClassifications: [],
    headroomPolicy: config.safeCapacity.headroomFactor,
    calculatedHeadroomTarget: null,
    safeCapacityCandidateTested: null,
    safeCapacityCandidates: [],
    safeHomeOpensPerSecond: null,
    safeCapacityUnavailableReason: null,
    failureReason: null,
    failureReasonDetail: null,
    primaryBottleneck: "inconclusive",
  };

  if (firstFailingRate != null) {
    Object.assign(result, aggregateFailure(records.get(firstFailingRate).attempts));
  }
  if (highestPassingRate != null && firstFailingRate != null &&
      [config.thresholds.queueGrowth, config.thresholds.resourceSafety].includes("baseline-required")) {
    result.safeCapacityUnavailableReason = "safe_gate_baseline_required";
  } else if (highestPassingRate != null && firstFailingRate != null) {
    const target = Number((highestPassingRate * config.safeCapacity.headroomFactor).toFixed(6));
    const initial = Math.min(highestPassingRate, Math.ceil(target));
    result.calculatedHeadroomTarget = target;
    result.safeCapacityCandidateTested = initial;
    for (let candidate = initial; candidate >= 1;
      candidate -= config.safeCapacity.fallbackStepPerSecond) {
      let attempt = records.get(candidate)?.attempts.find((row) =>
        row.outcome === "PASS" && row.passedSafeCapacityGates === true);
      const evidenceReused = Boolean(attempt);
      if (!attempt) attempt = await executeRate({ rate: candidate, purpose: "safe_capacity", attempt: 1 });
      const passed = attempt?.outcome === "PASS" && attempt.passedSafeCapacityGates === true;
      result.safeCapacityCandidates.push({ rate: candidate, passedSafeCapacityGates: passed,
        evidenceReused, binding: attempt?.evidence?.binding || null });
      if (passed) { result.safeHomeOpensPerSecond = candidate; break; }
    }
  }

  result.rateClassifications = [...records.values()].sort((a, b) => a.rate - b.rate).map((record) => ({
    rate: record.rate,
    ...(record.classification || classifyRate(record.attempts)),
    attempts: record.attempts.map((attempt) => ({ outcome: attempt.outcome,
      failureReason: attempt.failureReason, passedSafeCapacityGates: attempt.passedSafeCapacityGates })),
  }));
  return result;
}

module.exports = { classifyAttempt, classifyRate, inferPrimaryBottleneck, runScan };
