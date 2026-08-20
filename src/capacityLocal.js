async function startCapacityServer() {
  // This must run before index.js loads the app, event handlers, or push
  // singletons. The launcher also validates in the primary process, but keep
  // this guard here so invoking capacityLocal.js directly is equally safe.
  const {
    loadCapacityEffectiveEnvironment,
  } = require("../scripts/perf/capacity-effective-env");
  loadCapacityEffectiveEnvironment();
  const {
    assertCapacityDatabaseMarker,
    prepareLocalCapacityProcess,
  } = require("./localCapacitySafety");
  await assertCapacityDatabaseMarker();
  prepareLocalCapacityProcess();
  const {
    installProductionShutdownHandlers,
    startServer,
  } = require("./index");
  // Re-prove the runtime after index.js's normal dotenv bootstrap, and restore
  // the sink in case an application import touched either provider singleton.
  prepareLocalCapacityProcess();
  const server = startServer({ capacityHttpResolutionOnly: true });
  if (process.env.NODE_ENV === "production") {
    installProductionShutdownHandlers({ server });
  }
  return server;
}

if (require.main === module) {
  startCapacityServer().catch((error) => {
    console.error(`capacity backend startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { startCapacityServer };
