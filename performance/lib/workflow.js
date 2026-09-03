const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { classifyAttempt, runScan } = require("./evaluate");
const { runLevel, runtimeSummary, RUNTIME_CATEGORIES } = require("./lifecycle");
const { buildSummary, renderReport, writeReports } = require("./report");

function runId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase();
  return `perf-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function commitFor(repository) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository,
    encoding: "utf8", timeout: 10_000 }).trim(); }
  catch { return "unknown"; }
}

function effectiveMeasurementSeconds(config, rate, purpose) {
  const configured = purpose === "smoke"
    ? config.smoke.measurementSeconds : config.scan.measurementSeconds;
  if (config.workload?.name !== "authenticated-races-tab-reveal-v1" ||
      config.workload?.profileVersion !== "2.0.0") return configured;
  return Math.max(configured,
    Math.ceil(Number(config.workload.minimumMeasuredSessions) / Number(rate)));
}

async function runPerformanceWorkflow({ repository, cli, config, provider, workload,
  writeResult = true, now = Date.now, output = process.stdout, insideProviderLock = false,
  workflowStartedAt = null, getInterruption = () => null } = {}) {
  if (!repository || !cli || !config || !provider || !workload) {
    throw new Error("performance workflow requires repository, CLI, config, provider, and workload");
  }
  if (!insideProviderLock && typeof provider.runExclusive === "function") {
    const startedAt = workflowStartedAt ?? now();
    try {
      return await provider.runExclusive({ cli, config }, () => runPerformanceWorkflow({ repository, cli,
        config, provider, workload, writeResult, now, output, insideProviderLock: true,
        workflowStartedAt: startedAt, getInterruption }));
    } catch (error) {
      const failedProvider = { ...provider, runExclusive: undefined,
        prepare: async () => { throw error; } };
      return runPerformanceWorkflow({ repository, cli, config, provider: failedProvider,
        workload, writeResult, now, output, insideProviderLock: true,
        workflowStartedAt: startedAt, getInterruption });
    }
  }
  const startedAt = workflowStartedAt ?? now();
  const id = runId(new Date(startedAt));
  const breakdown = Object.fromEntries(RUNTIME_CATEGORIES.map((name) => [name, 0]));
  const interruptionError = () => {
    const signal = getInterruption();
    if (!signal) return null;
    const error = new Error(`performance workflow interrupted by ${signal}`);
    error.name = "InterruptionError";
    error.stage = "interruption";
    return error;
  };
  const time = async (category, operation) => {
    const started = now();
    try {
      const before = interruptionError();
      if (before) throw before;
      const value = await operation();
      const after = interruptionError();
      if (after) throw after;
      return value;
    }
    finally { breakdown[category] += Math.max(0, (now() - started) / 1000); }
  };
  const levels = [];
  let environment;
  let fixtures;
  let scan;
  let cleanupError = null;
  let workflowError = null;
  try {
    await time("environmentPreparation", async () => {
      environment = await provider.prepare({ runId: id, cli, config });
      return environment;
    });
    if (typeof provider.deleteExactRaceListCache === "function") {
      environment.deleteExactRaceListCache = (input) => provider.deleteExactRaceListCache(input);
    }
    await time("workflowValidation", () => provider.validate({ runId: id, cli, config, environment }));
    fixtures = await time("environmentPreparation", () =>
      workload.prepareFixtures({ runId: id, cli, config, environment }));
    if (config.workload?.name === "authenticated-races-tab-reveal-v1") {
      if (typeof provider.verifyRacesTabSettings !== "function") {
        throw new Error("Races-tab workload requires both-worker pinned-setting verification");
      }
      fixtures.topology.workerSettingsReadiness = await time("workflowValidation", () =>
        provider.verifyRacesTabSettings({ environment, config }));
    }
    if (cli.cache === "warm") {
      await time("initialPrewarm", () => workload.initialPrewarm({ runId: id, cli, config,
        environment, fixtures, seconds: config.cache.initialPrewarmSeconds }));
    }
    const executeRate = async ({ rate, purpose, attempt }) => {
      output.write(`Testing ${rate}/sec${purpose === "failure_confirmation" ? " (confirmation)" : ""}...\n`);
      const measurementSeconds = effectiveMeasurementSeconds(config, rate, purpose);
      const level = await runLevel({ rate, cacheMode: cli.cache,
        warmupSeconds: cli.cache === "warm" ?
          (purpose === "smoke" ? config.smoke.warmupSeconds : config.scan.warmupSeconds) : 0,
        ceremonyTargetSeconds: config.runtime.perLevelCeremonyTargetSeconds,
        operations: {
          settle: () => provider.settle({ environment, config }),
          targetedReset: () => workload.targetedReset({ rate, purpose, attempt, environment,
            fixtures, config, deleteExactRaceListCache: environment.deleteExactRaceListCache }),
          liveness: () => provider.liveness({ environment, config }),
          warmup: ({ warmupSeconds }) => workload.warmup({ rate, warmupSeconds,
            measurementSeconds, purpose, environment, fixtures, config }),
          nonCacheFillingStabilize: () => provider.liveness({ environment, config }),
          clearOwnedCache: () => provider.clearOwnedCache({ environment, config }),
          verifyOwnedCacheEmpty: () => provider.verifyOwnedCacheEmpty({ environment, config }),
          resetMetrics: () => provider.resetMetrics({ environment, config }),
          measure: () => workload.measure({ rate, purpose, attempt,
            measurementSeconds, environment, fixtures, config }),
          collectMetrics: () => provider.collectMetrics({ rate, purpose, attempt, environment, config }),
        }, now });
      breakdown.targetedResets += level.timings.targetedResetSeconds;
      breakdown.settlingDraining += level.timings.settlingDrainingSeconds +
        level.timings.livenessSeconds + (level.timings.nonCacheFillingStabilizeSeconds || 0);
      breakdown.settlingDraining += (level.timings.clearOwnedCacheSeconds || 0) +
        (level.timings.verifyOwnedCacheEmptySeconds || 0);
      breakdown.perLevelWarmups += level.timings.warmupSeconds;
      breakdown.metricsCollection += level.timings.metricsCollectionSeconds + level.timings.metricResetSeconds;
      const category = purpose === "failure_confirmation" ? "failureConfirmation" :
        purpose === "boundary_narrowing" ? "boundaryNarrowing" : "measuredLoad";
      breakdown[category] += level.timings.measurementSeconds;
      const classified = classifyAttempt({ ...level.measurement,
        resources: { ...(level.measurement?.resources || {}), ...(level.metrics?.resources || {}) } }, config);
      levels.push({ rate, purpose, attempt, configuredWarmupSeconds: level.configuredWarmupSeconds,
        configuredMeasurementSeconds: purpose === "smoke"
          ? config.smoke.measurementSeconds : config.scan.measurementSeconds,
        effectiveMeasurementSeconds: measurementSeconds,
        actualWarmupSeconds: level.actualWarmupSeconds,
        warmupBudgetWarning: level.actualWarmupSeconds > level.configuredWarmupSeconds,
        ceremonySeconds: level.ceremonySeconds, ceremonyBudgetWarning: level.ceremonyBudgetWarning,
        cacheConditioning: level.targetedReset?.cacheConditioning || null,
        ...level.measurement, outcome: classified.outcome });
      output.write(`${classified.outcome}\n`);
      return classified;
    };
    if (cli.command === "scan") {
      scan = await runScan({ config, executeRate, onEvent: (event) => {
        if (event.type === "rate_unstable") output.write(`${event.rate}/sec is unstable; running deciding repetition.\n`);
      } });
    } else if (cli.command === "smoke") {
      const attempt = await executeRate({ rate: config.smoke.rate, purpose: "smoke", attempt: 1 });
      scan = { highestPassingRate: attempt.outcome === "PASS" ? config.smoke.rate : null,
        firstFailingRate: attempt.outcome === "FAIL" ? config.smoke.rate : null,
        rateClassifications: [{ rate: config.smoke.rate, state: attempt.outcome,
          passes: attempt.outcome === "PASS" ? 1 : 0, failures: attempt.outcome === "FAIL" ? 1 : 0,
          unstable: false, attempts: [{ outcome: attempt.outcome }] }],
        headroomPolicy: null, calculatedHeadroomTarget: null, safeCapacityCandidateTested: null,
        safeCapacityCandidates: [], safeHomeOpensPerSecond: null, safeOperatingRate: null,
        safeOperatingRateUnit: cli.workload === "races-tab-open"
          ? "races_tab_opens_per_second" : "home_opens_per_second",
        failureReason: attempt.failureReason, failureReasonDetail: attempt.failureReasonDetail,
        primaryBottleneck: attempt.outcome === "FAIL" ? require("./evaluate").inferPrimaryBottleneck(attempt.evidence) : "inconclusive" };
    } else {
      throw new Error(`${cli.command} is not enabled in the first-run workflow`);
    }
    if (typeof workload.verifyFixtures === "function") {
      await time("workflowValidation", () => workload.verifyFixtures({
        runId: id, cli, config, environment, fixtures,
      }));
    }
  } catch (error) {
    workflowError = error;
  } finally {
    if (!cli.keepRunning && environment) {
      const cleanupStartedAt = now();
      try { await (async () => {
        const errors = [];
        if (typeof workload.cleanup === "function") {
          try { await workload.cleanup({ environment, fixtures, config }); }
          catch (error) { errors.push(error); }
        }
        try { await provider.cleanup({ environment, config }); }
        catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "performance cleanup failed");
      })(); }
      catch (error) { cleanupError = error; }
      finally { breakdown.cleanup += Math.max(0, (now() - cleanupStartedAt) / 1000); }
    }
  }
  workflowError ||= interruptionError();
  if (workflowError && cleanupError) {
    workflowError = new AggregateError([workflowError, ...(cleanupError.errors || [cleanupError])],
      `performance workflow and cleanup failed: ${workflowError.message}`);
  } else if (!workflowError && cleanupError) workflowError = cleanupError;
  scan ||= { highestPassingRate: null, firstFailingRate: null, rateClassifications: [],
    headroomPolicy: config.safeCapacity?.headroomFactor ?? null,
    calculatedHeadroomTarget: null, safeCapacityCandidateTested: null,
    safeCapacityCandidates: [], safeHomeOpensPerSecond: null,
    safeOperatingRate: null, safeOperatingRateUnit: cli.workload === "races-tab-open"
      ? "races_tab_opens_per_second" : "home_opens_per_second",
    safeCapacityUnavailableReason: workflowError ? "workflow_failed" : null,
    failureReason: workflowError ? "unknown" : null, failureReasonDetail: null,
    primaryBottleneck: "inconclusive" };
  if (workflowError) {
    scan.safeOperatingRate = null;
    scan.safeHomeOpensPerSecond = null;
    scan.safeCapacityUnavailableReason = "workflow_failed";
  }
  const accounted = () => Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const wallBeforeReport = Math.max(0, (now() - startedAt) / 1000);
  breakdown.workflowValidation += Math.max(0, wallBeforeReport - accounted());
  let runtime = runtimeSummary(breakdown, {
    targetSeconds: config.scan.preparedRuntimeTargetSeconds,
    warningSeconds: config.scan.runtimeWarningSeconds,
  });
  const safeError = workflowError ? { name: workflowError.name || "Error",
    message: String(workflowError.message || "workflow failed").slice(0, 1000),
    stage: workflowError.stage || (environment ? "workflow" : "environment_preparation") } : null;
  const input = { runId: id, status: workflowError ? "failed" : "completed", error: safeError,
    startedAt: new Date(startedAt).toISOString(), endedAt: new Date(now()).toISOString(),
    mode: cli.command, commit: commitFor(repository), effectiveConfig: config,
    dataset: environment?.datasetId || "unknown", backgroundMode: cli.background,
    cacheMode: cli.cache, workload: config.workload, environmentBinding: environment?.binding || null,
    topology: config.topology,
    fixtureProfile: fixtures?.topology || null,
    scan, runtime, levels,
    warnings: [cleanupError ? `Cleanup failed: ${cleanupError.message}` : null,
      ...levels.filter((row) => row.ceremonyBudgetWarning).map((row) =>
        `${row.rate}/sec ceremony exceeded ${config.runtime.perLevelCeremonyTargetSeconds}s`),
      ...levels.filter((row) => row.warmupBudgetWarning).map((row) =>
        `${row.rate}/sec warmup exceeded its configured budget`)]
      .filter(Boolean),
    limitations: ["Lima is regression evidence, not production certification.",
      ...(cli.workload === "races-tab-open" ? [
        ...(config.workload?.profileVersion === "2.0.0" ? [
          "CANCELLED tournaments are excluded because the current GET /races query omits them; this profile does not claim API-backed coverage for that app render branch.",
          "Review-opportunity and payout-double flows are off-screen and excluded from the Races-tab capacity gate.",
        ] : [
          "Historical profile 1.0.0 models only active-race count, zero-race users, and the zero-friends branch.",
        ]),
      ] : [])], };
  let reports;
  if (writeResult) {
    const directory = path.join(repository, "performance", "results", id);
    const started = now();
    const preliminary = buildSummary(input);
    JSON.stringify(preliminary); renderReport(preliminary);
    breakdown.reportGeneration += Math.max(0, (now() - started) / 1000);
    runtime = runtimeSummary(breakdown, {
      targetSeconds: config.scan.preparedRuntimeTargetSeconds,
      warningSeconds: config.scan.runtimeWarningSeconds,
    });
    input.runtime = runtime;
    reports = writeReports({ directory, input });
  } else reports = { summary: buildSummary(input), summaryPath: null, reportPath: null };
  return { ...reports, environment, fixtures, failed: Boolean(workflowError), error: workflowError };
}

module.exports = { effectiveMeasurementSeconds, runId, runPerformanceWorkflow };
