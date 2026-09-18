const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRenewTournamentSeeds,
} = require("../../src/modules/tournaments/jobs/tournamentSeedRenewal");

test("featured renewal stamps the seed prize and treats a pending-lobby unique conflict as another worker's successful mint", async () => {
  const seed = {
    id: "seed-tournament-weekly-showdown",
    kind: "WEEKLY_SHOWDOWN",
    name: "8 Racer Tourney",
    bracketSize: 8,
    matchupDurationDays: 2,
    powerupsEnabled: true,
    championPrizeCoins: 300,
    active: true,
  };
  const creates = [];
  let pendingLookups = 0;
  const prisma = {
    tournamentSeed: { findMany: async () => [seed] },
    tournament: {
      findMany: async () => [],
      findFirst: async () => {
        pendingLookups += 1;
        return pendingLookups === 1 ? null : { id: "other-worker-lobby" };
      },
      create: async ({ data }) => {
        creates.push(data);
        const error = new Error("duplicate pending seed lobby");
        error.code = "P2002";
        throw error;
      },
    },
  };

  const renew = buildRenewTournamentSeeds({
    prisma,
    appSettings: { getFlag: async () => true },
    logger: { log() {}, error() {} },
    eventBus: { emit() {} },
    generateShareToken: () => "seeded-share-token",
  });

  await renew();

  assert.equal(creates.length, 1);
  assert.equal(creates[0].championPrizeCoinsSnapshot, 300);
  assert.equal(creates[0].status, "PENDING");
  assert.equal(pendingLookups, 2, "conflict rereads the winning lobby");
});
