const os = require("node:os");
const { prisma: defaultPrisma } = require("../../../db");
const { isGenerationUsable } = require("./globalStepEventGeneration");

const LOCAL_AWARE_GENERATION = 2;
const OWNER_TTL_MS = 3 * 60 * 1000;

function configuredExpectedOwners(env = process.env) {
  const value = Number(env.GLOBAL_STEP_EVENT_CRON_EXPECTED_OWNERS);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function defaultOwnerId(env = process.env) {
  return env.GLOBAL_STEP_EVENT_CRON_OWNER_ID || `${os.hostname()}:${process.pid}`;
}

async function heartbeatAndCheck({
  client = defaultPrisma,
  now = new Date(),
  ownerId = defaultOwnerId(),
  expectedOwners = configuredExpectedOwners(),
} = {}) {
  // Once the expand schema is present, generation-two's exact per-boot census
  // is the sole creation gate. Do not refresh the legacy environment-keyed
  // owner row as well: that extra null-logical-owner lease would permanently
  // prevent the exact census from becoming usable.
  if (client?.globalStepEventGenerationState?.findUnique &&
      client?.globalStepEventCronOwner?.findMany) {
    return isGenerationUsable({ client, now });
  }
  if (expectedOwners == null) {
    return isGenerationUsable({ client, now });
  }
  // Explicit topology is an enablement precondition. Guessing one owner would
  // let a freshly deployed worker enable while an old worker is still alive.
  if (!expectedOwners) return false;
  const current = new Date(now);
  const expiresAt = new Date(current.getTime() + OWNER_TTL_MS);
  return client.$transaction(async (tx) => {
    await tx.globalStepEventCronOwner.upsert({
      where: { ownerId },
      create: {
        ownerId,
        generation: LOCAL_AWARE_GENERATION,
        localAware: true,
        heartbeatAt: current,
        expiresAt,
      },
      update: {
        generation: LOCAL_AWARE_GENERATION,
        localAware: true,
        heartbeatAt: current,
        expiresAt,
      },
    });
    const live = await tx.globalStepEventCronOwner.findMany({
      where: { expiresAt: { gt: current } },
      select: { generation: true, localAware: true },
    });
    return live.length === expectedOwners && live.every((owner) =>
      owner.localAware === true && owner.generation >= LOCAL_AWARE_GENERATION
    );
  });
}

module.exports = {
  LOCAL_AWARE_GENERATION,
  OWNER_TTL_MS,
  configuredExpectedOwners,
  defaultOwnerId,
  heartbeatAndCheck,
};
