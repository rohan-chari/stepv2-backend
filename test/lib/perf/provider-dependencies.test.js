const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertContainerResourceCaps,
  capacityResourcePlan,
  parseContainerResourceCaps,
  preparedNodeHelperCommand,
} = require("../../../scripts/lima-capacity");

test("source-bundle helpers mount the prepared dependency cache instead of resolving host modules", () => {
  const command = preparedNodeHelperCommand({
    bundle: "/safe/source",
    cacheVolume: "step-capacity-home-cache-abc123",
    script: "scripts/capacity-db.js",
    args: ["scrub", "--snapshot-hash", "a".repeat(64), "--attestation", "/evidence/out.json"],
    environmentFile: "/safe/helper.env",
    writableMounts: [{ source: "/safe/evidence", target: "/evidence" }],
  });
  assert.match(command, /node:22 node ['"]?scripts\/capacity-db\.js['"]?/);
  assert.match(command, /step-capacity-home-cache-abc123:\/workspace\/node_modules:ro/);
  assert.match(command, /\/safe\/source:\/workspace:ro/);
  assert.match(command, /\/safe\/evidence:\/evidence/);
  assert.match(command, /--env-file ['"]?\/safe\/helper\.env['"]?/);
  assert.doesNotMatch(command, /secret|DATABASE_URL/);
  assert.doesNotMatch(command, /NODE_PATH/);

  const source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/lima-capacity.js"), "utf8");
  const reset = source.slice(source.indexOf("function resetWorkflowChild"),
    source.indexOf("function cleanupWorkflowEnvironment"));
  assert.doesNotMatch(reset, /run\(process\.execPath/);
  assert.match(reset, /preparedNodeHelperCommand/);
});

test("Lima runtime can be loaded before the disposable database environment exists", () => {
  const repository = path.resolve(__dirname, "../../..");
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  const result = spawnSync(process.execPath, ["-e",
    `require(${JSON.stringify(path.join(repository, "performance/providers/lima-runtime.js"))})`], {
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "bara-perf-no-env-")),
    env: environment,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("Lima runtime flushes guest state and stops gracefully after mutations", () => {
  const source = fs.readFileSync(path.resolve(__dirname,
    "../../../performance/providers/lima-runtime.js"), "utf8");
  assert.match(source, /function gracefulStop[\s\S]*\["shell", instance, "--", "sync"\][\s\S]*\["stop", instance\]/);
  assert.doesNotMatch(source, /\["stop", "--force"/);
  assert.match(source, /resetEnvironment[\s\S]*gracefulStop\(state\.config\.lima_instance\)/);
  assert.match(source, /removeOwnedChildState[\s\S]*children[\s\S]*CHILD_ID/);
  assert.match(source, /catch \(error\)[\s\S]*removeOwnedChildState\(\)/);
  assert.match(source, /partial Lima environment cleanup failed/);
  assert.match(source, /new AggregateError\(\[error, \.\.\.cleanupErrors\]/);
  assert.match(source, /Lima environment reset cleanup failed/);
});

test("configured and inspected VM/backend/Postgres caps match production-shaped allocations", () => {
  const plan = capacityResourcePlan({
    vps_specs: { vcpu: 4, ram_gb: 8 },
    database_specs: { vcpu: 1, ram_gb: 2 },
  });
  assert.deepEqual({ vmCpu: plan.vmCpu, vmMemoryGb: plan.vmMemoryGb,
    backendCpu: plan.backendCpu, backendMemoryGb: plan.backendMemoryGb,
    databaseCpu: plan.databaseCpu, databaseMemoryGb: plan.databaseMemoryGb }, {
    vmCpu: 7, vmMemoryGb: 12, backendCpu: 4, backendMemoryGb: 8,
    databaseCpu: 1, databaseMemoryGb: 2,
  });
  assert.deepEqual(parseContainerResourceCaps({ NanoCpus: 4_000_000_000,
    Memory: 8 * 1024 ** 3 }), { cpu: 4, memoryGb: 8 });
  assert.deepEqual(assertContainerResourceCaps({ cpu: 1, memoryGb: 2 },
    { cpu: 1, memoryGb: 2 }, "PostgreSQL"), { cpu: 1, memoryGb: 2 });
  assert.throws(() => assertContainerResourceCaps({ cpu: 2, memoryGb: 2 },
    { cpu: 1, memoryGb: 2 }, "PostgreSQL"), /resource cap mismatch/i);
});

test("reusable environment installs pg_stat_statements after restore and migrations", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/lima-capacity.js"), "utf8");
  const reset = source.slice(source.indexOf("function resetWorkflowChild"),
    source.indexOf("function cleanupWorkflowEnvironment"));
  const migrate = reset.indexOf("npx prisma migrate deploy");
  const extension = reset.indexOf("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  assert.ok(migrate >= 0);
  assert.ok(extension > migrate);
});
