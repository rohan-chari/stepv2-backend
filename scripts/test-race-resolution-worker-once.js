// Test-only production-process probe.  Kept outside the worker itself so the
// integration suite proves another Node process can claim/recover the exact
// durable queue rows written by the public HTTP process.
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
const { buildRaceResolutionWorkerV2 } = require("../src/modules/races/jobs/raceResolutionQueueV2");
const { RaceResolutionJobV2 } = require("../src/modules/races/models/raceResolutionJobV2");
const { prisma } = require("../src/db");

async function main() {
  const claimOnly = process.argv.includes("--claim-only");
  const result = claimOnly
    ? await RaceResolutionJobV2.claimNext({ now: new Date() })
    : await buildRaceResolutionWorkerV2({ bootAt: 0 }).processOne();
  await prisma.$disconnect();
  if (process.send) {
    process.send({ id: result?.id || null, claimed: Boolean(result) }, () => process.exit(0));
  } else {
    process.exit(0);
  }
}

main().catch(async (error) => {
  await prisma.$disconnect();
  if (process.send) process.send({ error: error.message }, () => process.exit(1));
  else process.exit(1);
});
