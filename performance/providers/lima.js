const {
  assertPerformanceDatabase,
  assertSafeTrafficTarget,
  assertTargetIdentity,
} = require("../lib/safety");

function requiredAdapterMethod(adapter, name) {
  return async (input) => {
    if (typeof adapter?.[name] !== "function") {
      throw new Error(`Lima provider adapter is missing ${name}`);
    }
    return adapter[name](input);
  };
}

/**
 * Provider-neutral workflow adapter for the guarded Lima implementation.
 * `prepareOnce` is the only operation allowed to create/restore services. All
 * methods used between rates intentionally expose only bounded, non-lifecycle
 * operations.
 */
function createLimaProvider({ adapter } = {}) {
  const call = (name) => requiredAdapterMethod(adapter, name);
  const validateResponses = (environment, result) => {
    if (!Array.isArray(result?.targetResponses) || result.targetResponses.length === 0) {
      throw new Error("performance target identity evidence is missing");
    }
    for (const response of result.targetResponses) {
      assertTargetIdentity({ expectedRunId: environment?.expectedRunId || environment?.runId,
        expectedAddress: environment?.expectedAddress || environment?.resolvedAddresses?.[0], response });
    }
    return result;
  };
  const provider = {
    async prepare(input) {
      if (input?.cli?.target !== "lima") throw new Error("Lima provider requires --target=lima");
      return call("prepareOnce")(input);
    },
    async validate(input) {
      const environment = input?.environment;
      assertSafeTrafficTarget({ baseUrl: environment?.baseUrl,
        resolvedAddresses: environment?.resolvedAddresses || ["127.0.0.1"], target: "lima" });
      assertPerformanceDatabase({ databaseUrl: environment?.databaseUrl, marker: environment?.marker });
      return validateResponses(environment, await call("validate")(input));
    },
    settle: call("settle"),
    async liveness(input) {
      return validateResponses(input?.environment, await call("liveness")(input));
    },
    resetMetrics: call("resetMetrics"),
    collectMetrics: call("collectMetrics"),
    clearOwnedCache: call("clearOwnedCache"),
    verifyOwnedCacheEmpty: call("verifyOwnedCacheEmpty"),
    cleanup: call("cleanup"),
  };
  if (typeof adapter?.runExclusive === "function") {
    provider.runExclusive = (input, operation) => adapter.runExclusive(input, operation);
  }
  if (typeof adapter?.resetEnvironment === "function") {
    provider.resetEnvironment = (input) => adapter.resetEnvironment(input);
  }
  for (const name of ["deleteExactRaceListCache", "verifyRacesTabSettings"]) {
    if (typeof adapter?.[name] === "function") provider[name] = call(name);
  }
  return provider;
}

module.exports = { createLimaProvider };
