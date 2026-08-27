#!/usr/bin/env node

// Protected entrypoint for every process in the production-shaped capacity
// cluster. The run-bound database marker and outbound brakes are validated
// before application/provider singletons load.

async function main() {
  const {
    assertCapacityDatabaseMarker,
    prepareLocalCapacityProcess,
  } = require("../src/localCapacitySafety");
  await assertCapacityDatabaseMarker();
  const safety = prepareLocalCapacityProcess();
  const { installProductionShutdownHandlers, startServer } = require("../src/index");
  // src/index retains dotenv startup for ordinary entrypoints. Revalidate after
  // importing it so a checkout-local .env cannot redirect this process.
  prepareLocalCapacityProcess();
  const role = process.env.STEPS_PROCESS_ROLE || "all";
  const eventProfiles = new Set([
    "event_provisioning_10000",
    "event_boundary_10000",
    "event_provider_outage_10000",
  ]);
  const capacityGlobalEventOnly = role === "cron" &&
    eventProfiles.has(process.env.CAPACITY_GLOBAL_EVENT_PROFILE);
  const server = startServer({ capacityGlobalEventOnly });
  installProductionShutdownHandlers({ server });
  console.log(JSON.stringify({
    event: "capacity_process_started",
    runId: safety.runId,
    role,
    capacityGlobalEventOnly,
    deterministicProvider: safety.notificationSink.deterministicProvider === true,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
