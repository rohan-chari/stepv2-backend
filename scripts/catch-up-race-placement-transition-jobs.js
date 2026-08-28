const { prisma } = require("../src/db");
const {
  RacePlacementTransitionJob,
} = require("../src/modules/races/models/racePlacementTransitionJob");

async function main() {
  let cursor = null;
  let total = 0;
  for (;;) {
    const page = await RacePlacementTransitionJob.catchUpActiveSucceededPage({
      afterRaceId: cursor,
      limit: 100,
      now: new Date(),
    });
    total += page.count;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  console.log(JSON.stringify({
    event: "race_placement_transition_catch_up",
    placementJobsQueued: total,
  }));
}

main()
  .catch((error) => {
    console.error("race placement transition catch-up failed", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
