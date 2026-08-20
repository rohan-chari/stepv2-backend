#!/usr/bin/env node

// PM2 capacity entrypoint. The production evidence .env is never sourced.
// Only the separately generated effective environment may reach this process,
// and it is validated before any application module or provider singleton loads.

const {
  loadCapacityEffectiveEnvironment,
} = require("./capacity-effective-env");
const {
  removeOwnWorkerAttestation,
  writeWorkerAttestation,
} = require("./capacity-attestation");

async function main() {
  loadCapacityEffectiveEnvironment();

  const {
    assertCapacityDatabaseMarker,
    prepareLocalCapacityProcess,
  } = require("../../src/localCapacitySafety");
  await assertCapacityDatabaseMarker();
  const safety = prepareLocalCapacityProcess();

  const {
    installProductionShutdownHandlers,
    startServer,
  } = require("../../src/index");
  // src/index.js retains the normal dotenv bootstrap for every non-capacity
  // entrypoint. Revalidate after importing it so a checkout-local fallback
  // .env can never add an outbound credential or redirect this process after
  // the protected effective environment was proved.
  const postImportSafety = prepareLocalCapacityProcess();
  process.title = `steptracker-capacity-worker-${process.env.NODE_APP_INSTANCE}`;
  const { output: attestationPath, attestation } = writeWorkerAttestation();
  process.once("exit", () => {
    removeOwnWorkerAttestation(attestationPath, process.pid);
  });
  const server = startServer({ capacityHttpResolutionOnly: true });
  if (process.env.NODE_ENV === "production") {
    installProductionShutdownHandlers({ server });
  }
  console.log(JSON.stringify({
    event: "capacity_backend_started",
    runId: safety.runId,
    databaseHost: safety.database.host,
    databaseName: safety.database.name,
    nodeAppInstance: process.env.NODE_APP_INSTANCE ?? null,
    databasePoolMax: safety.databasePoolMax,
    commitSha: attestation.commitSha,
    effectiveEnvSha256: attestation.effectiveEnvSha256,
    runtimeFingerprint: attestation.runtimeFingerprint,
    attestationSchemaVersion: attestation.schemaVersion,
    notificationSink:
      safety.notificationSink.localCapacitySink &&
      postImportSafety.notificationSink.localCapacitySink,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "capacity_backend_start_failed",
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
