// Fresh-process integration driver. Refuse every non-local/non-test database
// before importing application modules, and never initialize an external cache.
const database = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !database.pathname.endsWith("_test")) {
  throw new Error("Durable worker integration driver requires a local test database");
}
process.env.REDIS_URL = "";
const { prisma } = require("../../../src/db");
const { buildGlobalEventSummaryTick } = require("../../../src/modules/steps/jobs/globalEventSummary");
const { coordinatedOptimizationMetrics: metrics } = require("../../../src/shared/observability/coordinatedOptimizationMetrics");

(async () => {
  const workId = process.argv[2];
  if (!workId) throw new Error("Missing integration work ID");
  for (let attempt = 0; attempt < 400; attempt++) {
    await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    const artifact = await prisma.globalEventCaptureArtifact.findFirst({ where: { workId } });
    if (artifact || process.argv[3] === "single") {
      process.stdout.write("DURABLE_WORKER_RESULT=" + JSON.stringify({
        pid: process.pid, artifactId: artifact?.id || null, delta: artifact?.payload.attributionDeltaSteps,
        metrics: metrics.snapshot(),
      }) + "\n");
      await prisma.$disconnect();
      process.exit(0);
    }
  }
  throw new Error("Fresh worker exceeded its bounded claim limit");
})().catch(async (error) => {
  process.stderr.write(String(error.stack || error));
  await prisma.$disconnect();
  process.exit(1);
});
