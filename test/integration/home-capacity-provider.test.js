const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dotenv = require("dotenv");

const { HARNESS_POLICY, buildWorkflowManifest, createSourceBundle, hashObject,
  validateSnapshotInputs } = require("../../scripts/home-capacity-workflow");
const { assertProviderIsolation, cleanupWorkflowEnvironment, prepareWorkflowEnvironment, providerResourceCensus,
  resetWorkflowChild, withProviderLock } = require("../../scripts/lima-capacity");
const { assertHomeCapacityParityOverlay } = require("../../src/modules/loadTesting/homeCapacityEnvironment");

const enabled = process.env.RUN_HOME_CAPACITY_PROVIDER_INTEGRATION === "true";

test("disposable Lima provider restores scrubbed Postgres, applies exact migrations, starts empty Redis, and reuses dependencies", {
  skip: !enabled, timeout: 30 * 60_000,
}, async () => {
  const testDatabaseUrl = new URL(process.env.DATABASE_URL || "");
  assert.match(testDatabaseUrl.pathname, /_test$/, "integration runner DATABASE_URL must be a dedicated *_test database");
  const repository = path.resolve(__dirname, "../..");
  const configPath = path.join(repository, "docs", "capacity-load.config.json");
  const configBytes = fs.readFileSync(configPath);
  const config = JSON.parse(configBytes);
  assert.equal(config.target, "capacity-vm");
  assert.equal(config.provider, "lima");
  assert.equal(config.db_name, "steps_tracker_capacity");
  assert.match(config.lima_instance, /^step-capacity/);
  assert.equal(path.resolve(config.repository), repository);
  const local = dotenv.parse(fs.readFileSync(path.join(repository, ".env.capacity.local")));
  const parity = dotenv.parse(fs.readFileSync(path.join(repository, ".env.capacity-prod-flags")));
  assertHomeCapacityParityOverlay(parity);
  const verified = validateSnapshotInputs({ config, localEnvironment: local });
  const token = `${Date.now()}-${process.pid}`;
  const runRoot = path.join(repository, "results", "capacity", "home-open",
    "provider-integration", token);
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const sourceBundle = createSourceBundle({ repository, output: path.join(runRoot, "source") });
  const workflowId = `home-provider-${crypto.createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
  const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  const migrationRows = sourceBundle.entries
    .filter((entry) => entry.name.startsWith("prisma/migrations/"))
    .map(({ name, mode, length, contentHash }) => ({ name, mode, length, contentHash }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.ok(migrationRows.length > 0);
  const manifest = buildWorkflowManifest({ workflowId, mode: "level", rate: 2,
    commit: sourceBundle.commit, sourceBundleHash: sourceBundle.hash,
    snapshotHash: verified.snapshot.snapshotHash,
    scrubAttestationHash: sha(fs.readFileSync(verified.attestationPath)),
    parityHash: sha(fs.readFileSync(path.join(repository, ".env.capacity-prod-flags"))),
    resourceManifestHash: hashObject(verified.liveManifest),
    effectiveEnvironmentHash: hashObject(parity), configHash: sha(configBytes),
    snapshotMetadataHash: sha(fs.readFileSync(verified.metadataPath)),
    migrationHash: hashObject(migrationRows),
    topologyHash: hashObject({ processes: 4, resolutionConcurrency: 2 }),
    startRate: 2, maxRate: 2,
    provider: { instance: config.lima_instance, target: config.target,
      database: config.db_name, dbHostPort: Number(config.db_host_port) } });
  fs.writeFileSync(path.join(runRoot, "confirmed-manifest.json"), `${JSON.stringify(manifest)}\n`,
    { flag: "wx", mode: 0o600 });
  const children = [1, 2].map((repeat) => ({ runId: HARNESS_POLICY.childId(workflowId,
    { kind: "boundary", rate: 2, repeat }), kind: "boundary", rate: 2, repeat }));
  const environment = { ...local, ...parity, CAPACITY_MODE: "true",
    CAPACITY_OUTBOUND_DISABLED: "true", CAPACITY_GLOBAL_EVENT_PROFILE: "home-open",
    CAPACITY_DATABASE_POOL_PROFILE: "role-budget" };
  const workflowsRoot = path.join(repository, "results", "capacity", "home-open", "workflows");
  let cleanup;
  const resetEvidence = [];
  let preparationEvidence;
  let passed = false;
  try {
    await withProviderLock({ directory: workflowsRoot, instance: config.lima_instance,
      workflowId, resourceCensus: providerResourceCensus }, async (providerLock) => {
      let preparation;
      try {
        assert.equal(assertProviderIsolation({ configPath, workflowId }).isolated, true);
        preparation = prepareWorkflowEnvironment({ configPath, manifest, sourceBundle,
          environment, providerLock });
        preparationEvidence = preparation;
        for (const [index, child] of children.entries()) {
          const evidence = resetWorkflowChild({ configPath, manifest, child, sourceBundle,
            environment, providerLock, previousChild: index > 0 ? children[index - 1] : null });
          resetEvidence.push(evidence);
          assert.equal(evidence.redisKeysBeforeBackend, 0);
          assert.equal(evidence.snapshotHash, manifest.snapshotHash);
          assert.deepEqual(evidence.appliedMigrations.map((row) => row.migration_name),
            preparation.binding.migrations || evidence.migrations);
          assert.match(evidence.appliedMigrationHash, /^[a-f0-9]{64}$/);
          assert.match(evidence.migrationChecksumDriftHash, /^[a-f0-9]{64}$/);
          assert.match(evidence.historicalRollbackHash, /^[a-f0-9]{64}$/);
          assert.equal(evidence.historicalRollbacksBeforeDeploy.hash,
            evidence.historicalRollbackHash);
          assert.equal(evidence.historicalRollbacksAfterDeploy.hash,
            evidence.historicalRollbackHash);
          assert.equal(evidence.unresolvedMigrationsBeforeDeploy, 0);
          assert.equal(evidence.unresolvedMigrationsAfterDeploy, 0);
          assert.match(evidence.schemaFingerprint, /^[a-f0-9]{64}$/);
          assert.match(evidence.normalizedEffectiveEnvironmentHash, /^[a-f0-9]{64}$/);
          for (const identity of Object.values(evidence.containerIdentities)) {
            assert.match(identity, /^[a-f0-9]{64}$/);
          }
        }
        for (const role of ["postgresContainer", "redisContainer", "backendContainer",
          "postgresVolume"]) {
          assert.notEqual(resetEvidence[0].names[role], resetEvidence[1].names[role], role);
        }
        for (const role of ["postgres", "redis", "backend"]) {
          assert.notEqual(resetEvidence[0].containerIdentities[role],
            resetEvidence[1].containerIdentities[role], `${role} identity`);
        }
        assert.equal(resetEvidence[0].appliedMigrationHash, resetEvidence[1].appliedMigrationHash);
        assert.equal(resetEvidence[0].historicalRollbackHash,
          resetEvidence[1].historicalRollbackHash);
        assert.equal(resetEvidence[0].migrationChecksumDriftHash,
          resetEvidence[1].migrationChecksumDriftHash);
        assert.deepEqual(resetEvidence[0].migrationChecksumDrift.names,
          ["20260405000000_remove_switcheroo_powerup"]);
        assert.deepEqual(resetEvidence[0].historicalRollbacksAfterDeploy.names,
          ["20260525000003_backfill_endsat_for_active_races",
            "20260615102652_race_results_seen"]);
        assert.equal(resetEvidence[0].schemaFingerprint, resetEvidence[1].schemaFingerprint);
        const effective = resetEvidence.map((evidence) =>
          JSON.parse(fs.readFileSync(evidence.childEffectiveEnvironmentPath, "utf8")));
        assert.notEqual(effective[0].childId, effective[1].childId);
        assert.notEqual(effective[0].nonSecret.CAPACITY_RUN_ID,
          effective[1].nonSecret.CAPACITY_RUN_ID);
        assert.notEqual(effective[0].nonSecret.CACHE_ENV_PREFIX,
          effective[1].nonSecret.CACHE_ENV_PREFIX);
        const secondPreparation = prepareWorkflowEnvironment({ configPath, manifest, sourceBundle,
          environment, providerLock });
        assert.equal(secondPreparation.cacheHit, true);
      } finally {
        cleanup = cleanupWorkflowEnvironment({ configPath, manifest, children,
          retainCache: true, providerLock, cacheVolume: preparation?.cacheVolume,
          cacheBindingHash: preparation?.binding?.hash });
      }
      assert.deepEqual({ resetData: cleanup.resetData, stopped: cleanup.stopped,
        cacheRetained: cleanup.cacheRetained, credentialsRetained: cleanup.credentialsRetained },
      { resetData: true, stopped: true, cacheRetained: true, credentialsRetained: false });
    });
    passed = true;
  } finally {
    try { fs.chmodSync(sourceBundle.path, 0o700); } catch {}
    const artifact = { schema: "home-capacity-provider-integration-v1", workflowId,
      passed, sourceBundleHash: sourceBundle.hash, preparation: preparationEvidence || null,
      resetEvidence, cleanup: cleanup || null,
      completedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(runRoot, "provider-integration-result.json"),
      `${JSON.stringify({ ...artifact, hash: hashObject(artifact) }, null, 2)}\n`, { mode: 0o600 });
    process.stderr.write(`retained provider integration evidence: ${runRoot}\n`);
  }
});
